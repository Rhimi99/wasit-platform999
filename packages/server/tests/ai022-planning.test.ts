import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { aiRequests, aiBudgets } from '../src/db/schema/ai.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { ensureAgentRegistrySeeded, createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import {
  planAgentRun,
  validatePlan,
  loadPlan,
  topologicalOrder,
  MAX_PLAN_STEPS,
  type ProposedStep,
} from '../src/modules/ai/planner.js';

/**
 * AI-02.2 — Planning & Dependency Resolution.
 *
 * Exercises the real planning service against the real database: validation,
 * dependency resolution, deterministic topological ordering, and persistence of
 * a run + its steps. Crucially it proves the boundary of this phase — planning
 * runs NO agent and never advances the run past PLANNING.
 */

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai022-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: 'x',
    firstName: 'IT',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) {
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  }
  createdUserIds.push(id);
  return id;
}

const auditCtx = { actorId: null, actorType: 'USER' as const };

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

/**
 * Runs `fn` and returns the rejection code carried in the thrown error's
 * `fieldErrors[0].code`. `ApiError.validation` intentionally keeps a generic
 * message and puts the machine-readable reason in `fieldErrors`, so tests assert
 * on the code (the real contract), not on a display string.
 */
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

async function countRows(table: typeof agentTasks | typeof aiRequests): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  if (createdRunIds.length) {
    await db.delete(agentRunSteps).where(inArray(agentRunSteps.runId, createdRunIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds));
  }
  if (createdUserIds.length) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeDb();
});

describe('AI-02.2 — planning: valid plans and persistence', () => {
  it('creates a multi-step plan, links each step to a registered agent, and persists it in PLANNING', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      requester,
      {
        title: 'Launch product X in France',
        steps: [
          step({ stepKey: 'research', agentKey: 'market-research-agent' }),
          step({ stepKey: 'product', agentKey: 'product-agent', dependsOn: ['research'] }),
          step({ stepKey: 'marketing', agentKey: 'marketing-agent', dependsOn: ['product'], priority: 5 }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);

    expect(plan.status).toBe('PLANNING');
    expect(plan.steps.length).toBe(3);

    // Every step is bound to a real registry agent.
    const keys = plan.steps.map((s) => s.agentKey);
    const registered = await db.select().from(agentRegistry).where(inArray(agentRegistry.key, keys));
    expect(registered.length).toBe(3);

    // Persisted rows exist and belong to the run.
    const runRows = await db.select().from(agentRuns).where(eq(agentRuns.id, plan.runId));
    expect(runRows[0].status).toBe('PLANNING');
    expect(runRows[0].requestedBy).toBe(requester);
    const stepRows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, plan.runId));
    expect(stepRows.length).toBe(3);
    expect(stepRows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('records an audit entry for the planning action', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      requester,
      { title: 'Audited plan', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent' })] },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, plan.runId));
    expect(rows.some((r) => r.action === 'AI.AGENT_RUN_PLANNED')).toBe(true);
  });

  it('rejects a duplicate runKey (idempotency)', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const runKey = `key-${randomUUID()}`;
    const plan = await planAgentRun(
      db,
      requester,
      { runKey, title: 'First', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent' })] },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    await expect(
      planAgentRun(
        db,
        requester,
        { runKey, title: 'Second', steps: [step({ stepKey: 'b', agentKey: 'marketing-agent' })] },
        auditCtx,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an unknown requester', async () => {
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          randomUUID(),
          { title: 'Ghost', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent' })] },
          auditCtx,
        ),
      ),
    ).toBe('UNKNOWN_REQUESTER');
  });
});

describe('AI-02.2 — dependency resolution and ordering', () => {
  it('orders dependencies before dependents (topological)', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      requester,
      {
        title: 'Ordered plan',
        steps: [
          step({ stepKey: 'c', agentKey: 'marketing-agent', dependsOn: ['b'] }),
          step({ stepKey: 'a', agentKey: 'market-research-agent' }),
          step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a'] }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    const order = plan.steps.map((s) => s.stepKey);
    expect(order).toEqual(['a', 'b', 'c']);
    // executionOrder is contiguous and consistent.
    expect(plan.steps.map((s) => s.executionOrder)).toEqual([0, 1, 2]);
  });

  it('never lets priority override a dependency', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      requester,
      {
        title: 'Priority vs dependency',
        steps: [
          step({ stepKey: 'dependent', agentKey: 'marketing-agent', dependsOn: ['prereq'], priority: 100 }),
          step({ stepKey: 'prereq', agentKey: 'product-agent', priority: 0 }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    // Despite priority 100, "dependent" still comes after its prerequisite.
    expect(plan.steps.map((s) => s.stepKey)).toEqual(['prereq', 'dependent']);
  });

  it('produces a reproducible order for equal inputs (priority then key)', () => {
    const steps = [
      { stepKey: 'z', dependsOn: [], priority: 1 },
      { stepKey: 'a', dependsOn: [], priority: 1 },
      { stepKey: 'm', dependsOn: [], priority: 5 },
    ];
    const first = topologicalOrder(steps);
    const second = topologicalOrder(steps);
    expect(first).toEqual(second);
    // Highest priority first; equal priority broken deterministically by key.
    expect(first).toEqual(['m', 'a', 'z']);
  });
});

describe('AI-02.2 — plan validation rejects bad plans', () => {
  it('rejects an unknown agent', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          { title: 'Bad agent', steps: [step({ stepKey: 'a', agentKey: 'does-not-exist' })] },
          auditCtx,
        ),
      ),
    ).toBe('UNKNOWN_AGENT');
  });

  it('rejects a duplicate stepKey', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          {
            title: 'Dup',
            steps: [
              step({ stepKey: 'a', agentKey: 'marketing-agent' }),
              step({ stepKey: 'a', agentKey: 'product-agent' }),
            ],
          },
          auditCtx,
        ),
      ),
    ).toBe('DUPLICATE');
  });

  it('rejects a missing/empty stepKey', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(db, requester, { title: 'No key', steps: [step({ stepKey: '  ', agentKey: 'marketing-agent' })] }, auditCtx),
      ),
    ).toBe('REQUIRED');
  });

  it('rejects a dependency on an unknown step', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          { title: 'Unknown dep', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent', dependsOn: ['ghost'] })] },
          auditCtx,
        ),
      ),
    ).toBe('UNKNOWN_DEPENDENCY');
  });

  it('rejects a self-dependency', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          { title: 'Self dep', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent', dependsOn: ['a'] })] },
          auditCtx,
        ),
      ),
    ).toBe('SELF_DEPENDENCY');
  });

  it('rejects a dependency cycle', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          {
            title: 'Cycle',
            steps: [
              step({ stepKey: 'a', agentKey: 'marketing-agent', dependsOn: ['b'] }),
              step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a'] }),
            ],
          },
          auditCtx,
        ),
      ),
    ).toBe('CYCLE');
  });

  it('rejects duplicate dependencies on a step', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          {
            title: 'Dup deps',
            steps: [
              step({ stepKey: 'a', agentKey: 'marketing-agent' }),
              step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a', 'a'] }),
            ],
          },
          auditCtx,
        ),
      ),
    ).toBe('DUPLICATE_DEPENDENCY');
  });

  it('rejects invalid input (non-object)', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          { title: 'Bad input', steps: [{ stepKey: 'a', agentKey: 'marketing-agent', input: [] as never }] },
          auditCtx,
        ),
      ),
    ).toBe('INVALID');
  });

  it('rejects an invalid priority', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(
      await rejectionCode(() =>
        planAgentRun(
          db,
          requester,
          { title: 'Bad priority', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent', priority: -3 })] },
          auditCtx,
        ),
      ),
    ).toBe('INVALID');
  });

  it('rejects a plan that exceeds the step limit', async () => {
    const requester = await createUser('SUPER_ADMIN');
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) =>
      step({ stepKey: `s${i}`, agentKey: 'marketing-agent' }),
    );
    expect(await rejectionCode(() => planAgentRun(db, requester, { title: 'Too big', steps }, auditCtx))).toBe(
      'MAX_STEPS_EXCEEDED',
    );
  });

  it('rejects an empty plan', async () => {
    const requester = await createUser('SUPER_ADMIN');
    expect(await rejectionCode(() => planAgentRun(db, requester, { title: 'Empty', steps: [] }, auditCtx))).toBe(
      'REQUIRED',
    );
  });
});

describe('AI-02.2 — permissions and approvals', () => {
  it('rejects a step whose agent needs a permission the requester lacks', async () => {
    // MERCHANT holds ai:use and ad:create but not risk:read.
    const merchant = await createUser('MERCHANT');
    await expect(
      planAgentRun(
        db,
        merchant,
        { title: 'No risk perm', steps: [step({ stepKey: 'r', agentKey: 'risk-agent' })] },
        auditCtx,
      ),
    ).rejects.toThrow(/permission/);
  });

  it('lets an administrator plan any registered agent', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      admin,
      { title: 'Admin plan', steps: [step({ stepKey: 'r', agentKey: 'risk-agent' })] },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    expect(plan.status).toBe('PLANNING');
  });

  it('carries the approval requirement of a sensitive agent into the plan', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      admin,
      {
        title: 'Approval carry-over',
        steps: [
          step({ stepKey: 'gated', agentKey: 'risk-agent' }),
          step({ stepKey: 'open', agentKey: 'marketing-agent' }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    const gated = plan.steps.find((s) => s.stepKey === 'gated')!;
    const open = plan.steps.find((s) => s.stepKey === 'open')!;
    expect(gated.requiresApproval).toBe(true);
    expect(open.requiresApproval).toBe(false);
    // The gated step is not executed or approved — it waits in PENDING.
    expect(gated.status).toBe('PENDING');
  });

  it('does not treat planning as an approval (run stays PLANNING, no task created)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const beforeTasks = await countRows(agentTasks);
    const plan = await planAgentRun(
      db,
      admin,
      { title: 'Not an approval', steps: [step({ stepKey: 'g', agentKey: 'risk-agent' })] },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    const afterTasks = await countRows(agentTasks);
    expect(afterTasks).toBe(beforeTasks);
    const runRows = await db.select().from(agentRuns).where(eq(agentRuns.id, plan.runId));
    expect(runRows[0].status).toBe('PLANNING');
  });

  it('rejects planning when the requester budget is exhausted', async () => {
    const user = await createUser('SUPER_ADMIN');
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({
      id: budgetId,
      userId: user,
      period: 'MONTHLY',
      maxRequests: 0,
      isActive: true,
    });
    try {
      await expect(
        planAgentRun(
          db,
          user,
          { title: 'No budget', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent' })] },
          auditCtx,
        ),
      ).rejects.toThrow(/budget exhausted/);
    } finally {
      await db.delete(aiBudgets).where(eq(aiBudgets.id, budgetId));
    }
  });

  it('keeps the AI-02.P0 separation-of-duties guard intact (self-approval refused)', async () => {
    // A gated task created by a user cannot be approved by that same user, and
    // approving it never runs an executor here because the guard throws first.
    const admin = await createUser('SUPER_ADMIN');
    const created = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      admin,
      { agentKey: 'sales-agent', requestedBy: admin, input: { action: 'identify_leads' } },
      { actorId: admin, actorType: 'USER' },
    );
    expect(created.status).toBe('awaiting_approval');
    await expect(
      decideAgentTask(db, created.id, admin, 'APPROVE', null, { actorId: admin, actorType: 'USER' }),
    ).rejects.toThrow(/cannot approve your own/);
  });
});

describe('AI-02.2 — planning never executes agents', () => {
  it('runs no executor and creates no agent task or AI request', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const tasksBefore = await countRows(agentTasks);
    const requestsBefore = await countRows(aiRequests);

    const plan = await planAgentRun(
      db,
      admin,
      {
        title: 'No execution',
        steps: [
          step({ stepKey: 'a', agentKey: 'marketing-agent' }),
          step({ stepKey: 'b', agentKey: 'product-agent', dependsOn: ['a'] }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);

    expect(await countRows(agentTasks)).toBe(tasksBefore);
    expect(await countRows(aiRequests)).toBe(requestsBefore);
  });

  it('never advances the run beyond PLANNING (no DISPATCHING / RUNNING)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      admin,
      { title: 'Stays planning', steps: [step({ stepKey: 'a', agentKey: 'marketing-agent' })] },
      auditCtx,
    );
    createdRunIds.push(plan.runId);
    const runRows = await db.select().from(agentRuns).where(eq(agentRuns.id, plan.runId));
    expect(runRows[0].status).toBe('PLANNING');
    expect(runRows[0].status).not.toBe('DISPATCHING');
    expect(runRows[0].status).not.toBe('RUNNING');
    // No step was moved into a running/successful state.
    const stepRows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, plan.runId));
    expect(stepRows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('re-reads a persisted plan and re-verifies it (loadPlan)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const plan = await planAgentRun(
      db,
      admin,
      {
        title: 'Reloadable',
        steps: [
          step({ stepKey: 'second', agentKey: 'product-agent', dependsOn: ['first'] }),
          step({ stepKey: 'first', agentKey: 'market-research-agent' }),
        ],
      },
      auditCtx,
    );
    createdRunIds.push(plan.runId);

    const reloaded = await loadPlan(db, plan.runId);
    expect(reloaded.runId).toBe(plan.runId);
    expect(reloaded.status).toBe('PLANNING');
    expect(reloaded.steps.map((s) => s.stepKey)).toEqual(['first', 'second']);
    expect(reloaded.steps[1].dependsOn).toEqual(['first']);
  });

  it('validatePlan re-checks dependencies on every call (no caching of a prior verdict)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    // A first, valid call...
    await expect(
      validatePlan(db, admin, [step({ stepKey: 'a', agentKey: 'marketing-agent' })]),
    ).resolves.toBeDefined();
    // ...does not make a later, cyclic plan acceptable.
    expect(
      await rejectionCode(() =>
        validatePlan(db, admin, [
          step({ stepKey: 'x', agentKey: 'marketing-agent', dependsOn: ['y'] }),
          step({ stepKey: 'y', agentKey: 'product-agent', dependsOn: ['x'] }),
        ]),
      ),
    ).toBe('CYCLE');
  });
});
