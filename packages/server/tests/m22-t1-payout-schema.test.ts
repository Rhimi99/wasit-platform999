import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { orders, sellerOrders, transactions } from '../src/db/schema/commerce.js';
import { payouts } from '../src/db/schema/payouts.js';
import { suppliers } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';

/**
 * M2.2-T1 — Payout schema for independent per-seller-suborder payouts.
 *
 * Verifies, against real PostgreSQL, the invariants added by migration 0038:
 *  - `payouts.seller_order_id` accepts a legacy NULL (old single-seller payout);
 *  - the composite FK proves the suborder belongs to the SAME order AND seller;
 *  - `payouts_unit_live_idx` blocks a second live/completed payout for the same
 *    unit (suborder when set, else transaction), yet allows one payout per
 *    seller suborder sharing a parent transaction;
 *  - the legacy per-transaction indexes are gone, and `payout_ref` uniqueness
 *    still holds.
 */

afterAll(async () => {
  await closeDb();
});

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeSeller(): Promise<{ userId: string; sellerId: string }> {
  const s = stamp();
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `it-t1-s-${s}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'T1',
    isActive: true,
    emailVerified: true,
  });
  const sellerId = `sup-t1-${s}`;
  await db.insert(suppliers).values({
    id: sellerId,
    userId,
    companyName: `T1 Supplier ${s}`,
    slug: `sup-t1-${s}`,
  });
  return { userId, sellerId };
}

async function makeParentOrder(sellerId: string): Promise<{ orderId: string; txId: string }> {
  const s = stamp();
  const buyerId = randomUUID();
  await db.insert(users).values({
    id: buyerId,
    email: `it-t1-b-${s}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'B',
    isActive: true,
    emailVerified: true,
  });
  const orderId = `ord-t1-${s}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDT1-${s}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId,
    sellerType: 'SUPPLIER',
    status: 'CONFIRMED',
    itemsTotal: '100.0000',
    grandTotal: '100.0000',
    currencyCode: 'TND',
  });
  const txId = `tx-t1-${s}`;
  await db.insert(transactions).values({
    id: txId,
    transactionNumber: `TXT1-${s}`,
    orderId,
    buyerId,
    sellerId,
    paymentProvider: 'manual',
    totalValue: '100.0000',
    currencyCode: 'TND',
    status: 'PAID',
  });
  return { orderId, txId };
}

async function makeSuborder(orderId: string, sellerId: string): Promise<string> {
  const id = randomUUID();
  const s = stamp();
  await db.insert(sellerOrders).values({
    id,
    parentOrderId: orderId,
    orderNumber: `ORDT1-${s}`,
    sellerOrderNumber: `SUB-${s}`,
    sellerId,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    status: 'CONFIRMED',
  });
  return id;
}

function payoutRow(over: Partial<typeof payouts.$inferInsert> & { id: string; orderId: string; transactionId: string; sellerId: string }) {
  return {
    sellerType: 'SUPPLIER' as const,
    amount: '98.0000',
    currencyCode: 'TND',
    provider: 'manual',
    status: 'CREATED' as const,
    ...over,
  };
}

describe('M2.2-T1 payout schema (real PostgreSQL)', () => {
  it('accepts a legacy payout with seller_order_id = NULL', async () => {
    const { sellerId } = await makeSeller();
    const { orderId, txId } = await makeParentOrder(sellerId);
    const id = randomUUID();
    await db.insert(payouts).values(payoutRow({ id, orderId, transactionId: txId, sellerId }));
    const [row] = await db.select().from(payouts).where(eq(payouts.id, id));
    expect(row.sellerOrderId).toBeNull();
  });

  it('rejects a seller_order_id that does not belong to the same order and seller (composite FK)', async () => {
    const a = await makeSeller();
    const b = await makeSeller();
    const { orderId, txId } = await makeParentOrder(a.sellerId);
    // A real suborder, but of a DIFFERENT parent order/seller.
    const otherParent = await makeParentOrder(b.sellerId);
    const foreignSub = await makeSuborder(otherParent.orderId, b.sellerId);
    await expect(
      db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId: a.sellerId, sellerOrderId: foreignSub })),
    ).rejects.toThrow(/payouts_suborder_fk|foreign key/i);
  });

  it('blocks a second live/completed payout for the same unit (legacy: same transaction)', async () => {
    const { sellerId } = await makeSeller();
    const { orderId, txId } = await makeParentOrder(sellerId);
    await db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId }));
    await expect(
      db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId, status: 'COMPLETED', payoutRef: `ref-${stamp()}` })),
    ).rejects.toThrow(/payouts_unit_live_idx|duplicate key/i);
  });

  it('allows an independent payout unit per seller suborder on the SAME parent transaction', async () => {
    const a = await makeSeller();
    const b = await makeSeller();
    const { orderId, txId } = await makeParentOrder(a.sellerId);
    const subA = await makeSuborder(orderId, a.sellerId);
    const subB = await makeSuborder(orderId, b.sellerId);
    await db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId: a.sellerId, sellerOrderId: subA }));
    await db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId: b.sellerId, sellerOrderId: subB }));
    const rows = await db.select().from(payouts).where(eq(payouts.transactionId, txId));
    expect(rows.length).toBe(2);
  });

  it('blocks a duplicate live payout for the SAME suborder', async () => {
    const { sellerId } = await makeSeller();
    const { orderId, txId } = await makeParentOrder(sellerId);
    const sub = await makeSuborder(orderId, sellerId);
    await db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId, sellerOrderId: sub }));
    await expect(
      db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId, transactionId: txId, sellerId, sellerOrderId: sub })),
    ).rejects.toThrow(/payouts_unit_live_idx|duplicate key/i);
  });

  it('still enforces unique payout_ref', async () => {
    const a = await makeSeller();
    const b = await makeSeller();
    const oa = await makeParentOrder(a.sellerId);
    const ob = await makeParentOrder(b.sellerId);
    const ref = `ref-uniq-${stamp()}`;
    await db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId: oa.orderId, transactionId: oa.txId, sellerId: a.sellerId, payoutRef: ref }));
    await expect(
      db.insert(payouts).values(payoutRow({ id: randomUUID(), orderId: ob.orderId, transactionId: ob.txId, sellerId: b.sellerId, payoutRef: ref })),
    ).rejects.toThrow(/payouts_payout_ref_idx|duplicate key/i);
  });
});
