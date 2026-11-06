import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { aiBudgets } from '../src/db/schema/ai.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { planAgentRun, type ProposedStep } from '../src/modules/ai/planner.js';
import { dispatchStep, approveRunStep, cancelRun, reconcileRun } from '../src/modules/ai/dispatcher.js';

/**
 * AI-02.3 — Dispatch & Controlled Execution.
 *
 * Exercises the real dispatcher against the real database and the real agent-task
 * system: dependency gating, approvals (AI-02.P0), permissions, budget, atomic
 * single-winner claims, failure/skip propagation, run reconciliation and audit.
 */

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];
const createdBudgetIds: string[] = [];
const createdRegistryKeys: string[] = [];

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai023-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

const auditCtx = { actorId: null, actorType: 'USER' as const };

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const fieldErrors = (err as { fieldErrors?: Array<{ code: string }> }).fieldErrors;
    if (fieldErrors?.length) return fieldErrors[0].code;
    throw err;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

/** Plans a run and remembers it for cleanup. */
async function plan(requester: string, steps: ProposedStep[], title = 'IT run') {
  const p = await planAgentRun(db, requester, { title, steps }, auditCtx);
  createdRunIds.push(p.runId);
  return p;
}

async function stepRow(runId: string, stepKey: string) {
  const rows = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId));
  return rows.find((r) => r.stepKey === stepKey)!;
}

async function runRow(runId: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return rows[0];
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
  if (createdBudgetIds.length) await db.delete(aiBudgets).where(inArray(aiBudgets.id, createdBudgetIds));
  if (createdRegistryKeys.length) await db.delete(agentRegistry).where(inArray(agentRegistry.key, createdRegistryKeys));
  if (createdUserIds.length) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeDb();
});

describe('AI-02.3 — dispatching a valid step through the existing task system', () => {
  it('dispatches a step, creates an agent task via the task system, and marks it SUCCEEDED', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);

    expect(out.status).toBe('SUCCEEDED');
    expect(out.taskId).not.toBeNull();

    // The task really exists in the agent-task system and points back at the step.
    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, out.taskId!)))[0];
    expect(task.agentKey).toBe('marketing-agent');
    expect(task.status).toBe('succeeded');
    expect((task.input as Record<string, unknown>).__stepId).toBe((await stepRow(p.runId, 'mkt')).id);

    // The step carries the linked task id and a result.
    const s = await stepRow(p.runId, 'mkt');
    expect(s.status).toBe('SUCCEEDED');
    expect((s.result as { taskId?: string }).taskId).toBe(out.taskId);
    expect(s.attemptCount).toBe(1);
  });

  it('records the run in RUNNING while steps remain, then closes it when all are done', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'analytics-agent', dependsOn: ['a'] }),
    ]);
    const outA = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (outA.taskId) createdTaskIds.push(outA.taskId);
    expect(outA.runStatus).toBe('RUNNING');

    const outB = await dispatchStep(db, p.runId, 'b', auditCtx);
    if (outB.taskId) createdTaskIds.push(outB.taskId);
    expect(outB.status).toBe('SUCCEEDED');
    // Every step succeeded → the run closes COMPLETED.
    expect(outB.runStatus).toBe('COMPLETED');
    expect((await runRow(p.runId)).status).toBe('COMPLETED');
  });

  it('writes dispatch and outcome audit entries', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, (await stepRow(p.runId, 'mkt')).id));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('AI.AGENT_RUN_STEP_DISPATCHED');
    expect(actions).toContain('AI.AGENT_RUN_STEP_SUCCEEDED');
  });
});

describe('AI-02.3 — dependencies gate dispatch', () => {
  it('refuses to dispatch a step before its dependency has succeeded', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'analytics-agent', dependsOn: ['a'] }),
    ]);
    await expect(dispatchStep(db, p.runId, 'b', auditCtx)).rejects.toThrow(/before its dependency/);
    // The blocked step was not claimed and no task was created.
    expect((await stepRow(p.runId, 'b')).status).toBe('PENDING');
  });

  it('does not treat SKIPPED as success for a dependent step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'analytics-agent', dependsOn: ['a'] }),
    ]);
    // Mark only the prerequisite SKIPPED (not the dependent step itself).
    await db.update(agentRunSteps).set({ status: 'SKIPPED' }).where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'a')));
    await expect(dispatchStep(db, p.runId, 'b', auditCtx)).rejects.toThrow(/before its dependency/);
  });
});

describe('AI-02.3 — duplicate and concurrent dispatch are prevented', () => {
  it('refuses a second dispatch of the same step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'mkt', agentKey: 'marketing-agent' }),
      step({ stepKey: 'other', agentKey: 'analytics-agent' }),
    ]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    // A second dispatch of the same (now SUCCEEDED) step is refused.
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/already terminal/);
    // Only one task exists for that step.
    const s = await stepRow(p.runId, 'mkt');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'marketing-agent'));
    const forStep = tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id);
    expect(forStep.length).toBe(1);
  });

  it('never re-runs a step already in RUNNING', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    await db.update(agentRunSteps).set({ status: 'RUNNING' }).where(eq(agentRunSteps.runId, p.runId));
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/already RUNNING/);
  });

  it('lets only one of two concurrent dispatches win (atomic claim)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);

    const results = await Promise.allSettled([
      dispatchStep(db, p.runId, 'mkt', auditCtx),
      dispatchStep(db, p.runId, 'mkt', auditCtx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    for (const r of fulfilled) {
      if (r.status === 'fulfilled' && r.value.taskId) createdTaskIds.push(r.value.taskId);
    }

    // Exactly one task was created for the step.
    const s = await stepRow(p.runId, 'mkt');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.agentKey, 'marketing-agent'));
    const forStep = tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === s.id);
    expect(forStep.length).toBe(1);
  });
});

describe('AI-02.3 — approvals (AI-02.P0 preserved)', () => {
  it('refuses to dispatch a sensitive step before approval', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(dispatchStep(db, p.runId, 'risk', auditCtx)).rejects.toThrow(/requires human approval/);
    expect((await stepRow(p.runId, 'risk')).status).toBe('PENDING');
  });

  it('refuses self-approval of a step (requester cannot approve their own run)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(approveRunStep(db, p.runId, 'risk', admin, auditCtx)).rejects.toThrow(/your own run/);
  });

  it('allows a different authorised approver, then dispatches the sensitive step', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const approver = await createUser('SUPER_ADMIN');
    const p = await plan(requester, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);

    const approved = await approveRunStep(db, p.runId, 'risk', approver, { actorId: approver, actorType: 'USER' });
    expect(approved.status).toBe('READY');
    expect((await stepRow(p.runId, 'risk')).approvedBy).toBe(approver);

    const out = await dispatchStep(db, p.runId, 'risk', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.status).toBe('SUCCEEDED');
  });

  it('refuses approval from a user without AI management authority', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const merchant = await createUser('MERCHANT');
    const p = await plan(requester, [step({ stepKey: 'risk', agentKey: 'risk-agent' })]);
    await expect(approveRunStep(db, p.runId, 'risk', merchant, auditCtx)).rejects.toThrow(/authority/);
  });
});

describe('AI-02.3 — agent, permission and budget guards', () => {
  it('refuses a step whose agent is unknown', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'x', agentKey: 'marketing-agent' })]);
    await db.update(agentRunSteps).set({ agentKey: 'no-such-agent' }).where(eq(agentRunSteps.runId, p.runId));
    expect(await rejectionCode(() => dispatchStep(db, p.runId, 'x', auditCtx))).toBe('UNKNOWN_AGENT');
  });

  it('refuses a step whose agent became inactive after planning', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    // Deactivate the agent between planning and dispatch.
    await db.update(agentRegistry).set({ isActive: false }).where(eq(agentRegistry.key, 'marketing-agent'));
    try {
      expect(await rejectionCode(() => dispatchStep(db, p.runId, 'mkt', auditCtx))).toBe('INACTIVE_AGENT');
    } finally {
      await db.update(agentRegistry).set({ isActive: true }).where(eq(agentRegistry.key, 'marketing-agent'));
    }
  });

  it('refuses a step when the requester lacks the agent permission', async () => {
    const merchant = await createUser('MERCHANT');
    // ads-agent needs ai:use + ad:create — MERCHANT holds both, so planning passes.
    const p = await plan(merchant, [step({ stepKey: 'ads', agentKey: 'ads-agent' })]);
    // Revoke the role between planning and dispatch.
    await db.delete(userRoles).where(eq(userRoles.userId, merchant));
    await expect(dispatchStep(db, p.runId, 'ads', auditCtx)).rejects.toThrow(/permission/);
  });

  it('refuses dispatch when the requester budget is exhausted', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({ id: budgetId, userId: admin, period: 'MONTHLY', maxRequests: 0, isActive: true });
    createdBudgetIds.push(budgetId);
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toThrow(/budget exhausted/);
    // The step was not claimed.
    expect((await stepRow(p.runId, 'mkt')).status).toBe('PENDING');
  });
});

describe('AI-02.3 — failure handling and dependency cascade', () => {
  it('records a FAILED step and skips its dependents when execution fails', async () => {
    const admin = await createUser('SUPER_ADMIN');
    // A registry-only agent (not in AGENT_CATALOGUE) passes dispatch's registry
    // check but makes createAgentTask fail — a realistic dispatch failure.
    const key = `it-ai023-ghost-${Date.now()}`;
    await db.insert(agentRegistry).values({
      id: randomUUID(),
      key,
      name: 'Ghost executor agent',
      capabilities: [] as never,
      permissionsRequired: [] as never,
      requiresHumanApproval: false,
      isActive: true,
    });
    createdRegistryKeys.push(key);

    const p = await plan(admin, [
      step({ stepKey: 'bad', agentKey: key }),
      step({ stepKey: 'after', agentKey: 'marketing-agent', dependsOn: ['bad'] }),
    ]);

    const out = await dispatchStep(db, p.runId, 'bad', auditCtx);
    expect(out.status).toBe('FAILED');
    expect(out.taskId).toBeNull();

    // The dependent step is skipped, not executed.
    expect((await stepRow(p.runId, 'after')).status).toBe('SKIPPED');
    // No step succeeded → the run is FAILED.
    expect((await runRow(p.runId)).status).toBe('FAILED');
  });

  it('closes a run PARTIALLY_COMPLETED when some steps fail but others succeed', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'ok', agentKey: 'marketing-agent' }),
      step({ stepKey: 'bad', agentKey: 'marketing-agent' }),
    ]);

    // One step succeeds through the real dispatch path...
    const out = await dispatchStep(db, p.runId, 'ok', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.runStatus).toBe('RUNNING');

    // ...the other fails, then the run is reconciled.
    await db.update(agentRunSteps).set({ status: 'FAILED' }).where(and(eq(agentRunSteps.runId, p.runId), eq(agentRunSteps.stepKey, 'bad')));
    const status = await reconcileRun(db, p.runId, auditCtx);
    expect(status).toBe('PARTIALLY_COMPLETED');
    expect((await runRow(p.runId)).status).toBe('PARTIALLY_COMPLETED');
  });
});

describe('AI-02.3 — cancellation', () => {
  it('cancels a run, cancels its steps, and refuses any new dispatch', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'marketing-agent' }),
      step({ stepKey: 'b', agentKey: 'analytics-agent' }),
    ]);
    const status = await cancelRun(db, p.runId, auditCtx);
    expect(status).toBe('CANCELLED');
    expect((await runRow(p.runId)).status).toBe('CANCELLED');
    expect((await stepRow(p.runId, 'a')).status).toBe('CANCELLED');
    await expect(dispatchStep(db, p.runId, 'a', auditCtx)).rejects.toThrow(/not in a dispatchable state/);
  });
});

describe('AI-02.3 — no path bypasses the agent-task system', () => {
  it('dispatcher.ts never imports an executor directly', () => {
    const path = fileURLToPath(new URL('../src/modules/ai/dispatcher.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/from ['"].*executors/);
    expect(src).not.toMatch(/executeAgentTask/);
    // It must route through the existing task system.
    expect(src).toMatch(/createAgentTask/);
  });

  it('a dispatched step always produces a row in agent_tasks', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'marketing-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, out.taskId!));
    expect(rows.length).toBe(1);
  });
});
