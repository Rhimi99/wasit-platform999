import { eq, gt, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { agentRegistry, agentTasks } from '../../db/schema/agents';
import { roles, userRoles } from '../../db/schema/auth';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service';
import { logger } from '../../lib/observability/logger';
import {
  DEFAULT_SUPERVISOR_LIMITS,
  recommendIntervention,
  type SupervisorAssessment,
  type SupervisorLimits,
} from './supervisor-policy.js';

export { DEFAULT_SUPERVISOR_LIMITS };
export type { SupervisorLimits };

/**
 * WASIT Agent Supervisor — the twentieth specialised agent and the platform's
 * deterministic oversight mechanism.
 *
 * Unlike every other agent, the Supervisor is NOT driven by the model: it runs
 * as a pure function of the task/agent state and can only *contain* problems,
 * never expand a capability. It cannot approve anything, cannot lift an approval
 * gate, cannot change the catalogue and cannot grant itself or any agent extra
 * permissions. Its only powers are:
 *   - observe   → recompute task/agent health into a report,
 *   - contain   → fail/block a task that breached a configured limit,
 *   - alert     → hand an escalation to the caller for human delivery.
 *
 * Because containment is persisted in the database (status → `failed`/`blocked`)
 * and every due task is re-checked before it runs, the guardrails hold even if
 * the Copilot, the scheduler or an LLM provider is down.
 */

/** A supervisor alarm, ready for delivery by the caller (audit + notification). */
export interface SupervisorAlert {
  agentKey: string;
  taskId: string | null;
  severity: 'WARNING' | 'CRITICAL';
  reason: string;
  action: string;
}

export interface SupervisorReport {
  generatedAt: string;
  limits: SupervisorLimits;
  counts: Record<string, number>;
  total: number;
  loopDetected: boolean;
  runawayDetected: boolean;
  stuckTasks: number;
  expiredQueued: number;
  failureRateFlagged: boolean;
  interventions: { taskId: string; agentKey: string; reason: string; action: string }[];
  alerts: SupervisorAlert[];
}

/** Pure assessment of a single task against the configured limits. */
export function assessTask(
  task: {
    id: string;
    agentKey: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    cost: string | null;
    startedAt: Date | null;
    createdAt: Date;
  },
  limits: SupervisorLimits,
  now: Date,
): SupervisorAssessment {
  return recommendIntervention(
    {
      status: task.status,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      cost: Number(task.cost ?? '0') || 0,
      startedAtMs: task.startedAt ? task.startedAt.getTime() : null,
      createdAtMs: task.createdAt.getTime(),
    },
    limits,
    now.getTime(),
  );
}

/**
 * Recomputes the whole agent layer's health and applies deterministic
 * containment. Idempotent: a task that has already been contained is terminal,
 * so a second call re-reports but never re-mutates.
 */
export async function supervise(db: DB, limits: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS): Promise<SupervisorReport> {
  const now = new Date();
  const rows = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      status: agentTasks.status,
      attempts: agentTasks.attempts,
      maxAttempts: agentTasks.maxAttempts,
      cost: agentTasks.cost,
      startedAt: agentTasks.startedAt,
      createdAt: agentTasks.createdAt,
    })
    .from(agentTasks);

  const counts: Record<string, number> = {};
  const interventions: SupervisorReport['interventions'] = [];
  const alerts: SupervisorAlert[] = [];
  let maxAttemptsSeen = 0;
  let latestCreated = 0;

  for (const t of rows) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    if (t.attempts > maxAttemptsSeen) maxAttemptsSeen = t.attempts;
    if (t.createdAt.getTime() > latestCreated) latestCreated = t.createdAt.getTime();

    const a = assessTask(t, limits, now);
    if (a.contain) {
      await db
        .update(agentTasks)
        .set({ status: a.status, error: { message: a.reason, supervisor: true } as never, errorAt: now })
        .where(eq(agentTasks.id, t.id));
      interventions.push({ taskId: t.id, agentKey: t.agentKey, reason: a.reason, action: a.action });
      alerts.push({ agentKey: t.agentKey, taskId: t.id, severity: a.severity, reason: a.reason, action: a.action });
      await writeAudit(db, { actorId: 'supervisor' }, {
        action: 'AI.SUPERVISOR_CONTAINED',
        entityType: 'AGENT_TASK',
        entityId: t.id,
        metadata: { agentKey: t.agentKey, reason: a.reason, action: a.action },
      });
    }
  }

  // Runaway detection: the same agent racking up retries across many tasks.
  const runawayByAgent = await db
    .select({ agentKey: agentTasks.agentKey, v: sql<number>`max(attempts)::int` })
    .from(agentTasks)
    .groupBy(agentTasks.agentKey);
  const runawayDetected = runawayByAgent.some((r) => Number(r.v) >= limits.maxAttempts);
  const loopDetected = maxAttemptsSeen >= limits.maxAttempts;

  // Per-agent failure-rate over the rolling window.
  const windowStart = new Date(now.getTime() - limits.windowSeconds * 1000);
  const windowRows = await db
    .select({ agentKey: agentTasks.agentKey, status: agentTasks.status })
    .from(agentTasks)
    .where(gt(agentTasks.createdAt, windowStart));
  const byAgent = new Map<string, { total: number; failed: number }>();
  for (const r of windowRows) {
    const cur = byAgent.get(r.agentKey) ?? { total: 0, failed: 0 };
    cur.total += 1;
    if (r.status === 'failed') cur.failed += 1;
    byAgent.set(r.agentKey, cur);
  }
  let failureRateFlagged = false;
  for (const [agentKey, v] of byAgent) {
    if (v.total < limits.minSamples) continue;
    const rate = v.failed / v.total;
    if (rate > limits.failureRateThreshold) {
      failureRateFlagged = true;
      alerts.push({
        agentKey,
        taskId: null,
        severity: 'CRITICAL',
        reason: `failure rate ${(rate * 100).toFixed(0)}% over ${v.total} task(s) in the window`,
        action: 'investigate-agent',
      });
    }
  }

  const stuckTasks = counts.running ?? 0;
  const expiredQueued = counts.queued ?? 0;
  const report: SupervisorReport = {
    generatedAt: now.toISOString(),
    limits,
    counts,
    total: rows.length,
    loopDetected,
    runawayDetected,
    stuckTasks,
    expiredQueued,
    failureRateFlagged,
    interventions,
    alerts,
  };

  if (interventions.length > 0 || failureRateFlagged) {
    logger.warn('supervisor intervened', { interventions: interventions.length, alerts: alerts.length });
    await escalateToSuperAdmins(db, alerts);
  }
  return report;
}

/** Resolves the ids of every SUPER_ADMIN. */
async function superAdminUserIds(db: DB): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.name, 'SUPER_ADMIN'));
  return rows.map((r) => r.userId);
}

/**
 * Delivers the supervisor's escalations to every SUPER_ADMIN: an in-app
 * notification and a dedicated audit entry per alert. Best-effort — a delivery
 * failure must never break the deterministic containment that already happened.
 */
export async function escalateToSuperAdmins(db: DB, alerts: SupervisorAlert[]): Promise<number> {
  if (alerts.length === 0) return 0;
  let delivered = 0;
  try {
    const admins = await superAdminUserIds(db);
    if (admins.length === 0) {
      logger.warn('supervisor alerts have no SUPER_ADMIN recipient', { alerts: alerts.length });
      return 0;
    }
    for (const alert of alerts) {
      for (const userId of admins) {
        await createNotification(db, {
          userId,
          type: 'AI_SUPERVISOR_ALERT',
          title: `Agent Supervisor: ${alert.action}`,
          body: `${alert.agentKey}${alert.taskId ? ` / task ${alert.taskId}` : ''} — ${alert.reason}`,
          data: { ...alert },
        });
        delivered += 1;
      }
    }
    await writeAudit(db, { actorId: 'supervisor' }, {
      action: 'AI.SUPERVISOR_ALERTED',
      entityType: 'AGENT_TASK',
      metadata: { alerts: alerts.length, recipients: admins.length, delivered },
    });
  } catch (err) {
    logger.error('supervisor escalation failed', { error: (err as Error).message });
  }
  return delivered;
}

/**
 * Pre-flight guardrail consulted by the runner before every execution. Returns
 * the agent keys that are currently unhealthy (too many failed tasks in the
 * window) so their runs are contained before they can loop.
 */
export async function unhealthyAgentKeys(db: DB, limits: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS): Promise<Set<string>> {
  const now = Date.now();
  const windowStart = new Date(now - limits.windowSeconds * 1000);
  const rows = await db
    .select({ agentKey: agentTasks.agentKey, status: agentTasks.status })
    .from(agentTasks)
    .where(gt(agentTasks.createdAt, windowStart));
  const byAgent = new Map<string, { total: number; failed: number }>();
  for (const r of rows) {
    const cur = byAgent.get(r.agentKey) ?? { total: 0, failed: 0 };
    cur.total += 1;
    if (r.status === 'failed') cur.failed += 1;
    byAgent.set(r.agentKey, cur);
  }
  const unhealthy = new Set<string>();
  for (const [agentKey, v] of byAgent) {
    if (v.total >= limits.minSamples && v.failed / v.total > limits.failureRateThreshold) unhealthy.add(agentKey);
  }
  return unhealthy;
}

/** Contained tasks awaiting a human look — the supervisor's escalation queue. */
export async function listContainedTasks(db: DB, limit = 50) {
  return db
    .select()
    .from(agentTasks)
    .where(inArray(agentTasks.status, ['failed', 'blocked']))
    .orderBy(agentTasks.createdAt)
    .limit(limit);
}

/** Agent registry rows flagged unhealthy by lifecycle status. */
export async function listHaltedAgents(db: DB) {
  return db.select().from(agentRegistry).where(inArray(agentRegistry.status, ['PAUSED', 'DISABLED']));
}

/** Read-only health snapshot for the admin desk (never mutates). */
export async function supervisorSnapshot(db: DB, limits: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS) {
  const rows = await db
    .select({ status: agentTasks.status, count: sql<number>`count(*)::int` })
    .from(agentTasks)
    .groupBy(agentTasks.status);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = Number(r.count);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const halted = await listHaltedAgents(db);
  return {
    limits,
    counts,
    total,
    haltedAgents: halted.map((a) => ({ key: a.key, status: a.status })),
    alertsOpen: (counts.failed ?? 0) + (counts.blocked ?? 0),
  };
}

/** Admin-facing health snapshot (no mutation). */
export async function supervisorStatus(db: DB, limits: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS) {
  const report = await supervise(db, limits);
  const halted = await listHaltedAgents(db);
  return { ...report, haltedAgents: halted.map((a) => ({ key: a.key, status: a.status })) };
}
