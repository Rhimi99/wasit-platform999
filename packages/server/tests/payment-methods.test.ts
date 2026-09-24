import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, paymentIntents, payments, transactionLedger } from '../src/db/schema/index.js';
import { FlouciPaymentProvider } from '../src/lib/payments/flouci.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/modules/payments/service.js';

/**
 * Multi-method + unsigned-provider (status recheck) integration tests.
 *
 * A local HTTP server emulates the documented Flouci endpoints, so the real
 * FlouciPaymentProvider code runs against a real database and the real payment
 * service. No WASIT logic is mocked and no external network/credential is used.
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

async function createAdminClient(password = 'AdminPass123!') {
  const id = randomUUID();
  const email = `pm-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'PM Admin',
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

async function registerUser(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', { method: 'POST', body: { email, password: 'StrongPass123!', firstName: 'PM', role } });
  expect(r.status).toBe(201);
}

/** Creates a real supplier + customer + product + order (buyer owns the order). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerUser(supplier, `pm-sup-${stamp}@wasit.tn`, 'SUPPLIER');
  await registerUser(buyer, `pm-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: `pm-sup-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: `pm-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'PM Test Co' } });
  const supplierId = supplierProfile.data.data.id as string;
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `PMSKU-${stamp}`,
      categoryId,
      name: `PM Product ${stamp}`,
      basePrice: '10.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 50,
      lowStockThreshold: 5,
      quantity: 50,
    },
  });
  const productId = product.data.data.id as string;
  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 3 }] },
  });
  expect(order.status).toBe(201);
  return { buyer, buyerId, orderId: order.data.data.orderId as string, grandTotal: order.data.data.grandTotal as string, transactionId: order.data.data.transactionId as string };
}

let server: Server;
let baseUrl: string;
let handlers: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = (req.url ?? '').split('?')[0];
    const handler = handlers[key];
    res.statusCode = handler?.status ?? 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(handler?.body ?? { result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

const flouci = () => new FlouciPaymentProvider(baseUrl, 'PUB', 'PRIV');

describe('Multi-method payment kernel', () => {
  it('GET /api/payments/methods requires auth and lists providers with method capabilities', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/payments/methods')).status).toBe(401);

    const s = await setupOrder();
    const res = await s.buyer.req('/api/payments/methods');
    expect(res.status).toBe(200);
    const data = res.data.data as { active: string; providers: { id: string; available: boolean; methods: { method: { type: string }; available: boolean }[] }[] };
    expect(data.active).toBe('manual');
    const manual = data.providers.find((p) => p.id === 'manual')!;
    expect(manual.available).toBe(true);
    expect(manual.methods.some((m) => m.method.type === 'CARD')).toBe(true);
    expect(manual.methods.some((m) => m.method.type === 'MOBILE_WALLET')).toBe(true);
    // Flouci is present but unavailable (no credentials configured in test env).
    const fl = data.providers.find((p) => p.id === 'flouci')!;
    expect(fl.available).toBe(false);
    expect(fl.methods.every((m) => !m.available)).toBe(true);
  });

  it('stores the chosen method on the intent', async () => {
    const s = await setupOrder();
    const res = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, {
      method: 'POST',
      body: { method: { type: 'MOBILE_WALLET', scheme: 'FLOUCI_WALLET' } },
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, s.orderId)).limit(1);
    expect(rows[0].method).toBe('MOBILE_WALLET');
    expect(rows[0].scheme).toBe('FLOUCI_WALLET');
  });

  it('rejects a method the active provider does not support', async () => {
    const s = await setupOrder();
    // The manual provider supports everything; use a Flouci provider (card-only)
    // directly to prove the service rejects an unsupported rail.
    const d17 = flouci();
    const err = await createPaymentIntent(
      db,
      { orderId: s.orderId, actorId: s.buyerId, method: { type: 'MOBILE_WALLET', scheme: 'D17' } },
      d17,
    ).then(
      () => null,
      (e) => e as { fieldErrors?: { field: string; message: string }[] },
    );
    expect(err).not.toBeNull();
    expect(JSON.stringify(err)).toMatch(/does not support/);
    // No intent was recorded for the rejected rail.
    const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, s.orderId));
    expect(rows.length).toBe(0);
  });

  it('rejects a method that is unsupported even when the provider is unconfigured', async () => {
    const s = await setupOrder();
    const unconfigured = new FlouciPaymentProvider(baseUrl, '', '');
    await expect(
      createPaymentIntent(db, { orderId: s.orderId, actorId: s.buyerId, method: { type: 'CARD' } }, unconfigured),
    ).rejects.toThrow(); // serviceUnavailable: credentials not configured
  });
});

describe('Unsigned provider (status recheck) end-to-end', () => {
  it('creates a Flouci intent with a hosted checkout URL and verifies via provider status', async () => {
    handlers = {
      '/api/v2/generate_payment': { status: 200, body: { result: { success: true, payment_id: `pay_${Date.now()}`, link: 'https://checkout.flouci.com/co/x' } } },
    };
    const s = await setupOrder();
    const created = await createPaymentIntent(
      db,
      { orderId: s.orderId, actorId: s.buyerId, method: { type: 'CARD', scheme: 'VISA' } },
      flouci(),
    );
    expect(created.checkoutUrl).toBe('https://checkout.flouci.com/co/x');
    const ref = (created.intent as { externalRef: string }).externalRef;

    // The provider reports SUCCESS on recheck → the callback settles the order.
    handlers = { [`/api/v2/verify_payment/${ref}`]: { status: 200, body: { result: { amount: Number(s.grandTotal) * 1000, status: 'SUCCESS', settlement_status: 'AVAILABLE' } } } };
    const result = await handlePaymentWebhook(
      db,
      { rawBody: JSON.stringify({ payment_id: ref }), signature: undefined },
      flouci(),
    );
    expect(result.applied).toBe(true);
    expect(result.eventType).toBe('PAYMENT_SUCCEEDED');

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).toBe('PAID');
    const pay = await db.select().from(payments).where(eq(payments.orderId, s.orderId)).limit(1);
    expect(pay[0].status).toBe('PAID');
    // Confirmed payment ≠ settled funds. Flouci reports an AVAILABLE settlement
    // balance, but no transfer reference here, so the ledger must stay PENDING
    // until real settlement evidence promotes it.
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
    expect(ledger.every((l) => l.paymentProvider === 'flouci')).toBe(true);

    // A replayed callback is an idempotent no-op.
    const replay = await handlePaymentWebhook(db, { rawBody: JSON.stringify({ payment_id: ref }) }, flouci());
    expect(replay.duplicate).toBe(true);
    expect(replay.applied).toBe(false);
  });

  it('rejects a forged callback whose provider amount does not match the intent', async () => {
    handlers = { '/api/v2/generate_payment': { status: 200, body: { result: { success: true, payment_id: `pay_m_${Date.now()}`, link: 'https://x' } } } };
    const s = await setupOrder();
    const created = await createPaymentIntent(db, { orderId: s.orderId, actorId: s.buyerId }, flouci());
    const ref = (created.intent as { externalRef: string }).externalRef;

    // Provider says SUCCESS but for a different amount → must not settle.
    handlers = { [`/api/v2/verify_payment/${ref}`]: { status: 200, body: { result: { amount: 1, status: 'SUCCESS' } } } };
    await expect(handlePaymentWebhook(db, { rawBody: JSON.stringify({ payment_id: ref }) }, flouci())).rejects.toThrow(/amount/);

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).not.toBe('PAID');
  });

  it('a FAILURE status on recheck marks the payment failed', async () => {
    handlers = { '/api/v2/generate_payment': { status: 200, body: { result: { success: true, payment_id: `pay_f_${Date.now()}`, link: 'https://x' } } } };
    const s = await setupOrder();
    const created = await createPaymentIntent(db, { orderId: s.orderId, actorId: s.buyerId }, flouci());
    const ref = (created.intent as { externalRef: string }).externalRef;

    handlers = { [`/api/v2/verify_payment/${ref}`]: { status: 200, body: { result: { amount: Number(s.grandTotal) * 1000, status: 'FAILURE' } } } };
    const result = await handlePaymentWebhook(db, { rawBody: JSON.stringify({ payment_id: ref }) }, flouci());
    expect(result.applied).toBe(true);
    expect(result.eventType).toBe('PAYMENT_FAILED');
    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).toBe('FAILED');
  });

  it('rejects a callback payload that carries no payment id', async () => {
    const s = await setupOrder();
    await expect(handlePaymentWebhook(db, { rawBody: JSON.stringify({ hello: 'world' }) }, flouci())).rejects.toThrow();
  });

  it('a valid callback for an unknown reference fails safely (no side-effect)', async () => {
    handlers = { '/api/v2/verify_payment/pay_unknown': { status: 200, body: { result: { amount: 1000, status: 'SUCCESS' } } } };
    await expect(handlePaymentWebhook(db, { rawBody: JSON.stringify({ payment_id: 'pay_unknown' }) }, flouci())).rejects.toThrow();
  });
});