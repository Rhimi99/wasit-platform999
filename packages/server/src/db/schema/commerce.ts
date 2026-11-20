import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
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
import { sellerTypeEnum } from './products';

export const orderStatusEnum = pgEnum('order_status', [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'UNPAID',
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

export const refundStatusEnum = pgEnum('refund_status', [
  'NONE',
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

export const settlementStatusEnum = pgEnum('settlement_status', [
  'PENDING',
  'PROCESSING',
  'SETTLED',
  'HELD',
  'FAILED',
]);

export const buyerTypeEnum = pgEnum('buyer_type', ['CUSTOMER', 'MERCHANT', 'COMPANY']);

export const orders = pgTable(
  'orders',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderNumber: varchar('order_number', { length: 40 }).notNull(),
    buyerId: varchar('buyer_id', { length: 36 }).notNull(),
    buyerType: buyerTypeEnum('buyer_type').notNull().default('CUSTOMER'),
    // The order's single seller, when it has one. A multi-seller Parent Order has
    // no single seller: its per-seller identity lives on `seller_orders`, and
    // each of its line items carries its own `order_items.sellerId`. Kept
    // non-null for every pre-existing (single-seller) row; only a Parent Order
    // that spans several sellers leaves it null. See M2.
    sellerId: varchar('seller_id', { length: 36 }),
    sellerType: sellerTypeEnum('seller_type'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    itemsTotal: numeric('items_total', { precision: 18, scale: 4 }).notNull(),
    commission: numeric('commission', { precision: 18, scale: 4 }).notNull().default('0'),
    // The buyer's share of the WASIT commission. NOTE: `commission` already holds the
    // TOTAL Wasit commission (seller + buyer), so this is a split detail only — never
    // sum the two columns together in aggregations.
    buyerCommission: numeric('buyer_commission', { precision: 18, scale: 4 }).notNull().default('0'),
    paymentFee: numeric('payment_fee', { precision: 18, scale: 4 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 18, scale: 4 }).notNull(),
    status: orderStatusEnum('status').notNull().default('DRAFT'),
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('UNPAID'),
    refundStatus: refundStatusEnum('refund_status').notNull().default('NONE'),
    settlementStatus: settlementStatusEnum('settlement_status').notNull().default('PENDING'),
    notes: text('notes'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderNumberIdx: uniqueIndex('orders_order_number_idx').on(t.orderNumber),
    buyerIdx: index('orders_buyer_idx').on(t.buyerId, t.buyerType),
    sellerIdx: index('orders_seller_idx').on(t.sellerId, t.sellerType),
    statusIdx: index('orders_status_idx').on(t.status),
    // Buyer and seller order history is always "mine, newest first"; the sort
    // is not served by the plain buyer/seller index.
    buyerCreatedIdx: index('orders_buyer_created_idx').on(t.buyerId, t.createdAt),
    sellerCreatedIdx: index('orders_seller_created_idx').on(t.sellerId, t.createdAt),
  }),
);

/**
 * M2 — Seller Suborder.
 *
 * One row per (Parent Order, seller). It is the seller's commercial and
 * financial unit: their own line items, their own items total, their own
 * commission share, and their own fulfilment status. The Parent Order keeps the
 * buyer identity, the grand total and the single payment; the suborder carries
 * everything the seller is accountable for.
 *
 * `order_items.sellerOrderId` points at the suborder, and `sellerId` is
 * denormalised onto the line, so a line can never end up under another seller's
 * suborder: both are written together, in one insert, from one seller grouping,
 * and the composite foreign key below makes the pairing a database invariant.
 */
export const sellerOrders = pgTable(
  'seller_orders',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    parentOrderId: varchar('parent_order_id', { length: 36 }).notNull(),
    orderNumber: varchar('order_number', { length: 40 }).notNull(),
    // Human-readable per-seller reference, e.g. `<orderNumber>-S1`.
    sellerOrderNumber: varchar('seller_order_number', { length: 60 }).notNull(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    itemsTotal: numeric('items_total', { precision: 18, scale: 4 }).notNull().default('0'),
    // Total WASIT commission attributable to this seller's lines (seller + buyer
    // shares), mirroring `orders.commission`.
    commission: numeric('commission', { precision: 18, scale: 4 }).notNull().default('0'),
    // The buyer's share of that commission for this seller's lines. Never summed
    // with `commission` (which already contains both shares).
    buyerCommission: numeric('buyer_commission', { precision: 18, scale: 4 }).notNull().default('0'),
    // The seller's share of that commission (commission - buyerCommission).
    sellerCommission: numeric('seller_commission', { precision: 18, scale: 4 }).notNull().default('0'),
    // What the seller is owed for this suborder: itemsTotal - sellerCommission.
    sellerPayable: numeric('seller_payable', { precision: 18, scale: 4 }).notNull().default('0'),
    // Fulfilment state of this seller's part, independent of the parent.
    status: orderStatusEnum('status').notNull().default('PENDING'),
    // The suborder's own settlement state, independent of the parent's.
    settlementStatus: settlementStatusEnum('settlement_status').notNull().default('PENDING'),
    notes: text('notes'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One suborder per seller per parent order — this is what makes a retried
    // create idempotent rather than spawning a duplicate suborder.
    parentSellerIdx: uniqueIndex('seller_orders_parent_seller_idx').on(t.parentOrderId, t.sellerId),
    // Target for `order_items.suborderFk`: lets a line prove, at the database,
    // that its suborder belongs to the same order AND the same seller.
    identityIdx: uniqueIndex('seller_orders_identity_idx').on(t.id, t.parentOrderId, t.sellerId),
    // M2.4 — target for `refund_allocations.suborderFk`: proves an allocation's
    // order and currency are the suborder's own, so an allocation can never be
    // attributed to a suborder in a different order or a different currency. Its
    // column list must match the FK's referenced columns EXACTLY (PostgreSQL
    // requires a unique index of the same arity as the target). `id` is already
    // unique, so this wider key can never conflict on existing rows.
    identityCurrencyIdx: uniqueIndex('seller_orders_identity_currency_idx').on(
      t.id,
      t.parentOrderId,
      t.currencyCode,
    ),
    parentIdx: index('seller_orders_parent_idx').on(t.parentOrderId),
    sellerIdx: index('seller_orders_seller_idx').on(t.sellerId, t.sellerType),
    sellerCreatedIdx: index('seller_orders_seller_created_idx').on(t.sellerId, t.createdAt),
    statusIdx: index('seller_orders_status_idx').on(t.status),
  }),
);

export const orderItems = pgTable(
  'order_items',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    // The seller suborder this line belongs to (M2). Nullable so pre-existing
    // rows keep their exact shape; every new order writes it, and the composite
    // FK below proves the suborder actually belongs to the same seller and order.
    sellerOrderId: varchar('seller_order_id', { length: 36 }),
    // The seller that owns this line. Denormalised from the product at creation
    // time so a line's seller is provable without re-reading the product, and so
    // a line can never be attributed to a different seller's suborder.
    sellerId: varchar('seller_id', { length: 36 }),
    productId: varchar('product_id', { length: 36 }).notNull(),
    productVariantId: varchar('product_variant_id', { length: 36 }),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: numeric('line_total', { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
    sellerOrderIdx: index('order_items_seller_order_idx').on(t.sellerOrderId),
    sellerIdx: index('order_items_seller_idx').on(t.sellerId),
    // A line's suborder must belong to the SAME order and the SAME seller. This
    // is what makes "a line can never move to another seller's suborder" a
    // database invariant, not just a code convention. Nullable columns → the
    // constraint only applies when a suborder is set (MATCH SIMPLE default), so
    // legacy rows with no suborder are unaffected.
    suborderFk: foreignKey({
      columns: [t.sellerOrderId, t.orderId, t.sellerId],
      foreignColumns: [sellerOrders.id, sellerOrders.parentOrderId, sellerOrders.sellerId],
      name: 'order_items_suborder_fk',
    }),
    // M2.4 — target for `refund_allocations.itemFk`: lets an allocation prove, at
    // the database, that the line it cites belongs to the SAME order AND the SAME
    // suborder it is attributed to — not merely that the line exists. Nullable
    // columns → MATCH SIMPLE leaves legacy lines with no suborder unaffected.
    identityIdx: uniqueIndex('order_items_identity_idx').on(t.id, t.orderId, t.sellerOrderId),
  }),
);

export const transactions = pgTable(
  'transactions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    transactionNumber: varchar('transaction_number', { length: 40 }).notNull(),
    orderId: varchar('order_id', { length: 36 }),
    buyerId: varchar('buyer_id', { length: 36 }).notNull(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    productId: varchar('product_id', { length: 36 }),
    quantity: integer('quantity'),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }),
    totalValue: numeric('total_value', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    commission: numeric('commission', { precision: 18, scale: 4 }).notNull().default('0'),
    buyerCommission: numeric('buyer_commission', { precision: 18, scale: 4 }).notNull().default('0'),
    paymentFee: numeric('payment_fee', { precision: 18, scale: 4 }).notNull().default('0'),
    status: paymentStatusEnum('status').notNull().default('PENDING'),
    paymentProvider: varchar('payment_provider', { length: 100 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txNumberIdx: uniqueIndex('transactions_tx_number_idx').on(t.transactionNumber),
    orderIdx: index('transactions_order_idx').on(t.orderId),
    buyerIdx: index('transactions_buyer_idx').on(t.buyerId),
    sellerIdx: index('transactions_seller_idx').on(t.sellerId),
    // M2.3 — target for `seller_settlements.transactionOrderFk`: lets a
    // per-seller settlement prove, at the database, that the transaction it
    // cites belongs to the SAME parent order. `id` is already unique, so this
    // wider key can never conflict on existing rows.
    identityIdx: uniqueIndex('transactions_identity_idx').on(t.id, t.orderId),
  }),
);

export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'TRANSACTION_VALUE',
  'COMMISSION',
  'PAYMENT_FEE',
  'REFUND',
  'SETTLEMENT',
]);

export const ledgerDirectionEnum = pgEnum('ledger_direction', ['DEBIT', 'CREDIT']);

export const transactionLedger = pgTable(
  'transaction_ledger',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    entryType: ledgerEntryTypeEnum('entry_type').notNull(),
    direction: ledgerDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    payerId: varchar('payer_id', { length: 36 }),
    beneficiaryId: varchar('beneficiary_id', { length: 36 }),
    paymentProvider: varchar('payment_provider', { length: 100 }),
    status: settlementStatusEnum('status').notNull().default('PENDING'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txIdx: index('ledger_tx_idx').on(t.transactionId),
    payerIdx: index('ledger_payer_idx').on(t.payerId),
    beneficiaryIdx: index('ledger_beneficiary_idx').on(t.beneficiaryId),
    // M2.3 — target for `seller_settlements.parentEntryFk`: lets a per-seller
    // settlement prove, at the database, that the entry it cites exists, is a
    // SETTLEMENT, is SETTLED, and belongs to the cited transaction. `id` is
    // already unique, so this wider key can never conflict on existing rows.
    identityIdx: uniqueIndex('transaction_ledger_identity_idx').on(
      t.id,
      t.transactionId,
      t.entryType,
      t.status,
    ),
  }),
);

export const payments = pgTable(
  'payments',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    provider: varchar('provider', { length: 100 }),
    externalRef: varchar('external_ref', { length: 200 }),
    status: paymentStatusEnum('status').notNull().default('PENDING'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txIdx: index('payments_tx_idx').on(t.transactionId),
    orderIdx: index('payments_order_idx').on(t.orderId),
  }),
);

export const refunds = pgTable(
  'refunds',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    paymentId: varchar('payment_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    reason: text('reason'),
    status: refundStatusEnum('status').notNull().default('REQUESTED'),
    requestedById: varchar('requested_by_id', { length: 36 }),
    processedById: varchar('processed_by_id', { length: 36 }),
    externalRef: varchar('external_ref', { length: 200 }),
    // Caller-supplied idempotency key: prevents duplicate refunds on retry.
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paymentIdx: index('refunds_payment_idx').on(t.paymentId),
    orderIdx: index('refunds_order_idx').on(t.orderId),
    idemIdx: uniqueIndex('refunds_idem_idx').on(t.idempotencyKey),
    // M2.4 — target for `refund_allocations.refundFk`: proves an allocation's
    // parent order is the order the refund itself belongs to, so an allocation
    // can never attribute a refund to an unrelated order. `id` is already unique,
    // so this wider key can never conflict on existing rows.
    identityIdx: uniqueIndex('refunds_identity_idx').on(t.id, t.orderId),
  }),
);

/**
 * M2.4 — Refund Allocation.
 *
 * A single refund (one buyer reversal) can cover several sellers when the refund
 * spans more than one seller suborder. This table records, per seller suborder,
 * how much of a refund is attributed to it — and optionally the exact line item.
 * It is the data foundation only: no service logic reads or writes it yet.
 *
 * It is deliberately NOT a money movement and writes NO ledger entry, and it is
 * NOT a wallet or a balance: it holds no running total and no per-seller accrual.
 * The refund itself stays the single source of truth for the reversal
 * (`refunds.status` + the REFUND ledger entry); these rows only say WHICH
 * sellers an already-recorded refund is attributed to.
 *
 * Relationships are proven at the database, not assumed:
 *  - `refundFk`   → the allocation's order is the refund's order;
 *  - `suborderFk` → the suborder belongs to the SAME order, the SAME seller, and
 *                   is in the SAME currency as the allocation;
 *  - `itemFk`     → the line belongs to the SAME order AND the SAME suborder
 *                   (nullable: a suborder-level allocation cites no line).
 *
 * Duplicate prevention is intentionally scoped to the suborder: a refund may be
 * attributed to a given suborder only once (the amount is a single figure per
 * suborder). Item-level granularity is added later without a schema change if a
 * real need appears; it is not invented here.
 */
export const refundAllocations = pgTable(
  'refund_allocations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    refundId: varchar('refund_id', { length: 36 }).notNull(),
    // The parent order, denormalised so the composite FKs below can prove every
    // participant (refund, suborder, line) belongs to this same order.
    parentOrderId: varchar('parent_order_id', { length: 36 }).notNull(),
    sellerOrderId: varchar('seller_order_id', { length: 36 }).notNull(),
    // The exact line this share is attributed to, when known. NULL means the
    // allocation is at suborder level.
    orderItemId: varchar('order_item_id', { length: 36 }),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One allocation per (refund, suborder): a refund is attributed to a suborder
    // at most once, so a retried write cannot double-count a seller.
    refundSuborderIdx: uniqueIndex('refund_allocations_refund_suborder_idx').on(
      t.refundId,
      t.sellerOrderId,
    ),
    refundIdx: index('refund_allocations_refund_idx').on(t.refundId),
    suborderIdx: index('refund_allocations_suborder_idx').on(t.sellerOrderId),
    parentOrderIdx: index('refund_allocations_parent_order_idx').on(t.parentOrderId),
    itemIdx: index('refund_allocations_item_idx').on(t.orderItemId),
    amountPositive: check('refund_allocations_amount_positive', sql`${t.amount} > 0`),
    currencyLen: check('refund_allocations_currency_len', sql`length(${t.currencyCode}) = 3`),
    // The allocation's order is the refund's own order.
    refundFk: foreignKey({
      columns: [t.refundId, t.parentOrderId],
      foreignColumns: [refunds.id, refunds.orderId],
      name: 'refund_allocations_refund_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    // The suborder belongs to the SAME order, the SAME seller, and is in the
    // SAME currency as the allocation.
    suborderFk: foreignKey({
      columns: [t.sellerOrderId, t.parentOrderId, t.currencyCode],
      foreignColumns: [sellerOrders.id, sellerOrders.parentOrderId, sellerOrders.currencyCode],
      name: 'refund_allocations_suborder_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    // The line belongs to the SAME order AND the SAME suborder. MATCH SIMPLE
    // leaves a NULL `order_item_id` (suborder-level allocation) unconstrained.
    itemFk: foreignKey({
      columns: [t.orderItemId, t.parentOrderId, t.sellerOrderId],
      foreignColumns: [orderItems.id, orderItems.orderId, orderItems.sellerOrderId],
      name: 'refund_allocations_item_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
  }),
);

/**
 * M2.3 — Seller Suborder Settlement.
 *
 * A per-seller settlement is a distinct fact from the parent TRANSACTION's
 * settlement: the transaction-level SETTLEMENT ledger entry proves the money
 * moved at provider/bank level; this row records that one seller's share has
 * been attributed to that already-proven movement. It is NOT a second money
 * movement and writes NO ledger entry.
 *
 * Separation of the three layers is enforced here:
 *  - Parent Transaction Settlement → `transaction_ledger` (SETTLEMENT/SETTLED);
 *  - Seller Suborder Settlement    → this table;
 *  - Payout                        → `payouts` (independent lifecycle).
 *
 * The parent entry is the single source of truth for the reference: this table
 * stores NO copy of `settlement_ref` — it points at the ledger entry instead, so
 * a suborder cannot drift from the evidence it cites.
 *
 * Lifecycle is deliberately one-state: only `SETTLED`. A rejected attempt writes
 * no row (it is recorded in `audit_logs`), so a retry is never blocked by a
 * historical failure and no state implies a money transfer this path never makes.
 */
export const sellerSettlements = pgTable(
  'seller_settlements',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    sellerOrderId: varchar('seller_order_id', { length: 36 }).notNull(),
    parentOrderId: varchar('parent_order_id', { length: 36 }).notNull(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    // The seller's payable for this suborder — exactly `seller_orders.seller_payable`
    // read from the locked suborder row, never supplied by the caller.
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    status: settlementStatusEnum('status').notNull().default('SETTLED'),
    // The parent transaction's SETTLEMENT ledger entry this row is attributed to.
    parentSettlementEntryId: varchar('parent_settlement_entry_id', { length: 36 }).notNull(),
    // Pinned columns so the composite FK below is exclusive: it can only ever
    // match a SETTLEMENT entry that is SETTLED.
    parentEntryType: ledgerEntryTypeEnum('parent_entry_type').notNull().default('SETTLEMENT'),
    parentEntryStatus: settlementStatusEnum('parent_entry_status').notNull().default('SETTLED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Exactly one settlement per seller suborder. Rejected attempts write no row,
    // so this never blocks a retry.
    suborderIdx: uniqueIndex('seller_settlements_suborder_idx').on(t.sellerOrderId),
    parentOrderIdx: index('seller_settlements_parent_order_idx').on(t.parentOrderId),
    transactionIdx: index('seller_settlements_transaction_idx').on(t.transactionId),
    statusIdx: index('seller_settlements_status_idx').on(t.status),
    parentEntryIdx: index('seller_settlements_parent_entry_idx').on(t.parentSettlementEntryId),
    // Lifecycle is one-state: only SETTLED exists here.
    statusSettled: check('seller_settlements_status_settled', sql`${t.status} = 'SETTLED'`),
    // A settled row must carry the moment it settled (audit).
    settledRequiresAt: check(
      'seller_settlements_settled_requires_at',
      sql`${t.status} <> 'SETTLED' or ${t.settledAt} is not null`,
    ),
    amountPositive: check('seller_settlements_amount_positive', sql`${t.amount} > 0`),
    currencyLen: check('seller_settlements_currency_len', sql`length(${t.currencyCode}) = 3`),
    // Pin the parent entry's type and status so the composite FK is exclusive.
    parentIsSettlement: check(
      'seller_settlements_parent_is_settlement',
      sql`${t.parentEntryType} = 'SETTLEMENT'`,
    ),
    parentIsSettled: check(
      'seller_settlements_parent_is_settled',
      sql`${t.parentEntryStatus} = 'SETTLED'`,
    ),
    // The suborder must belong to the same order AND the same seller.
    suborderFk: foreignKey({
      columns: [t.sellerOrderId, t.parentOrderId, t.sellerId],
      foreignColumns: [sellerOrders.id, sellerOrders.parentOrderId, sellerOrders.sellerId],
      name: 'seller_settlements_suborder_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    // The parent entry must exist, be a SETTLEMENT, be SETTLED, and belong to
    // this transaction. ON UPDATE NO ACTION pins the ledger entry: altering it is
    // refused loudly rather than propagating silently.
    parentEntryFk: foreignKey({
      columns: [t.parentSettlementEntryId, t.transactionId, t.parentEntryType, t.parentEntryStatus],
      foreignColumns: [transactionLedger.id, transactionLedger.transactionId, transactionLedger.entryType, transactionLedger.status],
      name: 'seller_settlements_parent_entry_fk',
    })
      .onDelete('restrict')
      .onUpdate('no action'),
    // The transaction must belong to the SAME parent order. This is what makes
    // "the entry's transaction is right" also "right for this suborder's order".
    transactionOrderFk: foreignKey({
      columns: [t.transactionId, t.parentOrderId],
      foreignColumns: [transactions.id, transactions.orderId],
      name: 'seller_settlements_transaction_order_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
  }),
);