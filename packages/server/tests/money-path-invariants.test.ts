import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { handlePaymentWebhook } from '../src/modules/payments/service.js';
import { computeWebhookSignature, OpenCheckoutPaymentProvider, ManualPaymentProvider } from '../src/lib/payments/providers.js';

/**
 * Money-path invariants. These are the semantic rules the platform must never
 * break, exercised against the REAL service and a real database:
 *
 *  1. Payment ≠ Settlement            — confirming payment never writes SETTLED.
 *  2. Settlement requires evidence    — only a settlement-capable provider can
 *                                       write SETTLED, and only with a matching
 *                                       amount/currency and a confirmed payment.
 *  3. Commission Earned ≠ Received    — refund reversals are book entries (PENDING).
 *  4. Refund status is independent    — refunds.status is not the ledger status.
 *  5. Demo cannot fabricate money     — the offline provider can never settle.
 *
 * The settlement webhook is delivered through the same `handlePaymentWebhook`
 * the HTTP route calls; the only difference is which provider adapter is passed,
 * which is exactly how a real acquirer is selected in production.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;
const SETTLEMENT_PROVIDER = new OpenCheckoutPaymentProvider('https://acquirer.example', 'test-key');

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
    body: { email, password: 'StrongPass123!', firstName: 'Inv', role },
  });
  expect(r.status).toBe(201);
}

async function createAdminClient() {
  const id = randomUUID();
  const email = `inv-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const password = 'AdminPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Inv Admin',
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

/** Supplier + customer + a real order (20 × 15.50 = 310.00 TND). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `inv-sup-${stamp}@wasit.tn`;
  const buyerEmail = `inv-buy-${stamp}@wasit.tn`;

  await registerUser(supplier, supplierEmail, 'SUPPLIER');
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: supplierEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: buyerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const admin = await createAdminClient();
  const buyerUserId = (buyerLogin.data.data as { id: string }).id;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Inv Test Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `INVSKU-${stamp}`,
      categoryId,
      name: `Invariant Product ${stamp}`,
      basePrice: '15.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };
  return { supplier, buyer, admin, buyerUserId, orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId };
}

async function startIntent(buyer: ReturnType<typeof makeClient>, orderId: string) {
  const r = await buyer.req(`/api/payments/orders/${orderId}/intent`, { method: 'POST', body: {} });
  expect(r.status).toBe(201);
  return r.data.data.intent as { externalRef: string; amount: string };
}

async function ledgerRows(transactionId: string) {
  return db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
}

/** Confirms the payment through the real service, using the demo provider. */
async function confirmPayment(externalRef: string, amount: string) {
  const rawBody = JSON.stringify({
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'payment.succeeded',
    externalRef,
    amount,
    currencyCode: 'TND',
  });
  return handlePaymentWebhook(db, { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) }, new ManualPaymentProvider());
}

/** Delivers settlement evidence through the real service, using an acquirer. */
async function confirmSettlement(externalRef: string, amount: string, settlementRef = 'trf-1') {
  const rawBody = JSON.stringify({
    eventId: `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'settlement.confirmed',
    externalRef,
    amount,
    currencyCode: 'TND',
    settlementRef,
  });
  return handlePaymentWebhook(db, { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) }, SETTLEMENT_PROVIDER);
}

afterAll(async () => {
  await closeDb();
});

describe('Money path — Payment ≠ Settlement', () => {
  it('never writes SETTLED when only the payment is confirmed', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);

    const applied = await confirmPayment(intent.externalRef, s.grandTotal);
    expect(applied.applied).toBe(true);

    const tx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(tx[0].status).toBe('PAID');

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.some((l) => l.status === 'SETTLED')).toBe(false);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).toBe('PAID');
    expect(order[0].settlementStatus).toBe('PENDING');
  });

  it('promotes the ledger to SETTLED only when settlement evidence arrives', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const result = await confirmSettlement(intent.externalRef, s.grandTotal, 'trf-settle-1');
    expect(result.applied).toBe(true);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'SETTLED')).toBe(true);
    expect(ledger.every((l) => l.paymentProvider === 'open-checkout')).toBe(true);

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].settlementStatus).toBe('SETTLED');

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.orderId));
    expect(audit.some((a) => a.action === 'SETTLEMENT.CONFIRMED')).toBe(true);
  });

  it('does not settle an order whose payment was never confirmed', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);

    await expect(confirmSettlement(intent.externalRef, s.grandTotal)).rejects.toThrow(/not confirmed/);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
  });

  it('rejects settlement evidence whose amount does not match the intent', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    await expect(confirmSettlement(intent.externalRef, '1.0000')).rejects.toThrow(/amount/);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
  });

  it('rejects a payment confirmation whose amount does not match the intent', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);

    await expect(confirmPayment(intent.externalRef, '1.0000')).rejects.toThrow(/amount/);

    // Creating the intent moves the order to PENDING, never to PAID.
    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).toBe('PENDING');
    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
  });
});

describe('Money path — a demo provider cannot fabricate settlement', () => {
  it('refuses a SETTLEMENT_CONFIRMED assertion from the offline provider', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const rawBody = JSON.stringify({
      eventId: `desk-set-${Date.now()}`,
      type: 'settlement.confirmed',
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      settlementRef: 'desk-1',
    });
    // The refusal is a validation error carrying a precise field message.
    const err = await handlePaymentWebhook(
      db,
      { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
      new ManualPaymentProvider(),
    ).then(
      () => null,
      (e) => e as { fieldErrors?: { field: string; message: string }[] },
    );
    expect(err).not.toBeNull();
    expect(JSON.stringify(err?.fieldErrors)).toContain('cannot assert settlement');

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
  });

  it('declares the capability flags that make the guard possible', () => {
    const manual = new ManualPaymentProvider();
    expect(manual.capabilities?.demo).toBe(true);
    expect(manual.capabilities?.settlementEvidence).toBe(false);
    const acquirer = new OpenCheckoutPaymentProvider('https://x.example', 'k');
    expect(acquirer.capabilities?.settlementEvidence).toBe(true);
    expect(acquirer.capabilities?.demo).toBe(false);
  });
});

describe('Money path — Commission Earned ≠ Received, refunds stay book entries', () => {
  it('writes a full refund as a PENDING reversal and keeps refund status independent', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const refund = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'invariant' } });
    expect(refund.status).toBe(201);
    // The refund itself completed (a business fact) …
    expect(refund.data.data.refund.status).toBe('COMPLETED');

    // … but the reversal is a book entry, not received money.
    const ledger = await ledgerRows(s.transactionId);
    const refundEntries = ledger.filter((l) => l.entryType === 'REFUND');
    expect(refundEntries.length).toBeGreaterThan(0);
    expect(refundEntries.every((l) => l.status === 'PENDING')).toBe(true);
    expect(ledger.some((l) => l.status === 'SETTLED')).toBe(false);
  });
});

describe('Money path — no implicit transitions', () => {
  it('leaves the transaction PENDING until the provider confirms it', async () => {
    const s = await setupOrder();
    const tx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(tx[0].status).toBe('PENDING');

    const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, s.orderId));
    expect(intents.length).toBe(0);
  });
});
