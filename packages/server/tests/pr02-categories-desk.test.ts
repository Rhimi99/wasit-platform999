import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { merchants } from '../src/db/schema/trade.js';
import { categories, products } from '../src/db/schema/products.js';
import { eq } from 'drizzle-orm';

/**
 * PR-02 slice 2 — Categories Desk.
 *
 * Real app, real database, no mocks: every figure asserted here is computed by
 * the queries under test from the tree this file builds. The tree is three
 * levels deep on purpose, because the two things that can silently go wrong in a
 * hierarchy are depth/path derivation and sub-tree aggregation — a flat count
 * would pass while both were broken.
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

async function makeUser(emailPrefix: string, role: string) {
  const id = randomUUID();
  const email = `${emailPrefix}-${randomUUID().slice(0, 8)}@wasit.test`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Passw0rd!2026'),
    firstName: emailPrefix,
    isActive: true,
    emailVerified: true,
  });
  const roleRow = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow[0]!.id });
  return { id, email };
}

async function login(prefix: string, role: string) {
  const user = await makeUser(prefix, role);
  const client = makeClient();
  const res = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: 'Passw0rd!2026', allowUnverifiedEmail: true },
  });
  expect(res.status).toBe(200);
  return { client, user };
}

const tag = () => randomUUID().slice(0, 8);

let admin: ReturnType<typeof makeClient>;
let rootId: string;
let childId: string;
let leafId: string;
let emptyId: string;
let rootName: string;
let childName: string;
let leafName: string;
let emptyName: string;

beforeAll(async () => {
  admin = (await login('pr02c-admin', 'ADMIN')).client;

  const t = tag();
  rootName = `PR02C Root ${t}`;
  childName = `PR02C Child ${t}`;
  leafName = `PR02C Leaf ${t}`;
  emptyName = `PR02C Empty ${t}`;

  rootId = randomUUID();
  childId = randomUUID();
  leafId = randomUUID();
  emptyId = randomUUID();

  await db.insert(categories).values([
    { id: rootId, name: rootName, slug: `pr02c-root-${t}`, isActive: true, sortOrder: 10 },
    { id: childId, parentId: rootId, name: childName, slug: `pr02c-child-${t}`, isActive: true, sortOrder: 20 },
    { id: leafId, parentId: childId, name: leafName, slug: `pr02c-leaf-${t}`, isActive: false, sortOrder: 30 },
    { id: emptyId, name: emptyName, slug: `pr02c-empty-${t}`, isActive: true, sortOrder: 40 },
  ]);

  const owner = await makeUser('pr02c-merchant', 'MERCHANT');
  const merchantId = randomUUID();
  await db.insert(merchants).values({
    id: merchantId,
    userId: owner.id,
    storeName: `PR02C Store ${t}`,
    slug: `pr02c-store-${t}`,
    verified: true,
    isActive: true,
  });

  const rows: Array<{ categoryId: string; status: 'ACTIVE' | 'DRAFT'; published: boolean }> = [
    { categoryId: childId, status: 'ACTIVE', published: true },
    { categoryId: childId, status: 'ACTIVE', published: false },
    { categoryId: leafId, status: 'DRAFT', published: false },
  ];
  for (const [index, row] of rows.entries()) {
    await db.insert(products).values({
      id: randomUUID(),
      sellerId: merchantId,
      sellerType: 'MERCHANT',
      categoryId: row.categoryId,
      name: `PR02C Product ${t} ${index}`,
      slug: `pr02c-product-${t}-${index}`,
      sku: `PR02C-${t}-${index}`,
      basePrice: '50.0000',
      status: row.status,
      isPublished: row.published,
    });
  }
});

describe('PR-02 slice 2 · Categories Desk — access control', () => {
  it('refuses anonymous callers', async () => {
    const anon = makeClient();
    for (const path of ['/api/admin/categories/summary', '/api/admin/categories', `/api/admin/categories/${rootId}`]) {
      expect((await anon.req(path)).status).toBe(401);
    }
  });

  it('refuses non-admin roles, including staff, with 403', async () => {
    for (const role of ['CUSTOMER', 'SUPPORT', 'RISK', 'DISPUTE', 'MERCHANT']) {
      const { client } = await login(`pr02c-deny-${role.toLowerCase()}`, role);
      for (const path of ['/api/admin/categories/summary', '/api/admin/categories']) {
        const r = await client.req(path);
        expect(r.status, `${role} ${path}`).toBe(403);
      }
    }
  });

  it('keeps the specialized staff desks reachable while the categories desk stays closed', async () => {
    const support = (await login('pr02c-support', 'SUPPORT')).client;
    expect((await support.req('/api/admin/trust')).status).toBe(200);
    expect((await support.req('/api/admin/disputes')).status).toBe(200);
    expect((await support.req('/api/admin/categories')).status).toBe(403);

    const risk = (await login('pr02c-risk', 'RISK')).client;
    expect((await risk.req('/api/admin/risk/profiles')).status).toBe(200);
    expect((await risk.req('/api/admin/categories/summary')).status).toBe(403);

    const dispute = (await login('pr02c-dispute', 'DISPUTE')).client;
    expect((await dispute.req('/api/admin/disputes')).status).toBe(200);
    expect((await dispute.req('/api/admin/categories')).status).toBe(403);
  });

  it('lets ADMIN through with the standard envelope', async () => {
    const r = await admin.req('/api/admin/categories/summary');
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(typeof r.data.data.total).toBe('number');
  });
});

describe('PR-02 slice 2 · Categories Desk — summary', () => {
  it('counts every category and keeps its own arithmetic consistent', async () => {
    const r = await admin.req('/api/admin/categories/summary');
    const s = r.data.data;

    expect(s.active + s.inactive).toBe(s.total);
    expect(s.roots + s.children).toBe(s.total);
    expect(s.withProducts + s.empty).toBe(s.total);
    expect(s.maxDepth).toBeGreaterThanOrEqual(2);
    expect(s.total).toBeGreaterThanOrEqual(4);
    expect(s.withProducts).toBeGreaterThanOrEqual(2);
    expect(s.empty).toBeGreaterThanOrEqual(1);
    expect(s.publishedProducts).toBeGreaterThanOrEqual(1);
    expect(s.totalProducts).toBeGreaterThanOrEqual(3);
    expect(s.newLast30Days).toBeGreaterThanOrEqual(4);
    expect(s.newLast30Days).toBeLessThanOrEqual(s.total);
  });
});

describe('PR-02 slice 2 · Categories Desk — list', () => {
  const listOf = async (qs: string) => {
    const r = await admin.req(`/api/admin/categories?${qs}`);
    expect(r.status).toBe(200);
    return r.data.data as {
      items: Array<Record<string, unknown>>;
      page: number;
      pageSize: number;
      total: number;
    };
  };

  it('derives depth, path and parent from the real parent pointers', async () => {
    const data = await listOf(`q=${encodeURIComponent(leafName)}&pageSize=100`);
    const row = data.items.find((i) => i.id === leafId)!;
    expect(row).toBeDefined();
    expect(row.depth).toBe(2);
    expect(row.path).toBe(`${rootName} / ${childName} / ${leafName}`);
    expect(row.parentName).toBe(childName);
    expect(row.parentId).toBe(childId);
    expect(row.isActive).toBe(false);
  });

  it('counts direct, published and sub-tree products per row', async () => {
    const data = await listOf(`q=${encodeURIComponent(childName)}&pageSize=100`);
    const row = data.items.find((i) => i.id === childId)!;
    expect(row.productCount).toBe(2);
    expect(row.publishedProductCount).toBe(1);
    expect(row.subtreeProductCount).toBe(3);
    expect(row.childrenCount).toBe(1);
  });

  it('filters by level, parent, status and product presence', async () => {
    const roots = await listOf('level=root&pageSize=100');
    expect(roots.items.every((i) => i.parentId === null)).toBe(true);
    expect(roots.items.some((i) => i.id === rootId)).toBe(true);

    const leaves = await listOf('level=leaf&pageSize=100');
    expect(leaves.items.some((i) => i.id === leafId)).toBe(true);
    expect(leaves.items.some((i) => i.id === rootId)).toBe(false);

    const childrenOfRoot = await listOf(`parentId=${rootId}&pageSize=100`);
    expect(childrenOfRoot.items.map((i) => i.id)).toEqual([childId]);

    const inactive = await listOf('status=inactive&pageSize=100');
    expect(inactive.items.some((i) => i.id === leafId)).toBe(true);
    expect(inactive.items.some((i) => i.id === childId)).toBe(false);

    const withoutProducts = await listOf('hasProducts=no&pageSize=100');
    expect(withoutProducts.items.some((i) => i.id === emptyId)).toBe(true);
    expect(withoutProducts.items.some((i) => i.id === childId)).toBe(false);
  });

  it('searches by slug as well as by name, and isolates unknown terms', async () => {
    const bySlug = await listOf(`q=${encodeURIComponent(childName.split(' ').pop()!)}&pageSize=100`);
    expect(bySlug.items.some((i) => i.id === childId)).toBe(true);

    const nothing = await listOf(`q=zz-no-such-category-${randomUUID()}`);
    expect(nothing.total).toBe(0);
    expect(nothing.items).toEqual([]);
  });

  it('paginates with a total independent of the page', async () => {
    const data = await listOf('page=1&pageSize=1');
    expect(data.items.length).toBe(1);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(1);
    expect(data.total).toBeGreaterThan(1);
  });

  it('rejects invalid filters with 422', async () => {
    for (const qs of ['status=archived', 'level=galaxy', 'hasProducts=maybe', 'pageSize=500']) {
      const r = await admin.req(`/api/admin/categories?${qs}`);
      expect(r.status, qs).toBe(422);
      expect(r.data.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('PR-02 slice 2 · Categories Desk — detail', () => {
  it('shows a root with no direct products but the whole branch behind it', async () => {
    const r = await admin.req(`/api/admin/categories/${rootId}`);
    expect(r.status).toBe(200);
    const d = r.data.data;

    expect(d.category.id).toBe(rootId);
    expect(d.category.depth).toBe(0);
    expect(d.category.path).toBe(rootName);
    expect(d.ancestors).toEqual([]);

    expect(d.metrics.directProducts).toBe(0);
    expect(d.metrics.subtreeProducts).toBe(3);
    expect(d.metrics.subtreePublishedProducts).toBe(1);
    expect(d.metrics.children).toBe(1);
    expect(d.metrics.descendants).toBe(2);

    expect(d.children.length).toBe(1);
    expect(d.children[0].id).toBe(childId);
    expect(d.children[0].productCount).toBe(2);
    expect(d.recentProducts).toEqual([]);
  });

  it('shows a leaf with its full ancestor chain and its own products', async () => {
    const r = await admin.req(`/api/admin/categories/${leafId}`);
    const d = r.data.data;

    expect(d.category.depth).toBe(2);
    expect(d.category.parentName).toBe(childName);
    expect(d.ancestors.map((a: { id: string }) => a.id)).toEqual([rootId, childId]);
    expect(d.ancestors.map((a: { depth: number }) => a.depth)).toEqual([0, 1]);

    expect(d.metrics.directProducts).toBe(1);
    expect(d.metrics.draftProducts).toBe(1);
    expect(d.metrics.publishedProducts).toBe(0);
    expect(d.metrics.children).toBe(0);
    expect(d.metrics.descendants).toBe(0);

    expect(d.recentProducts.length).toBe(1);
    expect(d.recentProducts[0].status).toBe('DRAFT');
    expect(d.recentProducts[0].isPublished).toBe(false);
  });

  it('404s for an unknown category and never leaks secrets', async () => {
    const missing = await admin.req(`/api/admin/categories/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.data.error.code).toBe('NOT_FOUND');

    const ok = await admin.req(`/api/admin/categories/${childId}`);
    expect(JSON.stringify(ok.data)).not.toMatch(/passwordHash|password_hash|secret|recoveryCodes/i);
  });
});
