import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { orders, sellerOrders, transactions } from '../src/db/schema/commerce.js';
import { trustScores } from '../src/db/schema/trust.js';
import { countSellerTransactions } from '../src/lib/seller-attribution.js';
import { computeTrustScore } from '../src/lib/trust-engine.js';
import { users } from '../src/db/schema/auth.js';

/**
 * M2.5-TX-SELLER-ATTRIBUTION — the seller attribution layer.
 *
 * These run against the isolated `wasit_test` database. Every row is namespaced
 * with a per-run `stamp` and the assertions are scoped to the ids this test
 * created, so the suite is safe under the shared, parallel test DB.
 */

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
const ids: string[] = [];
const orderIds: string[] = [];

function newId(): string {
  const id = randomUUID();
  ids.push(id);
  return id;
}

function orderNumber(): string {
  seq += 1;
  return `M25-${stamp}-${seq}`;
}

afterAll(async () => {
  for (const id of orderIds) {
    await db.delete(sellerOrders).where(eq(sellerOrders.parentOrderId, id));
    await db.delete(orders).where(eq(orders.id, id));
  }
  for (const id of ids) {
    await db.delete(transactions).where(eq(transactions.orderId, id));
    await db.delete(trustScores).where(eq(trustScores.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeDb();
});

/**
 * Creates one order row with the given seller (or null for a multi-seller
 * parent) and optional suborders, mirroring exactly what `orders/service.ts`
 * writes: ONE `transactions` row per parent, attributed to `soleSeller` or the
 * first product's seller when the basket spans several sellers.
 */
async function makeOrder(opts: {
  parentSellerId: string | null;
  paymentStatus?: 'UNPAID' | 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  suborders?: Array<{ sellerId: string; status?: 'PENDING' | 'CONFIRMED' }>;
  transactionSellerId?: string;
  /** Override the transaction row's status, to model a field divergence. */
  transactionStatus?: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
}): Promise<string> {
  const orderId = newId();
  orderIds.push(orderId);
  await db.insert(orders).values({
    id: orderId,
    orderNumber: orderNumber(),
    buyerId: newId(),
    buyerType: 'CUSTOMER',
    sellerId: opts.parentSellerId,
    sellerType: opts.parentSellerId ? 'MERCHANT' : null,
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    paymentFee: '2.0000',
    grandTotal: '102.0000',
    status: 'PENDING',
    paymentStatus: opts.paymentStatus ?? 'UNPAID',
  });
  for (const sub of opts.suborders ?? []) {
    await db.insert(sellerOrders).values({
      id: newId(),
      parentOrderId: orderId,
      orderNumber: orderNumber(),
      sellerOrderNumber: `SO-${stamp}-${seq}`,
      sellerId: sub.sellerId,
      sellerType: 'MERCHANT',
      currencyCode: 'TND',
      itemsTotal: '100.0000',
      commission: '4.0000',
      buyerCommission: '2.0000',
      sellerCommission: '2.0000',
      sellerPayable: '98.0000',
      status: sub.status ?? 'PENDING',
      settlementStatus: 'PENDING',
    });
  }
  // The single payment row, exactly as production writes it.
  const txSeller = opts.transactionSellerId ?? opts.parentSellerId ?? opts.suborders?.[0]?.sellerId;
  if (txSeller) {
    const txStatus = opts.transactionStatus ?? (opts.paymentStatus === 'PAID' ? 'PAID' : 'PENDING');
    await db.insert(transactions).values({
      id: newId(),
      transactionNumber: `TX-${stamp}-${seq}`,
      orderId,
      buyerId: newId(),
      sellerId: txSeller,
      productId: null,
      totalValue: '102.0000',
      currencyCode: 'TND',
      status: txStatus,
    });
  }
  return orderId;
}

describe('M2.5 countSellerTransactions — per-seller attribution', () => {
  it('1) single-seller order: counted once, no double count', async () => {
    const seller = newId();
    await makeOrder({
      parentSellerId: seller,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: seller, status: 'CONFIRMED' }],
    });

    const counts = await countSellerTransactions(db, [seller]);
    expect(counts).toEqual({ total: 1, successful: 1 });
  });

  it('2) two-seller order: each seller counts their own suborder only', async () => {
    const a = newId();
    const b = newId();
    await makeOrder({
      parentSellerId: null,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: a }, { sellerId: b }],
      transactionSellerId: a, // production collapses the payment onto one seller
    });

    expect(await countSellerTransactions(db, [a])).toEqual({ total: 1, successful: 1 });
    expect(await countSellerTransactions(db, [b])).toEqual({ total: 1, successful: 1 });
  });

  it('3) three-seller order: each of the three counts 1 (basket is not credited to one)', async () => {
    const a = newId();
    const b = newId();
    const c = newId();
    await makeOrder({
      parentSellerId: null,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: a }, { sellerId: b }, { sellerId: c }],
      transactionSellerId: a,
    });

    expect(await countSellerTransactions(db, [a])).toEqual({ total: 1, successful: 1 });
    expect(await countSellerTransactions(db, [b])).toEqual({ total: 1, successful: 1 });
    expect(await countSellerTransactions(db, [c])).toEqual({ total: 1, successful: 1 });
  });

  it('4) a seller not in the order is unaffected', async () => {
    const inOrder = newId();
    const outsider = newId();
    await makeOrder({
      parentSellerId: inOrder,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: inOrder }],
    });

    expect(await countSellerTransactions(db, [outsider])).toEqual({ total: 0, successful: 0 });
  });

  it('5) legacy single-seller order with no suborder: counted via the parent fallback', async () => {
    const seller = newId();
    await makeOrder({ parentSellerId: seller, paymentStatus: 'PAID', suborders: [] });

    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 1 });
  });

  it('6) legacy MIXED order (no suborders, null parent seller): never attributed to anyone', async () => {
    await makeOrder({ parentSellerId: null, paymentStatus: 'PAID', suborders: [] });
    const anySeller = newId();

    // No seller can claim it — in particular it is not dumped on a first seller.
    expect(await countSellerTransactions(db, [anySeller])).toEqual({ total: 0, successful: 0 });
  });

  it('7) order WITH suborders and a non-null parent seller: parent is NOT double counted', async () => {
    const seller = newId();
    await makeOrder({
      parentSellerId: seller, // parent names the seller too
      paymentStatus: 'PAID',
      suborders: [{ sellerId: seller }],
    });

    // Counted once (through the suborder), not twice (suborder + parent).
    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 1 });
  });

  it('8) paid vs unpaid follows the parent payment status', async () => {
    const paid = newId();
    const unpaid = newId();
    await makeOrder({ parentSellerId: paid, paymentStatus: 'PAID', suborders: [{ sellerId: paid }] });
    await makeOrder({ parentSellerId: unpaid, paymentStatus: 'UNPAID', suborders: [{ sellerId: unpaid }] });

    expect(await countSellerTransactions(db, [paid])).toEqual({ total: 1, successful: 1 });
    expect(await countSellerTransactions(db, [unpaid])).toEqual({ total: 1, successful: 0 });
  });

  it('9) successful transactions are not multiplied across a basket', async () => {
    const a = newId();
    const b = newId();
    const c = newId();
    await makeOrder({
      parentSellerId: null,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: a }, { sellerId: b }, { sellerId: c }],
      transactionSellerId: a,
    });

    const all = await countSellerTransactions(db, [a, b, c]);
    // Three sellers each with one suborder => 3 total, 3 successful (not 1, not 9).
    expect(all).toEqual({ total: 3, successful: 3 });
  });

  it('10) one seller\'s statistics never leak into another', async () => {
    const a = newId();
    const b = newId();
    await makeOrder({ parentSellerId: a, paymentStatus: 'PAID', suborders: [{ sellerId: a }] });
    await makeOrder({ parentSellerId: a, paymentStatus: 'PAID', suborders: [{ sellerId: a }] });

    expect(await countSellerTransactions(db, [a])).toEqual({ total: 2, successful: 2 });
    expect(await countSellerTransactions(db, [b])).toEqual({ total: 0, successful: 0 });
  });

  it('11) duplicate and empty inputs are handled safely (no double count, no widening)', async () => {
    const seller = newId();
    await makeOrder({ parentSellerId: seller, paymentStatus: 'PAID', suborders: [{ sellerId: seller }] });

    expect(await countSellerTransactions(db, [seller, seller, seller])).toEqual({ total: 1, successful: 1 });
    expect(await countSellerTransactions(db, [])).toEqual({ total: 0, successful: 0 });
    expect(await countSellerTransactions(db, [''])).toEqual({ total: 0, successful: 0 });
  });

  it('12) mixed basket in one call: paid and unpaid coexist without cross-contamination', async () => {
    const a = newId();
    const b = newId();
    await makeOrder({ parentSellerId: a, paymentStatus: 'PAID', suborders: [{ sellerId: a }] });
    await makeOrder({ parentSellerId: b, paymentStatus: 'UNPAID', suborders: [{ sellerId: b }] });

    expect(await countSellerTransactions(db, [a, b])).toEqual({ total: 2, successful: 1 });
  });
});

describe('M2.5 — trust score uses the attributed counts (score equation unchanged)', () => {
  async function makeUser(): Promise<string> {
    const id = newId();
    await db.insert(users).values({
      id,
      email: `m25-${id}@wasit.tn`,
      passwordHash: 'x',
      firstName: 'M25',
      lastName: 'Seller',
      emailVerified: false,
      phoneVerified: false,
    });
    return id;
  }

  it('12) a user selling in a mixed basket scores on their own suborder, not the whole basket', async () => {
    const user = await makeUser();
    const otherA = newId();
    const otherB = newId();
    // A three-seller basket where this user is NOT the seller the payment row
    // names — the old logic would have credited them zero.
    await makeOrder({
      parentSellerId: null,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: otherA }, { sellerId: user }, { sellerId: otherB }],
      transactionSellerId: otherA,
    });

    const result = await computeTrustScore(db, user);
    // The user's own seller id is counted (their suborder), so the transaction
    // factor sees 1/1 instead of 0/0.
    expect(result.factors.totalTransactions).toBe(1);
    expect(result.factors.successfulTransactions).toBe(1);
    expect(result.summary).toContain('1/1 successful transactions');
  });

  it('12) a legacy single-seller user still scores as before', async () => {
    const user = await makeUser();
    await makeOrder({ parentSellerId: user, paymentStatus: 'PAID', suborders: [] });

    const result = await computeTrustScore(db, user);
    expect(result.factors.totalTransactions).toBe(1);
    expect(result.factors.successfulTransactions).toBe(1);
  });
});

describe('M2.5-T3 — success meaning is driven by orders.payment_status, not transactions.status', () => {
  it('a transaction still PENDING while the parent is PAID does not lose the success', async () => {
    const seller = newId();
    // Field divergence: the payment row lags the order. The success must be
    // decided by the order's payment status (the single payment truth).
    await makeOrder({
      parentSellerId: seller,
      paymentStatus: 'PAID',
      suborders: [{ sellerId: seller }],
      transactionStatus: 'PENDING',
    });

    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 1 });
  });

  it('a refunded parent is not counted as successful, even if the transaction still reads PAID', async () => {
    const seller = newId();
    await makeOrder({
      parentSellerId: seller,
      paymentStatus: 'REFUNDED',
      suborders: [{ sellerId: seller }],
      transactionStatus: 'PAID',
    });

    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 0 });
  });

  it('a legacy single-seller order is counted from the parent, never from transactions.status', async () => {
    const seller = newId();
    await makeOrder({
      parentSellerId: seller,
      paymentStatus: 'PAID',
      suborders: [],
      transactionStatus: 'FAILED',
    });

    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 1 });
  });

  it('an UNPAID parent whose transaction reads PAID is not counted as successful', async () => {
    const seller = newId();
    await makeOrder({
      parentSellerId: seller,
      paymentStatus: 'UNPAID',
      suborders: [{ sellerId: seller }],
      transactionStatus: 'PAID',
    });

    expect(await countSellerTransactions(db, [seller])).toEqual({ total: 1, successful: 0 });
  });
});
