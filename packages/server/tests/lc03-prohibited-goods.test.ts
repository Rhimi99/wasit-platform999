import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { products } from '../src/db/schema/products.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * LC-03 — prohibited & restricted goods policy, over the real HTTP stack and the
 * real database. Proves the enforcement is not just unit-tested: a prohibited
 * listing is rejected end to end, a restricted one lands unpublished, a seller
 * cannot publish it by a status change, and only an authorised reviewer clears
 * it. Requires Postgres (the shared `globalSetup` recreates `wasit_test`).
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
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

const createdUserIds: string[] = [];

afterAll(async () => {
  await cleanupOwnedRows(db, { userIds: createdUserIds });
  await closeDb();
});

async function registerSeller(tag: string) {
  const c = makeClient();
  const email = `lc03-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'LC03', role: 'SUPPLIER' },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const profile = await c.req('/api/suppliers', { method: 'POST', body: { companyName: `LC03 Supplier ${tag}` } });
  expect(profile.status).toBe(201);
  const sellerId = profile.data.data.id as string;
  const cats = await c.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const userId = login.data.data.id as string;
  createdUserIds.push(userId);
  return { client: c, sellerId, categoryId, userId };
}

function productBody(sellerId: string, categoryId: string, name: string, sku: string) {
  return {
    sellerId, sellerType: 'SUPPLIER', categoryId, name, sku,
    basePrice: '10.0000', currencyCode: 'TND', moq: 1,
  };
}

async function makeAdminClient() {
  const adminId = randomUUID();
  const email = `lc03-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id: adminId, email,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'LC03 Admin', emailVerified: true, isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role[0].id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  createdUserIds.push(adminId);
  return { client: c, userId: adminId };
}

describe('LC-03 prohibited & restricted goods over HTTP', () => {
  it('rejects a prohibited listing with PROHIBITED_GOODS and stores nothing', async () => {
    const { client, sellerId, categoryId } = await registerSeller('prohibited');
    const sku = `LC03-PROHIB-${Date.now()}`;
    const res = await client.req('/api/products', {
      method: 'POST',
      body: productBody(sellerId, categoryId, 'AK-47 assault rifle', sku),
    });
    expect(res.status).toBe(422);
    expect(res.data.error.code).toBe('PROHIBITED_GOODS');
    const rows = await db.select().from(products).where(eq(products.sku, sku));
    expect(rows).toHaveLength(0);
  });

  it('stores a restricted listing unpublished, blocks activation, then a reviewer approves it', async () => {
    const { client, sellerId, categoryId } = await registerSeller('restricted');
    const sku = `LC03-RESTRICT-${Date.now()}`;
    const created = await client.req('/api/products', {
      method: 'POST',
      body: productBody(sellerId, categoryId, 'Imported French wine case', sku),
    });
    expect(created.status).toBe(201);
    const id = created.data.data.id as string;

    const [row] = await db.select().from(products).where(eq(products.id, id));
    expect(row.status).toBe('DRAFT');
    expect(row.isPublished).toBe(false);

    // The seller cannot activate it themselves.
    const activate = await client.req(`/api/products/${id}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    expect(activate.status).toBe(422);
    expect(activate.data.error.code).toBe('RESTRICTED_GOODS_REVIEW_REQUIRED');

    // An authorised reviewer approves it.
    const admin = await makeAdminClient();
    const approve = await admin.client.req(`/api/products/${id}/compliance-review`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(approve.status).toBe(200);
    const [after] = await db.select().from(products).where(eq(products.id, id));
    expect(after.status).toBe('ACTIVE');
    expect(after.isPublished).toBe(true);
  });

  it('a seller without the compliance permission cannot review a restricted listing', async () => {
    const { client, sellerId, categoryId } = await registerSeller('noauthz');
    const sku = `LC03-NOAUTHZ-${Date.now()}`;
    const created = await client.req('/api/products', {
      method: 'POST',
      body: productBody(sellerId, categoryId, 'Tobacco cartons', sku),
    });
    const id = created.data.data.id as string;
    const attempt = await client.req(`/api/products/${id}/compliance-review`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(attempt.status).toBe(403);
  });

  it('an allowed listing is published as before', async () => {
    const { client, sellerId, categoryId } = await registerSeller('allowed');
    const sku = `LC03-ALLOW-${Date.now()}`;
    const created = await client.req('/api/products', {
      method: 'POST',
      body: productBody(sellerId, categoryId, 'Premium Organic Olive Oil 5L', sku),
    });
    expect(created.status).toBe(201);
    const [row] = await db.select().from(products).where(eq(products.sku, sku));
    expect(row.status).toBe('ACTIVE');
    expect(row.isPublished).toBe(true);
  });
});
