import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { planAgentRun, type ProposedStep } from '../src/modules/ai/planner.js';
import {
  dispatchStep,
  approveRunStep,
  cancelRun,
  recoverStuckSteps,
  recoverRun,
  reconcileRun,
  syncStepFromTask,
} from '../src/modules/ai/dispatcher.js';

/**
 * AI-02.3.1 — Execution Reliability & Recovery.
 *
 * Exercises the real dispatcher, the real agent-task system and the real
 * database: task↔step synchronisation, stuck-RUNNING recovery, lease-guarded
 * concurrency, the no-duplicate guarantees, the attempt bound, and the
 * permission/approval invariants. Nothing is mocked — the value here is exactly
 * the behaviour a mock would hide.
 */

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];
const createdRegistryKeys: string[] = [];

const auditCtx = { actorId: null, actorType: 'USER' as const };
const STUCK = { stuckSeconds: 300, leaseSeconds: 60 };

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai0231-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

async function plan(requester: string, steps: ProposedStep[], title = 'IT run') {
  const p = await planAgentRun(db, requester, { title, steps }, auditCtx);
  createdRunIds.push(p.runId);
  return p;
}

async function stepRow(runId: string, stepKey: string) {
  const rows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  return rows.find((r) => r.stepKey === stepKey)!;
}

async function runRow(runId: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return rows[0];
}

/** A step that looks abandoned: RUNNING long ago, not leased since. */
async function makeStuck(stepId: string, minutesAgo = 60): Promise<void> {
  const past = new Date(Date.now() - minutesAgo * 60_000);
  await db
    .update(agentRunSteps)
    .set({ status: 'RUNNING', startedAt: past, updatedAt: past })
    .where(eq(agentRunSteps.id, stepId));
}

/** Inserts a task linked to a step, bypassing the dispatcher (crash simulation). */
async function insertLinkedTask(opts: {
  stepId: string;
  runId: string;
  requestedBy: string;
  status: string;
  result?: unknown;
  error?: unknown;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(agentTasks).values({
    id,
    agentKey: 'product-agent',
    requestedBy: opts.requestedBy,
    input: { __runId: opts.runId, __stepId: opts.stepId } as never,
    status: opts.status,
    result: (opts.result ?? null) as never,
    error: (opts.error ?? null) as never,
  });
  createdTaskIds.push(id);
  return id;
}

async function auditCountFor(entityId: string, action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));
  return rows.length;
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  // Ownership-scoped: removes the spec's tasks/runs/registry rows and any
  // ai_requests/ai_usage recorded under its users, without a table-wide DELETE.
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    runIds: createdRunIds,
    taskIds: createdTaskIds,
    registryKeys: createdRegistryKeys,
  });
  await closeDb();
});

describe('AI-02.3.1 — execution completes and synchronises', () => {
  it('1. executes a step to success and links exactly one task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.status).toBe('SUCCEEDED');
    const s = await stepRow(p.runId, 'mkt');
    expect(s.status).toBe('SUCCEEDED');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'product-agent'));
    expect(tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id).length).toBe(1);
  });

  it('2. synchronises a succeeded task back onto the step and closes the run', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'succeeded', result: { advice: 'ok' } });

    const status = await recoverRun(db, p.runId, auditCtx);
    expect(status).toBe('COMPLETED');
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
    expect((await runRow(p.runId)).status).toBe('COMPLETED');
  });
});

describe('AI-02.3.1 — recovery never duplicates or overrides live work', () => {
  it('3. detects a RUNNING task and does not resend or duplicate it', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'running' });

    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(0);
    // The step is untouched and no second task was created.
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'product-agent'));
    expect(tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id).length).toBe(1);
  });

  it('11. refuses to re-execute a step whose task is still in flight (awaiting_approval)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'awaiting_approval' });
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });

  it('12. takes no action when the task state is unknown', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'mystery_state' });
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });

  it('4. syncs a succeeded task to SUCCEEDED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'succeeded', result: { advice: 'x' } });
    const res = await syncStepFromTask(db, s.id, auditCtx);
    expect(res.changed).toBe(true);
    expect(res.status).toBe('SUCCEEDED');
  });

  it('5. syncs a failed task to FAILED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { message: 'boom' } });
    const res = await syncStepFromTask(db, s.id, auditCtx);
    expect(res.changed).toBe(true);
    expect(res.status).toBe('FAILED');
  });

  it('does not accept a "succeeded" task that carries no result', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'succeeded' });
    const res = await syncStepFromTask(db, s.id, auditCtx);
    expect(res.changed).toBe(false);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });
});

describe('AI-02.3.1 — stuck steps and crash windows', () => {
  it('6. records a RUNNING step with no task as FAILED (never fabricates a replacement)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
    // No task was created as a side effect.
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'product-agent'));
    expect(tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id).length).toBe(0);
  });

  it('7. heals a crash between the claim and task creation (RUNNING, no task)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'bad', agentKey: 'product-agent' }),
      step({ stepKey: 'after', agentKey: 'product-agent', dependsOn: ['bad'] }),
    ]);
    const bad = await stepRow(p.runId, 'bad');
    await makeStuck(bad.id);
    await recoverStuckSteps(db, STUCK, auditCtx);
    expect((await stepRow(p.runId, 'bad')).status).toBe('FAILED');
    // The dependent is skipped, and the run closes FAILED.
    expect((await stepRow(p.runId, 'after')).status).toBe('SKIPPED');
    expect((await runRow(p.runId)).status).toBe('FAILED');
  });

  it('8. heals a crash between task creation and result persistence', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    // A task was created and succeeded, but the step write never happened.
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id); // reset to RUNNING with old timestamps

    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
  });

  it('22. recovers correctly after an abrupt restart (fresh sweep, no in-process state)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id, 120);
    // A brand-new recovery sweep (as a restarted process would run) heals it.
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.scanned).toBeGreaterThanOrEqual(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });
});

describe('AI-02.3.1 — concurrency and idempotency', () => {
  it('9. two concurrent dispatches create exactly one task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const results = await Promise.allSettled([
      dispatchStep(db, p.runId, 'mkt', auditCtx),
      dispatchStep(db, p.runId, 'mkt', auditCtx),
    ]);
    for (const r of results) if (r.status === 'fulfilled' && r.value.taskId) createdTaskIds.push(r.value.taskId);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const s = await stepRow(p.runId, 'mkt');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'product-agent'));
    expect(tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id).length).toBe(1);
  });

  it('10. two concurrent recoveries process a stuck step only once', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { message: 'x' } });

    const [a, b] = await Promise.all([
      recoverStuckSteps(db, STUCK, auditCtx),
      recoverStuckSteps(db, STUCK, auditCtx),
    ]);
    expect(a.recovered + b.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });

  it('21. re-running the sync does not duplicate audit events', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { message: 'x' } });

    await syncStepFromTask(db, s.id, auditCtx);
    const first = await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED');
    // Second and third runs are no-ops (step is already settled).
    await syncStepFromTask(db, s.id, auditCtx);
    await syncStepFromTask(db, s.id, auditCtx);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(first);
    expect(first).toBe(1);
  });

  it('13. refuses to dispatch a step that has exhausted its attempts', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    await db.update(agentRunSteps).set({ attemptCount: 1 }).where(eq(agentRunSteps.runId, p.runId));
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/exhausted its attempts/);
    // The step was not claimed.
    expect((await stepRow(p.runId, 'mkt')).status).toBe('PENDING');
  });
});

describe('AI-02.3.1 — run closure integrity', () => {
  it('14. a failed step skips its dependents', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'bad', agentKey: 'product-agent' }),
      step({ stepKey: 'after', agentKey: 'product-agent', dependsOn: ['bad'] }),
    ]);
    // Record the failure the dispatcher would record when execution faults, then
    // reconcile: the dependent must be skipped, never executed.
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED' })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'bad')));
    expect(await reconcileRun(db, p.runId, auditCtx)).toBe('FAILED');
    expect((await stepRow(p.runId, 'after')).status).toBe('SKIPPED');
    expect((await runRow(p.runId)).status).toBe('FAILED');
  });

  it('15. never closes a run COMPLETED while a step failed', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'ok', agentKey: 'product-agent' }),
      step({ stepKey: 'bad', agentKey: 'product-agent' }),
    ]);
    const ok = await dispatchStep(db, p.runId, 'ok', auditCtx);
    if (ok.taskId) createdTaskIds.push(ok.taskId);
    const s = await stepRow(p.runId, 'bad');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { message: 'x' } });
    const status = await recoverRun(db, p.runId, auditCtx);
    expect(status).toBe('PARTIALLY_COMPLETED');
    expect((await runRow(p.runId)).status).toBe('PARTIALLY_COMPLETED');
  });

  it('16. never closes a run while a step is unsettled', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'product-agent' }),
      step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a'] }),
    ]);
    const outA = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (outA.taskId) createdTaskIds.push(outA.taskId);
    // 'b' is still PENDING → the run must remain open.
    expect((await runRow(p.runId)).status).toBe('RUNNING');
    const status = await recoverRun(db, p.runId, auditCtx);
    expect(status).toBe('RUNNING');
  });
});

describe('AI-02.3.1 — permissions and approvals are preserved', () => {
  it('17. keeps the human-approval requirement for a sensitive step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(dispatchStep(db, p.runId, 'risk', auditCtx)).rejects.toThrow(/requires human approval/);
    // Recovery never approves on its own.
    const s = await stepRow(p.runId, 'risk');
    await makeStuck(s.id);
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.recovered).toBe(1); // no task → FAILED, still not approved/executed
    expect((await stepRow(p.runId, 'risk')).approvedBy).toBeNull();
  });

  it('18. forbids self-approval of a step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(approveRunStep(db, p.runId, 'risk', admin, auditCtx)).rejects.toThrow(/your own run/);
  });

  it('19. verifies permissions at execution time, not only at planning', async () => {
    const merchant = await createUser('MERCHANT');
    const p = await plan(merchant, [step({ stepKey: 'ads', agentKey: 'ads-agent' })]);
    await db.delete(userRoles).where(eq(userRoles.userId, merchant));
    await expect(dispatchStep(db, p.runId, 'ads', auditCtx)).rejects.toThrow(/permission/);
  });

  it('20. a cancelled run never dispatches a step (no supervisor authority leak)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    await cancelRun(db, p.runId, auditCtx);
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/not in a dispatchable state/);
  });
});
