import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { eq } from 'drizzle-orm';

/**
 * PERM-01A — specialised staff desk access.
 *
 * The general `/api/admin/*` guard used to be ADMIN/SUPER_ADMIN only, which made
 * the StaffOnly desks in the UI unusable for SUPPORT/RISK/DISPUTE. The fix lets
 * the general guard step aside for the four desk prefixes and moves enforcement
 * into `adminEnginesRoutes`, where each desk requires the permission a role must
 * actually hold. These tests pin both halves: the specialised desks open for the
 * right roles only, and every other admin surface stays admin-only.
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

/** Inserts a user directly with a role and logs in (public register blocks staff roles). */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'RISK' | 'DISPUTE') {
  const id = randomUUID();
  const email = `perm01a-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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

async function createCustomer() {
  const client = makeClient();
  const email = `perm01a-customer-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'PC', role: 'CUSTOMER' },
  });
  expect(r.status, 'register CUSTOMER').toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return client;
}

const DESKS = {
  verification: '/api/admin/verification/requests',
  trust: '/api/admin/trust',
  risk: '/api/admin/risk/profiles',
  disputes: '/api/admin/disputes',
} as const;

/** General admin surfaces that must stay ADMIN/SUPER_ADMIN only. */
const GENERAL_ADMIN = [
  '/api/admin/stats',
  '/api/admin/users',
  '/api/admin/orders',
  '/api/admin/transactions',
  '/api/admin/ledger',
  '/api/admin/products',
  '/api/admin/audit-logs',
  '/api/admin/ads/summary',
  '/api/admin/analytics/overview',
  '/api/admin/observability/metrics',
  '/api/admin/policies/dispute',
  '/api/admin/countries',
  '/api/admin/finance/payout-providers',
  '/api/admin/ai/usage',
] as const;

afterAll(async () => {
  await closeDb();
});

describe('PERM-01A — authentication on the specialised desks', () => {
  it('returns 401 for an anonymous caller on every desk', async () => {
    const anon = makeClient();
    for (const path of Object.values(DESKS)) {
      expect((await anon.req(path)).status, path).toBe(401);
    }
  });

  it('returns 401 for an anonymous caller on a general admin surface', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/admin/stats')).status).toBe(401);
  });
});

describe('PERM-01A — CUSTOMER cannot reach any staff or admin desk', () => {
  it('returns 403 on every desk and general admin surface', async () => {
    const customer = await createCustomer();
    for (const path of Object.values(DESKS)) {
      expect((await customer.req(path)).status, path).toBe(403);
    }
    for (const path of GENERAL_ADMIN) {
      expect((await customer.req(path)).status, path).toBe(403);
    }
  });
});

describe('PERM-01A — ADMIN and SUPER_ADMIN keep full administrative access', () => {
  for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
    it(`${role} reaches every desk and every general admin surface`, async () => {
      const staff = await createStaffUser(role);
      for (const path of Object.values(DESKS)) {
        expect((await staff.client.req(path)).status, path).toBe(200);
      }
      for (const path of GENERAL_ADMIN) {
        expect((await staff.client.req(path)).status, path).toBe(200);
      }
    });
  }
});

describe('PERM-01A — SUPPORT reaches only its desks', () => {
  it('reaches trust and disputes, but not verification or risk', async () => {
    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req(DESKS.trust)).status).toBe(200);
    expect((await support.client.req(DESKS.disputes)).status).toBe(200);
    expect((await support.client.req(DESKS.verification)).status).toBe(403);
    expect((await support.client.req(DESKS.risk)).status).toBe(403);
  });

  it('cannot reach any general admin surface', async () => {
    const support = await createStaffUser('SUPPORT');
    for (const path of GENERAL_ADMIN) {
      expect((await support.client.req(path)).status, path).toBe(403);
    }
  });
});

describe('PERM-01A — RISK reaches only its desks', () => {
  it('reaches risk and trust, but not verification or disputes', async () => {
    const risk = await createStaffUser('RISK');
    expect((await risk.client.req(DESKS.risk)).status).toBe(200);
    expect((await risk.client.req(DESKS.trust)).status).toBe(200);
    expect((await risk.client.req(DESKS.verification)).status).toBe(403);
    expect((await risk.client.req(DESKS.disputes)).status).toBe(403);
  });

  it('cannot reach any general admin surface', async () => {
    const risk = await createStaffUser('RISK');
    for (const path of GENERAL_ADMIN) {
      expect((await risk.client.req(path)).status, path).toBe(403);
    }
  });
});

describe('PERM-01A — DISPUTE reaches only its desks', () => {
  it('reaches disputes, but not verification, trust or risk', async () => {
    const dispute = await createStaffUser('DISPUTE');
    expect((await dispute.client.req(DESKS.disputes)).status).toBe(200);
    expect((await dispute.client.req(DESKS.verification)).status).toBe(403);
    expect((await dispute.client.req(DESKS.trust)).status).toBe(403);
    expect((await dispute.client.req(DESKS.risk)).status).toBe(403);
  });

  it('cannot reach any general admin surface', async () => {
    const dispute = await createStaffUser('DISPUTE');
    for (const path of GENERAL_ADMIN) {
      expect((await dispute.client.req(path)).status, path).toBe(403);
    }
  });
});

describe('PERM-01A — cross-desk mutation attempts are refused at the desk boundary', () => {
  it('DISPUTE cannot reassess a user risk profile', async () => {
    const dispute = await createStaffUser('DISPUTE');
    const r = await dispute.client.req(`/api/admin/risk/profiles/${randomUUID()}/reassess`, {
      method: 'POST',
    });
    expect(r.status).toBe(403);
  });

  it('SUPPORT cannot reassess a user risk profile', async () => {
    const support = await createStaffUser('SUPPORT');
    const r = await support.client.req(`/api/admin/risk/profiles/${randomUUID()}/reassess`, {
      method: 'POST',
    });
    expect(r.status).toBe(403);
  });

  it('RISK cannot decide a dispute', async () => {
    const risk = await createStaffUser('RISK');
    const r = await risk.client.req(`/api/admin/disputes/${randomUUID()}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER' },
    });
    expect(r.status).toBe(403);
  });

  it('SUPPORT and DISPUTE cannot review a verification request', async () => {
    for (const role of ['SUPPORT', 'DISPUTE'] as const) {
      const staff = await createStaffUser(role);
      const r = await staff.client.req(`/api/admin/verification/requests/${randomUUID()}/review`, {
        method: 'POST',
        body: { decision: 'APPROVED' },
      });
      expect(r.status, role).toBe(403);
    }
  });
});

describe('PERM-01A — reaching a desk does not grant every action on it', () => {
  it('SUPPORT can read the disputes desk but cannot assign or decide', async () => {
    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req(DESKS.disputes)).status).toBe(200);
    // SUPPORT holds dispute:review/dispute:manage but not dispute:assign/decide.
    expect(
      (
        await support.client.req(`/api/admin/disputes/${randomUUID()}/assign`, {
          method: 'POST',
          body: { reviewerUserId: randomUUID() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await support.client.req(`/api/admin/disputes/${randomUUID()}/decide`, {
          method: 'POST',
          body: { decision: 'IN_FAVOR_OF_BUYER' },
        })
      ).status,
    ).toBe(403);
  });

  it('SUPPORT cannot recompute another user trust score (needs trust:read:all)', async () => {
    const support = await createStaffUser('SUPPORT');
    expect((await support.client.req(DESKS.trust)).status).toBe(200);
    const r = await support.client.req(`/api/admin/trust/${randomUUID()}/recompute`, { method: 'POST' });
    expect(r.status).toBe(403);
  });

  it('DISPUTE is admitted to its own decide action (not blocked by the desk guard)', async () => {
    const dispute = await createStaffUser('DISPUTE');
    // A non-existent dispute proves the request passed the desk + action guards
    // and failed on data, not on permission: 404, never 403.
    const r = await dispute.client.req(`/api/admin/disputes/${randomUUID()}/decide`, {
      method: 'POST',
      body: { decision: 'IN_FAVOR_OF_BUYER' },
    });
    expect(r.status).not.toBe(403);
  });
});
