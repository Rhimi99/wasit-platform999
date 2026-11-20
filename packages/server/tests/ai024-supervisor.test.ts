import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { aiBudgets } from '../src/db/schema/ai.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { planAgentRun, type ProposedStep } from '../src/modules/ai/planner.js';
import { dispatchStep, cancelRun } from '../src/modules/ai/dispatcher.js';
import { DEFAULT_SUPERVISOR_LIMITS } from '../src/modules/ai/supervisor-policy.js';
import {
  runSupervisorCycle,
  containRun,
  containRunManually,
  retryStep,
  createSupervisorCycleGuard,
} from '../src/modules/ai/supervisor.js';

/**
 * AI-02.S1 — Agent Supervisor + Retry Policy.
 *
 * Exercises the real supervisor against the real database, the real state
 * machine and the real dispatcher: containment decisions, the retry policy and
 * its bounds, dependency gating, concurrency (single winner), and audit. Nothing
 * is mocked — the value here is exactly the behaviour a mock would hide.
 */

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];
const createdBudgetIds: string[] = [];

const auditCtx = { actorId: null, actorType: 'USER' as const };

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    taskIds: createdTaskIds,
    runIds: createdRunIds,
    budgetIds: createdBudgetIds,
  });
  await closeDb();
});

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai024-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

async function plan(requester: string, steps: ProposedStep[], title = 'IT supervisor run') {
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

async function taskCountForStep(stepId: string): Promise<number> {
  const rows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(sql`${agentTasks.input}->>'__stepId' = ${stepId}`);
  return rows.length;
}

/** Inserts a task linked to a run (and optionally a step), bypassing the dispatcher. */
async function insertLinkedTask(opts: {
  requester: string;
  runId: string;
  stepId?: string;
  status?: string;
  cost?: string;
}): Promise<string> {
  const id = randomUUID();
  const input: Record<string, unknown> = { __runId: opts.runId };
  if (opts.stepId) input.__stepId = opts.stepId;
  await db.insert(agentTasks).values({
    id,
    agentKey: 'marketing-agent',
    requestedBy: opts.requester,
    input: input as never,
    status: opts.status ?? 'failed',
    cost: opts.cost ?? '0',
  });
  createdTaskIds.push(id);
  return id;
}

async function auditActionsFor(entityId: string): Promise<string[]> {
  const rows = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, entityId));
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------------------
// A. Supervisor policy (live rows)
// ---------------------------------------------------------------------------

describe('AI-02.S1 — supervisor containment decisions', () => {
  it('does not contain a healthy run', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    const out = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect((await runRow(p.runId)).status).toBe('RUNNING');

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.contained).toBe(0);
    expect((await runRow(p.runId)).status).toBe('RUNNING');
  });

  it('contains a run whose step is stuck RUNNING past the ceiling', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    const out = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);

    // Make the run look stuck: a RUNNING step and an old run start.
    const old = new Date(Date.now() - (DEFAULT_SUPERVISOR_LIMITS.stuckRuntimeSeconds + 100) * 1000);
    await db.update(agentRuns).set({ startedAt: old }).where(eq(agentRuns.id, p.runId));
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', startedAt: old, updatedAt: old })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'b')));

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.contained).toBe(1);

    const run = await runRow(p.runId);
    expect(run.status).toBe('FAILED');
    expect((run.error as { contained?: boolean }).contained).toBe(true);
    // Non-terminal steps are cancelled; the already-succeeded step is untouched.
    expect((await stepRow(p.runId, 'b')).status).toBe('CANCELLED');
    expect((await stepRow(p.runId, 'a')).status).toBe('SUCCEEDED');
    expect(await auditActionsFor(p.runId)).toContain('AI.AGENT_RUN_CONTAINED');
  });

  it('contains a run that exceeds the budget ceiling', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    // A linked task with a cost above the run ceiling.
    await insertLinkedTask({ requester: admin, runId: p.runId, status: 'succeeded', cost: String(DEFAULT_SUPERVISOR_LIMITS.maxRunCostUsd + 5) });

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.contained).toBe(1);
    const run = await runRow(p.runId);
    expect(run.status).toBe('FAILED');
    expect((run.error as { action?: string }).action).toBe('block-budget');
  });

  it('contains a run whose attempts reached the ceiling', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: DEFAULT_SUPERVISOR_LIMITS.maxAttempts, maxAttempts: DEFAULT_SUPERVISOR_LIMITS.maxAttempts })
      .where(eq(agentRunSteps.runId, p.runId));

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.contained).toBe(1);
    expect((await runRow(p.runId)).status).toBe('FAILED');
  });

  it('does not contain or retry a run that is already terminal', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    const out = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect((await runRow(p.runId)).status).toBe('COMPLETED');

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    // A terminal run is not even selected.
    expect(cycle.scanned).toBe(0);
    expect(cycle.contained).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. Retry policy
// ---------------------------------------------------------------------------

describe('AI-02.S1 — retry policy', () => {
  it('retries an eligible FAILED step and records the attempt', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    // Simulate a step that failed on its first attempt.
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1 })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'a')));

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.retried).toBe(1);

    const s = await stepRow(p.runId, 'a');
    expect(s.status).toBe('SUCCEEDED');
    expect(s.attemptCount).toBe(2);
    expect(s.maxAttempts).toBe(DEFAULT_SUPERVISOR_LIMITS.maxAttempts);
    expect(await taskCountForStep(s.id)).toBe(1);
    expect(await auditActionsFor(s.id)).toContain('AI.AGENT_RUN_STEP_RETRY_SCHEDULED');
  });

  it('respects the attempt ceiling (a run that exhausted attempts is contained, not retried)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: DEFAULT_SUPERVISOR_LIMITS.maxAttempts, maxAttempts: DEFAULT_SUPERVISOR_LIMITS.maxAttempts })
      .where(eq(agentRunSteps.runId, p.runId));

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.retried).toBe(0);
    expect(cycle.contained).toBe(1);
    // No task was created for the step.
    expect(await taskCountForStep((await stepRow(p.runId, 'a')).id)).toBe(0);
  });

  it('refuses to retry when the requester budget is exhausted', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1 })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'a')));
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({ id: budgetId, userId: admin, period: 'MONTHLY', maxRequests: 0, isActive: true });
    createdBudgetIds.push(budgetId);

    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, p.runId));
    const a = steps.find((s) => s.stepKey === 'a')!;
    const outcome = await retryStep(db, p.runId, { ...a, dependsOn: a.dependsOn as string[] } as never, steps as never, auditCtx);
    expect(outcome.retried).toBe(false);
    expect(outcome.code).toBe('BUDGET_EXHAUSTED');
  });

  it('does not repeat a successful step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    const out = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);

    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, p.runId));
    const a = steps[0];
    const outcome = await retryStep(db, p.runId, { ...a, dependsOn: a.dependsOn as string[] } as never, steps as never, auditCtx);
    expect(outcome.retried).toBe(false);
    expect(outcome.code).toBe('NOT_FAILED');
  });

  it('does not retry a cancelled step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    await cancelRun(db, p.runId, auditCtx);
    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, p.runId));
    const a = steps.find((s) => s.stepKey === 'a')!;
    const outcome = await retryStep(db, p.runId, { ...a, dependsOn: a.dependsOn as string[] } as never, steps as never, auditCtx);
    expect(outcome.retried).toBe(false);
    expect(outcome.code).toBe('NOT_FAILED');
  });

  it('refuses to retry when a dependency is SKIPPED (SKIPPED is not success)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent', dependsOn: ['a'] }),
    ]);
    await db
      .update(agentRunSteps)
      .set({ status: 'SKIPPED' })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'a')));
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1 })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'b')));

    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, p.runId));
    const b = steps.find((s) => s.stepKey === 'b')!;
    const outcome = await retryStep(db, p.runId, { ...b, dependsOn: b.dependsOn as string[] } as never, steps as never, auditCtx);
    expect(outcome.retried).toBe(false);
    expect(outcome.code).toBe('DEPS_UNMET');
  });

  it('a repeated cycle does not create a duplicate retry', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    const a = await stepRow(p.runId, 'a');
    await insertLinkedTask({ requester: admin, runId: p.runId, stepId: a.id, status: 'failed' });
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1 })
      .where(eq(agentRunSteps.id, a.id));

    const first = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(first.retried).toBe(1);
    // The retry unlinks the old task and creates exactly one new linked task.
    const afterFirst = await taskCountForStep(a.id);
    expect(afterFirst).toBe(1);

    const second = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(second.retried).toBe(0);
    expect(await taskCountForStep(a.id)).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// C. Concurrency & reliability
// ---------------------------------------------------------------------------

describe('AI-02.S1 — concurrency and reliability', () => {
  it('two concurrent cycles retry a step exactly once', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    const a = await stepRow(p.runId, 'a');
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1 })
      .where(eq(agentRunSteps.id, a.id));

    await Promise.all([
      runSupervisorCycle(db, auditCtx, { runIds: [p.runId] }),
      runSupervisorCycle(db, auditCtx, { runIds: [p.runId] }),
    ]);

    // Only one retry task may exist, and the step must be SUCCEEDED once.
    expect(await taskCountForStep(a.id)).toBe(1);
    const settled = await stepRow(p.runId, 'a');
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.attemptCount).toBe(2);
  });

  it('a failed retry leaves the step FAILED and the run uncorrupted', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    // A step whose agent does not exist: the retry cannot start.
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: 1, maxAttempts: 1, agentKey: 'ghost-agent' })
      .where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'a')));

    const cycle = await runSupervisorCycle(db, auditCtx, { runIds: [p.runId] });
    expect(cycle.retried).toBe(0);
    expect(cycle.errors).toBe(0);

    const s = await stepRow(p.runId, 'a');
    expect(s.status).toBe('FAILED');
    expect(s.attemptCount).toBe(2); // the attempt was consumed
    expect(await auditActionsFor(s.id)).toContain('AI.AGENT_RUN_STEP_RETRY_FAILED');
    // The run was not closed by the failed retry — not corrupted. (The
    // dispatcher's own failure handling may advance it out of PLANNING, but it
    // never closes a run while another step is still pending.)
    const runStatus = (await runRow(p.runId)).status;
    expect(['PLANNING', 'DISPATCHING', 'RUNNING', 'AGGREGATING']).toContain(runStatus);
    expect((await stepRow(p.runId, 'b')).status).toBe('PENDING');
  });

  it('the in-process cycle guard prevents self-overlap', async () => {
    const guard = createSupervisorCycleGuard();
    let concurrent = 0;
    let maxConcurrent = 0;
    const job = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
      return 1;
    };
    const results = await Promise.all([guard(job), guard(job), guard(job)]);
    expect(maxConcurrent).toBe(1);
    // Only one of the three ran; the others were skipped (undefined).
    expect(results.filter((r) => r === 1).length).toBe(1);
  });

  it('containment is idempotent (a second attempt is a no-op)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent' }),
    ]);
    const first = await containRun(db, p.runId, 'manual', 'manual-contain', auditCtx);
    expect(first).toBe(true);
    const second = await containRun(db, p.runId, 'manual', 'manual-contain', auditCtx);
    expect(second).toBe(false);
    expect((await runRow(p.runId)).status).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// D. Audit
// ---------------------------------------------------------------------------

describe('AI-02.S1 — audit trail', () => {
  it('records containment with its reason and action', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]);
    await containRunManually(db, p.runId, 'operator stop', auditCtx);

    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, p.runId), eq(auditLogs.action, 'AI.AGENT_RUN_CONTAINED')));
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as { reason?: string }).reason).toBe('operator stop');
    expect((rows[0].metadata as { action?: string }).action).toBe('manual-contain');
  });
});
