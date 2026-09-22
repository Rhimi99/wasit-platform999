import { sql, and, eq, desc } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import type { DB } from '../../db/client';
import { env } from '../env';
import { newId } from '../ids';
import { metrics } from './metrics';
import { logger } from './logger';
import { pingDb } from '../../db/client';
import { writeAudit } from '../audit';
import { alertEvents } from '../../db/schema/observability';
import type { AlertNotification, AlertSeverity, AlertStatus } from './alert-port';
import { resolveAlertNotifier } from './resolve-notifier';

/**
 * Alert engine.
 *
 * Rules are evaluated against the in-process metrics registry and a live
 * database probe. A rule has a threshold; when it is crossed the rule fires
 * once and stays firing (no repeated pages each tick), and when the condition
 * clears it resolves. Each transition is persisted to `alert_events`, written
 * to the audit log, and pushed through the notifier port.
 *
 * The engine is intentionally rule-table driven so adding a signal is one
 * function, not a new subsystem.
 */

export interface AlertRuleContext {
  db: DB;
  now: Date;
}

export interface AlertRule {
  name: string;
  severity: AlertSeverity;
  /** Short human description used in the notification summary. */
  summary: string;
  /** Returns firing details when the condition holds, or null when healthy. */
  evaluate(ctx: AlertRuleContext): Promise<Record<string, unknown> | null>;
}

/**
 * Error ratio over the process lifetime. A lifetime ratio is coarse but honest:
 * it needs no sliding window state, and with a healthy baseline it still trips
 * when something starts failing badly.
 */
function errorRatioRule(threshold: number): AlertRule {
  return {
    name: 'http_error_ratio',
    severity: 'CRITICAL',
    summary: `HTTP error ratio above ${Math.round(threshold * 100)}%`,
    async evaluate() {
      const total = sumCounterByPrefix('wasit_http_requests_total');
      const errors = sumCounterByPrefix('wasit_http_errors_total');
      if (total === 0) return null;
      const ratio = errors / total;
      if (ratio <= threshold) return null;
      return { ratio: Number(ratio.toFixed(4)), errors, total, threshold };
    },
  };
}

function sumCounterByPrefix(name: string): number {
  const snapshot = metrics.snapshot();
  const rows = snapshot.counters[name] ?? [];
  return rows.reduce((sum, row) => sum + row.value, 0);
}

const databaseDownRule: AlertRule = {
  name: 'database_down',
  severity: 'CRITICAL',
  summary: 'Database is not reachable',
  async evaluate() {
    try {
      await pingDb();
      metrics.setGauge('wasit_db_up', 1);
      return null;
    } catch (err) {
      metrics.setGauge('wasit_db_up', 0);
      return { error: (err as Error).message };
    }
  },
};

function p95LatencyRule(thresholdSeconds: number): AlertRule {
  return {
    name: 'http_p95_latency',
    severity: 'WARNING',
    summary: `HTTP p95 latency above ${thresholdSeconds}s`,
    async evaluate() {
      const snapshot = metrics.snapshot();
      const durations = snapshot.histograms['wasit_http_request_duration_seconds'] ?? [];
      if (durations.length === 0) return null;
      // Worst route p95 — a single sick route is the actionable signal.
      let worst = 0;
      let worstRoute = '';
      for (const row of durations) {
        const p95 = row.quantiles.p95 ?? 0;
        if (p95 > worst) {
          worst = p95;
          worstRoute = `${row.labels.method ?? ''} ${row.labels.route ?? ''}`.trim();
        }
      }
      if (worst <= thresholdSeconds) return null;
      return { p95: Number(worst.toFixed(4)), route: worstRoute, threshold: thresholdSeconds };
    },
  };
}

/** Rate-limit rejections imply either abuse or limits set too tight to ignore. */
function rateLimitRule(threshold: number): AlertRule {
  return {
    name: 'rate_limit_rejections',
    severity: 'WARNING',
    summary: `More than ${threshold} rate-limit rejections`,
    async evaluate() {
      const total = sumCounterByPrefix('wasit_rate_limit_rejections_total');
      if (total <= threshold) return null;
      return { rejections: total, threshold };
    },
  };
}

/**
 * Overdue alert evaluation: if a previous evaluation was expected but the
 * scheduler has not run, that is itself an incident signal (the background job
 * died). We compare wall clock against the last successful evaluation.
 */
export function schedulerStaleRule(maxStaleMinutes: number): AlertRule {
  return {
    name: 'alert_scheduler_stale',
    severity: 'CRITICAL',
    summary: `Alert scheduler has not run in ${maxStaleMinutes} minutes`,
    async evaluate() {
      const last = lastEvaluationAt;
      if (!last) return null; // first run has nothing to compare against
      const staleMinutes = (Date.now() - last.getTime()) / 60000;
      if (staleMinutes <= maxStaleMinutes) return null;
      return { staleMinutes: Number(staleMinutes.toFixed(1)), threshold: maxStaleMinutes };
    },
  };
}

/**
 * Backup freshness. The nightly backup writes a heartbeat file on success; if
 * the newest one is missing or too old, the schedule has stopped working and
 * nobody would otherwise notice until a restore is needed. The rule is inert
 * unless BACKUP_HEARTBEAT_FILE is configured, so tests and deployments without
 * a schedule do not page.
 */
export function backupStaleRule(
  heartbeatPath: string = env.BACKUP_HEARTBEAT_FILE,
  maxAgeHours: number = env.BACKUP_MAX_AGE_HOURS,
): AlertRule {
  return {
    name: 'backup_stale',
    severity: 'CRITICAL',
    summary: `Last successful database backup is older than ${maxAgeHours}h`,
    async evaluate() {
      if (!heartbeatPath) return null; // rule disabled
      let at: string | undefined;
      try {
        const raw = readFileSync(heartbeatPath, 'utf8');
        at = (JSON.parse(raw) as { at?: string }).at;
      } catch {
        return { heartbeat: heartbeatPath, reason: 'unreadable' };
      }
      if (!at) return { heartbeat: heartbeatPath, reason: 'no timestamp' };
      const ageHours = (Date.now() - new Date(at).getTime()) / 3_600_000;
      if (!Number.isFinite(ageHours)) return { heartbeat: heartbeatPath, reason: 'bad timestamp' };
      if (ageHours <= maxAgeHours) return null;
      return {
        heartbeat: heartbeatPath,
        lastSuccessAt: at,
        ageHours: Number(ageHours.toFixed(2)),
        threshold: maxAgeHours,
      };
    },
  };
}

export function defaultRules(): AlertRule[] {
  return [
    databaseDownRule,
    errorRatioRule(0.25),
    p95LatencyRule(2.5),
    rateLimitRule(200),
    backupStaleRule(),
  ];
}

let lastEvaluationAt: Date | null = null;

interface RuleState {
  firing: boolean;
  eventId: string | null;
  firedAt: Date | null;
}

const states = new Map<string, RuleState>();
let rehydrated = false;

/**
 * Alert transitions are tracked in memory for speed, but the events themselves
 * live in the database. After a restart the in-memory state is empty while the
 * rows are not, so a rule that was FIRING would never emit its RESOLVED row and
 * a still-matched condition would insert a duplicate FIRING. Seed the state
 * from the newest event per rule once per process to close that gap.
 */
async function rehydrateStates(db: DB): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  try {
    const open = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.status, 'FIRING'))
      .orderBy(desc(alertEvents.startedAt));
    for (const row of open) {
      if (states.has(row.rule)) continue;
      states.set(row.rule, { firing: true, eventId: row.id, firedAt: row.startedAt });
    }
  } catch (err) {
    logger.error('alert state rehydration failed', { error: (err as Error).message });
  }
}

export interface EvaluationResult {
  evaluated: number;
  fired: string[];
  resolved: string[];
}

/**
 * Evaluate every rule once and persist/notify on transitions. Safe to call from
 * the scheduler or an admin route; concurrent callers could race but the worst
 * outcome is a duplicate resolution, and transitions are cheap.
 */
export async function evaluateAlerts(
  db: DB,
  rules: AlertRule[] = defaultRules(),
): Promise<EvaluationResult> {
  await rehydrateStates(db);
  const now = new Date();
  const fired: string[] = [];
  const resolved: string[] = [];
  lastEvaluationAt = now;

  for (const rule of rules) {
    let details: Record<string, unknown> | null = null;
    try {
      details = await rule.evaluate({ db, now });
    } catch (err) {
      logger.error('alert rule evaluation failed', {
        rule: rule.name,
        error: (err as Error).message,
      });
      continue;
    }

    const state = states.get(rule.name) ?? { firing: false, eventId: null, firedAt: null };

    if (details && !state.firing) {
      const eventId = newId();
      await db.insert(alertEvents).values({
        id: eventId,
        rule: rule.name,
        severity: rule.severity,
        status: 'FIRING',
        summary: rule.summary,
        details,
        startedAt: now,
      });
      states.set(rule.name, { firing: true, eventId, firedAt: now });
      metrics.incCounter('wasit_alerts_fired_total', { rule: rule.name });
      fired.push(rule.name);
      await notify(db, {
        rule: rule.name,
        severity: rule.severity,
        status: 'FIRING',
        summary: rule.summary,
        details,
        occurredAt: now.toISOString(),
      }, eventId);
      await writeAudit(
        db,
        {},
        {
          action: 'OBSERVABILITY.ALERT_FIRED',
          entityType: 'ALERT',
          entityId: eventId,
          after: { rule: rule.name, severity: rule.severity, details },
        },
      );
      logger.warn(`alert FIRING: ${rule.name}`, { rule: rule.name, details });
    } else if (!details && state.firing) {
      if (state.eventId) {
        await db
          .update(alertEvents)
          .set({ status: 'RESOLVED', resolvedAt: now })
          .where(sql`${alertEvents.id} = ${state.eventId}`);
      }
      states.set(rule.name, { firing: false, eventId: null, firedAt: null });
      resolved.push(rule.name);
      await notify(db, {
        rule: rule.name,
        severity: rule.severity,
        status: 'RESOLVED',
        summary: rule.summary,
        details: {},
        occurredAt: now.toISOString(),
      }, state.eventId);
      await writeAudit(
        db,
        {},
        {
          action: 'OBSERVABILITY.ALERT_RESOLVED',
          entityType: 'ALERT',
          entityId: state.eventId,
          after: { rule: rule.name },
        },
      );
      logger.info(`alert RESOLVED: ${rule.name}`, { rule: rule.name });
    }
  }

  return { evaluated: rules.length, fired, resolved };
}

async function notify(
  db: DB,
  notification: AlertNotification,
  eventId: string | null,
): Promise<void> {
  const notifier = resolveAlertNotifier();
  let result = 'skipped';
  if (notifier.isAvailable()) {
    try {
      await notifier.send(notification);
      result = 'sent';
    } catch (err) {
      result = 'failed';
      logger.error('alert notification failed', {
        rule: notification.rule,
        notifier: notifier.id,
        error: (err as Error).message,
      });
    }
  }
  metrics.incCounter('wasit_alert_notifications_total', {
    channel: notifier.id,
    result,
  });
  if (eventId && result !== 'skipped') {
    await db
      .update(alertEvents)
      .set({ notifiedChannel: notifier.id, notifiedResult: result })
      .where(sql`${alertEvents.id} = ${eventId}`);
  }
}

/** Current firing rules, for the admin surface and health. */
export function firingAlerts(): Array<{ rule: string; firedAt: string | null }> {
  return [...states.entries()]
    .filter(([, state]) => state.firing)
    .map(([rule, state]) => ({ rule, firedAt: state.firedAt?.toISOString() ?? null }));
}

export function lastAlertEvaluationAt(): Date | null {
  return lastEvaluationAt;
}

/** Test seam: forget rule state between suites. */
export function resetAlertState(): void {
  states.clear();
  lastEvaluationAt = null;
  rehydrated = false;
}