import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { products } from '../src/db/schema/products.js';
import { eq } from 'drizzle-orm';

/**
 * PERM-01B — inventory & product permission alignment.
 *
 * The administrative decision: ADMIN may *read* stock for follow-up but must not
 * hold the seller write permissions, so a seller's stock stays theirs to change;
 * no role, SUPER_ADMIN included, may bypass the inventory ownership check. These
 * tests pin both halves of that contract, plus the product-catalogue rules that
 * were already enforced by `product:manage` (ADMIN/SUPER_ADMIN only).
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

/** Inserts a staff user directly with a role and logs in (public register blocks staff roles). */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'RISK' | 'DISPUTE') {
  const id = randomUUID();
  const email = `perm01b-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} missing — seed did not run`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });

  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login ${roleName}`).toBe(200);
  return { client, id, email };
}

async function registerRole(role: 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY') {
  const client = makeClient();
  const email = `perm01b-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'PB', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return client;
}

/** Creates a SUPPLIER with one product carrying `qty` initial stock. */
async function supplierWithStock(qty: number) {
  const supplier = await registerRole('SUPPLIER');
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const profile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: `PB Supplier ${stamp}` } });
  const supplierId = profile.data.data.id as string;
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `PB-${stamp}`,
      categoryId,
      name: `PB Product ${stamp}`,
      basePrice: '20.0000',
      currencyCode: 'TND',
      initialQuantity: qty,
      lowStockThreshold: 5,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;
  const list = await supplier.req('/api/inventory');
  expect(list.status).toBe(200);
  const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;
  return { supplier, supplierId, productId, itemId: item.id, categoryId };
}

afterAll(async () => {
  await closeDb();
});

describe('PERM-01B — ADMIN has read-only inventory access', () => {
  it('can read a seller inventory list, an item and its movements', async () => {
    const { itemId } = await supplierWithStock(7);
    const admin = await createStaffUser('ADMIN');

    const list = await admin.client.req('/api/inventory');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.data.items)).toBe(true);

    expect((await admin.client.req(`/api/inventory/${itemId}`)).status).toBe(200);
    expect((await admin.client.req(`/api/inventory/${itemId}/movements`)).status).toBe(200);
  });

  it('cannot adjust a seller stock (POST /adjust → 403)', async () => {
    const { itemId } = await supplierWithStock(7);
    const admin = await createStaffUser('ADMIN');
    const r = await admin.client.req(`/api/inventory/${itemId}/adjust`, {
      method: 'POST',
      body: { quantityChange: 5, movementType: 'PURCHASE' },
    });
    expect(r.status).toBe(403);
  });

  it('cannot set stock fields (PATCH → 403)', async () => {
    const { itemId } = await supplierWithStock(7);
    const admin = await createStaffUser('ADMIN');
    const r = await admin.client.req(`/api/inventory/${itemId}`, {
      method: 'PATCH',
      body: { quantity: 999 },
    });
    expect(r.status).toBe(403);
  });

  it('writes no inventory change when the adjust attempt is refused', async () => {
    const { itemId } = await supplierWithStock(7);
    const admin = await createStaffUser('ADMIN');
    await admin.client.req(`/api/inventory/${itemId}/adjust`, {
      method: 'POST',
      body: { quantityChange: 100, movementType: 'PURCHASE' },
    });
    const [row] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
    expect(row.quantity).toBe(7);
  });
});

describe('PERM-01B — the inventory ownership check cannot be bypassed', () => {
  it('SUPER_ADMIN reads but cannot modify another seller stock', async () => {
    const { itemId } = await supplierWithStock(4);
    const superAdmin = await createStaffUser('SUPER_ADMIN');

    expect((await superAdmin.client.req('/api/inventory')).status).toBe(200);
    expect((await superAdmin.client.req(`/api/inventory/${itemId}`)).status).toBe(200);

    expect(
      (await superAdmin.client.req(`/api/inventory/${itemId}/adjust`, {
        method: 'POST',
        body: { quantityChange: 3 },
      })).status,
    ).toBe(403);
    expect(
      (await superAdmin.client.req(`/api/inventory/${itemId}`, { method: 'PATCH', body: { quantity: 1 } })).status,
    ).toBe(403);
  });

  it('ADMIN reading another seller stock leaves the quantity untouched', async () => {
    const { itemId } = await supplierWithStock(9);
    const admin = await createStaffUser('ADMIN');
    expect((await admin.client.req(`/api/inventory/${itemId}`)).status).toBe(200);
    const [row] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
    expect(row.quantity).toBe(9);
  });
});

describe('PERM-01B — SUPPORT gains no inventory permission', () => {
  it('is refused on reads and writes', async () => {
    const { itemId } = await supplierWithStock(3);
    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req('/api/inventory')).status).toBe(403);
    expect((await support.client.req(`/api/inventory/${itemId}`)).status).toBe(403);
    expect((await support.client.req(`/api/inventory/${itemId}/movements`)).status).toBe(403);
    expect(
      (await support.client.req(`/api/inventory/${itemId}/adjust`, { method: 'POST', body: { quantityChange: 1 } }))
        .status,
    ).toBe(403);
    expect(
      (await support.client.req(`/api/inventory/${itemId}`, { method: 'PATCH', body: { quantity: 1 } })).status,
    ).toBe(403);
  });
});

describe('PERM-01B — CUSTOMER and anonymous are refused', () => {
  it('CUSTOMER is refused on every inventory route', async () => {
    const { itemId } = await supplierWithStock(3);
    const customer = await registerRole('CUSTOMER');
    expect((await customer.req('/api/inventory')).status).toBe(403);
    expect((await customer.req(`/api/inventory/${itemId}`)).status).toBe(403);
    expect(
      (await customer.req(`/api/inventory/${itemId}/adjust`, { method: 'POST', body: { quantityChange: 1 } })).status,
    ).toBe(403);
  });

  it('anonymous gets 401', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/inventory')).status).toBe(401);
    expect((await anon.req('/api/inventory/whatever')).status).toBe(401);
  });
});

describe('PERM-01B — a seller manages its own stock within ownership', () => {
  it('reads and adjusts its own item', async () => {
    const { supplier, itemId } = await supplierWithStock(5);

    const list = await supplier.req('/api/inventory');
    expect(list.status).toBe(200);
    expect((list.data.data.items as Array<{ id: string }>).some((i) => i.id === itemId)).toBe(true);

    const adjust = await supplier.req(`/api/inventory/${itemId}/adjust`, {
      method: 'POST',
      body: { quantityChange: 10, movementType: 'PURCHASE' },
    });
    expect(adjust.status).toBe(200);
    expect(adjust.data.data.newQuantity).toBe(15);

    const patch = await supplier.req(`/api/inventory/${itemId}`, { method: 'PATCH', body: { lowStockThreshold: 4 } });
    expect(patch.status).toBe(200);
    expect(patch.data.data.lowStockThreshold).toBe(4);
  });

  it('cannot reach another seller inventory (own-scope returns empty / 404)', async () => {
    const a = await supplierWithStock(6);
    const b = await supplierWithStock(6);

    // `listMyInventory` scopes to the caller's own entity, so B never sees A's item.
    const listB = await b.supplier.req('/api/inventory');
    expect(listB.status).toBe(200);
    expect((listB.data.data.items as Array<{ id: string }>).some((i) => i.id === a.itemId)).toBe(false);

    // Direct id access is scoped too.
    expect((await b.supplier.req(`/api/inventory/${a.itemId}`)).status).toBe(404);
    expect(
      (await b.supplier.req(`/api/inventory/${a.itemId}/adjust`, { method: 'POST', body: { quantityChange: 1 } })).status,
    ).toBe(404);
    expect(
      (await b.supplier.req(`/api/inventory/${a.itemId}`, { method: 'PATCH', body: { quantity: 1 } })).status,
    ).toBe(404);
  });
});

describe('PERM-01B — product publish/edit follows RBAC', () => {
  it('a seller publishes under its own entity (201) but not under another seller (403)', async () => {
    const victim = await supplierWithStock(1);
    const attacker = await registerRole('SUPPLIER');
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const own = await attacker.req('/api/suppliers', { method: 'POST', body: { companyName: `PB Attacker ${stamp}` } });
    const ownId = own.data.data.id as string;

    const body = (sellerId: string) => ({
      sellerId,
      sellerType: 'SUPPLIER',
      sku: `PB-ATK-${stamp}-${Math.floor(Math.random() * 1e6)}`,
      categoryId: victim.categoryId,
      name: `PB Attacker Product ${stamp}`,
      basePrice: '10.0000',
      currencyCode: 'TND',
    });

    expect((await attacker.req('/api/products', { method: 'POST', body: body(ownId) })).status).toBe(201);
    expect((await attacker.req('/api/products', { method: 'POST', body: body(victim.supplierId) })).status).toBe(403);
  });

  it('ADMIN may publish under any seller, but SUPPORT may not', async () => {
    const victim = await supplierWithStock(1);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const body = {
      sellerId: victim.supplierId,
      sellerType: 'SUPPLIER',
      sku: `PB-ADM-${stamp}`,
      categoryId: victim.categoryId,
      name: `PB Admin Product ${stamp}`,
      basePrice: '11.0000',
      currencyCode: 'TND',
    };

    const admin = await createStaffUser('ADMIN');
    expect((await admin.client.req('/api/products', { method: 'POST', body })).status).toBe(201);

    const support = await createStaffUser('SUPPORT');
    expect(
      (await support.client.req('/api/products', {
        method: 'POST',
        body: { ...body, sku: `${body.sku}-s` },
      })).status,
    ).toBe(403);
  });

  it('a seller cannot edit another seller product (403), ADMIN can', async () => {
    const owner = await supplierWithStock(1);
    const other = await registerRole('SUPPLIER');
    await other.req('/api/suppliers', { method: 'POST', body: { companyName: `PB Other ${Date.now()}` } });

    expect(
      (await other.req(`/api/products/${owner.productId}`, { method: 'PATCH', body: { name: 'Hijacked' } })).status,
    ).toBe(403);

    const admin = await createStaffUser('ADMIN');
    expect(
      (await admin.client.req(`/api/products/${owner.productId}`, { method: 'PATCH', body: { name: 'Admin Edit' } })).status,
    ).toBe(200);

    const [row] = await db.select().from(products).where(eq(products.id, owner.productId)).limit(1);
    expect(row.name).toBe('Admin Edit');
  });

  it('CUSTOMER cannot publish a product (403)', async () => {
    const victim = await supplierWithStock(1);
    const customer = await registerRole('CUSTOMER');
    const r = await customer.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: victim.supplierId,
        sellerType: 'SUPPLIER',
        sku: `PB-CUST-${Date.now()}`,
        categoryId: victim.categoryId,
        name: 'PB Customer Product',
        basePrice: '9.0000',
        currencyCode: 'TND',
      },
    });
    expect(r.status).toBe(403);
  });
});
