import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRuns, agentRunSteps } from '../../db/schema/agent_runs';
import { agentTasks, agentRegistry } from '../../db/schema/agents';
import { userRoles, roles } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { isBudgetExhausted } from '../../lib/ai/cost-control';
import { isAiExecutionBlocked, assertAiExecutionEnabled } from '../../lib/ai/kill-switch';
import { env } from '../../lib/env';
import { createAgentTask, decideAgentTask } from './agents.js';
import {
  assertRunTransition,
  assertRunCompletion,
  isTerminalStepStatus,
  type AgentRunStatus,
  type AgentRunStepStatus,
  type StepOutcome,
} from './run-state-machine.js';

/**
 * AI-02.3 — Dispatch & Controlled Execution.
 *
 * Sends a planned step to the EXISTING agent-task system (`createAgentTask` /
 * `decideAgentTask`) and records the outcome back onto the run. It never calls an
 * executor directly and never creates a parallel task path.
 *
 * Hard boundaries (this phase does not widen them):
 * - No new columns or tables: the link between a step and its task is carried in
 *   the task's `input` jsonb (`__runId` / `__stepId`), matching the existing
 *   `__userId` convention, so NO migration is required.
 * - The agent's own registered capabilities are the authority. A plan can never
 *   grant a capability its requester does not hold.
 * - A sensitive step (requiresApproval) is never dispatched until a valid human
 *   approval from a DIFFERENT authorised approver is recorded (AI-02.P0 holds).
 * - No real financial/external action: sensitive executors stay gated behind the
 *   existing approval engine, exactly as before.
 */

/** Run states in which a step may still be dispatched. */
const DISPATCHABLE_RUN_STATES: AgentRunStatus[] = ['PLANNING', 'DISPATCHING', 'RUNNING', 'PAUSED'];

export interface DispatchResult {
  runId: string;
  stepKey: string;
  status: AgentRunStepStatus;
  taskId: string | null;
  runStatus: AgentRunStatus;
}

function validationError(field: string, message: string, code: string): ApiError {
  return ApiError.validation([{ field, message, code }]);
}

async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

function hasPermission(userRoleList: UserRole[], permission: string): boolean {
  return userRoleList.some((r) => ROLE_PERMISSIONS[r]?.has(permission as never));
}

async function loadRun(db: DB, runId: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Agent run');
  return rows[0];
}

async function loadSteps(db: DB, runId: string) {
  return db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
}

/**
 * Finds the single agent task linked to a step, if any. The link lives in the
 * task's `input` jsonb (`__stepId`), so no extra column or table is needed.
 */
export async function findTaskForStep(db: DB, stepId: string) {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(sql`${agentTasks.input}->>'__stepId' = ${stepId}`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fenced write of a step outcome (AI-02.3.2). The ownership predicate
 * (`status='RUNNING' AND attempt_count=claimToken`) is part of the write itself,
 * so a stale dispatch whose claim was superseded or settled by Recovery cannot
 * overwrite the newer decision. Returns true when the write applied.
 */
export async function fencedStepWrite(
  db: DB,
  stepId: string,
  claimToken: number,
  values: Partial<typeof agentRunSteps.$inferInsert>,
): Promise<boolean> {
  const written = await db
    .update(agentRunSteps)
    .set(values)
    .where(
      and(
        eq(agentRunSteps.id, stepId),
        eq(agentRunSteps.status, 'RUNNING'),
        eq(agentRunSteps.attemptCount, claimToken),
      ),
    )
    .returning({ id: agentRunSteps.id });
  return written.length > 0;
}

/**
 * Records a human approval on a step that requires one, moving it
 * AWAITING_APPROVAL (or PENDING) → READY.
 *
 * Enforces AI-02.P0: the run's requester may never approve their own plan, and
 * the approver must hold AI_MANAGE. Creating a plan is not an approval; this is
 * the explicit, separate decision that authorises a sensitive step.
 */
export async function approveRunStep(
  db: DB,
  runId: string,
  stepKey: string,
  approverId: string,
  audit: AuditContext,
): Promise<DispatchResult> {
  const run = await loadRun(db, runId);
  const steps = await loadSteps(db, runId);
  const step = steps.find((s) => s.stepKey === stepKey);
  if (!step) throw ApiError.notFound('Agent run step');

  if (approverId === run.requestedBy) {
    throw ApiError.forbidden('You cannot approve a step in your own run; another authorised approver must decide');
  }
  const approverRoles = await rolesOf(db, approverId);
  if (!hasPermission(approverRoles, 'ai:manage') && !approverRoles.includes('ADMIN') && !approverRoles.includes('SUPER_ADMIN')) {
    throw ApiError.forbidden('Approving a run step requires AI management authority');
  }
  if (!step.requiresApproval) {
    throw ApiError.conflict('This step does not require approval');
  }
  if (step.status !== 'PENDING' && step.status !== 'AWAITING_APPROVAL') {
    throw ApiError.conflict(`Step ${stepKey} is not awaiting approval (status ${step.status})`);
  }

  await db
    .update(agentRunSteps)
    .set({ status: 'READY', approvedBy: approverId, updatedAt: new Date() })
    .where(eq(agentRunSteps.id, step.id));

  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_STEP_APPROVED',
    entityType: 'AGENT_RUN_STEP',
    entityId: step.id,
    metadata: { runId, stepKey, approvedBy: approverId },
  });

  return { runId, stepKey, status: 'READY', taskId: null, runStatus: run.status as AgentRunStatus };
}

/** Advances the run into the dispatching/running band if it is still planning. */
async function ensureRunDispatching(db: DB, run: { id: string; status: string }): Promise<AgentRunStatus> {
  let status = run.status as AgentRunStatus;
  if (status === 'PLANNING' || status === 'AWAITING_APPROVAL') {
    assertRunTransition(status, 'DISPATCHING');
    status = 'DISPATCHING';
  }
  if (status === 'DISPATCHING' || status === 'PAUSED') {
    assertRunTransition(status, 'RUNNING');
    status = 'RUNNING';
  }
  await db.update(agentRuns).set({ status, startedAt: sql`coalesce(${agentRuns.startedAt}, now())`, updatedAt: new Date() }).where(eq(agentRuns.id, run.id));
  return status;
}

/**
 * Test seam for the dispatch↔recovery race (AI-02.3.2). `onClaimed` runs after
 * the atomic claim and before the agent task is created, letting a test drive a
 * recovery sweep into exactly that window. Production callers pass nothing.
 */
export interface DispatchFence {
  onClaimed?: (info: { stepId: string; claimToken: number }) => Promise<void>;
}

/**
 * Dispatches one planned step to the existing agent-task system.
 *
 * Fail-closed order of checks: run is dispatchable; the step exists and is not
 * terminal; every dependency SUCCEEDED; the agent exists and is active; the
 * requester holds the agent's permissions; a sensitive step is approved; budget
 * is available. Only then is the step atomically claimed (RUNNING) and a task
 * created. The claim is a single conditional UPDATE, so two concurrent requests
 * cannot both create a task for the same step.
 */
export async function dispatchStep(
  db: DB,
  runId: string,
  stepKey: string,
  audit: AuditContext,
  fence?: DispatchFence,
): Promise<DispatchResult> {
  // Central AI Kill Switch (A1): dispatch starts a step, so a global disable
  // refuses it BEFORE the run/step is touched — no step is marked RUNNING and no
  // task is created. Uniform across the admin route and the supervisor retry.
  assertAiExecutionEnabled();
  const run = await loadRun(db, runId);
  const steps = await loadSteps(db, runId);
  const step = steps.find((s) => s.stepKey === stepKey);
  if (!step) throw ApiError.notFound('Agent run step');

  if (!DISPATCHABLE_RUN_STATES.includes(run.status as AgentRunStatus)) {
    throw ApiError.conflict(`Run is not in a dispatchable state (status ${run.status})`);
  }
  if (isTerminalStepStatus(step.status as AgentRunStepStatus)) {
    throw ApiError.conflict(`Step ${stepKey} is already terminal (status ${step.status})`);
  }
  if (step.status === 'RUNNING') {
    throw ApiError.conflict(`Step ${stepKey} is already RUNNING`);
  }
  // Attempts are bounded by the model itself (AI-02.1). A step that has spent
  // its attempts may not be dispatched again: no random re-execution.
  if (step.attemptCount >= step.maxAttempts) {
    throw ApiError.conflict(
      `Step ${stepKey} has exhausted its attempts (${step.attemptCount}/${step.maxAttempts})`,
    );
  }

  // Dependencies must have SUCCEEDED. SKIPPED is not success.
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  for (const depKey of (step.dependsOn ?? []) as string[]) {
    const dep = byKey.get(depKey);
    if (!dep || dep.status !== 'SUCCEEDED') {
      throw ApiError.conflict(`Step ${stepKey} cannot run before its dependency ${depKey} succeeds`);
    }
  }

  // The agent must exist, be active, and be within the requester's authority.
  const registryRows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, step.agentKey)).limit(1);
  const agentRow = registryRows[0];
  if (!agentRow) throw validationError('agentKey', `Unknown agent "${step.agentKey}"`, 'UNKNOWN_AGENT');
  if (!agentRow.isActive) throw validationError('agentKey', `Agent "${step.agentKey}" is not active`, 'INACTIVE_AGENT');

  const requesterRoles = await rolesOf(db, run.requestedBy);
  const isAdmin = requesterRoles.includes('ADMIN') || requesterRoles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    const required = (agentRow.permissionsRequired ?? []) as string[];
    const missing = required.filter((p) => !hasPermission(requesterRoles, p));
    if (missing.length > 0) {
      throw ApiError.forbidden(`Step ${stepKey} needs permission(s) the requester lacks: ${missing.join(', ')}`);
    }
  }

  // A sensitive step is never dispatched before a valid, separate approval.
  if (step.requiresApproval) {
    if (step.status !== 'READY' || !step.approvedBy) {
      throw ApiError.conflict(`Step ${stepKey} requires human approval before it can be dispatched`);
    }
  }

  // Budget pre-flight: refuse before creating the task (and before any provider
  // call), mirroring the AI-01 scheduling gate.
  const budget = await isBudgetExhausted(db, run.requestedBy, requesterRoles, 'MONTHLY', env.AI_BUDGET_MONTHLY_USD);
  if (budget.exhausted) {
    throw ApiError.tooManyRequests(`AI budget exhausted (${budget.reason ?? 'budget'}); cannot dispatch a step`);
  }

  // Idempotency guard across restarts: if a task already exists for this step,
  // do not create a second one. The step link lives in the task input.
  const existingTask = await findTaskForStep(db, step.id);
  if (existingTask) {
    throw ApiError.conflict(`Step ${stepKey} already has an agent task; refusing to create a duplicate`);
  }

  // Atomic claim: only one caller can move a PENDING/READY/RETRYING step to
  // RUNNING. RETRYING is included because AI-02.S1's retry policy moves an
  // eligible FAILED step to RETRYING (FAILED → RETRYING → RUNNING is the AI-02.1
  // state machine, unchanged); the claim below is still the single winner, and
  // `attemptCount` remains the fencing token every later write must present.
  const claimed = await db
    .update(agentRunSteps)
    .set({
      status: 'RUNNING',
      attemptCount: sql`${agentRunSteps.attemptCount} + 1`,
      startedAt: sql`coalesce(${agentRunSteps.startedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRunSteps.id, step.id), inArray(agentRunSteps.status, ['PENDING', 'READY', 'RETRYING'])))
    .returning({ id: agentRunSteps.id, attemptCount: agentRunSteps.attemptCount });
  if (claimed.length === 0) {
    throw ApiError.conflict(`Step ${stepKey} was already claimed by another dispatch`);
  }
  const claimToken = claimed[0].attemptCount;

  // Test-only seam: allows a test to interleave a recovery sweep between the
  // claim and task creation. No-op in production.
  if (fence?.onClaimed) await fence.onClaimed({ stepId: step.id, claimToken });

  const runStatus = await ensureRunDispatching(db, run);

  const taskInput = {
    ...((step.input ?? {}) as Record<string, unknown>),
    __runId: runId,
    __stepId: step.id,
  };

  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_STEP_DISPATCHED',
    entityType: 'AGENT_RUN_STEP',
    entityId: step.id,
    metadata: { runId, stepKey, agentKey: step.agentKey },
  });

  let taskId: string | null = null;
  let finalStatus: AgentRunStepStatus;
  try {
    // The task is attributed to the run's requester (accountability); the agent's
    // own capabilities gate execution inside createAgentTask. Fencing ties the
    // task to this exact claim so a superseded dispatch cannot attach one.
    const task = await createAgentTask(
      db,
      requesterRoles,
      run.requestedBy,
      { agentKey: step.agentKey, requestedBy: run.requestedBy, input: taskInput },
      audit,
      { runId, stepId: step.id, claimToken },
    );
    taskId = task.id;

    let resolved = task;
    // A sensitive agent yields awaiting_approval. The step was already approved
    // by a DIFFERENT authorised approver, so bridge that approval through the
    // existing approval engine (never a bypass, and never self-approval).
    if (task.status === 'awaiting_approval') {
      resolved = await decideAgentTask(db, task.id, step.approvedBy!, 'APPROVE', null, audit);
    }

    finalStatus = resolved.status === 'succeeded' || resolved.status === 'approved' ? 'SUCCEEDED' : 'FAILED';
    const resultPayload = { taskId: task.id, taskStatus: resolved.status, result: resolved.result ?? null };
    // Fenced: only applies if this claim still owns a RUNNING step. If Recovery
    // settled it first, the write is a no-op and we surface the newer decision.
    const applied = await fencedStepWrite(db, step.id, claimToken, {
      status: finalStatus,
      result: (finalStatus === 'SUCCEEDED' ? resultPayload : null) as never,
      error: (finalStatus === 'FAILED' ? resultPayload : null) as never,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    await writeAudit(db, audit, {
      action: applied
        ? finalStatus === 'SUCCEEDED'
          ? 'AI.AGENT_RUN_STEP_SUCCEEDED'
          : 'AI.AGENT_RUN_STEP_FAILED'
        : 'AI.AGENT_RUN_STEP_WRITE_REJECTED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId, stepKey, taskId: task.id, taskStatus: resolved.status, claimToken, applied },
    });
    if (!applied) {
      // Ownership was lost (Recovery settled the step first). Do not claim a
      // success we no longer own; report the authoritative status.
      const current = await db
        .select({ status: agentRunSteps.status })
        .from(agentRunSteps)
        .where(eq(agentRunSteps.id, step.id))
        .limit(1);
      finalStatus = (current[0]?.status as AgentRunStepStatus) ?? finalStatus;
    }
  } catch (err) {
    // A dispatch failure is recorded, not hidden. No retry policy exists in this
    // phase: the step lands in FAILED and dependents are skipped. The write is
    // fenced, so it never overwrites a decision Recovery already made.
    finalStatus = 'FAILED';
    const errorPayload = { message: err instanceof Error ? err.message : 'Unknown error', taskId };
    const applied = await fencedStepWrite(db, step.id, claimToken, {
      status: 'FAILED',
      error: errorPayload as never,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    await writeAudit(db, audit, {
      action: applied ? 'AI.AGENT_RUN_STEP_FAILED' : 'AI.AGENT_RUN_STEP_WRITE_REJECTED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId, stepKey, taskId, claimToken, applied, error: errorPayload.message },
    });
    if (!applied) {
      const current = await db
        .select({ status: agentRunSteps.status })
        .from(agentRunSteps)
        .where(eq(agentRunSteps.id, step.id))
        .limit(1);
      finalStatus = (current[0]?.status as AgentRunStepStatus) ?? finalStatus;
    }
  }

  const reconciledRunStatus = await reconcileRun(db, runId, audit);
  return { runId, stepKey, status: finalStatus, taskId, runStatus: reconciledRunStatus };
}

/**
 * Reconciles the run after a step finishes:
 * - steps depending (transitively) on a FAILED/CANCELLED step are SKIPPED, so a
 *   single failure never triggers a chain of dependents;
 * - when every step is terminal the run is closed with the honest status:
 *   COMPLETED only if all succeeded, PARTIALLY_COMPLETED if some succeeded and
 *   some did not, FAILED if none succeeded.
 */
export async function reconcileRun(db: DB, runId: string, audit: AuditContext): Promise<AgentRunStatus> {
  const run = await loadRun(db, runId);
  const steps = await loadSteps(db, runId);

  const failed = new Set(steps.filter((s) => s.status === 'FAILED' || s.status === 'CANCELLED').map((s) => s.stepKey));
  const skippedKeys = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of steps) {
      if (skippedKeys.has(s.stepKey) || failed.has(s.stepKey)) continue;
      if (isTerminalStepStatus(s.status as AgentRunStepStatus)) continue;
      const deps = (s.dependsOn ?? []) as string[];
      if (deps.some((d) => failed.has(d) || skippedKeys.has(d))) {
        skippedKeys.add(s.stepKey);
        changed = true;
      }
    }
  }
  for (const key of skippedKeys) {
    const step = steps.find((s) => s.stepKey === key)!;
    if (isTerminalStepStatus(step.status as AgentRunStepStatus)) continue;
    await db.update(agentRunSteps).set({ status: 'SKIPPED', updatedAt: new Date() }).where(eq(agentRunSteps.id, step.id));
    step.status = 'SKIPPED';
    await writeAudit(db, audit, {
      action: 'AI.AGENT_RUN_STEP_SKIPPED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId, stepKey: key, reason: 'dependency_failed' },
    });
  }

  const outcomes: StepOutcome[] = steps.map((s) => ({ stepKey: s.stepKey, status: s.status as AgentRunStepStatus }));
  // A step is "settled" for run-closing when it is terminal OR FAILED. AI-02.1
  // keeps FAILED out of the terminal set because a retry is possible, but this
  // phase has no retry policy, so a FAILED step is final here. We do not weaken
  // the AI-02.1 guard: the COMPLETED path still calls assertRunCompletion.
  const isSettled = (s: AgentRunStepStatus): boolean => isTerminalStepStatus(s) || s === 'FAILED';
  const allSettled = outcomes.every((o) => isSettled(o.status));

  let current = run.status as AgentRunStatus;
  if (allSettled && current !== 'CANCELLED' && !['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'].includes(current)) {
    const succeeded = outcomes.filter((o) => o.status === 'SUCCEEDED').length;
    // Walk the run into the aggregation band through legal states. Recovery may
    // settle a step while the run is still PLANNING (a crash between the atomic
    // claim and the run advancing), so we advance rather than jump straight to a
    // completion state, which would be an illegal transition.
    if (current === 'DRAFT') {
      assertRunTransition(current, 'PLANNING');
      current = 'PLANNING';
    }
    if (current === 'PLANNING' || current === 'AWAITING_APPROVAL') {
      assertRunTransition(current, 'DISPATCHING');
      current = 'DISPATCHING';
    }
    if (current === 'DISPATCHING' || current === 'PAUSED') {
      assertRunTransition(current, 'RUNNING');
      current = 'RUNNING';
    }
    if (current === 'RUNNING') {
      assertRunTransition(current, 'AGGREGATING');
      current = 'AGGREGATING';
    }
    let target: AgentRunStatus;
    if (succeeded === 0) {
      target = 'FAILED';
    } else if (succeeded === outcomes.length) {
      target = 'COMPLETED';
    } else {
      target = 'PARTIALLY_COMPLETED';
    }
    if (target === 'COMPLETED') {
      // The COMPLETED guard from AI-02.1 applies unchanged (every step terminal).
      assertRunCompletion(target, outcomes);
      assertRunTransition(current, target);
    } else {
      // FAILED / PARTIALLY_COMPLETED: validate the run-level transition. The
      // AI-02.1 completion guard is intentionally not used here because it treats
      // a FAILED step as unfinished (a retry could still be attempted), which
      // cannot apply in a no-retry phase.
      assertRunTransition(current, target);
    }
    await db.update(agentRuns).set({ status: target, completedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, runId));
    await writeAudit(db, audit, {
      action: target === 'FAILED' ? 'AI.AGENT_RUN_FAILED' : 'AI.AGENT_RUN_COMPLETED',
      entityType: 'AGENT_RUN',
      entityId: runId,
      metadata: { status: target, succeeded, total: outcomes.length },
    });
    return target;
  }

  return current;
}

/**
 * Cancels a run: the run moves to CANCELLED and every non-terminal step is
 * CANCELLED, so no new step can ever be dispatched from it.
 */
export async function cancelRun(db: DB, runId: string, audit: AuditContext): Promise<AgentRunStatus> {
  const run = await loadRun(db, runId);
  if (['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
    throw ApiError.conflict(`Run is already finished (status ${run.status})`);
  }
  assertRunTransition(run.status as AgentRunStatus, 'CANCELLED');
  await db.update(agentRuns).set({ status: 'CANCELLED', completedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, runId));
  const steps = await loadSteps(db, runId);
  for (const step of steps) {
    if (!isTerminalStepStatus(step.status as AgentRunStepStatus)) {
      await db.update(agentRunSteps).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(agentRunSteps.id, step.id));
    }
  }
  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_CANCELLED',
    entityType: 'AGENT_RUN',
    entityId: runId,
    metadata: { cancelledSteps: steps.filter((s) => !isTerminalStepStatus(s.status as AgentRunStepStatus)).length },
  });
  return 'CANCELLED';
}

/** Loads a run with its steps for read-only inspection (no state change). */
export async function getRunWithSteps(db: DB, runId: string) {
  const run = await loadRun(db, runId);
  const steps = await loadSteps(db, runId);
  return {
    run,
    steps: steps
      .map((s) => ({
        id: s.id,
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        status: s.status as AgentRunStepStatus,
        dependsOn: (s.dependsOn ?? []) as string[],
        requiresApproval: s.requiresApproval,
        approvedBy: s.approvedBy,
        attemptCount: s.attemptCount,
        result: s.result,
        error: s.error,
      }))
      .sort((a, b) => a.stepKey.localeCompare(b.stepKey)),
  };
}


// ---------------------------------------------------------------------------
// AI-02.3.1 — Synchronisation & Recovery
//
// The dispatcher writes a step's outcome synchronously, but a crash between the
// atomic claim and that write (or between task creation and the outcome write)
// can leave a step RUNNING with no recorded result. These functions reconcile a
// step with its linked task. They are idempotent: they only write and audit when
// a state actually changes, so re-running them never duplicates audit events.
// They never approve, never impersonate an approver, and never create a task
// without a claim — a step with no task is recorded FAILED, not silently redone.
// ---------------------------------------------------------------------------

/** Task statuses that mean the task has reached a final, decided outcome. */
function taskOutcome(status: string): 'success' | 'failure' | 'in_flight' | 'unknown' {
  switch (status) {
    case 'succeeded':
    case 'approved':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failure';
    case 'queued':
    case 'running':
    case 'awaiting_approval':
      return 'in_flight';
    default:
      return 'unknown';
  }
}

export interface SyncResult {
  /**
   * True only when THIS call changed the step row. A conditional UPDATE that
   * matched zero rows (another writer settled the step first) reports `false`
   * with `reason: 'lost_race'`, so callers never count or audit a settlement
   * that did not happen.
   */
  changed: boolean;
  status: AgentRunStepStatus;
  reason: string;
}

/**
 * Settles a RUNNING step with a conditional UPDATE and reports how many rows it
 * actually changed. `0` means a concurrent writer (a live dispatch finishing, or
 * another recovery) settled the step first — i.e. this call LOST THE RACE. The
 * caller must not treat that as a success: the row is already authoritative.
 */
async function settleRunningStep(
  db: DB,
  stepId: string,
  values: Partial<typeof agentRunSteps.$inferInsert>,
): Promise<number> {
  const settled = await db
    .update(agentRunSteps)
    .set(values)
    .where(and(eq(agentRunSteps.id, stepId), eq(agentRunSteps.status, 'RUNNING')))
    .returning({ id: agentRunSteps.id });
  return settled.length;
}

/** Reads the current persisted status of a step (used to report lost races). */
async function readStepStatus(db: DB, stepId: string): Promise<AgentRunStepStatus> {
  const rows = await db
    .select({ status: agentRunSteps.status })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.id, stepId))
    .limit(1);
  return (rows[0]?.status as AgentRunStepStatus) ?? 'RUNNING';
}

/**
 * Test-only hook for `syncStepFromTask`. `beforeSettle` runs after the step and
 * its task have been read but before the settle UPDATE, so a test can interleave
 * a concurrent writer and prove the zero-row (lost-race) path deterministically.
 * Never passed in production.
 */
export interface SyncHooks {
  beforeSettle?: (info: { stepId: string }) => Promise<void>;
}

/**
 * Reconciles ONE step with its linked task. Pure with respect to side effects on
 * the task: it only updates the step (and audits) when the outcome differs from
 * what is recorded. Safe to call repeatedly.
 */
export async function syncStepFromTask(
  db: DB,
  stepId: string,
  audit: AuditContext,
  hooks?: SyncHooks,
): Promise<SyncResult> {
  const rows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.id, stepId)).limit(1);
  const step = rows[0];
  if (!step) throw ApiError.notFound('Agent run step');
  const status = step.status as AgentRunStepStatus;

  // Already decided: nothing to reconcile (idempotent no-op).
  if (isTerminalStepStatus(status) || status === 'FAILED') {
    return { changed: false, status, reason: 'already_settled' };
  }
  // A step still legitimately in progress outside RUNNING is left alone.
  if (status !== 'RUNNING') {
    return { changed: false, status, reason: 'not_running' };
  }

  const task = await findTaskForStep(db, step.id);
  if (!task) {
    // No task was ever created for a RUNNING step (crash between claim and
    // create). We do NOT create a replacement; the step is recorded FAILED so a
    // human can decide. This is the safe, non-duplicating outcome.
    if (hooks?.beforeSettle) await hooks.beforeSettle({ stepId: step.id });
    const settled = await settleRunningStep(db, step.id, {
      status: 'FAILED',
      error: { message: 'dispatch incomplete: no task was created' } as never,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    if (settled === 0) {
      // A live dispatch (or another recovery) settled the step while we held the
      // lease. The row is already authoritative — report the loss, do not audit
      // a settlement that did not happen.
      return { changed: false, status: await readStepStatus(db, step.id), reason: 'lost_race' };
    }
    await writeAudit(db, audit, {
      action: 'AI.AGENT_RUN_STEP_RECOVERED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId: step.runId, stepKey: step.stepKey, reason: 'running_without_task', outcome: 'FAILED' },
    });
    return { changed: true, status: 'FAILED', reason: 'running_without_task' };
  }

  const outcome = taskOutcome(task.status);
  if (outcome === 'in_flight' || outcome === 'unknown') {
    // The task may still be working (or its state is unreadable). Do not touch
    // the step: never resend, never fabricate an outcome.
    return { changed: false, status, reason: outcome === 'unknown' ? 'task_state_unknown' : 'task_in_flight' };
  }

  if (outcome === 'success') {
    // A task is only "succeeded" evidence if it actually carries a result.
    if (task.result === null || task.result === undefined) {
      return { changed: false, status, reason: 'success_without_result' };
    }
    if (hooks?.beforeSettle) await hooks.beforeSettle({ stepId: step.id });
    const settled = await settleRunningStep(db, step.id, {
      status: 'SUCCEEDED',
      result: { taskId: task.id, taskStatus: task.status, result: task.result } as never,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    if (settled === 0) {
      return { changed: false, status: await readStepStatus(db, step.id), reason: 'lost_race' };
    }
    await writeAudit(db, audit, {
      action: 'AI.AGENT_RUN_STEP_SYNCED',
      entityType: 'AGENT_RUN_STEP',
      entityId: step.id,
      metadata: { runId: step.runId, stepKey: step.stepKey, taskId: task.id, outcome: 'SUCCEEDED' },
    });
    return { changed: true, status: 'SUCCEEDED', reason: 'task_succeeded' };
  }

  // Failure: record it and let the run reconciliation skip dependents.
  if (hooks?.beforeSettle) await hooks.beforeSettle({ stepId: step.id });
  const settled = await settleRunningStep(db, step.id, {
    status: 'FAILED',
    error: { taskId: task.id, taskStatus: task.status, error: task.error ?? null } as never,
    completedAt: new Date(),
    updatedAt: new Date(),
  });
  if (settled === 0) {
    return { changed: false, status: await readStepStatus(db, step.id), reason: 'lost_race' };
  }
  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_STEP_SYNCED',
    entityType: 'AGENT_RUN_STEP',
    entityId: step.id,
    metadata: { runId: step.runId, stepKey: step.stepKey, taskId: task.id, outcome: 'FAILED' },
  });
  return { changed: true, status: 'FAILED', reason: 'task_failed' };
}

export interface RecoverResult {
  scanned: number;
  recovered: number;
  reconciledRuns: number;
  /** Steps skipped because another recovery held a valid lease on them. */
  skippedLease: number;
  /**
   * Steps this sweep leased but then failed to settle because a live dispatch
   * (or another recovery) settled them first — the conditional UPDATE matched
   * zero rows. These are NOT counted as `recovered`.
   */
  lostRace: number;
  /** Steps whose reconciliation raised (isolated; the sweep continues). */
  errors: number;
  /** SUCCESS = clean sweep; PARTIAL = some errors; FAILED = sweep aborted. */
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  details: Array<{ stepId: string; stepKey: string; reason: string; outcome: string }>;
}

/**
 * Recovery sweep: finds steps stuck RUNNING beyond `stuckSeconds` and reconciles
 * each with its task. Two concurrent recoveries cannot process the same step:
 * the lease is an atomic conditional UPDATE on `updated_at` that only one caller
 * can win. A step whose task is still running is left untouched (the lease is
 * renewed so it is not reconsidered until it is stale again). A step that still
 * holds a valid (unexpired) lease is never settled, so an in-flight dispatch is
 * not mistaken for a stuck one. Per-step failures are isolated and counted.
 */
export async function recoverStuckSteps(
  db: DB,
  options: { stuckSeconds: number; leaseSeconds?: number; limit?: number },
  audit: AuditContext,
  hooks?: SyncHooks,
): Promise<RecoverResult> {
  // Central AI Kill Switch (A1): recovery must not re-drive anything during a
  // stop. It short-circuits to a clean no-op (nothing scanned, nothing settled,
  // no run reconciled) and records ONE refusal audit entry — never per-row. It
  // does not throw, so the scheduler loop stays healthy and simply idles.
  if (isAiExecutionBlocked()) {
    await writeAudit(db, audit, {
      action: 'AI.KILL_SWITCH_RECOVERY_REFUSED',
      entityType: 'AI_KILL_SWITCH',
      entityId: null,
      metadata: { reason: 'ai-execution-disabled', sweep: 'recoverStuckSteps' },
    });
    return {
      scanned: 0,
      recovered: 0,
      reconciledRuns: 0,
      skippedLease: 0,
      lostRace: 0,
      errors: 0,
      status: 'SUCCESS',
      details: [{ stepId: '-', stepKey: '-', reason: 'ai-execution-disabled', outcome: 'refused' }],
    };
  }
  const leaseSeconds = options.leaseSeconds ?? Math.max(options.stuckSeconds, 60);
  const limit = options.limit ?? 50;
  const result: RecoverResult = {
    scanned: 0,
    recovered: 0,
    reconciledRuns: 0,
    skippedLease: 0,
    lostRace: 0,
    errors: 0,
    status: 'SUCCESS',
    details: [],
  };

  const candidates = await db
    .select()
    .from(agentRunSteps)
    .where(
      sql`${agentRunSteps.status} = 'RUNNING'
          and ${agentRunSteps.startedAt} is not null
          and ${agentRunSteps.startedAt} < now() - (${options.stuckSeconds}::int * interval '1 second')
          and ${agentRunSteps.updatedAt} < now() - (${leaseSeconds}::int * interval '1 second')`,
    )
    .limit(limit);

  const runIds = new Set<string>();
  for (const step of candidates) {
    result.scanned += 1;
    // Atomic lease: only one recovery may take this step right now.
    const leased = await db
      .update(agentRunSteps)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(agentRunSteps.id, step.id),
          eq(agentRunSteps.status, 'RUNNING'),
          sql`${agentRunSteps.startedAt} < now() - (${options.stuckSeconds}::int * interval '1 second')`,
          sql`${agentRunSteps.updatedAt} < now() - (${leaseSeconds}::int * interval '1 second')`,
        ),
      )
      .returning({ id: agentRunSteps.id });
    if (leased.length === 0) {
      // Either another recovery holds the lease, or the step is no longer RUNNING
      // (a dispatch settled it). Either way, not ours to touch.
      result.skippedLease += 1;
      continue;
    }

    try {
      const synced = await syncStepFromTask(db, step.id, audit, hooks);
      if (synced.changed) {
        result.recovered += 1;
        runIds.add(step.runId);
        result.details.push({ stepId: step.id, stepKey: step.stepKey, reason: synced.reason, outcome: synced.status });
      } else if (synced.reason === 'lost_race') {
        // We leased the step but a live dispatch (or another recovery) settled it
        // first — the conditional UPDATE matched zero rows. Record it as its own
        // event, never as a recovery success, and do not touch the run here.
        result.lostRace += 1;
        result.details.push({ stepId: step.id, stepKey: step.stepKey, reason: synced.reason, outcome: synced.status });
        await writeAudit(db, audit, {
          action: 'AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE',
          entityType: 'AGENT_RUN_STEP',
          entityId: step.id,
          metadata: { runId: step.runId, stepKey: step.stepKey, reason: 'lost_race', observedStatus: synced.status },
        });
      }
    } catch (err) {
      // One bad step must not abort the whole sweep; the next tick retries it.
      result.errors += 1;
      result.status = 'PARTIAL';
      await writeAudit(db, audit, {
        action: 'AI.AGENT_RUN_STEP_RECOVERY_FAILED',
        entityType: 'AGENT_RUN_STEP',
        entityId: step.id,
        metadata: {
          runId: step.runId,
          stepKey: step.stepKey,
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  }

  for (const runId of runIds) {
    try {
      await reconcileRun(db, runId, audit);
      result.reconciledRuns += 1;
    } catch (err) {
      result.errors += 1;
      result.status = 'PARTIAL';
      await writeAudit(db, audit, {
        action: 'AI.AGENT_RUN_RECONCILE_FAILED',
        entityType: 'AGENT_RUN',
        entityId: runId,
        metadata: { error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }
  return result;
}

/**
 * Reconciles a whole run on demand: first syncs any RUNNING step against its
 * task, then re-derives the run status. Returns the run's status afterwards.
 */
export async function recoverRun(db: DB, runId: string, audit: AuditContext): Promise<AgentRunStatus> {
  // Central AI Kill Switch (A1): the manual recovery route must not re-drive a
  // run during a stop. Refuse loudly (503) so the operator sees why, without
  // touching the run — its state stays exactly as it was, nothing is lost.
  assertAiExecutionEnabled();
  const steps = await loadSteps(db, runId);
  for (const step of steps) {
    if (step.status === 'RUNNING') {
      await syncStepFromTask(db, step.id, audit);
    }
  }
  return reconcileRun(db, runId, audit);
}

