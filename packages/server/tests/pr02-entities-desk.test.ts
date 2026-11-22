import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { merchants, suppliers, companies } from '../src/db/schema/trade.js';
import { products, categories } from '../src/db/schema/products.js';
import { orders } from '../src/db/schema/commerce.js';
import { disputes } from '../src/db/schema/disputes.js';
import { trustScores, verificationRequests } from '../src/db/schema/trust.js';
import { eq } from 'drizzle-orm';

/**
 * PR-02 slice 1 — Entities Desk.
 *
 * Runs against the real app and the real database: real sessions, real rows, no
 * mocked aggregates. Every figure asserted below is computed by the query under
 * test from rows this file inserts, so a desk that guessed or hard-coded a number
 * would fail here.
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

async function makeUser(emailPrefix: string, role: string, password = 'Passw0rd!2026') {
  const id = randomUUID();
  const email = `${emailPrefix}-${randomUUID().slice(0, 8)}@wasit.test`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: emailPrefix,
    isActive: true,
    emailVerified: true,
  });
  const roleRow = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow[0]!.id });
  return { id, email, password };
}

async function login(prefix: string, role: string) {
  const user = await makeUser(prefix, role);
  const client = makeClient();
  const res = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
  });
  expect(res.status).toBe(200);
  return { client, user };
}

/** Unique-enough suffixes so parallel runs never collide on unique columns. */
const tag = () => randomUUID().slice(0, 8);

let admin: ReturnType<typeof makeClient>;
let merchantId: string;
let supplierId: string;
let companyId: string;
let merchantOwnerId: string;
let buyerId: string;
let categoryId: string;

beforeAll(async () => {
  const adminLogin = await login('pr02-admin', 'ADMIN');
  admin = adminLogin.client;

  const merchantOwner = await makeUser('pr02-merchant', 'MERCHANT');
  const supplierOwner = await makeUser('pr02-supplier', 'SUPPLIER');
  const companyOwner = await makeUser('pr02-company', 'COMPANY');
  const buyer = await makeUser('pr02-buyer', 'CUSTOMER');
  merchantOwnerId = merchantOwner.id;
  buyerId = buyer.id;

  merchantId = randomUUID();
  supplierId = randomUUID();
  companyId = randomUUID();
  const t = tag();
  await db.insert(merchants).values({
    id: merchantId,
    userId: merchantOwner.id,
    storeName: `PR02 Store ${t}`,
    slug: `pr02-store-${t}`,
    verified: true,
    isActive: true,
  });
  await db.insert(suppliers).values({
    id: supplierId,
    userId: supplierOwner.id,
    companyName: `PR02 Supply ${t}`,
    slug: `pr02-supply-${t}`,
    verified: false,
    isActive: false,
  });
  await db.insert(companies).values({
    id: companyId,
    userId: companyOwner.id,
    legalName: `PR02 Legal ${t}`,
    slug: `pr02-legal-${t}`,
    registrationNumber: `RC-${t}`,
    taxId: `MF-${t}`,
    industry: 'Wholesale',
    verified: true,
    isActive: true,
  });

  const categoryRow = await db
    .insert(categories)
    .values({ id: randomUUID(), name: `PR02 Cat ${t}`, slug: `pr02-cat-${t}` })
    .returning({ id: categories.id });
  categoryId = categoryRow[0]!.id;

  // Two products: one published, one draft — the desk must separate them.
  for (const [index, status] of ['ACTIVE', 'DRAFT'].entries()) {
    await db.insert(products).values({
      id: randomUUID(),
      sellerId: merchantId,
      sellerType: 'MERCHANT',
      categoryId,
      name: `PR02 Product ${t} ${index}`,
      slug: `pr02-product-${t}-${index}`,
      sku: `PR02-${t}-${index}`,
      basePrice: '100.0000',
      status: status as 'ACTIVE' | 'DRAFT',
      isPublished: status === 'ACTIVE',
    });
  }

  // Three orders: 120 + 80 count towards GMV, the cancelled one must not.
  const orderRows: Array<{ id: string; total: string; status: 'COMPLETED' | 'PENDING' | 'CANCELLED' }> = [
    { id: randomUUID(), total: '120.0000', status: 'COMPLETED' },
    { id: randomUUID(), total: '80.0000', status: 'PENDING' },
    { id: randomUUID(), total: '500.0000', status: 'CANCELLED' },
  ];
  for (const [index, order] of orderRows.entries()) {
    await db.insert(orders).values({
      id: order.id,
      orderNumber: `PR02-${t}-${index}`,
      buyerId: buyer.id,
      buyerType: 'CUSTOMER',
      sellerId: merchantId,
      sellerType: 'MERCHANT',
      currencyCode: 'TND',
      itemsTotal: order.total,
      grandTotal: order.total,
      status: order.status,
    });
  }

  await db.insert(disputes).values({
    id: randomUUID(),
    disputeNumber: `D-PR02-${t}`,
    orderId: orderRows[0]!.id,
    openedById: buyer.id,
    reasonCode: 'NOT_DELIVERED',
    description: 'Integration fixture for the entities desk',
    status: 'OPEN',
  });

  await db.insert(trustScores).values({
    id: randomUUID(),
    userId: merchantOwner.id,
    score: 77,
    level: 'TRUSTED',
  });
  await db.insert(verificationRequests).values({
    id: randomUUID(),
    userId: merchantOwner.id,
    targetLevel: 'BUSINESS_VERIFIED',
    status: 'APPROVED',
  });
});

describe('PR-02 · Entities Desk — access control', () => {
  it('refuses anonymous callers', async () => {
    const anon = makeClient();
    for (const path of ['/api/admin/entities/summary', '/api/admin/entities?type=merchant']) {
      const r = await anon.req(path);
      expect(r.status).toBe(401);
    }
  });

  it('refuses non-admin roles with 403 (least privilege unchanged)', async () => {
    for (const role of ['CUSTOMER', 'SUPPORT', 'MERCHANT']) {
      const { client } = await login(`pr02-deny-${role.toLowerCase()}`, role);
      const summary = await client.req('/api/admin/entities/summary');
      expect(summary.status).toBe(403);
      const list = await client.req('/api/admin/entities?type=merchant');
      expect(list.status).toBe(403);
      const detail = await client.req(`/api/admin/entities/merchant/${merchantId}`);
      expect(detail.status).toBe(403);
    }
  });

  it('lets ADMIN through and answers with the standard envelope', async () => {
    const r = await admin.req('/api/admin/entities/summary');
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(Array.isArray(r.data.data.items)).toBe(true);
  });
});

describe('PR-02 · Entities Desk — summary', () => {
  it('reports one block per entity type with consistent arithmetic', async () => {
    const r = await admin.req('/api/admin/entities/summary');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<Record<string, number | string>>;
    expect(items.map((i) => i.type)).toEqual(['merchant', 'supplier', 'company']);

    for (const block of items) {
      const total = Number(block.total);
      const active = Number(block.active);
      const inactive = Number(block.inactive);
      const verified = Number(block.verified);
      const unverified = Number(block.unverified);
      expect(active + inactive).toBe(total);
      expect(verified + unverified).toBe(total);
      expect(Number(block.newLast30Days)).toBeGreaterThanOrEqual(0);
      expect(Number(block.newLast30Days)).toBeLessThanOrEqual(total);
    }

    const merchantBlock = items.find((i) => i.type === 'merchant')!;
    expect(Number(merchantBlock.total)).toBeGreaterThanOrEqual(1);
    expect(Number(merchantBlock.verified)).toBeGreaterThanOrEqual(1);

    const supplierBlock = items.find((i) => i.type === 'supplier')!;
    expect(Number(supplierBlock.inactive)).toBeGreaterThanOrEqual(1);
  });
});

describe('PR-02 · Entities Desk — list', () => {
  it('lists merchants with real product, order and GMV figures', async () => {
    const r = await admin.req('/api/admin/entities?type=merchant&pageSize=100');
    expect(r.status).toBe(200);
    const row = (r.data.data.items as Array<Record<string, unknown>>).find((i) => i.id === merchantId);
    expect(row).toBeDefined();
    expect(row!.name).toContain('PR02 Store');
    expect(row!.verified).toBe(true);
    expect(row!.isActive).toBe(true);
    expect(row!.productCount).toBe(2);
    expect(row!.orderCount).toBe(3);
    // 120 + 80; the cancelled 500 is excluded.
    expect(Number(row!.gmv)).toBeCloseTo(200, 4);
  });

  it('surfaces inactive entities, which the public directory hides', async () => {
    const r = await admin.req('/api/admin/entities?type=supplier&status=inactive&pageSize=100');
    expect(r.status).toBe(200);
    const ids = (r.data.data.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(ids).toContain(supplierId);

    const activeOnly = await admin.req('/api/admin/entities?type=supplier&status=active&pageSize=100');
    const activeIds = (activeOnly.data.data.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(activeIds).not.toContain(supplierId);
  });

  it('filters by verification state and by name', async () => {
    const unverified = await admin.req('/api/admin/entities?type=supplier&verified=no&pageSize=100');
    const unverifiedIds = (unverified.data.data.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(unverifiedIds).toContain(supplierId);

    const byName = await admin.req('/api/admin/entities?type=company&q=PR02 Legal&pageSize=100');
    expect(byName.status).toBe(200);
    const names = (byName.data.data.items as Array<Record<string, unknown>>).map((i) => i.name);
    expect(names.some((n) => String(n).includes('PR02 Legal'))).toBe(true);
    expect(byName.data.data.total).toBeGreaterThanOrEqual(1);
  });

  it('paginates and reports the total independently of the page', async () => {
    const page1 = await admin.req('/api/admin/entities?type=merchant&page=1&pageSize=1');
    expect(page1.status).toBe(200);
    expect((page1.data.data.items as unknown[]).length).toBeLessThanOrEqual(1);
    expect(page1.data.data.total).toBeGreaterThanOrEqual(1);
    expect(page1.data.data.page).toBe(1);
    expect(page1.data.data.pageSize).toBe(1);
  });

  it('rejects an unknown or missing entity type with 422', async () => {
    for (const path of ['/api/admin/entities', '/api/admin/entities?type=warehouse']) {
      const r = await admin.req(path);
      expect(r.status).toBe(422);
      expect(r.data.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('PR-02 · Entities Desk — detail', () => {
  it('returns the business, its owner and its trading numbers', async () => {
    const r = await admin.req(`/api/admin/entities/merchant/${merchantId}`);
    expect(r.status).toBe(200);
    const data = r.data.data;

    expect(data.type).toBe('merchant');
    expect(data.entity.id).toBe(merchantId);
    expect(data.entity.name).toContain('PR02 Store');
    expect(data.entity.verified).toBe(true);
    expect(data.owner.id).toBe(merchantOwnerId);

    expect(data.metrics.products).toBe(2);
    expect(data.metrics.publishedProducts).toBe(1);
    expect(data.metrics.orders).toBe(3);
    expect(Number(data.metrics.gmv)).toBeCloseTo(200, 4);
    expect(data.metrics.openDisputes).toBe(1);
    expect(Number(data.metrics.openDisputeValue)).toBeCloseTo(120, 4);

    expect(data.trust).toEqual({ score: 77, level: 'TRUSTED' });
    expect(data.verification.status).toBe('APPROVED');
    expect(data.recentOrders.length).toBe(3);
  });

  it('carries company registration data only for companies', async () => {
    const company = await admin.req(`/api/admin/entities/company/${companyId}`);
    expect(company.status).toBe(200);
    expect(company.data.data.entity.industry).toBe('Wholesale');
    expect(company.data.data.entity.registrationNumber).toMatch(/^RC-/);
    expect(company.data.data.entity.taxId).toMatch(/^MF-/);

    const merchant = await admin.req(`/api/admin/entities/merchant/${merchantId}`);
    expect(merchant.data.data.entity.registrationNumber).toBeNull();
    expect(merchant.data.data.entity.taxId).toBeNull();
  });

  it('404s for a business that does not exist and 422 for an unknown type', async () => {
    const missing = await admin.req(`/api/admin/entities/merchant/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.data.error.code).toBe('NOT_FOUND');

    const wrongType = await admin.req(`/api/admin/entities/warehouse/${merchantId}`);
    expect(wrongType.status).toBe(422);
  });

  it('never leaks credential material', async () => {
    const r = await admin.req(`/api/admin/entities/merchant/${merchantId}`);
    const body = JSON.stringify(r.data);
    expect(body).not.toMatch(/passwordHash|password_hash|secret|recoveryCodes/i);
  });
});
