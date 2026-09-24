import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * PS-04 — Reconciliation / Treasury persistence.
 *
 * These tables store the *external evidence* (provider/bank statements) and the
 * matching decisions. They never derive a result from `Payment = PAID` or
 * `Ledger = SETTLED`: a decision is written only from a real three-way compare,
 * and a mismatch is stored as MISMATCH rather than being turned into a success.
 *
 * `reconciliation_lines` intentionally holds no reference to a ledger entry:
 * a feed line is independent evidence that may arrive before the ledger row or
 * cover several entries. Provenance links live on the decision (nullable
 * `matched_transaction_id` / `ledger_entry_id`).
 */
export const reconciliationSourceEnum = pgEnum('reconciliation_source', ['PROVIDER', 'BANK']);

export const reconciliationStatusEnum = pgEnum('reconciliation_status', ['MATCHED', 'MISMATCH']);

export const reconciliationImports = pgTable(
  'reconciliation_imports',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    source: reconciliationSourceEnum('source').notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    /** Caller-supplied key so an intentional re-import can be distinguished. */
    importKey: varchar('import_key', { length: 200 }),
    checksum: varchar('checksum', { length: 128 }).notNull(),
    lineCount: integer('line_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Same source with identical content is the same import: re-importing it
    // cannot create a second set of financial effects.
    checksumIdx: uniqueIndex('reconciliation_imports_checksum_idx').on(t.source, t.checksum),
    createdIdx: index('reconciliation_imports_created_idx').on(t.createdAt),
  }),
);

export const reconciliationLines = pgTable(
  'reconciliation_lines',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    importId: varchar('import_id', { length: 36 }).notNull(),
    reference: varchar('reference', { length: 200 }).notNull(),
    settlementRef: varchar('settlement_ref', { length: 200 }),
    payoutRef: varchar('payout_ref', { length: 200 }),
    grossAmount: numeric('gross_amount', { precision: 18, scale: 4 }),
    providerFee: numeric('provider_fee', { precision: 18, scale: 4 }),
    netAmount: numeric('net_amount', { precision: 18, scale: 4 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    settled: boolean('settled'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    importRefIdx: uniqueIndex('reconciliation_lines_import_ref_idx').on(t.importId, t.reference),
    importIdx: index('reconciliation_lines_import_idx').on(t.importId),
    refIdx: index('reconciliation_lines_ref_idx').on(t.reference),
  }),
);

export const reconciliationDecisions = pgTable(
  'reconciliation_decisions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    importId: varchar('import_id', { length: 36 }).notNull(),
    reference: varchar('reference', { length: 200 }).notNull(),
    status: reconciliationStatusEnum('status').notNull(),
    /** Classified differences (a JSON array of mismatch kinds). */
    mismatches: jsonb('mismatches').notNull(),
    detail: jsonb('detail'),
    provider: varchar('provider', { length: 100 }),
    matchedTransactionId: varchar('matched_transaction_id', { length: 36 }),
    ledgerEntryId: varchar('ledger_entry_id', { length: 36 }),
    auditLogId: varchar('audit_log_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    importRefIdx: uniqueIndex('reconciliation_decisions_import_ref_idx').on(t.importId, t.reference),
    statusIdx: index('reconciliation_decisions_status_idx').on(t.status),
    matchedTxIdx: index('reconciliation_decisions_matched_tx_idx').on(t.matchedTransactionId),
  }),
);
