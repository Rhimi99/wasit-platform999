import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { countries } from '../src/db/schema/geo.js';
import { auditLogs } from '../src/db/schema/audit.js';

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

async function createStaff(roleName: 'ADMIN' | 'SUPPORT') {
  const id = randomUUID();
  const email = `it-country-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

async function countryByCode(code: string) {
  const [row] = await db.select().from(countries).where(eq(countries.code, code)).limit(1);
  if (!row) throw new Error(`seed missing country ${code}`);
  return row;
}

const touched: string[] = [];

afterAll(async () => {
  // Leave the seeded markets as the tests found them.
  for (const id of touched) {
    await db.update(countries).set({ isActive: false, activatedAt: null }).where(eq(countries.id, id));
  }
});

describe('B4 — admin-controlled country activation', () => {
  it('lists countries including inactive candidates', async () => {
    const { client } = await createStaff('ADMIN');
    const r = await client.req('/api/admin/countries');
    expect(r.status).toBe(200);
    const codes = r.data.data.items.map((c: { code: string }) => c.code);
    expect(codes).toContain('TN');
    expect(codes).toContain('FR');
    const fr = r.data.data.items.find((c: { code: string }) => c.code === 'FR');
    expect(fr.isActive).toBe(false);
  });

  it('activates a candidate market and records activatedAt + audit', async () => {
    const { client } = await createStaff('ADMIN');
    const fr = await countryByCode('FR');
    touched.push(fr.id);

    const res = await client.req(`/api/admin/countries/${fr.id}/activation`, {
      method: 'PUT',
      body: { isActive: true, reason: 'Business decision: launch the France market.' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.isActive).toBe(true);

    const [after] = await db.select().from(countries).where(eq(countries.id, fr.id)).limit(1);
    expect(after.isActive).toBe(true);
    expect(after.activatedAt).not.toBeNull();

    const audits = await db.select().from(auditLogs);
    expect(
      audits.some((a) => a.action === 'COUNTRY.ACTIVATED' && a.entityId === fr.id),
    ).toBe(true);
  });

  it('rejects an unknown country with a structured 404', async () => {
    const { client } = await createStaff('ADMIN');
    const res = await client.req(`/api/admin/countries/${randomUUID()}/activation`, {
      method: 'PUT',
      body: { isActive: true, reason: 'Attempt on a missing country.' },
    });
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe('NOT_FOUND');
  });

  it('validates the payload (short reason is refused)', async () => {
    const { client } = await createStaff('ADMIN');
    const fr = await countryByCode('FR');
    const res = await client.req(`/api/admin/countries/${fr.id}/activation`, {
      method: 'PUT',
      body: { isActive: true, reason: 'no' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses non-admin staff and unauthenticated callers', async () => {
    const support = await createStaff('SUPPORT');
    const denied = await support.client.req('/api/admin/countries');
    expect(denied.status).toBe(403);

    const anon = makeClient();
    const res = await anon.req('/api/admin/countries');
    expect(res.status).toBe(401);
  });

  it('deactivates a market again and records the audit entry', async () => {
    const { client } = await createStaff('ADMIN');
    const fr = await countryByCode('FR');
    touched.push(fr.id);

    const res = await client.req(`/api/admin/countries/${fr.id}/activation`, {
      method: 'PUT',
      body: { isActive: false, reason: 'Reversing the launch for the test run.' },
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(countries).where(eq(countries.id, fr.id)).limit(1);
    expect(after.isActive).toBe(false);

    const audits = await db.select().from(auditLogs);
    expect(
      audits.some((a) => a.action === 'COUNTRY.DEACTIVATED' && a.entityId === fr.id),
    ).toBe(true);
  });
});