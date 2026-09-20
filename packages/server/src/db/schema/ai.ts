import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const aiRequests = pgTable(
  'ai_requests',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    requestType: varchar('request_type', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    cost: numeric('cost', { precision: 18, scale: 10 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    status: varchar('status', { length: 30 }).notNull().default('SUCCESS'),
    latencyMs: integer('latency_ms').notNull().default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('ai_requests_user_idx').on(t.userId),
    typeIdx: index('ai_requests_type_idx').on(t.requestType),
    createdIdx: index('ai_requests_created_idx').on(t.createdAt),
  }),
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull().default(0),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    cost: numeric('cost', { precision: 18, scale: 10 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
  },
  (t) => ({
    userPeriodIdx: index('ai_usage_user_period_idx').on(t.userId, t.periodStart, t.periodEnd),
  }),
);

export const aiBudgets = pgTable(
  'ai_budgets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }),
    roleTarget: varchar('role_target', { length: 50 }),
    period: varchar('period', { length: 20 }).notNull().default('MONTHLY'),
    maxRequests: integer('max_requests'),
    maxTokensInput: integer('max_tokens_input'),
    maxTokensOutput: integer('max_tokens_output'),
    maxCost: numeric('max_cost', { precision: 18, scale: 10 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('ai_budgets_user_idx').on(t.userId),
  }),
);

/**
 * Model Catalogue — pricing/provider metadata for every routable model.
 * Admin-configurable via CRUD (no hardcoded provider coupling in the core).
 */
export const aiModels = pgTable(
  'ai_models',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    key: varchar('key', { length: 100 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    contextWindow: integer('context_window').notNull().default(0),
    maxOutputTokens: integer('max_output_tokens').notNull().default(0),
    inputPer1k: numeric('input_per_1k', { precision: 18, scale: 10 }).notNull().default('0'),
    outputPer1k: numeric('output_per_1k', { precision: 18, scale: 10 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modelKeyIdx: index('ai_models_key_idx').on(t.key),
  }),
);