import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { products, categories } from '../src/db/schema/products.js';
import { suppliers } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';
import { reportingCurrency } from '../src/lib/env.js';
import { getUnitEconomics } from '../src/modules/analytics/unit-economics.js';

/**
 * Reporting currency is configuration-derived, and aggregates never mix
 * currencies.
 *
 * Before this, price statistics averaged base prices across products priced in
 * different currencies — a meaningless number presented to the user as a fact.
 * These tests pin the corrected behaviour through the real HTTP route.
 */

const app = createApp();
const created: string[] = [];

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

async function aiClient() {
  const c = makeClient();
  const email = `cur-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Cur', role: 'CUSTOMER' },
  });
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return c;
}

async function firstCategoryId(): Promise<string> {
  const rows = await db.select({ id: categories.id }).from(categories).limit(1);
  if (rows.length === 0) throw new Error('no seeded category available for the test');
  return rows[0].id;
}

async function seedProduct(currencyCode: string, basePrice: string) {
  const userId = randomUUID();
  const supplierId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `cur-sup-${userId.slice(0, 8)}@wasit.tn`,
    passwordHash: 'not-a-real-hash',
    firstName: 'Currency',
    isActive: true,
    emailVerified: true,
  });
  await db.insert(suppliers).values({
    id: supplierId,
    userId,
    companyName: `Currency Test ${supplierId.slice(0, 8)}`,
    slug: `currency-test-${supplierId.slice(0, 8)}`,
    isActive: true,
    verified: true,
  });
  const categoryId = await firstCategoryId();
  const productId = randomUUID();
  await db.insert(products).values({
    id: productId,
    sellerId: supplierId,
    sellerType: 'SUPPLIER',
    sku: `CUR-${productId.slice(0, 8)}`,
    categoryId,
    name: `Currency Product ${productId.slice(0, 8)}`,
    slug: `currency-product-${productId.slice(0, 8)}`,
    basePrice,
    currencyCode,
    isPublished: true,
  });
  created.push(productId);
}

afterAll(async () => {
  if (created.length > 0) await db.delete(products).where(inArray(products.id, created));
  await closeDb();
});

describe('reporting currency is configuration-derived', () => {
  it('exposes the configured reporting currency rather than a hardcoded literal', () => {
    const currency = reportingCurrency();
    expect(currency).toMatch(/^[A-Z]{3}$/);
    expect(currency).toBe(process.env.REPORTING_CURRENCY ?? 'TND');
  });

  it('unit economics echoes an explicitly requested currency', async () => {
    const report = await getUnitEconomics(db, 'EUR', 30);
    expect(report.currencyCode).toBe('EUR');
  });

  it('unit economics defaults to the configured reporting currency', async () => {
    const report = await getUnitEconomics(db);
    expect(report.currencyCode).toBe(reportingCurrency());
  });
});

describe('price intelligence never mixes currencies', () => {
  it('reports the configured currency and excludes other-currency products', async () => {
    const currency = reportingCurrency();
    const other = currency === 'EUR' ? 'USD' : 'EUR';

    await seedProduct(currency, '10.0000');
    await seedProduct(currency, '20.0000');
    // An extreme outlier in a different currency must not shift the band.
    await seedProduct(other, '999999.0000');

    const client = await aiClient();
    const r = await client.req('/api/ai/price-intelligence', { method: 'POST' });
    expect(r.status).toBe(200);
    const data = r.data.data.data as { currencyCode: string; max: string; count: number };
    expect(data.currencyCode).toBe(currency);
    expect(Number(data.max)).toBeLessThan(999999);
  });
});
