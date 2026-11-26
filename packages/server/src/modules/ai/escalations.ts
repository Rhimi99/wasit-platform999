import { and, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { alertEvents } from '../../db/schema/observability';
import { agentMetrics, agentTasks } from '../../db/schema/agents';
import { agentRuns } from '../../db/schema/agent_runs';
import { auditLogs } from '../../db/schema/audit';
import { notifications, notificationDeliveries } from '../../db/schema/messaging';
import { roles, userRoles, users } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { isAiExecutionBlocked } from '../../lib/ai/kill-switch';
import {
  DEFAULT_ESCALATION_LIMITS,
  ESCALATION_SEVERITIES,
  SEVERITY_RANK,
  evaluateEscalations,
  settledOf,
  type EscalationCode,
  type EscalationFacts,
  type EscalationLimits,
  type EscalationSeverity,
  type EscalationStatus,
  type Finding,
  type WindowCounts,
} from './escalation-policy.js';
import { LIVE_RUN_STATES } from './supervisor.js';

/**
 * AI-SUP-02 — Supervisor escalation store and GM notification.
 *
 * The Supervisor *acts*; this layer makes its findings *visible to a human who
 * can decide*. Storage reuses `alert_events` — the platform's existing
 * "severity + evidence + lifecycle" alert table — with the rule namespaced
 * `supervisor.<code>`. No migration: the case row carries severity, status,
 * summary and evidence; the who-did-what history is written to `audit_logs`,
 * which is the immutable record of an acknowledgement or a resolution.
 *
 * Guarantees:
 *  - ONE open case per condition. Creation runs under a transaction-scoped
 *    advisory lock keyed on the condition fingerprint, then re-checks for an
 *    open case — so two scans (or two processes) cannot open duplicates even
 *    though the table has no unique index on the fingerprint.
 *  - A repeat finding with the SAME severity refreshes the case and does NOT
 *    notify again. A HIGHER severity is a real escalation: the case is upgraded,
 *    audited and the GM is notified once more.
 *  - A resolved case is never reopened. The same condition recurring is a new
 *    case, so the history of what happened stays intact.
 *  - A notification failure never loses the case and never throws: the case is
 *    stored first, the delivery ledger records FAILED, and the GM can still see
 *    it in the list.
 *  - The kill switch stops detection and automatic notification. It does not
 *    block a human from acknowledging or resolving what is already open.
 */

export const ESCALATION_RULE_PREFIX = 'supervisor.';

/** Envelope stored in `alert_events.details` for a supervisor case. */
interface EscalationDetails {
  fingerprint: string;
  code: EscalationCode;
  agentKey: string | null;
  taskId: string | null;
  runId: string | null;
  recommendation: string;
  recommendationKey: string;
  evidence: Record<string, unknown>;
  occurrences: number;
  updatedAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  severityHistory: Array<{ severity: EscalationSeverity; at: string; reason: string }>;
  notification: {
    channel: string;
    result: string;
    recipients: number;
    sent: number;
    failed: number;
    at: string;
    lastError: string | null;
  } | null;
}

export interface EscalationView {
  id: string;
  code: EscalationCode;
  severity: EscalationSeverity;
  status: EscalationStatus;
  title: string;
  recommendation: string;
  recommendationKey: string;
  agentKey: string | null;
  taskId: string | null;
  runId: string | null;
  evidence: Record<string, unknown>;
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  resolutionNote: string | null;
  notification: EscalationDetails['notification'];
}

function ruleOf(code: EscalationCode): string {
  return `${ESCALATION_RULE_PREFIX}${code}`;
}

function codeOfRule(rule: string): EscalationCode {
  return rule.slice(ESCALATION_RULE_PREFIX.length) as EscalationCode;
}

function readDetails(raw: unknown): EscalationDetails {
  const d = (raw ?? {}) as Partial<EscalationDetails>;
  return {
    fingerprint: d.fingerprint ?? '',
    code: (d.code ?? 'task_stalled') as EscalationCode,
    agentKey: d.agentKey ?? null,
    taskId: d.taskId ?? null,
    runId: d.runId ?? null,
    recommendation: d.recommendation ?? '',
    recommendationKey: d.recommendationKey ?? '',
    evidence: d.evidence ?? {},
    occurrences: d.occurrences ?? 1,
    updatedAt: d.updatedAt ?? new Date(0).toISOString(),
    acknowledgedBy: d.acknowledgedBy ?? null,
    acknowledgedAt: d.acknowledgedAt ?? null,
    resolvedBy: d.resolvedBy ?? null,
    resolvedAt: d.resolvedAt ?? null,
    resolutionNote: d.resolutionNote ?? null,
    severityHistory: d.severityHistory ?? [],
    notification: d.notification ?? null,
  };
}

/** Display label for a staff actor; falls back to the id so the field is never blank. */
function displayName(first: string | null, last: string | null, id: string): string {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : id;
}

async function staffName(db: DB, userId: string | null): Promise<{ id: string; name: string } | null> {
  if (!userId) return null;
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (rows.length === 0) return { id: userId, name: userId };
  return { id: userId, name: displayName(rows[0].firstName, rows[0].lastName, userId) };
}

async function toView(db: DB, row: typeof alertEvents.$inferSelect): Promise<EscalationView> {
  const d = readDetails(row.details);
  return {
    id: row.id,
    code: codeOfRule(row.rule),
    severity: row.severity as EscalationSeverity,
    status: row.status as EscalationStatus,
    title: row.summary,
    recommendation: d.recommendation,
    recommendationKey: d.recommendationKey,
    agentKey: d.agentKey,
    taskId: d.taskId,
    runId: d.runId,
    evidence: d.evidence,
    occurrences: d.occurrences,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: d.updatedAt,
    acknowledgedAt: d.acknowledgedAt,
    acknowledgedBy: await staffName(db, d.acknowledgedBy),
    resolvedAt: d.resolvedAt,
    resolvedBy: await staffName(db, d.resolvedBy),
    resolutionNote: d.resolutionNote,
    notification: d.notification,
  };
}

// ---------------------------------------------------------------- detection

const EMPTY_COUNTS = (): WindowCounts => ({ attempts: 0, succeeded: 0, failed: 0, rejected: 0, blocked: 0 });

async function windowCounts(db: DB, from: Date, to: Date): Promise<Map<string, WindowCounts>> {
  const rows = await db
    .select({
      agentKey: agentMetrics.agentKey,
      attempts: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'failed')::int`,
      rejected: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'rejected')::int`,
      blocked: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'blocked')::int`,
    })
    .from(agentMetrics)
    .where(and(gte(agentMetrics.createdAt, from), lte(agentMetrics.createdAt, to)))
    .groupBy(agentMetrics.agentKey);

  const map = new Map<string, WindowCounts>();
  for (const r of rows) {
    map.set(r.agentKey, {
      attempts: Number(r.attempts),
      succeeded: Number(r.succeeded),
      failed: Number(r.failed),
      rejected: Number(r.rejected),
      blocked: Number(r.blocked),
    });
  }
  return map;
}

/** Tool refusals and failures, aggregated per agent and code (codes only). */
async function toolFacts(db: DB, from: Date, to: Date) {
  const rows = await db
    .select({
      agentKey: sql<string | null>`${auditLogs.metadata}->>'agentKey'`,
      action: auditLogs.action,
      code: sql<string | null>`${auditLogs.metadata}->>'code'`,
      count: sql<number>`count(*)::int`,
    })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.action, ['AI.TOOL_FAILED', 'AI.TOOL_REFUSED']),
        gte(auditLogs.createdAt, from),
        lte(auditLogs.createdAt, to),
      ),
    )
    .groupBy(sql`${auditLogs.metadata}->>'agentKey'`, auditLogs.action, sql`${auditLogs.metadata}->>'code'`);

  const byAgent = new Map<string, { failed: number; refused: number; timeouts: number; refusalCodes: string[] }>();
  for (const r of rows) {
    if (!r.agentKey) continue;
    const acc = byAgent.get(r.agentKey) ?? { failed: 0, refused: 0, timeouts: 0, refusalCodes: [] };
    const n = Number(r.count);
    if (r.action === 'AI.TOOL_FAILED') {
      acc.failed += n;
      if (r.code === 'TOOL_TIMEOUT') acc.timeouts += n;
    } else {
      acc.refused += n;
      if (r.code) acc.refusalCodes.push(r.code);
    }
    byAgent.set(r.agentKey, acc);
  }
  return [...byAgent.entries()].map(([agentKey, v]) => ({ agentKey, ...v }));
}

export async function collectEscalationFacts(
  db: DB,
  options: { now?: Date; windowMinutes?: number; supervisorEnabled?: boolean } = {},
): Promise<EscalationFacts> {
  const now = options.now ?? new Date();
  const windowMinutes = Math.max(5, options.windowMinutes ?? DEFAULT_ESCALATION_LIMITS.windowMinutes);
  const windowMs = windowMinutes * 60_000;
  // The window's upper bound is the app clock, but `created_at` is written by
  // PostgreSQL. A few milliseconds of skew between the two would otherwise drop
  // rows written moments ago, so the bound is widened rather than exact.
  const CLOCK_SKEW_MS = 5_000;
  const curTo = new Date(now.getTime() + CLOCK_SKEW_MS);
  const curFrom = new Date(now.getTime() - windowMs);
  const prevTo = new Date(curFrom.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - windowMs);

  const [current, previous] = await Promise.all([windowCounts(db, curFrom, curTo), windowCounts(db, prevFrom, prevTo)]);

  const agentKeys = new Set([...current.keys(), ...previous.keys()]);
  const agents = [...agentKeys].sort().map((agentKey) => ({
    agentKey,
    current: current.get(agentKey) ?? EMPTY_COUNTS(),
    previous: previous.get(agentKey) ?? EMPTY_COUNTS(),
  }));

  const openTaskRows = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      status: agentTasks.status,
      attempts: agentTasks.attempts,
      maxAttempts: agentTasks.maxAttempts,
      requiresApproval: agentTasks.requiresApproval,
      startedAt: agentTasks.startedAt,
      createdAt: agentTasks.createdAt,
    })
    .from(agentTasks)
    .where(inArray(agentTasks.status, ['queued', 'running', 'awaiting_approval']))
    .orderBy(agentTasks.createdAt)
    .limit(1000);

  const tasks = openTaskRows.map((t) => {
    const openedAt = t.startedAt ?? t.createdAt;
    return {
      id: t.id,
      agentKey: t.agentKey,
      status: t.status,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      requiresApproval: t.requiresApproval,
      ageMinutes: Math.max(0, Math.floor((now.getTime() - new Date(openedAt).getTime()) / 60_000)),
    };
  });

  const tools = await toolFacts(db, curFrom, curTo);

  const [failedCycleRows, liveRunRows, interventionRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'AI.AGENT_RUN_SUPERVISOR_FAILED'),
          gte(auditLogs.createdAt, curFrom),
          lte(auditLogs.createdAt, curTo),
        ),
      ),
    db
      .select({ id: agentRuns.id, startedAt: agentRuns.startedAt, createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(inArray(agentRuns.status, LIVE_RUN_STATES))
      .limit(1000),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.action, [
            'AI.AGENT_RUN_CONTAINED',
            'AI.AGENT_RUN_STEP_RETRY_SCHEDULED',
            'AI.AGENT_RUN_STEP_RETRY_FAILED',
          ]),
          gte(auditLogs.createdAt, new Date(now.getTime() - 60 * 60_000)),
        ),
      ),
  ]);

  let oldestLiveRunMinutes = 0;
  for (const run of liveRunRows) {
    const opened = new Date(run.startedAt ?? run.createdAt).getTime();
    oldestLiveRunMinutes = Math.max(oldestLiveRunMinutes, Math.floor((now.getTime() - opened) / 60_000));
  }

  return {
    agents,
    tasks,
    tools,
    supervisor: {
      enabled: options.supervisorEnabled ?? true,
      failedCycles: Number(failedCycleRows[0]?.count ?? 0),
      liveRuns: liveRunRows.length,
      oldestLiveRunMinutes,
      interventionsLastHour: Number(interventionRows[0]?.count ?? 0),
    },
  };
}

// ------------------------------------------------------------------ storage

export type CaseWriteOutcome = 'opened' | 'escalated' | 'refreshed' | 'suppressed';

export interface CaseWrite {
  outcome: CaseWriteOutcome;
  /** Null only when the finding was suppressed (no case was written). */
  id: string | null;
  severity: EscalationSeverity;
  notify: boolean;
}

/**
 * Creates a case for `finding`, or folds it into the open case that already
 * describes the same condition.
 *
 * The advisory lock is transaction-scoped and keyed on the fingerprint, so all
 * writers for one condition serialise; the "is there an open case?" read inside
 * that lock is therefore authoritative even without a unique index.
 */
export async function openOrEscalateCase(
  db: DB,
  finding: Finding,
  now: Date,
  options: { reopenCooldownMinutes?: number } = {},
): Promise<CaseWrite> {
  const cooldownMs = Math.max(0, options.reopenCooldownMinutes ?? DEFAULT_ESCALATION_LIMITS.reopenCooldownMinutes) * 60_000;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai-escalation:${finding.fingerprint}`}))`);

    const openRows = await tx
      .select()
      .from(alertEvents)
      .where(
        and(
          eq(alertEvents.rule, ruleOf(finding.code)),
          inArray(alertEvents.status, ['OPEN', 'ACKNOWLEDGED']),
          sql`${alertEvents.details}->>'fingerprint' = ${finding.fingerprint}`,
        ),
      )
      .limit(1);

    const nowIso = now.toISOString();

    if (openRows.length > 0) {
      const row = openRows[0];
      const d = readDetails(row.details);
      const previousSeverity = row.severity as EscalationSeverity;
      const upgraded = SEVERITY_RANK[finding.severity] > SEVERITY_RANK[previousSeverity];

      const nextDetails: EscalationDetails = {
        ...d,
        recommendation: finding.recommendation,
        recommendationKey: finding.recommendationKey,
        evidence: finding.evidence,
        occurrences: d.occurrences + 1,
        updatedAt: nowIso,
        severityHistory: upgraded
          ? [...d.severityHistory, { severity: finding.severity, at: nowIso, reason: 'severity upgraded by a later scan' }]
          : d.severityHistory,
      };

      await tx
        .update(alertEvents)
        .set({
          // An upgrade reopens the case for attention: an acknowledged case whose
          // condition got worse must not look handled.
          status: upgraded ? 'OPEN' : row.status,
          severity: upgraded ? finding.severity : previousSeverity,
          summary: finding.title,
          details: nextDetails,
        })
        .where(eq(alertEvents.id, row.id));

      return {
        outcome: upgraded ? 'escalated' : 'refreshed',
        id: row.id,
        severity: upgraded ? finding.severity : previousSeverity,
        notify: upgraded,
      };
    }

    // A case resolved moments ago must not be re-opened by the next sweep while
    // the same condition is still true — that would punish the GM for answering.
    if (cooldownMs > 0) {
      const recent = await tx
        .select({ resolvedAt: alertEvents.resolvedAt })
        .from(alertEvents)
        .where(
          and(
            eq(alertEvents.rule, ruleOf(finding.code)),
            eq(alertEvents.status, 'RESOLVED'),
            sql`${alertEvents.details}->>'fingerprint' = ${finding.fingerprint}`,
          ),
        )
        .orderBy(desc(alertEvents.resolvedAt))
        .limit(1);
      const resolvedAt = recent[0]?.resolvedAt ? new Date(recent[0].resolvedAt).getTime() : null;
      if (resolvedAt !== null && now.getTime() - resolvedAt < cooldownMs) {
        return { outcome: 'suppressed', id: null, severity: finding.severity, notify: false };
      }
    }

    const id = newId();
    const details: EscalationDetails = {
      fingerprint: finding.fingerprint,
      code: finding.code,
      agentKey: finding.agentKey,
      taskId: finding.taskId,
      runId: finding.runId,
      recommendation: finding.recommendation,
      recommendationKey: finding.recommendationKey,
      evidence: finding.evidence,
      occurrences: 1,
      updatedAt: nowIso,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      severityHistory: [{ severity: finding.severity, at: nowIso, reason: 'opened' }],
      notification: null,
    };

    await tx.insert(alertEvents).values({
      id,
      rule: ruleOf(finding.code),
      severity: finding.severity,
      status: 'OPEN',
      summary: finding.title,
      details,
      startedAt: now,
      createdAt: now,
    });

    return { outcome: 'opened', id, severity: finding.severity, notify: true };
  });
}

// -------------------------------------------------------------- notification

async function gmRecipients(db: DB): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(roles.name, 'SUPER_ADMIN'), eq(users.isActive, true)));
  return [...new Set(rows.map((r) => r.id))];
}

export interface DeliveryResult {
  channel: 'IN_APP';
  recipients: number;
  sent: number;
  failed: number;
  lastError: string | null;
}

/**
 * Delivers one case to the GM's in-app inbox.
 *
 * Delivery is best-effort by design: the case is already stored, so a failure
 * here is recorded (per recipient in `notification_deliveries`, and on the case
 * row as `notified_result`) rather than thrown. `notification_deliveries` has a
 * unique `dedupeKey`, so the same case at the same severity can never reach the
 * same recipient twice — while a severity upgrade uses a new generation and
 * therefore does reach them again.
 */
export async function deliverEscalationToGm(
  db: DB,
  escalationId: string,
  options: { generation?: number; now?: Date } = {},
): Promise<DeliveryResult> {
  const rows = await db.select().from(alertEvents).where(eq(alertEvents.id, escalationId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Escalation');
  const row = rows[0];
  const details = readDetails(row.details);
  const now = options.now ?? new Date();
  const generation = options.generation ?? details.severityHistory.length - 1;

  const recipients = await gmRecipients(db);
  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const userId of recipients) {
    const dedupeKey = `escalation:${escalationId}:${userId}:IN_APP:${generation}`;
    let notificationId: string | null = null;
    let error: string | null = null;
    try {
      notificationId = newId();
      await db.insert(notifications).values({
        id: notificationId,
        userId,
        type: 'AI_ESCALATION',
        title: `[${row.severity}] ${row.summary}`.slice(0, 250),
        body: details.recommendation || null,
        data: {
          escalationId,
          code: details.code,
          severity: row.severity,
          agentKey: details.agentKey,
          taskId: details.taskId,
          recommendationKey: details.recommendationKey,
        },
      });
    } catch (err) {
      notificationId = null;
      error = err instanceof Error ? err.message : 'notification insert failed';
      lastError = error;
    }

    if (error) failed += 1;
    else sent += 1;

    try {
      await db
        .insert(notificationDeliveries)
        .values({
          id: newId(),
          notificationId,
          userId,
          eventType: 'AI_ESCALATION',
          entityType: 'AI_ESCALATION',
          entityId: escalationId,
          channel: 'IN_APP',
          status: error ? 'FAILED' : 'SENT',
          attempts: 1,
          lastError: error ? error.slice(0, 500) : null,
          dedupeKey,
        })
        .onConflictDoUpdate({
          target: notificationDeliveries.dedupeKey,
          set: {
            notificationId,
            status: error ? 'FAILED' : 'SENT',
            attempts: sql`${notificationDeliveries.attempts} + 1`,
            lastError: error ? error.slice(0, 500) : null,
            updatedAt: now,
          },
        });
    } catch (err) {
      // The ledger is evidence, not the delivery: never fail the case over it.
      lastError = err instanceof Error ? err.message : lastError;
    }
  }

  const result: string = recipients.length === 0 ? 'NO_RECIPIENT' : failed === 0 ? 'SENT' : sent === 0 ? 'FAILED' : 'PARTIAL';
  const notification = {
    channel: 'IN_APP' as const,
    result,
    recipients: recipients.length,
    sent,
    failed,
    at: now.toISOString(),
    lastError,
  };

  await db
    .update(alertEvents)
    .set({
      notifiedChannel: 'IN_APP',
      notifiedResult: result,
      details: { ...details, notification, updatedAt: now.toISOString() } satisfies EscalationDetails,
    })
    .where(eq(alertEvents.id, escalationId));

  return { channel: 'IN_APP', recipients: recipients.length, sent, failed, lastError };
}

// --------------------------------------------------------------------- scan

export interface EscalationScanResult {
  skipped: 'KILL_SWITCH' | null;
  findings: number;
  opened: number;
  escalated: number;
  refreshed: number;
  suppressed: number;
  capped: number;
  notifications: { attempted: number; sent: number; failed: number; recipients: number };
  cases: Array<{ id: string | null; code: EscalationCode; severity: EscalationSeverity; outcome: CaseWriteOutcome }>;
}

export interface ScanOptions {
  now?: Date;
  limits?: Partial<EscalationLimits>;
  /** Per-scan cap on cases written; the most severe findings win. */
  maxCases?: number;
  supervisorEnabled?: boolean;
}

/**
 * One detection pass: collect facts, evaluate, then open/refresh/escalate cases
 * and notify the GM for anything new or worsened.
 *
 * The kill switch is checked FIRST and the pass becomes a recorded no-op: a
 * stopped platform must not generate new alerts, and must not touch cases.
 */
export async function scanEscalations(db: DB, audit: AuditContext, options: ScanOptions = {}): Promise<EscalationScanResult> {
  const empty: EscalationScanResult = {
    skipped: null,
    findings: 0,
    opened: 0,
    escalated: 0,
    refreshed: 0,
    suppressed: 0,
    capped: 0,
    notifications: { attempted: 0, sent: 0, failed: 0, recipients: 0 },
    cases: [],
  };

  if (await isAiExecutionBlocked(db)) {
    await writeAudit(db, audit, {
      action: 'AI.KILL_SWITCH_ESCALATION_REFUSED',
      entityType: 'AI_KILL_SWITCH',
      entityId: null,
      metadata: { reason: 'ai-execution-disabled', sweep: 'scanEscalations' },
    });
    return { ...empty, skipped: 'KILL_SWITCH' };
  }

  const now = options.now ?? new Date();
  const limits: EscalationLimits = { ...DEFAULT_ESCALATION_LIMITS, ...options.limits };
  const maxCases = Math.min(Math.max(1, options.maxCases ?? 200), 1000);

  const facts = await collectEscalationFacts(db, {
    now,
    windowMinutes: limits.windowMinutes,
    supervisorEnabled: options.supervisorEnabled,
  });
  const findings = evaluateEscalations(facts, limits);
  const result: EscalationScanResult = { ...empty, findings: findings.length };

  for (const finding of findings) {
    if (result.cases.length >= maxCases) {
      result.capped += 1;
      continue;
    }
    const write = await openOrEscalateCase(db, finding, now, {
      reopenCooldownMinutes: limits.reopenCooldownMinutes,
    });
    result[write.outcome] += 1;
    result.cases.push({ id: write.id, code: finding.code, severity: write.severity, outcome: write.outcome });

    if (write.notify && write.id) {
      const delivery = await deliverEscalationToGm(db, write.id, { now });
      result.notifications.attempted += 1;
      result.notifications.sent += delivery.sent;
      result.notifications.failed += delivery.failed;
      result.notifications.recipients = Math.max(result.notifications.recipients, delivery.recipients);
      await writeAudit(db, audit, {
        action: delivery.sent > 0 ? 'AI.ESCALATION_NOTIFIED' : 'AI.ESCALATION_NOTIFY_FAILED',
        entityType: 'AI_ESCALATION',
        entityId: write.id,
        metadata: {
          code: finding.code,
          severity: write.severity,
          outcome: write.outcome,
          recipients: delivery.recipients,
          sent: delivery.sent,
          failed: delivery.failed,
          channel: 'IN_APP',
        },
      });
    }
  }

  await writeAudit(db, audit, {
    action: 'AI.ESCALATION_SCAN_RUN',
    entityType: 'AI_ESCALATION',
    entityId: null,
    metadata: {
      windowMinutes: limits.windowMinutes,
      findings: result.findings,
      opened: result.opened,
      escalated: result.escalated,
      refreshed: result.refreshed,
      suppressed: result.suppressed,
      capped: result.capped,
      notificationsSent: result.notifications.sent,
      notificationsFailed: result.notifications.failed,
    },
  });

  return result;
}

// ----------------------------------------------------------------- lifecycle

async function loadCase(db: DB, id: string): Promise<typeof alertEvents.$inferSelect> {
  const rows = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.id, id), like(alertEvents.rule, `${ESCALATION_RULE_PREFIX}%`)))
    .limit(1);
  if (rows.length === 0) throw ApiError.notFound('Escalation');
  return rows[0];
}

export async function acknowledgeEscalation(
  db: DB,
  id: string,
  actorId: string,
  note: string | null,
  audit: AuditContext,
): Promise<EscalationView> {
  const row = await loadCase(db, id);
  if (row.status === 'RESOLVED') throw ApiError.conflict('Escalation is already resolved');
  if (row.status === 'ACKNOWLEDGED') throw ApiError.conflict('Escalation is already acknowledged');

  const nowIso = new Date().toISOString();
  const d = readDetails(row.details);
  const updated = await db
    .update(alertEvents)
    .set({
      status: 'ACKNOWLEDGED',
      details: { ...d, acknowledgedBy: actorId, acknowledgedAt: nowIso, updatedAt: nowIso, resolutionNote: note ?? d.resolutionNote } satisfies EscalationDetails,
    })
    .where(and(eq(alertEvents.id, id), eq(alertEvents.status, 'OPEN')))
    .returning({ id: alertEvents.id });
  if (updated.length === 0) throw ApiError.conflict('Escalation changed while being acknowledged');

  await writeAudit(db, audit, {
    action: 'AI.ESCALATION_ACKNOWLEDGED',
    entityType: 'AI_ESCALATION',
    entityId: id,
    before: { status: row.status },
    after: { status: 'ACKNOWLEDGED' },
    metadata: { code: d.code, severity: row.severity, note: note ?? null },
  });

  return toView(db, await loadCase(db, id));
}

export async function resolveEscalation(
  db: DB,
  id: string,
  actorId: string,
  note: string,
  audit: AuditContext,
): Promise<EscalationView> {
  const row = await loadCase(db, id);
  if (row.status === 'RESOLVED') throw ApiError.conflict('Escalation is already resolved');

  const now = new Date();
  const nowIso = now.toISOString();
  const d = readDetails(row.details);
  const updated = await db
    .update(alertEvents)
    .set({
      status: 'RESOLVED',
      resolvedAt: now,
      details: {
        ...d,
        resolvedBy: actorId,
        resolvedAt: nowIso,
        resolutionNote: note,
        updatedAt: nowIso,
      } satisfies EscalationDetails,
    })
    .where(and(eq(alertEvents.id, id), inArray(alertEvents.status, ['OPEN', 'ACKNOWLEDGED'])))
    .returning({ id: alertEvents.id });
  if (updated.length === 0) throw ApiError.conflict('Escalation changed while being resolved');

  await writeAudit(db, audit, {
    action: 'AI.ESCALATION_RESOLVED',
    entityType: 'AI_ESCALATION',
    entityId: id,
    before: { status: row.status },
    after: { status: 'RESOLVED' },
    metadata: { code: d.code, severity: row.severity, note },
  });

  return toView(db, await loadCase(db, id));
}

export interface ListEscalationsQuery {
  status?: EscalationStatus;
  severity?: EscalationSeverity;
  agentKey?: string;
  limit?: number;
  offset?: number;
}

export interface EscalationListResult {
  items: EscalationView[];
  total: number;
  counts: { open: number; acknowledged: number; resolved: number };
  bySeverity: Record<string, number>;
  killSwitch: boolean;
}

export async function listEscalations(db: DB, query: ListEscalationsQuery = {}): Promise<EscalationListResult> {
  const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
  const offset = Math.max(0, query.offset ?? 0);

  const conditions = [like(alertEvents.rule, `${ESCALATION_RULE_PREFIX}%`)];
  if (query.status) conditions.push(eq(alertEvents.status, query.status));
  if (query.severity) conditions.push(eq(alertEvents.severity, query.severity));
  if (query.agentKey) conditions.push(sql`${alertEvents.details}->>'agentKey' = ${query.agentKey}`);

  const [rows, totals, statusRows] = await Promise.all([
    db
      .select()
      .from(alertEvents)
      .where(and(...conditions))
      .orderBy(desc(alertEvents.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(alertEvents)
      .where(and(...conditions)),
    db
      .select({ status: alertEvents.status, severity: alertEvents.severity, count: sql<number>`count(*)::int` })
      .from(alertEvents)
      .where(like(alertEvents.rule, `${ESCALATION_RULE_PREFIX}%`))
      .groupBy(alertEvents.status, alertEvents.severity),
  ]);

  const counts = { open: 0, acknowledged: 0, resolved: 0 };
  const bySeverity: Record<string, number> = {};
  for (const s of statusRows) {
    const n = Number(s.count);
    if (s.status === 'OPEN') counts.open += n;
    else if (s.status === 'ACKNOWLEDGED') counts.acknowledged += n;
    else if (s.status === 'RESOLVED') counts.resolved += n;
    bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + n;
  }

  const items: EscalationView[] = [];
  for (const row of rows) items.push(await toView(db, row));

  return { items, total: Number(totals[0]?.count ?? 0), counts, bySeverity, killSwitch: await isAiExecutionBlocked(db) };
}

export async function getEscalation(db: DB, id: string): Promise<EscalationView> {
  return toView(db, await loadCase(db, id));
}

/** Remaining open cases for the GM panel, newest first. */
export async function openEscalationCount(db: DB): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alertEvents)
    .where(and(like(alertEvents.rule, `${ESCALATION_RULE_PREFIX}%`), inArray(alertEvents.status, ['OPEN', 'ACKNOWLEDGED'])));
  return Number(rows[0]?.count ?? 0);
}

/** Last scan time, derived from the audit trail (no extra table needed). */
export async function lastScanAt(db: DB): Promise<string | null> {
  const rows = await db
    .select({ createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(eq(auditLogs.action, 'AI.ESCALATION_SCAN_RUN'))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return rows.length > 0 ? new Date(rows[0].createdAt).toISOString() : null;
}

export { ESCALATION_SEVERITIES, settledOf };
