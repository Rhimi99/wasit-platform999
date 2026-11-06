import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema/index.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { planAgentRun, type ProposedStep } from '../src/modules/ai/planner.js';
import {
  dispatchStep,
  recoverStuckSteps,
  fencedStepWrite,
  syncStepFromTask,
  type DispatchResult,
} from '../src/modules/ai/dispatcher.js';
import { createAgentTask } from '../src/modules/ai/agents.js';

/**
 * AI-02.3.2 — TRUE CONCURRENCY (multiple server instances).
 *
 * The sibling `ai0232-fencing.test.ts` proves the fencing semantics with a
 * deterministic interleaving seam. This file proves the *database* guarantee:
 * that two independent server processes — modelled here by two independent
 * `pg.Pool`s (separate TCP connections and separate transactions, NOT the shared
 * singleton) — cannot both claim a step, both create a task, or both settle it.
 *
 * Every race below is real: the two operations are started with `Promise.all`
 * and interleaved by PostgreSQL's row locks, not by test code. No mocks.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];

const auditCtx = { actorId: null, actorType: 'USER' as const };
const STUCK = { stuckSeconds: 300, leaseSeconds: 60 };

/**
 * A second, fully independent connection pool. This is the crux of the test:
 * instance A (the shared `db`) and instance B (this pool) never share a client,
 * so their transactions are genuinely concurrent at the PostgreSQL level.
 */
const poolB = new pg.Pool({ connectionString: CONNECTION_STRING, max: 5 });
const dbB = drizzle(poolB, { schema });

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai0232c-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

async function plan(requester: string, steps: ProposedStep[], title = 'IT concurrency run') {
  const p = await planAgentRun(db, requester, { title, steps }, auditCtx);
  createdRunIds.push(p.runId);
  return p;
}

async function stepRow(runId: string, stepKey: string) {
  const rows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  return rows.find((r) => r.stepKey === stepKey)!;
}

async function taskCountForStep(stepId: string): Promise<number> {
  const rows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(sql`${agentTasks.input}->>'__stepId' = ${stepId}`);
  return rows.length;
}

async function auditCountFor(entityId: string, action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(sql`${auditLogs.entityId} = ${entityId} and ${auditLogs.action} = ${action}`);
  return rows.length;
}

async function makeStuck(stepId: string, minutesAgo = 60): Promise<void> {
  const past = new Date(Date.now() - minutesAgo * 60_000);
  await db
    .update(agentRunSteps)
    .set({ status: 'RUNNING', startedAt: past, updatedAt: past })
    .where(eq(agentRunSteps.id, stepId));
}

/** Settles a settled/duplicate rejection into a comparable token. */
async function outcome(fn: () => Promise<DispatchResult>): Promise<string> {
  try {
    const r = await fn();
    return `ok:${r.status}`;
  } catch (e) {
    return `err:${(e as Error).message}`;
  }
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdRunIds.length) {
    await db.delete(agentRunSteps).where(inArray(agentRunSteps.runId, createdRunIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds));
  }
  if (createdUserIds.length) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await poolB.end();
  await closeDb();
});

describe('AI-02.3.2 — two concurrent dispatches (independent connections)', () => {
  it('#9. exactly one of two simultaneous dispatches claims the step and creates a task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');

    // Instance A and instance B dispatch the SAME step at the same instant.
    const [a, b] = await Promise.all([
      outcome(() => dispatchStep(db, p.runId, 'mkt', auditCtx)),
      outcome(() => dispatchStep(dbB, p.runId, 'mkt', auditCtx)),
    ]);

    const successes = [a, b].filter((r) => r.startsWith('ok:'));
    const failures = [a, b].filter((r) => r.startsWith('err:'));
    // Exactly one winner; the loser is refused (not silently executed twice).
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    // The invariant that matters: one task, never two.
    expect(await taskCountForStep(s.id)).toBe(1);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_DISPATCHED')).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');

    const rows = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(sql`${agentTasks.input}->>'__stepId' = ${s.id}`);
    createdTaskIds.push(...rows.map((r) => r.id));
  });

  it('#9b. a losing dispatcher cannot attach a second task even when it reaches createAgentTask', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');

    // Both instances claim the step (only one wins), then both try to create a
    // task with their own claim token — the fencing inside createAgentTask must
    // let exactly one through.
    const claims = await Promise.all([
      db
        .update(agentRunSteps)
        .set({ status: 'RUNNING', attemptCount: sql`${agentRunSteps.attemptCount} + 1`, startedAt: new Date(), updatedAt: new Date() })
        .where(sql`${agentRunSteps.id} = ${s.id} and ${agentRunSteps.status} in ('PENDING','READY')`)
        .returning({ token: agentRunSteps.attemptCount }),
      dbB
        .update(agentRunSteps)
        .set({ status: 'RUNNING', attemptCount: sql`${agentRunSteps.attemptCount} + 1`, startedAt: new Date(), updatedAt: new Date() })
        .where(sql`${agentRunSteps.id} = ${s.id} and ${agentRunSteps.status} in ('PENDING','READY')`)
        .returning({ token: agentRunSteps.attemptCount }),
    ]);
    const winners = claims.filter((c) => c.length > 0);
    expect(winners.length).toBe(1);
    const token = winners[0][0].token;

    const create = async (conn: typeof db) =>
      createAgentTask(
        conn,
        ['SUPER_ADMIN'],
        admin,
        { agentKey: 'product-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
        auditCtx,
        { runId: p.runId, stepId: s.id, claimToken: token },
      );

    const results = await Promise.allSettled([create(db), create(dbB)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    expect(await taskCountForStep(s.id)).toBe(1);
    const rows = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(sql`${agentTasks.input}->>'__stepId' = ${s.id}`);
    createdTaskIds.push(...rows.map((r) => r.id));
  });
});

describe('AI-02.3.2 — two concurrent recoveries (independent connections)', () => {
  it('#8. two simultaneous recovery sweeps settle a stuck step exactly once', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    // A linked task in a decided state so the step has an outcome to sync.
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'product-agent',
      requestedBy: admin,
      input: { __runId: p.runId, __stepId: s.id } as never,
      status: 'failed',
      error: { m: 'x' } as never,
    });
    createdTaskIds.push(taskId);

    const [a, b] = await Promise.all([
      recoverStuckSteps(db, STUCK, auditCtx),
      recoverStuckSteps(dbB, STUCK, auditCtx),
    ]);
    expect(a.recovered + b.recovered).toBe(1);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });

  it('#14. repeated recovery is idempotent (no second settlement, no duplicate audit)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'product-agent',
      requestedBy: admin,
      input: { __runId: p.runId, __stepId: s.id } as never,
      status: 'failed',
      error: { m: 'x' } as never,
    });
    createdTaskIds.push(taskId);

    const first = await recoverStuckSteps(db, STUCK, auditCtx);
    const second = await recoverStuckSteps(db, STUCK, auditCtx);
    const third = await recoverStuckSteps(dbB, STUCK, auditCtx);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(third.recovered).toBe(0);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(1);
  });
});

describe('AI-02.3.2 — cross-instance stale writer cannot write', () => {
  it('#5/#10. instance B cannot write a step settled by instance A (stale token)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // Instance A claims generation 1.
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Instance A (Recovery) settles the step FAILED.
    const settled = await fencedStepWrite(db, s.id, 1, { status: 'FAILED' });
    expect(settled).toBe(true);
    // Instance B, still holding token 1, tries to write SUCCEEDED — refused.
    const stale = await fencedStepWrite(dbB, s.id, 1, { status: 'SUCCEEDED' });
    expect(stale).toBe(false);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });

  it('#4. instance B cannot create a task after instance A settled the step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Instance A settles it (as Recovery would).
    await fencedStepWrite(db, s.id, 1, { status: 'FAILED' });
    // Instance B tries to create the task with the now-stale claim.
    await expect(
      createAgentTask(
        dbB,
        ['SUPER_ADMIN'],
        admin,
        { agentKey: 'product-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
        auditCtx,
        { runId: p.runId, stepId: s.id, claimToken: 1 },
      ),
    ).rejects.toThrow(/no longer owned/);
    expect(await taskCountForStep(s.id)).toBe(0);
  });

  it('#6. recovery on instance B while instance A holds a live claim leaves the step RUNNING', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // Instance A claims with a FRESH lease (updated_at = now).
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Instance B's recovery must not consider it a candidate (lease valid).
    const sweep = await recoverStuckSteps(dbB, STUCK, auditCtx);
    expect(sweep.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });
});

describe('AI-02.3.2 — failure windows (real DB state)', () => {
  it('#11. failure BEFORE task creation leaves RUNNING with no task; recovery settles FAILED with no replacement task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // Claimed, then the process died before createAgentTask.
    await makeStuck(s.id);
    expect(await taskCountForStep(s.id)).toBe(0);

    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
    // Crucially, recovery does NOT fabricate a task.
    expect(await taskCountForStep(s.id)).toBe(0);
  });

  it('#12. failure AFTER task creation is settled by syncing the task outcome (no second task)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'product-agent',
      requestedBy: admin,
      input: { __runId: p.runId, __stepId: s.id } as never,
      status: 'succeeded',
      result: { ok: true } as never,
    });
    createdTaskIds.push(taskId);

    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
    expect(await taskCountForStep(s.id)).toBe(1);
  });

  it('#13. a stale writer failing while saving its result cannot overwrite the recovery decision', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Recovery (instance B) settles the step FAILED while the old dispatch is
    // about to persist a failure payload of its own.
    await fencedStepWrite(dbB, s.id, 1, { status: 'FAILED', error: { message: 'recovery' } as never });
    const staleFail = await fencedStepWrite(db, s.id, 1, {
      status: 'FAILED',
      error: { message: 'old-dispatch-error' } as never,
    });
    expect(staleFail).toBe(false);
    const row = await stepRow(p.runId, 'mkt');
    expect(row.status).toBe('FAILED');
    // The recorded error is recovery's, not the stale writer's.
    expect((row.error as { message?: string })?.message).toBe('recovery');
  });
});

describe('AI-02.3.2 — recovery audit accuracy (lost-race accounting)', () => {
  async function linkedTask(stepId: string, runId: string, requestedBy: string, status: string, result?: unknown) {
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'product-agent',
      requestedBy,
      input: { __runId: runId, __stepId: stepId } as never,
      status,
      result: (result ?? null) as never,
      error: status === 'failed' ? ({ m: 'x' } as never) : null,
    });
    createdTaskIds.push(taskId);
    return taskId;
  }

  it('#A. recovery wins: recovered increments once and exactly one success audit is written', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await linkedTask(s.id, p.runId, admin, 'failed');

    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(1);
    expect(sweep.lostRace).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(1);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE')).toBe(0);
  });

  it('#B. dispatch wins during the window: recovered does NOT increment and no success audit is written', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await db.update(agentRunSteps).set({ attemptCount: 1 }).where(eq(agentRunSteps.id, s.id));
    await linkedTask(s.id, p.runId, admin, 'failed');

    // While recovery holds the lease (before it settles), a live dispatch on the
    // OTHER connection persists its result — the exact race the audit found.
    const sweep = await recoverStuckSteps(db, STUCK, auditCtx, {
      beforeSettle: async () => {
        const applied = await fencedStepWrite(dbB, s.id, 1, {
          status: 'SUCCEEDED',
          result: { taskId: 'live', taskStatus: 'succeeded' } as never,
        });
        expect(applied).toBe(true);
      },
    });

    expect(sweep.recovered).toBe(0);
    expect(sweep.lostRace).toBe(1);
    // The dispatch's decision stands; recovery did not overwrite it.
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
    // No false recovery-success audit; the loss is its own event.
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(0);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_RECOVERED')).toBe(0);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE')).toBe(1);
  });

  it('#C. a zero-row settle is not a success (direct sync), and prior terminal states never change', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await db.update(agentRunSteps).set({ attemptCount: 1 }).where(eq(agentRunSteps.id, s.id));
    await linkedTask(s.id, p.runId, admin, 'succeeded', { ok: true });

    // A concurrent writer settles the step (SUCCEEDED) just before sync's UPDATE.
    const res = await syncStepFromTask(db, s.id, auditCtx, {
      beforeSettle: async () => {
        await fencedStepWrite(dbB, s.id, 1, { status: 'SUCCEEDED', result: { by: 'other' } as never });
      },
    });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('lost_race');
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(0);

    // A step already in a terminal state is reported as already_settled, unchanged.
    const before = await stepRow(p.runId, 'mkt');
    const again = await syncStepFromTask(db, s.id, auditCtx);
    expect(again.changed).toBe(false);
    expect(again.reason).toBe('already_settled');
    const after = await stepRow(p.runId, 'mkt');
    expect(after.status).toBe(before.status);
    expect(after.result).toEqual(before.result);
  });

  it('#D. repeated recovery produces no duplicate success audits', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await linkedTask(s.id, p.runId, admin, 'failed');

    const first = await recoverStuckSteps(db, STUCK, auditCtx);
    const second = await recoverStuckSteps(db, STUCK, auditCtx);
    const third = await recoverStuckSteps(dbB, STUCK, auditCtx);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(third.recovered).toBe(0);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(1);
  });
});
