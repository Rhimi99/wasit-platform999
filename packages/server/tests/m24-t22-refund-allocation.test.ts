import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
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

/**
 * M2.4-T2.2 — refund creation with per-seller-suborder attribution.
 *
 * `createRefund` now validates and writes `refund_allocations` rows: a refund can
 * name the seller suborders (and lines) it covers, a partial refund must name
 * them precisely, and no suborder/line/order may be refunded beyond what the
 * buyer actually paid for it. Concurrency and idempotency are exercised against
 * the real database.
 *
 * Completion (the REFUND ledger entry, commission reversal and order state) is
 * deliberately NOT in scope here — that stays with `completeRefundWithEvidence`.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.rawBody !== undefined ? options.rawBody : options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
    body: { email, password: 'StrongPass123!', firstName: 'RA', role },
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
  const email = `ra-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'RA Admin',
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

/** Registers a supplier, returns its client and supplier id. */
async function makeSupplier(tag: string, stamp: string) {
  const c = makeClient();
  const email = `ra-sup-${tag}-${stamp}@wasit.tn`;
  await registerUser(c, email, 'SUPPLIER');
  await login(c, email);
  const profile = await c.req('/api/suppliers', { method: 'POST', body: { companyName: `RA ${tag} Co` } });
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
      sku: `RASKU-${tag}-${stamp}`,
      categoryId,
      name: `RA Product ${tag} ${stamp}`,
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
  itemsTotal: string;
  buyerCommission: string;
  cap: number;
  items: { id: string; lineTotal: string }[];
}

/** Loads the seller suborders + their lines for an order, with the refundable cap. */
async function loadSubs(orderId: string): Promise<SubInfo[]> {
  const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  return subs.map((s) => ({
    id: s.id,
    sellerId: s.sellerId,
    itemsTotal: s.itemsTotal,
    buyerCommission: s.buyerCommission,
    cap: Number(s.itemsTotal) + Number(s.buyerCommission),
    items: items.filter((i) => i.sellerOrderId === s.id).map((i) => ({ id: i.id, lineTotal: i.lineTotal })),
  }));
}

/**
 * Creates a PAID, multi-seller order: two suppliers, one product each, bought in
 * a single order. Returns the order id, its grand total, the two suborders and
 * the admin client.
 */
async function setupMultiSellerPaidOrder() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supA = await makeSupplier('a', stamp);
  const supB = await makeSupplier('b', stamp);

  const buyer = makeClient();
  const buyerEmail = `ra-buy-${stamp}@wasit.tn`;
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

  // Mark it paid through the real webhook path.
  const intent = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  const externalRef = intent.data.data.intent.externalRef as string;
  const hook = await postWebhook({ eventId: `evt-ra-${stamp}`, type: 'payment.succeeded', externalRef });
  expect(hook.status).toBe(200);

  const subs = await loadSubs(orderData.orderId);
  expect(subs.length).toBe(2);

  return { orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId, subs, admin, buyer, stamp };
}

afterAll(() => {
  closeDb();
});

describe('M2.4-T2.2 — refund allocation: structure and happy paths', () => {
  it('1. allocates a partial refund to a single seller suborder', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;
    const amount = (subA.cap / 2).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, reason: 'partial single seller', allocations: [{ sellerOrderId: subA.id, amount }] },
    });
    expect(r.status).toBe(201);
    expect(r.data.data.refund.amount).toBe(amount);

    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(1);
    expect(allocs[0].sellerOrderId).toBe(subA.id);
    expect(allocs[0].amount).toBe(amount);
    expect(allocs[0].orderItemId).toBeNull();
  });

  it('2. allocates one refund across several seller suborders', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA, subB] = s.subs;
    const amountA = (subA.cap / 2).toFixed(4);
    const amountB = (subB.cap / 2).toFixed(4);
    const total = (Number(amountA) + Number(amountB)).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: {
        amount: total,
        allocations: [
          { sellerOrderId: subA.id, amount: amountA },
          { sellerOrderId: subB.id, amount: amountB },
        ],
      },
    });
    expect(r.status).toBe(201);

    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(2);
    const bySub = new Map(allocs.map((a) => [a.sellerOrderId, a.amount]));
    expect(bySub.get(subA.id)).toBe(amountA);
    expect(bySub.get(subB.id)).toBe(amountB);
    expect(allocs.every((a) => a.parentOrderId === s.orderId)).toBe(true);
  });

  it('3. a full refund with no explicit allocation is distributed by actual refundable amounts', async () => {
    const s = await setupMultiSellerPaidOrder();
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { reason: 'full refund' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data.refund.amount).toBe(s.grandTotal);

    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(2);
    const sum = allocs.reduce((acc, a) => acc + Number(a.amount), 0);
    expect(sum.toFixed(4)).toBe(Number(s.grandTotal).toFixed(4));
    // Each suborder gets its own cap, not an arbitrary equal split.
    for (const a of allocs) {
      const sub = s.subs.find((x) => x.id === a.sellerOrderId)!;
      expect(Number(a.amount)).toBeCloseTo(sub.cap, 4);
    }
  });

  it('4. accepts a line-level attribution to a line of the same suborder', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;
    const item = subA.items[0];
    const amount = (Number(item.lineTotal) / 2).toFixed(4);

    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount, allocations: [{ sellerOrderId: subA.id, orderItemId: item.id, amount }] },
    });
    expect(r.status).toBe(201);
    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(1);
    expect(allocs[0].orderItemId).toBe(item.id);
  });
});

describe('M2.4-T2.2 — refund allocation: rejections', () => {
  it('5. rejects a line allocated to a seller that does not own it', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA, subB] = s.subs;
    const itemB = subB.items[0];
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: {
        amount: '1.0000',
        allocations: [{ sellerOrderId: subA.id, orderItemId: itemB.id, amount: '1.0000' }],
      },
    });
    expect(r.status).toBe(422);
    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.parentOrderId, s.orderId));
    expect(allocs.length).toBe(0);
  });

  it('6. rejects an allocation whose suborder belongs to a different parent order', async () => {
    const a = await setupMultiSellerPaidOrder();
    const b = await setupMultiSellerPaidOrder();
    const r = await a.admin.req(`/api/payments/orders/${a.orderId}/refunds`, {
      method: 'POST',
      body: { amount: '1.0000', allocations: [{ sellerOrderId: b.subs[0].id, amount: '1.0000' }] },
    });
    expect(r.status).toBe(422);
  });

  it('7. rejects an allocation that exceeds the suborder refundable amount', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;
    const over = (subA.cap + 0.5).toFixed(4);
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: over, allocations: [{ sellerOrderId: subA.id, amount: over }] },
    });
    expect(r.status).toBe(422);
  });

  it('8. rejects a partial refund whose allocations do not sum to the amount', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: '5.0000', allocations: [{ sellerOrderId: subA.id, amount: '1.0000' }] },
    });
    expect(r.status).toBe(422);
  });

  it('9. rejects a partial refund of a multi-seller order that names no seller suborder', async () => {
    const s = await setupMultiSellerPaidOrder();
    // A partial amount with no allocations on a multi-seller order is ambiguous:
    // we cannot know which seller it belongs to, so it is refused (not guessed).
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: '5.0000' },
    });
    expect(r.status).toBe(422);
    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.parentOrderId, s.orderId));
    expect(allocs.length).toBe(0);
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, s.orderId));
    expect(rows.length).toBe(0);
  });

  it('10. rejects a duplicate allocation for the same suborder', async () => {
    const s = await setupMultiSellerPaidOrder();
    const [subA] = s.subs;
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: {
        amount: '2.0000',
        allocations: [
          { sellerOrderId: subA.id, amount: '1.0000' },
          { sellerOrderId: subA.id, amount: '1.0000' },
        ],
      },
    });
    expect(r.status).toBe(422);
  });
});

describe('M2.4-T2.2 — refund allocation: concurrency, idempotency, legacy', () => {
  it('11. two concurrent refunds of the same remainder never exceed the total', async () => {
    const s = await setupMultiSellerPaidOrder();

    const fire = () =>
      s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'race' } });
    const [r1, r2] = await Promise.all([fire(), fire()]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one wins; the second sees the reservation and is refused.
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(422);

    const rows = await db.select().from(refunds).where(eq(refunds.orderId, s.orderId));
    const reserved = rows.reduce((acc, r) => acc + Number(r.amount), 0);
    expect(reserved).toBeLessThanOrEqual(Number(s.grandTotal));
    expect(rows.length).toBe(1);
  });

  it('12. idempotent replay creates no additional allocations', async () => {
    const s = await setupMultiSellerPaidOrder();
    const key = `ra-idem-${s.stamp}`;
    const body = { reason: 'idem', idempotencyKey: key };

    const first = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body });
    expect(first.status).toBe(201);
    const before = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, first.data.data.refund.id));
    expect(before.length).toBe(2);

    const replay = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body });
    expect(replay.data.data.reused).toBe(true);
    const after = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, first.data.data.refund.id));
    expect(after.length).toBe(before.length);
  });

  it('13. preserves the legacy order path (no seller suborders)', async () => {
    // A pre-M2 order: order + payment but no `seller_orders` rows at all.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const buyerId = randomUUID();
    await db.insert(users).values({
      id: buyerId,
      email: `ra-legacy-${stamp}@wasit.tn`,
      passwordHash: 'x',
      firstName: 'Legacy',
      isActive: true,
      emailVerified: true,
    });
    const orderId = `ord-ra-legacy-${stamp}`;
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `ORDRALEG-${stamp}`,
      buyerId,
      buyerType: 'CUSTOMER',
      sellerId: 'legacy-seller',
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '100.0000',
      commission: '4.0000',
      buyerCommission: '2.0000',
      paymentFee: '0',
      grandTotal: '102.0000',
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      refundStatus: 'NONE',
    });
    await db.insert(payments).values({
      id: randomUUID(),
      transactionId: randomUUID(),
      orderId,
      amount: '102.0000',
      currencyCode: 'TND',
      status: 'PAID',
    });

    const admin = await createAdminClient();
    const r = await admin.req(`/api/payments/orders/${orderId}/refunds`, { method: 'POST', body: { reason: 'legacy full' } });
    expect(r.status).toBe(201);
    expect(r.data.data.refund.amount).toBe('102.0000');

    const allocs = await db.select().from(refundAllocations).where(eq(refundAllocations.refundId, r.data.data.refund.id));
    expect(allocs.length).toBe(0);
  });

  it('14. writes no REFUND ledger entry and does not touch order state at creation', async () => {
    const s = await setupMultiSellerPaidOrder();
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { reason: 'no completion here' },
    });
    expect(r.status).toBe(201);
    // The offline `manual` provider cannot prove money moved, so the refund is a
    // REQUEST: nothing is completed here.
    expect(r.data.data.refund.status).toBe('REQUESTED');

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.filter((l) => l.entryType === 'REFUND').length).toBe(0);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    expect(orderRow[0].status).not.toBe('REFUNDED');
    expect(orderRow[0].refundStatus).toBe('NONE');
  });
});
