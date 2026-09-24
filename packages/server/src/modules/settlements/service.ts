import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, transactionLedger, transactions } from '../../db/schema/commerce';
import { paymentIntents } from '../../db/schema/payments_extras';
import { newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { writeAudit } from '../../lib/audit';

/**
 * PS-01 — Automated Settlement.
 *
 * This module is the settlement layer: it turns a *provider settlement
 * confirmation* into a `transaction_ledger.status = 'SETTLED'` transition plus
 * exactly one `SETTLEMENT` ledger entry, atomically.
 *
 * It is deliberately a separate layer from payment confirmation:
 *  - `Payment = PAID` means the buyer's money reached the provider.
 *  - `Settlement = SETTLED` means the funds actually moved at provider/bank
 *    level. It is a different fact with different evidence, never derived from
 *    `PAID`.
 *
 * Evidence contract (`SettlementEvidence`): a transaction/order reference (via
 * the payment intent's `externalRef`), the settled amount, the currency, the
 * provider/acquirer that observed the movement, a mandatory settlement/transfer
 * reference, and the provider reference/timestamp when the payload supplies one.
 */

export interface SettlementEvidence {
  /** Payment-intent reference that identifies the order/transaction. */
  externalRef: string;
  /** Settled amount, as reported by the acquirer's evidence. */
  amount: string;
  /** Currency of the settled amount. */
  currencyCode: string;
  /** Provider/acquirer id that produced the evidence. */
  providerId: string;
  /** Acquirer transfer/settlement reference. Mandatory. */
  settlementRef: string;
  /** Provider-side reference for the movement, when the payload carries one. */
  providerRef?: string | null;
  /** When the movement occurred, when the evidence carries a timestamp. */
  occurredAt?: Date | null;
  ipAddress?: string | null;
}

export interface SettlementResult {
  /** True when this call wrote the settlement side-effects. */
  applied: boolean;
  /** True when an identical settlement (same ref) had already been applied. */
  duplicate: boolean;
  /** Id of the settlement entry this transaction now carries. */
  settlementEntryId: string | null;
}

/**
 * Applies settlement evidence. This is the ONLY writer of
 * `transaction_ledger.status = 'SETTLED'` and the only creator of `SETTLEMENT`
 * ledger entries.
 *
 * Guards, in order:
 *  1. `settlementRef` must be present — no settlement without a transfer
 *     reference.
 *  2. The referenced payment intent must exist and its payment must be confirmed
 *     (`SUCCEEDED`). Settling an unpaid order would fabricate a state transition.
 *  3. The evidence amount and currency must match the intent exactly.
 *  4. The whole application (ledger promotion, SETTLEMENT entry, order status,
 *     audit) runs in one DB transaction, so a partial failure leaves no half
 *     state behind.
 *  5. Idempotency: the transaction row is locked for update; an existing
 *     settlement entry with the same reference is a no-op, and a *different*
 *     reference against an already-settled transaction is a conflict.
 */
export async function confirmSettlement(db: DB, evidence: SettlementEvidence): Promise<SettlementResult> {
  const settlementRef = evidence.settlementRef?.trim();
  if (!settlementRef) {
    throw ApiError.validation([
      {
        field: 'settlementRef',
        message: 'Settlement evidence must carry a transfer/settlement reference',
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
  const amount = toDecimal(evidence.amount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw ApiError.validation([
      { field: 'amount', message: 'Settlement amount must be a positive number', code: 'VALIDATION_FAILED' },
    ]);
  }

  const intentRows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.externalRef, evidence.externalRef))
    .limit(1);
  if (intentRows.length === 0) throw ApiError.notFound('Payment intent');
  const intent = intentRows[0];
  if (!intent.orderId || !intent.transactionId) {
    throw ApiError.conflict('Settlement evidence targets a non-order payment intent');
  }
  if (intent.status !== 'SUCCEEDED') {
    throw ApiError.conflict('Cannot settle an intent whose payment is not confirmed');
  }
  if (!amount.equals(toDecimal(intent.amount))) {
    throw ApiError.conflict('Settlement amount does not match the payment intent');
  }
  if (evidence.currencyCode !== intent.currencyCode) {
    throw ApiError.conflict('Settlement currency does not match the payment intent');
  }

  const transactionId = intent.transactionId;
  const orderId = intent.orderId;
  const settledAmount = roundMoney(amount).toFixed(4);

  return db.transaction(async (tx) => {
    // Serialise concurrent settlements for the same transaction. Without this
    // lock two deliveries with the same reference could both pass the
    // "already settled?" check and each insert a SETTLEMENT entry.
    const locked = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .limit(1)
      .for('update');
    if (locked.length === 0) throw ApiError.notFound('Transaction');

    const existing = await tx
      .select()
      .from(transactionLedger)
      .where(
        and(eq(transactionLedger.transactionId, transactionId), eq(transactionLedger.entryType, 'SETTLEMENT')),
      );

    const sameRef = existing.find(
      (e) => (e.metadata as { settlementRef?: string } | null)?.settlementRef === settlementRef,
    );
    if (sameRef) {
      // Identical evidence replayed: the settlement is already applied. This is
      // a no-op, not an error, so a provider retry can never double-settle.
      return { applied: false, duplicate: true, settlementEntryId: sameRef.id };
    }
    if (existing.length > 0) {
      throw ApiError.conflict('Transaction already settled with a different reference');
    }

    await tx
      .update(transactionLedger)
      .set({ status: 'SETTLED', paymentProvider: evidence.providerId } as never)
      .where(
        and(
          eq(transactionLedger.transactionId, transactionId),
          sql`${transactionLedger.status} in ('PENDING','PROCESSING')`,
        ),
      );

    // The SETTLEMENT entry records the movement itself: what the acquirer
    // confirmed moved, in which currency, with which transfer reference. It is
    // the auditable bridge between provider evidence and the ledger, and it is
    // NOT a statement that WASIT has received its commission (see Receipt).
    const settlementEntryId = newId();
    await tx.insert(transactionLedger).values({
      id: settlementEntryId,
      transactionId,
      entryType: 'SETTLEMENT',
      direction: 'CREDIT',
      amount: settledAmount,
      currencyCode: evidence.currencyCode,
      beneficiaryId: 'wasit',
      paymentProvider: evidence.providerId,
      status: 'SETTLED',
      metadata: {
        settlementRef,
        providerRef: evidence.providerRef ?? null,
        occurredAt: evidence.occurredAt ? evidence.occurredAt.toISOString() : null,
      } as never,
    } as never);

    await tx
      .update(orders)
      .set({ settlementStatus: 'SETTLED', updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), sql`${orders.settlementStatus} <> 'SETTLED'`));

    await writeAudit(tx as unknown as DB, { actorId: null, ipAddress: evidence.ipAddress ?? null }, {
      action: 'SETTLEMENT.CONFIRMED',
      entityType: 'ORDER',
      entityId: orderId,
      after: {
        transactionId,
        provider: evidence.providerId,
        settlementRef,
        providerRef: evidence.providerRef ?? null,
        amount: settledAmount,
        currencyCode: evidence.currencyCode,
      },
    });

    return { applied: true, duplicate: false, settlementEntryId };
  });
}
