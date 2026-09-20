import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { revenueAccounts } from '../src/db/schema/revenue.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { getUnitEconomics, getCustomerCohorts, deriveUnitEconomics } from '../src/modules/analytics/unit-economics.js';

const app = createApp();

function makeClient(initialCookie = '') {
  let cookie = initialCookie;
  return {
    cookie(): string {
      return cookie;
    },
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
      return { data: data as any, status: res.status };
    },
  };
}

/** Register a real CUSTOMER then, for staff roles, grant the role in user_roles. */
async function createUserWithRole(roleName: 'CUSTOMER' | 'ADMIN'): Promise<{ id: string; cookie: string }> {
  const c = makeClient();
  const email = `unit-${roleName}-${Date.now()}-${Math.floor(Math.random() * 100000)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Unit', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const id = (login.data.data as { id: string }).id;
  if (roleName !== 'CUSTOMER') {
    const roleRow = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow[0].id });
  }
  return { id, cookie: c.cookie() };
}

async function insertAdmin(): Promise<string> {
  const id = randomUUID();
  const email = `unit-admin-${Date.now()}-${Math.floor(Math.random() * 100000)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'Admin',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return email;
}

const MARKER = `ue-${Date.now()}`;
// A synthetic 3-letter code no other suite uses: orders/revenue_accounts have no
// FK on currency_code, so every aggregate below sees only this suite's rows and
// we never delete another test's data (the shared DB is not reset between files).
const CUR = 'ZZZ';
const OTHER_CUR = 'YYY';
const seededOrderIds: string[] = [];
const seededAccountIds: string[] = [];

/** Insert a real order row directly so aggregate math is exact and isolated. */
async function insertOrder(opts: {
  buyerId: string;
  itemsTotal: string;
  commission: string;
  buyerCommission?: string;
  paymentFee: string;
  currencyCode?: string;
  paymentStatus?: 'UNPAID' | 'PAID';
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(orders).values({
    id,
    orderNumber: `${MARKER}-${seededOrderIds.length}`,
    buyerId: opts.buyerId,
    buyerType: 'CUSTOMER',
    sellerId: randomUUID(),
    sellerType: 'SUPPLIER',
    currencyCode: opts.currencyCode ?? CUR,
    itemsTotal: opts.itemsTotal,
    grandTotal: opts.itemsTotal,
    commission: opts.commission,
    buyerCommission: opts.buyerCommission ?? '0',
    paymentFee: opts.paymentFee,
    status: 'CONFIRMED',
    paymentStatus: opts.paymentStatus ?? 'PAID',
    createdAt: opts.createdAt ?? new Date(),
  });
  seededOrderIds.push(id);
  return id;
}

async function insertMarketingSpend(amount: string, currencyCode = CUR): Promise<string> {
  const id = randomUUID();
  await db.insert(revenueAccounts).values({
    id,
    lineType: 'COST',
    category: 'MARKETING',
    name: `${MARKER} acquisition`,
    amount,
    currencyCode,
    occurredAt: new Date(),
  });
  seededAccountIds.push(id);
  return id;
}

afterAll(async () => {
  await db.delete(revenueAccounts).where(eq(revenueAccounts.currencyCode, CUR));
  await db.delete(orders).where(eq(orders.currencyCode, CUR));
  await closeDb();
});

describe('deriveUnitEconomics — pure arithmetic', () => {
  it('computes CAC, ARPU, realized/projected LTV and ratios', () => {
    const out = deriveUnitEconomics(
      {
        currencyCode: 'TND',
        windowDays: 30,
        newCustomers: 4,
        marketingSpend: '400.0000',
        customersWithOrders: 10,
        paidOrders: 20,
        grossMarginTotal: '1000.0000',
        gmv: '20000.0000',
      },
      { assumedRetentionMonths: 12, assumedOrdersPerMonth: 2 },
    );
    expect(out.cac).toBe('100.0000'); // 400 / 4
    expect(out.arpu).toBe('100.0000'); // 1000 / 10
    expect(out.ltvRealized).toBe('100.0000');
    expect(out.grossMarginPerOrder).toBe('50.0000'); // 1000 / 20
    expect(out.ltvProjected).toBe('1200.0000'); // 50 * 2 * 12
    expect(out.ltvCacRatio).toBe('1.0000'); // 100 / 100
    expect(out.contributionMarginPct).toBe('5.0000'); // 1000 / 20000
  });

  it('returns null CAC/ratio and zero ARPU when there is no cohort or spend', () => {
    const out = deriveUnitEconomics(
      {
        currencyCode: 'TND',
        windowDays: 30,
        newCustomers: 0,
        marketingSpend: '0.0000',
        customersWithOrders: 0,
        paidOrders: 0,
        grossMarginTotal: '0.0000',
        gmv: '0.0000',
      },
      { assumedRetentionMonths: 12, assumedOrdersPerMonth: 1 },
    );
    expect(out.cac).toBeNull();
    expect(out.ltvCacRatio).toBeNull();
    expect(out.arpu).toBe('0.0000');
    expect(out.contributionMarginPct).toBe('0.0000');
  });

  it('rounds half-up to 4 decimals and never divides by zero GMV', () => {
    const out = deriveUnitEconomics(
      {
        currencyCode: 'TND',
        windowDays: 30,
        newCustomers: 3,
        marketingSpend: '100.0000',
        customersWithOrders: 2,
        paidOrders: 0,
        grossMarginTotal: '10.0000',
        gmv: '0.0000',
      },
      { assumedRetentionMonths: 12, assumedOrdersPerMonth: 1 },
    );
    expect(out.cac).toBe('33.3333'); // 100/3 rounded HALF_UP
    expect(out.grossMarginPerOrder).toBe('0.0000'); // no paid orders
    expect(out.contributionMarginPct).toBe('0.0000');
  });
});

describe('getUnitEconomics — aggregated from real tables', () => {
  it('scopes to currency, separates marketing spend, and derives the cohort', async () => {
    const buyerA = randomUUID();
    const buyerB = randomUUID();
    // buyerA: 2 orders this window (new cohort), buyerB: 1 order
    await insertOrder({ buyerId: buyerA, itemsTotal: '200.0000', commission: '4.0000', buyerCommission: '4.0000', paymentFee: '2.0000' });
    await insertOrder({ buyerId: buyerA, itemsTotal: '100.0000', commission: '2.0000', buyerCommission: '2.0000', paymentFee: '1.0000' });
    await insertOrder({ buyerId: buyerB, itemsTotal: '100.0000', commission: '2.0000', buyerCommission: '2.0000', paymentFee: '1.0000', paymentStatus: 'UNPAID' });
    // Other currency must be excluded entirely (and must NOT create a cohort).
    await insertOrder({ buyerId: randomUUID(), itemsTotal: '9999.0000', commission: '200.0000', buyerCommission: '200.0000', paymentFee: '0.0000', currencyCode: OTHER_CUR });
    await insertMarketingSpend('200.0000');
    await insertMarketingSpend('500.0000', OTHER_CUR); // excluded (currency)

    const out = await getUnitEconomics(db, CUR, 30, { assumedRetentionMonths: 12, assumedOrdersPerMonth: 1 });

    expect(out.currencyCode).toBe(CUR);
    expect(out.newCustomers).toBe(2);
    expect(out.marketingSpend).toBe('200.0000');
    expect(out.cac).toBe('100.0000'); // 200 / 2
    expect(out.customersWithOrders).toBe(2);
    expect(out.paidOrders).toBe(2);
    expect(out.grossMarginTotal).toBe('12.0000'); // (4+2)+(2+1)+(2+1), CUR only
    expect(out.gmv).toBe('400.0000'); // 200+100+100, CUR only
    expect(out.grossMarginPerOrder).toBe('6.0000');
    expect(out.arpu).toBe('6.0000');
    expect(out.ltvProjected).toBe('72.0000'); // 6 * 1 * 12
    expect(out.ltvCacRatio).toBe('0.0600'); // 6 / 100
    expect(out.contributionMarginPct).toBe('3.0000'); // 12 / 400
    expect(out.basedOn.some((s) => s.includes('revenue_accounts COST/MARKETING'))).toBe(true);
  });

  it('excludes marketing spend older than the window', async () => {
    const oldId = randomUUID();
    await db.insert(revenueAccounts).values({
      id: oldId,
      lineType: 'COST',
      category: 'MARKETING',
      name: `${MARKER} old`,
      amount: '100000.0000',
      currencyCode: CUR,
      occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });
    seededAccountIds.push(oldId);

    const out = await getUnitEconomics(db, CUR, 30);
    expect(out.marketingSpend).toBe('200.0000'); // unchanged by the out-of-window line
  });

  it('lists monthly acquisition cohorts with realized GMV and margin', async () => {
    const cohorts = await getCustomerCohorts(db, CUR, 6);
    expect(Array.isArray(cohorts)).toBe(true);
    expect(cohorts.length).toBeGreaterThanOrEqual(1);
    const total = cohorts.reduce((sum, row) => sum + row.customers, 0);
    expect(total).toBe(2);
    for (const row of cohorts) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof row.gmv).toBe('string');
      expect(typeof row.grossMargin).toBe('string');
    }
  });
});

describe('unit economics route — RBAC, validation and audit', () => {
  it('rejects unauthenticated access (401)', async () => {
    const c = makeClient();
    const r = await c.req('/api/admin/analytics/unit-economics');
    expect(r.status).toBe(401);
  });

  it('denies a CUSTOMER (403)', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER');
    const c = makeClient(cookie);
    const r = await c.req('/api/admin/analytics/unit-economics');
    expect(r.status).toBe(403);
  });

  it('serves ADMIN the real metrics and writes an audit entry', async () => {
    const email = await insertAdmin();
    const c = makeClient();
    const login = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const r = await c.req(`/api/admin/analytics/unit-economics?currency=${CUR}&windowDays=30&retentionMonths=12&ordersPerMonth=1`);
    expect(r.status).toBe(200);
    expect(r.data.data.cac).toBe('100.0000');
    expect(r.data.data.ltvProjected).toBe('72.0000');
    expect(r.data.data.currencyCode).toBe(CUR);

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, 'ANALYTICS.UNIT_ECONOMICS_READ')).limit(1);
    expect(audit.length).toBe(1);
  });

  it('rejects an invalid currency/query with 422 field errors', async () => {
    const email = await insertAdmin();
    const c = makeClient();
    await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    const r = await c.req('/api/admin/analytics/unit-economics?currency=TNDX');
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(r.data.error.fieldErrors)).toBe(true);
  });
});