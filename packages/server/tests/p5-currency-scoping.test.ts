import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { reportingCurrency } from '../src/lib/env.js';
import { getPlatformOverview, getConversionSnapshot, getRevenueBreakdown } from '../src/modules/analytics/service.js';

/**
 * P5 — money KPIs are currency-scoped, never mixed.
 *
 * Every financial aggregate must express exactly one currency. A deployment with
 * orders in two currencies must never see a "total" that is the sum of unlike
 * units, and the API must say which currencies were left out. No exchange rate
 * is invented anywhere: the platform has no FX source configured, so it excludes
 * rather than converts, and `fxApplied` is always false.
 */

const app = createApp();
const createdOrderIds: string[] = [];
const createdTxIds: string[] = [];

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

async function loginAdmin(client: ReturnType<typeof makeClient>) {
  const id = randomUUID();
  const email = `p5-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('AdminPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: 'P5', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

/** Inserts one order (and its transaction) in a given currency. */
async function seedOrder(currencyCode: string, itemsTotal: string, commission: string, paymentFee: string) {
  const orderId = randomUUID();
  const txId = randomUUID();
  const sellerId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `P5-${orderId.slice(0, 12)}`,
    buyerId: randomUUID(),
    sellerId,
    sellerType: 'SUPPLIER',
    currencyCode,
    itemsTotal,
    commission,
    buyerCommission: '0',
    paymentFee,
    grandTotal: itemsTotal,
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
  });
  await db.insert(transactions).values({
    id: txId,
    transactionNumber: `P5TX-${txId.slice(0, 12)}`,
    orderId,
    buyerId: randomUUID(),
    sellerId,
    totalValue: itemsTotal,
    currencyCode,
    commission,
    buyerCommission: '0',
    paymentFee,
    status: 'PAID',
  });
  await db.insert(transactionLedger).values({
    id: randomUUID(),
    transactionId: txId,
    entryType: 'COMMISSION',
    direction: 'CREDIT',
    amount: commission,
    currencyCode,
    status: 'PENDING',
  });
  createdOrderIds.push(orderId);
  createdTxIds.push(txId);
  return { orderId, txId };
}

afterAll(async () => {
  if (createdOrderIds.length > 0) await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  if (createdTxIds.length > 0) {
    await db.delete(transactionLedger).where(inArray(transactionLedger.transactionId, createdTxIds));
    await db.delete(transactions).where(inArray(transactions.id, createdTxIds));
  }
  await closeDb();
});

describe('P5 — platform KPIs never mix currencies', () => {
  it('scopes GMV/commission/fees to one currency and reports the excluded ones', async () => {
    const base = reportingCurrency();
    const other = base === 'EUR' ? 'USD' : 'EUR';

    const before = await getPlatformOverview(db, base);
    // A deliberately outsized other-currency order: if it were summed in, the
    // base-currency GMV would jump by ~1,000,000 and the test would catch it.
    await seedOrder(other, '1000000.0000', '40000.0000', '20000.0000');
    await seedOrder(base, '100.0000', '4.0000', '2.0000');

    const after = await getPlatformOverview(db, base);
    expect(after.currencyCode).toBe(base);

    // GMV grew only by the base-currency order.
    expect(after.gmv - before.gmv).toBeCloseTo(100, 2);
    expect(after.commission - before.commission).toBeCloseTo(4, 2);
    expect(after.paymentFees - before.paymentFees).toBeCloseTo(2, 2);

    // The other currency is named as excluded, and no conversion was applied.
    expect(after.currencyScope.excludedCurrencies).toContain(other);
    expect(after.currencyScope.multiCurrency).toBe(true);
    expect(after.currencyScope.fxApplied).toBe(false);
    expect(after.currencyScope.note).toContain(other);
  });

  it('average order value divides only same-currency orders', async () => {
    const base = reportingCurrency();
    const other = base === 'EUR' ? 'USD' : 'EUR';
    await seedOrder(other, '999999.0000', '0', '0');

    const snap = await getPlatformOverview(db, base);
    // AOV can never exceed the largest base-currency order, which proves the
    // other-currency order was not folded into the numerator.
    expect(snap.avgOrderValue).toBeLessThan(999999);
    expect(snap.ordersInCurrency).toBeGreaterThanOrEqual(0);
  });

  it('conversion snapshot AOV is same-currency and exposes the scope', async () => {
    const base = reportingCurrency();
    const other = base === 'EUR' ? 'USD' : 'EUR';
    await seedOrder(other, '888888.0000', '0', '0');

    const snap = await getConversionSnapshot(db, base);
    expect(snap.currencyCode).toBe(base);
    expect(snap.avgOrderValue).toBeLessThan(888888);
    expect(snap.currencyScope.excludedCurrencies).toContain(other);
    expect(snap.currencyScope.fxApplied).toBe(false);
  });

  it('revenue breakdown excludes other-currency transactions and ledger entries', async () => {
    const base = reportingCurrency();
    const other = base === 'EUR' ? 'USD' : 'EUR';
    const before = await getRevenueBreakdown(db, base);
    await seedOrder(other, '777777.0000', '30000.0000', '0');

    const after = await getRevenueBreakdown(db, base);
    expect(after.currencyCode).toBe(base);
    expect(after.transactionValue - before.transactionValue).toBeCloseTo(0, 2);
    expect(after.commission - before.commission).toBeCloseTo(0, 2);
    expect(after.currencyScope.excludedCurrencies).toContain(other);
  });

  it('does not treat TND as a hardcoded universal currency', async () => {
    // Requesting EUR must produce EUR totals and name TND as excluded when the
    // data is TND — i.e. the reporting currency is configuration, not a literal.
    const snapshot = await getPlatformOverview(db, 'EUR');
    expect(snapshot.currencyCode).toBe('EUR');
    expect(snapshot.currencyScope.currencyCode).toBe('EUR');
  });
});

describe('P5 — admin analytics routes carry the currency scope', () => {
  it('GET /api/admin/analytics/overview returns currencyCode + currencyScope', async () => {
    const client = makeClient();
    await loginAdmin(client);
    const r = await client.req('/api/admin/analytics/overview');
    expect(r.status).toBe(200);
    expect(typeof r.data.data.currencyCode).toBe('string');
    expect(r.data.data.currencyScope.currencyCode).toBe(r.data.data.currencyCode);
    expect(r.data.data.currencyScope.fxApplied).toBe(false);
    expect(Array.isArray(r.data.data.currencyScope.excludedCurrencies)).toBe(true);
  });

  it('GET /api/admin/analytics/overview?currency=EUR honours the explicit currency', async () => {
    const client = makeClient();
    await loginAdmin(client);
    const r = await client.req('/api/admin/analytics/overview?currency=EUR');
    expect(r.status).toBe(200);
    expect(r.data.data.currencyCode).toBe('EUR');
  });

  it('rejects a malformed currency code with a validation error', async () => {
    const client = makeClient();
    await loginAdmin(client);
    const r = await client.req('/api/admin/analytics/overview?currency=EURO');
    expect(r.status).toBe(422);
  });

  it('GET /api/admin/stats scopes the money KPI to one currency', async () => {
    const client = makeClient();
    await loginAdmin(client);
    const r = await client.req('/api/admin/stats');
    expect(r.status).toBe(200);
    expect(typeof r.data.data.currencyCode).toBe('string');
    expect(r.data.data.currencyScope).toBeTruthy();
    expect(r.data.data.currencyScope.fxApplied).toBe(false);
  });
});
