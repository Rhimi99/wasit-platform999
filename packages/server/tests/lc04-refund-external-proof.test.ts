import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, payments, refunds, transactionLedger } from '../src/db/schema/index.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import { completeRefundWithEvidence } from '../src/modules/payments/service.js';

/**
 * LC-04 — Refund financial integrity: a refund is only financially successful
 * on *external proof*.
 *
 * These specs run the real HTTP stack and the real database against the offline
 * `manual` provider. That provider is a demonstration harness, so it can never
 * prove money moved — which is exactly what makes it the right witness for the
 * fail-closed rule:
 *
 *  - a refund request never completes on the provider's local "success" alone;
 *  - a signature-verified `refund.succeeded` webhook from a demo provider is
 *    refused, not trusted;
 *  - the refund completes only when trusted external evidence (the acquirer's
 *    own refund API / webhook, correlated to this refund) is supplied;
 *  - evidence of a different amount or currency is rejected and moves nothing.
 *
 * The suite needs Postgres only because the refund rail writes ledger rows and
 * order state; it spins up no external service and contacts no acquirer.
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
    body: { email, password: 'StrongPass123!', firstName: 'LC04', role },
  });
  expect(r.status).toBe(201);
}

async function createAdminClient(password = 'AdminPass123!') {
  const id = randomUUID();
  const email = `lc04-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'LC04 Admin',
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

/** Supplier + customer + a real order, paid through a signed payment webhook. */
async function setupPaidOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await registerUser(supplier, `lc04-sup-${stamp}@wasit.tn`, 'SUPPLIER');
  await registerUser(buyer, `lc04-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: `lc04-sup-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: `lc04-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const admin = await createAdminClient();
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'LC04 Co' } });
  const supplierId = supplierProfile.data.data.id as string;
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `LC04SKU-${stamp}`,
      categoryId,
      name: `LC04 Product ${stamp}`,
      basePrice: '15.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  const productId = product.data.data.id as string;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
  });
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  const intent = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  const externalRef = intent.data.data.intent.externalRef as string;
  await postWebhook({ eventId: `lc04-pay-${stamp}`, type: 'payment.succeeded', externalRef });

  return { supplier, buyer, admin, orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId };
}

async function postWebhook(body: Record<string, unknown>, signature?: string) {
  const rawBody = JSON.stringify(body);
  const sig = signature ?? computeWebhookSignature(rawBody, WEBHOOK_SECRET);
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
  return { res, data: data as any, status: res.status };
}

/** The acquirer's verified evidence that this exact reversal moved. */
function evidenceFor(refundId: string, amount: string, currencyCode = 'TND') {
  return { source: 'PROVIDER_WEBHOOK' as const, providerId: 'open-checkout', externalRef: `acq-${refundId}`, amount, currencyCode };
}

afterAll(() => {
  closeDb();
});

describe('LC-04 — refund is only financially successful on external proof', () => {
  it('an offline provider cannot complete a refund: no ledger, no REFUNDED order', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'customer request' } });
    expect(created.status).toBe(201);
    expect(created.data.data.refund.status).toBe('REQUESTED');

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    expect(orderRow[0].refundStatus).not.toBe('COMPLETED');

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.filter((l) => l.entryType === 'REFUND').length).toBe(0);
  });

  it('refuses a signature-verified refund webhook from a demo provider', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'webhook proof attempt' } });
    const refundId = created.data.data.refund.id as string;

    // A `manual` refund.succeeded webhook is correctly signed, yet proves nothing.
    const hook = await postWebhook({ eventId: `lc04-rw-${Date.now()}`, type: 'refund.succeeded', externalRef: `acq-${refundId}` });
    expect(hook.status).toBe(422);

    const refundRow = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
    expect(refundRow[0].status).toBe('REQUESTED');
    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
  });

  it('completes the refund only with trusted external evidence', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'verified reversal' } });
    const refundId = created.data.data.refund.id as string;

    const result = await completeRefundWithEvidence(db, refundId, evidenceFor(refundId, s.grandTotal), { actorId: null });
    expect(result.completed).toBe(true);

    const refundRow = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
    expect(refundRow[0].status).toBe('COMPLETED');

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('REFUNDED');
    expect(orderRow[0].refundStatus).toBe('COMPLETED');

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const refundEntries = ledger.filter((l) => l.entryType === 'REFUND');
    expect(refundEntries.length).toBe(1);
    expect(refundEntries[0].direction).toBe('DEBIT');
    expect(refundEntries[0].status).toBe('PENDING');
  });

  it('rejects evidence whose amount does not match the refund and moves nothing', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'mismatch' } });
    const refundId = created.data.data.refund.id as string;

    await expect(
      completeRefundWithEvidence(db, refundId, evidenceFor(refundId, '1.0000'), { actorId: null }),
    ).rejects.toThrow();

    const refundRow = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
    expect(refundRow[0].status).toBe('REQUESTED');
    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
  });

  it('is idempotent: completing twice writes a single reversal', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'idempotent' } });
    const refundId = created.data.data.refund.id as string;

    const first = await completeRefundWithEvidence(db, refundId, evidenceFor(refundId, s.grandTotal), { actorId: null });
    expect(first.completed).toBe(true);
    const second = await completeRefundWithEvidence(db, refundId, evidenceFor(refundId, s.grandTotal), { actorId: null });
    expect(second.reused).toBe(true);

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.filter((l) => l.entryType === 'REFUND').length).toBe(1);
  });

  it('records the proof source in the audit trail, not just the outcome', async () => {
    const s = await setupPaidOrder();
    const created = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'audit' } });
    const refundId = created.data.data.refund.id as string;
    await completeRefundWithEvidence(db, refundId, evidenceFor(refundId, s.grandTotal), { actorId: null });

    const { auditLogs } = await import('../src/db/schema/audit.js');
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'REFUND.COMPLETED'));
    const row = rows.find((r) => (r.after as { refundId?: string } | null)?.refundId === refundId);
    expect(row).toBeTruthy();
    const after = row!.after as Record<string, unknown>;
    expect(after.evidenceSource).toBe('PROVIDER_WEBHOOK');
    expect(after.evidenceRef).toBe(`acq-${refundId}`);
    expect(after.evidenceVerified).toBe(true);
  });
});
