import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { handlePaymentWebhook } from '../src/modules/payments/service.js';
import { confirmSettlement } from '../src/modules/settlements/service.js';
import { computeWebhookSignature, OpenCheckoutPaymentProvider, ManualPaymentProvider } from '../src/lib/payments/providers.js';

/**
 * PS-01 — Settlement Ledger.
 *
 * Proves that the settlement layer is the only thing that can move the ledger to
 * SETTLED and that a real `SETTLEMENT` ledger entry exists — created only behind
 * valid, reference-carrying evidence, exactly once, atomically, and never from a
 * payment confirmation alone.
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
    body: { email, password: 'StrongPass123!', firstName: 'Set', role },
  });
  expect(r.status).toBe(201);
}

async function createAdminClient() {
  const id = randomUUID();
  const email = `set-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const password = 'AdminPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Set Admin',
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

/** Supplier + customer + a real order (20 × 15.50 = 310.00 TND; grandTotal 322.40). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `set-sup-${stamp}@wasit.tn`;
  const buyerEmail = `set-buy-${stamp}@wasit.tn`;

  await registerUser(supplier, supplierEmail, 'SUPPLIER');
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: supplierEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: buyerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const admin = await createAdminClient();
  const buyerUserId = (buyerLogin.data.data as { id: string }).id;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Set Test Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `SETSKU-${stamp}`,
      categoryId,
      name: `Settlement Product ${stamp}`,
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

async function ledgerRows(transactionId: string) {
  return db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
}

afterAll(async () => {
  await closeDb();
});

describe('PS-01 — settlement ledger requires evidence', () => {
  it('PAID alone never produces SETTLED and never creates a SETTLEMENT entry', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.some((l) => l.status === 'SETTLED')).toBe(false);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].paymentStatus).toBe('PAID');
    expect(order[0].settlementStatus).toBe('PENDING');
  });

  it('rejects a settlement transition without a settlementRef', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const err = await confirmSettlement(db, {
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      providerId: 'open-checkout',
      settlementRef: '   ',
    }).then(
      () => null,
      (e) => e as { fieldErrors?: { field: string; message: string }[] },
    );
    expect(err).not.toBeNull();
    expect(JSON.stringify(err?.fieldErrors)).toContain('reference');

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);
  });

  it('rejects settlement on an order whose payment was never confirmed', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);

    await expect(
      confirmSettlement(db, {
        externalRef: intent.externalRef,
        amount: s.grandTotal,
        currencyCode: 'TND',
        providerId: 'open-checkout',
        settlementRef: 'trf-unpaid',
      }),
    ).rejects.toThrow(/not confirmed/);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);
  });

  it('writes exactly one SETTLEMENT entry with a valid reference, and is idempotent on replay', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const first = await confirmSettlement(db, {
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      providerId: 'open-checkout',
      settlementRef: 'trf-settle-1',
      providerRef: 'acq-1',
    });
    expect(first.applied).toBe(true);
    expect(first.duplicate).toBe(false);

    const ledger = await ledgerRows(s.transactionId);
    const settlements = ledger.filter((l) => l.entryType === 'SETTLEMENT');
    expect(settlements.length).toBe(1);
    expect(settlements[0].status).toBe('SETTLED');
    expect(settlements[0].currencyCode).toBe('TND');
    expect((settlements[0].metadata as { settlementRef?: string }).settlementRef).toBe('trf-settle-1');
    expect(ledger.filter((l) => l.entryType !== 'SETTLEMENT').every((l) => l.status === 'SETTLED')).toBe(true);

    const order = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(order[0].settlementStatus).toBe('SETTLED');

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.orderId));
    expect(audit.filter((a) => a.action === 'SETTLEMENT.CONFIRMED').length).toBe(1);

    // Replay of the identical evidence is a no-op — no second entry, no second audit.
    const replay = await confirmSettlement(db, {
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      providerId: 'open-checkout',
      settlementRef: 'trf-settle-1',
    });
    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);

    const after = await ledgerRows(s.transactionId);
    expect(after.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(1);
    const auditAfter = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.orderId));
    expect(auditAfter.filter((a) => a.action === 'SETTLEMENT.CONFIRMED').length).toBe(1);
  });

  it('rejects a second settlement carrying a different reference', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);
    await confirmSettlement(db, {
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      providerId: 'open-checkout',
      settlementRef: 'trf-a',
    });

    await expect(
      confirmSettlement(db, {
        externalRef: intent.externalRef,
        amount: s.grandTotal,
        currencyCode: 'TND',
        providerId: 'open-checkout',
        settlementRef: 'trf-b',
      }),
    ).rejects.toThrow(/different reference/);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(1);
  });

  it('rejects amount and currency mismatches, leaving the ledger untouched', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    await expect(
      confirmSettlement(db, {
        externalRef: intent.externalRef,
        amount: '1.0000',
        currencyCode: 'TND',
        providerId: 'open-checkout',
        settlementRef: 'trf-bad-amount',
      }),
    ).rejects.toThrow(/amount/);

    await expect(
      confirmSettlement(db, {
        externalRef: intent.externalRef,
        amount: s.grandTotal,
        currencyCode: 'EUR',
        providerId: 'open-checkout',
        settlementRef: 'trf-bad-currency',
      }),
    ).rejects.toThrow(/currency/);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);
  });
});

describe('PS-01 — settlement stays fee-gated by provider capability', () => {
  it('a provider without settlementEvidence cannot cause a SETTLEMENT entry', async () => {
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
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);
  });

  it('promotes the ledger through the settlement-capable provider webhook', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);

    const rawBody = JSON.stringify({
      eventId: `acq-set-${Date.now()}`,
      type: 'settlement.confirmed',
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
      settlementRef: 'trf-webhook-1',
      occurredAt: new Date().toISOString(),
    });
    const result = await handlePaymentWebhook(
      db,
      { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
      SETTLEMENT_PROVIDER,
    );
    expect(result.applied).toBe(true);

    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(1);
    expect(ledger.filter((l) => l.entryType !== 'SETTLEMENT').every((l) => l.status === 'SETTLED')).toBe(true);
  });
});

describe('PS-01 — no party writes SETTLED outside the settlement service', () => {
  it('the payment webhook path cannot produce a SETTLEMENT entry', async () => {
    const s = await setupOrder();
    const intent = await startIntent(s.buyer, s.orderId);
    await confirmPayment(intent.externalRef, s.grandTotal);
    const rawBody = JSON.stringify({
      eventId: `evt-again-${Date.now()}`,
      type: 'payment.succeeded',
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
    });
    await handlePaymentWebhook(db, { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) }, new ManualPaymentProvider());

    const tx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(tx[0].status).toBe('PAID');
    const ledger = await ledgerRows(s.transactionId);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT').length).toBe(0);
  });
});
