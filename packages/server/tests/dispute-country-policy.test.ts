import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { suppliers } from '../src/db/schema/trade.js';
import { countries } from '../src/db/schema/geo.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { policies, countryPolicyGaps } from '../src/db/schema/engine.js';
import { disputes } from '../src/db/schema/disputes.js';

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
    body: { email, password: 'StrongPass123!', firstName: 'CP', role },
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

async function createStaff(roleName: 'ADMIN' | 'DISPUTE') {
  const id = randomUUID();
  const email = `it-cp-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

async function countryId(code: string): Promise<string> {
  const [row] = await db.select({ id: countries.id }).from(countries).where(eq(countries.code, code)).limit(1);
  if (!row) throw new Error(`seed missing country ${code}`);
  return row.id;
}

/** Creates a supplier in `code`'s country and an order whose seller is that supplier. */
async function orderInCountry(stamp: string, code: string) {
  const buyer = makeClient();
  const seller = makeClient();
  const buyerId = await registerRole(buyer, `it-cp-buy-${stamp}@wasit.tn`, 'CUSTOMER');
  const sellerUserId = await registerRole(seller, `it-cp-sel-${stamp}@wasit.tn`, 'SUPPLIER');

  const supplierId = `sup-${stamp}-${randomUUID().slice(0, 8)}`;
  await db.insert(suppliers).values({
    id: supplierId,
    userId: sellerUserId,
    companyName: `Supplier ${stamp}`,
    slug: `supplier-${stamp}-${randomUUID().slice(0, 6)}`,
    countryId: await countryId(code),
  });

  const orderId = `ord-cp-${stamp}-${randomUUID().slice(0, 8)}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDCP-${stamp}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId: supplierId,
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
  return { buyer, seller, buyerId, sellerUserId, supplierId, orderId };
}

async function openDispute(buyer: ReturnType<typeof makeClient>, orderId: string): Promise<string> {
  const created = await buyer.req('/api/disputes', {
    method: 'POST',
    body: { orderId, reasonCode: 'NOT_AS_DESCRIBED', description: 'Goods differ from the listing.' },
  });
  expect(created.status).toBe(200);
  return created.data.data.id as string;
}

// A country override is inserted once and shared across the suite.
const FR = 'FR';
let franceId = '';

beforeAll(async () => {
  franceId = await countryId(FR);
  const [existing] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.scope, 'DISPUTE'), eq(policies.code, 'DISPUTE_RESOLUTION'), eq(policies.countryId, franceId)))
    .limit(1);
  if (!existing) {
    await db.insert(policies).values({
      id: randomUUID(),
      scope: 'DISPUTE',
      code: 'DISPUTE_RESOLUTION',
      name: 'France Dispute Resolution Policy',
      description: 'Test override — appeal window is stricter than the global policy.',
      rules: { appealWindowDays: 1 },
      countryId: franceId,
      isActive: true,
      version: 1,
    });
  }
});

describe('Per-Country Dispute Policy (A5)', () => {
  it('records a DECISION_REQUIRED gap and applies the global policy when a country has no override', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, orderId } = await orderInCountry(stamp, 'TN');
    const disputeId = await openDispute(buyer, orderId);

    const detail = await buyer.req(`/api/disputes/${disputeId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.countryCode).toBe('TN');
    expect(detail.data.data.policySource).toBe('GLOBAL');

    const tnId = await countryId('TN');
    const gaps = await db
      .select()
      .from(countryPolicyGaps)
      .where(and(eq(countryPolicyGaps.countryId, tnId), eq(countryPolicyGaps.scope, 'DISPUTE'), eq(countryPolicyGaps.code, 'DISPUTE_RESOLUTION')));
    expect(gaps.length).toBe(1);
    expect(gaps[0].status).toBe('DECISION_REQUIRED');
  });

  it('prefers the country override and reports source=COUNTRY', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, orderId } = await orderInCountry(stamp, FR);
    const disputeId = await openDispute(buyer, orderId);

    const detail = await buyer.req(`/api/disputes/${disputeId}`);
    expect(detail.data.data.countryCode).toBe('FR');
    expect(detail.data.data.policySource).toBe('COUNTRY');
  });

  it('exposes the resolved policy for an order via GET /api/disputes/policies?orderId=', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, orderId } = await orderInCountry(stamp, FR);

    const r = await buyer.req(`/api/disputes/policies?orderId=${orderId}`);
    expect(r.status).toBe(200);
    // Country override sets appealWindowDays=1 and inherits maxAppeals=2 from global.
    expect(r.data.data.source).toBe('COUNTRY');
    expect(r.data.data.countryCode).toBe('FR');
    expect(r.data.data.rules.appealWindowDays).toBe(1);
    expect(r.data.data.rules.maxAppeals).toBeGreaterThan(0);
  });

  it('applies the country appeal window when the appeal arrives too late', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, orderId } = await orderInCountry(stamp, FR);
    const disputeId = await openDispute(buyer, orderId);

    const judge = await createStaff('ADMIN');
    const decided = await judge.client.req(`/api/admin/disputes/${disputeId}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_SELLER', note: 'Seller provided delivery proof.' },
    });
    expect(decided.status).toBe(200);

    // Move the decision back 3 days: beyond FR's 1-day window, inside the global 7-day window.
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.update(disputes).set({ decidedAt: past }).where(eq(disputes.id, disputeId));

    const appeal = await buyer.req(`/api/disputes/${disputeId}/appeals`, {
      method: 'POST',
      body: { reason: 'New delivery evidence was not considered by the reviewer.' },
    });
    expect(appeal.status).toBe(409);
  });

  it('denies the policy admin endpoints to a non-admin role', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const merchant = makeClient();
    await registerRole(merchant, `it-cp-merchant-${stamp}@wasit.tn`, 'MERCHANT');

    const list = await merchant.req('/api/admin/policies/dispute');
    expect(list.status).toBe(403);
    const put = await merchant.req('/api/admin/policies/dispute', {
      method: 'PUT',
      body: { name: 'Nope', rules: { appealWindowDays: 1 }, reason: 'unauthorized attempt' },
    });
    expect(put.status).toBe(403);
  });

  it('lets an admin create a country override, resolve the gap and write an audit trail', async () => {
    const admin = await createStaff('ADMIN');
    const tnId = await countryId('TN');

    // Force the gap to exist by resolving policy for a TN order (global fallback used).
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const { buyer, orderId } = await orderInCountry(stamp, 'TN');
    const resolved = await buyer.req(`/api/disputes/policies?orderId=${orderId}`);
    expect(resolved.data.data.source).toBe('GLOBAL');
    expect(resolved.data.data.countryCode).toBe('TN');

    const before = await db
      .select()
      .from(countryPolicyGaps)
      .where(and(eq(countryPolicyGaps.countryId, tnId), eq(countryPolicyGaps.scope, 'DISPUTE')));
    expect(before.length).toBe(1);
    expect(before[0].status).toBe('DECISION_REQUIRED');

    const put = await admin.client.req('/api/admin/policies/dispute', {
      method: 'PUT',
      body: {
        countryId: tnId,
        name: 'Tunisia Dispute Resolution Policy',
        rules: { appealWindowDays: 5, maxAppeals: 1 },
        reason: 'Legal review set the local dispute rules for Tunisia.',
      },
    });
    expect(put.status).toBe(200);
    expect(put.data.data.created).toBe(true);

    const [row] = await db
      .select()
      .from(policies)
      .where(and(eq(policies.scope, 'DISPUTE'), eq(policies.code, 'DISPUTE_RESOLUTION'), eq(policies.countryId, tnId)))
      .limit(1);
    expect(row).toBeTruthy();
    expect((row.rules as { appealWindowDays: number }).appealWindowDays).toBe(5);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'POLICY.DISPUTE.COUNTRY.CREATED'));
    const mine = audits.find((a) => a.entityId === row.id);
    expect(mine).toBeTruthy();
    expect((mine!.after as { reason?: string }).reason).toContain('Tunisia');

    const after = await db
      .select()
      .from(countryPolicyGaps)
      .where(and(eq(countryPolicyGaps.countryId, tnId), eq(countryPolicyGaps.scope, 'DISPUTE')));
    expect(after.length).toBe(1);
    expect(after[0].status).toBe('RESOLVED');

    // A second update bumps the version and is audited as an update, not a create.
    const put2 = await admin.client.req('/api/admin/policies/dispute', {
      method: 'PUT',
      body: { countryId: tnId, name: 'Tunisia Dispute Resolution Policy', rules: { appealWindowDays: 6 }, reason: 'Appeal window extended after review.' },
    });
    expect(put2.status).toBe(200);
    expect(put2.data.data.created).toBe(false);
    const [row2] = await db.select().from(policies).where(eq(policies.id, row.id)).limit(1);
    expect(row2.version).toBe(2);
  });

  it('validates the policy payload before writing anything', async () => {
    const admin = await createStaff('ADMIN');
    const bad = await admin.client.req('/api/admin/policies/dispute', {
      method: 'PUT',
      body: { name: 'Bad', rules: { appealWindowDays: -5 }, reason: 'negative window attempt' },
    });
    expect([400, 422]).toContain(bad.status);
  });

  it('lists the global policy alongside country overrides and open gaps', async () => {
    const admin = await createStaff('ADMIN');
    const r = await admin.client.req('/api/admin/policies/dispute');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data.items)).toBe(true);
    expect(r.data.data.items.some((p: { countryCode: string | null }) => p.countryCode === null)).toBe(true);
    expect(r.data.data.items.some((p: { countryCode: string | null }) => p.countryCode === FR)).toBe(true);
    expect(Array.isArray(r.data.data.gaps)).toBe(true);
  });
});