import { and, eq, notInArray, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, sellerOrders, sellerSettlements, transactionLedger, transactions } from '../../db/schema/commerce';
import { disputes } from '../../db/schema/disputes';
import { paymentIntents } from '../../db/schema/payments_extras';
import { newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { writeAudit, type AuditContext } from '../../lib/audit';

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

/**
 * M2.3 — Seller Suborder Settlement.
 *
 * Records that ONE seller's share of an already-settled transaction has been
 * attributed to the parent SETTLEMENT entry. This module is the ONLY writer of
 * `seller_orders.settlement_status = 'SETTLED'` and of a `seller_settlements`
 * row; every other path must call in here.
 *
 * What it is NOT: it moves no money, calls no provider, and writes NO ledger
 * entry. The parent SETTLEMENT entry already proves the money moved; this row
 * only says "this seller's share is part of that movement". That is why a
 * late-delivered suborder can be settled against the EXISTING parent evidence.
 *
 * Lifecycle is one-state (`SETTLED`). A rejected attempt writes no row — the
 * reason goes to `audit_logs` — so a retry is never blocked by a past failure.
 *
 * Locks, in the fixed order shared with `createPayout`:
 *   1. `seller_orders` row  (FOR UPDATE)
 *   2. `transactions` row   (FOR UPDATE)
 * so settlement and payout can never deadlock against each other.
 */
export interface SuborderSettlementResult {
  /** True when this call wrote the settlement row + flipped the suborder. */
  settled: boolean;
  /** True when the suborder was already settled (idempotent replay). */
  duplicate: boolean;
  /** Why a non-settled outcome happened, when it was a business ineligibility. */
  reason?: SuborderSettlementReason;
  /** Id of the settlement row the suborder now carries. */
  settlementId: string | null;
}

export type SuborderSettlementReason =
  | 'SUBORDER_NOT_FOUND'
  | 'SUBORDER_NOT_DELIVERED'
  | 'ALREADY_SETTLED'
  | 'PARENT_TRANSACTION_NOT_SETTLED'
  | 'PARENT_ORDER_NOT_PAID'
  | 'REFUND_PRESENT'
  | 'DISPUTE_OPEN';

/**
 * The eligibility verdict for one suborder, without writing anything. Exposed so
 * the admin re-processing path can report WHY a suborder is not settleable.
 */
export async function evaluateSuborderSettlement(
  db: DB,
  sellerOrderId: string,
): Promise<{ eligible: boolean; reason?: SuborderSettlementReason; parentOrderId?: string; transactionId?: string }> {
  const subRows = await db.select().from(sellerOrders).where(eq(sellerOrders.id, sellerOrderId)).limit(1);
  if (subRows.length === 0) return { eligible: false, reason: 'SUBORDER_NOT_FOUND' };
  return evaluateSuborderRow(db, subRows[0]);
}

async function evaluateSuborderRow(
  db: DB,
  sub: typeof sellerOrders.$inferSelect,
): Promise<{ eligible: boolean; reason?: SuborderSettlementReason; parentOrderId: string; transactionId?: string }> {
  const parentOrderId = sub.parentOrderId;
  if (sub.settlementStatus === 'SETTLED') {
    return { eligible: false, reason: 'ALREADY_SETTLED', parentOrderId };
  }
  // Only a fulfilled seller line is payable. A cancelled or still-pending
  // suborder must never be settled, even if the parent transaction was.
  if (sub.status !== 'DELIVERED' && sub.status !== 'COMPLETED') {
    return { eligible: false, reason: 'SUBORDER_NOT_DELIVERED', parentOrderId };
  }

  const orderRows = await db.select().from(orders).where(eq(orders.id, parentOrderId)).limit(1);
  if (orderRows.length === 0) return { eligible: false, reason: 'PARENT_ORDER_NOT_PAID', parentOrderId };
  const order = orderRows[0];

  // Money must still be with WASIT: a full or partial refund, or a refund in
  // flight, means the seller's payable is no longer what was recorded.
  if (
    order.paymentStatus === 'REFUNDED' ||
    order.paymentStatus === 'PARTIALLY_REFUNDED' ||
    order.refundStatus === 'COMPLETED' ||
    order.refundStatus === 'PROCESSING'
  ) {
    return { eligible: false, reason: 'REFUND_PRESENT', parentOrderId };
  }
  if (order.paymentStatus !== 'PAID') {
    return { eligible: false, reason: 'PARENT_ORDER_NOT_PAID', parentOrderId };
  }

  // An unresolved dispute blocks settlement: the seller's entitlement is not yet
  // final. Only CLOSED / ARCHIVED are terminal.
  const openDisputes = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.orderId, parentOrderId), notInArray(disputes.status, ['CLOSED', 'ARCHIVED'])))
    .limit(1);
  if (openDisputes.length > 0) return { eligible: false, reason: 'DISPUTE_OPEN', parentOrderId };

  // The parent transaction must carry a SETTLED SETTLEMENT entry.
  const txRows = await db.select().from(transactions).where(eq(transactions.orderId, parentOrderId)).limit(1);
  if (txRows.length === 0) return { eligible: false, reason: 'PARENT_TRANSACTION_NOT_SETTLED', parentOrderId };
  const transaction = txRows[0];
  const settlement = await db
    .select()
    .from(transactionLedger)
    .where(
      and(
        eq(transactionLedger.transactionId, transaction.id),
        eq(transactionLedger.entryType, 'SETTLEMENT'),
        eq(transactionLedger.status, 'SETTLED'),
      ),
    )
    .limit(1);
  if (settlement.length === 0) {
    return { eligible: false, reason: 'PARENT_TRANSACTION_NOT_SETTLED', parentOrderId, transactionId: transaction.id };
  }
  return { eligible: true, parentOrderId, transactionId: transaction.id };
}

/**
 * Settles one seller suborder against the parent transaction's existing
 * SETTLEMENT evidence. Idempotent and safe under concurrency.
 *
 * Returns `settled:false` with a `reason` for a business ineligibility (recorded
 * in the audit log); a missing suborder is also reported, never thrown, so a
 * batch re-processing run can continue past it.
 */
export async function settleSellerSuborder(
  db: DB,
  sellerOrderId: string,
  ctx: AuditContext = { actorId: null, actorType: 'SYSTEM' },
): Promise<SuborderSettlementResult> {
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as DB;

    // 1) Lock the suborder first — the fixed first lock shared with createPayout.
    const locked = await tx
      .select()
      .from(sellerOrders)
      .where(eq(sellerOrders.id, sellerOrderId))
      .limit(1)
      .for('update');
    if (locked.length === 0) {
      return { settled: false, duplicate: false, reason: 'SUBORDER_NOT_FOUND', settlementId: null };
    }
    const sub = locked[0];

    // Idempotent replay: already settled is a no-op, not an error.
    if (sub.settlementStatus === 'SETTLED') {
      const existing = await tx
        .select()
        .from(sellerSettlements)
        .where(eq(sellerSettlements.sellerOrderId, sellerOrderId))
        .limit(1);
      return { settled: false, duplicate: true, reason: 'ALREADY_SETTLED', settlementId: existing[0]?.id ?? null };
    }

    const verdict = await evaluateSuborderRow(tdb, sub);
    if (!verdict.eligible || !verdict.transactionId) {
      await writeAudit(tdb, ctx, {
        action: 'SELLER_SETTLEMENT.REJECTED',
        entityType: 'SELLER_ORDER',
        entityId: sellerOrderId,
        after: { reason: verdict.reason ?? 'NOT_ELIGIBLE', parentOrderId: sub.parentOrderId },
      });
      return { settled: false, duplicate: false, reason: verdict.reason, settlementId: null };
    }

    const transactionId = verdict.transactionId;

    // 2) Lock the parent transaction — the fixed second lock, same order as
    //    confirmSettlement and createPayout.
    const txLocked = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .limit(1)
      .for('update');
    if (txLocked.length === 0) {
      return { settled: false, duplicate: false, reason: 'PARENT_TRANSACTION_NOT_SETTLED', settlementId: null };
    }

    const settlementRows = await tx
      .select()
      .from(transactionLedger)
      .where(
        and(
          eq(transactionLedger.transactionId, transactionId),
          eq(transactionLedger.entryType, 'SETTLEMENT'),
          eq(transactionLedger.status, 'SETTLED'),
        ),
      )
      .limit(1);
    if (settlementRows.length === 0) {
      await writeAudit(tdb, ctx, {
        action: 'SELLER_SETTLEMENT.REJECTED',
        entityType: 'SELLER_ORDER',
        entityId: sellerOrderId,
        after: { reason: 'PARENT_TRANSACTION_NOT_SETTLED', parentOrderId: sub.parentOrderId },
      });
      return { settled: false, duplicate: false, reason: 'PARENT_TRANSACTION_NOT_SETTLED', settlementId: null };
    }
    const parentEntry = settlementRows[0];

    // Every stored value is taken from the LOCKED suborder row — never from a
    // caller — so the record can never disagree with the seller's own terms.
    const settlementId = newId();
    const now = new Date();
    const amount = roundMoney(toDecimal(sub.sellerPayable)).toFixed(4);
    await tx.insert(sellerSettlements).values({
      id: settlementId,
      sellerOrderId: sub.id,
      parentOrderId: sub.parentOrderId,
      transactionId,
      sellerId: sub.sellerId,
      sellerType: sub.sellerType,
      amount,
      currencyCode: sub.currencyCode,
      status: 'SETTLED',
      parentSettlementEntryId: parentEntry.id,
      parentEntryType: 'SETTLEMENT',
      parentEntryStatus: 'SETTLED',
      settledAt: now,
    } as never);

    await tx
      .update(sellerOrders)
      .set({ settlementStatus: 'SETTLED', updatedAt: now })
      .where(and(eq(sellerOrders.id, sub.id), sql`${sellerOrders.settlementStatus} <> 'SETTLED'`));

    await writeAudit(tdb, ctx, {
      action: 'SELLER_SETTLEMENT.CONFIRMED',
      entityType: 'SELLER_ORDER',
      entityId: sub.id,
      after: {
        parentOrderId: sub.parentOrderId,
        transactionId,
        sellerId: sub.sellerId,
        amount,
        currencyCode: sub.currencyCode,
        parentSettlementEntryId: parentEntry.id,
      },
    });

    return { settled: true, duplicate: false, settlementId };
  });
}

/**
 * Admin re-processing: settles every eligible suborder of one order, or of all
 * still-pending suborders when `orderId` is null. Idempotent; returns a
 * per-suborder verdict so a stuck suborder can be explained rather than silently
 * retried.
 */
export async function reconcileSellerSettlements(
  db: DB,
  orderId: string | null,
  ctx: AuditContext = { actorId: null, actorType: 'SYSTEM' },
): Promise<Array<{ sellerOrderId: string; settled: boolean; duplicate: boolean; reason?: SuborderSettlementReason }>> {
  const subs = orderId
    ? await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId))
    : await db.select().from(sellerOrders).where(eq(sellerOrders.settlementStatus, 'PENDING'));

  const results: Array<{ sellerOrderId: string; settled: boolean; duplicate: boolean; reason?: SuborderSettlementReason }> = [];
  for (const sub of subs) {
    const r = await settleSellerSuborder(db, sub.id, ctx);
    results.push({ sellerOrderId: sub.id, settled: r.settled, duplicate: r.duplicate, reason: r.reason });
  }
  return results;
}
