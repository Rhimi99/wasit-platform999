import { and, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, transactionLedger, transactions } from '../../db/schema/commerce';
import { wasitReceipts } from '../../db/schema/receipts';
import { newId } from '../../lib/ids';
import { writeAudit } from '../../lib/audit';
import { applyReceiptEvidence, reverseReceipt, type ReceiptEvidence } from './receipt';

/**
 * WASIT Receipt persistence — the only writer of `wasit_receipts`.
 *
 * `WASIT Funds Received = RECEIVED` is recorded strictly from independent
 * statement evidence. Nothing here reads payment or settlement state, so
 * `Settlement ≠ Received` holds in the data model: a SETTLED ledger produces no
 * receipt row and cannot promote anything to RECEIVED.
 */

export interface RecordReceiptInput {
  transactionId: string;
  evidence: ReceiptEvidence;
  actorId?: string | null;
  ipAddress?: string | null;
}

export interface RecordReceiptResult {
  id: string;
  status: 'RECEIVED';
  reference: string;
  amount: string;
  currencyCode: string;
  source: ReceiptEvidence['source'];
  duplicate: boolean;
}

/**
 * Records that WASIT's commission funds actually landed. Requires an order that
 * is already SETTLED (settlement is a precondition, not the evidence) and an
 * independent statement reference matching the commission amount exactly.
 */
export async function recordReceipt(db: DB, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const txRows = await db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (txRows.length === 0) throw ApiError.notFound('Transaction');
  const transaction = txRows[0];
  if (!transaction.orderId) throw ApiError.conflict('Transaction is not attached to an order');

  // Settlement is a precondition for a receipt to be meaningful, but the
  // receipt's own validity comes from the statement evidence alone.
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
    throw ApiError.conflict('A receipt can only be recorded for a settled transaction');
  }

  const orderRows = await db.select().from(orders).where(eq(orders.id, transaction.orderId)).limit(1);
  if (orderRows.length === 0) throw ApiError.notFound('Order');
  const order = orderRows[0];

  // WASIT's commission receivable = the total commission on the order.
  const expected = { amount: order.commission, currencyCode: order.currencyCode };
  const decision = applyReceiptEvidence(input.evidence, expected);

  const existing = await db
    .select()
    .from(wasitReceipts)
    .where(and(eq(wasitReceipts.source, decision.source), eq(wasitReceipts.reference, decision.reference)))
    .limit(1);
  if (existing.length > 0) {
    return {
      id: existing[0].id,
      status: 'RECEIVED',
      reference: existing[0].reference,
      amount: existing[0].amount,
      currencyCode: existing[0].currencyCode,
      source: existing[0].source,
      duplicate: true,
    };
  }

  const id = newId();
  await db.insert(wasitReceipts).values({
    id,
    orderId: order.id,
    transactionId: transaction.id,
    reference: decision.reference,
    amount: decision.amount,
    currencyCode: decision.currencyCode,
    source: decision.source,
    status: 'RECEIVED',
    receivedAt: new Date(),
  });

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: 'WASIT_RECEIPT.RECEIVED',
    entityType: 'TRANSACTION',
    entityId: transaction.id,
    after: {
      receiptId: id,
      orderId: order.id,
      reference: decision.reference,
      amount: decision.amount,
      currencyCode: decision.currencyCode,
      source: decision.source,
    },
  });

  return {
    id,
    status: 'RECEIVED',
    reference: decision.reference,
    amount: decision.amount,
    currencyCode: decision.currencyCode,
    source: decision.source,
    duplicate: false,
  };
}

/** Reverses a receipt (bank reversal/chargeback). Keeps the original evidence. */
export async function reverseReceiptInDb(
  db: DB,
  input: { receiptId: string; reason: string; actorId?: string | null; ipAddress?: string | null },
): Promise<void> {
  const { status } = reverseReceipt(input.reason);
  const rows = await db.select().from(wasitReceipts).where(eq(wasitReceipts.id, input.receiptId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Receipt');
  if (rows[0].status !== 'RECEIVED') {
    throw ApiError.conflict('Only a received receipt can be reversed');
  }

  await db
    .update(wasitReceipts)
    .set({ status, reversedAt: new Date(), updatedAt: new Date() })
    .where(eq(wasitReceipts.id, input.receiptId));

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: 'WASIT_RECEIPT.REVERSED',
    entityType: 'TRANSACTION',
    entityId: rows[0].transactionId,
    after: { receiptId: input.receiptId, reason: input.reason },
  });
}
