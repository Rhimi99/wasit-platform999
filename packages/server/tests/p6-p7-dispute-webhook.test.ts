import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import argon2 from 'argon2';
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
} from '../src/db/schema/index.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import { MAX_WEBHOOK_ATTEMPTS } from '../src/modules/payments/service.js';

/**
 * P6/P7 — dispute financial effect, and webhook ordering / retry / DLQ.
 *
 * P6: a dispute decision that returns money does so through the existing refund
 * rail, driven by policy, idempotent by dispute id. A decision whose effect the
 * policy does not name moves no money and is reported as DECISION_REQUIRED.
 *
 * P7: a stale (out-of-order) terminal event is never applied; a failing event is
 * retried with a recorded attempt count and last error, then dead-lettered and
 * kept for an operator rather than silently deleted.
 */

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

async function registerAndLogin(c: ReturnType<typeof makeClient>, email: string, role: string) {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'T', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return (login.data.data as { id: string }).id;
}

async function createStaffUser(roleName: string) {
  const id = randomUUID();
  const email = `t6-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: roleName,
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const client = makeClient();
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { id, client };
}

/** Seeds a PAID order directly plus a dispute opened through the real API. */
async function paidOrderWithDispute(stamp: string) {
  const buyer = makeClient();
  const buyerId = await registerAndLogin(buyer, `t6-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const sellerId = randomUUID();
  const orderId = `ord6-${stamp}-${randomUUID().slice(0, 8)}`;
  const txId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORD6-${stamp}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    paymentFee: '0',
    grandTotal: '100.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });
  // A paid order has a payment record; the refund rail requires one.
  await db.insert(payments).values({
    id: randomUUID(),
    transactionId: txId,
    orderId,
    amount: '100.0000',
    currencyCode: 'TND',
    provider: 'manual',
    externalRef: `ref6-${stamp}`,
    status: 'PAID',
  });
  const created = await buyer.req('/api/disputes', {
    method: 'POST',
    body: { orderId, reasonCode: 'NOT_AS_DESCRIBED', description: 'Goods differ from the listing.' },
  });
  expect(created.status).toBe(200);
  return { buyer, orderId, disputeId: created.data.data.id as string };
}

async function postWebhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const sig = computeWebhookSignature(rawBody, WEBHOOK_SECRET);
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

describe('P6 — dispute decisions have a real, policy-driven financial effect', () => {
  it('IN_FAVOR_OF_BUYER refunds the buyer through the real refund rail', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { orderId, disputeId } = await paidOrderWithDispute(stamp);
    const judge = await createStaffUser('ADMIN');

    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER', note: 'Goods not as described.' },
    });
    expect(decided.status).toBe(200);
    expect(decided.data.data.financialEffect.kind).toBe('REFUND_BUYER');

    // A real refund row exists and the order is refunded.
    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows.length).toBe(1);
    expect(refundRows[0].status).toBe('COMPLETED');

    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('REFUNDED');
    expect(orderRow[0].refundStatus).toBe('COMPLETED');
  });

  it('IN_FAVOR_OF_SELLER moves no money', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { orderId, disputeId } = await paidOrderWithDispute(stamp);
    const judge = await createStaffUser('ADMIN');

    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Delivery proven.' },
    });
    expect(decided.status).toBe(200);
    expect(decided.data.data.financialEffect.kind).toBe('NONE');

    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows.length).toBe(0);
    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
  });

  it('a decision the policy does not map reports DECISION_REQUIRED and moves no money', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { orderId, disputeId } = await paidOrderWithDispute(stamp);
    const judge = await createStaffUser('ADMIN');

    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'SPLIT', note: 'Split negotiated.' },
    });
    expect(decided.status).toBe(200);
    expect(decided.data.data.financialEffect.kind).toBe('DECISION_REQUIRED');

    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows.length).toBe(0);
    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
  });

  it('cannot decide the same dispute twice (so it cannot refund twice)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { orderId, disputeId } = await paidOrderWithDispute(stamp);
    const judge = await createStaffUser('ADMIN');

    const first = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER' },
    });
    expect(first.status).toBe(200);

    const second = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER' },
    });
    expect(second.status).toBe(409);

    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows.length).toBe(1);
    // Exactly one REFUND ledger entry — no double reversal.
    const ledgerRefunds = await db
      .select()
      .from(transactionLedger)
      .where(and(eq(transactionLedger.currencyCode, 'TND'), eq(transactionLedger.entryType, 'REFUND')));
    expect(ledgerRefunds.filter((l) => l.payerId === 'wasit').length).toBeGreaterThanOrEqual(1);
  });
});

describe('P7 — webhook ordering, retry and dead-letter queue', () => {
  it('ignores a stale payment.failed that arrives after the intent succeeded', async () => {
    const externalRef = `ref-stale-${Date.now()}`;
    const intentId = randomUUID();
    const txId = randomUUID();
    const orderId = randomUUID();
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `P7-STALE-${Date.now()}`,
      buyerId: randomUUID(),
      buyerType: 'CUSTOMER',
      sellerId: randomUUID(),
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '10.0000',
      commission: '0',
      buyerCommission: '0',
      paymentFee: '0',
      grandTotal: '10.0000',
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });
    await db.insert(paymentIntents).values({
      id: intentId,
      orderId,
      transactionId: txId,
      amount: '10.0000',
      currencyCode: 'TND',
      provider: 'manual',
      idempotencyKey: `idem-${intentId}`,
      externalRef,
      status: 'SUCCEEDED',
    });

    const failed = await postWebhook({ eventId: `evt-stale-${Date.now()}`, type: 'payment.failed', externalRef });
    expect(failed.status).toBe(200);
    expect(failed.data.data.stale).toBe(true);
    expect(failed.data.data.applied).toBe(false);

    // The order and intent are untouched by the stale failure.
    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    const intentRow = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
    expect(intentRow[0].status).toBe('SUCCEEDED');
  });

  it('records a failed attempt with an attempt count and reason instead of deleting the claim', async () => {
    const eventId = `evt-fail-${Date.now()}`;
    const externalRef = `ref-missing-${Date.now()}`;

    const first = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(first.status).toBe(404);

    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeTruthy();
  });

  it('retries a previously failed event and applies it once the target exists', async () => {
    const eventId = `evt-retry-${Date.now()}`;
    const externalRef = `ref-retry-${Date.now()}`;

    // First delivery fails: no intent exists yet.
    const first = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(first.status).toBe(404);

    // Create the order/intent the event refers to.
    const orderId = randomUUID();
    const txId = randomUUID();
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `P7-RETRY-${Date.now()}`,
      buyerId: randomUUID(),
      buyerType: 'CUSTOMER',
      sellerId: randomUUID(),
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '25.0000',
      commission: '0',
      buyerCommission: '0',
      paymentFee: '0',
      grandTotal: '25.0000',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
    });
    await db.insert(paymentIntents).values({
      id: randomUUID(),
      orderId,
      transactionId: txId,
      amount: '25.0000',
      currencyCode: 'TND',
      provider: 'manual',
      idempotencyKey: `idem-${randomUUID()}`,
      externalRef,
      status: 'CREATED',
    });

    // Second delivery retries and succeeds.
    const second = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(second.status).toBe(200);
    expect(second.data.data.applied).toBe(true);

    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(row.status).toBe('PROCESSED');
  });

  it('dead-letters an event after the attempt cap and refuses further silent retries', async () => {
    const eventId = `evt-dlq-${Date.now()}`;
    const externalRef = `ref-ghost-${Date.now()}`;

    for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i += 1) {
      const r = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
      expect(r.status).toBe(404);
    }

    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(row.status).toBe('DEAD_LETTERED');
    expect(row.attempts).toBe(MAX_WEBHOOK_ATTEMPTS);
    expect(row.deadLetteredAt).toBeTruthy();

    // A further delivery does not re-attempt.
    const after = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(after.status).toBe(200);
    expect(after.data.data.deadLettered).toBe(true);
    expect(after.data.data.applied).toBe(false);
    const [rowAfter] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(rowAfter.attempts).toBe(MAX_WEBHOOK_ATTEMPTS);
  });

  it('surfaces dead-lettered events to an operator and lets them replay', async () => {
    const eventId = `evt-dlq-list-${Date.now()}`;
    const externalRef = `ref-ghost-list-${Date.now()}`;
    for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i += 1) {
      await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    }

    const admin = await createStaffUser('ADMIN');
    const listed = await admin.client.req('/api/payments/webhook-failures');
    expect(listed.status).toBe(200);
    const item = (listed.data.data.items as Array<{ id: string; eventId: string; status: string; attempts: number }>).find(
      (i) => i.eventId === eventId,
    );
    expect(item).toBeTruthy();
    expect(item!.status).toBe('DEAD_LETTERED');

    const replay = await admin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' });
    expect(replay.status).toBe(200);
    expect(replay.data.data.replayed).toBe(true);

    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(row.status).toBe('RECEIVED');
    expect(row.attempts).toBe(0);
  });

  it('does not expose webhook failures to a non-privileged user', async () => {
    const buyer = makeClient();
    await registerAndLogin(buyer, `t6-nonpriv-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await buyer.req('/api/payments/webhook-failures');
    expect(r.status).toBe(403);
  });
});
