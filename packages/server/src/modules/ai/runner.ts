import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRegistry, agentTasks } from '../../db/schema/agents';
import { roles, userRoles } from '../../db/schema/auth';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/observability/logger';
import type { AgentDefinition, AgentTaskStatus, CreateAgentTaskInput, ResolvedAgentTask } from '../../lib/ai/types.js';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE, allAgentSpecs, findAgentSpec, resolveApproval } from './catalogue.js';
import { executeAgentTask } from './executors.js';
import { DEFAULT_SUPERVISOR_LIMITS } from './supervisor-policy.js';
import { supervise, unhealthyAgentKeys } from './supervisor.js';

export { AGENT_CATALOGUE, COPILOT_CATALOGUE, allAgentSpecs, agentCount, isSensitiveAction, SENSITIVE_ACTIONS } from './catalogue.js';

/** The supervisor's own agent key — excluded from its own failure-rate guard. */
export const SUPERVISOR_KEY = 'agent-supervisor';

/** Statuses that end a task's life; a dedupe key only collides on open tasks. */
const TERMINAL: AgentTaskStatus[] = ['succeeded', 'failed', 'rejected', 'blocked'];

/**
 * The internal automation principal, used only by the trusted in-process
 * scheduler. It is a *named, singular* identity — never an arbitrary user id —
 * and a task only runs under it when its `triggeredBy` carries the scheduler
 * provenance marker below. A task that merely claims `requestedBy: 'system'`
 * without that marker is treated as an ordinary user with no roles and is
 * refused, so a forged task cannot inherit platform privileges.
 */
export const SYSTEM_PRINCIPAL = 'system';
const SCHEDULER_TRIGGER_PREFIX = 'schedule:';

/** True only for a task the trusted scheduler itself enqueued. */
function isTrustedSchedulerTask(triggeredBy: string): boolean {
  return triggeredBy.startsWith(SCHEDULER_TRIGGER_PREFIX);
}

/** The roles the scheduler principal executes with (its own delegation roles). */
function trustedPrincipalRoles(): UserRole[] {
  return ['SUPER_ADMIN'];
}
const DEFAULT_MAX_ATTEMPTS = 3;

/** Default per-run budget guard when an agent does not declare one. */
const DEFAULT_MAX_COST_USD = 5;

/**
 * Idempotently mirror the declarative catalogue into `agent_registry`.
 *
 * Only declarative fields are refreshed: operator-controlled lifecycle state
 * (`status`, `isActive`) is never overwritten, so a paused/disabled agent stays
 * paused across a re-seed. Mirrors `sync_registry` in the reference layer.
 */
export async function syncAgentRegistry(db: DB): Promise<{ created: number; updated: number; total: number }> {
  const existing = await db.select({ key: agentRegistry.key }).from(agentRegistry);
  const existingKeys = new Set(existing.map((r) => r.key));
  let created = 0;
  let updated = 0;
  for (const def of allAgentSpecs()) {
    const values = {
      name: def.name,
      nameAr: def.nameAr ?? null,
      mission: def.mission ?? null,
      category: def.category ?? 'general',
      description: def.description,
      capabilities: def.capabilities as never,
      allowedTools: def.allowedTools as never,
      approvalActions: def.approvalActions as never,
      limits: { ...def.limits, ...(def.isSupervisor ? { isSupervisor: true } : {}) } as never,
      taskTypes: def.taskTypes as never,
      permissionsRequired: def.permissionsRequired as never,
      requiresHumanApproval: def.requiresHumanApproval,
      isCopilot: def.isCopilot ?? false,
    };
    if (existingKeys.has(def.key)) {
      await db.update(agentRegistry).set(values).where(eq(agentRegistry.key, def.key));
      updated += 1;
    } else {
      await db.insert(agentRegistry).values({
        id: newId(),
        key: def.key,
        inputSchema: (def.inputSchema ?? null) as never,
        status: 'ACTIVE',
        isActive: true,
        ...values,
      });
      created += 1;
    }
  }
  return { created, updated, total: allAgentSpecs().length };
}

async function getAgentDef(db: DB, agentKey: string): Promise<AgentDefinition> {
  const found = findAgentSpec(agentKey);
  if (!found) throw ApiError.notFound('Agent');
  await syncAgentRegistry(db);
  return found;
}

/** Registry row (declarative definition + operator lifecycle state). */
export async function getRegistryAgent(db: DB, agentKey: string) {
  await syncAgentRegistry(db);
  const rows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, agentKey)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Agent');
  return rows[0];
}

export async function listAgents(db: DB): Promise<AgentDefinition[]> {
  await syncAgentRegistry(db);
  const rows = await db.select().from(agentRegistry).orderBy(asc(agentRegistry.category), asc(agentRegistry.key));
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    nameAr: r.nameAr ?? undefined,
    mission: r.mission ?? undefined,
    category: r.category,
    description: r.description ?? '',
    capabilities: (r.capabilities ?? []) as AgentDefinition['capabilities'],
    allowedTools: (r.allowedTools ?? []) as string[],
    approvalActions: (r.approvalActions ?? []) as string[],
    limits: (r.limits ?? {}) as Record<string, number>,
    taskTypes: (r.taskTypes ?? []) as string[],
    permissionsRequired: (r.permissionsRequired ?? []) as string[],
    scope: findAgentSpec(r.key)?.scope ?? 'own',
    requiresHumanApproval: r.requiresHumanApproval,
    isCopilot: r.isCopilot,
  }));
}

/** Raw registry rows for admin oversight. Seeds the catalogue first. */
export async function listRegistryAgents(db: DB) {
  await syncAgentRegistry(db);
  return db.select().from(agentRegistry).orderBy(asc(agentRegistry.category), asc(agentRegistry.key));
}

/** Role check: ADMIN/SUPER_ADMIN bypass; otherwise every required permission. */
async function assertAgentAllowed(role: UserRole[], agent: AgentDefinition): Promise<void> {
  if (role.includes('ADMIN') || role.includes('SUPER_ADMIN')) return;
  const { ROLE_PERMISSIONS } = await import('@wasit/shared');
  const hasAll = agent.permissionsRequired.every((p) =>
    role.some((r) => (ROLE_PERMISSIONS[r] as ReadonlySet<string>)?.has(p)),
  );
  if (!hasAll) throw ApiError.forbidden('Agent capability not allowed for your role');
}

/**
 * Kill switch: a PAUSED or DISABLED agent must not run. Returns the blocked task
 * (and audits the block) when the guard trips, otherwise `null` so the caller
 * proceeds. Kept in one place so every execution path — including the
 * supervisor's dedicated branch — enforces the same stop.
 */
async function blockIfAgentStopped(
  db: DB,
  taskId: string,
  agentKey: string,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask | null> {
  const registry = await getRegistryAgent(db, agentKey);
  if (registry.status !== 'DISABLED' && registry.status !== 'PAUSED') return null;
  const blocked = await db
    .update(agentTasks)
    .set({ status: 'blocked', error: { message: `agent ${registry.status.toLowerCase()}` } as never })
    .where(runningClaimGuard(taskId))
    .returning({ id: agentTasks.id });
  // The watchdog may have already failed the task; then it is not ours to block.
  if (blocked.length === 0) return getTask(db, taskId);
  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_BLOCKED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { reason: `agent ${registry.status}` },
  });
  return getTask(db, taskId);
}

/** Loads the role names currently granted to a user id. */
export async function resolveUserRoles(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

/**
 * True when a role set may read platform-wide data.
 *
 * Restricted to admins only: holding `analytics:read:all` is NOT sufficient, so
 * support/risk/dispute roles cannot reach another tenant's data.
 */
function holdsPlatformAnalytics(role: UserRole[]): boolean {
  return role.includes('ADMIN') || role.includes('SUPER_ADMIN');
}

/**
 * Detects an executor refusal encoded in the agent's advice. Executors return a
 * `{ status: 'refused', error: '<CODE>' }` payload when they cannot establish a
 * safe data scope; the task runner must surface that as a failure rather than a
 * success, otherwise a refused run is indistinguishable from a healthy one.
 */
function detectRefusal(content: string): { code: string; message: string } | null {
  if (!content || !content.includes('refused')) return null;
  try {
    const parsed = JSON.parse(content) as { status?: string; error?: string; message?: string };
    if (parsed?.status === 'refused') {
      return { code: parsed.error ?? 'REFUSED', message: parsed.message ?? '' };
    }
  } catch {
    // Not a structured refusal payload — treat as normal output.
  }
  return null;
}

/**
 * Enforces an agent's data-access scope.
 *
 * Only agents that return a platform-wide result whose value *is* the aggregate
 * (`requiresPlatformScope`) are gated here: the caller must be an admin
 * (`ADMIN`/`SUPER_ADMIN`). Agents whose output is already tenant-scoped, or that
 * expose only anonymised platform *counts*, are not gated — their executors
 * never return another tenant's rows.
 *
 * This runs both when a task is created and again immediately before execution,
 * so a scheduled or later-approved task can never execute with a permission the
 * requester no longer holds — or never held.
 */
export async function assertAgentScope(db: DB, role: UserRole[], agent: AgentDefinition): Promise<void> {
  if (!agent.requiresPlatformScope) return;
  if (holdsPlatformAnalytics(role)) return;
  throw ApiError.forbidden('Agent requires an admin role for platform-wide data');
}

/**
 * True when a task for this agent needs an explicit human approval.
 *
 * Delegates to the single catalogue authority ({@link resolveApproval}) so the
 * gate can never drift from the declared `approvalActions` / `SENSITIVE_ACTIONS`.
 */
export function actionRequiresApproval(agent: AgentDefinition, taskType: string | undefined): boolean {
  return resolveApproval(agent, taskType).requiresApproval;
}

function toResolved(r: typeof agentTasks.$inferSelect): ResolvedAgentTask {
  return {
    id: r.id,
    agentKey: r.agentKey,
    requestedBy: r.requestedBy,
    taskType: r.taskType,
    input: (r.input ?? {}) as Record<string, unknown>,
    status: r.status as AgentTaskStatus,
    result: r.result,
    error: r.error,
    requiresApproval: r.requiresApproval,
    approvalAction: r.approvalAction,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    dedupeKey: r.dedupeKey,
    correlationId: r.correlationId,
    triggeredBy: r.triggeredBy,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    scheduledFor: r.scheduledFor,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    cost: r.cost,
    model: r.model,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  };
}

export async function getTask(db: DB, taskId: string): Promise<ResolvedAgentTask> {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Agent task');
  return toResolved(rows[0]);
}

export async function listMyTasks(db: DB, userId: string): Promise<ResolvedAgentTask[]> {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.requestedBy, userId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(50);
  return rows.map(toResolved);
}

/**
 * Creates a task, or returns the existing open one when `dedupeKey` matches.
 * Sensitive actions are queued as `awaiting_approval`; read-only tasks run now.
 */
export async function createAgentTask(
  db: DB,
  role: UserRole[],
  requestedBy: string,
  input: CreateAgentTaskInput,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const agent = await getAgentDef(db, input.agentKey);
  await assertAgentAllowed(role, agent);
  await assertAgentScope(db, role, agent);

  // Capability boundary: an agent may only be asked to do the task types it
  // declares, so a caller cannot stretch an agent beyond its defined scope.
  if (input.taskType && !agent.taskTypes.includes(input.taskType)) {
    throw ApiError.forbidden(`Agent ${agent.key} does not handle task type ${input.taskType}`);
  }

  // Idempotency: an open task with the same dedupe key owned by the *same*
  // caller is returned unchanged. Scoping by `requestedBy` means a caller can
  // never adopt (or read) another owner's open task just by reusing its key.
  if (input.dedupeKey) {
    const open = await db
      .select()
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.requestedBy, requestedBy),
          eq(agentTasks.dedupeKey, input.dedupeKey),
          sql`${agentTasks.status} not in ${TERMINAL}`,
        ),
      )
      .limit(1);
    if (open.length > 0) return toResolved(open[0]);
  }

  const { requiresApproval, approvalAction } = resolveApproval(agent, input.taskType);
  const initialStatus: AgentTaskStatus = requiresApproval ? 'awaiting_approval' : 'queued';

  const id = newId();
  const correlationId = input.correlationId ?? newId();
  const inserted = await db
    .insert(agentTasks)
    .values({
      id,
      agentKey: agent.key,
      requestedBy,
      taskType: input.taskType ?? null,
      input: input.input as never,
      status: initialStatus,
      requiresApproval,
      approvalAction,
      dedupeKey: input.dedupeKey ?? null,
      correlationId,
      triggeredBy: input.triggeredBy ?? 'user',
      priority: input.priority ?? 100,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      scheduledFor: input.scheduledFor ?? null,
      model: 'local-heuristic',
    })
    // Concurrent double-submit protection: the partial unique index
    // (`agent_tasks_dedupe_open_uidx`) rejects the second open insertion. The
    // conflict target names that index's exact columns and predicate, so only
    // *this* index can mask a conflict — any future unique constraint would
    // still surface its error. Rather than error, yield the race to the first
    // writer and return its open task — exactly one open task per (owner, key).
    .onConflictDoNothing({
      target: [agentTasks.requestedBy, agentTasks.dedupeKey],
      where: sql`${agentTasks.dedupeKey} is not null and ${agentTasks.status} not in ('succeeded', 'failed', 'rejected', 'blocked')`,
    })
    .returning({ id: agentTasks.id });

  if (inserted.length === 0 && input.dedupeKey) {
    const existing = await db
      .select()
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.requestedBy, requestedBy),
          eq(agentTasks.dedupeKey, input.dedupeKey),
          sql`${agentTasks.status} not in ${TERMINAL}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return toResolved(existing[0]);
    // The conflicting row turned terminal between the insert and this read;
    // surface a conflict rather than silently fabricating a task.
    throw ApiError.conflict('Duplicate task');
  }

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_CREATED',
    entityType: 'AGENT_TASK',
    entityId: id,
    metadata: { agentKey: agent.key, taskType: input.taskType, requiresApproval, approvalAction },
  });

  if (!requiresApproval) {
    await runTask(db, id, audit);
  }
  return getTask(db, id);
}

/**
 * Executes a supervisor observation task. Kept separate because the supervisor
 * is invoked as a guardrail (no timeout race, no retry loop) and its result is
 * the deterministic health report it just persisted.
 */
async function runSupervisorTask(
  db: DB,
  taskId: string,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const started = Date.now();
  const held = await db
    .update(agentTasks)
    .set({ status: 'running', attempts: sql`${agentTasks.attempts} + 1`, startedAt: new Date() })
    .where(runningClaimGuard(taskId))
    .returning({ id: agentTasks.id });
  if (held.length === 0) return getTask(db, taskId); // claim lost (e.g. reaped)
  try {
    const report = await supervise(db);
    const result = {
      agentKey: SUPERVISOR_KEY,
      advice: JSON.stringify({ agentKey: SUPERVISOR_KEY, action: 'supervisor.observe', report, readOnly: true, deterministic: true }),
      readOnly: true,
    };
    const finished = await db
      .update(agentTasks)
      .set({ status: 'succeeded', result: result as never, model: 'deterministic', completedAt: new Date(), latencyMs: Date.now() - started })
      .where(runningClaimGuard(taskId))
      .returning({ id: agentTasks.id });
    if (finished.length === 0) return getTask(db, taskId);
    await writeAudit(db, audit, {
      action: 'AI.SUPERVISOR_OBSERVED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { interventions: report.interventions.length, alerts: report.alerts.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const finished = await db
      .update(agentTasks)
      .set({ status: 'failed', error: { message } as never, errorAt: new Date(), latencyMs: Date.now() - started })
      .where(runningClaimGuard(taskId))
      .returning({ id: agentTasks.id });
    if (finished.length === 0) return getTask(db, taskId);
    await writeAudit(db, audit, { action: 'AI.SUPERVISOR_FAILED', entityType: 'AGENT_TASK', entityId: taskId, metadata: { error: message } });
  }
  return getTask(db, taskId);
}

/**
 * Atomically claims a task for execution by transitioning it to `running`.
 *
 * The single conditional UPDATE is the lock: only a caller that observes the
 * task in one of `from` transitions it, so of any number of concurrent callers
 * exactly one wins and the rest receive `null`. A task already `running`
 * (another caller or a scheduler tick holds it) can never be claimed again,
 * which is what makes execution single-flight across every path — the scheduler
 * (`executeDueTasks`), the on-demand admin run (`runApprovedTask`) and a direct
 * `runTask` call all go through here. This replaces the previous blind
 * `status = 'running'` write, which let a second caller execute a row that had
 * already been claimed.
 */
async function claimTaskForRun(
  db: DB,
  taskId: string,
  from: AgentTaskStatus[],
): Promise<boolean> {
  const claimed = await db
    .update(agentTasks)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(agentTasks.id, taskId), inArray(agentTasks.status, from)))
    .returning({ id: agentTasks.id });
  return claimed.length > 0;
}

/**
 * WHERE guard for every write that finalises a run: it matches only the row this
 * caller still owns (`running`). The watchdog (`reapStaleTasks`) may fail a task
 * once its execution exceeds the timeout, so a late write from the original
 * (still in-flight) runner would otherwise resurrect a terminal task and record a
 * second, contradictory outcome. A guarded update that matches zero rows means the
 * claim was lost — the caller must then skip its audit entry and leave the
 * watchdog's terminal state in place.
 */
function runningClaimGuard(taskId: string) {
  return and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'running'));
}

/**
 * Executes one task with timeout + retry/backoff and full audit.
 *
 * Single-flight: the task is claimed before any work starts, so a task that is
 * terminal or already `running` is a no-op (idempotent replay) and never runs a
 * second time — whether the second caller is the scheduler, the on-demand admin
 * route, or a direct call. A failure below the attempt ceiling is rescheduled
 * with exponential backoff rather than looping immediately, and the loop guard
 * (kill switch) is checked before every run.
 */
export async function runTask(
  db: DB,
  taskId: string,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
  opts: { timeoutMs?: number } = {},
): Promise<ResolvedAgentTask> {
  const current = await getTask(db, taskId);
  if (TERMINAL.includes(current.status) || current.status === 'running') return current;

  // Only a `queued` (auto-runnable) or `approved` (human-gated, cleared) task may
  // start. `awaiting_approval` is deliberately absent: approval must never be
  // bypassed by calling the runner directly.
  const claimed = await claimTaskForRun(db, taskId, ['queued', 'approved']);
  if (!claimed) return getTask(db, taskId);
  return executeClaimedTask(db, taskId, audit, opts);
}

/**
 * Runs a task whose `running` claim this caller already holds. Policy (permission
 * re-check, kill switch, supervisor boundary, refusal handling, retry) lives here
 * and is unchanged; only the claim moved out to {@link claimTaskForRun}.
 */
async function executeClaimedTask(
  db: DB,
  taskId: string,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
  opts: { timeoutMs?: number } = {},
): Promise<ResolvedAgentTask> {
  const current = await getTask(db, taskId);
  if (TERMINAL.includes(current.status)) return current;

  const agent = await getAgentDef(db, current.agentKey);

  // The supervisor is a deterministic guardrail, not a model-driven executor, so
  // it is dispatched directly here and never queued as ordinary agent work. The
  // kill switch is honoured *before* this branch so a PAUSED/DISABLED supervisor
  // cannot keep running through its dedicated path.
  if (agent.key === SUPERVISOR_KEY) {
    const stopped = await blockIfAgentStopped(db, taskId, current.agentKey, audit);
    if (stopped) return stopped;
    return runSupervisorTask(db, taskId, audit);
  }

  // Permission re-check at execution time. A task may have been created earlier
  // (or by the Copilot/scheduler) under a permission that has since been revoked,
  // or the requester's roles may have changed. For a real user the current roles
  // are re-resolved from the database — never trusted from the stored task — and
  // both the agent capability and the data-access scope are re-enforced before
  // any execution. Only a task the trusted scheduler enqueued (the named
  // `system` principal *and* the `schedule:` provenance marker) runs with the
  // scheduler's own roles; anything else that merely claims `system` is resolved
  // like an ordinary user, finds no roles, and is refused. That trust anchor is
  // explicit here rather than inferred from a free-form user id.
  const trustedScheduler = current.requestedBy === SYSTEM_PRINCIPAL && isTrustedSchedulerTask(current.triggeredBy);
  const requesterRoles: UserRole[] = trustedScheduler
    ? trustedPrincipalRoles()
    : await resolveUserRoles(db, current.requestedBy);
  try {
    await assertAgentAllowed(requesterRoles, agent);
    await assertAgentScope(db, requesterRoles, agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'permission denied';
    const blocked = await db
      .update(agentTasks)
      .set({ status: 'blocked', error: { message: `permission revoked: ${message}` } as never, errorAt: new Date() })
      .where(runningClaimGuard(taskId))
      .returning({ id: agentTasks.id });
    if (blocked.length === 0) return getTask(db, taskId);
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_BLOCKED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { reason: 'permission revoked', detail: message },
    });
    return getTask(db, taskId);
  }

  // Loop guard: a paused/disabled agent or an engaged kill switch blocks the run.
  const stopped = await blockIfAgentStopped(db, taskId, current.agentKey, audit);
  if (stopped) return stopped;

  // Boundary guard (supervisor): never start work for an agent that is already
  // breaching its failure ceiling — contain it instead of retrying into a loop.
  try {
    const unhealthy = await unhealthyAgentKeys(db, DEFAULT_SUPERVISOR_LIMITS);
    if (unhealthy.has(agent.key)) {
      const blocked = await db
        .update(agentTasks)
        .set({ status: 'blocked', error: { message: `supervisor: agent ${agent.key} flagged unhealthy (failure rate over limit)` } as never, errorAt: new Date() })
        .where(runningClaimGuard(taskId))
        .returning({ id: agentTasks.id });
      if (blocked.length === 0) return getTask(db, taskId);
      await writeAudit(db, audit, {
        action: 'AI.SUPERVISOR_BLOCKED',
        entityType: 'AGENT_TASK',
        entityId: taskId,
        metadata: { agentKey: agent.key, reason: 'unhealthy agent' },
      });
      return getTask(db, taskId);
    }
  } catch (err) {
    logger.error('supervisor boundary check failed (continuing)', { error: (err as Error).message });
  }

  const attempts = current.attempts + 1;
  const started = Date.now();
  // The `running` status is already held by this caller's claim; only record the
  // attempt and the real execution start time here. Guarded so a run the watchdog
  // has already failed cannot have its attempt count rewritten.
  const recording = await db
    .update(agentTasks)
    .set({ attempts, startedAt: new Date() })
    .where(runningClaimGuard(taskId))
    .returning({ id: agentTasks.id });
  if (recording.length === 0) return getTask(db, taskId);

  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    const advice = await Promise.race([
      executeAgentTask(db, agent, { ...current.input, __userId: current.requestedBy }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const result = { agentKey: agent.key, advice: advice.content, readOnly: true };
    const latencyMs = Date.now() - started;
    const refusal = detectRefusal(advice.content);
    if (refusal) {
      // The executor declined to act — most often because no data scope could be
      // established (NO_SCOPE). Recording this as `succeeded` would make a dead
      // schedule look healthy and hide the failure from operators, so it is
      // persisted as a failure with a clear reason and raised as a warning.
      const message = refusal.message || `agent refused to run (${refusal.code})`;
      const recorded = await db
        .update(agentTasks)
        .set({
          status: 'failed',
          result: result as never,
          error: { message, code: refusal.code, refused: true } as never,
          errorAt: new Date(),
          tokensInput: advice.tokensInput,
          tokensOutput: advice.tokensOutput,
          model: 'local-heuristic',
          completedAt: new Date(),
          latencyMs,
        })
        .where(runningClaimGuard(taskId))
        .returning({ id: agentTasks.id });
      // The watchdog failed the task first: keep its terminal state, skip the audit.
      if (recorded.length === 0) return getTask(db, taskId);
      await writeAudit(db, audit, {
        action: 'AI.AGENT_TASK_REFUSED',
        entityType: 'AGENT_TASK',
        entityId: taskId,
        after: result as never,
        metadata: { code: refusal.code, message, latencyMs, agentKey: agent.key, requestedBy: current.requestedBy },
      });
      logger.warn('agent task refused — not counted as success', {
        agentKey: agent.key,
        taskId,
        code: refusal.code,
        message,
      });
      return getTask(db, taskId);
    }
    const recorded = await db
      .update(agentTasks)
      .set({
        status: 'succeeded',
        result: result as never,
        tokensInput: advice.tokensInput,
        tokensOutput: advice.tokensOutput,
        model: 'local-heuristic',
        completedAt: new Date(),
        latencyMs,
      })
      .where(runningClaimGuard(taskId))
      .returning({ id: agentTasks.id });
    // The watchdog failed the task first: keep its terminal state, skip the audit.
    if (recorded.length === 0) return getTask(db, taskId);
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_SUCCEEDED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      after: result as never,
      metadata: { latencyMs, attempts },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const willRetry = attempts < current.maxAttempts;
    const backoffMs = Math.min(2 ** attempts * 1000, 60_000);
    const recorded = await db
      .update(agentTasks)
      .set({
        status: willRetry ? 'queued' : 'failed',
        error: { message, attempts } as never,
        errorAt: willRetry ? null : new Date(),
        scheduledFor: willRetry ? new Date(Date.now() + backoffMs) : null,
        latencyMs: Date.now() - started,
      })
      .where(runningClaimGuard(taskId))
      .returning({ id: agentTasks.id });
    // The watchdog failed the task first: do not reschedule it or record a
    // contradictory outcome — the timeout stands.
    if (recorded.length === 0) return getTask(db, taskId);
    await writeAudit(db, audit, {
      action: willRetry ? 'AI.AGENT_TASK_RETRY_SCHEDULED' : 'AI.AGENT_TASK_FAILED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { error: message, attempt: attempts, backoffMs: willRetry ? backoffMs : 0 },
    });
    if (!willRetry) {
      // Escalate a permanently failed task to the manager (Super Admin).
      logger.warn('agent task failed permanently', { agentKey: agent.key, taskId, error: message });
    }
  }
  return getTask(db, taskId);
}

/**
 * Approves (or rejects) a task awaiting approval and runs it when approved.
 * Only a task that is still `awaiting_approval` may be decided.
 */
export async function decideAgentTask(
  db: DB,
  taskId: string,
  approverId: string,
  decision: 'APPROVE' | 'REJECT',
  reason: string | null,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const task = await getTask(db, taskId);
  if (task.status !== 'awaiting_approval') {
    throw ApiError.conflict('Task is not awaiting approval');
  }

  if (decision === 'REJECT') {
    await db
      .update(agentTasks)
      .set({ status: 'rejected', approvedBy: approverId, approvedAt: new Date(), rejectionReason: reason })
      .where(eq(agentTasks.id, taskId));
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_REJECTED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { reason },
    });
    return getTask(db, taskId);
  }

  // Approval is recorded as its own transition. Execution is deliberately NOT
  // run here: granting approval must not imply the task succeeded. The approved
  // task is dispatched by the scheduler (`executeDueTasks`), which records the
  // real outcome as `succeeded`/`failed`/`blocked`.
  await db
    .update(agentTasks)
    .set({ status: 'approved', approvedBy: approverId, approvedAt: new Date() })
    .where(eq(agentTasks.id, taskId));
  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_APPROVED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { reason, approvalAction: task.approvalAction },
  });

  return getTask(db, taskId);
}

/**
 * Runs a single task that has already been approved, on demand.
 *
 * Approval alone never executes a task (see {@link decideAgentTask}); the
 * scheduler dispatches approved tasks on its interval. This is the explicit,
 * operator-driven counterpart: an `AI_MANAGE` holder triggers one approved task
 * without waiting for a scheduler tick or enabling the scheduler globally.
 *
 * Only an `approved` task may be run — never `awaiting_approval` (not yet
 * approved), `queued` (the scheduler's to run), `running` (already claimed), or
 * a terminal one. The claim reuses {@link claimTaskForRun}, the same atomic
 * transition the scheduler path uses, so a manual run and a scheduler tick
 * racing for the same task cannot both execute it: exactly one claims the row
 * and the other is rejected with a 409.
 *
 * Execution itself is delegated to {@link executeClaimedTask} under the claim
 * already taken here, so the kill switch, the execution-time permission/scope
 * re-check, the supervisor boundary guard, the retry/backoff policy, and every
 * `AI.AGENT_TASK_*` audit entry stay in one place — this is a trigger, not a
 * second executor.
 */
export async function runApprovedTask(
  db: DB,
  taskId: string,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const task = await getTask(db, taskId);
  if (task.status !== 'approved') {
    throw ApiError.conflict('Task is not approved for execution');
  }

  // Single-flight claim: the transition out of `approved` is the lock. A second
  // caller (or a scheduler tick that grabbed the row first) matches zero rows and
  // is rejected instead of running the task a second time.
  const claimed = await claimTaskForRun(db, taskId, ['approved']);
  if (!claimed) {
    throw ApiError.conflict('Task is already running or no longer approved');
  }

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_RUN_REQUESTED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { agentKey: task.agentKey, approvedBy: task.approvedBy },
  });

  return executeClaimedTask(db, taskId, audit);
}

/**
 * Runs every due queued/approved task in priority order. Used by the scheduler
 * and the Copilot so periodic agent work happens inside the existing job loop.
 *
 * Each due task is claimed with the shared {@link claimTaskForRun} transition
 * before it runs, so a task a concurrent scheduler tick — or an on-demand admin
 * run — already picked up is skipped instead of executed twice. Only tasks this
 * call actually claims are counted.
 */
export async function executeDueTasks(
  db: DB,
  limit = 25,
  audit: { actorId: string } = { actorId: 'scheduler' },
): Promise<{ ran: number; failed: number }> {
  const due = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        inArray(agentTasks.status, ['queued', 'approved']),
        or(isNull(agentTasks.scheduledFor), lt(agentTasks.scheduledFor, new Date())),
      ),
    )
    .orderBy(asc(agentTasks.priority), asc(agentTasks.createdAt))
    .limit(limit);
  let ran = 0;
  let failed = 0;
  for (const t of due) {
    const claimed = await claimTaskForRun(db, t.id, ['queued', 'approved']);
    if (!claimed) continue; // already claimed by a concurrent path
    const out = await executeClaimedTask(db, t.id, audit);
    ran += 1;
    if (out.status === 'failed') failed += 1;
  }
  return { ran, failed };
}

/**
 * Watchdog: fails tasks stuck in `running` beyond the timeout so a crashed run
 * cannot hold a dedupe key forever. Idempotent and safe to call on every tick.
 */
export async function reapStaleTasks(db: DB, timeoutSeconds = 300): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const stale = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.status, 'running'), lt(agentTasks.startedAt, cutoff)));
  if (stale.length === 0) return 0;
  await db
    .update(agentTasks)
    .set({ status: 'failed', error: { message: `timeout: running longer than ${timeoutSeconds}s` } as never, errorAt: new Date() })
    .where(inArray(agentTasks.id, stale.map((s) => s.id)));
  await writeAudit(db, { actorId: 'scheduler' }, {
    action: 'AI.AGENT_TASK_TIMEOUT',
    entityType: 'AGENT_TASK',
    metadata: { count: stale.length },
  });
  return stale.length;
}

/** Operator lifecycle control: pause / resume / disable an agent (kill switch). */
export async function setAgentStatus(
  db: DB,
  agentKey: string,
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED',
  reason: string | null,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  const registry = await getRegistryAgent(db, agentKey);
  await db
    .update(agentRegistry)
    .set({ status, isActive: status === 'ACTIVE' })
    .where(eq(agentRegistry.key, agentKey));
  await writeAudit(db, audit, {
    action: 'AI.AGENT_STATUS_CHANGED',
    entityType: 'AGENT_REGISTRY',
    entityId: registry.id,
    before: { status: registry.status, isActive: registry.isActive } as never,
    after: { status } as never,
    metadata: { agentKey, reason },
  });
}

/** Aggregate counts for the admin agents desk. */
export async function agentTaskSummary(db: DB) {
  const rows = await db
    .select({ status: agentTasks.status, count: sql<number>`count(*)::int` })
    .from(agentTasks)
    .groupBy(agentTasks.status);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = Number(r.count);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, byStatus };
}
