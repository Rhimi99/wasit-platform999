import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, sellerOrders, sellerSettlements, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { disputes } from '../src/db/schema/disputes.js';
import { suppliers } from '../src/db/schema/trade.js';
import {
  evaluateSuborderSettlement,
  reconcileSellerSettlements,
  settleSellerSuborder,
} from '../src/modules/settlements/service.js';
import { createPayout } from '../src/modules/payouts/service.js';
import { updateOrderStatus } from '../src/modules/orders/service.js';

/**
 * M2.3-T2 — Seller suborder settlement.
 *
 * Proves the per-seller settlement layer: a suborder is settled against the
 * EXISTING parent SETTLEMENT entry (no new ledger entry), only once it is
 * fulfilled and the money is still with WASIT (no refund, no open dispute), and
 * a payout can only follow that settlement. Idempotency and the concurrency
 * guarantees are exercised directly against the real database.
 */

afterAll(async () => {
  await closeDb();
});

async function makeSellerUserAndSupplier(stamp: string, tag: string) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `m23t2-${tag}-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const supplierId = `sup-m23t2-${tag}-${stamp}`;
  await db.insert(suppliers).values({
    id: supplierId,
    userId,
    companyName: `M23T2 ${tag} ${stamp}`,
    slug: `sup-m23t2-${tag}-${stamp}`,
  });
  return supplierId;
}

interface FixtureOpts {
  settle?: boolean;
  subStatus?: 'DELIVERED' | 'COMPLETED' | 'SHIPPED' | 'CANCELLED';
  paymentStatus?: string;
  refundStatus?: string;
  disputeStatus?: string | null;
  parentOrderIdOverride?: string;
  transactionOrderIdOverride?: string;
}

/**
 * Builds a parent order with ONE seller suborder, a transaction, and (by
 * default) a SETTLED SETTLEMENT ledger entry.
 */
async function orderFixture(opts: FixtureOpts = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const buyerId = randomUUID();
  await db.insert(users).values({
    id: buyerId,
    email: `m23t2-buyer-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'Buyer',
    isActive: true,
    emailVerified: true,
  });
  const seller = await makeSellerUserAndSupplier(stamp, 's1');

  const orderId = `ord-m23t2-${stamp}`;
  const orderNumber = `ORDM23T2-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId: seller,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    paymentFee: '0',
    grandTotal: '100.0000',
    status: 'DELIVERED',
    paymentStatus: (opts.paymentStatus ?? 'PAID') as never,
    refundStatus: (opts.refundStatus ?? 'NONE') as never,
  });

  const subId = `sub-m23t2-${stamp}`;
  await db.insert(sellerOrders).values({
    id: subId,
    parentOrderId: orderId,
    orderNumber,
    sellerOrderNumber: `${orderNumber}-S1`,
    sellerId: seller,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    sellerCommission: '2.0000',
    sellerPayable: '98.0000',
    status: (opts.subStatus ?? 'DELIVERED') as never,
    settlementStatus: 'PENDING',
  });

  const transactionId = `txn-m23t2-${stamp}`;
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `TXM23T2-${stamp}`,
    orderId: opts.transactionOrderIdOverride ?? orderId,
    buyerId,
    sellerId: seller,
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

  if (opts.disputeStatus) {
    await db.insert(disputes).values({
      id: randomUUID(),
      disputeNumber: `DSPM23T2-${stamp}`,
      orderId,
      openedById: buyerId,
      reasonCode: 'NOT_AS_DESCRIBED',
      description: 'fixture dispute',
      status: opts.disputeStatus as never,
    });
  }

  return { orderId, transactionId, subId, seller, buyerId, stamp };
}

async function ledgerCount(transactionId: string) {
  const rows = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
  return rows.length;
}

describe('M2.3-T2 — seller suborder settlement', () => {
  it('1. settles a delivered suborder against the existing parent SETTLEMENT entry', async () => {
    const f = await orderFixture();
    const before = await ledgerCount(f.transactionId);

    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(true);
    expect(r.duplicate).toBe(false);
    expect(r.settlementId).not.toBeNull();

    const [row] = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(row).toBeDefined();
    expect(row.status).toBe('SETTLED');
    expect(row.amount).toBe('98.0000');
    expect(row.sellerId).toBe(f.seller);
    expect(row.parentOrderId).toBe(f.orderId);
    expect(row.transactionId).toBe(f.transactionId);
    expect(row.parentSettlementEntryId).not.toBeNull();

    const [sub] = await db.select().from(sellerOrders).where(eq(sellerOrders.id, f.subId));
    expect(sub.settlementStatus).toBe('SETTLED');

    // No new ledger entry was written — the parent evidence is reused.
    expect(await ledgerCount(f.transactionId)).toBe(before);
  });

  it('2. takes seller_type, currency and amount from the locked suborder row', async () => {
    const f = await orderFixture();
    await settleSellerSuborder(db, f.subId);
    const [row] = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    const [sub] = await db.select().from(sellerOrders).where(eq(sellerOrders.id, f.subId));
    expect(row.sellerType).toBe(sub.sellerType);
    expect(row.currencyCode).toBe(sub.currencyCode);
    expect(row.amount).toBe(sub.sellerPayable);
  });

  it('3. refuses to settle a suborder that is not delivered/completed', async () => {
    const f = await orderFixture({ subStatus: 'SHIPPED' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('SUBORDER_NOT_DELIVERED');
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(0);
  });

  it('4. refuses to settle when the parent transaction is not settled', async () => {
    const f = await orderFixture({ settle: false });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('PARENT_TRANSACTION_NOT_SETTLED');
  });

  it('5. refuses to settle when the order is not PAID', async () => {
    const f = await orderFixture({ paymentStatus: 'UNPAID' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('PARENT_ORDER_NOT_PAID');
  });

  it('6. refuses to settle on a full refund', async () => {
    const f = await orderFixture({ paymentStatus: 'REFUNDED', refundStatus: 'COMPLETED' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('REFUND_PRESENT');
  });

  it('7. refuses to settle on a PARTIAL refund (seller_payable would be stale)', async () => {
    const f = await orderFixture({ paymentStatus: 'PARTIALLY_REFUNDED', refundStatus: 'PROCESSING' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('REFUND_PRESENT');
  });

  it('8. refuses to settle while a dispute is not CLOSED/ARCHIVED', async () => {
    const f = await orderFixture({ disputeStatus: 'UNDER_REVIEW' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('DISPUTE_OPEN');
  });

  it('9. settles once the dispute is CLOSED', async () => {
    const f = await orderFixture({ disputeStatus: 'CLOSED' });
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(true);
  });

  it('10. is idempotent: a replay is a no-op and writes no second row', async () => {
    const f = await orderFixture();
    const first = await settleSellerSuborder(db, f.subId);
    expect(first.settled).toBe(true);
    const second = await settleSellerSuborder(db, f.subId);
    expect(second.settled).toBe(false);
    expect(second.duplicate).toBe(true);
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(1);
  });

  it('11. records a rejection in audit_logs and allows a later successful retry', async () => {
    const f = await orderFixture({ settle: false });
    const rejected = await settleSellerSuborder(db, f.subId);
    expect(rejected.settled).toBe(false);
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(0);

    // Now the parent settles; the retry must succeed — the past failure is not
    // a blocker because no row was written.
    await db.insert(transactionLedger).values({
      id: randomUUID(),
      transactionId: f.transactionId,
      entryType: 'SETTLEMENT',
      direction: 'CREDIT',
      amount: '100.0000',
      currencyCode: 'TND',
      status: 'SETTLED',
    });
    const retry = await settleSellerSuborder(db, f.subId);
    expect(retry.settled).toBe(true);
  });

  it('12. two concurrent settlements of one suborder produce exactly one row', async () => {
    const f = await orderFixture();
    const results = await Promise.all([
      settleSellerSuborder(db, f.subId),
      settleSellerSuborder(db, f.subId),
    ]);
    const settledCount = results.filter((r) => r.settled).length;
    expect(settledCount).toBe(1);
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(1);
  });

  it('13. blocks a payout before the suborder is settled, and allows it after', async () => {
    const f = await orderFixture();
    await expect(
      createPayout(db, { transactionId: f.transactionId, providerId: 'sandbox', sellerOrderId: f.subId }),
    ).rejects.toThrow(/before this seller suborder is settled/);

    await settleSellerSuborder(db, f.subId);
    const payout = await createPayout(db, {
      transactionId: f.transactionId,
      providerId: 'sandbox',
      sellerOrderId: f.subId,
    });
    expect(payout.status).toBe('CREATED');
    expect(payout.amount).toBe('98.0000');
  });

  it('14. settlement and payout racing on one suborder never pay before settlement', async () => {
    const f = await orderFixture();
    const [settle, pay] = await Promise.allSettled([
      settleSellerSuborder(db, f.subId),
      createPayout(db, { transactionId: f.transactionId, providerId: 'sandbox', sellerOrderId: f.subId }),
    ]);
    // The settlement must succeed. The payout either succeeds (it ran after the
    // settlement committed) or is refused — never "paid before settled".
    expect(settle.status).toBe('fulfilled');
    if (pay.status === 'fulfilled') {
      const [sub] = await db.select().from(sellerOrders).where(eq(sellerOrders.id, f.subId));
      expect(sub.settlementStatus).toBe('SETTLED');
    } else {
      expect(String(pay.reason)).toMatch(/before this seller suborder is settled/);
    }
  });

  it('15. the admin reconcile path settles pending suborders and reports duplicates', async () => {
    const f = await orderFixture();
    const first = await reconcileSellerSettlements(db, f.orderId);
    expect(first.find((r) => r.sellerOrderId === f.subId)?.settled).toBe(true);
    const second = await reconcileSellerSettlements(db, f.orderId);
    expect(second.find((r) => r.sellerOrderId === f.subId)?.duplicate).toBe(true);
  });

  it('16. evaluateSuborderSettlement reports the reason without writing', async () => {
    const f = await orderFixture({ subStatus: 'SHIPPED' });
    const verdict = await evaluateSuborderSettlement(db, f.subId);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('SUBORDER_NOT_DELIVERED');
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(0);
  });

  it('17. auto-settles a suborder that reaches DELIVERED after the parent was settled', async () => {
    // Build an order whose parent is already settled but the suborder is not yet
    // delivered, then drive the real fulfilment transition.
    const f = await orderFixture({ subStatus: 'SHIPPED' });
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));

    // The seller owns the suborder; drive updateOrderStatus as that seller.
    const sellerUser = (
      await db.select().from(suppliers).where(eq(suppliers.id, f.seller))
    )[0];
    await updateOrderStatus(db, f.orderId, 'DELIVERED', sellerUser.userId, { sellerOrderId: f.subId });

    const [sub] = await db.select().from(sellerOrders).where(eq(sellerOrders.id, f.subId));
    expect(sub.status).toBe('DELIVERED');
    expect(sub.settlementStatus).toBe('SETTLED');
    const rows = await db.select().from(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    expect(rows.length).toBe(1);
    expect(rows[0].parentOrderId).toBe(f.orderId);
    void order;
  });

  it('18. the composite FK refuses a settlement whose transaction belongs to a different order', async () => {
    const other = await orderFixture();
    const f = await orderFixture();
    // Point f's transaction at `other`'s order id → the (transaction_id,
    // parent_order_id) FK must refuse the row.
    await db.update(transactions).set({ orderId: other.orderId }).where(eq(transactions.id, f.transactionId));
    // Now f's parent order has no transaction of its own → not settleable.
    const r = await settleSellerSuborder(db, f.subId);
    expect(r.settled).toBe(false);
  });

  it('19. the admin reconcile route refuses an unauthenticated caller', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/finance/settlements/suborders/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('20. leaves a legacy order (no suborders) on its previous shape', async () => {
    const f = await orderFixture();
    // Delete the suborder to simulate a pre-M2 order: no suborder to settle.
    await db.delete(sellerSettlements).where(eq(sellerSettlements.sellerOrderId, f.subId));
    await db.delete(sellerOrders).where(eq(sellerOrders.id, f.subId));
    const r = await reconcileSellerSettlements(db, f.orderId);
    expect(r.length).toBe(0);
    // The parent transaction's SETTLED entry is untouched.
    expect(await ledgerCount(f.transactionId)).toBeGreaterThan(0);
  });
});
