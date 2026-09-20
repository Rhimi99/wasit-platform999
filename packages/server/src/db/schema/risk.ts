import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const riskLevelEnum = pgEnum('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'SEVERE']);

export const riskEvents = pgTable(
  'risk_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    severity: riskLevelEnum('severity').notNull().default('LOW'),
    riskScore: integer('risk_score').notNull().default(0),
    reasonCode: varchar('reason_code', { length: 100 }).notNull(),
    recommendedAction: varchar('recommended_action', { length: 200 }),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('risk_events_user_idx').on(t.userId),
    severityIdx: index('risk_events_severity_idx').on(t.severity),
    typeIdx: index('risk_events_type_idx').on(t.eventType),
  }),
);

export const riskProfiles = pgTable(
  'risk_profiles',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    currentScore: integer('current_score').notNull().default(0),
    level: riskLevelEnum('level').notNull().default('LOW'),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    flags: jsonb('flags'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('risk_profiles_user_idx').on(t.userId),
  }),
);