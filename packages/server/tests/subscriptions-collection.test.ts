import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles } from '../src/db/schema/auth.js';
import {
  subscriptionPlans,
  subscriptions,
  invoices,
} from '../src/db/schema/subscriptions.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { newId } from '../src/lib/ids.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import {
  collectInvoicePayment,
  startInvoicePayment,
  expireLapsedSubscriptions,
  listPendingInvoices,
} from '../src/modules/subscriptions/collection.js';
import type { UserRole } from '@wasit/shared';

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

function makeClient(base: Hono, initialCookie = '') {
  let cookie = initialCookie;
  return {
    cookie(): string {
      return cookie;
    },
    async req(
      path: string,
      options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
    ) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await base.request(path, {
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
      return { data: data as any, status: res.status };
    },
  };
}

async function createUserWithRole(role: UserRole, tag: string): Promise<{ id: string; cookie: string }> {
  const c = makeClient(app);
  const email = `subc-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: tag, role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const id = (login.data.data as { id: string }).id;
  if (role === 'CUSTOMER') return { id, cookie: c.cookie() };
  const roleRow = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  await db.delete(userRoles).where(eq(userRoles.userId, id));
  await db.insert(userRoles).values({ id: newId(), userId: id, roleId: roleRow[0].id });
  return { id, cookie: c.cookie() };
}

async function paidPlanId(): Promise<string> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.code, 'SMALL_MERCHANT'))
    .limit(1);
  return rows[0].id;
}

/** Creates a subscription + PENDING invoice directly, returning both ids. */
async function createPendingSubscription(userId: string, endsAt?: Date) {
  const planId = await paidPlanId();
  const subId = newId();
  await db.insert(subscriptions).values({
    id: subId,
    userId,
    planId,
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    autoRenew: true,
    startsAt: new Date(Date.now() - 30 * 86_400_000),
    endsAt: endsAt ?? new Date(Date.now() + 5 * 86_400_000),
  });
  const invoiceId = newId();
  await db.insert(invoices).values({
    id: invoiceId,
    subscriptionId: subId,
    invoiceNumber: `INV-TEST-${invoiceId.slice(0, 8)}`,
    amount: '29.0000',
    currencyCode: 'TND',
    status: 'PENDING',
    dueAt: new Date(Date.now() + 3 * 86_400_000),
  });
  return { subId, invoiceId };
}

afterAll(async () => {
  await closeDb();
});

describe('Subscriptions — invoice payment through the provider port', () => {
  it('startInvoicePayment creates a provider intent (manual) and audits it', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'intent');
    const { invoiceId } = await createPendingSubscription(userId);

    const result = await startInvoicePayment(db, { invoiceId, actorId: userId });
    expect(result.reused).toBe(false);
    expect(result.provider).toBe('manual');
    expect(result.externalRef.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.idempotencyKey, `subinv_${invoiceId}`))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].subscriptionId).not.toBeNull();
    expect(rows[0].orderId).toBeNull();

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'SUBSCRIPTION.INVOICE_INTENT_CREATE'), eq(auditLogs.entityId, invoiceId)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('is idempotent: replaying startInvoicePayment returns the same intent', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'intent-reuse');
    const { invoiceId } = await createPendingSubscription(userId);
    const first = await startInvoicePayment(db, { invoiceId, actorId: userId });
    const second = await startInvoicePayment(db, { invoiceId, actorId: userId });
    expect(second.reused).toBe(true);
    expect(second.intentId).toBe(first.intentId);

    const rows = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.idempotencyKey, `subinv_${invoiceId}`));
    expect(rows.length).toBe(1);
  });

  it("refuses to start payment for someone else's invoice", async () => {
    const { id: owner } = await createUserWithRole('CUSTOMER', 'intent-owner');
    const { id: stranger } = await createUserWithRole('CUSTOMER', 'intent-stranger');
    const { invoiceId } = await createPendingSubscription(owner);
    await expect(startInvoicePayment(db, { invoiceId, actorId: stranger })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('collects through the provider: PAID + period extended + audit', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'collect');
    const { subId, invoiceId } = await createPendingSubscription(userId);
    const before = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    const beforeEnd = before[0].endsAt!.getTime();

    const result = await collectInvoicePayment(db, { invoiceId, actorId: userId });
    expect(result.subscriptionStatus).toBe('ACTIVE');

    const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    expect(inv[0].status).toBe('PAID');
    expect(inv[0].paidAt).not.toBeNull();
    expect(inv[0].externalRef).toBeTruthy();

    const after = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(after[0].endsAt!.getTime()).toBeGreaterThan(beforeEnd);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'SUBSCRIPTION.INVOICE_PAID'), eq(auditLogs.entityId, invoiceId)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second collect on a paid invoice is rejected', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'collect-twice');
    const { invoiceId } = await createPendingSubscription(userId);
    await collectInvoicePayment(db, { invoiceId, actorId: userId });
    await expect(collectInvoicePayment(db, { invoiceId, actorId: userId })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('lists pending invoices for the dunning queue', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'pending');
    const { invoiceId } = await createPendingSubscription(userId);
    const items = await listPendingInvoices(db);
    expect(items.some((i) => i.id === invoiceId)).toBe(true);
  });
});

describe('Subscriptions — settlement via the payment webhook', () => {
  it('a signed PAYMENT_SUCCEEDED webhook settles the invoice and extends the period', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'webhook-ok');
    const { subId, invoiceId } = await createPendingSubscription(userId);
    const intent = await startInvoicePayment(db, { invoiceId, actorId: userId });

    const raw = JSON.stringify({ eventId: `evt_${newId()}`, type: 'payment.succeeded', externalRef: intent.externalRef });
    const client = makeClient(app);
    const res = await client.req('/api/payment-webhooks', {
      method: 'POST',
      rawBody: raw,
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': computeWebhookSignature(raw, WEBHOOK_SECRET) },
    });
    expect(res.status).toBe(200);

    const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    expect(inv[0].status).toBe('PAID');
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('ACTIVE');
  });

  it('a signed PAYMENT_FAILED webhook marks the invoice FAILED and the subscription PAST_DUE', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'webhook-fail');
    const { subId, invoiceId } = await createPendingSubscription(userId);
    const intent = await startInvoicePayment(db, { invoiceId, actorId: userId });

    const raw = JSON.stringify({ eventId: `evt_${newId()}`, type: 'payment.failed', externalRef: intent.externalRef });
    const client = makeClient(app);
    const res = await client.req('/api/payment-webhooks', {
      method: 'POST',
      rawBody: raw,
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': computeWebhookSignature(raw, WEBHOOK_SECRET) },
    });
    expect(res.status).toBe(200);

    const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    expect(inv[0].status).toBe('FAILED');
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('PAST_DUE');
  });

  it('replaying the same webhook event id does not extend the period twice', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'webhook-replay');
    const { subId, invoiceId } = await createPendingSubscription(userId);
    const intent = await startInvoicePayment(db, { invoiceId, actorId: userId });

    const raw = JSON.stringify({ eventId: `evt_${newId()}`, type: 'payment.succeeded', externalRef: intent.externalRef });
    const headers = { 'Content-Type': 'application/json', 'x-wasit-signature': computeWebhookSignature(raw, WEBHOOK_SECRET) };
    const client = makeClient(app);
    const first = await client.req('/api/payment-webhooks', { method: 'POST', rawBody: raw, headers });
    const second = await client.req('/api/payment-webhooks', { method: 'POST', rawBody: raw, headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // One PAID invoice, one active subscription window.
    const paidInvoices = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, subId), eq(invoices.status, 'PAID')));
    expect(paidInvoices.length).toBe(1);
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('ACTIVE');
  });

  it('rejects a forged signature on an invoice event', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'webhook-forged');
    const { invoiceId } = await createPendingSubscription(userId);
    const intent = await startInvoicePayment(db, { invoiceId, actorId: userId });

    const raw = JSON.stringify({ eventId: `evt_${newId()}`, type: 'payment.succeeded', externalRef: intent.externalRef });
    const client = makeClient(app);
    const res = await client.req('/api/payment-webhooks', {
      method: 'POST',
      rawBody: raw,
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': 'deadbeef' },
    });
    expect(res.status).toBe(401);
    const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    expect(inv[0].status).toBe('PENDING');
  });
});

describe('Subscriptions — cancel/expiry cycle', () => {
  it('expires a cancelled subscription whose period has lapsed', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'expire-cancel');
    const { subId } = await createPendingSubscription(userId);
    await db
      .update(subscriptions)
      .set({ autoRenew: false, cancelledAt: new Date(), endsAt: new Date(Date.now() - 86_400_000) })
      .where(eq(subscriptions.id, subId));

    const result = await expireLapsedSubscriptions(db);
    expect(result.expiredIds).toContain(subId);
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('EXPIRED');
  });

  it('does not expire a cancelled subscription whose period is still running', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'keep-active');
    const { subId } = await createPendingSubscription(userId);
    await db
      .update(subscriptions)
      .set({ autoRenew: false, cancelledAt: new Date(), endsAt: new Date(Date.now() + 10 * 86_400_000) })
      .where(eq(subscriptions.id, subId));

    const result = await expireLapsedSubscriptions(db);
    expect(result.expiredIds).not.toContain(subId);
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('ACTIVE');
  });

  it('expires a PAST_DUE subscription beyond the grace window', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'expire-pastdue');
    const { subId } = await createPendingSubscription(userId);
    const stale = new Date(Date.now() - 30 * 86_400_000);
    await db
      .update(subscriptions)
      .set({ status: 'PAST_DUE', updatedAt: stale })
      .where(eq(subscriptions.id, subId));

    const result = await expireLapsedSubscriptions(db, { graceDays: 14 });
    expect(result.expiredIds).toContain(subId);
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(sub[0].status).toBe('EXPIRED');
    expect(sub[0].autoRenew).toBe(false);
  });
});

describe('Subscriptions — collection routes RBAC', () => {
  it('lets an owner start payment for their own invoice via /me/invoices/:id/pay', async () => {
    const owner = await createUserWithRole('CUSTOMER', 'route-owner');
    const { invoiceId } = await createPendingSubscription(owner.id);
    const client = makeClient(app, owner.cookie);
    const res = await client.req(`/api/subscriptions/me/invoices/${invoiceId}/pay`, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(201);
    expect(res.data.data.externalRef).toBeTruthy();
  });

  it("hides another user's invoice behind a 403 on the user route", async () => {
    const owner = await createUserWithRole('CUSTOMER', 'route-owner2');
    const other = await createUserWithRole('CUSTOMER', 'route-other');
    const { invoiceId } = await createPendingSubscription(owner.id);
    const client = makeClient(app, other.cookie);
    const res = await client.req(`/api/subscriptions/me/invoices/${invoiceId}/pay`, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('denies collect to a MERCHANT without SUBSCRIPTION_MANAGE', async () => {
    const { cookie } = await createUserWithRole('MERCHANT', 'deny-collect');
    const client = makeClient(app, cookie);
    const res = await client.req('/api/subscriptions/admin/invoices/whatever/collect', {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('lets an ADMIN collect through the route', async () => {
    const { id: userId } = await createUserWithRole('CUSTOMER', 'route-collect');
    const { invoiceId } = await createPendingSubscription(userId);
    const { cookie } = await createUserWithRole('ADMIN', 'collect-admin');
    const admin = makeClient(app, cookie);
    const res = await admin.req(`/api/subscriptions/admin/invoices/${invoiceId}/collect`, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.data.data.invoiceId).toBe(invoiceId);
  });

  it('exposes the pending-invoice queue to an ADMIN', async () => {
    const { cookie } = await createUserWithRole('ADMIN', 'pending-admin');
    const admin = makeClient(app, cookie);
    const res = await admin.req('/api/subscriptions/admin/invoices/pending');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data.items)).toBe(true);
  });
});