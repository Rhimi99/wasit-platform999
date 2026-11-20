import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import {
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  sellerOrders,
  transactionLedger,
} from '../src/db/schema/index.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import { completeRefundWithEvidence } from '../src/modules/payments/service.js';
import { settleSellerSuborder } from '../src/modules/settlements/service.js';

/**
 * M2.4-T2.3 — per-seller suborder status + per-seller commission reversal on a
 * completed refund.
 *
 * T2.1 built the `refund_allocations` data foundation; T2.2 made `createRefund`
 * write and validate those allocations. T2.3 makes the *completion* side
 * per-seller:
 *
 *  - a seller suborder that is fully refunded is moved to `REFUNDED` on its own
 *    attributed amount (a partially-refunded suborder keeps its fulfilment state);
 *  - a seller's commission share is reversed in proportion to *that suborder's*
 *    own refunded share, so an untouched seller keeps their commission;
 *  - the buyer's commission and the payment fee stay on the order-level policy;
 *  - a `REFUNDED` suborder is ineligible for settlement, so a refunded seller can
 *    never be paid out.
 *
 * Completion still happens only through `completeRefundWithEvidence` with trusted
 * external evidence; the offline provider used by these tests cannot complete a
 * refund on its own.
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
    body: { email, password: 'StrongPass123!', firstName: 'RS', role },
  });
  expect(r.status).toBe(201);
}

async function login(c: ReturnType<typeof makeClient>, email: string, password = 'StrongPass123!') {
  const r = await c.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
  expect(r.status).toBe(200);
  return r;
}

async function createAdminClient(password = 'AdminPass123!') {
  const id = randomUUID();
  const email = `rs-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'RS Admin',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  await login(c, email, password);
  return c;
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

/** Trusted external evidence that a refund of this amount/currency moved. */
function completeRefund(refundId: string, amount: string, currencyCode = 'TND') {
  return completeRefundWithEvidence(
    db,
    refundId,
    { source: 'PROVIDER_WEBHOOK', providerId: 'open-checkout', externalRef: `acq-${refundId}`, amount, currencyCode },
    { actorId: null },
  );
}

async function makeSupplier(tag: string, stamp: string) {
  const c = makeClient();
  const email = `rs-sup-${tag}-${stamp}@wasit.tn`;
  await registerUser(c, email, 'SUPPLIER');
  await login(c, email);
  const profile = await c.req('/api/suppliers', { method: 'POST', body: { companyName: `RS ${tag} Co` } });
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
      sku: `RSSKU-${tag}-${stamp}`,
      categoryId,
      name: `RS Product ${tag} ${stamp}`,
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
  commission: number;
  buyerCommission: number;
  sellerCommission: number;
  status: string;
  items: { id: string; lineTotal: string }[];
}

async function loadSubs(orderId: string): Promise<SubInfo[]> {
  const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  return subs.map((s) => ({
    id: s.id,
    sellerId: s.sellerId,
    cap: Number(s.itemsTotal) + Number(s.buyerCommission),
    commission: Number(s.commission),
    buyerCommission: Number(s.buyerCommission),
    sellerCommission: Number(s.sellerCommission),
    status: s.status,
    items: items.filter((i) => i.sellerOrderId === s.id).map((i) => ({ id: i.id, lineTotal: i.lineTotal })),
  }));
}

/** Creates a PAID, multi-seller order (two suppliers, one product each). */
async function setupMultiSellerPaidOrder() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supA = await makeSupplier('a', stamp);
  const supB = await makeSupplier('b', stamp);

  const buyer = makeClient();
  const buyerEmail = `rs-buy-${stamp}@wasit.tn`;
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  const buyerLogin = await login(buyer, buyerEmail);
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const admin = await createAdminClient();

  const productA = await makeProduct(supA.client, supA.supplierId, stamp, 'a', '10.0000');
  const productB = await makeProduct(supB.client, supB.supplierId, stamp, 'b', '20.0000');

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: {
      buyerId: buyerUserId,
      buyerType: 'CUSTOMER',
      items: [
        { productId: productA, quantity: 1 },
        { productId: productB, quantity: 1 },
      ],
    },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  const intent = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  const externalRef = intent.data.data.intent.externalRef as string;
  const hook = await postWebhook({ eventId: `evt-rs-${stamp}`, type: 'payment.succeeded', externalRef });
  expect(hook.status).toBe(200);

  const subs = await loadSubs(orderData.orderId);
  expect(subs.length).toBe(2);

  return { orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId, subs, admin, buyer, stamp };
}

/** The seller-share COMMISSION ledger entries of a transaction, keyed by suborder. */
async function sellerCommissionBySub(transactionId: string) {
  const rows = await db
    .select()
    .from(transactionLedger)
    .where(
      and(
        eq(transactionLedger.transactionId, transactionId),
        eq(transactionLedger.entryType, 'COMMISSION'),
        eq(transactionLedger.direction, 'DEBIT'),
      ),
    );
  const bySub = new Map<string, { id: string; amount: number }>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as { share?: string; sellerOrderId?: string };
    if (meta.share === 'SELLER' && meta.sellerOrderId) {
      bySub.set(meta.sellerOrderId, { id: r.id, amount: Number(r.amount) });
    }
  }
  return bySub;
}

/** Total CREDIT reversal written against one original ledger entry. */
async function reversalOf(transactionId: string, entryId: string): Promise<number> {
  const rows = await db
    .select()
    .from(transactionLedger)
    .where(
      and(
        eq(transactionLedger.transactionId, transactionId),
        eq(transactionLedger.direction, 'CREDIT'),
        sql`${transactionLedger.metadata}->>'reversalOf' = ${entryId}`,
      ),
    );
  return rows.reduce((acc, r) => acc + Number(r.amount), 0);
}

/** Net magnitude (DEBIT − CREDIT) for an entry type on one transaction. */
async function netByType(transactionId: string, entryType: string): Promise<number> {
  const rows = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
  return rows
    .filter((r) => r.entryType === entryType)
    .reduce((acc, r) => acc + (r.direction === 'DEBIT' ? 1 : -1) * Number(r.amount), 0);
}

afterAll(() => {
  closeDb();
});

describe('M2.4-T2.3 — refund completion moves per-seller suborder status', () => {
  it('1. a full refund marks every suborder REFUNDED', async () => {
    const s = await setupMultiSellerPaidOrder();
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'full' } });
    expect(r.status).toBe(201);
    const done = await completeRefund(r.data.data.refund.id as string, s.grandTotal);
    expect(done.completed).toBe(true);

    const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, s.orderId));
    expect(subs.length).toBe(2);
    expect(subs.every((sub) => sub.status === 'REFUNDED')).toBe(true);
  });

  it('2. a partial refund leaves the suborder in its fulfilment state and does not touch the sibling', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA, subB] = s.subs;
    const amount = (subA.cap / 2).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: subA.id, amount }] },
    });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, amount);

    const after = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, s.orderId));
    const a = after.find((x) => x.id === subA.id)!;
    const b = after.find((x) => x.id === subB.id)!;
    // Neither suborder is fully refunded, so neither is moved to REFUNDED.
    expect(a.status).not.toBe('REFUNDED');
    expect(b.status).not.toBe('REFUNDED');
    expect(a.status).toBe(subA.status);
    expect(b.status).toBe(subB.status);
  });
});

describe('M2.4-T2.3 — refund completion reverses commission per seller', () => {
  it('3. reverses only the refunded seller\'s commission share, leaving the other seller intact', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA, subB] = s.subs;
    const commission = await sellerCommissionBySub(s.transactionId);
    const entryA = commission.get(subA.id)!;
    const entryB = commission.get(subB.id)!;
    expect(entryA.amount).toBeGreaterThan(0);
    expect(entryB.amount).toBeGreaterThan(0);

    const amount = (subA.cap / 2).toFixed(4);
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: subA.id, amount }] },
    });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, amount);

    // Seller A's commission is half reversed (half their cap was refunded)...
    expect(await reversalOf(s.transactionId, entryA.id)).toBeCloseTo(entryA.amount / 2, 3);
    // ...and seller B's is untouched.
    expect(await reversalOf(s.transactionId, entryB.id)).toBeCloseTo(0, 4);
  });

  it('4. a full refund reverses every seller commission plus the buyer commission and the fee', async () => {
    const s = await setupMultiSellerPaidOrder();
    const commission = await sellerCommissionBySub(s.transactionId);
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'full' } });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, s.grandTotal);

    for (const sub of s.subs) {
      const entry = commission.get(sub.id)!;
      expect(await reversalOf(s.transactionId, entry.id)).toBeCloseTo(entry.amount, 4);
    }
    // Every commission (both shares) and the payment fee net to exactly zero.
    expect(await netByType(s.transactionId, 'COMMISSION')).toBeCloseTo(0, 4);
    expect(await netByType(s.transactionId, 'PAYMENT_FEE')).toBeCloseTo(0, 4);
  });
});

describe('M2.4-T2.3 — a refunded suborder cannot be settled', () => {
  it('5. settlement of a refunded suborder is refused', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;

    // Put the suborder in a settleable fulfilment state, then refund it fully.
    await db
      .update(sellerOrders)
      .set({ status: 'DELIVERED' })
      .where(eq(sellerOrders.id, subA.id));

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: subA.cap.toFixed(4), allocations: [{ sellerOrderId: subA.id, amount: subA.cap.toFixed(4) }] },
    });
    expect(r.status).toBe(201);
    await completeRefund(r.data.data.refund.id as string, subA.cap.toFixed(4));

    const [row] = await db.select().from(sellerOrders).where(eq(sellerOrders.id, subA.id)).limit(1);
    expect(row.status).toBe('REFUNDED');

    const verdict = await settleSellerSuborder(db, subA.id);
    expect(verdict.settled).toBe(false);
    expect(verdict.reason).toBe('SUBORDER_NOT_DELIVERED');
  });
});

describe('M2.4-T2.3 — idempotency and legacy safety', () => {
  it('6. replaying completion writes no extra reversal and does not re-move the suborder', async () => {
    const s = await setupMultiSellerPaidOrder();
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'full' } });
    const refundId = r.data.data.refund.id as string;
    await completeRefund(refundId, s.grandTotal);

    const before = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const replay = await completeRefund(refundId, s.grandTotal);
    expect(replay.reused).toBe(true);
    const after = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(after.length).toBe(before.length);

    const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, s.orderId));
    expect(subs.every((sub) => sub.status === 'REFUNDED')).toBe(true);
  });

  it('7. a legacy order with no suborders completes and reverses its commission at order level', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const buyerId = randomUUID();
    await db.insert(users).values({
      id: buyerId,
      email: `rs-legacy-${stamp}@wasit.tn`,
      passwordHash: 'x',
      firstName: 'Legacy',
      isActive: true,
      emailVerified: true,
    });
    const orderId = `ord-rs-legacy-${stamp}`;
    const transactionId = randomUUID();
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `ORDRSLEG-${stamp}`,
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
    await db.insert(payments).values({
      id: randomUUID(),
      transactionId,
      orderId,
      amount: '102.5000',
      currencyCode: 'TND',
      status: 'PAID',
    });
    // A pre-M2 ledger: a seller COMMISSION entry with no `sellerOrderId` in its
    // metadata. It must still be reversed through the order-level fallback.
    await db.insert(transactionLedger).values({
      id: randomUUID(),
      transactionId,
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: '4.0000',
      currencyCode: 'TND',
      payerId: 'legacy-seller',
      beneficiaryId: 'wasit',
      status: 'PENDING',
      metadata: { share: 'SELLER' } as never,
    });

    const admin = await createAdminClient();
    const r = await admin.req(`/api/payments/orders/${orderId}/refunds`, { method: 'POST', body: { reason: 'legacy full' } });
    expect(r.status).toBe(201);
    expect(r.data.data.refund.amount).toBe('102.5000');
    const done = await completeRefund(r.data.data.refund.id as string, '102.5000');
    expect(done.completed).toBe(true);

    // No suborders were touched (there are none) and the commission is fully reversed.
    expect(await netByType(transactionId, 'COMMISSION')).toBeCloseTo(0, 4);
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow.paymentStatus).toBe('REFUNDED');
    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(0);
  });
});
