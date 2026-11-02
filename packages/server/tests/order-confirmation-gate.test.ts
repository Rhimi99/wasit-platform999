import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, transactions } from '../src/db/schema/commerce.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { handlePaymentWebhook } from '../src/modules/payments/service.js';
import { computeWebhookSignature, ManualPaymentProvider } from '../src/lib/payments/providers.js';

/**
 * PS-08A — an order may not be CONFIRMED before its payment is proven.
 *
 * Confirmation is a money-gated transition: it commits the stock reservation to a
 * sale. The gate asserts `orders.payment_status = 'PAID'`, which the payment
 * kernel writes only off provider-verified evidence (a signed webhook, or the
 * offline desk completing a real intent). These specs exercise the real
 * route → service → database chain against a real database and pin the rule:
 *
 *  1. an unpaid / unconfirmed order is refused (409);
 *  2. a paid order confirms normally;
 *  3. a refused confirmation moves no stock and commits no sale;
 *  4. the gate cannot be bypassed by picking a different actor role;
 *  5. the documented demo flow (offline desk → PAID → CONFIRMED) still works.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
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
    body: { email, password: 'StrongPass123!', firstName: 'Gate', role },
  });
  expect(r.status).toBe(201);
}

async function createStaffClient(roleName: string) {
  const id = randomUUID();
  const email = `gate-${roleName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const password = 'StaffPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Gate Staff',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return c;
}

/** Supplier + customer + a real product (stock 100) + a real order (20 units). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `gate-sup-${stamp}@wasit.tn`;
  const buyerEmail = `gate-buy-${stamp}@wasit.tn`;

  await registerUser(supplier, supplierEmail, 'SUPPLIER');
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: supplierEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: buyerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  expect(buyerLogin.status).toBe(200);
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Gate Test Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `GATESKU-${stamp}`,
      categoryId,
      name: `Gate Product ${stamp}`,
      basePrice: '15.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  const invList = await supplier.req('/api/inventory?pageSize=100');
  const invItems = (invList.data.data.items as Array<{ id: string; productId: string }>);
  const inventoryItemId = invItems.find((i) => i.productId === productId)!.id;

  return { supplier, buyer, buyerUserId, supplierId, productId, inventoryItemId, ...orderData };
}

async function startIntent(buyer: ReturnType<typeof makeClient>, orderId: string) {
  const r = await buyer.req(`/api/payments/orders/${orderId}/intent`, { method: 'POST', body: {} });
  expect(r.status).toBe(201);
  return r.data.data.intent as { externalRef: string; amount: string };
}

/** Confirms the payment through the real service, using the offline demo provider. */
async function confirmPayment(externalRef: string, amount: string) {
  const rawBody = JSON.stringify({
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'payment.succeeded',
    externalRef,
    amount,
    currencyCode: 'TND',
  });
  return handlePaymentWebhook(
    db,
    { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
    new ManualPaymentProvider(),
  );
}

async function orderRow(orderId: string) {
  const rows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return rows[0];
}

async function inventoryRow(inventoryItemId: string) {
  const r = await db.execute<{ quantity: string; reserved_quantity: string }>(
    sql`select quantity, reserved_quantity from inventory_items where id = ${inventoryItemId}`,
  );
  const rows = (r as unknown as { rows: Array<{ quantity: string; reserved_quantity: string }> }).rows;
  return { quantity: Number(rows[0].quantity), reserved: Number(rows[0].reserved_quantity) };
}

afterAll(async () => {
  await closeDb();
});

describe('PS-08A — an order cannot be confirmed before payment is proven', () => {
  it('refuses CONFIRMED on an unpaid order (no intent yet)', async () => {
    const s = await setupOrder();
    const confirm = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(409);
    expect(confirm.data.error.code).toBe('CONFLICT');
    expect((await orderRow(s.orderId)).status).toBe('PENDING');
  });

  it('refuses CONFIRMED when an intent exists but the payment is only PENDING', async () => {
    const s = await setupOrder();
    await startIntent(s.buyer, s.orderId);
    // The intent moved the order to PENDING payment — still not proof of payment.
    expect((await orderRow(s.orderId)).paymentStatus).toBe('PENDING');

    const confirm = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(409);
    expect((await orderRow(s.orderId)).status).toBe('PENDING');
  });

  it('confirms a paid order and commits the sale', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    const applied = await confirmPayment(intent.externalRef, s.grandTotal);
    expect(applied.applied).toBe(true);
    expect((await orderRow(s.orderId)).paymentStatus).toBe('PAID');

    const confirm = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(200);
    expect((await orderRow(s.orderId)).status).toBe('CONFIRMED');

    // The sale is committed: on-hand stock drops and the reservation is released.
    const inv = await inventoryRow(s.inventoryItemId);
    expect(inv.quantity).toBe(80);
    expect(inv.reserved).toBe(0);
  });

  it('moves no stock and writes no status change when confirmation is refused', async () => {
    const s = await setupOrder();
    // A reservation exists (20 units held) but nothing is committed yet.
    const before = await inventoryRow(s.inventoryItemId);
    expect(before.quantity).toBe(100);
    expect(before.reserved).toBe(20);

    const confirm = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(409);

    const after = await inventoryRow(s.inventoryItemId);
    expect(after.quantity).toBe(100);
    expect(after.reserved).toBe(20);

    // The refusal is not a silent no-op the UI could misread as success: no
    // ORDER.STATUS_CHANGE audit was written for it.
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.orderId));
    expect(audit.some((a) => a.action === 'ORDER.STATUS_CHANGE')).toBe(false);
  });

  it('cannot be bypassed by choosing another actor: buyer and seller both hit the gate', async () => {
    const s = await setupOrder();

    // Buyer (the order's own party) is refused by the money gate, not authorized.
    const byBuyer = await s.buyer.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(byBuyer.status).toBe(409);

    // Seller (owning entity) is refused by the same gate.
    const bySeller = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(bySeller.status).toBe(409);

    // A privileged but unrelated actor is still refused on ownership (403): no
    // staff role opens an alternate path into this transition.
    const admin = await createStaffClient('ADMIN');
    const byAdmin = await admin.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(byAdmin.status).toBe(403);

    expect((await orderRow(s.orderId)).status).toBe('PENDING');
    expect((await orderRow(s.orderId)).paymentStatus).toBe('UNPAID');
  });

  it('keeps the documented demo path: offline desk completes payment, then CONFIRMED succeeds', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);

    // The offline rail has no signed callback; the operator desk completes the
    // real intent (refused outside demo mode by the provider resolver).
    const admin = await createStaffClient('ADMIN');
    const completed = await admin.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST', body: {} });
    expect(completed.status).toBe(200);
    expect(completed.data.data.paymentStatus).toBe('PAID');
    expect(intent.externalRef).toBeTruthy();

    const confirm = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(200);
    expect((await orderRow(s.orderId)).status).toBe('CONFIRMED');
  });

  it('leaves other transitions (CANCELLED) ungated by the payment rule', async () => {
    const s = await setupOrder();
    const cancel = await s.supplier.req(`/api/orders/${s.orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED' },
    });
    expect(cancel.status).toBe(200);
    expect((await orderRow(s.orderId)).status).toBe('CANCELLED');

    // Cancelling releases the reservation without touching on-hand stock.
    const inv = await inventoryRow(s.inventoryItemId);
    expect(inv.quantity).toBe(100);
    expect(inv.reserved).toBe(0);

    // The transaction stays PENDING: cancellation is not a money transition.
    const tx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(tx[0].status).toBe('PENDING');
  });
});
