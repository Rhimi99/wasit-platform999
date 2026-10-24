import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentSchedules, agentTasks } from '../../db/schema/agents';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/observability/logger';
import { COPILOT_KEY, findAgentSpec } from './catalogue.js';
import { createAgentTask, getRegistryAgent, syncAgentRegistry, SUPERVISOR_KEY } from './runner.js';
import { DEFAULT_SUPERVISOR_LIMITS } from './supervisor-policy.js';

/**
 * WASIT AI Copilot — the central coordination layer.
 *
 * The Copilot receives events, delegates them to the specialised agents and
 * aggregates results. It is deliberately NOT counted among the 20 agents and it
 * never executes a specialised agent's work itself: it only routes, so every
 * delegated task still passes the same RBAC, approval and audit gates.
 */

export interface Delegation {
  event: string;
  agentKey: string;
  taskType: string;
  payload: Record<string, unknown>;
}

/**
 * Deterministic event → agent routing table. Each platform event maps to the
 * agent that owns it, so routing is auditable and cannot be hijacked by an LLM.
 */
export const EVENT_ROUTING: Record<string, Delegation> = {
  'order.placed': { event: 'order.placed', agentKey: 'operations-agent', taskType: 'operations.health_check', payload: {} },
  'order.paid': { event: 'order.paid', agentKey: 'payment-settlement-agent', taskType: 'payment.monitor_settlement', payload: {} },
  'payment.failed': { event: 'payment.failed', agentKey: 'payment-settlement-agent', taskType: 'payment.monitor_settlement', payload: {} },
  'dispute.opened': { event: 'dispute.opened', agentKey: 'dispute-assistant', taskType: 'dispute.summarize', payload: {} },
  'risk.flagged': { event: 'risk.flagged', agentKey: 'risk-agent', taskType: 'risk.scan', payload: {} },
  'entity.registered': { event: 'entity.registered', agentKey: 'compliance-agent', taskType: 'compliance.check', payload: {} },
  'lead.created': { event: 'lead.created', agentKey: 'sales-agent', taskType: 'sales.qualify_lead', payload: {} },
  'catalog.audit': { event: 'catalog.audit', agentKey: 'product-agent', taskType: 'product.audit_catalog', payload: {} },
};

/** Maximum number of agents one event may fan out to (loop / blast-radius cap). */
export const MAX_FANOUT = 10;

export interface CopilotRunResult {
  correlationId: string;
  routed: { event: string; agentKey: string; taskId: string; status: string }[];
  skipped: { event: string; reason: string }[];
}

/**
 * Routes one or more events to their owning agents.
 *
 * Fan-out is capped and every delegation is de-duplicated per (event, agent)
 * within the run, so a burst of identical events cannot create a task storm.
 */
export async function routeEvents(
  db: DB,
  events: { event: string; payload?: Record<string, unknown> }[],
  requestedBy: string,
  role: UserRole[],
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CopilotRunResult> {
  await syncAgentRegistry(db);
  const correlationId = newId();
  const routed: CopilotRunResult['routed'] = [];
  const skipped: CopilotRunResult['skipped'] = [];
  const seen = new Set<string>();

  const capped = events.slice(0, MAX_FANOUT);
  for (const e of events.slice(MAX_FANOUT)) {
    skipped.push({ event: e.event, reason: `fan-out cap reached (${MAX_FANOUT})` });
  }

  for (const e of capped) {
    const route = EVENT_ROUTING[e.event];
    if (!route) {
      skipped.push({ event: e.event, reason: 'no route for event' });
      continue;
    }
    const dedupe = `${e.event}:${route.agentKey}`;
    if (seen.has(dedupe)) {
      skipped.push({ event: e.event, reason: 'duplicate event in batch' });
      continue;
    }
    seen.add(dedupe);

    // The target agent must be runnable; a paused/disabled agent is skipped
    // rather than run, so an operator kill switch is respected end-to-end.
    const registry = await getRegistryAgent(db, route.agentKey);
    if (registry.status !== 'ACTIVE') {
      skipped.push({ event: e.event, reason: `agent ${route.agentKey} is ${registry.status}` });
      continue;
    }

    try {
      const task = await createAgentTask(
        db,
        // The caller's real roles (never a forged system role): the Copilot must
        // not be a privilege-escalation path. Each delegated agent is checked
        // against `permissionsRequired`, so a caller lacking a target agent's
        // permission gets `skipped` and no task is created. The deterministic
        // EVENT_ROUTING table bounds *which* agents an event may reach; RBAC
        // bounds *whether the caller* may use them.
        role,
        requestedBy,
        {
          agentKey: route.agentKey,
          taskType: route.taskType,
          input: { ...route.payload, ...(e.payload ?? {}) },
          correlationId,
          triggeredBy: `copilot:${e.event}`,
          dedupeKey: `copilot:${correlationId}:${dedupe}`,
        },
        audit,
      );
      routed.push({ event: e.event, agentKey: route.agentKey, taskId: task.id, status: task.status });
    } catch (err) {
      skipped.push({ event: e.event, reason: err instanceof Error ? err.message : 'delegation failed' });
    }
  }

  await writeAudit(db, audit, {
    action: 'AI.COPILOT_ROUTED',
    entityType: 'AGENT_TASK',
    entityId: correlationId,
    metadata: { routed: routed.length, skipped: skipped.length },
  });

  return { correlationId, routed, skipped };
}

/** Aggregates the tasks a Copilot run spawned into a human-readable summary. */
export async function summarizeRun(db: DB, correlationId: string) {
  const tasks = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.correlationId, correlationId))
    .orderBy(asc(agentTasks.createdAt));
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return {
    correlationId,
    total: tasks.length,
    byStatus,
    tasks: tasks.map((t) => ({
      id: t.id,
      agentKey: t.agentKey,
      taskType: t.taskType,
      status: t.status,
      requiresApproval: t.requiresApproval,
      approvalAction: t.approvalAction,
    })),
    needsHumanAction: tasks.filter((t) => t.status === 'awaiting_approval' || t.status === 'failed').length,
  };
}

// ---------------------------------------------------------------- schedules

/**
 * Declarative periodic schedules. Registered idempotently into
 * `agent_schedules`; the existing in-process scheduler dispatches due rows so
 * no separate cron/worker process is needed.
 */
export const DEFAULT_SCHEDULES: { agentKey: string; taskType: string; intervalSeconds: number; payload?: Record<string, unknown> }[] = [
  { agentKey: 'agent-supervisor', taskType: 'supervisor.observe', intervalSeconds: 1800 },
  { agentKey: 'outreach-acquisition-agent', taskType: 'outreach.run_cycle', intervalSeconds: 86400 },
  { agentKey: 'operations-agent', taskType: 'operations.health_check', intervalSeconds: 3600 },
  { agentKey: 'payment-settlement-agent', taskType: 'payment.monitor_settlement', intervalSeconds: 3600 },
  { agentKey: 'analytics-agent', taskType: 'analytics.report', intervalSeconds: 86400 },
];

export async function ensureSchedules(db: DB): Promise<number> {
  await syncAgentRegistry(db);
  let created = 0;
  for (const s of DEFAULT_SCHEDULES) {
    const existing = await db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.agentKey, s.agentKey), eq(agentSchedules.taskType, s.taskType)))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(agentSchedules).values({
      id: newId(),
      agentKey: s.agentKey,
      taskType: s.taskType,
      intervalSeconds: s.intervalSeconds,
      payload: (s.payload ?? {}) as never,
      enabled: true,
      nextRunAt: new Date(),
    });
    created += 1;
  }
  return created;
}

export async function listSchedules(db: DB) {
  await ensureSchedules(db);
  return db.select().from(agentSchedules).orderBy(asc(agentSchedules.agentKey));
}

export async function setScheduleEnabled(db: DB, scheduleId: string, enabled: boolean, audit: { actorId: string }): Promise<void> {
  const rows = await db.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Schedule');
  await db.update(agentSchedules).set({ enabled }).where(eq(agentSchedules.id, scheduleId));
  await writeAudit(db, audit, {
    action: 'AI.AGENT_SCHEDULE_TOGGLED',
    entityType: 'AGENT_SCHEDULE',
    entityId: scheduleId,
    after: { enabled } as never,
  });
}

/**
 * Dispatches every due schedule once. Idempotent: `nextRunAt` is advanced inside
 * the same statement that claims the row, so two scheduler instances cannot run
 * the same window twice.
 */
export async function dispatchDueSchedules(
  db: DB,
  audit: { actorId: string } = { actorId: 'scheduler' },
): Promise<{ dispatched: number }> {
  await ensureSchedules(db);
  const now = new Date();
  const due = await db
    .select()
    .from(agentSchedules)
    .where(and(eq(agentSchedules.enabled, true), or(isNull(agentSchedules.nextRunAt), lt(agentSchedules.nextRunAt, now))));
  let dispatched = 0;
  for (const s of due) {
    const registry = await getRegistryAgent(db, s.agentKey);
    if (registry.status !== 'ACTIVE') continue;
    try {
      const task = await createAgentTask(
        db,
        ['SUPER_ADMIN'],
        'system',
        {
          agentKey: s.agentKey,
          taskType: s.taskType,
          input: (s.payload ?? {}) as Record<string, unknown>,
          triggeredBy: `schedule:${s.id}`,
          dedupeKey: `schedule:${s.id}:${Math.floor(now.getTime() / (s.intervalSeconds * 1000))}`,
        },
        audit,
      );
      await db
        .update(agentSchedules)
        .set({ lastRunAt: now, nextRunAt: new Date(now.getTime() + s.intervalSeconds * 1000), lastTaskId: task.id })
        .where(eq(agentSchedules.id, s.id));
      dispatched += 1;
    } catch (err) {
      logger.error('agent schedule dispatch failed', { scheduleId: s.id, error: (err as Error).message });
    }
  }
  return { dispatched };
}

/** Copilot spec lookup (used by the admin desk to render the coordinator row). */
export function copilotSpec() {
  return findAgentSpec(COPILOT_KEY);
}

/** Count of open tasks awaiting a human decision — the manager's action queue. */
export async function pendingApprovalsCount(db: DB): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(eq(agentTasks.status, 'awaiting_approval'));
  return Number(rows[0]?.v ?? 0);
}

/** Recent tasks across all agents, for the admin oversight table. */
export async function listRecentTasks(db: DB, limit = 50) {
  return db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(limit);
}
