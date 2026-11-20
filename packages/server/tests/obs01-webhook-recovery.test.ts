import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import {
  orders,
  paymentIntents,
  paymentWebhookAttempts,
  paymentWebhookEvents,
} from '../src/db/schema/index.js';
import { computeWebhookSignature } from '../src/lib/payments/providers.js';
import { MAX_WEBHOOK_ATTEMPTS, resolveWebhookRetryPolicy } from '../src/modules/payments/service.js';

/**
 * OBS-01 — webhook failure recovery.
 *
 * Covers classification, the bounded exponential backoff, idempotency under
 * concurrency, stale events, the dead-letter terminal state, the per-attempt
 * audit trail, operator visibility and the replay cap. Everything runs against
 * the real app, the real PostgreSQL schema and the real offline provider.
 */
const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;
const POLICY = resolveWebhookRetryPolicy();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(
        path,
        {
          method: options.method ?? 'GET',
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
      return { status: res.status, data: data as any };
    },
  };
}

async function createStaffUser(roleName: string) {
  const id = randomUUID();
  const email = `obs01-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { id, client };
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
  return { status: res.status, data: data as any };
}

/** Moves a failed event's backoff slot into the past — what a real re-delivery does after the delay. */
async function makeRetryDue(eventId: string) {
  await db.execute(sql`
    update payment_webhook_events
       set next_attempt_at = now() - interval '1 second',
           claim_token = null,
           claimed_at = null
     where provider = 'manual' and event_id = ${eventId}
  `);
}

async function rowFor(eventId: string) {
  const [row] = await db
    .select()
    .from(paymentWebhookEvents)
    .where(and(eq(paymentWebhookEvents.provider, 'manual'), eq(paymentWebhookEvents.eventId, eventId)))
    .limit(1);
  return row;
}

async function attemptsFor(eventRowId: string) {
  return db
    .select()
    .from(paymentWebhookAttempts)
    .where(eq(paymentWebhookAttempts.webhookEventId, eventRowId))
    .orderBy(paymentWebhookAttempts.createdAt, paymentWebhookAttempts.attemptNumber);
}

/** Seeds an order + intent the webhook can legitimately apply to. */
async function seedIntent(opts: { withTransaction?: boolean; status?: 'CREATED' | 'SUCCEEDED' } = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const orderId = randomUUID();
  const externalRef = `obs01-ref-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `OBS01-${stamp}`,
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
    transactionId: opts.withTransaction === false ? null : randomUUID(),
    amount: '25.0000',
    currencyCode: 'TND',
    provider: 'manual',
    idempotencyKey: `obs01-idem-${stamp}`,
    externalRef,
    status: opts.status ?? 'CREATED',
  });
  return { orderId, externalRef };
}

/** Drives an event to DEAD_LETTERED through real failing deliveries. */
async function deadLetter(eventId: string, externalRef: string) {
  for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i += 1) {
    if (i > 0) await makeRetryDue(eventId);
    const r = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(r.status).toBe(404);
  }
  const row = await rowFor(eventId);
  expect(row.status).toBe('DEAD_LETTERED');
  return row;
}

afterAll(() => {
  closeDb();
});

describe('OBS-01 — failure classification and exponential backoff', () => {
  it('classifies a missing target as TRANSIENT and schedules a backoff slot', async () => {
    const eventId = `obs01-transient-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;

    const before = Date.now();
    const first = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(first.status).toBe(404);

    const row = await rowFor(eventId);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.failureClass).toBe('TRANSIENT');
    expect(row.firstFailedAt).toBeTruthy();
    expect(row.deadLetteredAt).toBeNull();
    expect(row.claimToken).toBeNull();
    // First backoff slot = base delay.
    const delay = row.nextAttemptAt!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(POLICY.baseDelayMs - 5_000);
    expect(delay).toBeLessThanOrEqual(POLICY.baseDelayMs + 10_000);

    const attempts = await attemptsFor(row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('FAILURE');
    expect(attempts[0].failureClass).toBe('TRANSIENT');
    expect(attempts[0].retryScheduled).toBe(true);
    expect(attempts[0].nextAttemptAt).toBeTruthy();
  });

  it('refuses a retry before the backoff slot elapses (bounded, not a hot loop)', async () => {
    const eventId = `obs01-notdue-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;
    await postWebhook({ eventId, type: 'payment.succeeded', externalRef });

    const early = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(early.status).toBe(200);
    expect(early.data.data.retryScheduled).toBe(true);
    expect(early.data.data.applied).toBe(false);
    expect(early.data.data.nextAttemptAt).toBeTruthy();

    const row = await rowFor(eventId);
    expect(row.attempts).toBe(1);
    const attempts = await attemptsFor(row.id);
    // A gated delivery is not an attempt: nothing reached the apply path.
    expect(attempts).toHaveLength(1);
  });

  it('grows the delay exponentially on successive failures', async () => {
    const eventId = `obs01-backoff-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;

    await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    let row = await rowFor(eventId);
    const firstDelay = row.nextAttemptAt!.getTime() - Date.now();

    await makeRetryDue(eventId);
    const beforeSecond = Date.now();
    await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    row = await rowFor(eventId);
    expect(row.attempts).toBe(2);
    const secondDelay = row.nextAttemptAt!.getTime() - beforeSecond;

    expect(secondDelay).toBeGreaterThan(firstDelay);
    expect(secondDelay).toBeGreaterThanOrEqual(POLICY.baseDelayMs * 2 - 5_000);
  });

  it('retries after the slot elapses and applies the event once', async () => {
    const eventId = `obs01-retry-${randomUUID()}`;
    const { externalRef, orderId } = await seedIntent();

    // First delivery fails because the target does not exist yet.
    const ghostRef = `obs01-ghost-${randomUUID()}`;
    const first = await postWebhook({ eventId, type: 'payment.succeeded', externalRef: ghostRef });
    expect(first.status).toBe(404);

    // The retry is a new delivery of the same event, now naming the real intent.
    await makeRetryDue(eventId);
    const retried = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(retried.status).toBe(200);
    expect(retried.data.data.applied).toBe(true);

    const row = await rowFor(eventId);
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(2);
    expect(row.failureClass).toBeNull();
    expect(row.nextAttemptAt).toBeNull();

    const attempts = await attemptsFor(row.id);
    expect(attempts.map((a) => a.outcome)).toEqual(['FAILURE', 'SUCCESS']);

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(order.paymentStatus).toBe('PAID');
  });

  it('dead-letters a non-retryable conflict on the first attempt instead of burning the budget', async () => {
    const eventId = `obs01-conflict-${randomUUID()}`;
    // An intent with no transaction cannot be applied: a permanent state conflict.
    const { externalRef } = await seedIntent({ withTransaction: false });

    const res = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(res.status).toBe(409);

    const row = await rowFor(eventId);
    expect(row.status).toBe('DEAD_LETTERED');
    expect(row.attempts).toBe(1);
    expect(row.failureClass).toBe('CONFLICT');
    expect(row.deadLetteredAt).toBeTruthy();
    expect(row.nextAttemptAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row.id));
    const dlqAudit = audits.find((a) => a.action === 'PAYMENT.WEBHOOK_DEAD_LETTERED');
    expect(dlqAudit).toBeTruthy();
    expect(dlqAudit!.actorId).toBeNull();
    expect(dlqAudit!.actorType).toBe('SYSTEM');
  });
});

describe('OBS-01 — idempotency and concurrency', () => {
  it('applies concurrent duplicate deliveries exactly once', async () => {
    const eventId = `obs01-concurrent-${randomUUID()}`;
    const { externalRef, orderId } = await seedIntent();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook({ eventId, type: 'payment.succeeded', externalRef })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const applied = results.filter((r) => r.data?.data?.applied === true);
    expect(applied).toHaveLength(1);

    const row = await rowFor(eventId);
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(1);
    expect(row.claimToken).toBeNull();

    const attempts = await attemptsFor(row.id);
    expect(attempts.filter((a) => a.outcome === 'SUCCESS')).toHaveLength(1);

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(order.paymentStatus).toBe('PAID');
  });

  it('acknowledges a delivery while another process holds the claim, without applying it', async () => {
    const eventId = `obs01-lease-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;
    await db.insert(paymentWebhookEvents).values({
      id: randomUUID(),
      provider: 'manual',
      eventId,
      eventType: 'PAYMENT_SUCCEEDED',
      payload: {} as never,
      signatureValid: 'true',
      status: 'FAILED',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1_000),
      claimToken: 'held-by-another-process',
      claimedAt: new Date(),
    });

    const res = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(res.status).toBe(200);
    expect(res.data.data.inProgress).toBe(true);
    expect(res.data.data.applied).toBe(false);

    let row = await rowFor(eventId);
    expect(row.attempts).toBe(1);
    expect(await attemptsFor(row.id)).toHaveLength(0);

    // Once the lease expires, a later delivery may take it over.
    await db
      .update(paymentWebhookEvents)
      .set({ claimedAt: new Date(Date.now() - POLICY.claimLeaseMs - 5_000) })
      .where(eq(paymentWebhookEvents.id, row.id));
    const takeover = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(takeover.status).toBe(404); // it applied and failed: the target does not exist

    row = await rowFor(eventId);
    expect(row.attempts).toBe(2);
  });
});

describe('OBS-01 — stale events, dead-letter and audit trail', () => {
  it('records an out-of-order payment.failed as STALE and never applies it', async () => {
    const eventId = `obs01-stale-${randomUUID()}`;
    const { externalRef } = await seedIntent({ status: 'SUCCEEDED' });

    const res = await postWebhook({ eventId, type: 'payment.failed', externalRef });
    expect(res.status).toBe(200);
    expect(res.data.data.stale).toBe(true);
    expect(res.data.data.applied).toBe(false);

    const row = await rowFor(eventId);
    expect(row.status).toBe('PROCESSED');
    expect(row.failureClass).toBe('STALE');
    const attempts = await attemptsFor(row.id);
    expect(attempts.map((a) => a.outcome)).toEqual(['STALE']);
  });

  it('dead-letters after the attempt budget and stops retrying silently', async () => {
    const eventId = `obs01-dlq-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;
    const row = await deadLetter(eventId, externalRef);

    expect(row.attempts).toBe(MAX_WEBHOOK_ATTEMPTS);
    expect(row.failureClass).toBe('TRANSIENT');
    expect(row.deadLetteredAt).toBeTruthy();

    const after = await postWebhook({ eventId, type: 'payment.succeeded', externalRef });
    expect(after.status).toBe(200);
    expect(after.data.data.deadLettered).toBe(true);
    expect(after.data.data.applied).toBe(false);
    expect((await rowFor(eventId)).attempts).toBe(MAX_WEBHOOK_ATTEMPTS);

    const attempts = await attemptsFor(row.id);
    expect(attempts).toHaveLength(MAX_WEBHOOK_ATTEMPTS);
    expect(attempts.every((a) => a.outcome === 'FAILURE')).toBe(true);
    expect(attempts[MAX_WEBHOOK_ATTEMPTS - 1].retryScheduled).toBe(false);
  });

  it('exposes the attempt trail to an operator, never to SUPPORT, and never the payload', async () => {
    const eventId = `obs01-trail-${randomUUID()}`;
    const row = await deadLetter(eventId, `obs01-ghost-${randomUUID()}`);

    const admin = await createStaffUser('ADMIN');
    const trail = await admin.client.req(`/api/payments/webhook-failures/${row.id}/attempts`);
    expect(trail.status).toBe(200);
    const items = trail.data.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(MAX_WEBHOOK_ATTEMPTS);
    expect(items[0].outcome).toBe('FAILURE');
    expect(items[0].failureClass).toBe('TRANSIENT');
    expect(items[0]).not.toHaveProperty('payload');
    expect(items[0]).not.toHaveProperty('signatureValid');

    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req(`/api/payments/webhook-failures/${row.id}/attempts`)).status).toBe(403);
    expect((await makeClient().req(`/api/payments/webhook-failures/${row.id}/attempts`)).status).toBe(401);
    expect((await admin.client.req(`/api/payments/webhook-failures/${randomUUID()}/attempts`)).status).toBe(404);
  });

  it('lists the failure class and the next backoff slot for an operator', async () => {
    const eventId = `obs01-list-${randomUUID()}`;
    await postWebhook({ eventId, type: 'payment.succeeded', externalRef: `obs01-ghost-${randomUUID()}` });

    const admin = await createStaffUser('ADMIN');
    const listed = await admin.client.req('/api/payments/webhook-failures');
    const item = (listed.data.data.items as Array<Record<string, unknown>>).find((i) => i.eventId === eventId);
    expect(item).toBeTruthy();
    expect(item!.failureClass).toBe('TRANSIENT');
    expect(item!.nextAttemptAt).toBeTruthy();
    expect(item!.replayCount).toBe(0);
  });
});

describe('OBS-01 — replay guardrails', () => {
  it('caps operator replays and refuses further ones with 409', async () => {
    const eventId = `obs01-replaycap-${randomUUID()}`;
    const externalRef = `obs01-ghost-${randomUUID()}`;
    const admin = await createStaffUser('ADMIN');

    for (let cycle = 0; cycle < POLICY.maxReplays; cycle += 1) {
      const row = await deadLetter(eventId, externalRef);
      const replay = await admin.client.req(`/api/payments/webhook-failures/${row.id}/replay`, { method: 'POST' });
      expect(replay.status).toBe(200);
      expect(replay.data.data.replayed).toBe(true);
      expect(replay.data.data.replayCount).toBe(cycle + 1);
    }

    const row = await deadLetter(eventId, externalRef);
    expect(row.replayCount).toBe(POLICY.maxReplays);

    const refused = await admin.client.req(`/api/payments/webhook-failures/${row.id}/replay`, { method: 'POST' });
    expect(refused.status).toBe(409);
    // The refusal changed nothing: the event stays terminal.
    expect((await rowFor(eventId)).status).toBe('DEAD_LETTERED');
  });

  it('records a replay in the attempt trail without applying the side effect', async () => {
    const eventId = `obs01-replaytrail-${randomUUID()}`;
    const row = await deadLetter(eventId, `obs01-ghost-${randomUUID()}`);
    const admin = await createStaffUser('ADMIN');

    const replay = await admin.client.req(`/api/payments/webhook-failures/${row.id}/replay`, { method: 'POST' });
    expect(replay.status).toBe(200);
    expect(replay.data.data.applied).toBeUndefined();

    const after = await rowFor(eventId);
    expect(after.status).toBe('RECEIVED');
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt).toBeTruthy();

    const attempts = await attemptsFor(row.id);
    expect(attempts[attempts.length - 1].outcome).toBe('REPLAY');
  });
});
