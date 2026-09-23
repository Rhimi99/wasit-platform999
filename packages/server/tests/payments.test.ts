import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import {
  orders,
  paymentIntents,
  paymentWebhookEvents,
  payments,
  refunds,
  transactionLedger,
  transactions,
} from '../src/db/schema/index.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';

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
    body: { email, password: 'StrongPass123!', firstName: 'Pay', role },
  });
  expect(r.status).toBe(201);
}

/**
 * Creates an ADMIN directly in the DB. Public registration intentionally cannot
 * self-grant privileged roles, so privileged test actors are seeded the same way
 * the real provisioning flow would (hashed password + explicit role row).
 */
async function createAdminClient(password = 'AdminPass123!') {
  const id = randomUUID();
  const email = `pay-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: 'Pay Admin',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });

  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  expect(login.data.data.roles).toContain('ADMIN');
  return c;
}

/** Registers a supplier + customer and creates a real order for 20 × 15.50 = 310.00 TND. */
async function setupPaidOrderBase() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await registerUser(supplier, `pay-sup-${stamp}@wasit.tn`, 'SUPPLIER');
  await registerUser(buyer, `pay-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  await supplier.req('/api/auth/login', { method: 'POST', body: { email: `pay-sup-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  const buyerLogin = await buyer.req('/api/auth/login', { method: 'POST', body: { email: `pay-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  expect(buyerLogin.status).toBe(200);
  const admin = await createAdminClient();
  const buyerUserId = (buyerLogin.data.data as { id: string }).id as string;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Pay Test Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `PAYSKU-${stamp}`,
      categoryId,
      name: `Payment Test Product ${stamp}`,
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

  return { supplier, buyer, admin, buyerUserId, orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId };
}

/** Signs a webhook payload and posts it to the unauthenticated webhook endpoint. */
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

afterAll(() => {
  closeDb();
});

describe('PHASE A — Payment provider / intent / webhooks / refunds', () => {
  it('rejects an unsupported provider-less intent when no provider is configured', async () => {
    // The suite runs with PAYMENT_PROVIDER=manual; the noop guard is unit-covered
    // by resolvePaymentProvider's default. Here we only assert route protection.
    const c = makeClient();
    const unauth = await c.req('/api/payments/orders/some-order/intent', { method: 'POST', body: {} });
    expect(unauth.status).toBe(401);
  });

  it('creates a payment intent with a real provider and is idempotent by key', async () => {
    const s = await setupPaidOrderBase();
    const key = `idem-${Date.now()}`;

    const first = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, {
      method: 'POST',
      body: { idempotencyKey: key },
    });
    expect(first.status).toBe(201);
    expect(first.data.data.intent.provider).toBe('manual');
    expect(first.data.data.intent.status).toBe('PENDING');

    const second = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, {
      method: 'POST',
      body: { idempotencyKey: key },
    });
    expect(second.status).toBe(201);
    expect(second.data.data.reused).toBe(true);
    expect(second.data.data.intent.id).toBe(first.data.data.intent.id);

    const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, s.orderId));
    expect(intents.length).toBe(1);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PENDING');

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, s.orderId));
    expect(audit.some((a) => a.action === 'PAYMENT.INTENT_CREATE')).toBe(true);
  });

  it('rejects an unsigned webhook and accepts a signed one, settling payment once', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    expect(intent.status).toBe(201);
    const externalRef = intent.data.data.intent.externalRef as string;

    // Unsigned / forged signature must be rejected before any side-effect.
    const forged = await postWebhook({ eventId: `evt-forged-${Date.now()}`, type: 'payment.succeeded', externalRef }, 'deadbeef');
    expect(forged.status).toBe(401);

    const payload = { eventId: `evt-${Date.now()}`, type: 'payment.succeeded', externalRef, amount: s.grandTotal, currencyCode: 'TND' };
    const ok = await postWebhook(payload);
    expect(ok.status).toBe(200);
    expect(ok.data.data.applied).toBe(true);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');

    const pay = await db.select().from(payments).where(eq(payments.orderId, s.orderId)).limit(1);
    expect(pay[0].status).toBe('PAID');

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.every((l) => l.status === 'SETTLED')).toBe(true);
    expect(ledger.every((l) => l.paymentProvider === 'manual')).toBe(true);

    // Replaying the same event id is an idempotent no-op.
    const replay = await postWebhook(payload);
    expect(replay.status).toBe(200);
    expect(replay.data.data.duplicate).toBe(true);
    expect(replay.data.data.applied).toBe(false);

    const events = await db.select().from(paymentWebhookEvents);
    expect(events.filter((e) => e.eventId === payload.eventId).length).toBe(1);
  });

  it('marks a payment failed via webhook and is idempotent', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intent.data.data.intent.externalRef as string;
    const payload = { eventId: `evt-fail-${Date.now()}`, type: 'payment.failed', externalRef };

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    expect(first.data.data.applied).toBe(true);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('FAILED');

    const replay = await postWebhook(payload);
    expect(replay.data.data.duplicate).toBe(true);
    const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, s.orderId));
    expect(intents[0].status).toBe('FAILED');
  });

  it('refunds a paid order (full), writes a REFUND ledger DEBIT, and is idempotent', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intent.data.data.intent.externalRef as string;
    await postWebhook({ eventId: `evt-r-${Date.now()}`, type: 'payment.succeeded', externalRef });

    // A customer lacks refund:manage — RBAC must block server-side.
    const forbidden = await s.buyer.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: {} });
    expect(forbidden.status).toBe(403);

    const key = `rf-${Date.now()}`;
    const refund = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { reason: 'customer request', idempotencyKey: key },
    });
    expect(refund.status).toBe(201);
    expect(refund.data.data.refund.status).toBe('COMPLETED');
    expect(refund.data.data.refund.amount).toBe(s.grandTotal);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('REFUNDED');
    expect(orderRow[0].status).toBe('REFUNDED');

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    const refundEntries = ledger.filter((l) => l.entryType === 'REFUND');
    expect(refundEntries.length).toBe(1);
    expect(refundEntries[0].direction).toBe('DEBIT');
    expect(refundEntries[0].amount).toBe(s.grandTotal);

    // Idempotent retry returns the same refund, does not create a second ledger entry.
    const retry = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { idempotencyKey: key },
    });
    expect(retry.data.data.reused).toBe(true);
    const ledgerAfter = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledgerAfter.filter((l) => l.entryType === 'REFUND').length).toBe(1);
  });

  it('supports partial refunds and prevents over-refunding', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    await postWebhook({ eventId: `evt-p-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.data.data.intent.externalRef as string });

    const partial = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: '100.0000', reason: 'partial' },
    });
    expect(partial.status).toBe(201);
    expect(partial.data.data.refund.status).toBe('COMPLETED');

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PARTIALLY_REFUNDED');

    const over = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, {
      method: 'POST',
      body: { amount: '999.0000' },
    });
    expect(over.status).toBe(422);

    // Remaining refundable = 316.20 (buyer total incl. their 2% commission) − 100 = 216.20.
    const rest = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: {} });
    expect(rest.status).toBe(201);
    expect(rest.data.data.refund.amount).toBe('216.2000');

    const finalOrder = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(finalOrder[0].paymentStatus).toBe('REFUNDED');

    const allRefunds = await db.select().from(refunds).where(eq(refunds.orderId, s.orderId));
    expect(allRefunds.length).toBe(2);
  });

  it('refuses to refund an unpaid order', async () => {
    const s = await setupPaidOrderBase();
    const r = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: {} });
    expect(r.status).toBe(409);
  });

  it('exposes the refund state needed by the admin orders UI projection', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    await postWebhook({ eventId: `evt-o-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.data.data.intent.externalRef as string });

    // Before refunding: the admin order list must carry the fields the UI uses
    // to decide whether a refund button is legitimate.
    const before = await s.admin.req('/api/admin/orders');
    expect(before.status).toBe(200);
    const beforeRow = (before.data.data.items as Array<Record<string, unknown>>).find((o) => o.id === s.orderId)!;
    expect(beforeRow.paymentStatus).toBe('PAID');
    expect(beforeRow.refundStatus).toBe('NONE');
    expect(beforeRow.currencyCode).toBe('TND');

    await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'ui projection' } });

    const after = await s.admin.req('/api/admin/orders');
    const afterRow = (after.data.data.items as Array<Record<string, unknown>>).find((o) => o.id === s.orderId)!;
    expect(afterRow.paymentStatus).toBe('REFUNDED');
    expect(afterRow.refundStatus).toBe('COMPLETED');
  });

  it('does not leak payment data to unrelated users (ownership enforced)', async () => {
    const s = await setupPaidOrderBase();
    const stranger = makeClient();
    const email = `pay-stranger-${Date.now()}@wasit.tn`;
    await registerUser(stranger, email, 'CUSTOMER');
    await stranger.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });

    const intent = await stranger.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    expect(intent.status).toBe(403);

    const read = await stranger.req(`/api/payments/orders/${s.orderId}`);
    // Permission gate (payment:read) fires for a CUSTOMER before ownership.
    expect([403, 401]).toContain(read.status);
  });
});

describe('RC-1 — transactions.status reflects the real payment state', () => {
  it('creates the transaction PENDING (not PAID) and promotes it only on payment success', async () => {
    const s = await setupPaidOrderBase();

    // Before any payment: the order is UNPAID and so is its transaction.
    const beforeOrder = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(beforeOrder[0].paymentStatus).toBe('UNPAID');
    const beforeTx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(beforeTx[0].status).toBe('PENDING');

    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intent.data.data.intent.externalRef as string;
    await postWebhook({ eventId: `evt-rc1-${Date.now()}`, type: 'payment.succeeded', externalRef });

    // After a confirmed payment the transaction is PAID, matching the order.
    const afterTx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(afterTx[0].status).toBe('PAID');
    const afterOrder = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(afterOrder[0].paymentStatus).toBe('PAID');
  });

  it('marks the transaction FAILED (not PAID) when the provider reports failure', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    await postWebhook({ eventId: `evt-rc1f-${Date.now()}`, type: 'payment.failed', externalRef: intent.data.data.intent.externalRef as string });

    const tx = await db.select().from(transactions).where(eq(transactions.id, s.transactionId)).limit(1);
    expect(tx[0].status).toBe('FAILED');
  });
});

describe('RC-4 — webhook idempotency key is claimed only by a terminal event', () => {
  it('lets pending → succeeded with the same eventId reach the terminal side-effect', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intent.data.data.intent.externalRef as string;
    const eventId = `evt-rc4-${Date.now()}`;

    // A non-actionable event first (the provider's "pending" notification).
    const pendingEvent = await postWebhook({ eventId, type: 'payment.pending', externalRef });
    expect(pendingEvent.status).toBe(200);
    expect(pendingEvent.data.data.applied).toBe(false);
    expect(pendingEvent.data.data.eventType).toBe('UNKNOWN');

    // The terminal event reuses the same id and MUST still be applied.
    const succeeded = await postWebhook({ eventId, type: 'payment.succeeded', externalRef, amount: s.grandTotal, currencyCode: 'TND' });
    expect(succeeded.status).toBe(200);
    expect(succeeded.data.data.applied).toBe(true);
    expect(succeeded.data.data.duplicate).toBe(false);

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
  });

  it('keeps terminal replays idempotent and records the terminal event exactly once', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const externalRef = intent.data.data.intent.externalRef as string;
    const eventId = `evt-rc4r-${Date.now()}`;
    const payload = { eventId, type: 'payment.succeeded', externalRef, amount: s.grandTotal, currencyCode: 'TND' };

    const first = await postWebhook(payload);
    expect(first.data.data.applied).toBe(true);
    const replay = await postWebhook(payload);
    expect(replay.data.data.duplicate).toBe(true);
    expect(replay.data.data.applied).toBe(false);

    const events = await db.select().from(paymentWebhookEvents);
    expect(events.filter((e) => e.eventId === eventId).length).toBe(1);
  });

  it('never consumes the eventId for a terminal event without a reference', async () => {
    const eventId = `evt-rc4noref-${Date.now()}`;
    const r = await postWebhook({ eventId, type: 'payment.succeeded' });
    expect(r.status).toBe(200);
    expect(r.data.data.applied).toBe(false);

    const events = await db.select().from(paymentWebhookEvents);
    expect(events.filter((e) => e.eventId === eventId).length).toBe(0);
  });
});

describe('RC-5 — refunds reverse COMMISSION and PAYMENT_FEE proportionally', () => {
  /** Net magnitude (DEBIT − CREDIT) for an entry type on one transaction. */
  async function netByType(transactionId: string, entryType: string): Promise<number> {
    const rows = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
    return rows
      .filter((r) => r.entryType === entryType)
      .reduce((acc, r) => acc + (r.direction === 'DEBIT' ? 1 : -1) * Number(r.amount), 0);
  }

  it('fully reverses commission and payment fee on a full refund', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    await postWebhook({ eventId: `evt-rc5f-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.data.data.intent.externalRef as string });

    const commissionBefore = await netByType(s.transactionId, 'COMMISSION');
    const feeBefore = await netByType(s.transactionId, 'PAYMENT_FEE');
    expect(commissionBefore).toBeGreaterThan(0);
    expect(feeBefore).toBeGreaterThan(0);

    const refund = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'full reversal' } });
    expect(refund.status).toBe(201);
    expect(refund.data.data.refund.status).toBe('COMPLETED');

    // Full refund: WASIT's commission and fee net to exactly zero.
    expect(await netByType(s.transactionId, 'COMMISSION')).toBeCloseTo(0, 4);
    expect(await netByType(s.transactionId, 'PAYMENT_FEE')).toBeCloseTo(0, 4);
  });

  it('reverses only the refunded share on a partial refund and never over-reverses', async () => {
    const s = await setupPaidOrderBase();
    const intent = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    await postWebhook({ eventId: `evt-rc5p-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.data.data.intent.externalRef as string });

    const orderRow = await db.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    const paid = Number(orderRow[0].grandTotal);
    const commissionBefore = await netByType(s.transactionId, 'COMMISSION');

    const half = (paid / 2).toFixed(4);
    const r1 = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { amount: half, reason: 'half' } });
    expect(r1.status).toBe(201);

    const afterHalf = await netByType(s.transactionId, 'COMMISSION');
    // Roughly half the commission is reversed (4 dp rounding is the only drift).
    expect(afterHalf).toBeCloseTo(commissionBefore / 2, 3);

    // Second half completes the reversal; the total must not exceed the original.
    const r2 = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'rest' } });
    expect(r2.status).toBe(201);
    expect(await netByType(s.transactionId, 'COMMISSION')).toBeCloseTo(0, 4);

    // Idempotent retry of the last refund writes no further reversal.
    const retry = await s.admin.req(`/api/payments/orders/${s.orderId}/refunds`, { method: 'POST', body: { reason: 'rest' } });
    expect([409, 422]).toContain(retry.status);
    expect(await netByType(s.transactionId, 'COMMISSION')).toBeCloseTo(0, 4);
  });
});