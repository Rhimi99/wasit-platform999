import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import {
  securityActions,
  securityBlocks,
  securityEvents,
  securityIncidents,
} from '../../db/schema/security';
import { auditLogs } from '../../db/schema/audit';
import { mediaAssets } from '../../db/schema/media';
import { aiExecutionSwitches } from '../../db/schema/ai-execution-switch';
import { sessions, users } from '../../db/schema/auth';
import { env } from '../../lib/env';
import { recordSecurityEvent } from '../../lib/wcdc/collector';
import { resolveWcdcPolicy, type WcdcPolicy } from '../../lib/wcdc/policy';
import {
  postureLevel,
  riskScore,
  SECURITY_RULES,
  type IncidentStatus,
  type PostureLevel,
  type SecuritySeverity,
} from '../../lib/wcdc/types';

/**
 * WCDC read model and audit-derived collection.
 *
 * The GM screen reads only what is actually stored. Where a number cannot be
 * known (a volumetric DDoS absorbed upstream, for example) the field says so
 * instead of inventing a figure.
 */

export interface OverviewCounts {
  events24h: number;
  incidentsOpen: number;
  incidentsContained: number;
  incidentsResolved24h: number;
  criticalOpen: number;
  blockedAddresses: number;
  atRiskSessions: number;
  pendingApprovals: number;
}

export interface SecurityOverview {
  posture: {
    level: PostureLevel;
    score: number;
    basis: 'open-incidents' | 'recent-events' | 'none';
    worstRule: string | null;
  };
  counts: OverviewCounts;
  bySeverity: Record<SecuritySeverity, number>;
  topRules: Array<{ ruleId: string; title: string; count: number; severity: SecuritySeverity }>;
  protection: {
    api: {
      enabled: boolean;
      blockedAddresses: number;
      tightened: 'policy' | 'none';
      /** Where the client address comes from, so an operator can see whether
       *  address-based controls can act at all in this deployment. */
      addressControls: 'forwarded' | 'socket';
    };
    uploads: { rejected24h: number; quarantinedAssets: number };
    agents: { outOfScope24h: number; aiExecutionStopped: boolean | null };
    audit: { tamperAttempts24h: number; lastWriteAt: string | null };
    edge: {
      provider: string;
      note: string | null;
      providerConfigured: boolean;
      coversVolumetric: boolean;
    };
  };
  policy: {
    autoContainment: WcdcPolicy['autoContainment'];
    source: WcdcPolicy['source'];
    policyId: string | null;
    version: number | null;
    burstMax: number;
    burstWindowSeconds: number;
    blockTtlMinutes: number;
  };
  generatedAt: string;
}

async function scalar(db: DB, query: Promise<Array<{ n: number }>>): Promise<number> {
  const rows = await query;
  return Number(rows[0]?.n ?? 0);
}

export async function securityOverview(db: DB): Promise<SecurityOverview> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const policy = await resolveWcdcPolicy(db);

  const [
    events24h,
    criticalOpen,
    incidentsOpen,
    incidentsContained,
    incidentsResolved24h,
    blockedAddresses,
    pendingApprovals,
    tamperAttempts,
    uploadsRejected,
    agentViolations,
  ] = await Promise.all([
    scalar(db, db.select({ n: sql<number>`count(*)::int` }).from(securityEvents).where(gte(securityEvents.occurredAt, since))),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityIncidents)
        .where(and(eq(securityIncidents.severity, 'CRITICAL'), inArray(securityIncidents.status, ['OPEN', 'ACKNOWLEDGED']))),
    ),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityIncidents)
        .where(inArray(securityIncidents.status, ['OPEN', 'ACKNOWLEDGED'])),
    ),
    scalar(db, db.select({ n: sql<number>`count(*)::int` }).from(securityIncidents).where(eq(securityIncidents.status, 'CONTAINED'))),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityIncidents)
        .where(and(eq(securityIncidents.status, 'RESOLVED'), gte(securityIncidents.updatedAt, since))),
    ),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityBlocks)
        .where(and(eq(securityBlocks.kind, 'IP'), isNull(securityBlocks.revokedAt), gte(securityBlocks.expiresAt, new Date()))),
    ),
    scalar(db, db.select({ n: sql<number>`count(*)::int` }).from(securityActions).where(eq(securityActions.status, 'REQUIRES_APPROVAL'))),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityEvents)
        .where(and(eq(securityEvents.ruleId, 'AUDIT_TAMPER_ATTEMPT'), gte(securityEvents.occurredAt, since))),
    ),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityEvents)
        .where(and(eq(securityEvents.ruleId, 'UPLOAD_REJECTED'), gte(securityEvents.occurredAt, since))),
    ),
    scalar(
      db,
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(securityEvents)
        .where(and(eq(securityEvents.ruleId, 'AGENT_SCOPE_VIOLATION'), gte(securityEvents.occurredAt, since))),
    ),
  ]);

  const bySeverityRows = await db
    .select({ severity: securityEvents.severity, n: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(gte(securityEvents.occurredAt, since))
    .groupBy(securityEvents.severity);
  const bySeverity: Record<SecuritySeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const row of bySeverityRows) bySeverity[row.severity] = Number(row.n);

  const topRuleRows = await db
    .select({
      ruleId: securityEvents.ruleId,
      severity: securityEvents.severity,
      n: sql<number>`count(*)::int`,
    })
    .from(securityEvents)
    .where(gte(securityEvents.occurredAt, since))
    .groupBy(securityEvents.ruleId, securityEvents.severity)
    .orderBy(desc(sql`count(*)`))
    .limit(6);
  const topRules = topRuleRows.map((row) => ({
    ruleId: row.ruleId,
    title: SECURITY_RULES[row.ruleId]?.title ?? row.ruleId,
    count: Number(row.n),
    severity: row.severity,
  }));

  const worst = await db
    .select({
      riskScore: securityIncidents.riskScore,
      ruleId: securityIncidents.ruleId,
      severity: securityIncidents.severity,
      eventCount: securityIncidents.eventCount,
      status: securityIncidents.status,
    })
    .from(securityIncidents)
    .where(inArray(securityIncidents.status, ['OPEN', 'ACKNOWLEDGED', 'CONTAINED']))
    .orderBy(desc(securityIncidents.riskScore))
    .limit(1);

  let score = 0;
  let basis: SecurityOverview['posture']['basis'] = 'none';
  let worstRule: string | null = null;
  if (worst.length > 0) {
    score = worst[0].riskScore;
    worstRule = worst[0].ruleId;
    basis = 'open-incidents';
  } else if (bySeverity.CRITICAL > 0 || bySeverity.HIGH > 0) {
    score = bySeverity.CRITICAL > 0 ? 60 : 35;
    basis = 'recent-events';
  }

  const [quarantined, aiStopped] = await Promise.all([
    scalar(db, db.select({ n: sql<number>`count(*)::int` }).from(mediaAssets).where(eq(mediaAssets.status, 'QUARANTINED'))),
    (async (): Promise<boolean | null> => {
      try {
        const [row] = await db
          .select({ stopped: aiExecutionSwitches.stopped })
          .from(aiExecutionSwitches)
          .where(eq(aiExecutionSwitches.scope, 'GLOBAL'))
          .limit(1);
        return typeof row?.stopped === 'boolean' ? row.stopped : null;
      } catch {
        return null;
      }
    })(),
  ]);

  const [lastAudit] = await db
    .select({ createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);

  const atRiskSessions = await countAtRiskSessions(db);

  return {
    posture: { level: postureLevel(score), score, basis, worstRule },
    counts: {
      events24h,
      incidentsOpen,
      incidentsContained,
      incidentsResolved24h,
      criticalOpen,
      blockedAddresses,
      atRiskSessions,
      pendingApprovals,
    },
    bySeverity,
    topRules,
    protection: {
      api: {
        enabled: env.WCDC_ENABLED === 'on',
        blockedAddresses,
        tightened: policy.autoContainment === 'limited' ? 'policy' : 'none',
        addressControls: env.TRUSTED_PROXY_HOPS > 0 ? 'forwarded' : 'socket',
      },
      uploads: { rejected24h: uploadsRejected, quarantinedAssets: quarantined },
      agents: { outOfScope24h: agentViolations, aiExecutionStopped: aiStopped },
      audit: { tamperAttempts24h: tamperAttempts, lastWriteAt: lastAudit?.createdAt?.toISOString() ?? null },
      edge: {
        provider: env.WCDC_EDGE_PROVIDER,
        note: env.WCDC_EDGE_NOTES ?? null,
        // Recording a provider is not evidence it absorbs a flood: WCDC cannot
        // verify the edge from here, so it never claims that it does.
        providerConfigured: env.WCDC_EDGE_PROVIDER !== 'none',
        coversVolumetric: false,
      },
    },
    policy: {
      autoContainment: policy.autoContainment,
      source: policy.source,
      policyId: policy.policyId,
      version: policy.policyVersion,
      burstMax: policy.burstMax,
      burstWindowSeconds: policy.burstWindowSeconds,
      blockTtlMinutes: policy.blockTtlMinutes,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function countAtRiskSessions(db: DB): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await db
    .select({ n: sql<number>`count(distinct ${securityEvents.sessionHash})::int` })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.ruleId, 'SESSION_ANOMALY'),
        gte(securityEvents.occurredAt, since),
        sql`${securityEvents.sessionHash} is not null`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export interface EventQuery {
  ruleId?: string;
  severity?: SecuritySeverity;
  source?: string;
  actorId?: string;
  ipAddress?: string;
  incidentId?: string;
  limit?: number;
  offset?: number;
}

export async function listEvents(db: DB, query: EventQuery) {
  const conditions = [];
  if (query.ruleId) conditions.push(eq(securityEvents.ruleId, query.ruleId));
  if (query.severity) conditions.push(eq(securityEvents.severity, query.severity));
  if (query.source) conditions.push(eq(securityEvents.source, query.source as 'HTTP'));
  if (query.actorId) conditions.push(eq(securityEvents.actorId, query.actorId));
  if (query.ipAddress) conditions.push(eq(securityEvents.ipAddress, query.ipAddress));
  if (query.incidentId) conditions.push(eq(securityEvents.incidentId, query.incidentId));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  const [items, countRows] = await Promise.all([
    db.select().from(securityEvents).where(where).orderBy(desc(securityEvents.occurredAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(securityEvents).where(where),
  ]);
  return { items, total: Number(countRows[0]?.n ?? 0), limit, offset };
}

export interface IncidentQuery {
  status?: IncidentStatus;
  severity?: SecuritySeverity;
  limit?: number;
  offset?: number;
}

export async function listIncidents(db: DB, query: IncidentQuery) {
  const conditions = [];
  if (query.status) conditions.push(eq(securityIncidents.status, query.status));
  if (query.severity) conditions.push(eq(securityIncidents.severity, query.severity));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const [items, countRows] = await Promise.all([
    db
      .select()
      .from(securityIncidents)
      .where(where)
      .orderBy(desc(securityIncidents.riskScore), desc(securityIncidents.lastSeenAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(securityIncidents).where(where),
  ]);
  return { items, total: Number(countRows[0]?.n ?? 0), limit, offset };
}

export async function getIncident(db: DB, id: string) {
  const [incident] = await db.select().from(securityIncidents).where(eq(securityIncidents.id, id)).limit(1);
  if (!incident) return null;
  const [events, actions] = await Promise.all([
    db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.incidentId, id))
      .orderBy(desc(securityEvents.occurredAt))
      .limit(50),
    db
      .select()
      .from(securityActions)
      .where(eq(securityActions.incidentId, id))
      .orderBy(desc(securityActions.createdAt))
      .limit(50),
  ]);
  return { incident, events, actions };
}

export async function updateIncidentStatus(
  db: DB,
  input: { id: string; status: IncidentStatus; note?: string | null },
) {
  const [current] = await db
    .select()
    .from(securityIncidents)
    .where(eq(securityIncidents.id, input.id))
    .limit(1);
  if (!current) return null;
  const score = riskScore({ severity: current.severity, eventCount: current.eventCount, status: input.status });
  const [updated] = await db
    .update(securityIncidents)
    .set({
      status: input.status,
      riskScore: score,
      resolutionNote: input.note ?? current.resolutionNote,
      updatedAt: new Date(),
    })
    .where(eq(securityIncidents.id, input.id))
    .returning();
  return updated;
}

export async function listActions(db: DB, query: { status?: string; incidentId?: string; limit?: number }) {
  const conditions = [];
  if (query.status) conditions.push(eq(securityActions.status, query.status as 'EXECUTED'));
  if (query.incidentId) conditions.push(eq(securityActions.incidentId, query.incidentId));
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  return db.select().from(securityActions).where(where).orderBy(desc(securityActions.createdAt)).limit(limit);
}

export interface AtRiskSession {
  sessionId: string;
  userId: string;
  email: string | null;
  sessionIp: string | null;
  lastSeenAt: string | null;
  addressesSeen: number;
}

export async function sessionsAtRisk(db: DB): Promise<AtRiskSession[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await db
    .select({
      sessionHash: securityEvents.sessionHash,
      lastSeenAt: sql<string | null>`max(${securityEvents.occurredAt})`,
      addresses: sql<number>`count(distinct ${securityEvents.ipAddress})::int`,
    })
    .from(securityEvents)
    .where(and(eq(securityEvents.ruleId, 'SESSION_ANOMALY'), gte(securityEvents.occurredAt, since)))
    .groupBy(securityEvents.sessionHash);

  if (rows.length === 0) return [];
  const hashes = rows.map((r) => r.sessionHash).filter((h): h is string => Boolean(h));
  if (hashes.length === 0) return [];

  const sessionRows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      ipAddress: sessions.ipAddress,
      tokenHash: sessions.tokenHash,
      email: users.email,
    })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.userId))
    .where(and(inArray(sessions.tokenHash, hashes), isNull(sessions.revokedAt)));

  const byHash = new Map(rows.filter((r) => r.sessionHash).map((r) => [r.sessionHash as string, r]));
  return sessionRows.map((row) => {
    const meta = byHash.get(row.tokenHash);
    return {
      sessionId: row.id,
      userId: row.userId,
      email: row.email,
      sessionIp: row.ipAddress,
      lastSeenAt: meta?.lastSeenAt ? new Date(meta.lastSeenAt).toISOString() : null,
      addressesSeen: Number(meta?.addresses ?? 0),
    };
  });
}

/**
 * Collector over the existing audit trail.
 *
 * Nothing new is instrumented: the auth, AI and media modules already record
 * refusals, lockouts and integrity failures. WCDC reads those rows and turns
 * them into security events, deduplicated by the audit row id so a repeated
 * scan cannot inflate an incident.
 */
const AUDIT_SIGNALS: Record<string, { ruleId: string; source: 'AUTH' | 'AI' | 'MEDIA' }> = {
  'AI.TOOL_REFUSED': { ruleId: 'AGENT_SCOPE_VIOLATION', source: 'AI' },
  'AI.AGENT_RUN_REFUSED': { ruleId: 'AGENT_SCOPE_VIOLATION', source: 'AI' },
  'AI.EXECUTION_CONTROL_REFUSED': { ruleId: 'AGENT_SCOPE_VIOLATION', source: 'AI' },
  'AI.KILL_SWITCH_ESCALATION_REFUSED': { ruleId: 'AGENT_SCOPE_VIOLATION', source: 'AI' },
  'AI.MEMORY_INTEGRITY_FAILED': { ruleId: 'INTEGRITY_FAILURE', source: 'AI' },
  'AUTH.ACCOUNT_LOCKED': { ruleId: 'AUTH_BRUTEFORCE', source: 'AUTH' },
  'AUTH.MFA_VERIFY_FAILED': { ruleId: 'AUTH_BRUTEFORCE', source: 'AUTH' },
  'AUTH.MFA_CHALLENGE_FAILED': { ruleId: 'AUTH_BRUTEFORCE', source: 'AUTH' },
};

export interface ScanResult {
  scanned: number;
  recorded: number;
  incidentsOpened: number;
  windowMinutes: number;
}

export async function scanAuditSignals(db: DB, windowMinutes = 60): Promise<ScanResult> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const actions = Object.keys(AUDIT_SIGNALS);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(inArray(auditLogs.action, actions), gte(auditLogs.createdAt, since)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(500);

  let recorded = 0;
  let incidentsOpened = 0;
  for (const row of rows) {
    const signal = AUDIT_SIGNALS[row.action];
    if (!signal) continue;
    const fingerprintParts = ['audit', row.id];
    const [existing] = await db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.ruleId, signal.ruleId),
          sql`${securityEvents.metadata}->>'auditId' = ${row.id}`,
        ),
      )
      .limit(1);
    if (existing) continue;

    const result = await recordSecurityEvent(db, {
      ruleId: signal.ruleId,
      source: signal.source,
      actorId: row.actorId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      route: row.entityType,
      metadata: {
        auditId: row.id,
        auditAction: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
      },
      fingerprintParts,
    });
    if (result) {
      recorded += 1;
      if (result.opened) incidentsOpened += 1;
    }
  }

  return { scanned: rows.length, recorded, incidentsOpened, windowMinutes };
}

export interface SecurityBlockRow {
  id: string;
  kind: 'IP' | 'SESSION';
  target: string;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

export async function listBlocks(
  db: DB,
  query: { activeOnly?: boolean; limit?: number; id?: string },
): Promise<SecurityBlockRow[]> {
  const conditions = [];
  if (query.activeOnly) {
    conditions.push(isNull(securityBlocks.revokedAt));
    conditions.push(sql`${securityBlocks.expiresAt} > now()`);
  }
  if (query.id) conditions.push(eq(securityBlocks.id, query.id));
  const rows = await db
    .select()
    .from(securityBlocks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(securityBlocks.createdAt))
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    target: row.target,
    reason: row.reason,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    active: !row.revokedAt && row.expiresAt.getTime() > now,
  }));
}

/**
 * Housekeeping: drop events past the retention window and blocks that expired
 * long ago. Retention is a promise the centre makes on the GM screen, so it is
 * enforced by the scheduler rather than left to an operator.
 */
export async function sweepWcdcData(db: DB): Promise<{ prunedEvents: number; prunedBlocks: number }> {
  const prunedEvents = await pruneSecurityEvents(db);
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const pruned = await db
    .delete(securityBlocks)
    .where(sql`${securityBlocks.expiresAt} < ${cutoff.toISOString()}`)
    .returning({ id: securityBlocks.id });
  return { prunedEvents, prunedBlocks: pruned.length };
}

/** Retention sweep; the scheduler calls it daily. */
export async function pruneSecurityEvents(db: DB, days = env.WCDC_EVENT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await db
    .delete(securityEvents)
    .where(sql`${securityEvents.occurredAt} < ${cutoff.toISOString()}`)
    .returning({ id: securityEvents.id });
  return rows.length;
}
