import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, orderItems, sellerOrders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';

/**
 * M2 — Multi-Seller Order Architecture (real PostgreSQL, real services).
 *
 * A basket spanning several sellers becomes ONE Parent Order (buyer identity,
 * grand total, one payment) plus one Seller Suborder per seller (their own
 * lines, items total, commission share and fulfilment state). These specs drive
 * the REAL order/payment services against a real database; no WASIT logic is
 * mocked. The webhook is signed with the real HMAC secret.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

function makeClient() {
  let cookie = '';
  return {
    async req(
      path: string,
      options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
    ) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.rawBody !== undefined
            ? options.rawBody
            : options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
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

async function registerAndLogin(c: ReturnType<typeof makeClient>, email: string, role: string): Promise<string> {
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'M2', role },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return (login.data.data as { id: string }).id;
}

/** A supplier client with a profile and a product (returns client + ids). */
async function makeSellerWithProduct(stamp: string, tag: string, price: string, stock: number) {
  const client = makeClient();
  const email = `m2-${tag}-${stamp}@wasit.tn`;
  const userId = await registerAndLogin(client, email, 'SUPPLIER');
  const profile = await client.req('/api/suppliers', { method: 'POST', body: { companyName: `M2 ${tag} ${stamp}` } });
  expect(profile.status).toBe(201);
  const sellerId = profile.data.data.id as string;
  const cats = await client.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const product = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: 'SUPPLIER',
      sku: `M2-${tag}-${stamp}`,
      categoryId,
      name: `M2 ${tag} Product ${stamp}`,
      basePrice: price,
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: stock,
      lowStockThreshold: 5,
      quantity: stock,
    },
  });
  expect(product.status).toBe(201);
  return { client, userId, sellerId, productId: product.data.data.id as string };
}

async function buyerClient(stamp: string) {
  const client = makeClient();
  const email = `m2-buy-${stamp}@wasit.tn`;
  const userId = await registerAndLogin(client, email, 'CUSTOMER');
  return { client, userId, email };
}

async function orderOf(id: string) {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0];
}

async function subordersOf(parentOrderId: string) {
  return db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, parentOrderId));
}

/** Pays a whole parent order through the trusted provider path. */
async function payOrder(client: ReturnType<typeof makeClient>, orderId: string) {
  const intent = await client.req(`/api/payments/orders/${orderId}/intent`, { method: 'POST', body: {} });
  expect(intent.status).toBe(201);
  const externalRef = intent.data.data.intent.externalRef as string;
  const body = JSON.stringify({
    eventId: `m2-${orderId}-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef,
    amount: intent.data.data.intent.amount,
    currencyCode: 'TND',
  });
  const signature = computeWebhookSignature(body, WEBHOOK_SECRET);
  const hook = await client.req('/api/payment-webhooks', {
    method: 'POST',
    rawBody: body,
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
  });
  expect(hook.status).toBe(200);
  expect(hook.data.data.applied).toBe(true);
}

afterAll(() => {
  closeDb();
});

describe('M2 — multi-seller parent order + seller suborders (real DB)', () => {
  it('splits a two-seller basket into one parent and two suborders, each with its own money', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'sa', '10.0000', 50);
    const b = await makeSellerWithProduct(stamp, 'sb', '20.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'CUSTOMER',
        items: [
          { productId: a.productId, quantity: 2 }, // 20.00
          { productId: b.productId, quantity: 1 }, // 20.00
        ],
      },
    });
    expect(order.status).toBe(201);
    const orderId = order.data.data.orderId as string;

    // One parent order, no single seller, correct aggregate money.
    const parent = await orderOf(orderId);
    expect(parent.sellerId).toBeNull();
    expect(parent.sellerType).toBeNull();
    expect(parent.itemsTotal).toBe('40.0000');
    // 4% of 40 = 1.60 total (0.80 + 0.80).
    expect(parent.commission).toBe('1.6000');
    expect(parent.buyerCommission).toBe('0.8000');
    expect(parent.grandTotal).toBe('40.8000');

    // One suborder per seller, each carrying that seller's own totals.
    const subs = await subordersOf(orderId);
    expect(subs).toHaveLength(2);
    const bySeller = new Map(subs.map((s) => [s.sellerId, s]));
    const subA = bySeller.get(a.sellerId)!;
    const subB = bySeller.get(b.sellerId)!;
    expect(subA).toBeDefined();
    expect(subB).toBeDefined();
    expect(subA.itemsTotal).toBe('20.0000');
    expect(subA.commission).toBe('0.8000');
    expect(subA.buyerCommission).toBe('0.4000');
    expect(subA.sellerCommission).toBe('0.4000');
    expect(subA.sellerPayable).toBe('19.6000');
    expect(subB.itemsTotal).toBe('20.0000');

    // Every line carries its seller and points at that seller's suborder.
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const sub = bySeller.get(line.sellerId!);
      expect(sub).toBeDefined();
      expect(line.sellerOrderId).toBe(sub!.id);
    }

    // Ledger: one TRANSACTION_VALUE credit PER SELLER, so neither seller's funds
    // are attributed to the other.
    const tx = (await db.select().from(transactions).where(eq(transactions.orderId, orderId)).limit(1))[0];
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, tx.id));
    const credits = ledger.filter((e) => e.entryType === 'TRANSACTION_VALUE');
    expect(credits).toHaveLength(2);
    expect(credits.map((e) => e.beneficiaryId).sort()).toEqual([a.sellerId, b.sellerId].sort());
    expect(credits.every((e) => e.amount === '20.0000')).toBe(true);
    const sellerCommissionDebits = ledger.filter(
      (e) => e.entryType === 'COMMISSION' && (e.metadata as { share?: string } | null)?.share === 'SELLER',
    );
    expect(sellerCommissionDebits).toHaveLength(2);
    expect(sellerCommissionDebits.map((e) => e.payerId).sort()).toEqual([a.sellerId, b.sellerId].sort());
  });

  it('lets each seller confirm only their own suborder, and aggregates the parent status', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'ca', '10.0000', 50);
    const b = await makeSellerWithProduct(stamp, 'cb', '10.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'CUSTOMER',
        items: [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }],
      },
    });
    expect(order.status).toBe(201);
    const orderId = order.data.data.orderId as string;
    await payOrder(buyer.client, orderId);

    const subs = await subordersOf(orderId);
    const subA = subs.find((s) => s.sellerId === a.sellerId)!;
    const subB = subs.find((s) => s.sellerId === b.sellerId)!;

    // Seller A confirms their suborder (payment is confirmed for the parent).
    const confirmA = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED', sellerOrderId: subA.id },
    });
    expect(confirmA.status).toBe(200);

    // A's suborder is CONFIRMED, B's is still PENDING, and the parent is only
    // CONFIRMED once every seller has confirmed.
    let subsAfter = await subordersOf(orderId);
    expect(subsAfter.find((s) => s.id === subA.id)!.status).toBe('CONFIRMED');
    expect(subsAfter.find((s) => s.id === subB.id)!.status).toBe('PENDING');
    expect((await orderOf(orderId)).status).toBe('PENDING');

    // B confirms theirs → the parent becomes CONFIRMED.
    const confirmB = await b.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED', sellerOrderId: subB.id },
    });
    expect(confirmB.status).toBe(200);
    subsAfter = await subordersOf(orderId);
    expect(subsAfter.every((s) => s.status === 'CONFIRMED')).toBe(true);
    expect((await orderOf(orderId)).status).toBe('CONFIRMED');

    // Seller A's stock was decremented by exactly their own line (1 unit).
    const invA = (await db.select().from(inventoryItems).where(eq(inventoryItems.productId, a.productId)).limit(1))[0];
    expect(invA.quantity).toBe(49);
    expect(invA.reservedQuantity).toBe(0);
  });

  it('refuses one seller confirming a suborder they do not own', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'oa', '10.0000', 50);
    const b = await makeSellerWithProduct(stamp, 'ob', '10.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'CUSTOMER',
        items: [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }],
      },
    });
    const orderId = order.data.data.orderId as string;
    await payOrder(buyer.client, orderId);
    const subB = (await subordersOf(orderId)).find((s) => s.sellerId === b.sellerId)!;

    // Seller A tries to move Seller B's suborder → forbidden.
    const res = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED', sellerOrderId: subB.id },
    });
    expect(res.status).toBe(403);
    expect((await subordersOf(orderId)).find((s) => s.id === subB.id)!.status).toBe('PENDING');
  });

  it('shows each seller only their own suborder lines on the order detail', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'da', '10.0000', 50);
    const b = await makeSellerWithProduct(stamp, 'db', '10.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'CUSTOMER',
        items: [{ productId: a.productId, quantity: 3 }, { productId: b.productId, quantity: 2 }],
      },
    });
    const orderId = order.data.data.orderId as string;

    // Buyer sees the whole basket and both suborders.
    const buyerView = await buyer.client.req(`/api/orders/${orderId}`);
    expect(buyerView.status).toBe(200);
    expect(buyerView.data.data.isMultiSeller).toBe(true);
    expect(buyerView.data.data.items).toHaveLength(2);
    expect(buyerView.data.data.sellerOrders).toHaveLength(2);
    expect(buyerView.data.data.viewerRole).toBe('BUYER');

    // Seller A sees their own suborder with only their line.
    const aView = await a.client.req(`/api/orders/${orderId}`);
    expect(aView.status).toBe(200);
    expect(aView.data.data.viewerRole).toBe('SELLER');
    const aSub = (aView.data.data.sellerOrders as Array<{ sellerId: string; items: unknown[] }>).find(
      (s) => s.sellerId === a.sellerId,
    )!;
    expect(aSub.items).toHaveLength(1);

    // The basket appears in both sellers' own order lists.
    const aList = await a.client.req('/api/orders');
    expect((aList.data.data as Array<{ id: string }>).some((o) => o.id === orderId)).toBe(true);
    const bList = await b.client.req('/api/orders');
    expect((bList.data.data as Array<{ id: string }>).some((o) => o.id === orderId)).toBe(true);
  });

  it('lets the buyer cancel a whole multi-seller basket, releasing every seller’s reservation', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'xa', '10.0000', 50);
    const b = await makeSellerWithProduct(stamp, 'xb', '10.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'CUSTOMER',
        items: [{ productId: a.productId, quantity: 4 }, { productId: b.productId, quantity: 4 }],
      },
    });
    const orderId = order.data.data.orderId as string;

    const cancel = await buyer.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED' },
    });
    expect(cancel.status).toBe(200);

    const subs = await subordersOf(orderId);
    expect(subs.every((s) => s.status === 'CANCELLED')).toBe(true);
    expect((await orderOf(orderId)).status).toBe('CANCELLED');

    // Every reservation was released — no stock left held.
    for (const productId of [a.productId, b.productId]) {
      const inv = (await db.select().from(inventoryItems).where(eq(inventoryItems.productId, productId)).limit(1))[0];
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.quantity).toBe(50);
    }
  });

  it('keeps single-seller orders on the exact previous shape (one suborder, seller on the parent)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'ss', '15.5000', 100);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyer.userId, buyerType: 'CUSTOMER', items: [{ productId: a.productId, quantity: 20 }] },
    });
    expect(order.status).toBe(201);
    const orderId = order.data.data.orderId as string;
    const d = order.data.data as Record<string, string>;

    // 20 × 15.50 = 310.00; 4% = 12.40 (6.20 + 6.20); grandTotal 316.20.
    // `itemsTotal` is returned as a decimal value (pre-existing response shape),
    // so compare numerically; the commission fields stay fixed-precision strings.
    expect(Number(d.itemsTotal)).toBe(310);
    expect(d.commission).toBe('12.4000');
    expect(d.commissionSeller).toBe('6.2000');
    expect(d.commissionBuyer).toBe('6.2000');
    expect(d.grandTotal).toBe('316.2000');

    const parent = await orderOf(orderId);
    expect(parent.sellerId).toBe(a.sellerId);
    const subs = await subordersOf(orderId);
    expect(subs).toHaveLength(1);
    expect(subs[0].itemsTotal).toBe('310.0000');
    expect(subs[0].sellerPayable).toBe('303.8000');
  });

  it('derives the parent as DELIVERED once a seller line is delivered (not stuck at SHIPPED)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await makeSellerWithProduct(stamp, 'dlv', '10.0000', 50);
    const buyer = await buyerClient(stamp);

    const order = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyer.userId, buyerType: 'CUSTOMER', items: [{ productId: a.productId, quantity: 1 }] },
    });
    expect(order.status).toBe(201);
    const orderId = order.data.data.orderId as string;
    await payOrder(buyer.client, orderId);

    const sub = (await subordersOf(orderId))[0];
    for (const status of ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const res = await a.client.req(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: { status, sellerOrderId: sub.id },
      });
      expect(res.status).toBe(200);
    }

    // The suborder is DELIVERED, so the parent must read DELIVERED too: folding
    // DELIVERED into SHIPPED would leave the parent one step behind its own line.
    expect((await subordersOf(orderId))[0].status).toBe('DELIVERED');
    expect((await orderOf(orderId)).status).toBe('DELIVERED');

    // The seller can still drive the line — and the parent — to COMPLETED.
    const complete = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'COMPLETED', sellerOrderId: sub.id },
    });
    expect(complete.status).toBe(200);
    expect((await orderOf(orderId)).status).toBe('COMPLETED');
  });
});
