import { and, desc, eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRegistry, agentTasks } from '../../db/schema/agents';
import { agentRunSteps } from '../../db/schema/agent_runs';
import { aiRequests } from '../../db/schema/ai';
import { roles, userRoles } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { createNotification } from '../../lib/notifications-service';
import type { AgentDefinition, AgentTaskStatus, CreateAgentTaskInput, ResolvedAgentTask } from '../../lib/ai/types';
import {
  AgentRunBudget,
  AgentCostRecordingError,
  AgentRunBudgetExceededError,
  withAgentRunBudget,
  withAgentRunContext,
  AGENT_TASK_LEDGER_KEY,
  type AgentRunContext,
} from '../../lib/ai/agent-run-context.js';
import { executeAgentTask } from './executors.js';
import {
  AGENT_CATALOGUE as AGENT_LAYER,
  COPILOT_CATALOGUE,
  agentLayerCounts,
  agentRunRefusal,
  executableAgents,
  findAgentSpec,
  type AgentLayerCounts,
} from './catalogue.js';
import { assertAgentScopeContract, assertRunOwnerScope } from './agent-scope.js';
import { assertAiExecutionEnabled } from '../../lib/ai/kill-switch.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/observability/logger';

/**
 * Fencing context for a task created on behalf of a dispatched run step
 * (AI-02.3.2). `claimToken` is the step's `attempt_count` captured at the atomic
 * dispatch claim; it identifies the exact claim that owns the step. The
 * ownership check and the insert are performed in one transaction, so a stale
 * dispatch cannot attach a task to a step that Recovery already settled.
 */
export interface AgentTaskFencing {
  runId: string;
  stepId: string;
  claimToken: number;
}

/**
 * The executable slice of the agent layer (AI-REG-01).
 *
 * Derived from the single reference source (`catalogue.ts`) instead of being a
 * second hand-maintained list: an agent is runnable only if the catalogue marks
 * it `executable: true`, which in turn means `executeAgentTask` has a branch for
 * it. Read-only advisory agents run immediately; agents whose capabilities could
 * touch financial/admin actions are gated behind an explicit human approval
 * (see `requiresHumanApproval`).
 */
export const AGENT_CATALOGUE: AgentDefinition[] = executableAgents();

/**
 * Seed the whole agent layer (20 rows: 19 specialised + the supervisor)
 * idempotently.
 *
 * The insert is a single `INSERT … ON CONFLICT (key) DO NOTHING`, so concurrent
 * callers — several workers, several connections, or a burst of first-time
 * requests — cannot create duplicate rows. The earlier read-then-insert form was
 * a check-then-act race: two callers could both observe a missing key and both
 * insert it. The conflict target relies on the unique index
 * `agent_registry_key_idx` (see migration 0029); without it Postgres rejects the
 * statement with 42P10 instead of silently ignoring the conflict.
 *
 * Registration is identity, not authority: a row here does not make an agent
 * runnable. Execution is gated by `agentRunRefusal` (catalogue `executable`).
 *
 * There is deliberately no `catch` around the insert. `ON CONFLICT (key)`
 * already resolves the only conflict this loop can legitimately hit, so any
 * error that does surface is a real failure and must propagate — including a
 * `23505` raised by a *different* unique constraint (e.g. the `id` primary
 * key), which a blanket `23505` guard would have silently swallowed.
 */
export async function ensureAgentRegistrySeeded(db: DB): Promise<void> {
  for (const def of AGENT_LAYER) {
    await db
      .insert(agentRegistry)
      .values({
        id: newId(),
        key: def.key,
        name: def.name,
        nameAr: def.nameAr ?? null,
        mission: def.mission ?? null,
        category: def.category ?? 'general',
        description: def.description,
        capabilities: def.capabilities as never,
        allowedTools: (def.allowedTools ?? []) as never,
        approvalActions: (def.approvalActions ?? []) as never,
        limits: (def.limits ?? {}) as never,
        taskTypes: (def.taskTypes ?? []) as never,
        permissionsRequired: def.permissionsRequired as never,
        requiresHumanApproval: def.requiresHumanApproval,
        inputSchema: (def.inputSchema ?? null) as never,
        isActive: true,
      })
      .onConflictDoNothing({ target: agentRegistry.key });
  }
}

/**
 * The full agent layer for read surfaces (AI-REG-01).
 *
 * Code is the source of truth for identity, capability and `executable`; the
 * registry row contributes the live lifecycle (`status`, `isActive`, `id`). An
 * agent that is registered but has no executor is returned with
 * `executable: false` rather than hidden, so operators see the real layer.
 */
export async function listAgents(db: DB): Promise<AgentDefinition[]> {
  await ensureAgentRegistrySeeded(db);
  const rows = await db.select().from(agentRegistry);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return AGENT_LAYER.map((spec) => {
    const row = byKey.get(spec.key);
    return {
      ...spec,
      id: row?.id,
      status: row?.status ?? 'ACTIVE',
      isActive: row?.isActive ?? true,
      executable: spec.executable === true,
    };
  });
}

/** Composition of the layer, for API/UI headers. Copilot is counted apart. */
export function agentLayerSummary(): AgentLayerCounts {
  return agentLayerCounts();
}

/** The Copilot spec — a coordinator, never counted among the 20 agents. */
export function copilotAgent(): AgentDefinition {
  return COPILOT_CATALOGUE;
}



/**
 * Resolves an agent from the reference catalogue (20 agents + Copilot) without
 * touching the database. Runnability is a code property (`executable`), so it
 * must not depend on a registry row existing or on a seeding side effect.
 */
function resolveAgentSpec(agentKey: string): AgentDefinition {
  const spec = findAgentSpec(agentKey);
  if (!spec) throw ApiError.notFound('Agent');
  return spec;
}

/**
 * Fallback per-run cost ceiling (USD) used when an agent's registry row declares
 * no positive `limits.maxCostUsdPerRun`. Deliberately finite: a missing or
 * malformed limit must never silently disable the run ceiling.
 */
const DEFAULT_AGENT_RUN_CAP_USD = 5;

/** Parses a stored `agent_tasks.cost` decimal string, degrading to zero. */
function parseStoredCostUsd(cost: string | null | undefined): Decimal {
  if (!cost) return new Decimal(0);
  try {
    const value = new Decimal(cost);
    return value.isFinite() && value.gte(0) ? value : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * Adds two non-negative decimal strings exactly (no floating-point round-trip).
 * A malformed operand degrades to zero, matching {@link parseStoredCostUsd}.
 */
function addDecimalStrings(a: string | null | undefined, b: string): string {
  return parseStoredCostUsd(a).plus(parseStoredCostUsd(b)).toFixed(10);
}

/**
 * The measured cost already spent when an execution threw AFTER the provider
 * call, or `null` when nothing billable happened.
 *
 * - `AgentCostRecordingError` carries the exact cost of a completed call whose
 *   ledger write failed.
 * - `AgentRunBudgetExceededError` carries the measured call cost ONLY when it
 *   was thrown post-provider (`actualCostUsd` present); a pre-flight refusal has
 *   none — nothing was spent and no cost must be invented.
 *
 * The value is validated (a malformed or non-positive amount is rejected rather
 * than written as a misleading zero) but returned VERBATIM, so the stored
 * representation for `AgentCostRecordingError` is unchanged. Every other error
 * yields `null`, leaving the stored cost untouched (AI-INTEG-P3-G3). The value is
 * the CALL's cost, never the run's accumulated total, so a prior cost is never
 * re-added (no double count).
 */
function measuredCostFromError(err: unknown): string | null {
  const raw =
    err instanceof AgentCostRecordingError
      ? err.costUsd
      : err instanceof AgentRunBudgetExceededError
        ? err.actualCostUsd ?? null
        : null;
  if (raw == null) return null;
  return parseStoredCostUsd(raw).gt(0) ? raw : null;
}

/** Roles the requester currently holds, resolved server-side (never from input). */
async function rolesOfUser(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.name as UserRole);
}

/**
 * Builds the trusted execution context and per-run budget for a task about to
 * execute. Every field is derived server-side — the stored task row and the
 * agent's registry row — so a caller-supplied `taskId`/`agentKey`/role/budget can
 * never widen authority. A run with no declared capabilities or tools gets an
 * EMPTY grant list (the T2 action gate will then refuse, fail-closed).
 */
async function buildRunContext(
  db: DB,
  task: { id: string; agentKey: string; taskType?: string | null; requestedBy: string; cost?: string | null },
  requesterRoles: UserRole[],
): Promise<{ context: AgentRunContext; budget: AgentRunBudget }> {
  const registryRows = await db
    .select({ allowedTools: agentRegistry.allowedTools, limits: agentRegistry.limits })
    .from(agentRegistry)
    .where(eq(agentRegistry.key, task.agentKey))
    .limit(1);
  const registry = registryRows[0];
  const limits = (registry?.limits ?? {}) as { maxCostUsdPerRun?: unknown };
  const rawCap = Number(limits.maxCostUsdPerRun);
  const capUsd = Number.isFinite(rawCap) && rawCap > 0 ? new Decimal(rawCap) : new Decimal(DEFAULT_AGENT_RUN_CAP_USD);

  const agentDef = AGENT_CATALOGUE.find((a) => a.key === task.agentKey);
  const authorizedActions = (agentDef?.capabilities ?? []).map((c) => c.action);
  const allowedTools = (registry?.allowedTools ?? []) as string[];
  // A2: the data-scope grant is server-derived from the agent's scope contract
  // (fail-closed — an agent without a contract has no data authority). It is
  // never taken from task `input`, so a caller cannot widen the tables it reads.
  const allowedTables = assertAgentScopeContract(task.agentKey).allowedTables;
  // A2 tenant boundary: every production run must carry a validated owner scope
  // (`scope.ts`), established BEFORE any data access. A run with no trustworthy
  // owner is refused here rather than silently widened.
  assertRunOwnerScope(task.requestedBy);

  const context: AgentRunContext = {
    taskId: task.id,
    agentKey: task.agentKey,
    // The trusted reconciliation evidence id: the stored task's own id, never a
    // caller value. `runAIFeature` records it under AGENT_TASK_LEDGER_KEY so
    // reconciliation keys on server-derived evidence only (AI-INTEG-P3-G2).
    ledgerTaskId: task.id,
    taskType: task.taskType ?? undefined,
    runCapUsd: capUsd.toFixed(10),
    requestedBy: task.requestedBy,
    requesterRoles,
    authorizedActions,
    allowedTables,
    allowedTools,
  };
  // A retry is seeded with the cost the task already recorded, so the ceiling
  // bounds the whole task across attempts and cannot be reset by re-running.
  const budget = new AgentRunBudget(capUsd, parseStoredCostUsd(task.cost));
  return { context, budget };
}

/**
 * Per-agent specialised executors live in `./executors.ts`.
 * `executeAgentTask` routes each agent key to its own DB-backed implementation,
 * returning structured results (never mock data).
 */

export async function createAgentTask(
  db: DB,
  role: UserRole[],
  requestedBy: string,
  input: CreateAgentTaskInput,
  audit: AuditContext,
  fencing?: AgentTaskFencing,
): Promise<ResolvedAgentTask> {
  // Central AI Kill Switch (A1): no NEW AI task may be created while disabled —
  // user requests, scheduler dispatches and approval-triggered runs all pass
  // through here. Fail-closed and uniform across every surface.
  assertAiExecutionEnabled();

  // AI-REG-01: the agent must exist AND have a real executor. Declared-only
  // agents, the Copilot and the oversight supervisor are refused here — before
  // the permission check, before the per-user cap and before any task row is
  // written — and every refusal is audited.
  const agent = resolveAgentSpec(input.agentKey);
  const refusal = agentRunRefusal(agent);
  if (refusal) {
    await writeAudit(db, audit, {
      action: 'AI.AGENT_RUN_REFUSED',
      entityType: 'AGENT',
      entityId: agent.key,
      metadata: {
        agentKey: agent.key,
        code: refusal.code,
        reason: refusal.message,
        requestedBy,
      },
    });
    throw ApiError.conflict(refusal.message);
  }

  if (!role.includes('ADMIN') && !role.includes('SUPER_ADMIN')) {
    // Secondary guard: every required permission must be present.
    const { ROLE_PERMISSIONS } = await import('@wasit/shared');
    const hasAll = agent.permissionsRequired.every((p) =>
      role.some((r) => (ROLE_PERMISSIONS[r] as ReadonlySet<string>).has(p)),
    );
    if (!hasAll) throw ApiError.forbidden('Agent capability not allowed for your role');
  }

  const requiresApproval = agent.requiresHumanApproval;
  const initialStatus: AgentTaskStatus = requiresApproval ? 'awaiting_approval' : 'queued';

  // Bound per-user concurrent work (011.4): a user may hold only so many
  // non-terminal tasks. Applies to user-initiated creation only — a scheduler
  // dispatch (fencing) is not a user request and must not be blocked here.
  if (!fencing) {
    const active = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.requestedBy, requestedBy),
          sql`${agentTasks.status} not in ('succeeded', 'failed', 'rejected', 'approved')`,
        ),
      );
    if (active.length >= env.AI_AGENT_MAX_ACTIVE_TASKS_PER_USER) {
      throw ApiError.tooManyRequests('Too many active agent tasks; wait for existing tasks to finish');
    }
  }

  const id = newId();

  if (fencing) {
    // Service-level fencing (AI-02.3.2). The task is created only if the step is
    // still RUNNING and still owned by the exact claim that dispatched it. The
    // ownership re-check (which also renews the recovery lease) and the insert
    // share one transaction, so Recovery cannot settle the step in between and a
    // stale dispatch cannot attach a task to a step it no longer owns.
    await db.transaction(async (tx) => {
      // The ownership UPDATE is taken FIRST so it doubles as the step's row lock.
      // Two concurrent creators for the same step then serialise here: the loser
      // blocks until the winner commits and only then reads the task table. A
      // bare SELECT-then-INSERT before this lock is not atomic under READ
      // COMMITTED — both transactions would see "no task" and both would insert,
      // producing two active tasks for one step.
      const owned = await tx
        .update(agentRunSteps)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(agentRunSteps.id, fencing.stepId),
            eq(agentRunSteps.runId, fencing.runId),
            eq(agentRunSteps.status, 'RUNNING'),
            eq(agentRunSteps.attemptCount, fencing.claimToken),
          ),
        )
        .returning({ id: agentRunSteps.id });
      if (owned.length === 0) {
        throw ApiError.conflict('Step is no longer owned by this dispatch; refusing to create an agent task');
      }
      // Under the row lock this read sees any task the winning creator committed.
      const existing = await tx
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(sql`${agentTasks.input}->>'__stepId' = ${fencing.stepId}`)
        .limit(1);
      if (existing.length > 0) {
        // Idempotent: a task already exists for this step; do not create a second.
        throw ApiError.conflict(`Step already has an agent task; refusing to create a duplicate`);
      }
      await tx.insert(agentTasks).values({
        id,
        agentKey: agent.key,
        requestedBy,
        input: input.input as never,
        status: initialStatus,
        requiresApproval,
        model: 'local-heuristic',
      });
    });
  } else {
    await db.insert(agentTasks).values({
      id,
      agentKey: agent.key,
      requestedBy,
      input: input.input as never,
      status: initialStatus,
      requiresApproval,
      model: 'local-heuristic',
    });
  }

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_CREATED',
    entityType: 'AGENT_TASK',
    entityId: id,
    metadata: { agentKey: agent.key, requiresApproval },
  });

  let status: AgentTaskStatus = initialStatus;
  let result: unknown = null;
  let error: unknown = null;
  let tokensInput = 0;
  let tokensOutput = 0;
  // `null` means "cost unknown" (a deterministic executor made no provider
  // call). It is kept distinct from a real zero-cost run and only collapsed to
  // the stored default `'0'` at the API boundary (AI-INTEG-P3-T1.1 / F1).
  let cost: string | null = null;
  let model = 'local-heuristic';

  if (!requiresApproval) {
    const started = Date.now();
    status = 'running';
    await db.update(agentTasks).set({ status, startedAt: new Date() }).where(eq(agentTasks.id, id));
    try {
      // Bind the trusted run identity and per-run budget to THIS execution only
      // (AI-INTEG-P3-T1). Both are derived server-side from the stored task row
      // and the agent's registry row — never from `input` — so a caller cannot
      // forge the task/agent it runs as, nor raise its own cost ceiling. The
      // context expires when the callback returns and cannot leak into another
      // run. When no context exists elsewhere the guards stay inert (unchanged
      // behaviour), so this wrapper is additive.
      const requesterRoles = await rolesOfUser(db, requestedBy);
      const { context, budget } = await buildRunContext(
        db,
        { id, agentKey: agent.key, requestedBy, cost: null },
        requesterRoles,
      );
      const advice = await withAgentRunContext(context, () =>
        withAgentRunBudget(budget, () =>
          executeAgentTask(db, agent, { ...input.input, __userId: requestedBy }),
        ),
      );
      tokensInput = advice.tokensInput;
      tokensOutput = advice.tokensOutput;
      // Persist the measured cost so a retry can seed its ceiling with it
      // (AI-INTEG-P3-T1.1 / F1). The executors return the exact Decimal string
      // `runAIFeature` computed; when it is absent the cost is genuinely unknown
      // and is left unset rather than stored as a misleading zero.
      cost = advice.cost ?? null;
      result = { agentKey: agent.key, advice: advice.content, readOnly: true };
      status = 'succeeded';
      await db
        .update(agentTasks)
        .set({
          status,
          result: result as never,
          tokensInput,
          tokensOutput,
          ...(cost !== null ? { cost } : {}),
          model,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
        })
        .where(eq(agentTasks.id, id));
      await writeAudit(db, audit, {
        action: 'AI.AGENT_TASK_SUCCEEDED',
        entityType: 'AGENT_TASK',
        entityId: id,
        after: result as never,
      });
    } catch (err) {
      status = 'failed';
      error = { message: err instanceof Error ? err.message : 'Unknown error' };
      // A cost-recording or over-budget failure happens AFTER the provider call,
      // so money was spent even though the run is recorded as failed: persist the
      // measured CALL cost so the retry ceiling carries it (F1/G3) instead of
      // silently resetting. The value is the call's own cost — never the run's
      // accumulated total — so a prior cost is not re-added (no double count).
      const recordedCost = measuredCostFromError(err);
      await db
        .update(agentTasks)
        .set({ status, error: error as never, errorAt: new Date(), ...(recordedCost !== null ? { cost: recordedCost } : {}) })
        .where(eq(agentTasks.id, id));
      await writeAudit(db, audit, {
        action: 'AI.AGENT_TASK_FAILED',
        entityType: 'AGENT_TASK',
        entityId: id,
        metadata: { error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }

  return {
    id,
    agentKey: agent.key,
    requestedBy,
    input: input.input,
    status,
    result,
    error,
    requiresApproval,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    tokensInput,
    tokensOutput,
    // `ResolvedAgentTask.cost` is a string; a genuinely-unknown cost surfaces as
    // the stored default `'0'` at this boundary only (AI-INTEG-P3-T1.1 / F1).
    cost: cost ?? '0',
    model,
    latencyMs: 0,
    createdAt: new Date(),
  };
}

/** Lists the current user's tasks, newest first. */
export async function listMyTasks(db: DB, userId: string): Promise<ResolvedAgentTask[]> {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.requestedBy, userId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    agentKey: r.agentKey,
    requestedBy: r.requestedBy,
    input: (r.input ?? {}) as never,
    status: r.status as AgentTaskStatus,
    result: r.result,
    error: r.error,
    requiresApproval: r.requiresApproval,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    cost: r.cost,
    model: r.model,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  }));
}

export async function getTask(db: DB, taskId: string): Promise<ResolvedAgentTask> {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Agent task');
  const r = rows[0];
  return {
    id: r.id,
    agentKey: r.agentKey,
    requestedBy: r.requestedBy,
    input: (r.input ?? {}) as never,
    status: r.status as AgentTaskStatus,
    result: r.result,
    error: r.error,
    requiresApproval: r.requiresApproval,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    cost: r.cost,
    model: r.model,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  };
}

/**
 * Outcome of a terminal write. `applied` is false only when the write was
 * FENCED OUT — the task was no longer `running` when the row lock was taken, so
 * a stale writer cannot overwrite a decision already made (AI-INTEG-P3-T1.6).
 */
export interface TaskTerminalWrite {
  applied: boolean;
  reason: 'applied' | 'not_running' | 'missing';
}

/**
 * Writes a task's terminal state and accumulates its measured cost, FENCED to a
 * task that is still `running`.
 *
 * Runs in a SHORT transaction that locks the task row (`SELECT … FOR UPDATE`),
 * re-checks the CURRENT status, re-reads the CURRENT stored cost, and adds to it
 * with {@link addDecimalStrings}. Two writers therefore serialise on the row and
 * each accumulates onto the value the other committed — no lost update. It is
 * deliberately called only AFTER the provider call (never around it), so no row
 * lock is ever held across the network.
 *
 * The status guard is the fencing token for `agent_tasks` (AI-INTEG-P3-T1.6):
 * only a writer that observes `running` inside the lock may move the task to a
 * terminal state. A late/duplicate writer sees the terminal state and returns
 * `applied: false` WITHOUT writing the result or the cost, so it can neither
 * resurrect nor double-count a settled task. This mirrors the step-level
 * `fencedStepWrite`, using the task's own lifecycle as the fence.
 *
 * `addCostUsd === null` means "the cost is unknown; leave the stored value
 * untouched" (distinct from a real `'0'`).
 */
async function writeTaskTerminal(
  db: DB,
  taskId: string,
  patch: Record<string, unknown>,
  addCostUsd: string | null,
): Promise<TaskTerminalWrite> {
  return db.transaction(async (tx) => {
    const locked = await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1).for('update');
    const row = locked[0];
    if (!row) return { applied: false, reason: 'missing' };
    if (row.status !== 'running') return { applied: false, reason: 'not_running' };
    const base = row.cost ?? '0';
    await tx
      .update(agentTasks)
      .set({ ...patch, ...(addCostUsd !== null ? { cost: addDecimalStrings(base, addCostUsd) } : {}) } as never)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'running')));
    return { applied: true, reason: 'applied' };
  });
}

/** Approves (or rejects) a task awaiting approval. Performs the run afterwards. */
export async function decideAgentTask(
  db: DB,
  taskId: string,
  approverId: string,
  decision: 'APPROVE' | 'REJECT',
  reason: string | null,
  audit: AuditContext,
): Promise<ResolvedAgentTask> {
  const task = await getTask(db, taskId);
  if (task.status !== 'awaiting_approval') {
    throw ApiError.conflict('Task is not awaiting approval');
  }

  // Central AI Kill Switch (A1): approving a task triggers an execution, so a
  // global disable must refuse it here — BEFORE the atomic claim — rather than
  // starting a run and then failing mid-flight. Rejection stays allowed: it is a
  // safe, no-execution decision and must remain available during a stop.
  if (decision === 'APPROVE') {
    assertAiExecutionEnabled();
  }

  // Separation of duties (AI-02.P0): the person who requested a task may never
  // approve it, no matter how privileged their role. This is enforced here — the
  // single service every approval surface calls — rather than in the UI, so an
  // administrator cannot rubber-stamp their own sensitive request. SUPER_ADMIN is
  // included deliberately: holding every permission does not make self-approval
  // acceptable; a different authorised approver must decide.
  if (decision === 'APPROVE' && task.requestedBy === approverId) {
    throw ApiError.forbidden('You cannot approve your own agent task; another authorised approver must decide');
  }

  if (decision === 'REJECT') {
    // Conditional, like the claim below: only the caller that actually moves the
    // task out of `awaiting_approval` reports success. A lost race is a conflict,
    // never a misleading "rejected".
    const rejected = await db
      .update(agentTasks)
      .set({ status: 'rejected', approvedBy: approverId, approvedAt: new Date(), rejectionReason: reason })
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'awaiting_approval')))
      .returning({ id: agentTasks.id });
    if (rejected.length === 0) {
      throw ApiError.conflict('Task is not awaiting approval');
    }
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_REJECTED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { reason },
    });
    return getTask(db, taskId);
  }

  // Atomic claim (AI-INTEG-P3-T1.3): the transition awaiting_approval → running is
  // a single conditional UPDATE, so exactly ONE caller can win it. The loser
  // matches no row and is refused BEFORE any provider call — this closes the
  // double-execution window a plain check-then-act left open. It is a lone
  // statement (its own implicit transaction), so no lock is held afterwards.
  const claimed = await db
    .update(agentTasks)
    .set({ status: 'running', approvedBy: approverId, approvedAt: new Date(), startedAt: new Date() })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'awaiting_approval')))
    .returning({ id: agentTasks.id });
  if (claimed.length === 0) {
    // Someone else already claimed (or decided) this task. Do not run anything.
    throw ApiError.conflict('Task is not awaiting approval');
  }

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_APPROVED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { reason },
  });

  const agent = resolveAgentSpec(task.agentKey);
  const approvalRefusal = agentRunRefusal(agent);
  if (approvalRefusal) throw ApiError.conflict(approvalRefusal.message);
  const started = Date.now();
  try {
    // Same trusted execution context as the direct path (AI-INTEG-P3-T1): the
    // identity is the task OWNER (`requestedBy`) — the stored row, not the
    // approver and never `input` — so per-owner metrics/limits stay consistent
    // with the direct path. The approver's authority was already enforced above
    // (AI_MANAGE + separation of duties); this wrapper only binds identity and
    // the run budget, and is inert when no context is otherwise present.
    const requesterRoles = await rolesOfUser(db, task.requestedBy);
    const { context, budget } = await buildRunContext(
      db,
      { id: taskId, agentKey: agent.key, requestedBy: task.requestedBy, cost: task.cost },
      requesterRoles,
    );
    const advice = await withAgentRunContext(context, () =>
      withAgentRunBudget(budget, () =>
        executeAgentTask(db, agent, { ...task.input, __userId: approverId }),
      ),
    );
    const result = { agentKey: agent.key, advice: advice.content, readOnly: true };
    // Persist the terminal state and accumulate the measured cost in a SHORT
    // locked transaction (never around the provider call). A `cost: undefined`
    // from a deterministic executor leaves the stored value untouched.
    const written = await writeTaskTerminal(
      db,
      taskId,
      {
        status: 'approved',
        result: result as never,
        tokensInput: advice.tokensInput,
        tokensOutput: advice.tokensOutput,
        model: 'local-heuristic',
        completedAt: new Date(),
        latencyMs: Date.now() - started,
      },
      advice.cost ?? null,
    );
    if (!written.applied) {
      // Fenced out: the task was settled by another writer (recovery/duplicate)
      // while this run was in flight. Do not claim a success we no longer own.
      logger.warn('agent task terminal write fenced out', { taskId, reason: written.reason });
      return getTask(db, taskId);
    }
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_COMPLETED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      after: result as never,
    });

    // Notify the requester that their task is complete.
    await createNotification(db, {
      userId: task.requestedBy,
      type: 'AI.AGENT_TASK_COMPLETED',
      title: `Agent ${agent.key}`,
      body: 'Your agent task has been approved and completed.',
      data: { taskId },
    });
    return getTask(db, taskId);
  } catch (err) {
    const error = { message: err instanceof Error ? err.message : 'Unknown error' };
    // A cost-recording or over-budget failure is post-provider: the spend is
    // real. Accumulate the measured CALL cost onto the stored value (read under
    // lock) so it is not lost — and never double-count a prior cost, because the
    // value is the call's own cost, not the run's accumulated total. Any other
    // failure leaves the cost untouched (unknown).
    const recordedCost = measuredCostFromError(err);
    const written = await writeTaskTerminal(
      db,
      taskId,
      { status: 'failed', error: error as never, errorAt: new Date() },
      recordedCost,
    );
    if (!written.applied) {
      logger.warn('agent task failure write fenced out', { taskId, reason: written.reason });
      return getTask(db, taskId);
    }
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_FAILED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: error,
    });
    return getTask(db, taskId);
  }
}

/**
 * Evidence-based cost recovery (AI-INTEG-P3-T1.6).
 *
 * A crash AFTER the provider call but BEFORE `writeTaskTerminal` leaves a task
 * stuck in `running` with no durable result and no cost. The provider's spend,
 * however, was already recorded by `runAIFeature` as an `ai_requests` row whose
 * SERVER-OWNED `metadata[AGENT_TASK_LEDGER_KEY]` links it to this task. This
 * function recovers that EXACT cost — never an estimate — and closes the task,
 * but ONLY when the evidence is unambiguous.
 *
 * It NEVER re-executes the provider call (the outcome is unknown; re-running
 * could double-spend and could duplicate an external side effect).
 *
 * Evidence trust (AI-INTEG-P3-G2): the key is written only from a trusted run
 * context (`mergeAgentTaskMetadata`) and is stripped from every caller-supplied
 * metadata object, so a forged `metadata.taskId` on the direct `/api/ai/run`
 * path can never be read as a task's own evidence.
 *
 * Reconciliation is attempted only when ALL of these hold:
 *  - the task is still `running`;
 *  - exactly ONE `ai_requests` row carries the trusted ledger id === taskId;
 *  - that row's `status` is a completed, billable success (`SUCCESS`/`OVER_BUDGET`);
 *  - its `cost` parses as a finite, non-negative decimal.
 *
 * Otherwise it makes NO change and reports why. In particular, several rows (an
 * ambiguous multi-attempt history) are never summed, and an absent row is never
 * read as "zero cost".
 *
 * The close itself is a fenced terminal write, so a concurrent writer cannot be
 * double-counted and a repeat call is a no-op (the task is no longer `running`).
 */
export type CostRecoveryReason =
  | 'recovered'
  | 'not_running'
  | 'no_ledger_row'
  | 'ambiguous_ledger_rows'
  | 'ledger_row_not_billable'
  | 'ledger_cost_unreadable'
  | 'fenced_out';

export interface CostRecoveryResult {
  recovered: boolean;
  reason: CostRecoveryReason;
  costUsd?: string;
  ledgerRowId?: string;
}

export async function reconcileTaskCostFromLedger(
  db: DB,
  taskId: string,
  audit: AuditContext,
): Promise<CostRecoveryResult> {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  const task = rows[0];
  if (!task) return { recovered: false, reason: 'not_running' };
  // Recovery is only ever for a task that never reached a terminal state. A task
  // already settled (succeeded/failed/approved/rejected) is left untouched.
  if (task.status !== 'running') return { recovered: false, reason: 'not_running' };

  const ledger = await db
    .select()
    .from(aiRequests)
    // Key on the SERVER-OWNED evidence id, never the caller-supplied `taskId`.
    // `mergeAgentTaskMetadata`/`stripReservedAgentMetadata` write this key only
    // from a trusted run context, so a forged `metadata.taskId` from a direct
    // request (`/api/ai/run`) cannot be mistaken for a task's own evidence
    // (AI-INTEG-P3-G2).
    .where(sql`${aiRequests.metadata}->>${sql.raw(`'${AGENT_TASK_LEDGER_KEY}'`)} = ${taskId}`);
  // Zero rows is NOT proof the provider never ran; it is simply "no evidence".
  if (ledger.length === 0) return { recovered: false, reason: 'no_ledger_row' };
  // More than one row means we cannot tell which attempt the task's spend came
  // from. Never guess, never sum uncertain costs.
  if (ledger.length > 1) return { recovered: false, reason: 'ambiguous_ledger_rows' };

  const row = ledger[0];
  if (row.status !== 'SUCCESS' && row.status !== 'OVER_BUDGET') {
    return { recovered: false, reason: 'ledger_row_not_billable', ledgerRowId: row.id };
  }
  const parsed = new Decimal(row.cost);
  if (!parsed.isFinite() || parsed.lt(0)) {
    return { recovered: false, reason: 'ledger_cost_unreadable', ledgerRowId: row.id };
  }
  const costUsd = parsed.toFixed(10);

  const message =
    'Provider completed, but task result was not durably saved; cost recovered from ai_requests.';
  const written = await writeTaskTerminal(
    db,
    taskId,
    { status: 'failed', error: { message } as never, errorAt: new Date() },
    costUsd,
  );
  if (!written.applied) {
    // Another writer settled the task between our read and our write: leave the
    // authoritative decision alone (the fence prevents a double cost).
    logger.warn('agent task cost recovery fenced out', { taskId, reason: written.reason });
    return { recovered: false, reason: 'fenced_out', ledgerRowId: row.id };
  }

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_COST_RECOVERED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { costUsd, ledgerRowId: row.id, reason: 'provider_completed_result_not_saved' },
  });
  logger.info('agent task cost recovered from ai_requests', { taskId, costUsd, ledgerRowId: row.id });
  return { recovered: true, reason: 'recovered', costUsd, ledgerRowId: row.id };
}