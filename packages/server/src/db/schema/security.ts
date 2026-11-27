import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * WCDC-01 — the security centre's own records.
 *
 * These tables hold observations and decisions, never credentials: no session
 * token, no request body, no password, no API key. A row points at an actor, an
 * address, a route and a rule; the evidence is a pattern name and a fingerprint.
 */

export const securitySeverityEnum = pgEnum('security_severity', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

export const securityEventSourceEnum = pgEnum('security_event_source', [
  'HTTP',
  'AUTH',
  'AI',
  'MEDIA',
  'ADMIN',
  'SYSTEM',
]);

export const securityIncidentStatusEnum = pgEnum('security_incident_status', [
  'OPEN',
  'ACKNOWLEDGED',
  'CONTAINED',
  'RESOLVED',
  'CLOSED',
]);

export const securityActionTypeEnum = pgEnum('security_action_type', [
  'RATE_LIMIT_TIGHTEN',
  'BLOCK_IP',
  'UNBLOCK_IP',
  'REVOKE_SESSION',
  'QUARANTINE_ASSET',
  'ESCALATE',
  'NOTIFY_GM',
  'AI_KILL_SWITCH',
  // A request for an operation WCDC may never perform (RBAC/MFA/data/money).
  // Stored so the attempt is visible instead of looking like an unknown action.
  'FORBIDDEN_OPERATION',
]);

export const securityActionStatusEnum = pgEnum('security_action_status', [
  'EXECUTED',
  'REQUIRES_APPROVAL',
  'REFUSED',
  'FAILED',
]);

export const securityBlockKindEnum = pgEnum('security_block_kind', ['IP', 'SESSION']);

export const securityEvents = pgTable(
  'security_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    source: securityEventSourceEnum('source').notNull().default('HTTP'),
    category: varchar('category', { length: 32 }).notNull(),
    ruleId: varchar('rule_id', { length: 60 }).notNull(),
    severity: securitySeverityEnum('severity').notNull(),
    actorId: varchar('actor_id', { length: 36 }),
    actorRoles: jsonb('actor_roles'),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    method: varchar('method', { length: 10 }),
    route: varchar('route', { length: 300 }),
    statusCode: integer('status_code'),
    tenantId: varchar('tenant_id', { length: 36 }),
    /** Hash of the session token — never the token itself. */
    sessionHash: varchar('session_hash', { length: 64 }),
    traceId: varchar('trace_id', { length: 64 }),
    /** Non-reversible grouping key; no payload text is stored. */
    fingerprint: varchar('fingerprint', { length: 32 }).notNull(),
    metadata: jsonb('metadata'),
    incidentId: varchar('incident_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    occurredIdx: index('security_events_occurred_idx').on(t.occurredAt),
    ruleIdx: index('security_events_rule_idx').on(t.ruleId, t.occurredAt),
    actorIdx: index('security_events_actor_idx').on(t.actorId, t.occurredAt),
    ipIdx: index('security_events_ip_idx').on(t.ipAddress, t.occurredAt),
    fingerprintIdx: index('security_events_fingerprint_idx').on(t.fingerprint, t.occurredAt),
    incidentIdx: index('security_events_incident_idx').on(t.incidentId),
  }),
);

export const securityIncidents = pgTable(
  'security_incidents',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ruleId: varchar('rule_id', { length: 60 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    severity: securitySeverityEnum('severity').notNull(),
    status: securityIncidentStatusEnum('status').notNull().default('OPEN'),
    riskScore: integer('risk_score').notNull().default(0),
    actorId: varchar('actor_id', { length: 36 }),
    ipAddress: varchar('ip_address', { length: 64 }),
    /** Stable grouping key: actor when known, otherwise the source address. */
    subjectKey: varchar('subject_key', { length: 80 }).notNull(),
    eventCount: integer('event_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    summary: text('summary'),
    /** What was actually done, with ids, so a reviewer can verify it. */
    containment: jsonb('containment'),
    assignedToId: varchar('assigned_to_id', { length: 36 }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('security_incidents_status_idx').on(t.status, t.severity),
    subjectIdx: index('security_incidents_subject_idx').on(t.ruleId, t.subjectKey, t.status),
    lastSeenIdx: index('security_incidents_last_seen_idx').on(t.lastSeenAt),
  }),
);

export const securityActions = pgTable(
  'security_actions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    incidentId: varchar('incident_id', { length: 36 }),
    actionType: securityActionTypeEnum('action_type').notNull(),
    status: securityActionStatusEnum('status').notNull(),
    /** `AUTO` only when a policy explicitly allowed it for this rule. */
    mode: varchar('mode', { length: 8 }).notNull().default('MANUAL'),
    target: varchar('target', { length: 200 }),
    reason: text('reason'),
    requestedById: varchar('requested_by_id', { length: 36 }),
    approvedById: varchar('approved_by_id', { length: 36 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    incidentIdx: index('security_actions_incident_idx').on(t.incidentId),
    statusIdx: index('security_actions_status_idx').on(t.status, t.createdAt),
  }),
);

export const securityBlocks = pgTable(
  'security_blocks',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    kind: securityBlockKindEnum('kind').notNull(),
    target: varchar('target', { length: 120 }).notNull(),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdById: varchar('created_by_id', { length: 36 }),
    actionId: varchar('action_id', { length: 36 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index('security_blocks_target_idx').on(t.kind, t.target),
    expiryIdx: index('security_blocks_expiry_idx').on(t.expiresAt),
  }),
);
