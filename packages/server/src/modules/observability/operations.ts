import { and, desc, eq, gte, inArray, like, lt, notLike, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { pingDb } from '../../db/client';
import { env } from '../../lib/env';
import { metrics } from '../../lib/observability/metrics';
import {
  firingAlerts,
  lastAlertEvaluationAt,
} from '../../lib/observability/alerts';
import { alertStatus } from '../../lib/observability/resolve-notifier';
import { backupStatus } from '../../lib/observability/backup-status';
import { schedulerInfo } from '../../lib/observability/job-registry';
import { getAiExecutionSwitchState } from '../../lib/ai/kill-switch';
import { agentMetrics, agentRegistry, agentTasks } from '../../db/schema/agents';
import { aiRequests } from '../../db/schema/ai';
import { notificationDeliveries } from '../../db/schema/messaging';
import { auditLogs } from '../../db/schema/audit';
import { alertEvents } from '../../db/schema/observability';
import { agentCount, allAgentSpecs, executableAgents, declaredOnlyAgents, COPILOT_KEY } from '../ai/catalogue';
import { buildSupervisorOverview } from '../ai/supervisor';
import { lastScanAt, openEscalationCount, ESCALATION_RULE_PREFIX } from '../ai/escalations';
import { metricsCoverage } from '../ai/metrics';

/**
 * OBS-OPS-01 — the operational snapshot the General Manager reads.
 *
 * This module adds no source of truth. Every number is derived from a system
 * that already exists (HTTP metrics, alert engine, AI-MET-01 metrics log,
 * AI-SUP-02 escalation store, the scheduler, the notification ledger). Where a
 * figure cannot be trusted it is reported as unavailable with a reason instead
 * of being estimated — a monitoring surface that guesses is worse than one that
 * admits a gap.
 *
 * Read-only by construction: no writes, no state changes, no repair actions.
 */

const HOUR = 3_600_000;

export type Availability = 'available' | 'unavailable';

export interface PlatformHealth {
  db: { status: 'up' | 'down'; latencyMs: number | null; error: string | null };
  http: {
    requests: number;
    errors: number;
    errorRatio: number | null;
    p95Seconds: number | null;
    slowestRoute: string | null;
    topErrorRoutes: Array<{ route: string; method: string; errors: number }>;
  };
  rateLimitRejections: number;
  backup: ReturnType<typeof backupStatus>;
  killSwitch: { enabled: boolean; source: 'runtime' | 'env' };
}

export interface AgentOperations {
  catalogue: {
    total: number;
    executable: number;
    declaredOnly: number;
    copilot: boolean;
    registryStatus: { ACTIVE: number; PAUSED: number; DISABLED: number; total: number };
  };
  tasks: {
    byStatus: Record<string, number>;
    last24h: Record<string, number>;
    stalled: { count: number; oldestAgeMinutes: number | null; thresholdMinutes: number };
    pendingApprovals: number;
  };
  runs: {
    active: number;
    stuck: number;
    failedSteps: number;
    awaitingRetrySteps: number;
    contained: number;
    budgetExceeded: number;
    lastCycleAt: string | null;
  };
  escalations: { open: number; lastScanAt: string | null };
  performance24h: {
    attempts: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    scopeFailures: number;
    worstAgents: Array<{ agentKey: string; attempts: number; failed: number; successRate: number | null }>;
  };
  cost24h: {
    status: Availability;
    reason: string | null;
    byCurrency: Array<{ currencyCode: string; cost: string; requests: number }>;
    metricCoveragePercent: number | null;
  };
}

export interface NotificationHealth {
  byStatus: Record<string, number>;
  recentFailures: Array<{
    id: string;
    eventType: string;
    channel: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
  }>;
  failedLast24h: number;
}

export interface OperationsSnapshot {
  generatedAt: string;
  window: { from: string; to: string };
  platform: PlatformHealth;
  scheduler: ReturnType<typeof schedulerInfo> & {
    alertsLastEvaluatedAt: string | null;
    escalationsLastScanAt: string | null;
    supervisorLastCycleAt: string | null;
  };
  agents: AgentOperations;
  alerts: {
    firing: Array<{ rule: string; firedAt: string | null }>;
    lastEvaluatedAt: string | null;
    notifier: ReturnType<typeof alertStatus>;
    firingCount: number;
    acknowledgedFiring: number;
  };
  notifications: NotificationHealth;
  recentEvents: Array<{
    action: string;
    entityType: string;
    entityId: string | null;
    createdAt: string;
    metadata: unknown;
  }>;
  unavailable: string[];
}

function sumCounters(name: string): number {
  const rows = metrics.snapshot().counters[name] ?? [];
  return rows.reduce((acc, row) => acc + row.value, 0);
}

/** Highest p95 across routes — one sick route is the actionable signal. */
function worstLatency(): { p95Seconds: number | null; route: string | null } {
  const rows = metrics.snapshot().histograms['wasit_http_request_duration_seconds'] ?? [];
  let worst: number | null = null;
  let route: string | null = null;
  for (const row of rows) {
    const p95 = row.quantiles.p95;
    if (p95 === undefined) continue;
    if (worst === null || p95 > worst) {
      worst = p95;
      route = `${row.labels.method ?? ''} ${row.labels.route ?? ''}`.trim();
    }
  }
  return { p95Seconds: worst, route };
}

/** Routes with the most recorded errors, highest first. Labels only — no payloads. */
function topErrorRoutes(limit = 5): PlatformHealth['http']['topErrorRoutes'] {
  const rows = metrics.snapshot().counters['wasit_http_errors_total'] ?? [];
  return rows
    .map((row) => ({
      route: row.labels.route ?? '',
      method: row.labels.method ?? '',
      errors: row.value,
    }))
    .filter((row) => row.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, limit);
}

async function dbProbe(): Promise<PlatformHealth['db']> {
  const started = Date.now();
  try {
    await pingDb();
    return { status: 'up', latencyMs: Date.now() - started, error: null };
  } catch (err) {
    return { status: 'down', latencyMs: null, error: (err as Error).message };
  }
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function countRows(rows: Array<{ status: string | null; count: unknown }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status ?? 'unknown'] = toNumber(row.count);
  return out;
}

export async function buildOperationsSnapshot(
  db: DB,
  options: { now?: Date } = {},
): Promise<OperationsSnapshot> {
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - 24 * HOUR);
  const stalledBefore = new Date(now.getTime() - env.AI_METRICS_STALL_AFTER_MINUTES * 60_000);
  const unavailable: string[] = [];

  const [
    dbHealth,
    taskStatusRows,
    task24hRows,
    stalledRows,
    runOverview,
    escalationOpen,
    escalationScan,
    metricRows,
    deliveryRows,
    failedDeliveries,
    failed24h,
    costRows,
    coverage,
    ackedFiring,
    recentEvents,
  ] = await Promise.all([
    dbProbe(),
    db.select({ status: agentTasks.status, count: sql`count(*)::int` }).from(agentTasks).groupBy(agentTasks.status),
    db
      .select({ status: agentTasks.status, count: sql`count(*)::int` })
      .from(agentTasks)
      .where(gte(agentTasks.createdAt, from))
      .groupBy(agentTasks.status),
    db
      .select({
        count: sql`count(*)::int`,
        oldest: sql`min(${agentTasks.createdAt})`,
      })
      .from(agentTasks)
      .where(
        and(
          inArray(agentTasks.status, ['queued', 'running', 'awaiting_approval']),
          lt(agentTasks.createdAt, stalledBefore),
        ),
      ),
    buildSupervisorOverview(db),
    openEscalationCount(db),
    lastScanAt(db),
    db
      .select({
        agentKey: agentMetrics.agentKey,
        outcome: agentMetrics.outcome,
        errorCode: agentMetrics.errorCode,
        count: sql`count(*)::int`,
      })
      .from(agentMetrics)
      .where(gte(agentMetrics.createdAt, from))
      .groupBy(agentMetrics.agentKey, agentMetrics.outcome, agentMetrics.errorCode),
    db
      .select({ status: notificationDeliveries.status, count: sql`count(*)::int` })
      .from(notificationDeliveries)
      .groupBy(notificationDeliveries.status),
    db
      .select({
        id: notificationDeliveries.id,
        eventType: notificationDeliveries.eventType,
        channel: notificationDeliveries.channel,
        attempts: notificationDeliveries.attempts,
        lastError: notificationDeliveries.lastError,
        createdAt: notificationDeliveries.createdAt,
      })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, 'FAILED'))
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(10),
    db
      .select({ count: sql`count(*)::int` })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.status, 'FAILED'), gte(notificationDeliveries.createdAt, from))),
    db
      .select({
        currencyCode: aiRequests.currencyCode,
        cost: sql<string>`coalesce(sum(${aiRequests.cost}), 0)::text`,
        requests: sql`count(*)::int`,
      })
      .from(aiRequests)
      .where(gte(aiRequests.createdAt, from))
      .groupBy(aiRequests.currencyCode),
    metricsCoverage(db, { from, to: now }),
    db
      .select({ count: sql`count(*)::int` })
      .from(alertEvents)
      .where(
        and(
          eq(alertEvents.status, 'FIRING'),
          notLike(alertEvents.rule, `${ESCALATION_RULE_PREFIX}%`),
          sql`${alertEvents.details} ? 'ack'`,
        ),
      ),
    db
      .select({
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(like(auditLogs.action, 'OBSERVABILITY.%'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10),
  ]);

  // Registry status is read separately from the catalogue constants so a paused
  // or disabled agent is visible even though its spec still exists.
  const registryStatus = await db
    .select({ status: agentRegistry.status, count: sql`count(*)::int` })
    .from(agentRegistry)
    .groupBy(agentRegistry.status);

  const byStatus = countRows(taskStatusRows);
  const last24h = countRows(task24hRows);

  // Per-agent performance from the AI-MET-01 log (attempt-level, already durable).
  const perAgent = new Map<string, { attempts: number; succeeded: number; failed: number }>();
  let attempts = 0;
  let succeeded = 0;
  let failed = 0;
  let scopeFailures = 0;
  for (const row of metricRows) {
    const count = toNumber(row.count);
    const entry = perAgent.get(row.agentKey) ?? { attempts: 0, succeeded: 0, failed: 0 };
    entry.attempts += count;
    if (row.outcome === 'succeeded') entry.succeeded += count;
    if (row.outcome === 'failed') entry.failed += count;
    perAgent.set(row.agentKey, entry);
    attempts += count;
    if (row.outcome === 'succeeded') succeeded += count;
    if (row.outcome === 'failed') failed += count;
    if (/^(NO_SCOPE|SCOPE_)/i.test(row.errorCode ?? '')) scopeFailures += count;
  }
  const settled = succeeded + failed;
  const worstAgents = [...perAgent.entries()]
    .map(([agentKey, v]) => ({
      agentKey,
      attempts: v.attempts,
      failed: v.failed,
      successRate: v.succeeded + v.failed > 0 ? Number((v.succeeded / (v.succeeded + v.failed)).toFixed(4)) : null,
    }))
    .sort((a, b) => b.failed - a.failed || a.agentKey.localeCompare(b.agentKey))
    .slice(0, 5);

  const registryCounts = { ACTIVE: 0, PAUSED: 0, DISABLED: 0, total: 0 };
  for (const row of registryStatus) {
    const count = toNumber(row.count);
    registryCounts.total += count;
    if (row.status === 'ACTIVE') registryCounts.ACTIVE += count;
    else if (row.status === 'PAUSED') registryCounts.PAUSED += count;
    else if (row.status === 'DISABLED') registryCounts.DISABLED += count;
  }
  if (registryCounts.total === 0) {
    unavailable.push('agent registry rows are missing (catalogue is code-only until seeded)');
  }

  const byStatusNotifications = countRows(
    deliveryRows.map((r) => ({ status: r.status, count: r.count })),
  );

  const httpRequests = sumCounters('wasit_http_requests_total');
  const httpErrors = sumCounters('wasit_http_errors_total');
  const latency = worstLatency();
  const firing = firingAlerts();
  const scheduler = schedulerInfo();

  if (scheduler.jobs.length === 0) {
    unavailable.push('background jobs have not run in this process yet (registry is process-local)');
  }
  if (coverage.percent === null) {
    unavailable.push('agent metric coverage is undefined (no tasks in the last 24h)');
  }
  if (costRows.length === 0) {
    unavailable.push('AI cost: no ai_requests recorded in the last 24h');
  }

  return {
    generatedAt: now.toISOString(),
    window: { from: from.toISOString(), to: now.toISOString() },
    platform: {
      db: dbHealth,
      http: {
        requests: httpRequests,
        errors: httpErrors,
        errorRatio: httpRequests > 0 ? Number((httpErrors / httpRequests).toFixed(4)) : null,
        p95Seconds: latency.p95Seconds,
        slowestRoute: latency.route,
        topErrorRoutes: topErrorRoutes(),
      },
      rateLimitRejections: sumCounters('wasit_rate_limit_rejections_total'),
      backup: backupStatus(),
      killSwitch: getAiExecutionSwitchState(),
    },
    scheduler: {
      ...scheduler,
      alertsLastEvaluatedAt: lastAlertEvaluationAt()?.toISOString() ?? null,
      escalationsLastScanAt: escalationScan,
      supervisorLastCycleAt: runOverview.lastCycleAt,
    },
    agents: {
      catalogue: {
        total: agentCount(),
        executable: executableAgents().length,
        declaredOnly: declaredOnlyAgents().length,
        copilot: allAgentSpecs().some((a) => a.key === COPILOT_KEY),
        registryStatus: registryCounts,
      },
      tasks: {
        byStatus,
        last24h,
        stalled: {
          count: toNumber(stalledRows[0]?.count),
          oldestAgeMinutes: stalledRows[0]?.oldest
            ? Math.round((now.getTime() - new Date(stalledRows[0].oldest as string).getTime()) / 60_000)
            : null,
          thresholdMinutes: env.AI_METRICS_STALL_AFTER_MINUTES,
        },
        pendingApprovals: byStatus.awaiting_approval ?? 0,
      },
      runs: {
        active: runOverview.activeRuns,
        stuck: runOverview.stuckRuns,
        failedSteps: runOverview.failedSteps,
        awaitingRetrySteps: runOverview.awaitingRetrySteps,
        contained: runOverview.containedRuns,
        budgetExceeded: runOverview.budgetExceededRuns,
        lastCycleAt: runOverview.lastCycleAt,
      },
      escalations: { open: escalationOpen, lastScanAt: escalationScan },
      performance24h: {
        attempts,
        succeeded,
        failed,
        successRate: settled > 0 ? Number((succeeded / settled).toFixed(4)) : null,
        scopeFailures,
        worstAgents,
      },
      cost24h: {
        status: costRows.length > 0 ? 'available' : 'unavailable',
        reason: costRows.length > 0 ? null : 'no ai_requests in the window',
        byCurrency: costRows.map((row) => ({
          currencyCode: row.currencyCode,
          cost: String(row.cost ?? '0'),
          requests: toNumber(row.requests),
        })),
        metricCoveragePercent: coverage.percent === null ? null : Number((coverage.percent * 100).toFixed(1)),
      },
    },
    alerts: {
      firing,
      lastEvaluatedAt: lastAlertEvaluationAt()?.toISOString() ?? null,
      notifier: alertStatus(),
      firingCount: firing.length,
      acknowledgedFiring: toNumber(ackedFiring[0]?.count),
    },
    notifications: {
      byStatus: byStatusNotifications,
      recentFailures: failedDeliveries.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        channel: row.channel,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
      failedLast24h: toNumber(failed24h[0]?.count),
    },
    recentEvents: recentEvents.map((row) => ({
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: new Date(row.createdAt).toISOString(),
      metadata: row.metadata,
    })),
    unavailable,
  };
}
