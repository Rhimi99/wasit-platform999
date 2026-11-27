import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Spend limits for outbound AI calls (AI-05).
 *
 * A limit is scoped to the whole environment (`GLOBAL`), one provider, or one
 * agent, and applies to a calendar day or month (UTC). No row means no cap —
 * the platform ships with none, so no money ceiling is invented for the admin.
 */
export const aiSpendLimits = pgTable(
  'ai_spend_limits',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    environment: varchar('environment', { length: 30 }).notNull(),
    scope: varchar('scope', { length: 20 }).notNull(),
    /** Empty string for GLOBAL; the provider or agent key otherwise. */
    targetKey: varchar('target_key', { length: 100 }).notNull().default(''),
    period: varchar('period', { length: 20 }).notNull(),
    maxCost: numeric('max_cost', { precision: 18, scale: 10 }),
    maxRequests: integer('max_requests'),
    /** Fraction of the cap at which a warning is raised (0.8 = 80%). */
    warnRatio: numeric('warn_ratio', { precision: 5, scale: 4 }).notNull().default('0.8000'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    isActive: boolean('is_active').notNull().default(true),
    updatedBy: varchar('updated_by', { length: 36 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index('ai_spend_limits_scope_idx').on(t.environment, t.scope, t.period),
    uniqueScope: uniqueIndex('ai_spend_limits_unique_scope').on(
      t.environment,
      t.scope,
      t.targetKey,
      t.period,
    ),
  }),
);

/**
 * Authoritative, atomically updated spend counter per (environment, scope,
 * target, period). A reservation is a guarded upsert: it only moves when the
 * new total stays under the cap, so concurrent calls cannot both slip through.
 * Rows are never deleted; a period simply stops being consulted once it ends.
 */
export const aiSpendCounters = pgTable(
  'ai_spend_counters',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    environment: varchar('environment', { length: 30 }).notNull(),
    scope: varchar('scope', { length: 20 }).notNull(),
    targetKey: varchar('target_key', { length: 100 }).notNull().default(''),
    period: varchar('period', { length: 20 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    spent: numeric('spent', { precision: 18, scale: 10 }).notNull().default('0'),
    requests: integer('requests').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueCounter: uniqueIndex('ai_spend_counters_unique').on(
      t.environment,
      t.scope,
      t.targetKey,
      t.period,
      t.periodStart,
    ),
  }),
);

/**
 * One row per (limit, period, level) transition. The unique index makes the
 * alert idempotent: a retry or a second concurrent request cannot spam it.
 */
export const aiSpendAlerts = pgTable(
  'ai_spend_alerts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    environment: varchar('environment', { length: 30 }).notNull(),
    scope: varchar('scope', { length: 20 }).notNull(),
    targetKey: varchar('target_key', { length: 100 }).notNull().default(''),
    period: varchar('period', { length: 20 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    level: varchar('level', { length: 20 }).notNull(),
    spent: numeric('spent', { precision: 18, scale: 10 }).notNull(),
    limitAmount: numeric('limit_amount', { precision: 18, scale: 10 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueAlert: uniqueIndex('ai_spend_alerts_unique').on(
      t.environment,
      t.scope,
      t.targetKey,
      t.period,
      t.periodStart,
      t.level,
    ),
    createdIdx: index('ai_spend_alerts_created_idx').on(t.createdAt),
  }),
);
