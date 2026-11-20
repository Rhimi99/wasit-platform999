import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orderItems, orders, payments, sellerOrders, transactionLedger } from '../src/db/schema/index.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import { completeRefundWithEvidence } from '../src/modules/payments/service.js';

/**
 * M2.4-T2.4 — the per-seller refund attribution view (admin desk).
 *
 * Proves the read-only view answers, from real server data, what each seller on
 * an order was owed, how much of it a COMPLETED refund returned, whether the
 * suborder is now `REFUNDED`, and how much of that seller's commission has been
 * reversed — for one seller, several sellers, a partial refund, a full refund of
 * one seller only, and a full refund of all. It also pins the access rule: the
 * view is `PAYMENT_READ` (ADMIN/SUPER_ADMIN only), so a customer or merchant is
 * refused even on their own order, and it writes nothing.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function registerUser(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'AT', role },
  });
  expect(r.status).toBe(201);
}

async function login(c: ReturnType<typeof makeClient>, email: string, password = 'StrongPass123!') {
  const r = await c.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
  expect(r.status).toBe(200);
  return r;
}

async function createStaffClient(roleName: string, password = 'AdminPass123!') {
  const id = randomUUID();
  const email = `at-${roleName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: `AT ${roleName}`,
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  await login(c, email, password);
  return c;
}

function completeRefund(refundId: string, amount: string, currencyCode = 'TND') {
  return completeRefundWithEvidence(
    db,
    refundId,
    { source: 'PROVIDER_WEBHOOK', providerId: 'open-checkout', externalRef: `acq-${refundId}`, amount, currencyCode },
    { actorId: null },
  );
}

async function postWebhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const sig = computeWebhookSignature(rawBody, WEBHOOK_SECRET);
  const res = await app.request('/api/payment-webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': sig },
    body: rawBody,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: data as any, status: res.status };
}

async function makeSupplier(tag: string, stamp: string) {
  const c = makeClient();
  const email = `at-sup-${tag}-${stamp}@wasit.tn`;
  await registerUser(c, email, 'SUPPLIER');
  await login(c, email);
  const profile = await c.req('/api/suppliers', { method: 'POST', body: { companyName: `AT ${tag} Co` } });
  expect(profile.status).toBe(201);
  return { client: c, supplierId: profile.data.data.id as string };
}

async function makeProduct(supplier: ReturnType<typeof makeClient>, supplierId: string, stamp: string, tag: string, price: string) {
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `ATSKU-${tag}-${stamp}`,
      categoryId,
      name: `AT Product ${tag} ${stamp}`,
      basePrice: price,
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  expect(product.status).toBe(201);
  return product.data.data.id as string;
}

interface SubInfo {
  id: string;
  sellerId: string;
  cap: number;
  sellerCommission: number;
  status: string;
}

async function loadSubs(orderId: string): Promise<SubInfo[]> {
  const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  return subs.map((s) => ({
    id: s.id,
    sellerId: s.sellerId,
    cap: Number(s.itemsTotal) + Number(s.buyerCommission),
    sellerCommission: Number(s.sellerCommission),
    status: s.status,
  }));
}

/** Creates a PAID order for `sellerCount` (1 or 2) suppliers, one product each. */
async function setupPaidOrder(sellerCount: 1 | 2) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supA = await makeSupplier('a', stamp);
  const supB = sellerCount === 2 ? await makeSupplier('b', stamp) : null;

  const buyer = makeClient();
  const buyerEmail = `at-buy-${stamp}@wasit.tn`;
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  const buyerLogin = await login(buyer, buyerEmail);
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const admin = await createStaffClient('ADMIN');

  const productA = await makeProduct(supA.client, supA.supplierId, stamp, 'a', '10.0000');
  const items: Array<{ productId: string; quantity: number }> = [{ productId: productA, quantity: 1 }];
  if (supB) {
    const productB = await makeProduct(supB.client, supB.supplierId, stamp, 'b', '20.0000');
    items.push({ productId: productB, quantity: 1 });
  }

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  const intent = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  const externalRef = intent.data.data.intent.externalRef as string;
  const hook = await postWebhook({ eventId: `evt-at-${stamp}`, type: 'payment.succeeded', externalRef });
  expect(hook.status).toBe(200);

  const subs = await loadSubs(orderData.orderId);
  expect(subs.length).toBe(sellerCount);

  return { orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId, subs, admin, buyer, buyerEmail, stamp };
}

afterAll(() => {
  closeDb();
});

describe('M2.4-T2.4 — refund attribution view: shape and per-seller breakdown', () => {
  it('1. a single-seller order lists that seller with cap, commission and no refunds', async () => {
    const s = await setupPaidOrder(1);
    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    expect(res.status).toBe(200);

    const data = res.data.data;
    expect(data.legacy).toBe(false);
    expect(data.sellers.length).toBe(1);
    expect(data.refunds).toEqual([]);

    const seller = data.sellers[0];
    expect(seller.sellerOrderId).toBe(s.subs[0].id);
    expect(Number(seller.refundableCap)).toBeCloseTo(s.subs[0].cap, 4);
    expect(Number(seller.sellerCommission)).toBeCloseTo(s.subs[0].sellerCommission, 4);
    expect(Number(seller.refundedAmount)).toBe(0);
    expect(Number(seller.remainingAmount)).toBeCloseTo(s.subs[0].cap, 4);
    expect(Number(seller.sellerCommissionReversed)).toBe(0);
    expect(seller.fullyRefunded).toBe(false);
    expect(seller.refunds).toEqual([]);
    expect(seller.lineItems).toEqual([]);
    // Parent-level totals come from the same rows.
    expect(Number(data.order.grandTotal)).toBeCloseTo(Number(s.grandTotal), 4);
    expect(Number(data.order.refundedTotal)).toBe(0);
    expect(data.order.fullyRefunded).toBe(false);
  });

  it('2. a multi-seller order lists each seller independently with its own cap', async () => {
    const s = await setupPaidOrder(2);
    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    expect(res.status).toBe(200);
    const data = res.data.data;

    expect(data.sellers.length).toBe(2);
    const byId = new Map(data.sellers.map((x: { sellerOrderId: string }) => [x.sellerOrderId, x]));
    for (const sub of s.subs) {
      const row = byId.get(sub.id) as { refundableCap: string; sellerCommission: string };
      expect(row).toBeTruthy();
      expect(Number(row.refundableCap)).toBeCloseTo(sub.cap, 4);
      expect(Number(row.sellerCommission)).toBeCloseTo(sub.sellerCommission, 4);
    }
    // Each seller's cap is its own; the two are not the order total each.
    const caps = data.sellers.map((x: { refundableCap: string }) => Number(x.refundableCap));
    expect(caps[0]).toBeLessThan(Number(s.grandTotal));
    expect(caps[1]).toBeLessThan(Number(s.grandTotal));
  });

  it('3. a partial refund shows the refunded and remaining amounts per seller, without moving status', async () => {
    const s = await setupPaidOrder(2);
    const [subA, subB] = s.subs;
    const amount = (subA.cap / 2).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: subA.id, amount }] },
    });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, amount);

    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    const data = res.data.data;
    const byId = new Map(data.sellers.map((x: { sellerOrderId: string }) => [x.sellerOrderId, x]));

    const a = byId.get(subA.id) as { refundedAmount: string; remainingAmount: string; fullyRefunded: boolean; status: string; refunds: unknown[] };
    const b = byId.get(subB.id) as { refundedAmount: string; fullyRefunded: boolean; status: string; refunds: unknown[] };

    expect(Number(a.refundedAmount)).toBeCloseTo(Number(amount), 4);
    expect(Number(a.remainingAmount)).toBeCloseTo(subA.cap - Number(amount), 4);
    expect(a.fullyRefunded).toBe(false);
    expect(a.status).not.toBe('REFUNDED');
    // The sibling seller is untouched and has no refund rows.
    expect(Number(b.refundedAmount)).toBe(0);
    expect(b.fullyRefunded).toBe(false);
    expect(b.refunds).toEqual([]);
    // The order shows exactly one refund, attributed only to seller A.
    expect(data.refunds.length).toBe(1);
    expect(data.refunds[0].allocatedTo).toEqual([subA.id]);
    expect(Number(data.order.refundedTotal)).toBeCloseTo(Number(amount), 4);
  });

  it('4. a full refund of one seller marks only that suborder REFUNDED and reverses only its commission', async () => {
    const s = await setupPaidOrder(2);
    const [subA, subB] = s.subs;
    const amount = subA.cap.toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: subA.id, amount }] },
    });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, amount);

    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    const data = res.data.data;
    const byId = new Map(data.sellers.map((x: { sellerOrderId: string }) => [x.sellerOrderId, x]));

    const a = byId.get(subA.id) as { status: string; fullyRefunded: boolean; sellerCommissionReversed: string; remainingAmount: string };
    const b = byId.get(subB.id) as { status: string; fullyRefunded: boolean; sellerCommissionReversed: string };

    expect(a.fullyRefunded).toBe(true);
    expect(a.status).toBe('REFUNDED');
    expect(Number(a.remainingAmount)).toBe(0);
    // Seller A's whole commission share is reversed...
    expect(Number(a.sellerCommissionReversed)).toBeCloseTo(subA.sellerCommission, 4);
    // ...and seller B keeps theirs, untouched.
    expect(b.status).not.toBe('REFUNDED');
    expect(b.fullyRefunded).toBe(false);
    expect(Number(b.sellerCommissionReversed)).toBe(0);
  });

  it('5. a full refund of all sellers marks every suborder REFUNDED and reverses every commission', async () => {
    const s = await setupPaidOrder(2);
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'full' } });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, s.grandTotal);

    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    const data = res.data.data;

    for (const seller of data.sellers) {
      expect(seller.fullyRefunded).toBe(true);
      expect(seller.status).toBe('REFUNDED');
      expect(Number(seller.remainingAmount)).toBe(0);
      expect(Number(seller.sellerCommissionReversed)).toBeCloseTo(Number(seller.sellerCommission), 4);
    }
    expect(data.order.fullyRefunded).toBe(true);
    expect(Number(data.order.remainingTotal)).toBe(0);
  });

  it('6. the reversed commission is read from the ledger, not recomputed (a half refund reverses half)', async () => {
    const s = await setupPaidOrder(1);
    const sub = s.subs[0];
    const amount = (sub.cap / 2).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: sub.id, amount }] },
    });
    await completeRefund(r.data.data.refund.id as string, amount);

    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    const seller = res.data.data.sellers[0];
    expect(Number(seller.sellerCommissionReversed)).toBeCloseTo(sub.sellerCommission / 2, 4);
    // The view equals the ledger reversal written against *that seller's*
    // commission entry — not the sum of every reversal on the transaction (which
    // also carries the buyer-commission and payment-fee reversals).
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const commissionEntry = ledger.find(
      (row) =>
        row.entryType === 'COMMISSION' &&
        row.direction === 'DEBIT' &&
        (row.metadata as { share?: string; sellerOrderId?: string } | null)?.share === 'SELLER' &&
        (row.metadata as { sellerOrderId?: string } | null)?.sellerOrderId === sub.id,
    );
    expect(commissionEntry).toBeTruthy();
    const sellerReversal = ledger
      .filter(
        (row) =>
          row.direction === 'CREDIT' &&
          (row.metadata as { reversalOf?: string } | null)?.reversalOf === commissionEntry!.id,
      )
      .reduce((acc, row) => acc + Number(row.amount), 0);
    expect(Number(seller.sellerCommissionReversed)).toBeCloseTo(sellerReversal, 4);
  });
});

describe('M2.4-T2.4 — refund attribution view: access control and safety', () => {
  it('7. a customer, a merchant, a supplier party and a support operator are refused; an admin is allowed', async () => {
    const s = await setupPaidOrder(1);
    const path = `/api/payments/orders/${s.orderId}/refund-attribution`;

    // The buyer owns the order but holds no refund/read-all permission: refused.
    expect((await s.buyer.req(path)).status).toBe(403);

    // A merchant (non-party) is refused.
    const merchant = makeClient();
    const mEmail = `at-merchant-${s.stamp}@wasit.tn`;
    await registerUser(merchant, mEmail, 'MERCHANT');
    await login(merchant, mEmail);
    expect((await merchant.req(path)).status).toBe(403);

    // The selling supplier is a party to the order but must not see the
    // per-seller breakdown: it holds PAYMENT_READ but not REFUND_MANAGE.
    const supplierEmail = `at-sup-a-${s.stamp}@wasit.tn`;
    const supplier = makeClient();
    await login(supplier, supplierEmail);
    expect((await supplier.req(path)).status).toBe(403);

    // A support operator does not hold REFUND_MANAGE either: refused.
    const support = await createStaffClient('SUPPORT');
    expect((await support.req(path)).status).toBe(403);

    // Only an admin (REFUND_MANAGE) reads it.
    expect((await s.admin.req(path)).status).toBe(200);
  });

  it('8. an order with no refunds returns an empty refund list and zeroed amounts', async () => {
    const s = await setupPaidOrder(1);
    const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
    expect(res.status).toBe(200);
    expect(res.data.data.refunds).toEqual([]);
    expect(res.data.data.sellers.every((x: { refundedAmount: string }) => Number(x.refundedAmount) === 0)).toBe(true);
    expect(res.data.data.order.fullyRefunded).toBe(false);
  });

  it('9. an unknown order is a 404, not an empty payload', async () => {
    const admin = await createStaffClient('ADMIN');
    const res = await admin.req(`/api/payments/orders/does-not-exist/refund-attribution`);
    expect(res.status).toBe(404);
  });

  it('10. reading the view writes nothing (no ledger, refund or suborder change)', async () => {
    const s = await setupPaidOrder(2);
    const sub = s.subs[0];
    const amount = (sub.cap / 2).toFixed(4);
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: sub.id, amount }] },
    });
    await completeRefund(r.data.data.refund.id as string, amount);

    const before = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const subsBefore = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, s.orderId));
    const refundsBefore = await db.select().from(payments).where(eq(payments.orderId, s.orderId));

    for (let i = 0; i < 3; i += 1) {
      const res = await s.admin.req(`/api/payments/orders/${s.orderId}/refund-attribution`);
      expect(res.status).toBe(200);
    }

    const after = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const subsAfter = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, s.orderId));
    const refundsAfter = await db.select().from(payments).where(eq(payments.orderId, s.orderId));
    expect(after.length).toBe(before.length);
    expect(subsAfter.map((x) => x.status)).toEqual(subsBefore.map((x) => x.status));
    expect(refundsAfter.length).toBe(refundsBefore.length);
  });

  it('11. a legacy order with no suborders is reported as legacy with no sellers', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const buyerId = randomUUID();
    await db.insert(users).values({
      id: buyerId,
      email: `at-legacy-${stamp}@wasit.tn`,
      passwordHash: 'x',
      firstName: 'Legacy',
      isActive: true,
      emailVerified: true,
    });
    const orderId = `ord-at-legacy-${stamp}`;
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `ORDATLEG-${stamp}`,
      buyerId,
      buyerType: 'CUSTOMER',
      sellerId: 'legacy-seller',
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '100.0000',
      commission: '4.0000',
      buyerCommission: '2.0000',
      paymentFee: '0.5000',
      grandTotal: '102.5000',
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      refundStatus: 'NONE',
    });
    await db.insert(orderItems).values({
      id: randomUUID(),
      orderId,
      sellerOrderId: null,
      sellerId: 'legacy-seller',
      productId: `prd-${stamp}`,
      unitPrice: '100.0000',
      quantity: 1,
      lineTotal: '100.0000',
    });

    const admin = await createStaffClient('ADMIN');
    const res = await admin.req(`/api/payments/orders/${orderId}/refund-attribution`);
    expect(res.status).toBe(200);
    expect(res.data.data.legacy).toBe(true);
    expect(res.data.data.sellers).toEqual([]);
  });
});
