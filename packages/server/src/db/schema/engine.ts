import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------- Commission / Policy Engine ----------

export const commissionPolicyTypeEnum = pgEnum('commission_policy_type', [
  'BASE',
  'ACCOUNT_TYPE',
  'B2B_B2C',
  'TRANSACTION_VALUE',
  'VOLUME',
  'COUNTRY',
  'CURRENCY',
  'SECTOR',
  'PRODUCT',
  'SUBSCRIPTION',
  'VERIFICATION',
  'ACTIVITY',
]);

export const commissionPolicies = pgTable(
  'commission_policies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    policyType: commissionPolicyTypeEnum('policy_type').notNull().default('BASE'),
    // Total rate as decimal fraction e.g. 0.04 = 4%. Kept in sync with
    // seller + buyer shares by the seed/Admin layer; the engine derives the total.
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    // Who bears each part of the total. sellerRate + buyerRate === rate.
    sellerRate: numeric('seller_rate', { precision: 9, scale: 6 }).notNull().default('0'),
    buyerRate: numeric('buyer_rate', { precision: 9, scale: 6 }).notNull().default('0'),
    // Optional conditions (JSON): { accountType, minValue, maxValue, countryCode, currency, sector, productId, ... }
    conditions: jsonb('conditions'),
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdById: varchar('created_by_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('commission_policies_name_idx').on(t.name),
    activeIdx: index('commission_policies_active_idx').on(t.isActive),
  }),
);

export const commissions = pgTable(
  'commissions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    policyId: varchar('policy_id', { length: 36 }),
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    payerId: varchar('payer_id', { length: 36 }).notNull(),
    beneficiaryId: varchar('beneficiary_id', { length: 36 }),
    status: varchar('status', { length: 30 }).notNull().default('PENDING'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txIdx: uniqueIndex('commissions_tx_idx').on(t.transactionId),
    policyIdx: index('commissions_policy_idx').on(t.policyId),
  }),
);

// Payment fee policies (separate from commission)
export const paymentFeePolicies = pgTable(
  'payment_fee_policies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    // fee as percentage (vendor fee e.g. 2.9%) or flat, or both
    percentRate: numeric('percent_rate', { precision: 9, scale: 6 }).notNull().default('0'),
    flatFee: numeric('flat_fee', { precision: 18, scale: 4 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('USD'),
    conditions: jsonb('conditions'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('payment_fee_policies_name_idx').on(t.name),
  }),
);

// Generic policy engine for business rules
export const policyScopeEnum = pgEnum('policy_scope', [
  'COMMISSION',
  'LIMITS',
  'VERIFICATION',
  'RISK',
  'DISPUTE',
  'ADVERTISING',
  'SUBSCRIPTION',
  'COUNTRY',
  'CATEGORY',
  'TRADE',
  'PRIVACY',
  'TAX',
]);

export const policies = pgTable(
  'policies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    scope: policyScopeEnum('scope').notNull(),
    code: varchar('code', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    // Rules stored as JSON
    rules: jsonb('rules').notNull(),
    countryId: varchar('country_id', { length: 36 }),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdById: varchar('created_by_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index('policies_scope_idx').on(t.scope),
    codeIdx: uniqueIndex('policies_code_idx').on(t.code, t.countryId),
  }),
);

/**
 * Tracks business rules that a country needs but that are not yet configured.
 *
 * When a country-scoped rule is absent and only the global policy applies, the
 * engine records the gap here as DECISION_REQUIRED rather than inventing a
 * country-specific rule. Admin/legal decide the actual value later; once a
 * country-scoped policy exists the row is marked RESOLVED.
 */
export const countryPolicyGaps = pgTable(
  'country_policy_gaps',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    countryId: varchar('country_id', { length: 36 }).notNull(),
    scope: policyScopeEnum('scope').notNull(),
    code: varchar('code', { length: 120 }).notNull(),
    status: varchar('status', { length: 30 }).notNull().default('DECISION_REQUIRED'),
    reason: text('reason'),
    metadata: jsonb('metadata'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    uniqueIdx: uniqueIndex('country_policy_gaps_unique_idx').on(t.countryId, t.scope, t.code),
    statusIdx: index('country_policy_gaps_status_idx').on(t.status),
  }),
);