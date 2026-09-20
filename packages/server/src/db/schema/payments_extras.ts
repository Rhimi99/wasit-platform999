import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Payment provider lifecycle. The provider is abstracted behind a port
 * (see `lib/payments/port.ts`), so the concrete vendor is never hardcoded here.
 */
export const paymentIntentStatusEnum = pgEnum('payment_intent_status', [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    // A payment intent targets either a marketplace order or a subscription
    // invoice. Both are nullable because exactly one is set; the shared
    // provider/idempotency machinery is what makes reusing this table correct.
    orderId: varchar('order_id', { length: 36 }),
    subscriptionId: varchar('subscription_id', { length: 36 }),
    transactionId: varchar('transaction_id', { length: 36 }),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    /** Payer-chosen method family: CARD or MOBILE_WALLET. */
    method: varchar('method', { length: 20 }),
    /** Scheme within the family (VISA/MASTERCARD/CIB/D17/FLOUCI_WALLET). */
    scheme: varchar('scheme', { length: 20 }),
    // Provider-side idempotency key so retries never create a second charge.
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    // Opaque provider reference (intent id / checkout session id).
    externalRef: varchar('external_ref', { length: 200 }),
    status: paymentIntentStatusEnum('status').notNull().default('CREATED'),
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One intent per order+idempotency key: retries are idempotent.
    idemIdx: uniqueIndex('payment_intents_idem_idx').on(t.idempotencyKey),
    orderIdx: index('payment_intents_order_idx').on(t.orderId),
    subscriptionIdx: index('payment_intents_subscription_idx').on(t.subscriptionId),
    externalIdx: index('payment_intents_external_idx').on(t.externalRef),
  }),
);

/**
 * Raw provider webhook events. The unique provider+eventId constraint is the
 * idempotency guard: replaying an event must never apply a side-effect twice.
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    provider: varchar('provider', { length: 100 }).notNull(),
    eventId: varchar('event_id', { length: 200 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    signatureValid: varchar('signature_valid', { length: 10 }).notNull().default('false'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: uniqueIndex('payment_webhook_events_provider_event_idx').on(t.provider, t.eventId),
    typeIdx: index('payment_webhook_events_type_idx').on(t.eventType),
  }),
);