import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import * as executors from '../src/modules/ai/executors.js';
import {
  createAgentTask,
  decideAgentTask,
  executeDueTasks,
  getTask,
  reapStaleTasks,
  runApprovedTask,
  syncAgentRegistry,
} from '../src/modules/ai/runner.js';

/**
 * Single-flight execution of an agent task.
 *
 * Approval gates a task; the scheduler (`executeDueTasks`) and the on-demand
 * admin path (`runApprovedTask`, served by `POST /api/ai/tasks/:id/run`) are two
 * independent triggers for the SAME task. These tests pin that the shared atomic
 * claim lets exactly one of them execute it — never both — even under genuine
 * concurrency, and that a crashed run cannot be re-executed.
 *
 * Every assertion is scoped by the task id this file created, because the suite
 * runs files in parallel against one database and `executeDueTasks` also picks
 * up any other due task in the table.
 */

const AUDIT_OPERATOR = { actorId: 'singleflight-operator' };
const AUDIT_SCHEDULER = { actorId: 'singleflight-scheduler' };

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

async function insertUser(roleName: 'MERCHANT' | 'ADMIN'): Promise<string> {
  const id = randomUUID();
  const email = `sf-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('SfPass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

/** Creates a gated sales-agent task owned by a real MERCHANT, approved and ready. */
async function approvedSalesTask(): Promise<string> {
  const merchantId = await insertUser('MERCHANT');
  const created = await createAgentTask(
    db, ['MERCHANT'], merchantId,
    { agentKey: 'sales-agent', taskType: 'sales.qualify_lead', input: {} },
    AUDIT_OPERATOR,
  );
  expect(created.status).toBe('awaiting_approval');
  createdTaskIds.push(created.id);
  const approved = await decideAgentTask(db, created.id, merchantId, 'APPROVE', null, AUDIT_OPERATOR);
  expect(approved.status).toBe('approved');
  return created.id;
}

async function successAudits(taskId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'AI.AGENT_TASK_SUCCEEDED')));
}

beforeAll(async () => {
  await syncAgentRegistry(db);
});

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('Agent task single-flight execution', () => {
  it('scheduler and manual run racing the same approved task execute it exactly once', async () => {
    const taskId = await approvedSalesTask();

    // Both triggers start before either finishes: the manual run and a scheduler
    // tick contend for the same row.
    const [manual, scheduler] = await Promise.all([
      runApprovedTask(db, taskId, AUDIT_OPERATOR).then(
        (t) => ({ kind: 'ran' as const, status: t.status }),
        (e: Error) => ({ kind: 'rejected' as const, status: e.message }),
      ),
      executeDueTasks(db, 50, AUDIT_SCHEDULER),
    ]);

    // Exactly one execution: one success record, one written result.
    const successes = await successAudits(taskId);
    expect(successes.length).toBe(1);

    const done = await getTask(db, taskId);
    expect(done.status).toBe('succeeded');
    expect(done.result).toBeTruthy();

    // The loser never executed: the manual path either ran it or was rejected
    // with a 409; the scheduler ran at most this one task.
    const manualRan = manual.kind === 'ran' && manual.status === 'succeeded';
    if (!manualRan) expect(manual.kind).toBe('rejected');
    expect(scheduler.ran).toBeLessThanOrEqual(1);
  });

  it('two concurrent scheduler ticks execute the same approved task exactly once', async () => {
    const taskId = await approvedSalesTask();

    await Promise.all([
      executeDueTasks(db, 50, AUDIT_SCHEDULER),
      executeDueTasks(db, 50, AUDIT_SCHEDULER),
    ]);

    const successes = await successAudits(taskId);
    expect(successes.length).toBe(1);
    expect((await getTask(db, taskId)).status).toBe('succeeded');
  });

  it('a task already claimed as running is skipped by both the scheduler and the manual path', async () => {
    const taskId = await approvedSalesTask();

    // Simulate a concurrent caller holding the claim.
    await db.update(agentTasks).set({ status: 'running', startedAt: new Date() }).where(eq(agentTasks.id, taskId));

    const { ran } = await executeDueTasks(db, 50, AUDIT_SCHEDULER);
    expect(ran).toBe(0);
    await expect(runApprovedTask(db, taskId, AUDIT_OPERATOR)).rejects.toThrow();

    // The holder's run is untouched and nothing else executed it.
    expect((await getTask(db, taskId)).status).toBe('running');
    expect((await successAudits(taskId)).length).toBe(0);
  });

  it('a crashed run is reaped to failed and can never be re-executed (no double execution)', async () => {
    const taskId = await approvedSalesTask();

    // Claim it (as a run that then crashes would) with an old start time.
    await db
      .update(agentTasks)
      .set({ status: 'running', startedAt: new Date(Date.now() - 3600_000) })
      .where(eq(agentTasks.id, taskId));

    // The watchdog recovers it — a crashed run never holds the task forever.
    const reaped = await reapStaleTasks(db, 300);
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect((await getTask(db, taskId)).status).toBe('failed');

    // Recovery is terminal: neither trigger may run it again.
    const { ran } = await executeDueTasks(db, 50, AUDIT_SCHEDULER);
    expect(ran).toBe(0);
    await expect(runApprovedTask(db, taskId, AUDIT_OPERATOR)).rejects.toThrow();

    expect((await successAudits(taskId)).length).toBe(0);
  });

  it('a late write from an execution the watchdog already failed cannot resurrect the task', async () => {
    const taskId = await approvedSalesTask();

    // Interleave the REAL watchdog with the REAL runner deterministically: while
    // the executor is in flight, the watchdog runs and fails the task as stale
    // (this is exactly the >timeout path, forced without waiting 300s). The run
    // then completes and attempts its final write — which must not apply.
    let reaped = 0;
    const original = executors.executeAgentTask;
    const spy = vi
      .spyOn(executors, 'executeAgentTask')
      .mockImplementation(async (dbArg, agentArg, inputArg) => {
        // Age only THIS task so the real watchdog (300s threshold) reaps it and
        // nothing else — the suite shares one database across parallel files.
        await db
          .update(agentTasks)
          .set({ startedAt: new Date(Date.now() - 3600_000) })
          .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'running')));
        reaped = await reapStaleTasks(db, 300);
        return original(dbArg, agentArg, inputArg);
      });

    try {
      await runApprovedTask(db, taskId, AUDIT_OPERATOR);
    } finally {
      spy.mockRestore();
    }

    expect(reaped).toBeGreaterThanOrEqual(1);

    // The watchdog's terminal state stands; the late write did not overwrite it.
    const done = await getTask(db, taskId);
    expect(done.status).toBe('failed');
    expect((done.error as { message?: string } | null)?.message).toMatch(/timeout/);

    // No contradictory outcome was recorded for the reaped run.
    const successes = await successAudits(taskId);
    expect(successes.length).toBe(0);
  });
});
