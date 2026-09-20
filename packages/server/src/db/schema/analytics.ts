import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventName: varchar('event_name', { length: 100 }).notNull(),
    userId: varchar('user_id', { length: 36 }),
    sessionId: varchar('session_id', { length: 100 }),
    properties: jsonb('properties'),
    ipHash: varchar('ip_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('analytics_events_name_idx').on(t.eventName),
    createdIdx: index('analytics_events_created_idx').on(t.createdAt),
    userIdx: index('analytics_events_user_idx').on(t.userId),
  }),
);

export const dailyKpis = pgTable(
  'daily_kpis',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    date: timestamp('date', { withTimezone: true }).notNull(),
    metricName: varchar('metric_name', { length: 100 }).notNull(),
    metricValue: numeric('metric_value', { precision: 18, scale: 4 }).notNull(),
    dimensions: jsonb('dimensions'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dateMetricIdx: index('daily_kpis_date_name_idx').on(t.date, t.metricName),
  }),
);

export const dashboardReports = pgTable(
  'dashboard_reports',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    reportCode: varchar('report_code', { length: 100 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    reportData: jsonb('report_data'),
    generatedById: varchar('generated_by_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: index('dashboard_reports_code_idx').on(t.reportCode),
  }),
);