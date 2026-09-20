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
  varchar,
} from 'drizzle-orm/pg-core';

export const planTargetEnum = pgEnum('plan_target', [
  'CUSTOMER',
  'MERCHANT',
  'SUPPLIER',
  'COMPANY',
  'GLOBAL',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'TRIAL',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
]);

export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    code: varchar('code', { length: 60 }).notNull(),
    name: varchar('name', { length: 150 }).notNull(),
    nameAr: varchar('name_ar', { length: 150 }),
    nameFr: varchar('name_fr', { length: 150 }),
    planTarget: planTargetEnum('plan_target').notNull(),
    priceMonthly: numeric('price_monthly', { precision: 18, scale: 4 }).notNull().default('0'),
    priceYearly: numeric('price_yearly', { precision: 18, scale: 4 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    // Features stored as JSON
    features: jsonb('features'),
    limits: jsonb('limits'),
    isActive: boolean('is_active').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: index('subscription_plans_code_idx').on(t.code),
  }),
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    planId: varchar('plan_id', { length: 36 }).notNull(),
    status: subscriptionStatusEnum('status').notNull().default('TRIAL'),
    billingCycle: varchar('billing_cycle', { length: 20 }).notNull().default('MONTHLY'),
    autoRenew: boolean('auto_renew').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('subscriptions_user_idx').on(t.userId),
    statusIdx: index('subscriptions_status_idx').on(t.status),
  }),
);

export const invoices = pgTable(
  'invoices',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    subscriptionId: varchar('subscription_id', { length: 36 }).notNull(),
    invoiceNumber: varchar('invoice_number', { length: 40 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    status: varchar('status', { length: 30 }).notNull().default('PENDING'),
    externalRef: varchar('external_ref', { length: 200 }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subscriptionIdx: index('invoices_subscription_idx').on(t.subscriptionId),
  }),
);