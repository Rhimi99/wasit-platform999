import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Alert history. Every time a rule transitions to FIRING or back to RESOLVED we
 * persist one row, so "did we get paged, when, and with what evidence" is
 * answerable after the event without a separate monitoring stack.
 *
 * Evaluation happens on an interval; a rule that stays firing does not create a
 * new row each tick (transitions only), so the table stays small.
 */
export const alertEvents = pgTable(
  'alert_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rule: varchar('rule', { length: 80 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    summary: varchar('summary', { length: 300 }).notNull(),
    details: jsonb('details'),
    /** Set only when a notification was attempted; channel id + result. */
    notifiedChannel: varchar('notified_channel', { length: 40 }),
    notifiedResult: varchar('notified_result', { length: 20 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ruleIdx: index('alert_events_rule_idx').on(t.rule),
    statusIdx: index('alert_events_status_idx').on(t.status),
    createdIdx: index('alert_events_created_idx').on(t.createdAt),
  }),
);