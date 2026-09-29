import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { verificationDocuments, verificationRequests } from '../src/db/schema/trust.js';
import { disputes, disputeEvents, disputeMessages, disputeEvidence } from '../src/db/schema/disputes.js';
import { notifications } from '../src/db/schema/messaging.js';
import { policies } from '../src/db/schema/engine.js';
import { orders, payments } from '../src/db/schema/commerce.js';
import { eq, sql } from 'drizzle-orm';

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

async function registerRole(c: ReturnType<typeof makeClient>, email: string, role: string) {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'VT', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

async function createStaffUser(roleName: 'ADMIN' | 'RISK' | 'DISPUTE' | 'SUPPORT') {
  const id = randomUUID();
  const email = `it-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) {
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  }
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

function nextOrderId(): string {
  return `ord-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

describe('Verification Engine', () => {
  it('exposes verification policies from the Policy Engine', async () => {
    const c = makeClient();
    await registerRole(c, `it-ver-pol-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const rows = await db.select().from(policies).where(eq(policies.scope, 'VERIFICATION'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const r = await c.req('/api/verification/policies');
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.data.length).toBeGreaterThanOrEqual(4);
  });

  it('returns my verification status with current level NONE initially', async () => {
    const c = makeClient();
    const email = `it-ver-${Date.now()}@wasit.tn`;
    await registerRole(c, email, 'CUSTOMER');
    const r = await c.req('/api/verification/me');
    expect(r.status).toBe(200);
    expect(r.data.data.currentLevel).toBe('NONE');
    expect(r.data.data.emailVerified).toBe(false);
  });

  it('submits a BASIC verification request and lists it', async () => {
    const c = makeClient();
    const email = `it-ver2-${Date.now()}@wasit.tn`;
    await registerRole(c, email, 'CUSTOMER');
    const r = await c.req('/api/verification/requests', {
      method: 'POST',
      body: { targetLevel: 'BASIC', documentType: 'ID_CARD', documentRef: 'TN-12345678' },
    });
    expect(r.status).toBe(200);
    const requestId = r.data.data.id as string;

    const rows = await db.select().from(verificationRequests).where(eq(verificationRequests.id, requestId));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('SUBMITTED');
    const docs = await db.select().from(verificationDocuments).where(eq(verificationDocuments.requestId, requestId));
    expect(docs.length).toBe(1);

    const list = await c.req('/api/verification/requests');
    expect(list.status).toBe(200);
    expect(list.data.data.items.some((i: { id: string }) => i.id === requestId)).toBe(true);

    // Cannot submit twice while pending
    const dup = await c.req('/api/verification/requests', {
      method: 'POST',
      body: { targetLevel: 'BASIC', documentType: 'ID_CARD' },
    });
    expect(dup.status).toBe(409);
  });

  it('prevents non-admin from reviewing verification requests', async () => {
    const c = makeClient();
    const email = `it-ver3-${Date.now()}@wasit.tn`;
    await registerRole(c, email, 'CUSTOMER');
    const submitted = await c.req('/api/verification/requests', {
      method: 'POST',
      body: { targetLevel: 'BASIC' },
    });
    expect(submitted.status).toBe(200);
    const requestId = submitted.data.data.id as string;
    const r = await c.req(`/api/admin/verification/requests/${requestId}/review`, {
      method: 'POST',
      body: { decision: 'APPROVED' },
    });
    expect(r.status).toBe(403);
  });

  it('admin approves a verification request and triggers a notification', async () => {
    const user = makeClient();
    const email = `it-ver4-${Date.now()}@wasit.tn`;
    await registerRole(user, email, 'CUSTOMER');
    const submitted = await user.req('/api/verification/requests', {
      method: 'POST',
      body: { targetLevel: 'BASIC' },
    });
    expect(submitted.status).toBe(200);
    const requestId = submitted.data.data.id as string;

    const admin = await createStaffUser('ADMIN');
    const review = await admin.client.req(`/api/admin/verification/requests/${requestId}/review`, {
      method: 'POST',
      body: { decision: 'APPROVED', notes: 'Docs look good' },
    });
    expect(review.status).toBe(200);

    const rows = await db.select().from(verificationRequests).where(eq(verificationRequests.id, requestId));
    expect(rows[0].status).toBe('APPROVED');
    expect(rows[0].reviewedById).toBe(admin.id);

    const me = await user.req('/api/verification/me');
    expect(me.data.data.currentLevel).toBe('BASIC');

    const notif = await db.select().from(notifications).where(eq(notifications.type, 'VERIFICATION.DECISION'));
    expect(notif.some((n) => n.userId === rows[0].userId && n.data && JSON.stringify(n.data).includes('APPROVED'))).toBe(true);
  });
});

describe('Trust Engine', () => {
  it('computes a trust score, persists a snapshot, and returns history', async () => {
    const c = makeClient();
    const email = `it-trust-${Date.now()}@wasit.tn`;
    await registerRole(c, email, 'CUSTOMER');

    const r = await c.req('/api/trust/me');
    expect(r.status).toBe(200);
    expect(r.data.data).toHaveProperty('historyCount');

    const recompute = await c.req('/api/trust/me/recompute', { method: 'POST' });
    expect(recompute.status).toBe(200);
    expect(typeof recompute.data.data.score.score).toBe('number');
    expect(recompute.data.data.history.length).toBeGreaterThan(0);

    const history = await c.req('/api/trust/me/history');
    expect(history.status).toBe(200);
    expect(history.data.data.items.length).toBeGreaterThan(0);
  });
});

describe('Risk Engine', () => {
  it('blocks CUSTOMER from reading risk profiles', async () => {
    const c = makeClient();
    await registerRole(c, `it-risk-cust-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await c.req('/api/risk/profiles');
    expect(r.status).toBe(403);
  });

  it('RISK role can list profiles and reassess a user', async () => {
    const risk = await createStaffUser('RISK');
    const target = makeClient();
    const email = `it-risk-target-${Date.now()}@wasit.tn`;
    await registerRole(target, email, 'CUSTOMER');

    const profiles = await risk.client.req('/api/risk/profiles');
    expect(profiles.status).toBe(200);

    // Find user id from DB
    const [targetUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const reassess = await risk.client.req(`/api/risk/profiles/${targetUser.id}/reassess`, { method: 'POST' });
    expect(reassess.status).toBe(200);
    expect(reassess.data.data).toHaveProperty('currentScore');

    const events = await risk.client.req('/api/risk/events');
    expect(events.status).toBe(200);
  });
});

describe('Dispute Center', () => {
  it('creates a dispute from an order, lists it, and staff can decide', async () => {
    // Create buyer + seller users
    const buyer = makeClient();
    const seller = makeClient();
    const stamp = Date.now().toString();
    await registerRole(buyer, `it-disp-buy-${stamp}@wasit.tn`, 'CUSTOMER');
    await registerRole(seller, `it-disp-sel-${stamp}@wasit.tn`, 'SUPPLIER');

    // create an order via the vertical slice helper (create order directly referencing an existing product)
    // If no products exist, we create one via the real service chain.
    // Instead we insert an order row directly for the dispute test with a participant seller.
    // To satisfy isOrderParticipant we need buyer_id == buyerUserId OR seller in owned sellers.
    const [buyerUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, `it-disp-buy-${stamp}@wasit.tn`)).limit(1);
    const [sellerUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, `it-disp-sel-${stamp}@wasit.tn`)).limit(1);

    const orderId = nextOrderId();
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `ORD-${stamp}`,
      buyerId: buyerUser.id,
      buyerType: 'CUSTOMER',
      sellerId: sellerUser.id,
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
    // A PAID order implies a payment record; the refund rail that a
    // buyer-favourable dispute decision drives through requires one.
    await db.insert(payments).values({
      id: randomUUID(),
      transactionId: randomUUID(),
      orderId,
      amount: '100.0000',
      currencyCode: 'TND',
      provider: 'manual',
      externalRef: `vt-ref-${stamp}`,
      status: 'PAID',
    });

    const created = await buyer.req('/api/disputes', {
      method: 'POST',
      body: { orderId, reasonCode: 'NOT_RECEIVED', description: 'Product arrived damaged and not as described.' },
    });
    expect(created.status).toBe(200);
    const disputeId = created.data.data.id as string;

    // Dispute persisted + event written
    const disp = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(disp.length).toBe(1);
    expect(disp[0].status).toBe('OPEN');
    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].eventType).toBe('CREATED');

    // A non-participant can't view
    const outsider = makeClient();
    await registerRole(outsider, `it-disp-out-${stamp}@wasit.tn`, 'CUSTOMER');
    const denied = await outsider.req(`/api/disputes/${disputeId}`);
    expect(denied.status).toBe(403);

    // Buyer can add a message + evidence
    const msg = await buyer.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'Please review the photos I uploaded.' } });
    expect(msg.status).toBe(200);
    const evid = await buyer.req(`/api/disputes/${disputeId}/evidence`, {
      method: 'POST',
      body: { fileRef: '/uploads/damage.jpg', description: 'Damaged box photo', contentType: 'image/jpeg' },
    });
    expect(evid.status).toBe(200);
    const msgRows = await db.select().from(disputeMessages).where(eq(disputeMessages.disputeId, disputeId));
    expect(msgRows.length).toBe(1);
    const evRows = await db.select().from(disputeEvidence).where(eq(disputeEvidence.disputeId, disputeId));
    expect(evRows.length).toBe(1);

    // Seller (party) can view and message
    const selList = await seller.req('/api/disputes');
    expect(selList.status).toBe(200);
    expect(selList.data.data.items.some((i: { id: string }) => i.id === disputeId)).toBe(true);
    const selReply = await seller.req(`/api/disputes/${disputeId}/messages`, { method: 'POST', body: { body: 'The item was shipped on time; claimed damage is false.' } });
    expect(selReply.status).toBe(200);

    // Admin assigns + decides
    const admin = await createStaffUser('ADMIN');
    const assigned = await admin.client.req(`/api/admin/disputes/${disputeId}/assign`, {
      method: 'POST',
      body: { reviewerUserId: admin.id },
    });
    expect(assigned.status).toBe(200);

    const decided = await admin.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER', note: 'Evidence supports the buyer' },
    });
    expect(decided.status).toBe(200);

    const after = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(after[0].status).toBe('DECIDED');
    expect(after[0].decision).toBe('IN_FAVOR_OF_BUYER');
    expect(after[0].decidedBy).toBe(admin.id);

    // Decision notification created
    const notif = await db.select().from(notifications).where(eq(notifications.type, 'DISPUTE.DECISION'));
    expect(notif.some((n) => n.userId === disp[0].openedById)).toBe(true);

    // Detail includes events/messages/evidence
    const detail = await buyer.req(`/api/disputes/${disputeId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.events.length).toBeGreaterThanOrEqual(3);
    expect(detail.data.data.messages.length).toBe(2);
    expect(detail.data.data.evidence.length).toBe(1);
  });

  it('prevents a customer from opening a dispute on an order they did not participate in', async () => {
    const a = makeClient();
    const b = makeClient();
    const stamp = Date.now().toString();
    await registerRole(a, `it-disp-a-${stamp}@wasit.tn`, 'CUSTOMER');
    await registerRole(b, `it-disp-b-${stamp}@wasit.tn`, 'CUSTOMER');
    const [bUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, `it-disp-b-${stamp}@wasit.tn`)).limit(1);

    const orderId = nextOrderId();
    await db.insert(orders).values({
      id: orderId,
      orderNumber: `ORD-${stamp}-X`,
      buyerId: bUser.id,
      buyerType: 'CUSTOMER',
      sellerId: randomUUID(),
      sellerType: 'SUPPLIER',
      currencyCode: 'TND',
      itemsTotal: '50.0000',
      commission: '1.0000',
      buyerCommission: '1.0000',
      paymentFee: '0',
      grandTotal: '50.0000',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    });
    const r = await a.req('/api/disputes', {
      method: 'POST',
      body: { orderId, reasonCode: 'QUALITY_ISSUE', description: 'I want a refund for poor quality.' },
    });
    expect(r.status).toBe(403);
  });
});

afterAll(() => {
  closeDb();
});