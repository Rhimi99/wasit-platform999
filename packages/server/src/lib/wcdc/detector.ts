import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { securityEvents, securityIncidents } from '../../db/schema/security';
import { newId } from '../ids';
import { metrics } from '../observability/metrics';
import {
  fingerprintOf,
  riskScore,
  ruleById,
  type IncidentStatus,
  type SecuritySeverity,
  type SecuritySource,
} from './types';

/**
 * Threat Detection Engine.
 *
 * A signal becomes an event; events of the same rule from the same subject are
 * folded into one incident while the rule's window is open. That keeps the GM
 * screen readable under a flood (one row that counts 4,000 hits, not 4,000 rows)
 * and keeps the audit trail complete, because every event is still stored.
 */

export interface IngestInput {
  ruleId: string;
  source?: SecuritySource;
  severity?: SecuritySeverity;
  actorId?: string | null;
  actorRoles?: string[] | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  method?: string | null;
  route?: string | null;
  statusCode?: number | null;
  tenantId?: string | null;
  sessionHash?: string | null;
  traceId?: string | null;
  fingerprintParts?: ReadonlyArray<string | null | undefined>;
  metadata?: Record<string, unknown> | null;
}

export interface IngestResult {
  eventId: string;
  incidentId: string;
  ruleId: string;
  severity: SecuritySeverity;
  /** True when this signal opened a new incident rather than joining one. */
  opened: boolean;
}

/** Subject used to group signals: the account when known, else the address. */
export function subjectKeyFor(input: { actorId?: string | null; ipAddress?: string | null }): string {
  if (input.actorId) return `user:${input.actorId}`;
  return `ip:${input.ipAddress ?? 'unknown'}`;
}

export async function ingestEvent(db: DB, input: IngestInput): Promise<IngestResult> {
  const rule = ruleById(input.ruleId);
  if (!rule) throw new Error(`Unknown security rule: ${input.ruleId}`);

  const severity = input.severity ?? rule.severity;
  const subjectKey = subjectKeyFor(input);
  const fingerprint = fingerprintOf(input.fingerprintParts ?? [rule.id, subjectKey, input.route]);
  const now = new Date();
  const windowStart = new Date(now.getTime() - rule.windowSeconds * 1000);

  const [openIncident] = await db
    .select()
    .from(securityIncidents)
    .where(
      and(
        eq(securityIncidents.ruleId, rule.id),
        eq(securityIncidents.subjectKey, subjectKey),
        inArray(securityIncidents.status, ['OPEN', 'ACKNOWLEDGED']),
        sql`${securityIncidents.lastSeenAt} >= ${windowStart.toISOString()}`,
      ),
    )
    .orderBy(desc(securityIncidents.lastSeenAt))
    .limit(1);

  let incidentId: string;
  let opened = false;

  if (openIncident) {
    incidentId = openIncident.id;
    const eventCount = openIncident.eventCount + 1;
    await db
      .update(securityIncidents)
      .set({
        eventCount,
        lastSeenAt: now,
        updatedAt: now,
        severity: higherSeverity(openIncident.severity, severity),
        riskScore: riskScore({
          severity: higherSeverity(openIncident.severity, severity),
          eventCount,
          status: openIncident.status,
        }),
      })
      .where(eq(securityIncidents.id, incidentId));
  } else {
    opened = true;
    incidentId = newId();
    await db.insert(securityIncidents).values({
      id: incidentId,
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      severity,
      status: 'OPEN',
      riskScore: riskScore({ severity, eventCount: 1, status: 'OPEN' }),
      actorId: input.actorId ?? null,
      ipAddress: input.ipAddress ?? null,
      subjectKey,
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      summary: null,
    });
    metrics.incCounter('wasit_wcdc_incidents_opened_total', { rule: rule.id, severity });
  }

  const eventId = newId();
  await db.insert(securityEvents).values({
    id: eventId,
    occurredAt: now,
    source: input.source ?? 'HTTP',
    category: rule.category,
    ruleId: rule.id,
    severity,
    actorId: input.actorId ?? null,
    actorRoles: input.actorRoles ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    method: input.method ?? null,
    route: input.route ? input.route.slice(0, 300) : null,
    statusCode: input.statusCode ?? null,
    tenantId: input.tenantId ?? null,
    sessionHash: input.sessionHash ?? null,
    traceId: input.traceId ?? null,
    fingerprint,
    metadata: input.metadata ?? null,
    incidentId,
  });

  metrics.incCounter('wasit_wcdc_events_total', { rule: rule.id, severity });
  return { eventId, incidentId, ruleId: rule.id, severity, opened };
}

const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function higherSeverity(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** Recomputes the score after a status change (contained incidents score lower). */
export function rescored(status: IncidentStatus, severity: SecuritySeverity, eventCount: number): number {
  return riskScore({ severity, eventCount, status });
}
