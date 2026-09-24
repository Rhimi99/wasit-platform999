import { index, numeric, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * WASIT Receipt persistence — `WASIT Funds Received = RECEIVED`.
 *
 * Settlement (`SETTLED`) proves money moved at the provider/bank; it says nothing
 * about WASIT's own funds arriving. Receipt is a separate, later stage backed by
 * its own evidence (a bank statement / acquirer / provider reference). No column
 * here is derived from settlement or payment state, which is what keeps
 * `Settlement ≠ Received` true in the data model.
 */
export const wasitReceiptStatusEnum = pgEnum('wasit_receipt_status', ['PENDING', 'RECEIVED', 'REVERSED']);

export const wasitReceiptSourceEnum = pgEnum('wasit_receipt_source', ['BANK_STATEMENT', 'ACQUIRER', 'PROVIDER']);

export const wasitReceipts = pgTable(
  'wasit_receipts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    transactionId: varchar('transaction_id', { length: 36 }).notNull(),
    reference: varchar('reference', { length: 200 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    source: wasitReceiptSourceEnum('source').notNull(),
    status: wasitReceiptStatusEnum('status').notNull().default('PENDING'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One piece of evidence (statement/acquirer reference) is recorded once.
    sourceRefIdx: uniqueIndex('wasit_receipts_source_ref_idx').on(t.source, t.reference),
    orderIdx: index('wasit_receipts_order_idx').on(t.orderId),
    txIdx: index('wasit_receipts_tx_idx').on(t.transactionId),
    statusIdx: index('wasit_receipts_status_idx').on(t.status),
  }),
);
