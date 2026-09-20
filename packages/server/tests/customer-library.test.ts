import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { categories, products } from '../src/db/schema/products.js';
import { suppliers } from '../src/db/schema/trade.js';
import { favorites, savedItems, searchHistory } from '../src/db/schema/audit.js';

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

async function registerCustomer(email: string) {
  const c = makeClient();
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Lib', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return { client: c, userId: u.id };
}

let productId = '';
let supplierId = '';
let categoryId = '';
let ownerUserId = '';

beforeAll(async () => {
  categoryId = randomUUID();
  await db.insert(categories).values({ id: categoryId, name: 'Lib Category', slug: `lib-cat-${Date.now()}`, isActive: true });

  ownerUserId = randomUUID();
  await db.insert(users).values({
    id: ownerUserId,
    email: `lib-owner-${Date.now()}@wasit.tn`,
    passwordHash: await argon2.hash('OwnerPass123!'),
    firstName: 'Owner',
    isActive: true,
    emailVerified: true,
  });

  productId = randomUUID();
  await db.insert(products).values({
    id: productId,
    sellerId: ownerUserId,
    sellerType: 'SUPPLIER',
    categoryId,
    name: 'Library Test Product',
    nameAr: 'منتج المكتبة',
    slug: `lib-prod-${Date.now()}`,
    sku: `SKU-LIB-${Date.now()}`,
    currencyCode: 'TND',
    basePrice: '42.0000',
    moq: 1,
    unit: 'piece',
    status: 'ACTIVE',
    isPublished: true,
  });

  supplierId = randomUUID();
  await db.insert(suppliers).values({
    id: supplierId,
    userId: ownerUserId,
    companyName: 'Library Test Supplier',
    slug: `lib-sup-${Date.now()}`,
    verified: true,
  });
});

afterAll(async () => {
  await db.delete(favorites).where(eq(favorites.entityId, productId));
  await db.delete(favorites).where(eq(favorites.entityId, supplierId));
  await db.delete(savedItems).where(eq(savedItems.itemId, productId));
  await db.delete(savedItems).where(eq(savedItems.itemId, supplierId));
  await db.delete(products).where(eq(products.id, productId));
  await db.delete(suppliers).where(eq(suppliers.id, supplierId));
  await db.delete(categories).where(eq(categories.id, categoryId));
});

describe('B6 — favorites, saved items & search history', () => {
  describe('favorites', () => {
    it('adds, lists and removes a favorite idempotently', async () => {
      const { client } = await registerCustomer(`lib-fav-${Date.now()}@wasit.tn`);

      const first = await client.req('/api/library/favorites', {
        method: 'POST',
        body: { entityType: 'PRODUCT', entityId: productId },
      });
      expect(first.status).toBe(200);
      expect(first.data.data.created).toBe(true);

      const again = await client.req('/api/library/favorites', {
        method: 'POST',
        body: { entityType: 'PRODUCT', entityId: productId },
      });
      expect(again.data.data.created).toBe(false);
      expect(again.data.data.id).toBe(first.data.data.id);

      const list = await client.req('/api/library/favorites');
      expect(list.status).toBe(200);
      expect(list.data.data.pagination.total).toBe(1);
      expect(list.data.data.items[0].title).toBe('منتج المكتبة');
      expect(list.data.data.items[0].available).toBe(true);

      const removed = await client.req(`/api/library/favorites/PRODUCT/${productId}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
      const empty = await client.req('/api/library/favorites');
      expect(empty.data.data.pagination.total).toBe(0);

      const removeAgain = await client.req(`/api/library/favorites/PRODUCT/${productId}`, { method: 'DELETE' });
      expect(removeAgain.status).toBe(404);
    });

    it('refuses to favorite a non-existent entity with a structured 404', async () => {
      const { client } = await registerCustomer(`lib-fav404-${Date.now()}@wasit.tn`);
      const res = await client.req('/api/library/favorites', {
        method: 'POST',
        body: { entityType: 'PRODUCT', entityId: randomUUID() },
      });
      expect(res.status).toBe(404);
      expect(res.data.error.code).toBe('NOT_FOUND');
    });

    it('filters favorites by entity type', async () => {
      const { client } = await registerCustomer(`lib-favf-${Date.now()}@wasit.tn`);
      await client.req('/api/library/favorites', { method: 'POST', body: { entityType: 'PRODUCT', entityId: productId } });
      await client.req('/api/library/favorites', { method: 'POST', body: { entityType: 'SUPPLIER', entityId: supplierId } });

      const onlySuppliers = await client.req('/api/library/favorites?entityType=SUPPLIER');
      expect(onlySuppliers.status).toBe(200);
      expect(onlySuppliers.data.data.items.length).toBe(1);
      expect(onlySuppliers.data.data.items[0].entityType).toBe('SUPPLIER');
    });

    it('rejects an invalid entity type', async () => {
      const { client } = await registerCustomer(`lib-favinvalid-${Date.now()}@wasit.tn`);
      const res = await client.req('/api/library/favorites', {
        method: 'POST',
        body: { entityType: 'WALLET', entityId: productId },
      });
      expect(res.status).toBe(422);
    });

    it('keeps favorites isolated between users', async () => {
      const a = await registerCustomer(`lib-faviso-a-${Date.now()}@wasit.tn`);
      const b = await registerCustomer(`lib-faviso-b-${Date.now()}@wasit.tn`);
      await a.client.req('/api/library/favorites', { method: 'POST', body: { entityType: 'PRODUCT', entityId: productId } });
      const bList = await b.client.req('/api/library/favorites');
      expect(bList.data.data.pagination.total).toBe(0);
    });
  });

  describe('saved items', () => {
    it('saves with notes and updates notes on re-save', async () => {
      const { client } = await registerCustomer(`lib-saved-${Date.now()}@wasit.tn`);
      const first = await client.req('/api/library/saved', {
        method: 'POST',
        body: { itemType: 'PRODUCT', itemId: productId, notes: 'Compare next week' },
      });
      expect(first.status).toBe(200);
      expect(first.data.data.created).toBe(true);

      const listed = await client.req('/api/library/saved');
      expect(listed.data.data.items[0].notes).toBe('Compare next week');
      expect(listed.data.data.items[0].title).toBe('منتج المكتبة');

      const resave = await client.req('/api/library/saved', {
        method: 'POST',
        body: { itemType: 'PRODUCT', itemId: productId, notes: 'Reorder Q4' },
      });
      expect(resave.data.data.id).toBe(first.data.data.id);
      const relisted = await client.req('/api/library/saved');
      expect(relisted.data.data.items[0].notes).toBe('Reorder Q4');

      const removed = await client.req(`/api/library/saved/PRODUCT/${productId}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
    });

    it('refuses to save a non-existent entity', async () => {
      const { client } = await registerCustomer(`lib-saved404-${Date.now()}@wasit.tn`);
      const res = await client.req('/api/library/saved', {
        method: 'POST',
        body: { itemType: 'SUPPLIER', itemId: randomUUID() },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('search history', () => {
    it('records an authenticated search automatically and lists it', async () => {
      const { client } = await registerCustomer(`lib-hist-${Date.now()}@wasit.tn`);
      const search = await client.req('/api/search?q=Library');
      expect(search.status).toBe(200);

      const hist = await client.req('/api/library/search-history');
      expect(hist.status).toBe(200);
      expect(hist.data.data.pagination.total).toBeGreaterThanOrEqual(1);
      expect(hist.data.data.items.some((h: { query: string }) => h.query === 'Library')).toBe(true);
    });

    it('does not record searches for anonymous callers', async () => {
      const anon = makeClient();
      const search = await anon.req(`/api/search?q=Anon${Date.now()}`);
      expect(search.status).toBe(200);
      const hist = await anon.req('/api/library/search-history');
      expect(hist.status).toBe(401);
    });

    it('deletes a single entry and clears all history', async () => {
      const { client } = await registerCustomer(`lib-histdel-${Date.now()}@wasit.tn`);
      await client.req('/api/library/search-history', { method: 'POST', body: { query: 'alpha' } });
      const beta = await client.req('/api/library/search-history', { method: 'POST', body: { query: 'beta' } });
      expect(beta.status).toBe(200);

      const before = await client.req('/api/library/search-history');
      expect(before.data.data.pagination.total).toBe(2);

      const del = await client.req(`/api/library/search-history/${beta.data.data.id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const after = await client.req('/api/library/search-history');
      expect(after.data.data.pagination.total).toBe(1);

      const cleared = await client.req('/api/library/search-history', { method: 'DELETE' });
      expect(cleared.status).toBe(200);
      expect(cleared.data.data.removed).toBe(1);
      const empty = await client.req('/api/library/search-history');
      expect(empty.data.data.pagination.total).toBe(0);
    });

    it('rejects an empty search-history query', async () => {
      const { client } = await registerCustomer(`lib-hempty-${Date.now()}@wasit.tn`);
      const res = await client.req('/api/library/search-history', { method: 'POST', body: { query: '   ' } });
      expect(res.status).toBe(422);
    });

    it('does not let a user delete another user’s history entry', async () => {
      const a = await registerCustomer(`lib-hiso-a-${Date.now()}@wasit.tn`);
      const b = await registerCustomer(`lib-hiso-b-${Date.now()}@wasit.tn`);
      const created = await a.client.req('/api/library/search-history', { method: 'POST', body: { query: 'secret' } });
      const del = await b.client.req(`/api/library/search-history/${created.data.data.id}`, { method: 'DELETE' });
      expect(del.status).toBe(404);
    });
  });

  describe('authorization', () => {
    it('refuses unauthenticated access to the library', async () => {
      const anon = makeClient();
      expect((await anon.req('/api/library/favorites')).status).toBe(401);
      expect((await anon.req('/api/library/saved')).status).toBe(401);
      expect((await anon.req('/api/library/search-history')).status).toBe(401);
    });

    it('allows an admin (also granted the permissions) to use the library', async () => {
      const id = randomUUID();
      const email = `lib-admin-${Date.now()}@wasit.tn`;
      await db.insert(users).values({ id, email, passwordHash: await argon2.hash('AdminPass123!'), firstName: 'Admin', isActive: true, emailVerified: true });
      const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
      if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
      const c = makeClient();
      const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true } });
      expect(login.status).toBe(200);
      const res = await c.req('/api/library/favorites');
      expect(res.status).toBe(200);
    });
  });
});