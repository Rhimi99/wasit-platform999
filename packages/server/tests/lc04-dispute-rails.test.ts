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

/**
 * LC-04 — non-financial dispute rails (integration, real DB + real app).
 *
 * The refund financial rail is covered elsewhere. This suite pins the operational
 * guarantees around a dispute: policy-driven windows (open / evidence), the
 * party's right to withdraw, separation of duties for reviewers, and the masking
 * of counterparty contact details. None of it is mocked — the specs drive the
 * real Hono app against a real PostgreSQL, so the SQL predicates and the
 * middleware chain are exercised exactly as in production.
 */

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
    body: { email, password: 'StrongPass123!', firstName: 'LC', role },
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
  const email = `it-lc04-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

/** Buyer + seller (as a user id) with a PAID/DELIVERED order between them. */
async function orderWithParties(stamp: string) {
  const buyer = makeClient();
  const seller = makeClient();
  const buyerId = await registerRole(buyer, `it-lc04-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const sellerId = await registerRole(seller, `it-lc04-sel-${stamp}@wasit.tn`, 'SUPPLIER');

  const orderId = `ord-lc04-${randomUUID().slice(0, 8)}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDLC04-${stamp}`,
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

describe('LC-04 dispute deadlines and windows', () => {
  it('refuses to open a dispute on an order past the policy open window', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    // Seeded openWindowDays is 30; push the order well past it.
    await db.update(orders).set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) }).where(eq(orders.id, orderId));

    const r = await buyer.req('/api/disputes', {
      method: 'POST',
      body: { orderId, reasonCode: 'NOT_AS_DESCRIBED', description: 'Attempting a stale dispute.' },
    });
    expect(r.status).toBe(409);
    const rows = await db.select({ id: disputes.id }).from(disputes).where(eq(disputes.orderId, orderId));
    expect(rows.length).toBe(0);
  });

  it('closes the evidence window after the policy deadline and reports deadlines in the detail', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    // Inside the window: evidence is accepted.
    const ok = await buyer.req(`/api/disputes/${disputeId}/evidence`, {
      method: 'POST',
      body: { fileRef: 's3://bucket/receipt.pdf', contentType: 'application/pdf' },
    });
    expect(ok.status).toBe(200);

    const detail = await buyer.req(`/api/disputes/${disputeId}`);
    expect(detail.status).toBe(200);
    // Concrete deadlines are published, not left for the client to infer.
    expect(detail.data.data.deadlines.evidenceDeadline).toBeTruthy();
    expect(detail.data.data.deadlineStatus.evidenceOpen).toBe(true);

    // Past the 14-day evidence deadline: the window is shut and evidence refused.
    await db.update(disputes).set({ createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }).where(eq(disputes.id, disputeId));
    const late = await buyer.req(`/api/disputes/${disputeId}/evidence`, {
      method: 'POST',
      body: { fileRef: 's3://bucket/late.pdf' },
    });
    expect(late.status).toBe(409);
  });
});

describe('LC-04 dispute withdrawal', () => {
  it('lets the opener withdraw a live dispute and refuses anyone else', async () => {
    const s = stamp();
    const { buyer, seller, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    // The counterparty may not withdraw someone else's case.
    const notOpener = await seller.req(`/api/disputes/${disputeId}/withdraw`, { method: 'POST' });
    expect(notOpener.status).toBe(403);

    const withdrawn = await buyer.req(`/api/disputes/${disputeId}/withdraw`, { method: 'POST' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.data.data.status).toBe('CLOSED');

    const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(row.status).toBe('CLOSED');

    const events = await db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, disputeId));
    expect(events.some((e) => e.eventType === 'STATUS_CHANGED')).toBe(true);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'DISPUTE.WITHDRAWN'));
    expect(audits.some((a) => a.entityId === disputeId)).toBe(true);

    // A closed dispute cannot be withdrawn twice.
    const again = await buyer.req(`/api/disputes/${disputeId}/withdraw`, { method: 'POST' });
    expect(again.status).toBe(409);
  });

  it('refuses to withdraw a dispute that already has a decision', async () => {
    const s = stamp();
    const { buyer, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    const judge = await createStaffUser('ADMIN');
    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Seller provided delivery proof.' },
    });
    expect(decided.status).toBe(200);

    const r = await buyer.req(`/api/disputes/${disputeId}/withdraw`, { method: 'POST' });
    expect(r.status).toBe(409);
  });
});

describe('LC-04 separation of duties', () => {
  it('refuses a reviewer who is also a party to the order', async () => {
    const s = stamp();
    const { buyer, orderId, sellerId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    // Grant the seller's user an ADMIN role; they are still a party to the order.
    const [adminRole] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
    expect(adminRole).toBeTruthy();
    await db.insert(userRoles).values({ id: randomUUID(), userId: sellerId, roleId: adminRole.id });
    const sellerClient = makeClient();
    const sellerEmail = (await db.select({ email: users.email }).from(users).where(eq(users.id, sellerId)).limit(1))[0].email;
    const login = await sellerClient.req('/api/auth/login', {
      method: 'POST',
      body: { email: sellerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const selfDecide = await sellerClient.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Ruling on my own order.' },
    });
    expect(selfDecide.status).toBe(403);

    // A neutral admin can still decide the same dispute.
    const neutral = await createStaffUser('ADMIN');
    const ok = await neutral.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Independent review.' },
    });
    expect(ok.status).toBe(200);
  });
});

describe('LC-04 counterparty privacy', () => {
  it('masks a counterparty email for a party but shows it in full to staff', async () => {
    const s = stamp();
    const { buyer, seller, orderId } = await orderWithParties(s);
    const disputeId = await openDispute(buyer, orderId);

    const sellerMsg = await seller.req(`/api/disputes/${disputeId}/messages`, {
      method: 'POST',
      body: { body: 'Here is our delivery record.' },
    });
    expect(sellerMsg.status).toBe(200);

    const buyerView = await buyer.req(`/api/disputes/${disputeId}`);
    expect(buyerView.status).toBe(200);
    const sellerEmail = (await db.select({ email: users.email }).from(users).where(eq(users.id, (await db.select({ sellerId: orders.sellerId }).from(orders).where(eq(orders.id, orderId)).limit(1))[0].sellerId!)).limit(1))[0].email;
    const seen = buyerView.data.data.messages[0].senderEmail as string;
    expect(seen).not.toBe(sellerEmail);
    expect(seen).toContain('***');
    expect(seen.endsWith('@wasit.tn')).toBe(true);

    const staff = await createStaffUser('DISPUTE');
    const staffView = await staff.client.req(`/api/admin/disputes/${disputeId}`);
    expect(staffView.status).toBe(200);
    expect(staffView.data.data.messages[0].senderEmail).toBe(sellerEmail);
  });
});

describe('LC-04 public refund policy surface', () => {
  it('serves the policy windows anonymously and labels itself operational-only', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/public/disputes/refund-policy');
    expect(r.status).toBe(200);
    expect(r.data.data.operationalSummaryOnly).toBe(true);
    expect(r.data.data.windows.openWindowDays).toBeGreaterThan(0);
    expect(r.data.data.windows.evidenceDeadlineDays).toBeGreaterThan(0);
    // No case data and no internal policy id leak through this surface.
    expect(JSON.stringify(r.data.data)).not.toContain('decisionEffects');
  });

  it('resolves a country override for a known country code', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/public/disputes/refund-policy?country=TN');
    expect(r.status).toBe(200);
    expect(r.data.data.countryCode).toBe('TN');
  });

  it('treats an unknown country code as no country context rather than an error', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/public/disputes/refund-policy?country=ZZ');
    expect(r.status).toBe(200);
    expect(r.data.data.countryCode).toBeNull();
  });
});
