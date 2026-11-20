import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, sellerOrders, transactionLedger, transactions } from '../../db/schema/commerce';
import { payouts } from '../../db/schema/payouts';
import { resolvePaymentProviderById } from '../../lib/payments/resolve';
import { newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { writeAudit } from '../../lib/audit';
import {
  applyPayoutEvent,
  assertPayoutCapable,
  computeSellerPayable,
  type PayoutEvent,
  type PayoutRecord,
  type PayoutStatus,
} from './engine';

/**
 * PS-02 — Seller Payout persistence.
 *
 * Wires the payout engine (the pure state machine) to the `payouts` table. The
 * only writer of a payout row and of `COMPLETED` is this module, and it refuses
 * to act without settlement evidence and a provider that declares the payout
 * capability. `Settlement ≠ Payout`: a SETTLED ledger is a precondition, never
 * a substitute for a real transfer reference.
 *
 * M2.2 — one payout per SELLER SUBORDER. A multi-seller Parent Order has no
 * single seller, so each of its suborders is paid independently: the amount is
 * the suborder's own `seller_payable`, and the composite FK proves the suborder
 * belongs to the same order and seller. A legacy order that has no suborder
 * keeps the old shape (`seller_order_id = NULL`).
 */

function toRecord(row: typeof payouts.$inferSelect): PayoutRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    transactionId: row.transactionId,
    sellerOrderId: row.sellerOrderId,
    sellerId: row.sellerId,
    amount: row.amount,
    currencyCode: row.currencyCode,
    providerId: row.provider,
    status: row.status as PayoutStatus,
    payoutRef: row.payoutRef,
    providerRef: row.providerRef,
    failureReason: row.failureReason,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export interface CreatePayoutInput {
  transactionId: string;
  providerId: string;
  /**
   * The seller suborder to pay (M2.2). Required when the order has seller
   * suborders; must be omitted (or null) for a legacy single-seller order.
   */
  sellerOrderId?: string | null;
  idempotencyKey?: string | null;
  actorId?: string | null;
  ipAddress?: string | null;
}

/**
 * Creates (or returns) the seller payout for a settled transaction.
 *
 * For an order with seller suborders the caller MUST name the suborder and the
 * amount is the suborder's own `seller_payable` — never the parent total, and
 * never supplied by the caller, so it cannot be inflated. For a legacy order
 * (no suborders) the amount is derived from the parent order as before and
 * `seller_order_id` stays NULL.
 *
 * Idempotent on `idempotencyKey`: replaying the same request returns the same
 * payout row instead of a second one.
 */
export async function createPayout(db: DB, input: CreatePayoutInput): Promise<PayoutRecord> {
  // The whole decision runs in one transaction so the settlement gate cannot be
  // raced: the suborder row is locked before its settlement state is read, and
  // the transaction row is locked next — the SAME lock order `settleSellerSuborder`
  // uses, so the two paths can never deadlock.
  return db.transaction(async (tx) => createPayoutTx(tx as unknown as DB, input));
}

async function createPayoutTx(db: DB, input: CreatePayoutInput): Promise<PayoutRecord> {
  const provider = resolvePaymentProviderById(input.providerId);
  assertPayoutCapable(provider.id, provider.capabilities);

  const requestedSellerOrderId = input.sellerOrderId?.trim() || null;

  if (input.idempotencyKey) {
    const existing = await db
      .select()
      .from(payouts)
      .where(eq(payouts.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing.length > 0) return toRecord(existing[0]);
  }

  const txRows = await db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (txRows.length === 0) throw ApiError.notFound('Transaction');
  const transaction = txRows[0];
  if (!transaction.orderId) throw ApiError.conflict('Transaction is not attached to an order');

  const orderRows = await db.select().from(orders).where(eq(orders.id, transaction.orderId)).limit(1);
  if (orderRows.length === 0) throw ApiError.notFound('Order');
  const order = orderRows[0];

  // Decide the payout unit: the seller suborder when the order has any, else the
  // legacy whole-order shape.
  const suborders = await db
    .select()
    .from(sellerOrders)
    .where(eq(sellerOrders.parentOrderId, order.id));

  let sellerOrderId: string | null = null;
  let sellerId: string;
  let sellerType: string;
  let amount: string;
  let currencyCode: string;
  let payoutSuborderId: string | null = null;

  if (suborders.length > 0) {
    // Multi-seller (or single-seller-with-suborder) order: the suborder is the
    // payout unit and MUST be named.
    if (!requestedSellerOrderId) {
      throw ApiError.validation([
        {
          field: 'sellerOrderId',
          message:
            'This order is settled per seller suborder: sellerOrderId is required so the payout is issued to the correct seller',
          code: 'VALIDATION_FAILED',
        },
      ]);
    }
    const suborder = suborders.find((s) => s.id === requestedSellerOrderId);
    if (!suborder) {
      // Either no such suborder, or it belongs to a different parent order — both
      // are "not a suborder of this order".
      throw ApiError.validation([
        {
          field: 'sellerOrderId',
          message: 'sellerOrderId does not belong to this order',
          code: 'VALIDATION_FAILED',
        },
      ]);
    }
    payoutSuborderId = suborder.id;
    sellerOrderId = suborder.id;
    sellerId = suborder.sellerId;
    sellerType = suborder.sellerType;
    currencyCode = suborder.currencyCode;
    // The amount is the suborder's own payable — never the parent total.
    amount = roundMoney(toDecimal(suborder.sellerPayable)).toFixed(4);
  } else {
    // Legacy order with no seller suborders: a passed sellerOrderId is invalid.
    if (requestedSellerOrderId) {
      throw ApiError.validation([
        {
          field: 'sellerOrderId',
          message: 'This order has no seller suborders: sellerOrderId must not be supplied',
          code: 'VALIDATION_FAILED',
        },
      ]);
    }
    if (order.sellerId === null || order.sellerType === null) {
      throw ApiError.conflict(
        'Cannot create a payout for a multi-seller order: payouts are issued per seller suborder',
      );
    }
    sellerId = order.sellerId;
    sellerType = order.sellerType;
    currencyCode = order.currencyCode;
    amount = computeSellerPayable({
      itemsTotal: order.itemsTotal,
      commission: order.commission,
      buyerCommission: order.buyerCommission,
    });
  }

  // Lock both rows BEFORE evaluating any gate, in the fixed order shared with
  // `settleSellerSuborder` — the suborder first, then the transaction — so the
  // settlement state this decision reads can never change under it and the two
  // paths can never deadlock.
  let lockedSuborder: typeof sellerOrders.$inferSelect | null = null;
  if (payoutSuborderId) {
    const lockedRows = await db
      .select()
      .from(sellerOrders)
      .where(eq(sellerOrders.id, payoutSuborderId))
      .limit(1)
      .for('update');
    if (lockedRows.length === 0) throw ApiError.notFound('Seller suborder');
    lockedSuborder = lockedRows[0];
  }
  await db.select().from(transactions).where(eq(transactions.id, transaction.id)).limit(1).for('update');

  // Precondition: the funds must have actually moved at provider/bank level.
  // Checked before the per-suborder gate so an unsettled transaction is reported
  // as such rather than as a missing per-seller settlement.
  const settlement = await db
    .select()
    .from(transactionLedger)
    .where(
      and(
        eq(transactionLedger.transactionId, input.transactionId),
        eq(transactionLedger.entryType, 'SETTLEMENT'),
        eq(transactionLedger.status, 'SETTLED'),
      ),
    )
    .limit(1);
  if (settlement.length === 0) {
    throw ApiError.conflict('Cannot create a payout for a transaction that is not settled');
  }

  // M2.3 — a payout may only follow the SETTLEMENT of this seller's own suborder.
  // Read under the lock taken above, so a concurrent settlement cannot slip
  // between this check and the insert. The parent transaction's SETTLED entry is
  // still required; this gate adds the per-seller dimension on top of it.
  if (lockedSuborder && lockedSuborder.settlementStatus !== 'SETTLED') {
    throw ApiError.conflict('Cannot create a payout before this seller suborder is settled');
  }

  const payout: PayoutRecord = {
    id: newId(),
    orderId: order.id,
    transactionId: transaction.id,
    sellerOrderId,
    sellerId,
    amount,
    currencyCode,
    providerId: provider.id,
    status: 'CREATED',
    payoutRef: null,
    providerRef: null,
    failureReason: null,
  };

  try {
    // The unique index `payouts_unit_live_idx` is the final guard: a concurrent
    // second create for the same unit (suborder when set, else transaction) is
    // rejected here even if both passed the pre-checks above.
    await db.insert(payouts).values({
      id: payout.id,
      orderId: payout.orderId,
      transactionId: payout.transactionId,
      sellerOrderId: payout.sellerOrderId,
      sellerId: payout.sellerId,
      sellerType: sellerType as never,
      amount: payout.amount,
      currencyCode: payout.currencyCode,
      provider: payout.providerId,
      status: 'CREATED',
      idempotencyKey: input.idempotencyKey ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(
        sellerOrderId
          ? 'A payout is already active or completed for this seller suborder'
          : 'A payout is already active or completed for this transaction',
      );
    }
    throw err;
  }

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: 'PAYOUT.CREATED',
    entityType: 'TRANSACTION',
    entityId: transaction.id,
    after: {
      payoutId: payout.id,
      orderId: payout.orderId,
      sellerOrderId: payout.sellerOrderId,
      sellerId: payout.sellerId,
      sellerType,
      amount: payout.amount,
      currencyCode: payout.currencyCode,
      provider: payout.providerId,
    },
  });

  return payout;
}

export interface PayoutEventInput {
  payoutId: string;
  event: PayoutEvent;
  actorId?: string | null;
  ipAddress?: string | null;
}

/**
 * Applies a provider/bank payout event through the engine and persists the
 * resulting state. The transition is decided entirely by `applyPayoutEvent`, so
 * `COMPLETED` is impossible without proof: a missing/invalid `payoutRef`, or a
 * mismatching amount/currency, throws before anything is written.
 */
export async function applyPayoutEventToDb(db: DB, input: PayoutEventInput): Promise<PayoutRecord> {
  const rows = await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Payout');
  const current = toRecord(rows[0]);

  const { record: next, applied, duplicate } = applyPayoutEvent(current, input.event);
  if (!applied || duplicate) return next;

  await db
    .update(payouts)
    .set({
      status: next.status,
      payoutRef: next.payoutRef,
      providerRef: next.providerRef,
      failureReason: next.failureReason,
      updatedAt: new Date(),
      completedAt: next.status === 'COMPLETED' ? new Date() : null,
    })
    .where(eq(payouts.id, next.id));

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: `PAYOUT.${next.status}`,
    entityType: 'TRANSACTION',
    entityId: next.transactionId,
    after: {
      payoutId: next.id,
      status: next.status,
      payoutRef: next.payoutRef,
      providerRef: next.providerRef,
    },
  });

  return next;
}

/** Reads a payout by its own id. */
export async function getPayout(db: DB, payoutId: string): Promise<PayoutRecord> {
  const rows = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Payout');
  return toRecord(rows[0]);
}

/** Reads the payout for a transaction, if any (used by callers/tests). */
export async function findPayoutByTransaction(db: DB, transactionId: string): Promise<PayoutRecord | null> {
  const rows = await db
    .select()
    .from(payouts)
    .where(and(eq(payouts.transactionId, transactionId), sql`${payouts.status} = 'COMPLETED'`))
    .limit(1);
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

export function payoutAmount(order: { itemsTotal: string; commission: string; buyerCommission: string }): string {
  return toDecimal(computeSellerPayable(order)).toFixed(4);
}
