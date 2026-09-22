import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { transactionLedger } from '../src/db/schema/commerce.js';
import { eq } from 'drizzle-orm';

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

async function registerLogin(c: ReturnType<typeof makeClient>, email: string, role: string) {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Test', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return login.data.data as { id: string };
}

/** Insert a staff (ADMIN) user directly and log them in. */
async function insertAndLoginAdmin(client: ReturnType<typeof makeClient>) {
  const id = randomUUID();
  const email = `an-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('AdminPass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: 'Admin',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  if (role[0]) {
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  }
  await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
}

afterAll(() => {
  closeDb();
});

describe('Analytics Engine (Phase 16) — real DB-backed', () => {
  it('rejects unauthenticated access to /api/analytics/my-overview (401)', async () => {
    const c = makeClient();
    const r = await c.req('/api/analytics/my-overview');
    expect(r.status).toBe(401);
  });

  it('rejects unauthenticated access to /api/admin/analytics/overview (401)', async () => {
    const c = makeClient();
    const r = await c.req('/api/admin/analytics/overview');
    expect(r.status).toBe(401);
  });

  it('enforces RBAC: CUSTOMER cannot access admin analytics (403)', async () => {
    const c = makeClient();
    await registerLogin(c, `an-cust-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await c.req('/api/admin/analytics/overview');
    expect(r.status).toBe(403);
  });

  it('returns own overview with no business entity for a fresh CUSTOMER', async () => {
    const c = makeClient();
    await registerLogin(c, `an-nobiz-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await c.req('/api/analytics/my-overview');
    expect(r.status).toBe(200);
    const d = r.data.data;
    expect(d.hasBusinessEntity).toBe(false);
    expect(d.products).toBe(0);
    expect(d.ordersAsSeller).toBe(0);
  });

  it('returns real supplier metrics in my-overview after creating products', async () => {
    const c = makeClient();
    const email = `an-supp-${Date.now()}@wasit.tn`;
    await registerLogin(c, email, 'SUPPLIER');

    const profile = await c.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'Analytics Textiles Co' },
    });
    expect(profile.status).toBe(201);
    const supplierId = profile.data.data.id as string;

    const cats = await c.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const ts = Date.now().toString();
    const product = await c.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `AN-SKU-${ts}`,
        categoryId,
        name: `Analytics Cotton ${ts}`,
        basePrice: '10.0000',
        currencyCode: 'TND',
        moq: 5,
        initialQuantity: 200,
        lowStockThreshold: 10,
        quantity: 200,
      },
    });
    expect(product.status).toBe(201);

    const ov = await c.req('/api/analytics/my-overview');
    expect(ov.status).toBe(200);
    const d = ov.data.data;
    expect(d.hasBusinessEntity).toBe(true);
    expect(d.sellerName).toBe('Analytics Textiles Co');
    expect(d.products).toBeGreaterThanOrEqual(1);
    expect(d.publishedProducts).toBeGreaterThanOrEqual(1);
    expect(d.inventoryItems).toBeGreaterThanOrEqual(1);
    expect(d.ordersAsSeller).toBe(0);
  });

  it('creates an order and the platform revenue breakdown reflects commission from the ledger', async () => {
    const supplier = makeClient();
    const buyer = makeClient();

    const supEmail = `an-sup2-${Date.now()}@wasit.tn`;
    const buyEmail = `an-buy-${Date.now()}@wasit.tn`;
    await registerLogin(supplier, supEmail, 'SUPPLIER');
    const buyerUserId = (await registerLogin(buyer, buyEmail, 'CUSTOMER')).id;

    const profile = await supplier.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'Analytics Metals Co' },
    });
    const supplierId = profile.data.data.id as string;

    const cats = await supplier.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const ts = Date.now().toString();
    const product = await supplier.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `AN2-SKU-${ts}`,
        categoryId,
        name: `Analytics Steel ${ts}`,
        basePrice: '20.0000',
        currencyCode: 'TND',
        moq: 3,
        initialQuantity: 100,
        lowStockThreshold: 5,
        quantity: 100,
      },
    });
    expect(product.status).toBe(201);
    const productId = product.data.data.id as string;

    // 5 units x 20 TND = 100 TND; base commission 4% = 4.0 TND (2% seller + 2% buyer)
    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 5 }] },
    });
    expect(order.status).toBe(201);
    const orderData = order.data.data as { orderId: string; itemsTotal: string; commission: string; commissionBuyer: string; transactionId: string };
    expect(orderData.commission).toBe('4.0000');
    expect(orderData.commissionBuyer).toBe('2.0000');

    // No double counting: the order-level `commission` is the TOTAL Wasit commission
    // (seller + buyer), and the ledger's two COMMISSION debits must sum to exactly that.
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, orderData.transactionId));
    const ledgerCommission = ledger
      .filter((e) => e.entryType === 'COMMISSION')
      .reduce((acc, e) => acc + Number(e.amount), 0);
    expect(ledgerCommission).toBe(4);

    // Seller own analytics report the seller's share only (2% of 100 = 2).
    const own = await supplier.req('/api/analytics/my-overview');
    expect(own.status).toBe(200);
    const od = own.data.data;
    expect(od.ordersAsSeller).toBeGreaterThanOrEqual(1);
    expect(Number(od.gmvAsSeller)).toBeGreaterThanOrEqual(100);
    expect(Number(od.commissionAsSeller)).toBeGreaterThanOrEqual(2);

    // Admin revenue breakdown derives platform commission from the ledger (both shares).
    const admin = makeClient();
    await insertAndLoginAdmin(admin);
    const rev = await admin.req('/api/admin/analytics/revenue-breakdown');
    expect(rev.status).toBe(200);
    const rd = rev.data.data;
    expect(typeof rd.transactionValue).toBe('number');
    expect(rd.commission).toBeGreaterThanOrEqual(4);
    expect(rd.transactionValue).toBeGreaterThanOrEqual(100);
    expect(rd.currencyCode).toBe('TND');
  });

  it('exposes platform overview, retention and conversion to ADMIN', async () => {
    const admin = makeClient();
    await insertAndLoginAdmin(admin);

    const ov = await admin.req('/api/admin/analytics/overview');
    expect(ov.status).toBe(200);
    const d = ov.data.data;
    expect(typeof d.users).toBe('number');
    expect(typeof d.gmv).toBe('number');
    expect(typeof d.commission).toBe('number');
    expect(typeof d.activeCampaigns).toBe('number');
    expect(d.currencyCode).toBe('TND');

    const ret = await admin.req('/api/admin/analytics/retention');
    expect(ret.status).toBe(200);
    expect(typeof ret.data.data.retentionRate30d).toBe('number');
    expect(typeof ret.data.data.totalUsers).toBe('number');

    const conv = await admin.req('/api/admin/analytics/conversion');
    expect(conv.status).toBe(200);
    expect(typeof conv.data.data.conversionRate).toBe('number');
    expect(typeof conv.data.data.orders).toBe('number');
  });

  it('captures an analytics event (audited) and lists it back', async () => {
    const c = makeClient();
    await registerLogin(c, `an-evt-${Date.now()}@wasit.tn`, 'MERCHANT');

    const created = await c.req('/api/analytics/events', {
      method: 'POST',
      body: { eventName: 'dashboard.opened', properties: { page: 'analytics' } },
    });
    expect(created.status).toBe(201);
    expect(created.data.data.id).toBeTruthy();

    const list = await c.req('/api/analytics/events?limit=5');
    expect(list.status).toBe(200);
    const items = list.data.data.items as Array<{ eventName: string }>;
    expect(items.some((i) => i.eventName === 'dashboard.opened')).toBe(true);
  });

  it('rejects invalid analytics event names (422)', async () => {
    const c = makeClient();
    await registerLogin(c, `an-bad-${Date.now()}@wasit.tn`, 'MERCHANT');
    const r = await c.req('/api/analytics/events', {
      method: 'POST',
      body: { eventName: 'invalid name with spaces!' },
    });
    expect(r.status).toBe(422);
  });

  it('runs the daily KPI rollup and lists KPIs (admin only)', async () => {
    const admin = makeClient();
    await insertAndLoginAdmin(admin);

    const rollup = await admin.req('/api/admin/analytics/daily-kpis/rollup', { method: 'POST' });
    expect([200, 201]).toContain(rollup.status);
    expect(typeof rollup.data.data.inserted).toBe('number');

    const kpis = await admin.req('/api/admin/analytics/daily-kpis?days=14');
    expect(kpis.status).toBe(200);
    expect(Array.isArray(kpis.data.data.items)).toBe(true);
  });

  it('creates and lists dashboard reports (admin only)', async () => {
    const admin = makeClient();
    await insertAndLoginAdmin(admin);

    const created = await admin.req('/api/admin/analytics/reports', {
      method: 'POST',
      body: { reportCode: 'weekly-gmv', title: 'Weekly GMV', reportData: { period: 'W' } },
    });
    expect(created.status).toBe(201);

    const list = await admin.req('/api/admin/analytics/reports');
    expect(list.status).toBe(200);
    const items = list.data.data.items as Array<{ reportCode: string; reportData: unknown }>;
    const row = items.find((r) => r.reportCode === 'weekly-gmv');
    expect(row).toBeDefined();
    // The saved payload must be readable back, not write-only metadata.
    expect(row!.reportData).toEqual({ period: 'W' });
  });

  it('restricts daily-kpis/rollup to admins (CUSTOMER denied)', async () => {
    const c = makeClient();
    await registerLogin(c, `an-deny-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await c.req('/api/admin/analytics/daily-kpis/rollup', { method: 'POST' });
    expect(r.status).toBe(403);
  });
});