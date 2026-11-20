import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import {
  orderItems,
  orders,
  sellerOrders,
  transactionLedger,
  transactions,
} from '../src/db/schema/commerce.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';

/**
 * M2.1 — Per-suborder cancellation & inventory correction (real PostgreSQL).
 *
 * A mixed basket (two sellers) must decide stock per Seller Suborder from that
 * suborder's own lifecycle, never from the Parent Order's status. These specs
 * drive the REAL order service against a real database and assert the exact
 * stock/money outcome for: cancelling a confirmed suborder, cancelling a still
 * pending suborder, cancelling the whole mixed basket, retrying a cancel, two
 * concurrent cancels, and a legacy order that has no suborders at all.
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
    body: { email, password: 'StrongPass123!', firstName: 'M21', role },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return (login.data.data as { id: string }).id;
}

async function makeSellerWithProduct(stamp: string, tag: string, price: string, stock: number) {
  const client = makeClient();
  const userId = await registerAndLogin(client, `m21-${tag}-${stamp}@wasit.tn`, 'SUPPLIER');
  const profile = await client.req('/api/suppliers', { method: 'POST', body: { companyName: `M21 ${tag} ${stamp}` } });
  expect(profile.status).toBe(201);
  const sellerId = profile.data.data.id as string;
  const cats = await client.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const product = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: 'SUPPLIER',
      sku: `M21-${tag}-${stamp}`,
      categoryId,
      name: `M21 ${tag} Product ${stamp}`,
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
  const userId = await registerAndLogin(client, `m21-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  return { client, userId };
}

async function invOf(productId: string) {
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.productId, productId)).limit(1);
  return rows[0];
}

async function orderOf(id: string) {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0];
}

async function subsOf(parentOrderId: string) {
  return db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, parentOrderId));
}

async function ledgerOf(orderId: string) {
  const tx = (await db.select().from(transactions).where(eq(transactions.orderId, orderId)).limit(1))[0];
  if (!tx) return [];
  return db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, tx.id));
}

async function payOrder(client: ReturnType<typeof makeClient>, orderId: string) {
  const intent = await client.req(`/api/payments/orders/${orderId}/intent`, { method: 'POST', body: {} });
  expect(intent.status).toBe(201);
  const externalRef = intent.data.data.intent.externalRef as string;
  const body = JSON.stringify({
    eventId: `m21-${orderId}-${Date.now()}`,
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

/** Creates a two-seller paid order and returns every handle the specs need. */
async function mixedPaidOrder(stamp: string, tag: string, qtyA = 3, qtyB = 2) {
  const a = await makeSellerWithProduct(stamp, `${tag}a`, '10.0000', 50);
  const b = await makeSellerWithProduct(stamp, `${tag}b`, '20.0000', 50);
  const buyer = await buyerClient(stamp);
  const order = await buyer.client.req('/api/orders', {
    method: 'POST',
    body: {
      buyerId: buyer.userId,
      buyerType: 'CUSTOMER',
      items: [{ productId: a.productId, quantity: qtyA }, { productId: b.productId, quantity: qtyB }],
    },
  });
  expect(order.status).toBe(201);
  const orderId = order.data.data.orderId as string;
  await payOrder(buyer.client, orderId);
  const subs = await subsOf(orderId);
  const subA = subs.find((s) => s.sellerId === a.sellerId)!;
  const subB = subs.find((s) => s.sellerId === b.sellerId)!;
  return { a, b, buyer, orderId, subA, subB, qtyA, qtyB };
}

async function confirm(sellerClient: ReturnType<typeof makeClient>, orderId: string, sellerOrderId: string) {
  const res = await sellerClient.req(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    body: { status: 'CONFIRMED', sellerOrderId },
  });
  expect(res.status).toBe(200);
}

afterAll(() => {
  closeDb();
});

describe('M2.1 — per-suborder cancel & inventory (real DB)', () => {
  it('cancelling a CONFIRMED suborder reinstates only that seller’s stock', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, b, orderId, subA } = await mixedPaidOrder(stamp, 'ca');

    // Seller A confirms → A's stock decremented, A's reservation released.
    await confirm(a.client, orderId, subA.id);
    let invA = await invOf(a.productId);
    expect(invA.quantity).toBe(47); // 50 - 3
    expect(invA.reservedQuantity).toBe(0);
    const invBBefore = await invOf(b.productId);
    expect(invBBefore.quantity).toBe(50);
    expect(invBBefore.reservedQuantity).toBe(2); // B still only reserved

    // The parent is still PENDING (B has not confirmed). This is exactly the
    // condition that used to mis-drive the stock decision: the OLD code read the
    // parent's status here and would have *released* instead of *reinstated*.
    expect((await orderOf(orderId)).status).toBe('PENDING');

    // Seller A cancels their own (confirmed) suborder → stock comes back.
    const cancel = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subA.id },
    });
    expect(cancel.status).toBe(200);

    invA = await invOf(a.productId);
    expect(invA.quantity).toBe(50); // reinstated
    expect(invA.reservedQuantity).toBe(0);

    // B was never confirmed, so B is untouched: still reserved, on-hand intact.
    const invBAfter = await invOf(b.productId);
    expect(invBAfter.quantity).toBe(50);
    expect(invBAfter.reservedQuantity).toBe(2);

    // The buyer's cancel of a still-pending B is unaffected by A's cancel.
    const subs = await subsOf(orderId);
    expect(subs.find((s) => s.id === subA.id)!.status).toBe('CANCELLED');
    expect(subs.find((s) => s.sellerId === b.sellerId)!.status).toBe('PENDING');
  });

  it('cancelling a still-PENDING suborder only releases its reservation', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, b, orderId, subB } = await mixedPaidOrder(stamp, 'pa');

    // Nothing confirmed yet: both sellers hold reservations only.
    expect((await invOf(a.productId)).reservedQuantity).toBe(3);
    expect((await invOf(b.productId)).reservedQuantity).toBe(2);

    // Buyer cancels just B's suborder (still pending).
    const cancel = await b.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subB.id },
    });
    expect(cancel.status).toBe(200);

    const invB = await invOf(b.productId);
    expect(invB.quantity).toBe(50); // never decremented → NOT reinstated
    expect(invB.reservedQuantity).toBe(0); // reservation released

    // A's reservation is untouched.
    const invA = await invOf(a.productId);
    expect(invA.quantity).toBe(50);
    expect(invA.reservedQuantity).toBe(3);
  });

  it('cancelling a whole mixed basket applies each suborder’s own stock rule', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, b, buyer, orderId, subA } = await mixedPaidOrder(stamp, 'wo');

    // A confirmed (stock decremented), B still pending (reserved only).
    await confirm(a.client, orderId, subA.id);
    expect((await invOf(a.productId)).quantity).toBe(47);
    expect((await invOf(b.productId)).quantity).toBe(50);
    expect((await invOf(b.productId)).reservedQuantity).toBe(2);

    // Buyer cancels the whole basket.
    const cancel = await buyer.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED' },
    });
    expect(cancel.status).toBe(200);

    // A: reinstated (was committed). B: released (was only reserved).
    const invA = await invOf(a.productId);
    const invB = await invOf(b.productId);
    expect(invA.quantity).toBe(50);
    expect(invA.reservedQuantity).toBe(0);
    expect(invB.quantity).toBe(50);
    expect(invB.reservedQuantity).toBe(0);

    const subs = await subsOf(orderId);
    expect(subs.every((s) => s.status === 'CANCELLED')).toBe(true);
    expect((await orderOf(orderId)).status).toBe('CANCELLED');
  });

  it('does not restore stock twice when the cancel is retried', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, orderId, subA } = await mixedPaidOrder(stamp, 'rt');
    await confirm(a.client, orderId, subA.id);
    expect((await invOf(a.productId)).quantity).toBe(47);

    const first = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subA.id },
    });
    expect(first.status).toBe(200);
    expect((await invOf(a.productId)).quantity).toBe(50);

    // Replay the same cancel — the suborder is already CANCELLED, so nothing moves.
    const second = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subA.id },
    });
    expect(second.status).toBe(200);
    expect((await invOf(a.productId)).quantity).toBe(50); // NOT 53
    expect((await invOf(a.productId)).reservedQuantity).toBe(0);
  });

  it('does not double-restore when two cancels of the same suborder run concurrently', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, orderId, subA } = await mixedPaidOrder(stamp, 'cc');
    await confirm(a.client, orderId, subA.id);
    expect((await invOf(a.productId)).quantity).toBe(47);

    const [r1, r2] = await Promise.all([
      a.client.req(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED', sellerOrderId: subA.id },
      }),
      a.client.req(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED', sellerOrderId: subA.id },
      }),
    ]);
    expect([r1.status, r2.status]).toContain(200);

    // Exactly one cancel won the guarded UPDATE; stock restored once.
    expect((await invOf(a.productId)).quantity).toBe(50);
    expect((await invOf(a.productId)).reservedQuantity).toBe(0);
  });

  it('never touches another seller’s stock when one suborder is cancelled', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, b, orderId, subA, subB } = await mixedPaidOrder(stamp, 'nt');
    await confirm(a.client, orderId, subA.id);
    await confirm(b.client, orderId, subB.id);
    const bBefore = await invOf(b.productId);
    expect(bBefore.quantity).toBe(48); // 50 - 2

    await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subA.id },
    });

    const bAfter = await invOf(b.productId);
    expect(bAfter.quantity).toBe(48); // unchanged
    expect(bAfter.reservedQuantity).toBe(0);
  });

  it('keeps a legacy order with no suborders working exactly as before', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, buyer, orderId } = await mixedPaidOrder(stamp, 'lg', 5, 1);
    // Simulate a pre-M2 row: detach the lines from their suborders and drop them,
    // leaving a parent order with no `seller_orders` at all.
    await db.update(orderItems).set({ sellerOrderId: null, sellerId: null }).where(eq(orderItems.orderId, orderId));
    await db.delete(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
    expect(await subsOf(orderId)).toHaveLength(0);

    // A legacy order is a single-seller order in this shape; cancel it directly.
    const cancel = await buyer.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED' },
    });
    expect(cancel.status).toBe(200);
    expect((await orderOf(orderId)).status).toBe('CANCELLED');
    // Its reservation was released without inventing a stock reinstatement.
    const invA = await invOf(a.productId);
    expect(invA.quantity).toBe(50);
    expect(invA.reservedQuantity).toBe(0);
  });

  it('writes no incorrect financial records when a suborder is cancelled', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, orderId, subA } = await mixedPaidOrder(stamp, 'fi');
    await confirm(a.client, orderId, subA.id);

    const before = await ledgerOf(orderId);
    const beforeTx = (await db.select().from(transactions).where(eq(transactions.orderId, orderId)).limit(1))[0];

    const cancel = await a.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subA.id },
    });
    expect(cancel.status).toBe(200);

    const after = await ledgerOf(orderId);
    const afterTx = (await db.select().from(transactions).where(eq(transactions.orderId, orderId)).limit(1))[0];

    // A cancellation is not a refund: no ledger entry is added or removed, and
    // the transaction's own state is unchanged. (Refunds go through the refund
    // path, which is the only writer of REFUND entries.)
    expect(after).toHaveLength(before.length);
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    expect(afterTx.status).toBe(beforeTx.status);
    expect(after.some((e) => e.entryType === 'REFUND')).toBe(false);
  });

  it('reflects a partially cancelled basket without a misleading PENDING parent', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { a, b, orderId, subA, subB } = await mixedPaidOrder(stamp, 'ps');
    await confirm(a.client, orderId, subA.id);
    await confirm(b.client, orderId, subB.id);
    expect((await orderOf(orderId)).status).toBe('CONFIRMED');

    // Cancel only B → parent must reflect A's live CONFIRMED, not a stale PENDING.
    await b.client.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED', sellerOrderId: subB.id },
    });
    const parent = await orderOf(orderId);
    expect(parent.status).toBe('CONFIRMED');
    const subs = await subsOf(orderId);
    expect(subs.find((s) => s.id === subA.id)!.status).toBe('CONFIRMED');
    expect(subs.find((s) => s.id === subB.id)!.status).toBe('CANCELLED');
  });
});
