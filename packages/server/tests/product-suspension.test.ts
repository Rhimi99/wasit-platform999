import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { products } from '../src/db/schema/products.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';

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

afterAll(() => {
  closeDb();
});

async function makeAdminClient() {
  const adminId = randomUUID();
  const email = `prod-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id: adminId,
    email,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'Prod Admin',
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role[0].id });

  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return c;
}

describe('Product suspension is only reversible by an administrator', () => {
  it('a seller cannot lift an admin suspension, but can unpublish / republish its own active listing', async () => {
    // Seller owns a supplier entity and a product.
    const seller = makeClient();
    const sellerEmail = `prod-seller-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
    const reg = await seller.req('/api/auth/register', {
      method: 'POST',
      body: { email: sellerEmail, password: 'StrongPass123!', firstName: 'Seller', role: 'SUPPLIER' },
    });
    expect(reg.status).toBe(201);
    const login = await seller.req('/api/auth/login', {
      method: 'POST',
      body: { email: sellerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const profile = await seller.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'Suspension Test Supplier' },
    });
    expect(profile.status).toBe(201);
    const sellerId = profile.data.data.id as string;

    const cats = await seller.req('/api/categories');
    expect(cats.status).toBe(200);
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

    const created = await seller.req('/api/products', {
      method: 'POST',
      body: {
        sellerId,
        sellerType: 'SUPPLIER',
        sku: `SUSP-${Date.now()}`,
        categoryId,
        name: `Suspension Product ${Date.now()}`,
        basePrice: '9.0000',
        currencyCode: 'TND',
        moq: 1,
      },
    });
    expect(created.status).toBe(201);
    const productId = created.data.data.id as string;

    // A seller may move its own listing INACTIVE <-> ACTIVE.
    const off = await seller.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'INACTIVE' } });
    expect(off.status).toBe(200);
    const on = await seller.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    expect(on.status).toBe(200);

    // Admin suspends it for enforcement.
    const admin = await makeAdminClient();
    const suspend = await admin.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'SUSPENDED' } });
    expect(suspend.status).toBe(200);

    // The seller must NOT be able to undo the admin's action.
    const lift = await seller.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    expect(lift.status).toBe(403);
    const rows = await db.select({ status: products.status }).from(products).where(eq(products.id, productId)).limit(1);
    expect(rows[0].status).toBe('SUSPENDED');

    // An administrator can restore it.
    const restore = await admin.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    expect(restore.status).toBe(200);
    const after = await db.select({ status: products.status }).from(products).where(eq(products.id, productId)).limit(1);
    expect(after[0].status).toBe('ACTIVE');
  });
});

describe('Editing a product (PATCH /api/products/:id)', () => {
  async function seedSellerAndProduct(tag: string) {
    const seller = makeClient();
    const email = `prod-edit-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
    const reg = await seller.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', firstName: 'Editor', role: 'SUPPLIER' },
    });
    expect(reg.status).toBe(201);
    expect((await seller.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    })).status).toBe(200);
    const profile = await seller.req('/api/suppliers', { method: 'POST', body: { companyName: `Edit Supplier ${tag}` } });
    expect(profile.status).toBe(201);
    const sellerId = profile.data.data.id as string;
    const cats = await seller.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const created = await seller.req('/api/products', {
      method: 'POST',
      body: {
        sellerId, sellerType: 'SUPPLIER', sku: `EDIT-${tag}-${Date.now()}`, categoryId,
        name: `Original ${tag}`, basePrice: '10.0000', currencyCode: 'TND', moq: 1,
      },
    });
    expect(created.status).toBe(201);
    return { seller, productId: created.data.data.id as string };
  }

  it('the owning seller updates name, price, moq, intent and description, and the change is persisted + audited', async () => {
    const { seller, productId } = await seedSellerAndProduct('own');
    const patch = await seller.req(`/api/products/${productId}`, {
      method: 'PATCH',
      body: { name: 'Renamed Product', basePrice: '25.5000', moq: 4, purchaseIntent: 'B2C', description: 'Edited description' },
    });
    expect(patch.status).toBe(200);

    const detail = await seller.req(`/api/products/${productId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.name).toBe('Renamed Product');
    expect(detail.data.data.basePrice).toBe('25.5000');
    expect(detail.data.data.moq).toBe(4);
    expect(detail.data.data.purchaseIntent).toBe('B2C');
    expect(detail.data.data.description).toBe('Edited description');
    // The slug is regenerated so the storefront URL stays consistent with the name.
    expect(detail.data.data.slug).toBe('renamed-product');
  });

  it('rejects an empty patch, an unknown category and a bad price with 422', async () => {
    const { seller, productId } = await seedSellerAndProduct('bad');
    expect((await seller.req(`/api/products/${productId}`, { method: 'PATCH', body: {} })).status).toBe(422);
    expect((await seller.req(`/api/products/${productId}`, { method: 'PATCH', body: { categoryId: randomUUID() } })).status).toBe(422);
    expect((await seller.req(`/api/products/${productId}`, { method: 'PATCH', body: { basePrice: '-1' } })).status).toBe(422);
    expect((await seller.req(`/api/products/${productId}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(422);

    const detail = await seller.req(`/api/products/${productId}`);
    expect(detail.data.data.basePrice).toBe('10.0000');
  });

  it('blocks another seller (403), requires auth (401), and refuses editing a suspended product (403)', async () => {
    const { seller, productId } = await seedSellerAndProduct('guard');
    const other = await seedSellerAndProduct('other');

    expect((await other.seller.req(`/api/products/${productId}`, { method: 'PATCH', body: { name: 'Hijacked Name' } })).status).toBe(403);
    expect((await makeClient().req(`/api/products/${productId}`, { method: 'PATCH', body: { name: 'Anon Name' } })).status).toBe(401);

    const admin = await makeAdminClient();
    await admin.req(`/api/products/${productId}/status`, { method: 'PATCH', body: { status: 'SUSPENDED' } });
    expect((await seller.req(`/api/products/${productId}`, { method: 'PATCH', body: { name: 'Sneaky Rename' } })).status).toBe(403);

    const rows = await db.select({ name: products.name, status: products.status }).from(products).where(eq(products.id, productId)).limit(1);
    expect(rows[0].name).not.toBe('Hijacked Name');
    expect(rows[0].name).not.toBe('Sneaky Rename');
    expect(rows[0].status).toBe('SUSPENDED');
  });
});
