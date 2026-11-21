import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRuns, agentRunSteps } from '../../db/schema/agent_runs';
import { agentTasks } from '../../db/schema/agents';
import { userRoles, roles } from '../../db/schema/auth';
import { auditLogs } from '../../db/schema/audit';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { env } from '../../lib/env';
import { isBudgetExhausted } from '../../lib/ai/cost-control';
import { isAiExecutionBlocked } from '../../lib/ai/kill-switch';
import {
  DEFAULT_SUPERVISOR_LIMITS,
  recommendIntervention,
  type SupervisorLimits,
  type TaskFacts,
} from './supervisor-policy.js';
import { decideRetry } from './retry-policy.js';
import {
  assertRunTransition,
  assertStepTransition,
  isTerminalRunStatus,
  isTerminalStepStatus,
  type AgentRunStatus,
  type AgentRunStepStatus,
} from './run-state-machine.js';
import { dispatchStep } from './dispatcher.js';

/**
 * AI-02.S1 — Agent Supervisor (orchestration control plane) + Retry Policy.
 *
 * The Supervisor is a coordination component, not a new executor and not a
 * parallel task path. It READS the existing run/step/task rows, asks the pure
 * `supervisor-policy` what (if anything) to do, and applies only the
 * interventions that policy allows — always through the existing state machine
 * and dispatcher.
 *
 * It can:
 *  - classify runs (active / stuck / stale / looping / over-budget / contained);
 *  - contain a run whose task is stuck, stale, looping, or over budget: the run
 *    walks to FAILED through legal transitions and its non-terminal steps are
 *    CANCELLED. It never closes a run as COMPLETED;
 *  - retry an eligible FAILED step through the AI-02.1 state machine
 *    (FAILED → RETRYING → dispatch) while the run is still open.
 *
 * It never:
 *  - approves a step (that stays a human, separate-approver action);
 *  - creates a parallel task path (a retry goes through `dispatchStep`, which
 *    uses the existing agent-task system and its fencing);
 *  - grants an agent a capability the run requester does not hold.
 *
 * Concurrency: cross-instance safety comes from CONDITIONAL DB WRITES (the
 * database is the arbiter, matching AI-02.3.2), never from an in-process flag
 * alone. Containment locks the run row (`SELECT … FOR UPDATE`) and updates it
 * conditionally; a retry transitions the step with `WHERE status = 'FAILED'`
 * (single winner) and `dispatchStep`'s atomic claim then owns the execution.
 * `createSupervisorCycleGuard` only prevents self-overlap inside one process.
 */

/** Run statuses the Supervisor actively looks after. */
export const LIVE_RUN_STATES: AgentRunStatus[] = ['PLANNING', 'AWAITING_APPROVAL', 'DISPATCHING', 'RUNNING', 'PAUSED'];

/** How many runs one cycle will examine. Bounds a single tick. */
export const DEFAULT_CYCLE_LIMIT = 50;

export interface SupervisorDeps {
  limits?: SupervisorLimits;
  now?: () => Date;
  /** Per-cycle cap on runs examined. */
  limit?: number;
  /** Restrict the cycle to these run ids (used by tests for isolation). */
  runIds?: string[];
  /** Injectable dispatch for tests; defaults to the real dispatcher. */
  dispatch?: typeof dispatchStep;
}

interface StepRow {
  id: string;
  runId: string;
  stepKey: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  dependsOn: string[];
  requiresApproval: boolean;
}

async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

function hasPermission(roleList: UserRole[], permission: string): boolean {
  return roleList.some((r) => ROLE_PERMISSIONS[r]?.has(permission as never));
}

/** Sum of the run's tasks' measured cost (USD) as a number for the policy. */
async function runCostUsd(db: DB, runId: string): Promise<number> {
  const rows = await db
    .select({ cost: sql<string>`coalesce(sum(cast(${agentTasks.cost} as numeric)), 0)` })
    .from(agentTasks)
    .where(sql`${agentTasks.input}->>'__runId' = ${runId}`);
  return Number(rows[0]?.cost ?? 0);
}

/** True when every dependency of `step` has reached SUCCEEDED (SKIPPED is not). */
function depsSucceeded(step: StepRow, steps: StepRow[]): boolean {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  return (step.dependsOn ?? []).every((k) => byKey.get(k)?.status === 'SUCCEEDED');
}

/**
 * Builds the `TaskFacts` the pure policy consumes from a run's real rows. A run
 * is assessed as a unit: attempts are the max across its steps, cost is the
 * summed task cost, and the "start" is the run's own `started_at`.
 */
function buildRunFacts(
  run: { status: string; startedAt: Date | null; createdAt: Date },
  steps: StepRow[],
  cost: number,
  limits: SupervisorLimits,
): TaskFacts {
  const attempts = steps.reduce((m, s) => Math.max(m, s.attemptCount), 0);
  // The loop ceiling is the POLICY maximum, not the per-step value: the planner
  // sets `maxAttempts = 1`, and the retry policy is exactly what raises it. Using
  // the per-step value would flag every first failure as a loop and contain the
  // run before any retry could happen.
  const status = steps.some((s) => s.status === 'RUNNING')
    ? 'running'
    : steps.some((s) => ['PENDING', 'READY', 'BLOCKED', 'RETRYING'].includes(s.status))
      ? 'queued'
      : 'idle';
  return {
    status,
    attempts,
    maxAttempts: limits.maxAttempts,
    cost,
    startedAtMs: run.startedAt ? run.startedAt.getTime() : null,
    createdAtMs: run.createdAt.getTime(),
  };
}

async function loadSteps(db: DB, runId: string): Promise<StepRow[]> {
  const rows = await db
    .select({
      id: agentRunSteps.id,
      runId: agentRunSteps.runId,
      stepKey: agentRunSteps.stepKey,
      status: agentRunSteps.status,
      attemptCount: agentRunSteps.attemptCount,
      maxAttempts: agentRunSteps.maxAttempts,
      dependsOn: agentRunSteps.dependsOn,
      requiresApproval: agentRunSteps.requiresApproval,
    })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId));
  return rows.map((r) => ({ ...r, dependsOn: (r.dependsOn ?? []) as string[] })) as StepRow[];
}

/**
 * Contains one run: cancels its non-terminal steps and walks the run to FAILED
 * through legal transitions. Runs in a transaction that locks the run row, so
 * two instances cannot both contain it, and it re-checks the status inside the
 * lock. Returns true only when THIS call performed the containment.
 */
export async function containRun(
  db: DB,
  runId: string,
  reason: string,
  action: string,
  audit: AuditContext,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1).for('update');
    const run = locked[0];
    if (!run) return false;
    const current = run.status as AgentRunStatus;
    if (isTerminalRunStatus(current)) return false;

    // Cancel every step that is not already terminal. A RUNNING step may be
    // cancelled (RUNNING → CANCELLED is legal); that is the honest outcome.
    const steps = await tx.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
    let cancelled = 0;
    for (const step of steps) {
      const s = step.status as AgentRunStepStatus;
      if (isTerminalStepStatus(s)) continue;
      await tx
        .update(agentRunSteps)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(and(eq(agentRunSteps.id, step.id), eq(agentRunSteps.status, s)));
      cancelled += 1;
    }

    // Walk the run to FAILED through legal transitions (never jump). DRAFT can
    // only reach FAILED via PLANNING; every other live state reaches FAILED
    // directly.
    let cursor = current;
    if (cursor === 'DRAFT') {
      cursor = 'PLANNING';
    }
    assertRunTransition(cursor, 'FAILED');
    await tx
      .update(agentRuns)
      .set({ status: 'FAILED', error: { contained: true, reason, action } as never, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, current)));

    await writeAudit(tx as unknown as DB, audit, {
      action: 'AI.AGENT_RUN_CONTAINED',
      entityType: 'AGENT_RUN',
      entityId: runId,
      before: { status: current },
      after: { status: 'FAILED' },
      metadata: { reason, action, cancelledSteps: cancelled },
    });
    return true;
  });
}

export interface RetryOutcome {
  stepId: string;
  stepKey: string;
  retried: boolean;
  code: string;
  reason: string;
  dispatched: boolean;
  runStatus?: AgentRunStatus;
}

/**
 * Attempts to retry one FAILED step of a run.
 *
 * The step is transitioned FAILED → RETRYING with a conditional UPDATE (single
 * winner), the failed task is unlinked from the step (its `__stepId` is removed
 * so the dispatcher may create a fresh task while the old row, cost and audit
 * trail are preserved), then `dispatchStep` runs it through the existing
 * pipeline. If the dispatch cannot start, the step is returned to FAILED and the
 * attempt is consumed, so the ceiling — not an unbounded loop — is what stops
 * repeated tries.
 */
export async function retryStep(
  db: DB,
  runId: string,
  step: StepRow,
  steps: StepRow[],
  audit: AuditContext,
  deps: SupervisorDeps = {},
): Promise<RetryOutcome> {
  // Central AI Kill Switch (A1): a retry is a new execution, so a global disable
  // refuses it here — BEFORE the step is moved to RETRYING or its attempt is
  // consumed — and reports it as a non-retry, without dispatching. The step is
  // left exactly as it was, so re-enabling can retry it normally (no lost work,
  // no double execution).
  if (isAiExecutionBlocked()) {
    return {
      stepId: step.id,
      stepKey: step.stepKey,
      retried: false,
      code: 'KILL_SWITCH',
      reason: 'ai-execution-disabled',
      dispatched: false,
    };
  }
  const limits = deps.limits ?? DEFAULT_SUPERVISOR_LIMITS;
  const dispatch = deps.dispatch ?? dispatchStep;

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) throw ApiError.notFound('Agent run');

  const rolesList = await rolesOf(db, run.requestedBy);
  const budget = await isBudgetExhausted(db, run.requestedBy, rolesList, 'MONTHLY', env.AI_BUDGET_MONTHLY_USD);

  const decision = decideRetry(
    {
      stepStatus: step.status,
      attemptCount: step.attemptCount,
      maxAttempts: step.maxAttempts,
      runStatus: run.status,
      runCancelled: run.status === 'CANCELLED',
      budgetExhausted: budget.exhausted,
      depsSucceeded: depsSucceeded(step, steps),
    },
    limits,
  );

  if (!decision.retry) {
    return { stepId: step.id, stepKey: step.stepKey, retried: false, code: decision.code, reason: decision.reason, dispatched: false };
  }

  assertStepTransition(step.status as AgentRunStepStatus, 'RETRYING');

  // Single-winner transition. Only a caller that observes FAILED wins.
  const scheduled = await db
    .update(agentRunSteps)
    .set({ status: 'RETRYING', maxAttempts: decision.nextMaxAttempts, updatedAt: new Date() })
    .where(and(eq(agentRunSteps.id, step.id), eq(agentRunSteps.status, 'FAILED')))
    .returning({ id: agentRunSteps.id });
  if (scheduled.length === 0) {
    return { stepId: step.id, stepKey: step.stepKey, retried: false, code: 'LOST_RACE', reason: 'step was already settled', dispatched: false };
  }

  // Unlink the failed task so the dispatcher's duplicate guard allows a fresh
  // task. The old row (cost, audit trail) is preserved; only the step link is
  // removed.
  await db
    .update(agentTasks)
    .set({ input: sql`${agentTasks.input} - '__stepId'` as never })
    .where(sql`${agentTasks.input}->>'__stepId' = ${step.id}`);

  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_STEP_RETRY_SCHEDULED',
    entityType: 'AGENT_RUN_STEP',
    entityId: step.id,
    metadata: { runId, stepKey: step.stepKey, attempt: decision.nextAttempt, maxAttempts: decision.nextMaxAttempts, reason: decision.reason },
  });

  try {
    const result = await dispatch(db, runId, step.stepKey, audit);
    return { stepId: step.id, stepKey: step.stepKey, retried: true, code: 'RETRIED', reason: decision.reason, dispatched: true, runStatus: result.runStatus };
  } catch (err) {
    // The retry could not start. Return the step to FAILED and consume the
    // attempt so the ceiling bounds any future try. Never leave it RETRYING.
    const message = err instanceof Error ? err.message : 'Unknown error';
    await db
      .update(agentRunSteps)
      .set({ status: 'FAILED', attemptCount: decision.nextAttempt, updatedAt: new Date() })
      .where(and(eq(agentRunSteps.id, step.id), eq(agentRunSteps.status, 'RETRYING')));
    await writeAudit(db, audit, {
      action: 'AI.AGENT_RUN_STEP_RETRY_FAILED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId, stepKey: step.stepKey, attempt: decision.nextAttempt, error: message },
    });
    return { stepId: step.id, stepKey: step.stepKey, retried: true, code: 'RETRY_FAILED', reason: message, dispatched: false };
  }
}

export interface RunDecision {
  runId: string;
  status: string;
  action: string;
  reason: string;
  contained: boolean;
  retries: RetryOutcome[];
}

export interface CycleResult {
  scanned: number;
  contained: number;
  retried: number;
  decisions: RunDecision[];
  errors: number;
  status: 'SUCCESS' | 'PARTIAL';
}

/**
 * Runs ONE bounded Supervisor cycle: examines up to `limit` live runs, applies
 * policy-approved containment and retries, and returns a summary. Per-run
 * failures are isolated and counted; one bad run never aborts the cycle. Safe to
 * call repeatedly — all writes are conditional, so a repeated cycle cannot
 * double-contain a run or double-retry a step.
 */
export async function runSupervisorCycle(db: DB, audit: AuditContext, deps: SupervisorDeps = {}): Promise<CycleResult> {
  // Central AI Kill Switch (A1): the supervisor must not launch new operations or
  // retries during a stop. It short-circuits to a clean no-op and records ONE
  // refusal audit entry — no run is scanned, contained or retried. It does not
  // throw, so the scheduler loop stays healthy and simply idles.
  if (isAiExecutionBlocked()) {
    await writeAudit(db, audit, {
      action: 'AI.KILL_SWITCH_SUPERVISOR_REFUSED',
      entityType: 'AI_KILL_SWITCH',
      entityId: null,
      metadata: { reason: 'ai-execution-disabled', sweep: 'runSupervisorCycle' },
    });
    return { scanned: 0, contained: 0, retried: 0, decisions: [], errors: 0, status: 'SUCCESS' };
  }
  const limits = deps.limits ?? DEFAULT_SUPERVISOR_LIMITS;
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? DEFAULT_CYCLE_LIMIT;

  const result: CycleResult = { scanned: 0, contained: 0, retried: 0, decisions: [], errors: 0, status: 'SUCCESS' };

  const runs = await db
    .select({ id: agentRuns.id, status: agentRuns.status, requestedBy: agentRuns.requestedBy, startedAt: agentRuns.startedAt, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(
      deps.runIds && deps.runIds.length > 0
        ? and(inArray(agentRuns.status, LIVE_RUN_STATES), inArray(agentRuns.id, deps.runIds))
        : inArray(agentRuns.status, LIVE_RUN_STATES),
    )
    .orderBy(agentRuns.createdAt)
    .limit(limit);

  for (const run of runs) {
    result.scanned += 1;
    try {
      const steps = await loadSteps(db, run.id);
      const cost = await runCostUsd(db, run.id);
      const facts = buildRunFacts(run, steps, cost, limits);
      const assessment = recommendIntervention(facts, limits, now().getTime());

      if (assessment.contain) {
        const contained = await containRun(db, run.id, assessment.reason, assessment.action, audit);
        if (contained) result.contained += 1;
        result.decisions.push({ runId: run.id, status: run.status, action: assessment.action, reason: assessment.reason, contained, retries: [] });
        continue;
      }

      // Not contained: retry any eligible FAILED step (still-open run).
      const failed = steps.filter((s) => s.status === 'FAILED');
      const retries: RetryOutcome[] = [];
      for (const step of failed) {
        const outcome = await retryStep(db, run.id, step, steps, audit, deps);
        retries.push(outcome);
        if (outcome.dispatched) result.retried += 1;
      }
      if (retries.length > 0) {
        result.decisions.push({ runId: run.id, status: run.status, action: 'retry', reason: 'failed-step-retry', contained: false, retries });
      }
    } catch (err) {
      result.errors += 1;
      result.status = 'PARTIAL';
      await writeAudit(db, audit, {
        action: 'AI.AGENT_RUN_SUPERVISOR_FAILED',
        entityType: 'AGENT_RUN',
        entityId: run.id,
        metadata: { error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }

  return result;
}

/**
 * In-process single-flight guard for the cycle. It only prevents SELF-overlap
 * inside one process; cross-instance safety is the conditional DB writes above.
 * Released in `finally` so a thrown cycle never wedges it. Exported so the
 * in-flight semantics can be unit-tested deterministically.
 */
export function createSupervisorCycleGuard(): <T>(job: () => Promise<T>) => Promise<T | undefined> {
  let inFlight = false;
  return async <T>(job: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await job();
    } finally {
      inFlight = false;
    }
  };
}

export interface SupervisorOverview {
  activeRuns: number;
  stuckRuns: number;
  failedSteps: number;
  awaitingRetrySteps: number;
  containedRuns: number;
  budgetExceededRuns: number;
  limits: SupervisorLimits;
  lastCycleAt: string | null;
  recentInterventions: Array<{ action: string; entityType: string; entityId: string | null; createdAt: string; metadata: unknown }>;
}

/**
 * Read-only overview for operators: the counts the Supervisor acts on, the
 * limits in force, the last cycle time (derived from the audit trail) and the
 * most recent Supervisor interventions with their reasons.
 */
export async function buildSupervisorOverview(db: DB, deps: SupervisorDeps = {}): Promise<SupervisorOverview> {
  const limits = deps.limits ?? DEFAULT_SUPERVISOR_LIMITS;
  const now = deps.now ?? (() => new Date());

  const liveRuns = await db
    .select({ id: agentRuns.id, status: agentRuns.status, requestedBy: agentRuns.requestedBy, startedAt: agentRuns.startedAt, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(inArray(agentRuns.status, LIVE_RUN_STATES));

  let stuckRuns = 0;
  let budgetExceededRuns = 0;
  for (const run of liveRuns) {
    const steps = await loadSteps(db, run.id);
    const cost = await runCostUsd(db, run.id);
    const assessment = recommendIntervention(buildRunFacts(run, steps, cost, limits), limits, now().getTime());
    if (assessment.contain && assessment.action === 'block-budget') budgetExceededRuns += 1;
    if (assessment.contain && (assessment.action === 'fail-stuck-task' || assessment.action === 'fail-stale-task' || assessment.action === 'halt-loop')) stuckRuns += 1;
  }

  const failedStepRows = await db
    .select({ id: agentRunSteps.id })
    .from(agentRunSteps)
    .where(inArray(agentRunSteps.status, ['FAILED']));
  const awaitingRetryRows = await db
    .select({ id: agentRunSteps.id })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.status, 'RETRYING'));
  const containedRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'FAILED'), sql`${agentRuns.error}->>'contained' = 'true'`));

  const interventions = await db
    .select({
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(
      inArray(auditLogs.action, [
        'AI.AGENT_RUN_CONTAINED',
        'AI.AGENT_RUN_STEP_RETRY_SCHEDULED',
        'AI.AGENT_RUN_STEP_RETRY_FAILED',
        'AI.AGENT_RUN_SUPERVISOR_FAILED',
      ]),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(20);

  const lastCycle = interventions[0]?.createdAt ?? null;

  return {
    activeRuns: liveRuns.length,
    stuckRuns,
    failedSteps: failedStepRows.length,
    awaitingRetrySteps: awaitingRetryRows.length,
    containedRuns: containedRows.length,
    budgetExceededRuns,
    limits,
    lastCycleAt: lastCycle ? new Date(lastCycle).toISOString() : null,
    recentInterventions: interventions.map((i) => ({
      action: i.action,
      entityType: i.entityType,
      entityId: i.entityId,
      createdAt: new Date(i.createdAt).toISOString(),
      metadata: i.metadata,
    })),
  };
}

/**
 * Manual containment by an operator. Guarded by the existing admin router's
 * RBAC; this function only enforces the state-machine and idempotency rules.
 */
export async function containRunManually(db: DB, runId: string, reason: string, audit: AuditContext): Promise<{ runId: string; contained: boolean }> {
  const contained = await containRun(db, runId, reason, 'manual-contain', audit);
  if (!contained) throw ApiError.conflict('Run is already finished or was contained by another actor');
  return { runId, contained };
}
