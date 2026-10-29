import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import {
  orders,
  paymentIntents,
  transactionLedger,
  transactions,
} from '../src/db/schema/index.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';

/**
 * PS-05 — completing an offline/`manual` payment from the operator desk.
 *
 * A `manual` rail has no signed provider callback, so before this path existed an
 * offline order sat in PENDING forever with no way out of the UI. These specs
 * exercise the real route → service → database chain and pin the security
 * boundaries: privileged-only, offline-rail-only, and no settlement conflation.
 */

const app = createApp();

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
    body: { email, password: 'StrongPass123!', firstName: 'Manual', role },
  });
  expect(r.status).toBe(201);
}

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

/** Provisions a staff actor with an explicit role, exactly as real provisioning would. */
async function createStaffClient(roleName: string) {
  const id = randomUUID();
  const email = `manual-${roleName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const password = 'StaffPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Staff',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });

  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password, allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client: c, id };
}

/** Registers a supplier + customer and creates a real order (20 × 15.50 = 310.00 TND). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await registerUser(supplier, `manual-sup-${stamp}@wasit.tn`, 'SUPPLIER');
  await registerUser(buyer, `manual-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: `manual-sup-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: `manual-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  expect(buyerLogin.status).toBe(200);
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Manual Pay Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `MANUALSKU-${stamp}`,
      categoryId,
      name: `Manual Pay Product ${stamp}`,
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

  return {
    supplier,
    buyer,
    buyerUserId,
    orderId: orderData.orderId,
    grandTotal: orderData.grandTotal,
    transactionId: orderData.transactionId,
  };
}

/** Creates a real `manual` intent for the order (moves the order to PENDING). */
async function startManualIntent(buyer: ReturnType<typeof makeClient>, orderId: string) {
  const res = await buyer.req(`/api/payments/orders/${orderId}/intent`, { method: 'POST', body: {} });
  expect(res.status).toBe(201);
  expect(res.data.data.intent.provider).toBe('manual');
  expect(res.data.data.intent.status).toBe('PENDING');
  return res.data.data.intent as { id: string; externalRef: string };
}

afterAll(() => {
  closeDb();
});

describe('PS-05 — manual/offline payment completion desk', () => {
  it('lets an operator complete a pending offline payment (payment only, never settlement)', async () => {
    const s = await setupOrder();
    const intent = await startManualIntent(s.buyer, s.orderId);
    const admin = await createStaffClient('ADMIN');

    const done = await admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(done.data.data.paymentStatus).toBe('PAID');
    expect(done.data.data.provider).toBe('manual');

    // The order is PAID on the payment axis…
    const order = (await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1))[0];
    expect(order.paymentStatus).toBe('PAID');

    // …but the ledger is NOT settled: a confirmed payment ≠ a settled one. This is
    // the invariant that must survive a manual completion.
    const tx = (await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1))[0];
    expect(tx.status).toBe('PAID');
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((e) => e.status === 'PENDING')).toBe(true);

    // The intent is SUCCEEDED and the buyer's payment record is PAID.
    const intentRow = (await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).limit(1))[0];
    expect(intentRow.status).toBe('SUCCEEDED');

    // Audit: the transition is attributed to the buyer, and the operator's action
    // is recorded separately so "who completed this offline payment" is answerable.
    const successLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'ORDER'), eq(auditLogs.entityId, s.orderId), eq(auditLogs.action, 'PAYMENT.SUCCEEDED')));
    expect(successLogs.length).toBe(1);
    expect(successLogs[0].actorId).toBe(s.buyerUserId);

    const manualLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'ORDER'), eq(auditLogs.entityId, s.orderId), eq(auditLogs.action, 'PAYMENT.MANUAL_COMPLETE')));
    expect(manualLogs.length).toBe(1);
    expect(manualLogs[0].actorId).toBe(admin.id);
  });

  it('is refused for the order parties and for staff without the money permission', async () => {
    const s = await setupOrder();
    await startManualIntent(s.buyer, s.orderId);

    // The buyer who owns the order still cannot self-attest payment.
    const asBuyer = await s.buyer.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(asBuyer.status).toBe(403);

    // SUPPORT holds no refund:manage / payment write permission.
    const support = await createStaffClient('SUPPORT');
    const asSupport = await support.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(asSupport.status).toBe(403);

    // Unauthenticated is rejected before any service work.
    const anon = makeClient();
    const asAnon = await anon.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(asAnon.status).toBe(401);

    // Nothing moved.
    const order = (await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1))[0];
    expect(order.paymentStatus).toBe('PENDING');
  });

  it('rejects a second completion of the same order (409)', async () => {
    const s = await setupOrder();
    await startManualIntent(s.buyer, s.orderId);
    const admin = await createStaffClient('ADMIN');

    const first = await admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(first.status).toBe(200);

    const second = await admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(second.status).toBe(409);
  });

  it('rejects completing an order with no payment in progress (409) and an unknown order (404)', async () => {
    const s = await setupOrder(); // no intent yet → paymentStatus UNPAID
    const admin = await createStaffClient('ADMIN');

    const noIntent = await admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(noIntent.status).toBe(409);

    const unknown = await admin.client.req(`/api/payments/orders/${randomUUID()}/complete-manual`, { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('refuses to complete a payment on a rail that must confirm via webhook (422)', async () => {
    const s = await setupOrder();
    // An intent on a real acquirer rail: only its signed webhook may confirm it.
    await db.insert(paymentIntents).values({
      id: randomUUID(),
      orderId: s.orderId,
      transactionId: s.transactionId,
      amount: s.grandTotal,
      currencyCode: 'TND',
      provider: 'flouci',
      idempotencyKey: `fl-${s.orderId}`,
      externalRef: `flref_${s.orderId}`,
      status: 'PENDING',
    });
    await db.update(orders).set({ paymentStatus: 'PENDING' }).where(eq(orders.id, s.orderId));

    const admin = await createStaffClient('ADMIN');
    const res = await admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' });
    expect(res.status).toBe(422);

    const order = (await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1))[0];
    expect(order.paymentStatus).toBe('PENDING');
  });

  it('cannot fabricate a payment on a live stack: the manual rail is refused outside demo mode (503)', async () => {
    const s = await setupOrder();
    await startManualIntent(s.buyer, s.orderId);
    const admin = await createStaffClient('ADMIN');

    // NODE_ENV=production makes `resolvePaymentProvider()` refuse the demo
    // harness, so the desk cannot self-attest a payment on a real deployment.
    const res = await withEnv({ NODE_ENV: 'production', DEMO_PAYMENT_MODE: true }, () =>
      admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' }),
    );
    expect(res.status).toBe(503);

    const order = (await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1))[0];
    expect(order.paymentStatus).toBe('PENDING');
  });

  it('serialises concurrent completions: exactly one succeeds, the rest are refused', async () => {
    const s = await setupOrder();
    await startManualIntent(s.buyer, s.orderId);
    const admin = await createStaffClient('ADMIN');

    // Fire many completions at once. The row lock must let exactly one through;
    // without it every request reads PENDING and each applies the transition,
    // writing duplicate PAYMENT.SUCCEEDED entries.
    const N = 24;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        admin.client.req(`/api/payments/orders/${s.orderId}/complete-manual`, { method: 'POST' }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(N - 1);

    const successLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'ORDER'), eq(auditLogs.entityId, s.orderId), eq(auditLogs.action, 'PAYMENT.SUCCEEDED')));
    expect(successLogs.length).toBe(1);

    const manualLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'ORDER'), eq(auditLogs.entityId, s.orderId), eq(auditLogs.action, 'PAYMENT.MANUAL_COMPLETE')));
    expect(manualLogs.length).toBe(1);

    // The ledger still never settled, despite the burst.
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.every((e) => e.status === 'PENDING')).toBe(true);
  });
});
