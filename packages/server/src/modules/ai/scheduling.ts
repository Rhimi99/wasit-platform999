import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentSchedules } from '../../db/schema/agent_schedules';
import { agentRegistry } from '../../db/schema/agents';
import { roles as rolesTable, userRoles } from '../../db/schema/auth';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { env } from '../../lib/env';
import { logger } from '../../lib/observability/logger';
import { isBudgetExhausted } from '../../lib/ai/cost-control';
import { createAgentTask, ensureAgentRegistrySeeded } from './agents.js';

/**
 * Safe floor for a schedule cadence. A shorter interval would let an operator
 * (or a bad migration) turn a periodic agent into a resource drain, so creation
 * and update both reject anything below the configured minimum. Defaults to 15
 * minutes; operators may raise it via `AI_AGENT_SCHEDULE_MIN_INTERVAL_MINUTES`.
 */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

function minIntervalMinutes(): number {
  return Math.max(env.AI_AGENT_SCHEDULE_MIN_INTERVAL_MINUTES, 1);
}

/** Default lease length. Long enough to cover a task run, short enough to recover. */
export const DEFAULT_LEASE_SECONDS = 300;

export const agentScheduleInputSchema = z.object({
  agentKey: z.string().min(1).max(64),
  input: z.record(z.unknown()).default({}),
  intervalMinutes: z.number().int().positive(),
  isActive: z.boolean().default(true),
});

export type AgentScheduleInput = z.infer<typeof agentScheduleInputSchema>;

export interface AgentScheduleRow {
  id: string;
  agentKey: string;
  input: Record<string, unknown>;
  intervalMinutes: number;
  isActive: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastTaskId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunDueResult {
  claimed: number;
  created: number;
  skippedApproval: number;
  budgetBlocked: number;
  failed: number;
}

/**
 * Roles of a user, read from RBAC. Used to decide whether a scheduled agent's
 * capability is within its creator's authority at run time.
 */
async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: rolesTable.name })
    .from(userRoles)
    .innerJoin(rolesTable, eq(userRoles.roleId, rolesTable.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

/** True when at least one of the user's roles carries the permission. */
function hasPermission(userRolesList: UserRole[], permission: string): boolean {
  return userRolesList.some((r) => ROLE_PERMISSIONS[r]?.has(permission as never));
}

function isValidInterval(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= minIntervalMinutes();
}

/**
 * Creates a schedule for an agent. Fail-closed rules (AI-01):
 * - The agent must be registered and active.
 * - Agents that require human approval are refused: a schedule must never be
 *   treated as pre-approval of a sensitive action.
 * - The creator must hold every permission the agent requires.
 * - The interval must be a safe integer >= MIN_SCHEDULE_INTERVAL_MINUTES.
 */
export async function createAgentSchedule(
  db: DB,
  createdBy: string,
  input: AgentScheduleInput,
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<AgentScheduleRow> {
  if (!isValidInterval(input.intervalMinutes)) {
    throw ApiError.validation([
      { field: 'intervalMinutes', message: `Must be an integer >= ${minIntervalMinutes()}`, code: 'TOO_SMALL' },
    ]);
  }

  // Make sure the catalogue exists so a schedule can only target a real agent.
  await ensureAgentRegistrySeeded(db);

  const reg = await db
    .select()
    .from(agentRegistry)
    .where(and(eq(agentRegistry.key, input.agentKey), eq(agentRegistry.isActive, true)))
    .limit(1);
  if (reg.length === 0) throw ApiError.notFound('Agent');

  const agent = reg[0];
  if (agent.requiresHumanApproval) {
    throw ApiError.conflict(
      'This agent requires human approval and cannot be scheduled for automatic execution',
    );
  }

  const creatorRoles = await rolesOf(db, createdBy);
  const required = (agent.permissionsRequired ?? []) as string[];
  const missing = required.filter((p) => !hasPermission(creatorRoles, p));
  if (missing.length > 0) {
    throw ApiError.forbidden(`Your role does not cover the agent's permissions: ${missing.join(', ')}`);
  }

  const now = new Date();
  const id = newId();
  await db.insert(agentSchedules).values({
    id,
    agentKey: agent.key,
    input: input.input as never,
    intervalMinutes: input.intervalMinutes,
    isActive: input.isActive,
    nextRunAt: new Date(now.getTime() + input.intervalMinutes * 60_000),
    createdBy,
  });

  await writeAudit(
    db,
    { actorId: createdBy, actorType: 'USER', ipAddress: audit.ipAddress, userAgent: audit.userAgent },
    {
      action: 'AI.AGENT_SCHEDULE_CREATED',
      entityType: 'AGENT_SCHEDULE',
      entityId: id,
      after: { agentKey: agent.key, intervalMinutes: input.intervalMinutes, isActive: input.isActive },
      metadata: { agentKey: agent.key, createdBy },
    },
  );

  return (await getAgentSchedule(db, id))!;
}

export async function getAgentSchedule(db: DB, id: string): Promise<AgentScheduleRow | null> {
  const rows = await db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).limit(1);
  return (rows[0] as AgentScheduleRow | undefined) ?? null;
}

export async function listAgentSchedules(db: DB): Promise<AgentScheduleRow[]> {
  return (await db.select().from(agentSchedules).orderBy(asc(agentSchedules.nextRunAt))) as AgentScheduleRow[];
}

/**
 * Updates an existing schedule. `agentKey` is immutable: changing which agent a
 * schedule targets is a different schedule, not an edit. Turning a schedule on
 * re-checks the agent is still schedulable, so a schedule created before an
 * agent was marked approval-gated cannot be re-enabled to bypass the gate.
 */
export async function updateAgentSchedule(
  db: DB,
  id: string,
  actorId: string,
  patch: { intervalMinutes?: number; isActive?: boolean; input?: Record<string, unknown> },
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<AgentScheduleRow> {
  const existing = await getAgentSchedule(db, id);
  if (!existing) throw ApiError.notFound('Agent schedule');

  if (patch.intervalMinutes !== undefined && !isValidInterval(patch.intervalMinutes)) {
    throw ApiError.validation([
      { field: 'intervalMinutes', message: `Must be an integer >= ${minIntervalMinutes()}`, code: 'TOO_SMALL' },
    ]);
  }

  if (patch.isActive === true && !existing.isActive) {
    await ensureAgentRegistrySeeded(db);
    const reg = await db
      .select()
      .from(agentRegistry)
      .where(and(eq(agentRegistry.key, existing.agentKey), eq(agentRegistry.isActive, true)))
      .limit(1);
    if (reg.length === 0) throw ApiError.notFound('Agent');
    if (reg[0].requiresHumanApproval) {
      throw ApiError.conflict('This agent requires human approval and cannot be scheduled for automatic execution');
    }
  }

  const now = new Date();
  const values: Record<string, unknown> = { updatedAt: now };
  if (patch.intervalMinutes !== undefined) values.intervalMinutes = patch.intervalMinutes;
  if (patch.input !== undefined) values.input = patch.input;
  if (patch.isActive !== undefined) {
    values.isActive = patch.isActive;
    // Re-enabling reschedules the next run rather than firing an overdue one.
    if (patch.isActive && patch.intervalMinutes === undefined) {
      values.nextRunAt = new Date(now.getTime() + existing.intervalMinutes * 60_000);
    }
  }
  if (patch.intervalMinutes !== undefined) {
    values.nextRunAt = new Date(now.getTime() + patch.intervalMinutes * 60_000);
  }

  await db.update(agentSchedules).set(values as never).where(eq(agentSchedules.id, id));

  await writeAudit(
    db,
    { actorId, actorType: 'USER', ipAddress: audit.ipAddress, userAgent: audit.userAgent },
    {
      action: patch.isActive === false ? 'AI.AGENT_SCHEDULE_DISABLED' : 'AI.AGENT_SCHEDULE_UPDATED',
      entityType: 'AGENT_SCHEDULE',
      entityId: id,
      before: { intervalMinutes: existing.intervalMinutes, isActive: existing.isActive },
      after: patch as never,
      metadata: { agentKey: existing.agentKey, createdBy: existing.createdBy },
    },
  );

  return (await getAgentSchedule(db, id))!;
}

/**
 * Atomically claims ONE due schedule for `workerId`, or returns null.
 *
 * The claim is a single UPDATE whose target row is chosen with
 * `FOR UPDATE SKIP LOCKED` in a subquery, so two workers running this at the
 * same instant never select the same row: one gets it, the other skips to the
 * next (or none). This is the cross-instance guarantee — an in-process lock
 * alone cannot provide it.
 *
 * Claiming advances `nextRunAt` and `lastRunAt` immediately (missed-run policy:
 * skip, never backfill an unbounded backlog). A claim is not success; it only
 * reserves the slot and is released either by expiry or by the next advance.
 */
export async function claimDueSchedule(
  db: DB,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<AgentScheduleRow | null> {
  const result = (await db.execute(sql`
    update ${agentSchedules}
    set
      lease_owner = ${workerId},
      lease_expires_at = now() + (${leaseSeconds}::int * interval '1 second'),
      last_run_at = now(),
      next_run_at = now() + (${agentSchedules.intervalMinutes} * interval '1 minute'),
      updated_at = now()
    where ${agentSchedules.id} = (
      select ${agentSchedules.id}
      from ${agentSchedules}
      where ${agentSchedules.isActive} = true
        and ${agentSchedules.nextRunAt} <= now()
        and (${agentSchedules.leaseExpiresAt} is null or ${agentSchedules.leaseExpiresAt} < now())
      order by ${agentSchedules.nextRunAt} asc
      limit 1
      for update skip locked
    )
    returning
      id, agent_key, input, interval_minutes, is_active, next_run_at, last_run_at,
      lease_owner, lease_expires_at, last_task_id, created_by, created_at, updated_at
  `)) as unknown as { rows: Record<string, unknown>[] };

  const row = result.rows?.[0];
  if (!row) return null;
  return {
    id: row.id as string,
    agentKey: row.agent_key as string,
    input: (row.input ?? {}) as Record<string, unknown>,
    intervalMinutes: Number(row.interval_minutes),
    isActive: Boolean(row.is_active),
    nextRunAt: new Date(row.next_run_at as string),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : null,
    leaseOwner: (row.lease_owner as string) ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string) : null,
    lastTaskId: (row.last_task_id as string) ?? null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/** Releases a claimed schedule's lease after a run (success or failure). */
async function releaseLease(db: DB, scheduleId: string, taskId: string | null): Promise<void> {
  await db
    .update(agentSchedules)
    .set({ leaseOwner: null, leaseExpiresAt: null, lastTaskId: taskId, updatedAt: new Date() })
    .where(eq(agentSchedules.id, scheduleId));
}

/**
 * Runs ONE claimed schedule through the existing agent pipeline.
 *
 * It does NOT create a parallel execution path: it delegates to
 * `createAgentTask`, which enforces RBAC, budget (via the runtime) and audit.
 * Fail-closed guards run first:
 * - the agent must still be registered and active;
 * - an approval-gated agent is skipped, never auto-run;
 * - the creator must still cover the agent's permissions.
 */
async function runClaimedSchedule(db: DB, schedule: AgentScheduleRow): Promise<{
  taskId: string | null;
  outcome: 'created' | 'skipped_approval' | 'skipped_unknown' | 'forbidden' | 'budget_blocked' | 'failed';
}> {
  const systemAudit = { actorId: null, actorType: 'SYSTEM' as const };
  await ensureAgentRegistrySeeded(db);
  const reg = await db
    .select()
    .from(agentRegistry)
    .where(and(eq(agentRegistry.key, schedule.agentKey), eq(agentRegistry.isActive, true)))
    .limit(1);

  if (reg.length === 0) {
    await writeAudit(db, systemAudit, {
      action: 'AI.AGENT_TASK_SKIPPED_UNKNOWN_AGENT',
      entityType: 'AGENT_SCHEDULE',
      entityId: schedule.id,
      metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, reason: 'agent_not_registered_or_inactive' },
    });
    return { taskId: null, outcome: 'skipped_unknown' };
  }

  const agent = reg[0];
  if (agent.requiresHumanApproval) {
    await writeAudit(db, systemAudit, {
      action: 'AI.AGENT_TASK_SKIPPED_APPROVAL_REQUIRED',
      entityType: 'AGENT_SCHEDULE',
      entityId: schedule.id,
      metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, reason: 'requires_human_approval' },
    });
    return { taskId: null, outcome: 'skipped_approval' };
  }

  const creatorRoles = await rolesOf(db, schedule.createdBy);
  const required = (agent.permissionsRequired ?? []) as string[];
  const missing = required.filter((p) => !hasPermission(creatorRoles, p));
  if (missing.length > 0) {
    await writeAudit(db, systemAudit, {
      action: 'AI.AGENT_TASK_SKIPPED_FORBIDDEN',
      entityType: 'AGENT_SCHEDULE',
      entityId: schedule.id,
      metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, missing },
    });
    return { taskId: null, outcome: 'forbidden' };
  }

  // Budget pre-flight: refuse BEFORE creating the task (and before any provider
  // call). The runtime re-checks per call; this gate makes the refusal explicit
  // and auditable, and guarantees no paid call happens once the budget is spent.
  const budget = await isBudgetExhausted(db, schedule.createdBy, creatorRoles, 'MONTHLY', env.AI_BUDGET_MONTHLY_USD);
  if (budget.exhausted) {
    await writeAudit(db, systemAudit, {
      action: 'AI.AGENT_TASK_BUDGET_EXCEEDED',
      entityType: 'AGENT_SCHEDULE',
      entityId: schedule.id,
      metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, reason: budget.reason ?? 'budget' },
    });
    return { taskId: null, outcome: 'budget_blocked' };
  }

  // The task is attributed to its creator (accountability) while the audit
  // trail marks the *execution* as SYSTEM. No fake admin identity is minted.
  const task = await createAgentTask(
    db,
    creatorRoles,
    schedule.createdBy,
    { agentKey: schedule.agentKey, requestedBy: schedule.createdBy, input: schedule.input },
    systemAudit,
  );

  await writeAudit(db, systemAudit, {
    action: 'AI.AGENT_TASK_SCHEDULED',
    entityType: 'AGENT_TASK',
    entityId: task.id,
    metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, createdBy: schedule.createdBy },
  });

  return { taskId: task.id, outcome: 'created' };
}

/**
 * Processes due schedules: claims and runs them one at a time until none remain.
 *
 * A failure inside one schedule is caught and audited so it can never take down
 * the whole sweep (or the scheduler's other jobs). `maxPerSweep` bounds a single
 * call so a large backlog cannot monopolise the event loop.
 */
export async function runDueAgentSchedules(
  db: DB,
  workerId: string,
  options: { leaseSeconds?: number; maxPerSweep?: number } = {},
): Promise<RunDueResult> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const maxPerSweep = options.maxPerSweep ?? 25;
  const result: RunDueResult = { claimed: 0, created: 0, skippedApproval: 0, budgetBlocked: 0, failed: 0 };

  for (let i = 0; i < maxPerSweep; i++) {
    const schedule = await claimDueSchedule(db, workerId, leaseSeconds);
    if (!schedule) break;
    result.claimed += 1;

    try {
      const run = await runClaimedSchedule(db, schedule);
      if (run.outcome === 'created') result.created += 1;
      else if (run.outcome === 'skipped_approval') result.skippedApproval += 1;
      else if (run.outcome === 'budget_blocked') result.budgetBlocked += 1;
      await releaseLease(db, schedule.id, run.taskId);
    } catch (err) {
      // Budget exhaustion is expected and actionable, not a crash: audit it and
      // keep the sweep going. Any other error is recorded as a failed run.
      const status = (err as { statusCode?: number }).statusCode;
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (status === 429) {
        result.budgetBlocked += 1;
        await writeAudit(db, { actorId: null, actorType: 'SYSTEM' }, {
          action: 'AI.AGENT_TASK_BUDGET_EXCEEDED',
          entityType: 'AGENT_SCHEDULE',
          entityId: schedule.id,
          metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, reason: message },
        });
      } else {
        result.failed += 1;
        await writeAudit(db, { actorId: null, actorType: 'SYSTEM' }, {
          action: 'AI.AGENT_TASK_FAILED',
          entityType: 'AGENT_SCHEDULE',
          entityId: schedule.id,
          metadata: { agentKey: schedule.agentKey, scheduleId: schedule.id, reason: message },
        });
      }
      logger.error('scheduled agent run failed', { scheduleId: schedule.id, agentKey: schedule.agentKey, status });
      await releaseLease(db, schedule.id, null);
    }
  }

  return result;
}

/** Deletes a schedule (hard delete) and audits it. */
export async function deleteAgentSchedule(
  db: DB,
  id: string,
  actorId: string,
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  const existing = await getAgentSchedule(db, id);
  if (!existing) throw ApiError.notFound('Agent schedule');
  await db.delete(agentSchedules).where(eq(agentSchedules.id, id));
  await writeAudit(
    db,
    { actorId, actorType: 'USER', ipAddress: audit.ipAddress, userAgent: audit.userAgent },
    {
      action: 'AI.AGENT_SCHEDULE_DISABLED',
      entityType: 'AGENT_SCHEDULE',
      entityId: id,
      before: { agentKey: existing.agentKey, isActive: existing.isActive },
      metadata: { agentKey: existing.agentKey, createdBy: existing.createdBy, deleted: true },
    },
  );
}

/** Reclaims schedules whose lease expired (crashed worker) so they run again. */
export async function reclaimExpiredLeases(db: DB): Promise<number> {
  const res = (await db.execute(sql`
    update ${agentSchedules}
    set lease_owner = null, lease_expires_at = null, updated_at = now()
    where ${agentSchedules.leaseExpiresAt} is not null and ${agentSchedules.leaseExpiresAt} < now()
  `)) as unknown as { rowCount?: number };
  return res.rowCount ?? 0;
}

// Re-exported for callers that build queries on the table.
export { agentSchedules };
