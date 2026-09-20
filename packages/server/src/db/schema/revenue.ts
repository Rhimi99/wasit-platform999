import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Revenue & Profitability — operating cost/income lines and scenario reports.
//
// These tables ONLY capture WASIT's own operating P&L lines (infrastructure
// cost, payment-provider pass-throughs, etc.) plus saved scenario reports.
// They do NOT hold user funds and they do NOT duplicate the transactional
// tables (transactions / transaction_ledger / commissions / subscriptions /
// campaigns / ad_events / ai_usage). All transaction-derived revenue is read
// from those existing tables so every number remains auditable.
// ---------------------------------------------------------------------------

export const revenueLineTypeEnum = pgEnum('revenue_line_type', ['REVENUE', 'COST']);

export const revenueLineCategoryEnum = pgEnum('revenue_line_category', [
  'INFRASTRUCTURE',
  'PAYMENT_PROVIDER',
  'AI_MODEL',
  'MARKETING',
  'SUPPORT',
  'LEGAL',
  'OTHER',
]);

export const revenueAccounts = pgTable(
  'revenue_accounts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    lineType: revenueLineTypeEnum('line_type').notNull().default('COST'),
    category: revenueLineCategoryEnum('category').notNull().default('OTHER'),
    name: varchar('name', { length: 200 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    // Optional linkage to a real transaction/order/ledger reference (auditability).
    referenceType: varchar('reference_type', { length: 40 }),
    referenceId: varchar('reference_id', { length: 36 }),
    description: text('description'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: varchar('created_by_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    refIdx: index('revenue_accounts_ref_idx').on(t.referenceType, t.referenceId),
    occurredIdx: index('revenue_accounts_occurred_idx').on(t.occurredAt),
    categoryIdx: index('revenue_accounts_category_idx').on(t.category),
  }),
);

export const scenarioStatusEnum = pgEnum('scenario_status', ['PLANNING', 'SAVED']);

export const scenarioReports = pgTable(
  'scenario_reports',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    status: scenarioStatusEnum('status').notNull().default('PLANNING'),
    // Inputs snapshot (JSON) — the scenario assumptions.
    inputs: jsonb('inputs').notNull(),
    // Computed outputs snapshot (JSON) — NOT a profit guarantee, planning only.
    outputs: jsonb('outputs').notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    createdById: varchar('created_by_id', { length: 36 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    creatorIdx: index('scenario_reports_creator_idx').on(t.createdById),
    createdIdx: index('scenario_reports_created_idx').on(t.createdAt),
  }),
);