import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, transactionLedger, transactions } from '../../db/schema/commerce';
import { payouts } from '../../db/schema/payouts';
import { resolvePaymentProviderById } from '../../lib/payments/resolve';
import { newId } from '../../lib/ids';
import { toDecimal } from '../../lib/money';
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
 */

function toRecord(row: typeof payouts.$inferSelect): PayoutRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    transactionId: row.transactionId,
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
  idempotencyKey?: string | null;
  actorId?: string | null;
  ipAddress?: string | null;
}

/**
 * Creates (or returns) the seller payout for a settled transaction. Amount is
 * derived from the order (items total minus the seller commission share) — never
 * supplied by the caller, so it cannot be inflated.
 *
 * Idempotent on `idempotencyKey`: replaying the same request returns the same
 * payout row instead of a second one.
 */
export async function createPayout(db: DB, input: CreatePayoutInput): Promise<PayoutRecord> {
  const provider = resolvePaymentProviderById(input.providerId);
  assertPayoutCapable(provider.id, provider.capabilities);

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

  // Precondition: the funds must have actually moved at provider/bank level.
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

  const orderRows = await db.select().from(orders).where(eq(orders.id, transaction.orderId)).limit(1);
  if (orderRows.length === 0) throw ApiError.notFound('Order');
  const order = orderRows[0];

  const amount = computeSellerPayable({
    itemsTotal: order.itemsTotal,
    commission: order.commission,
    buyerCommission: order.buyerCommission,
  });

  const payout: PayoutRecord = {
    id: newId(),
    orderId: order.id,
    transactionId: transaction.id,
    sellerId: order.sellerId,
    amount,
    currencyCode: order.currencyCode,
    providerId: provider.id,
    status: 'CREATED',
    payoutRef: null,
    providerRef: null,
    failureReason: null,
  };

  try {
    await db.insert(payouts).values({
      id: payout.id,
      orderId: payout.orderId,
      transactionId: payout.transactionId,
      sellerId: payout.sellerId,
      sellerType: order.sellerType,
      amount: payout.amount,
      currencyCode: payout.currencyCode,
      provider: payout.providerId,
      status: 'CREATED',
      idempotencyKey: input.idempotencyKey ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('A payout is already active for this transaction');
    throw err;
  }

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: 'PAYOUT.CREATED',
    entityType: 'TRANSACTION',
    entityId: transaction.id,
    after: {
      payoutId: payout.id,
      orderId: payout.orderId,
      sellerId: payout.sellerId,
      sellerType: order.sellerType,
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
