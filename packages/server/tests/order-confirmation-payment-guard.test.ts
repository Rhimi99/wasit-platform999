import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import {
  orders,
  payments,
  paymentIntents,
  transactionLedger,
  transactions,
} from '../src/db/schema/index.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';

/**
 * SEC-03 — Payment must be verified before an order can be confirmed.
 *
 * These specs drive the REAL order + payment services against a real PostgreSQL
 * database and the real (offline, demo-mode) payment kernel. No WASIT logic is
 * mocked. The webhook is signed with the real HMAC secret, exactly as the
 * provider adapter verifies it.
 *
 * The point of every case is the same invariant: an order may not reach
 * CONFIRMED (nor PROCESSING/SHIPPED/DELIVERED/COMPLETED) — and stock may not be
 * decremented — unless the payment was confirmed through the trusted provider
 * path for the correct order, amount and currency.
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

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Guard', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

async function createAdminClient(): Promise<ReturnType<typeof makeClient>> {
  const password = 'AdminPass123!';
  const id = randomUUID();
  const email = `ocg-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Guard Admin',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return c;
}

/** Supplier (seller) + customer (buyer) + product with stock + an order. */
async function setupOrder(opts: { qty?: number; stock?: number } = {}) {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await register(supplier, `ocg-sup-${stamp}@wasit.tn`, 'SUPPLIER');
  await register(buyer, `ocg-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const buyerLogin = await buyer.req('/api/auth/login', {
    method: 'POST',
    body: { email: `ocg-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  const buyerId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: `OCG Co ${stamp}` } });
  const supplierId = supplierProfile.data.data.id as string;
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const stock = opts.stock ?? 50;
  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `OCG-${stamp}`,
      categoryId,
      name: `OCG Product ${stamp}`,
      basePrice: '10.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: stock,
      lowStockThreshold: 5,
      quantity: stock,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;

  const invList = await supplier.req('/api/inventory');
  const invItem = (invList.data.data.items as Array<{ id: string; productId: string }>).find(
    (i) => i.productId === productId,
  )!;
  expect(invItem).toBeDefined();

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, buyerType: 'CUSTOMER', items: [{ productId, quantity: opts.qty ?? 3 }] },
  });
  expect(order.status).toBe(201);

  return {
    supplier,
    buyer,
    buyerId,
    supplierId,
    productId,
    inventoryItemId: invItem.id,
    orderId: order.data.data.orderId as string,
    grandTotal: order.data.data.grandTotal as string,
  };
}

/** Drives the trusted provider path: intent then a signed success webhook. */
async function payOrder(s: { buyer: ReturnType<typeof makeClient>; orderId: string }, amount?: string) {
  const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
  expect(intentRes.status).toBe(201);
  const externalRef = intentRes.data.data.intent.externalRef as string;
  const body = JSON.stringify({
    eventId: `ocg-${s.orderId}-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef,
    amount: amount ?? intentRes.data.data.intent.amount,
    currencyCode: 'TND',
  });
  const signature = computeWebhookSignature(body, WEBHOOK_SECRET);
  const hook = await s.buyer.req('/api/payment-webhooks', {
    method: 'POST',
    rawBody: body,
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
  });
  expect(hook.status).toBe(200);
  expect(hook.data.data.applied).toBe(true);
  return externalRef;
}

async function inventoryOf(id: string) {
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1);
  return rows[0];
}

async function orderOf(id: string) {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0];
}

afterAll(() => {
  closeDb();
});

describe('SEC-03 — order confirmation requires a confirmed payment', () => {
  it('rejects CONFIRMED for an UNPAID order and decrements no stock', async () => {
    const s = await setupOrder();
    const before = await inventoryOf(s.inventoryItemId);

    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBe(409);

    const after = await orderOf(s.orderId);
    expect(after.status).toBe('PENDING');
    expect(after.paymentStatus).toBe('UNPAID');

    const inv = await inventoryOf(s.inventoryItemId);
    expect(inv.quantity).toBe(before.quantity);
    expect(inv.reservedQuantity).toBe(before.reservedQuantity);
  });

  it('rejects CONFIRMED while payment is PENDING (intent created, not paid)', async () => {
    const s = await setupOrder();
    const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    expect(intentRes.status).toBe(201);

    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBe(409);
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
  });

  it('rejects CONFIRMED after the payment FAILED', async () => {
    const s = await setupOrder();
    const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intentRes.data.data.intent.externalRef as string;
    const body = JSON.stringify({ eventId: `ocg-fail-${Date.now()}`, type: 'payment.failed', externalRef });
    const signature = computeWebhookSignature(body, WEBHOOK_SECRET);
    const hook = await s.buyer.req('/api/payment-webhooks', {
      method: 'POST',
      rawBody: body,
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    });
    expect(hook.status).toBe(200);
    expect((await orderOf(s.orderId)).paymentStatus).toBe('FAILED');

    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBe(409);
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
  });

  it('a payment for a DIFFERENT order does not unlock confirmation of this one', async () => {
    const a = await setupOrder();
    const b = await setupOrder();
    // Pay order A in full.
    await payOrder(a);
    expect((await orderOf(a.orderId)).paymentStatus).toBe('PAID');

    // Order B remains unpaid and must not be confirmable.
    expect((await orderOf(b.orderId)).paymentStatus).toBe('UNPAID');
    const res = await b.supplier.req(`/api/orders/${b.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBe(409);
    expect((await orderOf(b.orderId)).status).toBe('PENDING');
  });

  it('a mismatch between the confirmed amount and the order total is refused (defence in depth)', async () => {
    const s = await setupOrder();
    // Forge the trusted state directly: SUCCEEDED intent + PAID payment whose
    // amount differs from the order. This simulates any future path that sets
    // paymentStatus without the amount actually reconciling.
    await db
      .update(orders)
      .set({ paymentStatus: 'PAID' })
      .where(eq(orders.id, s.orderId));
    await db.insert(paymentIntents).values({
      id: randomUUID(),
      orderId: s.orderId,
      amount: '999.0000',
      currencyCode: 'TND',
      provider: 'manual',
      idempotencyKey: `ocg-mismatch-${s.orderId}`,
      externalRef: `manual_mismatch_${s.orderId}`,
      status: 'SUCCEEDED',
    });
    await db.insert(payments).values({
      id: randomUUID(),
      transactionId: randomUUID(),
      orderId: s.orderId,
      amount: '999.0000',
      currencyCode: 'TND',
      provider: 'manual',
      status: 'PAID',
    });

    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBe(409);
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
  });

  it('blocks a seller from confirming an order they own but that is unpaid', async () => {
    const s = await setupOrder();
    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'PROCESSING' }, // skip straight past CONFIRMED
    });
    expect(res.status).toBe(409);
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
    const inv = await inventoryOf(s.inventoryItemId);
    expect(inv.quantity).toBe(50);
  });

  it('an ADMIN cannot bypass the payment guard on an order they do not own', async () => {
    const s = await setupOrder();
    const admin = await createAdminClient();
    const res = await admin.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    // The order status endpoint is buyer/seller-scoped; an admin is neither.
    expect(res.status).toBe(403);
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
  });

  it('confirms a PAID order, decrements stock once, and is idempotent on repeat', async () => {
    const s = await setupOrder({ qty: 4, stock: 50 });
    await payOrder(s);
    expect((await orderOf(s.orderId)).paymentStatus).toBe('PAID');

    const first = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(first.status).toBe(200);
    const inv = await inventoryOf(s.inventoryItemId);
    expect(inv.quantity).toBe(46);
    expect(inv.reservedQuantity).toBe(0);

    // Repeating the same transition is a no-op: no second decrement.
    const again = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(again.status).toBe(200);
    const inv2 = await inventoryOf(s.inventoryItemId);
    expect(inv2.quantity).toBe(46);
  });

  it('two concurrent confirmations decrement stock exactly once', async () => {
    const s = await setupOrder({ qty: 5, stock: 50 });
    await payOrder(s);

    const [a, b] = await Promise.all([
      s.supplier.req(`/api/orders/${s.orderId}/status`, { method: 'PATCH', body: { status: 'CONFIRMED' } }),
      s.supplier.req(`/api/orders/${s.orderId}/status`, { method: 'PATCH', body: { status: 'CONFIRMED' } }),
    ]);
    expect([a.status, b.status]).toContain(200);

    const inv = await inventoryOf(s.inventoryItemId);
    expect(inv.quantity).toBe(45); // 50 - 5, once only
    expect(inv.reservedQuantity).toBe(0);
    expect((await orderOf(s.orderId)).status).toBe('CONFIRMED');
  });

  it('rolls back the status change atomically when the stock commit fails', async () => {
    const s = await setupOrder({ qty: 3, stock: 50 });
    await payOrder(s);

    // Simulate a stock failure mid-confirmation: zero the on-hand quantity after
    // the order reserved its 3 units, so commitReservationToSale cannot complete.
    await db
      .update(inventoryItems)
      .set({ quantity: 0, reservedQuantity: 3 })
      .where(eq(inventoryItems.id, s.inventoryItemId));

    const res = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The whole transition rolled back: the order is still PENDING, not left
    // half-confirmed with the stock untouched.
    expect((await orderOf(s.orderId)).status).toBe('PENDING');
  });

  it('a replayed success webhook applies once and creates no duplicate PAID state', async () => {
    const s = await setupOrder();
    const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intentRes.data.data.intent.externalRef as string;
    const body = JSON.stringify({
      eventId: `ocg-dup-${Date.now()}`,
      type: 'payment.succeeded',
      externalRef,
      amount: intentRes.data.data.intent.amount,
      currencyCode: 'TND',
    });
    const signature = computeWebhookSignature(body, WEBHOOK_SECRET);
    const headers = { 'Content-Type': 'application/json', 'x-wasit-signature': signature };

    const first = await s.buyer.req('/api/payment-webhooks', { method: 'POST', rawBody: body, headers });
    const second = await s.buyer.req('/api/payment-webhooks', { method: 'POST', rawBody: body, headers });
    expect(first.data.data.applied).toBe(true);
    expect(second.data.data.duplicate).toBe(true);
    expect(second.data.data.applied).toBe(false);

    const paidPayments = await db.select().from(payments).where(eq(payments.orderId, s.orderId));
    expect(paidPayments.filter((p) => p.status === 'PAID').length).toBe(1);
  });

  it('confirmation never lifts the ledger to SETTLED (Payment ≠ Settlement)', async () => {
    const s = await setupOrder();
    await payOrder(s);
    await s.supplier.req(`/api/orders/${s.orderId}/status`, { method: 'PATCH', body: { status: 'CONFIRMED' } });

    const orderRow = await orderOf(s.orderId);
    const txRows = await db.select().from(transactions).where(eq(transactions.orderId, s.orderId)).limit(1);
    expect(txRows.length).toBe(1);
    const ledger = await db
      .select()
      .from(transactionLedger)
      .where(eq(transactionLedger.transactionId, txRows[0].id));
    expect(ledger.length).toBeGreaterThan(0);
    // No SETTLEMENT entry and no SETTLED status may be produced by confirmation.
    expect(ledger.some((l) => l.entryType === 'SETTLEMENT')).toBe(false);
    expect(ledger.every((l) => l.status !== 'SETTLED')).toBe(true);
    expect(orderRow.settlementStatus).toBe('PENDING');
  });
});
