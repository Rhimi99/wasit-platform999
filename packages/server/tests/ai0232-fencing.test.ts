import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
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
  syncStepFromTask,
  fencedStepWrite,
  findTaskForStep,
} from '../src/modules/ai/dispatcher.js';
import { createAgentTask } from '../src/modules/ai/agents.js';
import { createInFlightGuard } from '../src/lib/scheduler.js';

/**
 * AI-02.3.2 — Fencing, Concurrency & Recovery Safety.
 *
 * These tests exercise the real dispatcher, the real agent-task service and the
 * real database. The concurrency cases use a deterministic interleaving seam
 * (`dispatchStep(..., { onClaimed })`) plus `Promise.all` so the actual race is
 * constructed, not merely described.
 */

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];
const createdRegistryKeys: string[] = [];

const auditCtx = { actorId: null, actorType: 'USER' as const };
const STUCK = { stuckSeconds: 300, leaseSeconds: 60 };

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai0232-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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

async function makeStuck(stepId: string, minutesAgo = 60): Promise<void> {
  const past = new Date(Date.now() - minutesAgo * 60_000);
  await db
    .update(agentRunSteps)
    .set({ status: 'RUNNING', startedAt: past, updatedAt: past })
    .where(eq(agentRunSteps.id, stepId));
}

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
    .where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));
  return rows.length;
}

/** A deferred promise used to hold a dispatch open at the seam. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

describe('AI-02.3.2 — normal dispatch (baseline)', () => {
  it('1. dispatches normally and creates exactly one task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.status).toBe('SUCCEEDED');
    const s = await stepRow(p.runId, 'mkt');
    expect(await taskCountForStep(s.id)).toBe(1);
  });

  it('8. refuses a second task for the same step (idempotency at the claim)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'mkt', agentKey: 'product-agent' }),
      step({ stepKey: 'other', agentKey: 'product-agent' }),
    ]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    const s = await stepRow(p.runId, 'mkt');
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/already terminal/);
    expect(await taskCountForStep(s.id)).toBe(1);
  });

  it('9. a repeated createAgentTask with fencing returns idempotently (no second task)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // Claim the step (RUNNING, attempt_count = 1) as the dispatcher would.
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    const first = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      admin,
      { agentKey: 'product-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
      auditCtx,
      { runId: p.runId, stepId: s.id, claimToken: 1 },
    );
    createdTaskIds.push(first.id);
    expect(await taskCountForStep(s.id)).toBe(1);
    // A second attempt for the same step is refused as a duplicate, not executed.
    await expect(
      createAgentTask(
        db,
        ['SUPER_ADMIN'],
        admin,
        { agentKey: 'product-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
        auditCtx,
        { runId: p.runId, stepId: s.id, claimToken: 1 },
      ),
    ).rejects.toThrow(/duplicate/);
    expect(await taskCountForStep(s.id)).toBe(1);
  });
});

describe('AI-02.3.2 — fencing blocks stale writes', () => {
  it('5. an old dispatch cannot write over FAILED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Recovery settles the step FAILED.
    await db.update(agentRunSteps).set({ status: 'FAILED' }).where(eq(agentRunSteps.id, s.id));
    // The stale claim (token 1) tries to write SUCCEEDED — it must be a no-op.
    const applied = await fencedStepWrite(db, s.id, 1, { status: 'SUCCEEDED' });
    expect(applied).toBe(false);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });

  it('6. an old dispatch cannot write over CANCELLED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    await db.update(agentRunSteps).set({ status: 'CANCELLED' }).where(eq(agentRunSteps.id, s.id));
    expect(await fencedStepWrite(db, s.id, 1, { status: 'SUCCEEDED' })).toBe(false);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('CANCELLED');
  });

  it('7. a write with a stale fencing token is refused even while RUNNING', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // The step now belongs to claim generation 2, not the caller's token 1.
    // maxAttempts must allow it (the DB CHECK enforces attemptCount <= maxAttempts).
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 2, maxAttempts: 3, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    expect(await fencedStepWrite(db, s.id, 1, { status: 'SUCCEEDED' })).toBe(false);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
    // The rightful owner (token 2) succeeds.
    expect(await fencedStepWrite(db, s.id, 2, { status: 'SUCCEEDED' })).toBe(true);
  });
});

describe('AI-02.3.2 — recovery vs. an in-flight dispatch (real interleaving)', () => {
  it('2+10. a dispatch suspended before task creation is NOT settled by recovery, then completes once', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');

    const atSeam = deferred();
    const release = deferred();
    // Run dispatch, holding it right after the claim (before createAgentTask).
    const dispatchPromise = dispatchStep(db, p.runId, 'mkt', auditCtx, {
      onClaimed: async () => {
        atSeam.resolve();
        await release.promise;
      },
    });

    await atSeam.promise; // claim done; step is RUNNING, lease is fresh
    // Recovery runs now: the lease is fresh, so the step is not a candidate.
    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');

    release.resolve();
    const out = await dispatchPromise;
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.status).toBe('SUCCEEDED');
    expect(await taskCountForStep(s.id)).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
  });

  it('4. after the lease expires, recovery settles FAILED and a returning old dispatch cannot create a task', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');

    const atSeam = deferred();
    const release = deferred();
    const dispatchPromise = dispatchStep(db, p.runId, 'mkt', auditCtx, {
      onClaimed: async () => {
        atSeam.resolve();
        await release.promise;
      },
    });

    await atSeam.promise;
    // Simulate the dispatch being abandoned long enough for the lease to expire.
    const past = new Date(Date.now() - 60 * 60_000);
    await db.update(agentRunSteps).set({ startedAt: past, updatedAt: past }).where(eq(agentRunSteps.id, s.id));

    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(1);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');

    // The old dispatch now resumes: it must NOT create a task.
    release.resolve();
    const out = await dispatchPromise;
    expect(out.taskId).toBeNull();
    expect(await taskCountForStep(s.id)).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');
  });

  it('7b. recovery between the claim and task creation prevents the task (ownership lost)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');

    const atSeam = deferred();
    const release = deferred();
    const dispatchPromise = dispatchStep(db, p.runId, 'mkt', auditCtx, {
      onClaimed: async () => {
        atSeam.resolve();
        await release.promise;
      },
    });
    await atSeam.promise;

    // Force the step to look abandoned, then let recovery settle it FAILED.
    const past = new Date(Date.now() - 60 * 60_000);
    await db.update(agentRunSteps).set({ startedAt: past, updatedAt: past }).where(eq(agentRunSteps.id, s.id));
    await recoverStuckSteps(db, STUCK, auditCtx);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('FAILED');

    release.resolve();
    const out = await dispatchPromise;
    expect(out.taskId).toBeNull();
    expect(await taskCountForStep(s.id)).toBe(0);
  });

  it('11+12. two concurrent recoveries settle a stuck step exactly once', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { m: 'x' } });
    const [a, b] = await Promise.all([
      recoverStuckSteps(db, STUCK, auditCtx),
      recoverStuckSteps(db, STUCK, auditCtx),
    ]);
    expect(a.recovered + b.recovered).toBe(1);
    expect(await auditCountFor(s.id, 'AI.AGENT_RUN_STEP_SYNCED')).toBe(1);
  });
});

describe('AI-02.3.2 — recovery decisions are correct', () => {
  it('13. a step whose lease is still valid is not settled', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    // RUNNING with an old startedAt but a FRESH lease (updated_at = now).
    const past = new Date(Date.now() - 60 * 60_000);
    await db.update(agentRunSteps).set({ status: 'RUNNING', startedAt: past, updatedAt: new Date() }).where(eq(agentRunSteps.id, s.id));
    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });

  it('14. an unsettled (in-flight) task is never marked FAILED early', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'running' });
    const sweep = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(sweep.recovered).toBe(0);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
  });

  it('17. QUEUED / RUNNING / unknown tasks lead to no decision', async () => {
    const admin = await createUser('SUPER_ADMIN');
    for (const status of ['queued', 'running', 'awaiting_approval', 'mystery']) {
      const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
      const s = await stepRow(p.runId, 'mkt');
      await makeStuck(s.id);
      await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status });
      const res = await syncStepFromTask(db, s.id, auditCtx);
      expect(res.changed).toBe(false);
      expect((await stepRow(p.runId, 'mkt')).status).toBe('RUNNING');
    }
  });

  it('15. a SUCCEEDED task with a result syncs to SUCCEEDED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'succeeded', result: { ok: 1 } });
    expect((await syncStepFromTask(db, s.id, auditCtx)).status).toBe('SUCCEEDED');
  });

  it('16. a FAILED task syncs to FAILED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { m: 'x' } });
    expect((await syncStepFromTask(db, s.id, auditCtx)).status).toBe('FAILED');
  });

  it('a "succeeded" task with no result is not treated as success', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'succeeded' });
    expect((await syncStepFromTask(db, s.id, auditCtx)).changed).toBe(false);
  });
});

describe('AI-02.3.2 — run closure and state policy', () => {
  it('18. a run is not COMPLETED while a step is failed', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'ok', agentKey: 'product-agent' }),
      step({ stepKey: 'bad', agentKey: 'product-agent' }),
    ]);
    const ok = await dispatchStep(db, p.runId, 'ok', auditCtx);
    if (ok.taskId) createdTaskIds.push(ok.taskId);
    const s = await stepRow(p.runId, 'bad');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { m: 'x' } });
    expect(await recoverRun(db, p.runId, auditCtx)).toBe('PARTIALLY_COMPLETED');
  });

  it('18b. a run is not closed while a step is unsettled', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'product-agent' }),
      step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a'] }),
    ]);
    const out = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect((await runRow(p.runId)).status).toBe('RUNNING');
    expect(await recoverRun(db, p.runId, auditCtx)).toBe('RUNNING');
  });

  it('19. maxAttempts is enforced (no retry beyond the bound)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    await db.update(agentRunSteps).set({ attemptCount: 1 }).where(eq(agentRunSteps.runId, p.runId));
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/exhausted its attempts/);
    expect((await stepRow(p.runId, 'mkt')).status).toBe('PENDING');
  });

  it('CANCELLED cannot be re-dispatched by a stale caller', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    await cancelRun(db, p.runId, auditCtx);
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/not in a dispatchable state/);
  });
});

describe('AI-02.3.2 — permissions and approvals preserved', () => {
  it('20. a sensitive step still requires a human approval', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(dispatchStep(db, p.runId, 'risk', auditCtx)).rejects.toThrow(/requires human approval/);
    const s = await stepRow(p.runId, 'risk');
    await makeStuck(s.id);
    await recoverStuckSteps(db, STUCK, auditCtx);
    expect((await stepRow(p.runId, 'risk')).approvedBy).toBeNull();
  });

  it('20b. self-approval is refused', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(approveRunStep(db, p.runId, 'risk', admin, auditCtx)).rejects.toThrow(/your own run/);
  });

  it('21. the agent does not inherit the run requester’s elevated permissions', async () => {
    // A merchant (who lacks ad:create after revocation) cannot dispatch ads-agent,
    // proving permissions are checked at execution time, not inherited from any
    // supervisor identity.
    const merchant = await createUser('MERCHANT');
    const p = await plan(merchant, [step({ stepKey: 'ads', agentKey: 'ads-agent' })]);
    await db.delete(userRoles).where(eq(userRoles.userId, merchant));
    await expect(dispatchStep(db, p.runId, 'ads', auditCtx)).rejects.toThrow(/permission/);
  });

  it('21b. createAgentTask fencing never widens permissions for a sensitive agent', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    const s = await stepRow(p.runId, 'risk');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    // Even with a valid fence, a sensitive agent yields awaiting_approval, not
    // an executed task — fencing does not bypass the approval gate.
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      admin,
      { agentKey: 'risk-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
      auditCtx,
      { runId: p.runId, stepId: s.id, claimToken: 1 },
    );
    createdTaskIds.push(task.id);
    expect(task.status).toBe('awaiting_approval');
  });
});

describe('AI-02.3.2 — in-process recovery guard', () => {
  it('22+23+24. the guard serialises cycles and releases after a throw', async () => {
    const guard = createInFlightGuard();
    const gate = deferred();
    let runs = 0;
    const first = guard(async () => {
      runs += 1;
      await gate.promise;
      return 'first';
    });
    // Second call while the first is in flight: skipped (returns undefined).
    const second = await guard(async () => {
      runs += 1;
      return 'second';
    });
    expect(second).toBeUndefined();
    expect(runs).toBe(1);
    gate.resolve();
    expect(await first).toBe('first');

    // After completion the guard is free again.
    expect(await guard(async () => 'third')).toBe('third');

    // A throwing cycle must release the guard, not wedge it.
    await expect(
      guard(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await guard(async () => 'after-throw')).toBe('after-throw');
  });

  it('24b. one failed cycle does not affect the next', async () => {
    const guard = createInFlightGuard();
    await expect(guard(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    let ran = false;
    await guard(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('AI-02.3.2 — recovery cycle reporting', () => {
  it('22b. an empty sweep reports SUCCESS with zero counts', async () => {
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.status).toBe('SUCCESS');
    expect(res.recovered).toBe(0);
    expect(res.errors).toBe(0);
    expect(typeof res.scanned).toBe('number');
    expect(typeof res.skippedLease).toBe('number');
  });

  it('reports counts for a recovered step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await makeStuck(s.id);
    await insertLinkedTask({ stepId: s.id, runId: p.runId, requestedBy: admin, status: 'failed', error: { m: 'x' } });
    const res = await recoverStuckSteps(db, STUCK, auditCtx);
    expect(res.status).toBe('SUCCESS');
    expect(res.recovered).toBe(1);
    expect(res.scanned).toBeGreaterThanOrEqual(1);
  });
});

describe('AI-02.3.2 — linkage integrity', () => {
  it('3. findTaskForStep only matches the step it was given', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'product-agent' }),
      step({ stepKey: 'b', agentKey: 'product-agent' }),
    ]);
    const a = await stepRow(p.runId, 'a');
    const b = await stepRow(p.runId, 'b');
    await insertLinkedTask({ stepId: a.id, runId: p.runId, requestedBy: admin, status: 'failed' });
    expect(await findTaskForStep(db, a.id)).not.toBeNull();
    expect(await findTaskForStep(db, b.id)).toBeNull();
  });

  it('a fenced create with a mismatched runId is refused', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', attemptCount: 1, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRunSteps.id, s.id));
    await expect(
      createAgentTask(
        db,
        ['SUPER_ADMIN'],
        admin,
        { agentKey: 'product-agent', requestedBy: admin, input: { __runId: p.runId, __stepId: s.id } },
        auditCtx,
        { runId: randomUUID(), stepId: s.id, claimToken: 1 },
      ),
    ).rejects.toThrow(/no longer owned/);
    expect(await taskCountForStep(s.id)).toBe(0);
  });
});
