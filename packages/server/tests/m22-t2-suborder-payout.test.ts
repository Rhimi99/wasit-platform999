import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { orders, sellerOrders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { payouts } from '../src/db/schema/payouts.js';
import { suppliers } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';
import { createPayout } from '../src/modules/payouts/service.js';
import { applyPayoutEventToDb } from '../src/modules/payouts/service.js';
import { settleSellerSuborder } from '../src/modules/settlements/service.js';
import { SandboxPayoutProvider } from '../src/lib/payments/sandbox-payout.js';
import { syncPayoutFromProvider } from '../src/modules/payouts/provider-service.js';

/**
 * M2.2-T2 — Seller suborder payout.
 *
 * Proves that a payout is issued PER SELLER SUBORDER: the unit is the suborder,
 * the amount is that suborder's own `seller_payable`, the suborder must belong
 * to the named parent order, and the composite FK makes the (suborder, order,
 * seller) triple a database invariant. Legacy single-seller orders keep the old
 * shape with `seller_order_id = NULL`.
 *
 * Settlement is still the precondition: no SETTLED ledger entry ⇒ no payout.
 */

afterAll(async () => {
  await closeDb();
});

const PROVIDER = 'sandbox';

/** Captures a rejection as an ApiError-shaped object for field-level assertions. */
async function rejection(p: Promise<unknown>): Promise<{ message: string; fields: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; fieldErrors?: { message: string }[] };
    return {
      message: err.message ?? '',
      fields: (err.fieldErrors ?? []).map((f) => f.message).join(' | '),
    };
  }
  throw new Error('Expected the call to reject, but it resolved');
}

async function makeSellerUserAndSupplier(stamp: string, tag: string) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `m22t2-${tag}-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const supplierId = `sup-m22t2-${tag}-${stamp}`;
  await db.insert(suppliers).values({
    id: supplierId,
    userId,
    companyName: `M22T2 ${tag} ${stamp}`,
    slug: `sup-m22t2-${tag}-${stamp}`,
  });
  return supplierId;
}

/**
 * Builds a MULTI-SELLER parent order: no single seller on the parent, two
 * suborders with their own payable, one transaction, and a SETTLED ledger entry.
 */
async function multiSellerOrder(opts: { settle?: boolean; settleSuborders?: boolean; sub1Payable?: string; sub2Payable?: string } = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const buyerId = randomUUID();
  await db.insert(users).values({
    id: buyerId,
    email: `m22t2-buyer-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'Buyer',
    isActive: true,
    emailVerified: true,
  });
  const seller1 = await makeSellerUserAndSupplier(stamp, 's1');
  const seller2 = await makeSellerUserAndSupplier(stamp, 's2');

  const orderId = `ord-m22t2-${stamp}`;
  const orderNumber = `ORDM22T2-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId: null,
    sellerType: null,
    currencyCode: 'TND',
    itemsTotal: '150.0000',
    commission: '6.0000',
    buyerCommission: '3.0000',
    paymentFee: '0',
    grandTotal: '150.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });

  const sub1Payable = opts.sub1Payable ?? '98.0000';
  const sub2Payable = opts.sub2Payable ?? '49.0000';
  const sub1Id = `sub-m22t2-1-${stamp}`;
  const sub2Id = `sub-m22t2-2-${stamp}`;
  await db.insert(sellerOrders).values([
    {
      id: sub1Id,
      parentOrderId: orderId,
      orderNumber,
      sellerOrderNumber: `${orderNumber}-S1`,
      sellerId: seller1,
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '100.0000',
      commission: '4.0000',
      buyerCommission: '2.0000',
      sellerCommission: '2.0000',
      sellerPayable: sub1Payable,
      status: 'DELIVERED',
      settlementStatus: 'PENDING',
    },
    {
      id: sub2Id,
      parentOrderId: orderId,
      orderNumber,
      sellerOrderNumber: `${orderNumber}-S2`,
      sellerId: seller2,
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '50.0000',
      commission: '2.0000',
      buyerCommission: '1.0000',
      sellerCommission: '1.0000',
      sellerPayable: sub2Payable,
      status: 'DELIVERED',
      settlementStatus: 'PENDING',
    },
  ]);

  const transactionId = `txn-m22t2-${stamp}`;
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `TXM22T2-${stamp}`,
    orderId,
    buyerId,
    sellerId: seller1,
    totalValue: '150.0000',
    currencyCode: 'TND',
    commission: '6.0000',
    buyerCommission: '3.0000',
    status: 'PAID',
  });

  if (opts.settle !== false) {
    await db.insert(transactionLedger).values({
      id: randomUUID(),
      transactionId,
      entryType: 'SETTLEMENT',
      direction: 'CREDIT',
      amount: '150.0000',
      currencyCode: 'TND',
      status: 'SETTLED',
    });
    // M2.3 — a payout now requires the seller's own suborder to be SETTLED. The
    // fixture settles both (both are DELIVERED) unless a spec opts out to test the
    // gate itself.
    if (opts.settleSuborders !== false) {
      await settleSellerSuborder(db, sub1Id);
      await settleSellerSuborder(db, sub2Id);
    }
  }

  return { orderId, transactionId, seller1, seller2, sub1Id, sub2Id };
}

/** Builds a LEGACY single-seller order with NO seller suborders. */
async function legacyOrder(opts: { settle?: boolean } = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const buyerId = randomUUID();
  await db.insert(users).values({
    id: buyerId,
    email: `m22t2-lbuyer-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'LBuyer',
    isActive: true,
    emailVerified: true,
  });
  const seller1 = await makeSellerUserAndSupplier(stamp, 'ls1');

  const orderId = `ord-m22t2l-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDM22T2L-${stamp}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId: seller1,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    paymentFee: '0',
    grandTotal: '100.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });

  const transactionId = `txn-m22t2l-${stamp}`;
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `TXM22T2L-${stamp}`,
    orderId,
    buyerId,
    sellerId: seller1,
    totalValue: '100.0000',
    currencyCode: 'TND',
    commission: '4.0000',
    buyerCommission: '2.0000',
    status: 'PAID',
  });

  if (opts.settle !== false) {
    await db.insert(transactionLedger).values({
      id: randomUUID(),
      transactionId,
      entryType: 'SETTLEMENT',
      direction: 'CREDIT',
      amount: '100.0000',
      currencyCode: 'TND',
      status: 'SETTLED',
    });
  }

  return { orderId, transactionId, seller1 };
}

describe('M2.2-T2 — payout per seller suborder', () => {
  it('1. creates a payout for one seller of a multi-seller order, using the suborder payable', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, {
      transactionId: s.transactionId,
      sellerOrderId: s.sub1Id,
      providerId: PROVIDER,
    });
    expect(payout.sellerOrderId).toBe(s.sub1Id);
    expect(payout.sellerId).toBe(s.seller1);
    // Amount is the suborder's own payable — never the parent total (150).
    expect(payout.amount).toBe('98.0000');
    expect(payout.currencyCode).toBe('TND');
    expect(payout.status).toBe('CREATED');
  });

  it('2. creates an independent payout for the second seller of the same parent order', async () => {
    const s = await multiSellerOrder();
    const p1 = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    const p2 = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub2Id, providerId: PROVIDER });
    expect(p1.id).not.toBe(p2.id);
    expect(p2.sellerOrderId).toBe(s.sub2Id);
    expect(p2.sellerId).toBe(s.seller2);
    expect(p2.amount).toBe('49.0000');
    // Two distinct rows on the same transaction.
    const rows = await db.select().from(payouts).where(eq(payouts.transactionId, s.transactionId));
    expect(rows.length).toBe(2);
  });

  it('3. rejects a missing sellerOrderId for a multi-seller order', async () => {
    const s = await multiSellerOrder();
    const err = await rejection(createPayout(db, { transactionId: s.transactionId, providerId: PROVIDER }));
    expect(err.fields).toMatch(/sellerOrderId is required/i);
  });

  it('4. rejects a non-existent sellerOrderId', async () => {
    const s = await multiSellerOrder();
    const err = await rejection(
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: randomUUID(), providerId: PROVIDER }),
    );
    expect(err.fields).toMatch(/does not belong to this order/i);
  });

  it('5. rejects a sellerOrderId that belongs to a different parent order', async () => {
    const a = await multiSellerOrder();
    const b = await multiSellerOrder();
    const err = await rejection(
      createPayout(db, { transactionId: a.transactionId, sellerOrderId: b.sub1Id, providerId: PROVIDER }),
    );
    expect(err.fields).toMatch(/does not belong to this order/i);
  });

  it('6. attributes the payout to the suborder seller, and the FK refuses a mismatched seller', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    // The derived seller is the suborder's seller, never the other seller.
    expect(payout.sellerId).toBe(s.seller1);
    expect(payout.sellerId).not.toBe(s.seller2);

    // A direct write that names the WRONG seller for a suborder is refused by
    // the composite FK `payouts_suborder_fk` (suborder, order, seller).
    await expect(
      db.insert(payouts).values({
        id: randomUUID(),
        orderId: s.orderId,
        transactionId: s.transactionId,
        sellerOrderId: s.sub1Id,
        sellerId: s.seller2,
        sellerType: 'SUPPLIER',
        amount: '98.0000',
        currencyCode: 'TND',
        provider: PROVIDER,
        status: 'CREATED',
      }),
    ).rejects.toThrow();
  });

  it('7 & 8. amount equals sellerPayable exactly — never the parent total, never partial, and a supplied amount is ignored', async () => {
    const s = await multiSellerOrder({ sub1Payable: '98.0000' });
    const payout = await createPayout(db, {
      transactionId: s.transactionId,
      sellerOrderId: s.sub1Id,
      providerId: PROVIDER,
      // A caller-supplied amount must never be honored.
      ...({ amount: '1000.0000' } as unknown as Record<string, never>),
    });
    expect(payout.amount).toBe('98.0000');
    expect(payout.amount).not.toBe('150.0000'); // parent total
    expect(payout.amount).not.toBe('1000.0000'); // inflated
  });

  it('9. carries the suborder currency and 4-decimal precision', async () => {
    const s = await multiSellerOrder({ sub1Payable: '98.5000' });
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    expect(payout.currencyCode).toBe('TND');
    expect(payout.amount).toMatch(/^\d+\.\d{4}$/);
    expect(payout.amount).toBe('98.5000');
  });

  it('9b. a completion with the wrong currency is refused and the payout stays non-COMPLETED', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    await applyPayoutEventToDb(db, { payoutId: payout.id, event: { type: 'payout.processing', providerRef: 'ref-1' } });
    await expect(
      applyPayoutEventToDb(db, {
        payoutId: payout.id,
        event: { type: 'payout.completed', payoutRef: 'tr-1', amount: payout.amount, currencyCode: 'USD' },
      }),
    ).rejects.toThrow(/currency/i);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).not.toBe('COMPLETED');
  });

  it('10. rejects a payout before the transaction is settled', async () => {
    const s = await multiSellerOrder({ settle: false });
    await expect(
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
    ).rejects.toThrow(/not settled/i);
  });

  it('11. accepts a legacy single-seller order with seller_order_id = NULL', async () => {
    const l = await legacyOrder();
    const payout = await createPayout(db, { transactionId: l.transactionId, providerId: PROVIDER });
    expect(payout.sellerOrderId).toBeNull();
    expect(payout.sellerId).toBe(l.seller1);
    // Legacy amount is derived from the parent: 100 − (4 − 2) = 98.
    expect(payout.amount).toBe('98.0000');
  });

  it('11b. rejects a sellerOrderId supplied for a legacy order that has none', async () => {
    const l = await legacyOrder();
    const err = await rejection(
      createPayout(db, { transactionId: l.transactionId, sellerOrderId: randomUUID(), providerId: PROVIDER }),
    );
    expect(err.fields).toMatch(/no seller suborders/i);
  });

  it('12. blocks a duplicate payout for the same seller suborder', async () => {
    const s = await multiSellerOrder();
    await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    await expect(
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
    ).rejects.toThrow(/already active or completed for this seller suborder/i);
  });

  it('13. blocks duplication when two creates for the same suborder run concurrently', async () => {
    const s = await multiSellerOrder();
    const results = await Promise.allSettled([
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    const rows = await db
      .select()
      .from(payouts)
      .where(and(eq(payouts.sellerOrderId, s.sub1Id), eq(payouts.transactionId, s.transactionId)));
    expect(rows.length).toBe(1);
  });

  it('14. preserves idempotency: replaying the same key returns the same payout', async () => {
    const s = await multiSellerOrder();
    const key = `idem-${randomUUID()}`;
    const first = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER, idempotencyKey: key });
    const second = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER, idempotencyKey: key });
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(payouts).where(eq(payouts.idempotencyKey, key));
    expect(rows.length).toBe(1);
  });

  it('15. a FAILED payout allows a retry (new attempt) for the same suborder', async () => {
    const s = await multiSellerOrder();
    const failed = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    await applyPayoutEventToDb(db, { payoutId: failed.id, event: { type: 'payout.failed', reason: 'provider rejected' } });
    const [row] = await db.select().from(payouts).where(eq(payouts.id, failed.id)).limit(1);
    expect(row.status).toBe('FAILED');

    // FAILED is excluded from the live index, so a new attempt is allowed.
    const retry = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    expect(retry.id).not.toBe(failed.id);
    expect(retry.status).toBe('CREATED');
    // The historical FAILED record is preserved, not deleted.
    const all = await db.select().from(payouts).where(eq(payouts.sellerOrderId, s.sub1Id));
    expect(all.length).toBe(2);
  });

  it('15b. a HELD payout blocks a second attempt for the same suborder', async () => {
    const s = await multiSellerOrder();
    const held = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    await applyPayoutEventToDb(db, { payoutId: held.id, event: { type: 'payout.held', reason: 'timeout / unknown' } });
    const [row] = await db.select().from(payouts).where(eq(payouts.id, held.id)).limit(1);
    expect(row.status).toBe('HELD');
    await expect(
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
    ).rejects.toThrow(/already active or completed/i);
  });

  it('15c. a timeout/UNKNOWN provider status is treated as HELD, never a failure or success', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'held');
    await (await import('../src/modules/payouts/provider-service.js')).dispatchPayoutToProvider(db, {
      payoutId: payout.id,
      beneficiaryRef: 'b',
      provider: sandbox,
    });
    const result = await syncPayoutFromProvider(db, { payoutId: payout.id, provider: sandbox });
    expect(result.payout.status).toBe('HELD');
    expect(result.payout.status).not.toBe('COMPLETED');
    expect(result.payout.status).not.toBe('FAILED');
  });

  it('16. refuses a completion claim without documented evidence', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'completed_without_reference');
    await (await import('../src/modules/payouts/provider-service.js')).dispatchPayoutToProvider(db, {
      payoutId: payout.id,
      beneficiaryRef: 'b',
      provider: sandbox,
    });
    await expect(syncPayoutFromProvider(db, { payoutId: payout.id, provider: sandbox })).rejects.toThrow(
      /transfer reference/i,
    );
    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('PROCESSING');
    expect(row.payoutRef).toBeNull();
  });

  it('17. blocks a duplicate payout once one is COMPLETED for the same suborder', async () => {
    const s = await multiSellerOrder();
    const payout = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    await applyPayoutEventToDb(db, { payoutId: payout.id, event: { type: 'payout.processing', providerRef: 'ref-x' } });
    await applyPayoutEventToDb(db, {
      payoutId: payout.id,
      event: { type: 'payout.completed', payoutRef: 'tr-proof-1', amount: payout.amount, currencyCode: 'TND' },
    });
    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('COMPLETED');

    await expect(
      createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER }),
    ).rejects.toThrow(/already active or completed/i);
  });

  it('18. two different sellers of one order can each complete independently', async () => {
    const s = await multiSellerOrder();
    const p1 = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub1Id, providerId: PROVIDER });
    const p2 = await createPayout(db, { transactionId: s.transactionId, sellerOrderId: s.sub2Id, providerId: PROVIDER });
    for (const p of [p1, p2]) {
      await applyPayoutEventToDb(db, { payoutId: p.id, event: { type: 'payout.processing', providerRef: `ref-${p.id}` } });
      await applyPayoutEventToDb(db, {
        payoutId: p.id,
        event: { type: 'payout.completed', payoutRef: `tr-${p.id}`, amount: p.amount, currencyCode: 'TND' },
      });
    }
    const rows = await db.select().from(payouts).where(eq(payouts.transactionId, s.transactionId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'COMPLETED')).toBe(true);
  });
});
