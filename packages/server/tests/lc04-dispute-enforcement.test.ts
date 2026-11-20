import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { disputes, disputeEvents } from '../src/db/schema/disputes.js';
import { escalateOverdueDisputes } from '../src/modules/disputes/service.js';

/**
 * LC-04 — dispute enforcement rails (integration, real DB + real app).
 *
 * Pins three behaviours that a policy value alone does not guarantee:
 *  1. a decision cannot be recorded by setting the status — `DECIDED` is reachable
 *     only through the decision path (separation of duties + financial effect);
 *  2. the respondent's response window is enforced, not merely displayed;
 *  3. `autoEscalateDays` is acted upon by an idempotent, concurrency-safe sweep.
 */

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;

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

async function registerRole(c: ReturnType<typeof makeClient>, email: string, role: string): Promise<string> {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'EN', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return u.id;
}

async function createStaffUser(roleName: 'ADMIN' | 'DISPUTE') {
  const id = randomUUID();
  const email = `it-lc04e-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

async function orderWithParties(stamp: string) {
  const buyer = makeClient();
  const seller = makeClient();
  const buyerId = await registerRole(buyer, `it-lc04e-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const sellerId = await registerRole(seller, `it-lc04e-sel-${stamp}@wasit.tn`, 'SUPPLIER');

  const orderId = `ord-lc04e-${randomUUID().slice(0, 8)}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDLC04E-${stamp}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '2.0000',
    buyerCommission: '2.0000',
    paymentFee: '0',
    grandTotal: '100.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });
  return { buyer, seller, buyerId, sellerId, orderId };
}

async function openDispute(buyer: ReturnType<typeof makeClient>, orderId: string): Promise<string> {
  const created = await buyer.req('/api/disputes', {
    method: 'POST',
    body: { orderId, reasonCode: 'NOT_AS_DESCRIBED', description: 'Goods differ from the listing.' },
  });
  expect(created.status).toBe(200);
  return created.data.data.id as string;
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;

describe('LC-04 decision integrity — DECIDED is unreachable via the status endpoint', () => {
  it('refuses to set DECIDED through the status endpoint and leaves the record undecided', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);
    const judge = await createStaffUser('ADMIN');

    const toReview = await judge.client.req(`/api/admin/disputes/${disputeId}/status`, { method: 'POST', body: { status: 'UNDER_REVIEW' } });
    expect(toReview.status).toBe(200);

    // The status endpoint must not be able to fabricate a decision.
    const viaStatus = await judge.client.req(`/api/admin/disputes/${disputeId}/status`, { method: 'POST', body: { status: 'DECIDED', note: 'probe' } });
    expect(viaStatus.status).toBe(409);

    const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(row.status).toBe('UNDER_REVIEW');
    expect(row.decision).toBe('NONE');
    expect(row.decidedBy).toBeNull();
    expect(row.decidedAt).toBeNull();
    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(events.some((e) => e.eventType === 'DECIDED')).toBe(false);

    // The dedicated decision path still records a real decision.
    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, { method: 'POST', body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Independent review.' } });
    expect(decided.status).toBe(200);
    const [after] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(after.status).toBe('DECIDED');
    expect(after.decision).toBe('IN_FAVOR_OF_SELLER');
    expect(after.decidedBy).toBe(judge.id);
    expect(after.decidedAt).not.toBeNull();
  });
});

describe('LC-04 response window — enforced for the respondent', () => {
  it('lets the respondent reply inside the window and refuses after it, while the opener and staff keep the channel', async () => {
    const s = stamp();
    const { buyer, seller, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    // Inside the 7-day response window: the counterparty may answer.
    const inside = await seller.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'Here is our delivery record.' } });
    expect(inside.status).toBe(200);

    // Push the dispute past the response window but still inside the evidence window.
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 10 * DAY) }).where(eq(disputes.id, disputeId));

    const lateReply = await seller.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'Late reply attempt.' } });
    expect(lateReply.status).toBe(409);
    const rows = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(rows.filter((e) => e.eventType === 'MESSAGE_ADDED').length).toBe(1);

    // The opener is not "responding" — their channel stays open.
    const openerLate = await buyer.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'Following up.' } });
    expect(openerLate.status).toBe(200);

    // Staff are reviewers, not respondents.
    const staff = await createStaffUser('DISPUTE');
    const staffLate = await staff.client.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'Internal note.' } });
    expect(staffLate.status).toBe(200);

    // Evidence has its own, longer window (14 days): the respondent may still file it.
    const evidence = await seller.req(`/api/disputes/${disputeId}/evidence`, { method: 'POST', body: { fileRef: 's3://bucket/late.pdf' } });
    expect(evidence.status).toBe(200);
  });
});

describe('LC-04 auto-escalation — the policy window is acted upon', () => {
  it('escalates a live dispute past autoEscalateDays and records a SYSTEM audit, idempotently', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const overdueId = await openDispute(buyer, orderId);

    // A fresh, in-window dispute in the same run must be left alone. (The sweep
    // is global, so assertions are per-dispute and do not depend on how many
    // other fixtures happen to be overdue in the shared test database.)
    const { buyer: buyer2, orderId: orderId2 } = await orderWithParties(`${s}-b`);
    const freshId = await openDispute(buyer2, orderId2);

    // Past autoEscalateDays (seeded 7): the sweep escalates the overdue case only.
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(disputes.id, overdueId));
    const run = await escalateOverdueDisputes(db);
    expect(run.escalated).toBeGreaterThanOrEqual(1);

    const [escalated] = await db.select().from(disputes).where(eq(disputes.id, overdueId)).limit(1);
    expect(escalated.status).toBe('ESCALATED');
    const [untouched] = await db.select().from(disputes).where(eq(disputes.id, freshId)).limit(1);
    expect(untouched.status).toBe('OPEN');

    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, overdueId));
    expect(events.some((e) => e.eventType === 'STATUS_CHANGED' && (e.after as { status?: string } | null)?.status === 'ESCALATED')).toBe(true);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'DISPUTE.AUTO_ESCALATED'));
    expect(audits.some((a) => a.entityId === overdueId && a.actorType === 'SYSTEM')).toBe(true);

    // A second sweep is a no-op for this dispute — escalation is not repeatable.
    await escalateOverdueDisputes(db);
    const after = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, overdueId));
    const escalations = after.filter((e) => e.eventType === 'STATUS_CHANGED' && (e.after as { status?: string } | null)?.status === 'ESCALATED');
    expect(escalations.length).toBe(1);
  });

  it('never escalates a dispute that already has a decision', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);
    const judge = await createStaffUser('ADMIN');
    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, { method: 'POST', body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Closed.' } });
    expect(decided.status).toBe(200);
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(disputes.id, disputeId));

    await escalateOverdueDisputes(db);
    const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(row.status).toBe('DECIDED');
  });

  it('escalates a given dispute exactly once under two concurrent sweeps', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(disputes.id, disputeId));

    await Promise.all([escalateOverdueDisputes(db), escalateOverdueDisputes(db)]);

    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    const escalations = events.filter((e) => e.eventType === 'STATUS_CHANGED' && (e.after as { status?: string } | null)?.status === 'ESCALATED');
    expect(escalations.length).toBe(1);
    const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(row.status).toBe('ESCALATED');
  });

  it('exposes an authenticated admin trigger for the same idempotent sweep', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(disputes.id, disputeId));

    // A party without dispute:manage cannot run the sweep.
    const denied = await buyer.req('/api/admin/disputes/escalate-overdue', { method: 'POST' });
    expect(denied.status).toBe(403);

    const admin = await createStaffUser('ADMIN');
    const ok = await admin.client.req('/api/admin/disputes/escalate-overdue', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ok.data.data.escalated).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(row.status).toBe('ESCALATED');

    // Unauthenticated callers are refused.
    const anon = makeClient();
    const unauth = await anon.req('/api/admin/disputes/escalate-overdue', { method: 'POST' });
    expect(unauth.status).toBe(401);
  });
});
