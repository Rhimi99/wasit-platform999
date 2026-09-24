import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
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
      report.decisions.map((d) => ({
        id: newId(),
        importId,
        reference: d.reference,
        status: d.status,
        mismatches: d.mismatches,
        detail: null,
        provider: input.providerId ?? null,
      })),
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
