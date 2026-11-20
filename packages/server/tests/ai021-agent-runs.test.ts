import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { agentSchedules } from '../src/db/schema/agent_schedules.js';
import {
  RUN_STATES,
  RUN_STEP_STATES,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
  canTransitionRun,
  canTransitionStep,
  assertRunTransition,
  assertStepTransition,
  assertStepSuccess,
  assertRunCompletion,
  resolveCompletionStatus,
  assertValidDependencies,
  isTerminalRunStatus,
  isTerminalStepStatus,
  type AgentRunStatus,
  type AgentRunStepStatus,
} from '../src/modules/ai/run-state-machine.js';

/**
 * AI-02.1 — Agent Runs & State Machine.
 *
 * Two layers are proven here against the real database:
 *  1. persistence: the run/step tables, their FK, unique index and CHECK
 *     constraints behave as declared;
 *  2. the state machine: only legal transitions pass, terminal states are not
 *     revived by accident, and a run cannot be completed without the evidence
 *     its status implies.
 *
 * No planning/dispatching logic exists yet, so none is tested — this phase is
 * foundational only.
 */

const createdRunIds: string[] = [];

/** Counts agent tasks attributed to a specific requester (ownership-scoped). */
async function ownedTaskCount(owner: string): Promise<number> {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, owner));
  return rows.length;
}

/** Counts schedules created by a specific user (ownership-scoped). */
async function ownedScheduleCount(owner: string): Promise<number> {
  const rows = await db.select().from(agentSchedules).where(eq(agentSchedules.createdBy, owner));
  return rows.length;
}

/** Runs `fn` and returns the `fieldErrors[0].code` of the thrown ApiError. */
function validationCode(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    const fieldErrors = (err as { fieldErrors?: Array<{ code: string }> }).fieldErrors;
    if (fieldErrors?.length) return fieldErrors[0].code;
    throw err;
  }
  throw new Error('Expected function to throw, but it did not');
}

async function insertRun(overrides: Partial<typeof agentRuns.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(agentRuns).values({
    id,
    runKey: `run-${id}`,
    title: 'Test run',
    requestedBy: randomUUID(),
    ...overrides,
  });
  createdRunIds.push(id);
  return id;
}

async function insertStep(runId: string, overrides: Partial<typeof agentRunSteps.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(agentRunSteps).values({
    id,
    runId,
    stepKey: `step-${id.slice(0, 8)}`,
    agentKey: 'marketing-agent',
    input: {},
    ...overrides,
  });
  return id;
}

afterAll(async () => {
  if (createdRunIds.length) {
    // Steps cascade with the run; delete runs explicitly to keep the assertion
    // of cascade behaviour honest rather than relying on it here.
    await db.delete(agentRunSteps).where(inArray(agentRunSteps.runId, createdRunIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds));
  }
  await closeDb();
});

describe('AI-02.1 — persistence: agent_runs and agent_run_steps', () => {
  it('creates a run with sensible defaults and tracks its requester', async () => {
    const requester = randomUUID();
    const id = await insertRun({ requestedBy: requester, title: 'Launch product X in France' });

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    expect(row.status).toBe('DRAFT');
    expect(row.requestedBy).toBe(requester);
    expect(row.runKey).toBe(`run-${id}`);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.completedAt).toBeNull();
  });

  it('enforces a unique runKey (idempotency)', async () => {
    const key = `dup-${randomUUID()}`;
    await insertRun({ runKey: key });
    await expect(insertRun({ runKey: key })).rejects.toThrow();
  });

  it('links a step to its run', async () => {
    const runId = await insertRun();
    const stepId = await insertStep(runId, { stepKey: 'market-research', agentKey: 'market-research-agent' });

    const [row] = await db.select().from(agentRunSteps).where(eq(agentRunSteps.id, stepId));
    expect(row.runId).toBe(runId);
    expect(row.stepKey).toBe('market-research');
    expect(row.agentKey).toBe('market-research-agent');
    expect(row.status).toBe('PENDING');
    expect(row.priority).toBe(0);
    expect(row.attemptCount).toBe(0);
    expect(row.maxAttempts).toBe(1);
    expect(row.dependsOn).toEqual([]);
    expect(row.requiresApproval).toBe(false);
  });

  it('refuses a step whose run does not exist (FK)', async () => {
    await expect(
      db.insert(agentRunSteps).values({
        id: randomUUID(),
        runId: randomUUID(),
        stepKey: 'orphan',
        agentKey: 'marketing-agent',
        input: {},
      }),
    ).rejects.toThrow();
  });

  it('refuses a duplicate stepKey within the same run', async () => {
    const runId = await insertRun();
    await insertStep(runId, { stepKey: 'duplicate-key' });
    await expect(insertStep(runId, { stepKey: 'duplicate-key' })).rejects.toThrow();
  });

  it('allows the same stepKey in different runs', async () => {
    const runA = await insertRun();
    const runB = await insertRun();
    await insertStep(runA, { stepKey: 'shared-key' });
    await insertStep(runB, { stepKey: 'shared-key' });

    const rows = await db.select().from(agentRunSteps).where(inArray(agentRunSteps.runId, [runA, runB]));
    expect(rows.filter((r) => r.stepKey === 'shared-key').length).toBe(2);
  });

  it('refuses invalid numeric values (negative priority, bad attempts)', async () => {
    const runId = await insertRun();
    await expect(insertStep(runId, { priority: -1 })).rejects.toThrow();
    await expect(insertStep(runId, { attemptCount: 2, maxAttempts: 1 })).rejects.toThrow();
    await expect(insertStep(runId, { maxAttempts: 0 })).rejects.toThrow();
  });

  it('refuses a non-array dependsOn payload (CHECK)', async () => {
    const runId = await insertRun();
    await expect(
      db.insert(agentRunSteps).values({
        id: randomUUID(),
        runId,
        stepKey: 'bad-deps',
        agentKey: 'marketing-agent',
        input: {},
        dependsOn: { not: 'an array' } as never,
      }),
    ).rejects.toThrow();
  });

  it('cascades step deletion when its run is deleted', async () => {
    const runId = await insertRun();
    await insertStep(runId, { stepKey: 'will-cascade' });

    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
    const remaining = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
    expect(remaining.length).toBe(0);
  });

  it('does not touch AI-01 tables (agent_tasks / agent_schedules)', async () => {
    // AI-02.1 is additive: creating runs and steps must not read or write the
    // scheduling/task tables introduced by AI-01.
    //
    // Ownership-scoped: the run's requester is a value unique to this test, so we
    // count only rows that would be attributed to it, and tasks linked to this
    // run via the existing `input.__runId` correlation. Other spec files writing
    // tasks/schedules concurrently cannot perturb the comparison.
    const owner = randomUUID();
    const beforeTasks = await ownedTaskCount(owner);
    const beforeSchedules = await ownedScheduleCount(owner);

    const runId = await insertRun({ requestedBy: owner });
    await insertStep(runId, { stepKey: 'independent-step' });

    const afterTasks = await ownedTaskCount(owner);
    const afterSchedules = await ownedScheduleCount(owner);
    expect(afterTasks).toBe(beforeTasks);
    expect(afterSchedules).toBe(beforeSchedules);

    const linkedTasks = await db
      .select()
      .from(agentTasks)
      .where(sql`${agentTasks.input}->>'__runId' = ${runId}`);
    expect(linkedTasks.length).toBe(0);
  });
});

describe('AI-02.1 — state machine: run transitions', () => {
  it('exposes every declared run and step state', () => {
    expect(RUN_STATES.length).toBe(11);
    expect(RUN_STEP_STATES.length).toBe(10);
    // Every state has a transitions entry (no silent "allow all").
    for (const s of RUN_STATES) expect(RUN_TRANSITIONS[s]).toBeDefined();
    for (const s of RUN_STEP_STATES) expect(STEP_TRANSITIONS[s]).toBeDefined();
  });

  it('allows the happy-path run transitions', () => {
    const path: AgentRunStatus[] = [
      'DRAFT',
      'PLANNING',
      'DISPATCHING',
      'RUNNING',
      'AGGREGATING',
      'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionRun(path[i], path[i + 1])).toBe(true);
      expect(() => assertRunTransition(path[i], path[i + 1])).not.toThrow();
    }
  });

  it('allows the approval and pause detours', () => {
    expect(canTransitionRun('PLANNING', 'AWAITING_APPROVAL')).toBe(true);
    expect(canTransitionRun('AWAITING_APPROVAL', 'DISPATCHING')).toBe(true);
    expect(canTransitionRun('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransitionRun('PAUSED', 'RUNNING')).toBe(true);
  });

  it('refuses illegal run transitions', () => {
    expect(canTransitionRun('DRAFT', 'COMPLETED')).toBe(false);
    expect(canTransitionRun('DRAFT', 'RUNNING')).toBe(false);
    expect(canTransitionRun('PLANNING', 'COMPLETED')).toBe(false);
    expect(canTransitionRun('RUNNING', 'COMPLETED')).toBe(false);
    expect(() => assertRunTransition('DRAFT', 'COMPLETED')).toThrow(/Illegal run transition/);
    expect(() => assertRunTransition('RUNNING', 'DRAFT')).toThrow();
  });

  it('refuses a no-op transition to the same state', () => {
    expect(() => assertRunTransition('RUNNING', 'RUNNING')).toThrow(/already in status/);
  });

  it('refuses to reopen a terminal run without an explicit policy', () => {
    for (const terminal of TERMINAL_RUN_STATES) {
      expect(isTerminalRunStatus(terminal)).toBe(true);
      expect(RUN_TRANSITIONS[terminal]).toEqual([]);
      expect(() => assertRunTransition(terminal, 'RUNNING')).toThrow(/terminal/);
      // With an explicit policy flag it is still refused if the move is illegal,
      // but the terminal guard itself can be waived deliberately.
      expect(() => assertRunTransition(terminal, 'RUNNING', { allowReopen: true })).toThrow(/Illegal run transition/);
    }
  });
});

describe('AI-02.1 — state machine: step transitions', () => {
  it('allows the happy-path step transitions', () => {
    const path: AgentRunStepStatus[] = ['PENDING', 'READY', 'RUNNING', 'SUCCEEDED'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionStep(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows blocked, approval, retry and skip detours', () => {
    expect(canTransitionStep('PENDING', 'BLOCKED')).toBe(true);
    expect(canTransitionStep('BLOCKED', 'READY')).toBe(true);
    expect(canTransitionStep('READY', 'AWAITING_APPROVAL')).toBe(true);
    expect(canTransitionStep('AWAITING_APPROVAL', 'RUNNING')).toBe(true);
    expect(canTransitionStep('RUNNING', 'FAILED')).toBe(true);
    expect(canTransitionStep('FAILED', 'RETRYING')).toBe(true);
    expect(canTransitionStep('RETRYING', 'RUNNING')).toBe(true);
    expect(canTransitionStep('PENDING', 'SKIPPED')).toBe(true);
  });

  it('refuses illegal step transitions', () => {
    expect(canTransitionStep('PENDING', 'RUNNING')).toBe(false);
    expect(canTransitionStep('PENDING', 'SUCCEEDED')).toBe(false);
    expect(canTransitionStep('BLOCKED', 'RUNNING')).toBe(false);
    expect(canTransitionStep('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(() => assertStepTransition('PENDING', 'SUCCEEDED')).toThrow(/Illegal step transition/);
  });

  it('refuses to reopen a terminal step', () => {
    for (const terminal of TERMINAL_STEP_STATES) {
      expect(isTerminalStepStatus(terminal)).toBe(true);
      expect(STEP_TRANSITIONS[terminal]).toEqual([]);
      expect(() => assertStepTransition(terminal, 'RUNNING')).toThrow(/terminal/);
    }
    // FAILED is not terminal: it may still retry or be cancelled.
    expect(isTerminalStepStatus('FAILED')).toBe(false);
    expect(canTransitionStep('FAILED', 'RETRYING')).toBe(true);
  });

  it('refuses to mark a step SUCCEEDED without a result', () => {
    expect(() => assertStepSuccess({ status: 'SUCCEEDED', result: null })).toThrow(/without a result/);
    expect(() => assertStepSuccess({ status: 'RUNNING', result: { ok: true } })).toThrow(/not in SUCCEEDED/);
    expect(() => assertStepSuccess({ status: 'SUCCEEDED', result: { ok: true } })).not.toThrow();
  });
});

describe('AI-02.1 — state machine: run completion and dependencies', () => {
  it('refuses completion while any step is unfinished', () => {
    expect(() =>
      assertRunCompletion('COMPLETED', [
        { stepKey: 'a', status: 'SUCCEEDED' },
        { stepKey: 'b', status: 'RUNNING' },
      ]),
    ).toThrow(/unfinished/);
  });

  it('refuses COMPLETED when no step succeeded', () => {
    expect(() =>
      assertRunCompletion('COMPLETED', [
        { stepKey: 'a', status: 'SKIPPED' },
        { stepKey: 'b', status: 'SKIPPED' },
      ]),
    ).toThrow(/no step succeeded/);
  });

  it('refuses COMPLETED when only some steps succeeded (must be PARTIALLY_COMPLETED)', () => {
    expect(() =>
      assertRunCompletion('COMPLETED', [
        { stepKey: 'a', status: 'SUCCEEDED' },
        { stepKey: 'b', status: 'SKIPPED' },
      ]),
    ).toThrow(/PARTIALLY_COMPLETED/);
    // The honest status for that set is PARTIALLY_COMPLETED.
    expect(resolveCompletionStatus([
      { stepKey: 'a', status: 'SUCCEEDED' },
      { stepKey: 'b', status: 'SKIPPED' },
    ])).toBe('PARTIALLY_COMPLETED');
  });

  it('allows COMPLETED only when every step succeeded', () => {
    const steps = [
      { stepKey: 'a', status: 'SUCCEEDED' as const },
      { stepKey: 'b', status: 'SUCCEEDED' as const },
    ];
    expect(() => assertRunCompletion('COMPLETED', steps)).not.toThrow();
    expect(resolveCompletionStatus(steps)).toBe('COMPLETED');
  });

  it('refuses completion with no steps at all', () => {
    expect(() => assertRunCompletion('COMPLETED', [])).toThrow(/without any steps/);
  });

  it('accepts a valid dependency graph', () => {
    expect(() =>
      assertValidDependencies([
        { stepKey: 'a', dependsOn: [] },
        { stepKey: 'b', dependsOn: ['a'] },
        { stepKey: 'c', dependsOn: ['a', 'b'] },
      ]),
    ).not.toThrow();
  });

  it('refuses a dependency on an unknown step', () => {
    expect(() => assertValidDependencies([{ stepKey: 'a', dependsOn: ['ghost'] }])).toThrow(/Validation failed/);
    expect(validationCode(() => assertValidDependencies([{ stepKey: 'a', dependsOn: ['ghost'] }]))).toBe(
      'UNKNOWN_DEPENDENCY',
    );
  });

  it('refuses a self-dependency', () => {
    expect(validationCode(() => assertValidDependencies([{ stepKey: 'a', dependsOn: ['a'] }]))).toBe(
      'SELF_DEPENDENCY',
    );
  });

  it('refuses a dependency cycle', () => {
    expect(
      validationCode(() =>
        assertValidDependencies([
          { stepKey: 'a', dependsOn: ['b'] },
          { stepKey: 'b', dependsOn: ['a'] },
        ]),
      ),
    ).toBe('CYCLE');
    expect(
      validationCode(() =>
        assertValidDependencies([
          { stepKey: 'a', dependsOn: ['c'] },
          { stepKey: 'b', dependsOn: ['a'] },
          { stepKey: 'c', dependsOn: ['b'] },
        ]),
      ),
    ).toBe('CYCLE');
  });

  it('refuses duplicate step keys in a graph', () => {
    expect(
      validationCode(() =>
        assertValidDependencies([
          { stepKey: 'a', dependsOn: [] },
          { stepKey: 'a', dependsOn: [] },
        ]),
      ),
    ).toBe('DUPLICATE');
  });
});
