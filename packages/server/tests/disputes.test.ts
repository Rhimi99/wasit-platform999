import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { policies } from '../src/db/schema/engine.js';
import { disputes, disputeAppeals, disputeEvents } from '../src/db/schema/disputes.js';
import { notifications } from '../src/db/schema/messaging.js';

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

async function registerRole(c: ReturnType<typeof makeClient>, email: string, role: string): Promise<string> {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'DA', role },
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

async function createStaffUser(roleName: 'ADMIN' | 'DISPUTE' | 'SUPPORT') {
  const id = randomUUID();
  const email = `it-appeal-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

/**
 * Builds an order + dispute and drives it to DECIDED via the real API, returning
 * both parties' clients plus the resulting ids.
 */
async function decidedDispute(stamp: string) {
  const buyer = makeClient();
  const seller = makeClient();
  const buyerId = await registerRole(buyer, `it-app-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const sellerId = await registerRole(seller, `it-app-sel-${stamp}@wasit.tn`, 'SUPPLIER');

  const orderId = `ord-${stamp}-${randomUUID().slice(0, 8)}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORD-${stamp}`,
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

  const created = await buyer.req('/api/disputes', {
    method: 'POST',
    body: { orderId, reasonCode: 'NOT_AS_DESCRIBED', description: 'Goods differ from the listing.' },
  });
  expect(created.status).toBe(200);
  const disputeId = created.data.data.id as string;

  const judge = await createStaffUser('ADMIN');
  const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
    method: 'POST',
    body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Seller provided delivery proof.' },
  });
  expect(decided.status).toBe(200);
  return { buyer, seller, buyerId, sellerId, disputeId, orderId, judge };
}

describe('Dispute Appeal (A4)', () => {
  it('lets a party appeal a decided dispute and lists it back with the appeal', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId } = await decidedDispute(stamp);

    const created = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'New delivery evidence was not considered by the reviewer.' },
    });
    expect(created.status).toBe(200);
    const appealId = created.data.data.id as string;

    const [row] = await db.select().from(disputeAppeals).where(eq(disputeAppeals.id, appealId)).limit(1);
    expect(row).toBeTruthy();
    expect(row.disputeId).toBe(disputeId);
    expect(row.status).toBe('PENDING');
    expect(row.appealedById).toBeTruthy();

    // APPEALED event written
    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(events.some((e) => e.eventType === 'APPEALED')).toBe(true);

    // Audit trail written
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'DISPUTE.APPEAL.CREATED'));
    expect(audits.some((a) => a.entityId === disputeId)).toBe(true);

    // Appeal is visible via the dispute detail and the dedicated list
    const detail = await buyer.req(`/api/disputes/${disputeId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.appeals.length).toBe(1);
    const list = await buyer.req(`/api/disputes/${disputeId}/appeals`);
    expect(list.status).toBe(200);
    expect(list.data.data.items.length).toBe(1);
    expect(list.data.data.items[0].status).toBe('PENDING');
  });

  it('rejects a non-party from appealing and a non-party from reading appeals', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { disputeId } = await decidedDispute(stamp);
    const outsider = makeClient();
    await registerRole(outsider, `it-app-out-${stamp}@wasit.tn`, 'CUSTOMER');

    const appeal = await outsider.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'I have nothing to do with this order but want to appeal.' },
    });
    expect(appeal.status).toBe(403);

    const read = await outsider.req(`/api/disputes/${disputeId}/appeals`);
    expect(read.status).toBe(403);
  });

  it('refuses to appeal a dispute that is still open / not yet decided', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const buyer = makeClient();
    const buyerId = await registerRole(buyer, `it-app-open-${stamp}@wasit.tn`, 'CUSTOMER');
    const sellerId = randomUUID();
    const orderId = `ord-${stamp}-open`;
    await db.insert(orders).values({
      id: orderId, orderNumber: `ORD-OPEN-${stamp}`, buyerId, buyerType: 'CUSTOMER', sellerId, sellerType: 'SUPPLIER',
      currencyCode: 'TND', itemsTotal: '50.0000', commission: '1.0000', buyerCommission: '1.0000', paymentFee: '0', grandTotal: '50.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });
    const created = await buyer.req('/api/disputes', {
      method: 'POST',
      body: { orderId, reasonCode: 'LATE_DELIVERY', description: 'The order arrived far later than promised.' },
    });
    const disputeId = created.data.data.id as string;

    const appeal = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Attempting to appeal before any decision exists.' },
    });
    expect(appeal.status).toBe(409);
  });

  it('prevents a second appeal while one is pending and enforces maxAppeals from policy', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId } = await decidedDispute(stamp);
    const reviewer = await createStaffUser('ADMIN');

    const first = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'First appeal with the evidence the reviewer missed.' },
    });
    expect(first.status).toBe(200);
    const appealId = first.data.data.id as string;

    // Duplicate while pending
    const dup = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Second appeal submitted while the first is still pending.' },
    });
    expect(dup.status).toBe(409);

    // Reviewer rejects the pending appeal; maxAppeals (seeded = 1) then blocks a new one
    const reviewed = await reviewer.client.req(`/api/admin/disputes/${disputeId}/appeals/${appealId}/review`, {
      method: 'POST',
      body: { status: 'REJECTED', note: 'The evidence was already considered.' },
    });
    expect(reviewed.status).toBe(200);

    const again = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Trying again after the maximum number of appeals.' },
    });
    expect(again.status).toBe(409);
  });

  it('enforces the appeal window from policy and honours appealAllowed=false', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId } = await decidedDispute(stamp);

    // Force the decision far beyond the seeded 7-day window.
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.update(disputes).set({ decidedAt: past }).where(eq(disputes.id, disputeId));
    const expired = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Appeal submitted long after the window closed.' },
    });
    expect(expired.status).toBe(409);

    // Re-enable the window but disable appeals on the dispute.
    await db.update(disputes).set({ decidedAt: new Date(), appealAllowed: false }).where(eq(disputes.id, disputeId));
    const disallowed = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Appeal attempted on a dispute where appeals are disabled.' },
    });
    expect(disallowed.status).toBe(409);
  });

  it('accepting an appeal reopens the dispute, disables further appeals and notifies the appellant', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId } = await decidedDispute(stamp);
    const reviewer = await createStaffUser('ADMIN');

    const created = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Please reconsider; new delivery evidence is attached.' },
    });
    const appealId = created.data.data.id as string;

    const reviewed = await reviewer.client.req(`/api/admin/disputes/${disputeId}/appeals/${appealId}/review`, {
      method: 'POST',
      body: { status: 'ACCEPTED', note: 'Reopening to review the new evidence.' },
    });
    expect(reviewed.status).toBe(200);

    const [appeal] = await db.select().from(disputeAppeals).where(eq(disputeAppeals.id, appealId)).limit(1);
    expect(appeal.status).toBe('ACCEPTED');
    expect(appeal.decidedBy).toBe(reviewer.id);
    expect(appeal.decidedAt).toBeTruthy();

    const [disp] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(disp.status).toBe('UNDER_REVIEW');
    expect(disp.appealAllowed).toBe(false);

    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(events.some((e) => e.eventType === 'REOPENED')).toBe(true);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'DISPUTE.APPEAL.REVIEWED'));
    expect(audits.some((a) => a.entityId === disputeId)).toBe(true);

    const notif = await db.select().from(notifications).where(eq(notifications.type, 'DISPUTE.APPEAL.DECIDED'));
    expect(notif.some((n) => n.userId === disp.openedById)).toBe(true);
  });

  it('recuses the original decision-maker from reviewing the appeal of their own decision', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId, judge } = await decidedDispute(stamp);

    const created = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Requesting a fresh review of the original decision.' },
    });
    const appealId = created.data.data.id as string;

    const selfReview = await judge.client.req(`/api/admin/disputes/${disputeId}/appeals/${appealId}/review`, {
      method: 'POST',
      body: { status: 'REJECTED', note: 'Reviewing my own decision.' },
    });
    expect(selfReview.status).toBe(403);

    // A different reviewer with the same permission can review it.
    const other = await createStaffUser('ADMIN');
    const ok = await other.client.req(`/api/admin/disputes/${disputeId}/appeals/${appealId}/review`, {
      method: 'POST',
      body: { status: 'REJECTED', note: 'Independent review; decision stands.' },
    });
    expect(ok.status).toBe(200);
  });

  it('validates the appeal payload', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, disputeId } = await decidedDispute(stamp);
    const tooShort = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'no' },
    });
    expect(tooShort.status).toBe(422);
  });

  it('requires authentication to file an appeal', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { disputeId } = await decidedDispute(stamp);
    const anon = makeClient();
    const r = await anon.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'Anonymous attempt to appeal this dispute.' },
    });
    expect(r.status).toBe(401);
  });

  it('exposes appeal rules through the dispute policy endpoint', async () => {
    const c = makeClient();
    await registerRole(c, `it-app-pol-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await c.req('/api/disputes/policies');
    expect(r.status).toBe(200);
    expect(r.data.data.rules.appealWindowDays).toBeGreaterThan(0);
    expect(r.data.data.rules.maxAppeals).toBeGreaterThan(0);
    // The global policy row (no country) is the source of truth for the fallback.
    const rows = await db.select().from(policies).where(and(eq(policies.code, 'DISPUTE_RESOLUTION'), isNull(policies.countryId)));
    expect(rows.length).toBe(1);
  });
});