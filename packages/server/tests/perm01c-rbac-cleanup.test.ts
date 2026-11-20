import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';

/**
 * PERM-01C — RBAC cleanup regression suite.
 *
 * Pins the four code changes made in this phase:
 *  - R1: business-entity create/update routes are gated by the RBAC permission
 *        (not a role name alone), while self-service onboarding and resource
 *        ownership stay intact — no role, ADMIN/SUPER_ADMIN included, bypasses
 *        the ownership check.
 *  - R2: `admin:reports` guards the reports desk, not the tax desk; tax is a
 *        policy-desk surface (`admin:policies`).
 *  - R3: the demo-owner reports probe points at the real route.
 *  - R6: the ghost `payment.view` web feature is gone.
 *
 * The static cases (R3/R6) need no database; the rest are integration cases.
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

/** Inserts a staff user directly with a role and logs in (public register blocks staff roles). */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'RISK' | 'DISPUTE') {
  const id = randomUUID();
  const email = `perm01c-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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
  const email = `perm01c-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'PC', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return client;
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// --------------------------------------------------------------------------
// R3 / R6 — static contracts (no database required)
// --------------------------------------------------------------------------

describe('PERM-01C R3/R6 — static contracts', () => {
  it('R3: the demo-owner reports probe points at the real route', () => {
    const catalog = readFileSync(
      new URL('../../web/src/lib/demo-owner-catalog.ts', import.meta.url),
      'utf8',
    );
    expect(catalog).toContain("path: '/api/admin/analytics/reports'");
    // The old, non-existent probe must not linger.
    expect(catalog).not.toContain("probe: { method: 'GET', path: '/api/admin/reports' }");
  });

  it('R3: GET /api/admin/analytics/reports is registered, /api/admin/reports is not', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = (app as any).routes as { method: string; path: string }[];
    expect(routes.some((r) => r.method === 'GET' && r.path === '/api/admin/analytics/reports')).toBe(true);
    expect(routes.some((r) => r.method === 'GET' && r.path === '/api/admin/reports')).toBe(false);
  });

  it('R6: the ghost payment.view web feature is gone', () => {
    const rbac = readFileSync(new URL('../../web/src/lib/rbac.ts', import.meta.url), 'utf8');
    expect(rbac).not.toContain('payment.view');
  });
});

// --------------------------------------------------------------------------
// R1 — entity create/update guards + ownership
// --------------------------------------------------------------------------

describe('PERM-01C R1 — business-entity create/update guards', () => {
  it('SUPPLIER self-service creates its own supplier (201)', async () => {
    const supplier = await registerRole('SUPPLIER');
    const res = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 Own ${stamp()}` } });
    expect(res.status).toBe(201);
  });

  it('MERCHANT self-service creates its own merchant (201)', async () => {
    const merchant = await registerRole('MERCHANT');
    const res = await merchant.req('/api/merchants', { method: 'POST', body: { storeName: `R1 Store ${stamp()}` } });
    expect(res.status).toBe(201);
  });

  it('COMPANY self-service creates its own company (201)', async () => {
    const company = await registerRole('COMPANY');
    const res = await company.req('/api/companies', { method: 'POST', body: { legalName: `R1 Co ${stamp()}` } });
    expect(res.status).toBe(201);
  });

  it('a seller role cannot create a different entity kind (403)', async () => {
    const merchant = await registerRole('MERCHANT');
    const res = await merchant.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 Wrong ${stamp()}` } });
    expect(res.status).toBe(403);
  });

  it('CUSTOMER cannot create merchant or company (403)', async () => {
    const customer = await registerRole('CUSTOMER');
    const merchant = await customer.req('/api/merchants', { method: 'POST', body: { storeName: `R1 Illegal ${stamp()}` } });
    expect(merchant.status).toBe(403);
    const company = await customer.req('/api/companies', { method: 'POST', body: { legalName: `R1 Illegal ${stamp()}` } });
    expect(company.status).toBe(403);
  });

  it('ADMIN cannot create business entities (lacks *_create) (403)', async () => {
    const admin = await createStaffUser('ADMIN');
    const supplier = await admin.client.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 Admin ${stamp()}` } });
    expect(supplier.status).toBe(403);
    const merchant = await admin.client.req('/api/merchants', { method: 'POST', body: { storeName: `R1 Admin ${stamp()}` } });
    expect(merchant.status).toBe(403);
    const company = await admin.client.req('/api/companies', { method: 'POST', body: { legalName: `R1 Admin ${stamp()}` } });
    expect(company.status).toBe(403);
  });

  it('SUPER_ADMIN may create business entities (holds *_create) (201)', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 Super ${stamp()}` } });
    expect(res.status).toBe(201);
  });

  it('MERCHANT edits its own profile but not another merchant profile (200 / 403)', async () => {
    const a = await registerRole('MERCHANT');
    const b = await registerRole('MERCHANT');
    const aId = (await a.req('/api/merchants', { method: 'POST', body: { storeName: `R1 A ${stamp()}` } })).data.data.id as string;
    const bId = (await b.req('/api/merchants', { method: 'POST', body: { storeName: `R1 B ${stamp()}` } })).data.data.id as string;

    const own = await a.req(`/api/merchants/${aId}`, { method: 'PATCH', body: { description: 'mine' } });
    expect(own.status).toBe(200);

    const foreign = await a.req(`/api/merchants/${bId}`, { method: 'PATCH', body: { description: 'not mine' } });
    expect(foreign.status).toBe(403);
  });

  it('COMPANY edits its own profile but not another company profile (200 / 403)', async () => {
    const a = await registerRole('COMPANY');
    const b = await registerRole('COMPANY');
    const aId = (await a.req('/api/companies', { method: 'POST', body: { legalName: `R1 A ${stamp()}` } })).data.data.id as string;
    const bId = (await b.req('/api/companies', { method: 'POST', body: { legalName: `R1 B ${stamp()}` } })).data.data.id as string;

    const own = await a.req(`/api/companies/${aId}`, { method: 'PATCH', body: { description: 'mine' } });
    expect(own.status).toBe(200);

    const foreign = await a.req(`/api/companies/${bId}`, { method: 'PATCH', body: { description: 'not mine' } });
    expect(foreign.status).toBe(403);
  });

  it('SUPPLIER adds a contact to its own profile but not to another supplier (201 / 403)', async () => {
    const a = await registerRole('SUPPLIER');
    const b = await registerRole('SUPPLIER');
    const aId = (await a.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 A ${stamp()}` } })).data.data.id as string;
    const bId = (await b.req('/api/suppliers', { method: 'POST', body: { companyName: `R1 B ${stamp()}` } })).data.data.id as string;

    const own = await a.req('/api/suppliers/contacts', {
      method: 'POST',
      body: { supplierId: aId, fullName: 'Owner Contact' },
    });
    expect(own.status).toBe(201);

    const foreign = await a.req('/api/suppliers/contacts', {
      method: 'POST',
      body: { supplierId: bId, fullName: 'Intruder Contact' },
    });
    expect(foreign.status).toBe(403);
  });

  it('ADMIN cannot edit another party\'s merchant profile (ownership is not bypassed) (403)', async () => {
    const merchant = await registerRole('MERCHANT');
    const merchantId = (await merchant.req('/api/merchants', { method: 'POST', body: { storeName: `R1 M ${stamp()}` } })).data.data.id as string;
    const admin = await createStaffUser('ADMIN');
    const res = await admin.client.req(`/api/merchants/${merchantId}`, { method: 'PATCH', body: { description: 'admin edit' } });
    expect(res.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// R2 — reports vs tax permission binding
// --------------------------------------------------------------------------

describe('PERM-01C R2 — reports desk and tax desk permission binding', () => {
  it('ADMIN reaches the reports endpoint (admin:reports) (200)', async () => {
    const admin = await createStaffUser('ADMIN');
    const res = await admin.client.req('/api/admin/analytics/reports');
    expect(res.status).toBe(200);
  });

  it('MERCHANT is refused the reports endpoint (403)', async () => {
    const merchant = await registerRole('MERCHANT');
    const res = await merchant.req('/api/admin/analytics/reports');
    expect(res.status).toBe(403);
  });

  it('SUPPORT is refused the reports endpoint (403)', async () => {
    const support = await createStaffUser('SUPPORT');
    const res = await support.client.req('/api/admin/analytics/reports');
    expect(res.status).toBe(403);
  });

  it('ADMIN reaches tax jurisdictions (admin:policies) (200)', async () => {
    const admin = await createStaffUser('ADMIN');
    const res = await admin.client.req('/api/admin/tax/jurisdictions');
    expect(res.status).toBe(200);
  });

  it('MERCHANT and SUPPORT are refused tax jurisdictions (403)', async () => {
    const merchant = await registerRole('MERCHANT');
    const support = await createStaffUser('SUPPORT');
    expect((await merchant.req('/api/admin/tax/jurisdictions')).status).toBe(403);
    expect((await support.client.req('/api/admin/tax/jurisdictions')).status).toBe(403);
  });

  it('an anonymous caller is refused tax jurisdictions (401)', async () => {
    const anon = makeClient();
    const res = await anon.req('/api/admin/tax/jurisdictions');
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// R7 — specialised staff still cannot reach general admin routes
// --------------------------------------------------------------------------

describe('PERM-01C R7 — specialised staff cannot reach general admin routes', () => {
  it('SUPPORT cannot read /api/admin/users (403)', async () => {
    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req('/api/admin/users')).status).toBe(403);
  });

  it('RISK cannot read /api/admin/ledger (403)', async () => {
    const risk = await createStaffUser('RISK');
    expect((await risk.client.req('/api/admin/ledger')).status).toBe(403);
  });

  it('DISPUTE cannot read /api/admin/transactions (403)', async () => {
    const dispute = await createStaffUser('DISPUTE');
    expect((await dispute.client.req('/api/admin/transactions')).status).toBe(403);
  });
});
