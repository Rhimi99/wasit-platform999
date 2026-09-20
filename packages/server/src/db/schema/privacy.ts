import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const deletionStageEnum = pgEnum('deletion_stage', [
  'REQUESTED',
  'DEACTIVATED',
  'RETENTION',
  'REVIEW',
  'ELIGIBLE',
  'ANONYMIZED',
  'DELETED',
  'REJECTED',
]);

/**
 * Privacy module tables.
 * - consent_events: append-only history of every grant/revoke (the `consents`
 *   table keeps current state; this records the timeline).
 * - data_export_requests: audit + state for Data Export Readiness.
 * - data_deletion_requests: staged account-deletion workflow:
 *   REQUESTED → DEACTIVATED → RETENTION/REVIEW → ELIGIBLE → (DELETED | ANONYMIZED).
 *   Financially-required records (ledger/audit/disputes) are never deleted by this flow.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    consentType: varchar('consent_type', { length: 100 }).notNull(),
    action: varchar('action', { length: 20 }).notNull(), // GRANT | REVOKE
    granted: boolean('granted').notNull(),
    actorId: varchar('actor_id', { length: 36 }),
    fromGranted: boolean('from_granted'),
    source: varchar('source', { length: 40 }).notNull().default('USER'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('consent_events_user_idx').on(t.userId),
    typeIdx: index('consent_events_type_idx').on(t.consentType),
    createdIdx: index('consent_events_created_idx').on(t.createdAt),
  }),
);

export const dataExportRequests = pgTable(
  'data_export_requests',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    requestedBy: varchar('requested_by', { length: 36 }).notNull(),
    format: varchar('format', { length: 10 }).notNull().default('json'),
    status: varchar('status', { length: 20 }).notNull().default('COMPLETED'),
    scope: jsonb('scope'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('data_export_requests_user_idx').on(t.userId),
    createdIdx: index('data_export_requests_created_idx').on(t.createdAt),
  }),
);

export const dataDeletionRequests = pgTable(
  'data_deletion_requests',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    requestedBy: varchar('requested_by', { length: 36 }).notNull(),
    reason: text('reason'),
    stage: deletionStageEnum('stage').notNull().default('REQUESTED'),
    retentionPolicy: jsonb('retention_policy'),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    reviewedBy: varchar('reviewed_by', { length: 36 }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    /** Manifest of the fields scrubbed by the anonymization run. */
    anonymizationLog: jsonb('anonymization_log'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('data_deletion_requests_user_idx').on(t.userId),
    stageIdx: index('data_deletion_requests_stage_idx').on(t.stage),
  }),
);