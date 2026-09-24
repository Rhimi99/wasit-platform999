import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, transactionLedger, transactions } from '../../db/schema/commerce';
import { paymentIntents } from '../../db/schema/payments_extras';
import { auditLogs } from '../../db/schema/audit';
import {
  reconciliationDecisions,
  reconciliationImports,
  reconciliationLines,
} from '../../db/schema/reconciliation';
import { newId } from '../../lib/ids';
import { writeAudit } from '../../lib/audit';
import {
  reconcile,
  type BankFeedLine,
  type LedgerFeedLine,
  type ProviderFeedLine,
  type ReconciliationReport,
} from './engine';
import {
  resolveReportProvenance,
  type LedgerEntryRow,
  type ProvenanceContext,
} from './provenance';

/**
 * PS-04 — Reconciliation persistence.
 *
 * Stores an imported feed and the three-way matching decisions derived from it.
 * The engine does the comparing; this layer only records the outcome, so a
 * mismatch is persisted as MISMATCH and never rewritten into a success.
 *
 * Idempotency follows the project convention: the same `(source, checksum)` is
 * the same import, so a replayed upload returns the existing import instead of
 * creating a second set of financial effects.
 */

export interface ImportFeedsInput {
  source: 'PROVIDER' | 'BANK';
  currencyCode: string;
  importKey?: string | null;
  /** Provider/acquirer id the feed came from, recorded on each decision. */
  providerId?: string | null;
  provider: ProviderFeedLine[];
  bank: BankFeedLine[];
  ledger: LedgerFeedLine[];
  actorId?: string | null;
  ipAddress?: string | null;
}

export interface ImportResult {
  importId: string;
  duplicate: boolean;
  insertedLines: number;
  report: ReconciliationReport;
}

/** Stable content hash over the lines this source contributes. */
function checksumOf(source: 'PROVIDER' | 'BANK', lines: { reference: string }[]): string {
  const canonical = JSON.stringify(
    [...lines].sort((a, b) => a.reference.localeCompare(b.reference)),
  );
  return createHash('sha256').update(`${source}:${canonical}`).digest('hex');
}

/**
 * Gathers the real rows needed to link decisions back to the ledger. Queries are
 * bounded by the references in the report, never a full-table scan, and only
 * real ids are ever read back.
 */
async function loadProvenanceContext(
  db: DB,
  report: ReconciliationReport,
): Promise<ProvenanceContext> {
  const refs = [...new Set(report.decisions.map((d) => d.reference))];
  if (refs.length === 0) {
    return { intents: [], transactions: [], ledgerEntries: [], orders: [], audits: [] };
  }

  const intents = await db
    .select({
      externalRef: paymentIntents.externalRef,
      orderId: paymentIntents.orderId,
      transactionId: paymentIntents.transactionId,
    })
    .from(paymentIntents)
    .where(inArray(paymentIntents.externalRef, refs));

  const transactionIds = [...new Set(intents.map((i) => i.transactionId).filter((v): v is string => v !== null))];
  if (transactionIds.length === 0) {
    return { intents, transactions: [], ledgerEntries: [], orders: [], audits: [] };
  }

  const txs = await db
    .select({ id: transactions.id, orderId: transactions.orderId })
    .from(transactions)
    .where(inArray(transactions.id, transactionIds));

  const orderIds = [...new Set(txs.map((t) => t.orderId).filter((v): v is string => v !== null))];
  if (orderIds.length === 0) {
    return { intents, transactions: txs, ledgerEntries: [], orders: [], audits: [] };
  }

  const ledgerRows = await db
    .select({
      id: transactionLedger.id,
      transactionId: transactionLedger.transactionId,
      entryType: transactionLedger.entryType,
      status: transactionLedger.status,
      currencyCode: transactionLedger.currencyCode,
      metadata: transactionLedger.metadata,
    })
    .from(transactionLedger)
    .where(inArray(transactionLedger.transactionId, transactionIds));

  const ledgerEntries: LedgerEntryRow[] = ledgerRows.map((row) => {
    const meta = (row.metadata ?? {}) as { settlementRef?: unknown; providerRef?: unknown };
    return {
      id: row.id,
      transactionId: row.transactionId,
      entryType: row.entryType,
      status: row.status,
      currencyCode: row.currencyCode,
      settlementRef: typeof meta.settlementRef === 'string' ? meta.settlementRef : null,
      providerRef: typeof meta.providerRef === 'string' ? meta.providerRef : null,
    };
  });

  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.id, orderIds));

  const auditRows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'ORDER'), eq(auditLogs.action, 'SETTLEMENT.CONFIRMED')));

  // Bound the audit set to the orders this report touches.
  const audits = auditRows.filter((a) => a.entityId !== null && orderIds.includes(a.entityId));

  return { intents, transactions: txs, ledgerEntries, orders: orderRows, audits };
}

export async function importReconciliationFeed(db: DB, input: ImportFeedsInput): Promise<ImportResult> {
  const sourceLines: (ProviderFeedLine | BankFeedLine)[] =
    input.source === 'PROVIDER' ? input.provider : input.bank;
  if (sourceLines.length === 0) {
    throw ApiError.validation([
      { field: 'lines', message: 'An import must carry at least one line', code: 'VALIDATION_FAILED' },
    ]);
  }
  const checksum = checksumOf(input.source, sourceLines);

  const existing = await db
    .select()
    .from(reconciliationImports)
    .where(
      and(eq(reconciliationImports.source, input.source), eq(reconciliationImports.checksum, checksum)),
    )
    .limit(1);

  const report = reconcile(input.currencyCode, input.provider, input.bank, input.ledger);

  if (existing.length > 0) {
    return { importId: existing[0].id, duplicate: true, insertedLines: 0, report };
  }

  // Resolve real provenance for MATCHED decisions before writing anything. A
  // decision that cannot be traced to exactly one transaction/ledger/audit is
  // stored without linkage rather than linked to a guessed row.
  const provenance = resolveReportProvenance(report.decisions, await loadProvenanceContext(db, report));

  const importId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(reconciliationImports).values({
      id: importId,
      source: input.source,
      currencyCode: input.currencyCode,
      importKey: input.importKey ?? null,
      checksum,
      lineCount: sourceLines.length,
    });

    await tx.insert(reconciliationLines).values(
      sourceLines.map((line) => {
        const isProvider = 'grossAmount' in line;
        return {
          id: newId(),
          importId,
          reference: line.reference,
          settlementRef: line.settlementRef ?? null,
          payoutRef: line.payoutRef ?? null,
          grossAmount: isProvider ? line.grossAmount : null,
          providerFee: isProvider ? line.providerFee : null,
          netAmount: isProvider ? line.netAmount : line.amount,
          currencyCode: line.currencyCode,
          // `settled` is a ledger-side fact, never asserted by an imported feed.
          settled: null,
          occurredAt: line.occurredAt ? new Date(line.occurredAt) : null,
        };
      }),
    );

    await tx.insert(reconciliationDecisions).values(
      report.decisions.map((d) => {
        // Provenance exists only for a MATCHED decision that resolved cleanly.
        const link = provenance.get(d.reference) ?? null;
        return {
          id: newId(),
          importId,
          reference: d.reference,
          status: d.status,
          mismatches: d.mismatches,
          detail: null,
          provider: input.providerId ?? null,
          matchedTransactionId: link?.transactionId ?? null,
          ledgerEntryId: link?.ledgerEntryId ?? null,
          auditLogId: link?.auditLogId ?? null,
        };
      }),
    );

    await writeAudit(
      tx as unknown as DB,
      { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null },
      {
        action: 'RECONCILIATION.IMPORTED',
        entityType: 'RECONCILIATION_IMPORT',
        entityId: importId,
        after: {
          source: input.source,
          currencyCode: input.currencyCode,
          checksum,
          matched: report.matched,
          mismatched: report.mismatched,
        },
      },
    );
  });

  return { importId, duplicate: false, insertedLines: sourceLines.length, report };
}
