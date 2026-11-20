import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles, mfaChallenges } from '../src/db/schema/auth.js';
import { generateTotp } from '../src/lib/mfa.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * Mandatory staff MFA (LC-06) — database-backed half.
 *
 * Proves the end-to-end login/enrollment flow against a real database: a staff
 * account without a second factor cannot obtain a staff session or reach a staff
 * API; enrollment opens a session only after a valid TOTP; and ordinary customer
 * accounts are unaffected. The database-free enforcement decision is covered in
 * `staff-mfa-enforcement.test.ts`.
 *
 * This file needs the integration database (`globalSetup` recreates it and runs
 * migrations). It is part of the ordinary suite and is not run when no database
 * is available.
 */

const app = createApp();

afterAll(async () => {
  await resetRateLimitStore();
  await closeDb();
});

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
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

/** Inserts a user with the given role (public register blocks staff roles). */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'RISK' | 'DISPUTE') {
  const id = randomUUID();
  const email = `lc06-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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
  return { id, email, password: 'StaffPass123!' };
}

async function createCustomer() {
  const email = `lc06-customer-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const client = makeClient();
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'LC', role: 'CUSTOMER' },
  });
  expect(reg.status, 'register CUSTOMER').toBe(201);
  return { client, email, password: 'StrongPass123!' };
}

const ADMIN_PROBE = '/api/admin/users';

describe('staff MFA — login enforcement (LC-06)', () => {
  it('a staff login without MFA returns an enrollment challenge and no session', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('ADMIN');
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      expect(login.status).toBe(200);
      const data = login.data.data as { mfaRequired: boolean; mfaEnrollmentRequired: boolean; challengeToken: string };
      expect(data.mfaRequired).toBe(true);
      expect(data.mfaEnrollmentRequired).toBe(true);
      expect(data.challengeToken).toBeTruthy();
      expect(client.cookie).not.toMatch(/wasit_session=/);

      // No session → the staff API and even /me are refused.
      const me = await client.req('/api/auth/me');
      expect(me.status).toBe(401);
      const admin = await client.req(ADMIN_PROBE);
      expect(admin.status).toBe(401);
    });
  });

  it('completing the enrollment challenge with a valid TOTP issues the staff session', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('ADMIN');
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      const { challengeToken } = login.data.data as { challengeToken: string };

      const begin = await client.req('/api/auth/mfa/staff-enroll', {
        method: 'POST',
        body: { challengeToken },
      });
      expect(begin.status).toBe(200);
      const { secretBase32, recoveryCodes } = begin.data.data as { secretBase32: string; recoveryCodes: string[] };
      expect(secretBase32).toBeTruthy();
      expect(recoveryCodes.length).toBeGreaterThan(0);
      // Enrollment begin does not open a session.
      expect(client.cookie).not.toMatch(/wasit_session=/);

      const confirm = await client.req('/api/auth/mfa/staff-confirm', {
        method: 'POST',
        body: { challengeToken, code: generateTotp(secretBase32) },
      });
      expect(confirm.status).toBe(200);
      expect(client.cookie).toMatch(/wasit_session=/);

      const admin = await client.req(ADMIN_PROBE);
      expect(admin.status).toBe(200);
    });
  });

  it('rejects an invalid TOTP at enrollment and keeps the challenge usable', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('ADMIN');
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      const { challengeToken } = login.data.data as { challengeToken: string };
      const begin = await client.req('/api/auth/mfa/staff-enroll', { method: 'POST', body: { challengeToken } });
      const { secretBase32 } = begin.data.data as { secretBase32: string };

      const bad = await client.req('/api/auth/mfa/staff-confirm', {
        method: 'POST',
        body: { challengeToken, code: '000000' },
      });
      expect(bad.status).toBe(401);
      expect(client.cookie).not.toMatch(/wasit_session=/);

      // The valid code still works on the same challenge (attempts < max).
      const good = await client.req('/api/auth/mfa/staff-confirm', {
        method: 'POST',
        body: { challengeToken, code: generateTotp(secretBase32) },
      });
      expect(good.status).toBe(200);
      expect((await client.req(ADMIN_PROBE)).status).toBe(200);
    });
  });

  it('an unenrolled staff account cannot bypass enrollment by calling /mfa/enroll unauthenticated', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('ADMIN');
      const client = makeClient();
      await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      // /mfa/enroll is behind requireAuth; with no session it must be refused.
      const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
      expect(enroll.status).toBe(401);
      expect((await client.req(ADMIN_PROBE)).status).toBe(401);
    });
  });

  it('a staff account with MFA already enabled uses the ordinary challenge', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('SUPER_ADMIN');
      // Enroll while enforcement is off so the account already has a factor.
      await withEnv({ STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
        const c = makeClient();
        const login = await c.req('/api/auth/login', {
          method: 'POST',
          body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
        });
        expect((login.data.data as { mfaRequired: boolean }).mfaRequired).toBe(false);
        const enroll = await c.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
        const { secretBase32 } = enroll.data.data as { secretBase32: string };
        const confirm = await c.req('/api/auth/mfa/confirm', {
          method: 'POST',
          body: { code: generateTotp(secretBase32) },
        });
        expect(confirm.status).toBe(200);
        // Stash the secret for the enforced phase via the DB (already enabled).
      });

      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      const data = login.data.data as { mfaRequired: boolean; mfaEnrollmentRequired?: boolean; challengeToken: string };
      expect(data.mfaRequired).toBe(true);
      expect(data.mfaEnrollmentRequired).toBeFalsy();
      expect(client.cookie).not.toMatch(/wasit_session=/);

      const rows = await db.select().from(users).where(eq(users.id, staff.id)).limit(1);
      expect(rows[0].mfaEnabled).toBe(true);
    });
  });

  it('an existing staff session does not bypass newly enforced MFA', async () => {
    const staff = await createStaffUser('ADMIN');
    // Session opened while enforcement is off (i.e. before the policy).
    const client = makeClient();
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      expect((login.data.data as { mfaRequired: boolean }).mfaRequired).toBe(false);
      expect((await client.req(ADMIN_PROBE)).status).toBe(200);
    });

    // Enforcement turns on; the pre-existing session is now refused by the staff
    // API until the account has a factor (the flag is read live per request).
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const blocked = await client.req(ADMIN_PROBE);
      expect(blocked.status).toBe(403);
      expect((blocked.data.error as { code: string }).code).toBe('MFA_REQUIRED');

      // Enrolling over the existing session (ordinary /mfa/enroll + /mfa/confirm)
      // lifts the block — proving the check follows the account flag, not the
      // session's age.
      const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
      expect(enroll.status).toBe(200);
      const { secretBase32 } = enroll.data.data as { secretBase32: string };
      const confirm = await client.req('/api/auth/mfa/confirm', {
        method: 'POST',
        body: { code: generateTotp(secretBase32) },
      });
      expect(confirm.status).toBe(200);
      expect((await client.req(ADMIN_PROBE)).status).toBe(200);
    });
  });

  it('SUPER_ADMIN without MFA is refused the staff API (no bypass)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('SUPER_ADMIN');
      const client = makeClient();
      await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      const admin = await client.req(ADMIN_PROBE);
      expect(admin.status).toBe(401);
    });
  });

  it('customer login is unaffected by staff MFA enforcement', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { client, email, password } = await createCustomer();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email, password, allowUnverifiedEmail: true },
      });
      expect(login.status).toBe(200);
      expect((login.data.data as { mfaRequired: boolean }).mfaRequired).toBe(false);
      expect(client.cookie).toMatch(/wasit_session=/);
      const me = await client.req('/api/auth/me');
      expect(me.status).toBe(200);
    });
  });

  it('a staff session without MFA is refused on mixed routes too (orders, revenue), not only /admin', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('SUPPORT');
      const client = makeClient();
      // Open a session while enforcement is off, then flip it on.
      await withEnv({ STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
        await client.req('/api/auth/login', {
          method: 'POST',
          body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
        });
        expect((await client.req('/api/orders')).status).toBe(200);
      });
      for (const path of ['/api/orders', '/api/revenue/report', '/api/admin/users']) {
        const blocked = await client.req(path);
        expect(blocked.status, path).toBe(403);
        expect((blocked.data.error as { code: string }).code).toBe('MFA_REQUIRED');
      }
    });
  });

  it('a SUPER_ADMIN without MFA cannot reach /api/revenue/report (no admin-guard assumption)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('SUPER_ADMIN');
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      // Login is refused to an enrollment challenge — no session cookie at all.
      expect(login.data.data).toMatchObject({ mfaEnrollmentRequired: true });
      expect(client.cookie).not.toMatch(/wasit_session=/);
      // So the staff surface is unreachable: unauthenticated (401). The point is
      // that `/api/revenue/report` is *not* blindly reachable by SUPER_ADMIN —
      // unlike the earlier per-prefix design that left it outside the gate.
      const res = await client.req('/api/revenue/report');
      expect(res.status).toBe(401);
    });
  });

  it('a live SUPER_ADMIN session without MFA is refused /api/revenue/report (403, not left open)', async () => {
    const staff = await createStaffUser('SUPER_ADMIN');
    const client = makeClient();
    // Open a session while enforcement is off, then turn it on — the pre-existing
    // session must not keep the staff-only revenue surface reachable.
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
    });
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const res = await client.req('/api/revenue/report');
      expect(res.status).toBe(403);
      expect((res.data.error as { code: string }).code).toBe('MFA_REQUIRED');
    });
  });

  it('a logged-in customer can still use mixed self-service routes while enforcement is on', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { client, email, password } = await createCustomer();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email, password, allowUnverifiedEmail: true },
      });
      expect(login.status).toBe(200);
      expect(client.cookie).toMatch(/wasit_session=/);
      // The shared route is not blocked for a non-staff session by the staff gate.
      const orders = await client.req('/api/orders');
      expect(orders.status).toBe(200);
    });
  });

  it('an expired enrollment challenge cannot open a staff session (token expiry)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const staff = await createStaffUser('ADMIN');
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: staff.email, password: staff.password, allowUnverifiedEmail: true },
      });
      const { challengeToken } = login.data.data as { challengeToken: string };

      // Backdate the freshly-issued challenge's expiry in the disposable test DB.
      await db
        .update(mfaChallenges)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(mfaChallenges.userId, staff.id));

      const begin = await client.req('/api/auth/mfa/staff-enroll', {
        method: 'POST',
        body: { challengeToken },
      });
      expect(begin.status).toBe(401);
      expect(client.cookie).not.toMatch(/wasit_session=/);

      // Confirming with the same expired token is refused too — no session.
      const confirm = await client.req('/api/auth/mfa/staff-confirm', {
        method: 'POST',
        body: { challengeToken, code: '000000' },
      });
      expect(confirm.status).toBe(401);
      expect(client.cookie).not.toMatch(/wasit_session=/);
    });
  });
});
