import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { eq } from 'drizzle-orm';

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

describe('Admin Role Access', () => {
  it('lets ADMIN access /api/admin/* endpoints while CUSTOMER is blocked', async () => {
    // Create an admin user directly in the test DB
    const id = randomUUID();
    const email = `it-admin-${Date.now()}@wasit.tn`;
    const passwordHash = await argon2.hash('AdminPass123!');
    await db.insert(users).values({
      id,
      email,
      passwordHash,
      firstName: 'Integration Admin',
      isActive: true,
      emailVerified: true,
    });
    const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });

    const admin = makeClient();
    const login = await admin.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    for (const path of ['/api/admin/stats', '/api/admin/users', '/api/admin/transactions', '/api/admin/ledger', '/api/admin/products', '/api/admin/orders', '/api/admin/audit-logs']) {
      const r = await admin.req(path);
      expect(r.status).toBe(200);
      expect(r.data.success).toBe(true);
    }

    // Customer must be blocked from every admin endpoint
    const cid = randomUUID();
    const cemail = `it-cust-${Date.now()}@wasit.tn`;
    const cHash = await argon2.hash('CustPass123!');
    await db.insert(users).values({
      id: cid,
      email: cemail,
      passwordHash: cHash,
      firstName: 'Customer',
      isActive: true,
      emailVerified: true,
    });
    const cRole = await db.select().from(roles).where(eq(roles.name, 'CUSTOMER')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: cid, roleId: cRole[0].id });

    const customer = makeClient();
    const custLogin = await customer.req('/api/auth/login', {
      method: 'POST',
      body: { email: cemail, password: 'CustPass123!', allowUnverifiedEmail: true },
    });
    expect(custLogin.status).toBe(200);
    for (const path of ['/api/admin/stats', '/api/admin/users', '/api/admin/ledger', '/api/admin/audit-logs']) {
      const r = await customer.req(path);
      expect(r.status).toBe(403);
    }
  });

  it('writes an ADMIN.USER_STATUS audit log when an admin changes a user status', async () => {
    const aid = randomUUID();
    const aemail = `it-admin-audit-${Date.now()}@wasit.tn`;
    await db.insert(users).values({
      id: aid,
      email: aemail,
      passwordHash: await argon2.hash('AdminPass123!'),
      firstName: 'Admin Audit',
      isActive: true,
      emailVerified: true,
    });
    const adminRole = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: aid, roleId: adminRole[0].id });

    const uid = randomUUID();
    const uemail = `it-user-audit-${Date.now()}@wasit.tn`;
    await db.insert(users).values({
      id: uid,
      email: uemail,
      passwordHash: await argon2.hash('UserPass123!'),
      firstName: 'Target',
      isActive: true,
      emailVerified: true,
    });

    const admin = makeClient();
    await admin.req('/api/auth/login', {
      method: 'POST',
      body: { email: aemail, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    const patch = await admin.req(`/api/admin/users/${uid}/status`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    expect(patch.status).toBe(200);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, uid));
    expect(audits.some((a) => a.action === 'ADMIN.USER_STATUS')).toBe(true);
    expect(audits.find((a) => a.action === 'ADMIN.USER_STATUS')?.actorId).toBe(aid);
  });
});