import {
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
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
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

export const orderItems = pgTable(
  'order_items',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    productId: varchar('product_id', { length: 36 }).notNull(),
    productVariantId: varchar('product_variant_id', { length: 36 }),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: numeric('line_total', { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
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
  }),
);