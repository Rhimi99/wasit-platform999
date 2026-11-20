import { check, foreignKey, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sellerTypeEnum } from './products';
import { sellerOrders } from './commerce';

/**
 * PS-02 — Seller Payout persistence.
 *
 * Payout is an independent lifecycle, never aliased to Payment or Settlement.
 * `COMPLETED` is guarded at the database level: it cannot be written without a
 * transfer reference (`payout_ref`), so `Settlement ≠ Payout`.
 *
 * The unique indexes encode the retry-vs-duplicate distinction:
 *  - one ACTIVE payout per transaction (a retry only starts after the previous
 *    attempt reached a terminal FAILED state);
 *  - one COMPLETED payout per transaction (no double completion);
 *  - `payout_ref` and `(provider, provider_ref)` are unique so a replayed
 *    provider transfer can never be recorded twice.
 */
export const payoutStatusEnum = pgEnum('payout_status', [
  'CREATED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'HELD',
]);

export const payouts = pgTable(
  'payouts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    // M2.2 — the seller suborder this payout settles. NULL for legacy
    // single-seller payouts (pre-M2 orders have no suborders); set for every
    // payout of a multi-seller parent. The composite FK below proves the
    // suborder belongs to the same order AND the same seller.
    sellerOrderId: varchar('seller_order_id', { length: 36 }),
    // The seller is an ENTITY (supplier/merchant/company), mirroring
    // orders.sellerId + orders.sellerType — never a users.id.
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    provider: varchar('provider', { length: 100 }).notNull(),
    status: payoutStatusEnum('status').notNull().default('CREATED'),
    // Set only when the transfer is proven; the CHECK below enforces it on COMPLETED.
    payoutRef: varchar('payout_ref', { length: 200 }),
    providerRef: varchar('provider_ref', { length: 200 }),
    failureReason: text('failure_reason'),
    // Caller-supplied key: replaying the same request returns the same payout.
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    idemIdx: uniqueIndex('payouts_idem_idx').on(t.idempotencyKey),
    payoutRefIdx: uniqueIndex('payouts_payout_ref_idx')
      .on(t.payoutRef)
      .where(sql`${t.payoutRef} is not null`),
    providerRefIdx: uniqueIndex('payouts_provider_ref_idx')
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} is not null`),
    // M2.2 — the legacy per-transaction uniqueness indexes (`payouts_active_tx_idx`
    // and `payouts_completed_tx_idx`) are removed: keyed on `transaction_id` alone,
    // they would forbid a second seller's payout on the same multi-seller parent
    // transaction. `payouts_unit_live_idx` below subsumes them — for a legacy row
    // it keys on `transaction_id` exactly as they did, and it additionally closes
    // the live-vs-completed gap.
    orderIdx: index('payouts_order_idx').on(t.orderId),
    sellerIdx: index('payouts_seller_idx').on(t.sellerId, t.sellerType),
    statusIdx: index('payouts_status_idx').on(t.status),
    // M2.2 — one live-or-completed payout per payout unit. The unit is the
    // seller suborder when set, else the (legacy) transaction. The CASE prefix
    // keeps the two id spaces apart, so a suborder id can never collide with an
    // unrelated transaction id. FAILED is deliberately excluded so a retry can
    // start a new attempt, while CREATED/PROCESSING/HELD/COMPLETED all block
    // any second attempt for the same unit — including a live attempt alongside
    // a completed one.
    unitLiveIdx: uniqueIndex('payouts_unit_live_idx')
      .on(
        sql`(CASE WHEN ${t.sellerOrderId} IS NOT NULL THEN 'S:' || ${t.sellerOrderId} ELSE 'T:' || ${t.transactionId} END)`,
      )
      .where(sql`${t.status} in ('CREATED','PROCESSING','HELD','COMPLETED')`),
    // A COMPLETED payout must carry the transfer reference that proves it.
    completedRequiresRef: check(
      'payouts_completed_requires_ref',
      sql`${t.status} <> 'COMPLETED' or ${t.payoutRef} is not null`,
    ),
    // M2.2 — a payout's suborder must belong to the same order AND the same
    // seller. MATCH SIMPLE (the default) leaves legacy rows with a NULL
    // `seller_order_id` entirely unaffected.
    suborderFk: foreignKey({
      columns: [t.sellerOrderId, t.orderId, t.sellerId],
      foreignColumns: [sellerOrders.id, sellerOrders.parentOrderId, sellerOrders.sellerId],
      name: 'payouts_suborder_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
  }),
);
