import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
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
import { MAX_WEBHOOK_ATTEMPTS, completeRefundWithEvidence } from '../src/modules/payments/service.js';

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
      // Inject the real TCP peer: with the trusted-IP fix the client address
      // comes from the socket, not from a forwarded header, so a test must set
      // the socket to observe an address in audit records.
      const res = await app.request(
        path,
        {
          method: options.method ?? 'GET',
          headers,
          body: options.rawBody !== undefined ? options.rawBody : options.body !== undefined ? JSON.stringify(options.body) : undefined,
        },
        { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 0, remoteFamily: 'IPv4' } } },
      );
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
  it('IN_FAVOR_OF_BUYER requests a refund but the decision alone does NOT complete it', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { orderId, disputeId } = await paidOrderWithDispute(stamp);
    const judge = await createStaffUser('ADMIN');

    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER', note: 'Goods not as described.' },
    });
    expect(decided.status).toBe(200);
    expect(decided.data.data.financialEffect.kind).toBe('REFUND_BUYER');

    // A refund row is raised, but the offline provider proves nothing, so the
    // decision alone leaves it REQUESTED — no money has moved.
    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows.length).toBe(1);
    expect(refundRows[0].status).toBe('REQUESTED');

    let orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    expect(orderRow[0].refundStatus).not.toBe('COMPLETED');

    // Only trusted external evidence completes the reversal.
    await completeRefundWithEvidence(
      db,
      refundRows[0].id,
      { source: 'PROVIDER_WEBHOOK', providerId: 'open-checkout', externalRef: `ext-${refundRows[0].id}`, amount: refundRows[0].amount, currencyCode: 'TND' },
      { actorId: null },
    );

    const completedRefund = await db.select().from(refunds).where(eq(refunds.id, refundRows[0].id)).limit(1);
    expect(completedRefund[0].status).toBe('COMPLETED');
    orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
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
    // Still only a request: no decision, and no refund, has moved money.
    expect(refundRows[0].status).toBe('REQUESTED');
    const ledgerRefunds = await db
      .select()
      .from(transactionLedger)
      .where(and(eq(transactionLedger.entryType, 'REFUND'), eq(transactionLedger.payerId, 'wasit')));
    // Scoped to this order's transaction, not the whole (shared) test database.
    const orderPayment = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    const thisTxRefunds = ledgerRefunds.filter((l) => l.transactionId === orderPayment[0].transactionId);
    expect(thisTxRefunds.length).toBe(0);
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

  // ---- OBS-01: webhook failure desk — audit identity, pagination, guardrails ----

  /** Drives an event to DEAD_LETTERED by failing the apply path MAX times. */
  async function deadLetterEvent(prefix: string): Promise<{ eventId: string; externalRef: string }> {
    const eventId = `evt-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const externalRef = `ref-ghost-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i += 1) {
      await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    }
    return { eventId, externalRef };
  }

  async function findFailure(admin: ReturnType<typeof createStaffUser> extends Promise<infer R> ? R : never, eventId: string) {
    const listed = await admin.client.req('/api/payments/webhook-failures');
    return (listed.data.data.items as Array<{ id: string; eventId: string; status: string }>).find((i) => i.eventId === eventId);
  }

  it('records the acting operator identity (not NULL) in the replay audit entry', async () => {
    const { eventId } = await deadLetterEvent('audit');
    const admin = await createStaffUser('ADMIN');
    const item = await findFailure(admin, eventId);
    expect(item).toBeTruthy();

    const replay = await admin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'wasit-obs01-test' },
    });
    expect(replay.status).toBe(200);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, item!.id));
    const entry = audits.find((a) => a.action === 'PAYMENT.WEBHOOK_REPLAY');
    expect(entry).toBeTruthy();
    // The whole point of OBS-01: the audit names the operator, not NULL.
    expect(entry!.actorId).toBe(admin.id);
    expect(entry!.actorId).not.toBeNull();
    expect(entry!.ipAddress).toBe('203.0.113.7');
    expect(entry!.userAgent).toBe('wasit-obs01-test');
  });

  it('rejects replay of an event that is not DEAD_LETTERED with 404', async () => {
    // A FAILED (below-cap) event exists but must not be replayable.
    const eventId = `evt-failed-${Date.now()}`;
    const externalRef = `ref-ghost-failed-${Date.now()}`;
    await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
      .limit(1);
    expect(row.status).toBe('FAILED');

    const admin = await createStaffUser('ADMIN');
    const replay = await admin.client.req(`/api/payments/webhook-failures/${row.id}/replay`, { method: 'POST' });
    expect(replay.status).toBe(404);
  });

  it('rejects replay of a non-existent event with 404', async () => {
    const admin = await createStaffUser('ADMIN');
    const replay = await admin.client.req(`/api/payments/webhook-failures/${randomUUID()}/replay`, { method: 'POST' });
    expect(replay.status).toBe(404);
  });

  it('runs concurrent replays of the same event exactly once (single transition)', async () => {
    const { eventId } = await deadLetterEvent('concurrent');
    const admin = await createStaffUser('ADMIN');
    const item = await findFailure(admin, eventId);
    expect(item).toBeTruthy();

    const [a, b] = await Promise.all([
      admin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' }),
      admin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one transition: one 200, one 404 (the loser sees the row already RECEIVED).
    expect(statuses).toEqual([200, 404]);

    const [row] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, item!.id))
      .limit(1);
    expect(row.status).toBe('RECEIVED');
    expect(row.attempts).toBe(0);
  });

  it('replaying a dead-lettered event creates no financial effect and moves no ledger to SETTLED', async () => {
    // A dead-lettered event for a ghost intent: replay only resets the counter.
    const { eventId } = await deadLetterEvent('nofin');
    const admin = await createStaffUser('ADMIN');
    const item = await findFailure(admin, eventId);
    expect(item).toBeTruthy();

    const before = await db.select().from(transactionLedger);
    const beforePaid = before.filter((l) => l.status === 'SETTLED').length;

    const replay = await admin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' });
    expect(replay.status).toBe(200);

    const after = await db.select().from(transactionLedger);
    expect(after.length).toBe(before.length);
    expect(after.filter((l) => l.status === 'SETTLED').length).toBe(beforePaid);
    // The replay response is honest: it reports the reset, not a completed process.
    expect(replay.data.data.replayed).toBe(true);
    expect(replay.data.data.applied).toBeUndefined();
  });

  it('pages the failure list with an offset and reports the true total', async () => {
    const admin = await createStaffUser('ADMIN');
    const first = await admin.client.req('/api/payments/webhook-failures?limit=1&offset=0');
    expect(first.status).toBe(200);
    expect((first.data.data.items as unknown[]).length).toBeLessThanOrEqual(1);
    expect(typeof first.data.data.meta.total).toBe('number');
    expect(first.data.data.meta.offset).toBe(0);

    // A malformed offset must not reach SQL as NaN — it falls back to 0.
    const bad = await admin.client.req('/api/payments/webhook-failures?offset=abc');
    expect(bad.status).toBe(200);
    expect(bad.data.data.meta.offset).toBe(0);
  });

  it('never leaks the raw payload or signature fields in the failure list', async () => {
    const { eventId } = await deadLetterEvent('noleak');
    const admin = await createStaffUser('ADMIN');
    const listed = await admin.client.req('/api/payments/webhook-failures');
    const item = (listed.data.data.items as Array<Record<string, unknown>>).find((i) => i.eventId === eventId);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('signatureValid');
  });

  it('allows a SUPER_ADMIN to list and replay, and forbids SUPPORT/RISK/DISPUTE/MERCHANT/CUSTOMER', async () => {
    const { eventId } = await deadLetterEvent('rbac');
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const item = await findFailure(superAdmin, eventId);
    expect(item).toBeTruthy();
    const replay = await superAdmin.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' });
    expect(replay.status).toBe(200);

    for (const role of ['SUPPORT', 'RISK', 'DISPUTE']) {
      const staff = await createStaffUser(role);
      expect((await staff.client.req('/api/payments/webhook-failures')).status).toBe(403);
      expect((await staff.client.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' })).status).toBe(403);
    }

    const merchant = makeClient();
    await registerAndLogin(merchant, `t6-merchant-${Date.now()}@wasit.tn`, 'MERCHANT');
    expect((await merchant.req('/api/payments/webhook-failures')).status).toBe(403);
    expect((await merchant.req(`/api/payments/webhook-failures/${item!.id}/replay`, { method: 'POST' })).status).toBe(403);
  });

  it('rejects an anonymous caller with 401', async () => {
    const guest = makeClient();
    expect((await guest.req('/api/payments/webhook-failures')).status).toBe(401);
    expect((await guest.req(`/api/payments/webhook-failures/${randomUUID()}/replay`, { method: 'POST' })).status).toBe(401);
  });
});
