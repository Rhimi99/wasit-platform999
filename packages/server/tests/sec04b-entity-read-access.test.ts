import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { suppliers, merchants, companies, supplierContacts } from '../src/db/schema/trade.js';

/**
 * SEC-04B — entity public/private data protection.
 *
 * Pins the read-side contract established in this phase:
 *  - every entity GET returns only the public projection (no `userId`, `isActive`
 *    or timestamps) to anyone, authenticated or not;
 *  - the private data — supplier contacts, company `registrationNumber`/`taxId` —
 *    is returned only to the owning user or to internal staff (`user:read`);
 *  - an inactive entity is a 404 to the public (existence is not disclosed) but is
 *    readable by its owner and by staff;
 *  - IDOR: any authenticated caller may read the *public* projection of any entity
 *    but never another owner's private data;
 *  - the supplier directory exposes contact e-mail/phone only to staff.
 *
 * These are real integration cases against the live app + PostgreSQL. They are
 * the executed SEC-04B evidence; earlier suites are historical baselines.
 */

const app = createApp();

const PUBLIC_SUPPLIER_KEYS = ['id', 'companyName', 'slug', 'countryId', 'cityId', 'description', 'logoUrl', 'verified'];
const PUBLIC_MERCHANT_KEYS = ['id', 'storeName', 'slug', 'countryId', 'cityId', 'description', 'logoUrl', 'verified'];
const PUBLIC_COMPANY_KEYS = ['id', 'legalName', 'slug', 'countryId', 'cityId', 'industry', 'description', 'logoUrl', 'verified'];
const NEVER_EXPOSED = ['userId', 'isActive', 'createdAt', 'updatedAt'];

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
      if (setCookie) cookie = setCookie.split(';')[0];
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

/** An unauthenticated client — no cookie ever attached. */
function anonClient() {
  return makeClient();
}

/** Inserts a staff user directly with a role and logs in (public register blocks staff roles). */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT') {
  const id = randomUUID();
  const email = `sec04b-${roleName.toLowerCase()}-${stamp()}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} missing — seed did not run`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });

  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login ${roleName}`).toBe(200);
  return { client, id };
}

/** Registers a self-service seller/customer and returns the logged-in client + user id. */
async function registerRole(role: 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY') {
  const client = makeClient();
  const email = `sec04b-${role.toLowerCase()}-${stamp()}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'S4', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await client.req('/api/auth/me');
  const id = (me.data?.data?.id ?? me.data?.data?.user?.id) as string;
  expect(id, 'register response exposed the user id').toBeTruthy();
  return { client, id, email };
}

/** Creates an entity owned by `client` and returns its id. */
async function createEntity(
  client: ReturnType<typeof makeClient>,
  kind: 'suppliers' | 'merchants' | 'companies',
  body: Record<string, unknown>,
) {
  const r = await client.req(`/api/${kind}`, { method: 'POST', body });
  expect(r.status, `create ${kind}`).toBe(201);
  return r.data.data.id as string;
}

async function createSupplierProfile(client: ReturnType<typeof makeClient>, userId: string, withContact = false) {
  const id = await createEntity(client, 'suppliers', { companyName: `S4 Supplier ${stamp()}` });
  if (withContact) {
    const contact = await client.req('/api/suppliers/contacts', {
      method: 'POST',
      body: { supplierId: id, fullName: 'Contact Person', email: `c-${stamp()}@wasit.tn`, phone: '+21600000000', isPrimary: true },
    });
    expect(contact.status, 'create contact').toBe(201);
  }
  void userId;
  return id;
}

async function setEntityActive(kind: 'suppliers' | 'merchants' | 'companies', id: string, isActive: boolean) {
  if (kind === 'suppliers') await db.update(suppliers).set({ isActive }).where(eq(suppliers.id, id));
  if (kind === 'merchants') await db.update(merchants).set({ isActive }).where(eq(merchants.id, id));
  if (kind === 'companies') await db.update(companies).set({ isActive }).where(eq(companies.id, id));
}

/**
 * Asserts `row` carries exactly the public projection (plus any `extraAllowed`
 * private field the caller is authorized to see, e.g. `contacts`).
 */
function expectPublicProjection(row: Record<string, unknown>, allowed: string[], extraAllowed: string[] = []) {
  for (const key of NEVER_EXPOSED) {
    expect(row, `leaked operational field ${key}`).not.toHaveProperty(key);
  }
  for (const key of allowed) {
    expect(row, `missing public field ${key}`).toHaveProperty(key);
  }
  // No field outside the allowed public set (plus any authorized private field)
  // may be present — this is the check that would catch an over-broad projection.
  const permitted = [...allowed, ...extraAllowed];
  for (const key of Object.keys(row)) {
    expect(permitted, `unexpected field ${key} in response`).toContain(key);
  }
}

// ---------------------------------------------------------------------------
// A. Public projection — anonymous visitor
// ---------------------------------------------------------------------------

describe('SEC-04B A — anonymous visitor sees only the public projection', () => {
  it('supplier list and profile expose public fields only', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id, true);

    const list = await anonClient().req('/api/suppliers');
    expect(list.status).toBe(200);
    for (const item of list.data.data.items as Record<string, unknown>[]) {
      expectPublicProjection(item, PUBLIC_SUPPLIER_KEYS);
    }

    const profile = await anonClient().req(`/api/suppliers/${id}`);
    expect(profile.status).toBe(200);
    expectPublicProjection(profile.data.data, PUBLIC_SUPPLIER_KEYS);
    expect(profile.data.data, 'anonymous must not receive contacts').not.toHaveProperty('contacts');
  });

  it('merchant list and profile expose public fields only', async () => {
    const owner = await registerRole('MERCHANT');
    const id = await createEntity(owner.client, 'merchants', { storeName: `S4 Store ${stamp()}` });

    const list = await anonClient().req('/api/merchants');
    expect(list.status).toBe(200);
    for (const item of list.data.data.items as Record<string, unknown>[]) {
      expectPublicProjection(item, PUBLIC_MERCHANT_KEYS);
    }

    const profile = await anonClient().req(`/api/merchants/${id}`);
    expect(profile.status).toBe(200);
    expectPublicProjection(profile.data.data, PUBLIC_MERCHANT_KEYS);
  });

  it('company list and profile hide legal/tax identifiers', async () => {
    const owner = await registerRole('COMPANY');
    const id = await createEntity(owner.client, 'companies', {
      legalName: `S4 Co ${stamp()}`,
      registrationNumber: `RN-${stamp()}`,
      taxId: `TAX-${stamp()}`,
      industry: 'TRADING',
    });

    const list = await anonClient().req('/api/companies');
    expect(list.status).toBe(200);
    for (const item of list.data.data.items as Record<string, unknown>[]) {
      expectPublicProjection(item, PUBLIC_COMPANY_KEYS);
      expect(item).not.toHaveProperty('taxId');
      expect(item).not.toHaveProperty('registrationNumber');
    }

    const profile = await anonClient().req(`/api/companies/${id}`);
    expect(profile.status).toBe(200);
    expectPublicProjection(profile.data.data, PUBLIC_COMPANY_KEYS);
    expect(profile.data.data).not.toHaveProperty('taxId');
    expect(profile.data.data).not.toHaveProperty('registrationNumber');
  });
});

// ---------------------------------------------------------------------------
// B. Private data — owner and staff
// ---------------------------------------------------------------------------

describe('SEC-04B B — private data is owner/staff only', () => {
  it('the supplier owner receives contacts; another seller and the public do not', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id, true);

    const own = await owner.client.req(`/api/suppliers/${id}`);
    expect(own.status).toBe(200);
    expect(own.data.data).toHaveProperty('contacts');
    expect(Array.isArray(own.data.data.contacts)).toBe(true);
    expect(own.data.data.contacts.length).toBeGreaterThan(0);
    expectPublicProjection(own.data.data, PUBLIC_SUPPLIER_KEYS, ['contacts']);

    const other = await registerRole('MERCHANT');
    const foreign = await other.client.req(`/api/suppliers/${id}`);
    expect(foreign.status).toBe(200);
    expect(foreign.data.data, 'a non-owner must not receive contacts').not.toHaveProperty('contacts');
    expectPublicProjection(foreign.data.data, PUBLIC_SUPPLIER_KEYS);
  });

  it('staff (SUPPORT) receive contacts; ADMIN and SUPER_ADMIN too', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id, true);

    for (const role of ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] as const) {
      const staff = await createStaffUser(role);
      const res = await staff.client.req(`/api/suppliers/${id}`);
      expect(res.status, `${role} read`).toBe(200);
      expect(res.data.data, `${role} should receive contacts`).toHaveProperty('contacts');
    }
  });

  it('company legal identifiers go to the owner and staff only', async () => {
    const owner = await registerRole('COMPANY');
    const id = await createEntity(owner.client, 'companies', {
      legalName: `S4 Co ${stamp()}`,
      registrationNumber: `RN-${stamp()}`,
      taxId: `TAX-${stamp()}`,
    });

    const own = await owner.client.req(`/api/companies/${id}`);
    expect(own.status).toBe(200);
    expect(own.data.data).toHaveProperty('registrationNumber');
    expect(own.data.data).toHaveProperty('taxId');

    const admin = await createStaffUser('ADMIN');
    const staffRes = await admin.client.req(`/api/companies/${id}`);
    expect(staffRes.status).toBe(200);
    expect(staffRes.data.data).toHaveProperty('taxId');

    const other = await registerRole('MERCHANT');
    const foreign = await other.client.req(`/api/companies/${id}`);
    expect(foreign.status).toBe(200);
    expect(foreign.data.data).not.toHaveProperty('taxId');
    expect(foreign.data.data).not.toHaveProperty('registrationNumber');
  });
});

// ---------------------------------------------------------------------------
// C. Inactive entities
// ---------------------------------------------------------------------------

describe('SEC-04B C — inactive entities are 404 to the public', () => {
  it('an inactive supplier is hidden from the public but visible to owner and staff', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id);
    await setEntityActive('suppliers', id, false);

    expect((await anonClient().req(`/api/suppliers/${id}`)).status, 'public').toBe(404);

    const other = await registerRole('MERCHANT');
    expect((await other.client.req(`/api/suppliers/${id}`)).status, 'other seller').toBe(404);

    expect((await owner.client.req(`/api/suppliers/${id}`)).status, 'owner').toBe(200);
    const admin = await createStaffUser('ADMIN');
    expect((await admin.client.req(`/api/suppliers/${id}`)).status, 'admin').toBe(200);
  });

  it('an inactive merchant and company are 404 to the public, 200 to owner', async () => {
    const m = await registerRole('MERCHANT');
    const mId = await createEntity(m.client, 'merchants', { storeName: `S4 Inactive ${stamp()}` });
    await setEntityActive('merchants', mId, false);
    expect((await anonClient().req(`/api/merchants/${mId}`)).status).toBe(404);
    expect((await m.client.req(`/api/merchants/${mId}`)).status).toBe(200);

    const c = await registerRole('COMPANY');
    const cId = await createEntity(c.client, 'companies', { legalName: `S4 Inactive Co ${stamp()}` });
    await setEntityActive('companies', cId, false);
    expect((await anonClient().req(`/api/companies/${cId}`)).status).toBe(404);
    expect((await c.client.req(`/api/companies/${cId}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// D. IDOR
// ---------------------------------------------------------------------------

describe('SEC-04B D — IDOR: public projection is readable, private data is not', () => {
  it('every role may read the public projection of a foreign entity, none may read its private data', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id, true);

    const readers: Array<[string, ReturnType<typeof makeClient>]> = [
      ['anonymous', anonClient()],
      ['CUSTOMER', (await registerRole('CUSTOMER')).client],
      ['MERCHANT', (await registerRole('MERCHANT')).client],
      ['SUPPLIER', (await registerRole('SUPPLIER')).client],
      ['COMPANY', (await registerRole('COMPANY')).client],
      ['SUPPORT', (await createStaffUser('SUPPORT')).client],
      ['ADMIN', (await createStaffUser('ADMIN')).client],
      ['SUPER_ADMIN', (await createStaffUser('SUPER_ADMIN')).client],
    ];

    for (const [label, client] of readers) {
      const res = await client.req(`/api/suppliers/${id}`);
      expect(res.status, `${label} read`).toBe(200);
      const isStaff = label === 'SUPPORT' || label === 'ADMIN' || label === 'SUPER_ADMIN';
      if (isStaff) {
        expectPublicProjection(res.data.data, PUBLIC_SUPPLIER_KEYS, ['contacts']);
        expect(res.data.data, `${label} staff should see contacts`).toHaveProperty('contacts');
      } else {
        expectPublicProjection(res.data.data, PUBLIC_SUPPLIER_KEYS);
        expect(res.data.data, `${label} must not see contacts`).not.toHaveProperty('contacts');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// E. Directory contact PII
// ---------------------------------------------------------------------------

describe('SEC-04B E — supplier directory hides contact PII from non-staff', () => {
  it('a seller-role caller gets the directory without contactEmail/contactPhone; staff get them', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id, true);
    await db.insert(supplierContacts).values({
      id: randomUUID(),
      supplierId: id,
      fullName: 'Directory Contact',
      email: `dir-${stamp()}@wasit.tn`,
      phone: '+21611111111',
      isPrimary: true,
    });

    // The platform directory is global and ordered by company name, so with the
    // hundreds of suppliers other suites create, this row can fall outside the
    // first page. Scope the read to this supplier's own unique name instead of
    // relying on page one; the ID lookup and the PII assertions are unchanged.
    const [supplier] = await db
      .select({ companyName: suppliers.companyName })
      .from(suppliers)
      .where(eq(suppliers.id, id))
      .limit(1);
    const q = encodeURIComponent(supplier.companyName);

    const customer = await registerRole('CUSTOMER');
    const asCustomer = await customer.client.req(`/api/directory/suppliers?q=${q}&pageSize=100`);
    expect(asCustomer.status).toBe(200);
    const customerRow = (asCustomer.data.data.items as Record<string, unknown>[]).find((r) => r.id === id);
    expect(customerRow, 'directory should still list the supplier').toBeTruthy();
    expect(customerRow).not.toHaveProperty('contactEmail');
    expect(customerRow).not.toHaveProperty('contactPhone');

    const admin = await createStaffUser('ADMIN');
    const asAdmin = await admin.client.req(`/api/directory/suppliers?q=${q}&pageSize=100`);
    expect(asAdmin.status).toBe(200);
    const adminRow = (asAdmin.data.data.items as Record<string, unknown>[]).find((r) => r.id === id);
    expect(adminRow).toBeTruthy();
    expect(adminRow).toHaveProperty('contactEmail');
    expect(adminRow).toHaveProperty('contactPhone');
  });
});

// ---------------------------------------------------------------------------
// F. Compatibility — public surfaces still work
// ---------------------------------------------------------------------------

describe('SEC-04B F — marketplace/search/SEO compatibility', () => {
  it('the public search endpoint still returns entity groups with the public projection', async () => {
    const owner = await registerRole('SUPPLIER');
    const name = `S4 Searchable ${stamp()}`;
    await createEntity(owner.client, 'suppliers', { companyName: name });

    const res = await anonClient().req(`/api/search?q=${encodeURIComponent(name)}&type=suppliers`);
    expect(res.status).toBe(200);
    const group = (res.data.data.results as Array<{ type: string; items: Record<string, unknown>[] }>).find((g) => g.type === 'suppliers');
    expect(group, 'search should still surface suppliers').toBeTruthy();
    for (const item of group!.items) {
      for (const key of NEVER_EXPOSED) expect(item).not.toHaveProperty(key);
    }
  });

  it('structured-data (JSON-LD) still resolves a public supplier', async () => {
    const owner = await registerRole('SUPPLIER');
    const id = await createSupplierProfile(owner.client, owner.id);
    const res = await anonClient().req(`/api/seo/structured-data/SUPPLIER/${id}`);
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('@type', 'Organization');
    expect(res.data.data).toHaveProperty('name');
  });
});
