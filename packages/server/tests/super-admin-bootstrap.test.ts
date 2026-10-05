import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  bootstrapSuperAdmin,
  BootstrapError,
} from '../src/lib/super-admin-bootstrap.js';

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

const PASSWORD = 'Sup3rOwner!Pass#2026';
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function superAdminRoleId(): Promise<string> {
  const rows = await db.select().from(roles).where(eq(roles.name, 'SUPER_ADMIN')).limit(1);
  return rows[0].id;
}

/** Removes the SUPER_ADMIN grants so each spec starts from a clean roster. */
async function clearSuperAdmins(): Promise<void> {
  await db.delete(userRoles).where(eq(userRoles.roleId, await superAdminRoleId()));
}

async function createPlainUser(roleName: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `sa-${roleName.toLowerCase()}-${stamp()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

describe('SUPER_ADMIN bootstrap', () => {
  it('creates the first SUPER_ADMIN through the official bootstrap path', async () => {
    await clearSuperAdmins();
    const email = `bootstrap-owner-${stamp()}@wasit.tn`;

    const result = await bootstrapSuperAdmin(db, { email, password: PASSWORD, source: 'test' });
    expect(result.status).toBe('created');
    expect(result.role).toBe('SUPER_ADMIN');

    const rows = await db
      .select({ email: users.email, role: roles.name })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(users.id, result.userId));
    expect(rows.some((r) => r.role === 'SUPER_ADMIN')).toBe(true);
  });

  it('lets the bootstrapped SUPER_ADMIN log in and reach the admin dashboard', async () => {
    await clearSuperAdmins();
    const email = `bootstrap-login-${stamp()}@wasit.tn`;
    await bootstrapSuperAdmin(db, { email, password: PASSWORD, source: 'test' });

    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.data.data.roles).toContain('SUPER_ADMIN');

    for (const path of [
      '/api/admin/stats',
      '/api/admin/users',
      '/api/admin/orders',
      '/api/admin/products',
      '/api/admin/ledger',
      '/api/admin/audit-logs',
    ]) {
      const r = await client.req(path);
      expect(r.status).toBe(200);
      expect(r.data.success).toBe(true);
    }
  });

  it('refuses a second SUPER_ADMIN unless explicitly allowed, and audits the refusal', async () => {
    await clearSuperAdmins();
    const first = `bootstrap-first-${stamp()}@wasit.tn`;
    await bootstrapSuperAdmin(db, { email: first, password: PASSWORD, source: 'test' });

    const second = `bootstrap-second-${stamp()}@wasit.tn`;
    await expect(
      bootstrapSuperAdmin(db, { email: second, password: PASSWORD, source: 'test' }),
    ).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' });

    // The refusal must survive the aborted transaction.
    const refusals = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AUTH.SUPER_ADMIN_BOOTSTRAP_REFUSED'));
    expect(refusals.some((r) => r.metadata && (r.metadata as Record<string, unknown>).requestedEmail === second)).toBe(true);

    // Explicit opt-in permits an additional owner.
    const allowed = await bootstrapSuperAdmin(db, {
      email: second,
      password: PASSWORD,
      allowAdditional: true,
      source: 'test',
    });
    expect(allowed.status).toBe('created');
  });

  it('rejects a weak password and never stores the plaintext', async () => {
    await clearSuperAdmins();
    await expect(
      bootstrapSuperAdmin(db, { email: `weak-${stamp()}@wasit.tn`, password: 'short' }),
    ).rejects.toBeInstanceOf(BootstrapError);

    const email = `bootstrap-hash-${stamp()}@wasit.tn`;
    const result = await bootstrapSuperAdmin(db, { email, password: PASSWORD, source: 'test' });
    const row = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    expect(row[0].passwordHash).not.toContain(PASSWORD);
    expect(row[0].passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(row[0].passwordHash, PASSWORD)).toBe(true);
  });

  it('records who/what created the account without logging the credential', async () => {
    await clearSuperAdmins();
    const email = `bootstrap-audit-${stamp()}@wasit.tn`;
    const result = await bootstrapSuperAdmin(db, { email, password: PASSWORD, source: 'test' });

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, result.userId));
    const created = rows.find((r) => r.action === 'AUTH.SUPER_ADMIN_BOOTSTRAP');
    expect(created).toBeDefined();
    // Bootstrap is a system action: no human actor, recorded as null.
    expect(created?.actorId).toBeNull();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PASSWORD);
  });

  it('grants the role to an existing account without resetting its password', async () => {
    await clearSuperAdmins();
    const { id, email } = await createPlainUser('CUSTOMER');
    const before = await db.select().from(users).where(eq(users.id, id)).limit(1);

    const result = await bootstrapSuperAdmin(db, {
      email,
      password: PASSWORD,
      source: 'test',
    });
    expect(result.grantedExisting).toBe(true);

    const after = await db.select().from(users).where(eq(users.id, id)).limit(1);
    expect(after[0].passwordHash).toBe(before[0].passwordHash);
    // The account still answers to its original credential.
    expect(await argon2.verify(after[0].passwordHash, PASSWORD)).toBe(true);
  });
});

describe('SUPER_ADMIN privilege escalation is blocked', () => {
  it('refuses role=SUPER_ADMIN from public registration', async () => {
    const client = makeClient();
    const r = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email: `esc-super-${stamp()}@wasit.tn`, password: PASSWORD, role: 'SUPER_ADMIN' },
    });
    expect(r.status).toBe(422);
  });

  it('refuses every privileged role from public registration', async () => {
    const client = makeClient();
    for (const role of ['ADMIN', 'SUPPORT', 'RISK', 'DISPUTE']) {
      const r = await client.req('/api/auth/register', {
        method: 'POST',
        body: { email: `esc-${role.toLowerCase()}-${stamp()}@wasit.tn`, password: PASSWORD, role },
      });
      expect(r.status).toBe(422);
    }
  });

  it('does not let a CUSTOMER promote itself to SUPER_ADMIN', async () => {
    const { email } = await createPlainUser('CUSTOMER');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.data.data.roles).not.toContain('SUPER_ADMIN');

    // No self-service role mutation exists; a crafted attempt must not grant it.
    for (const path of ['/api/auth/role', '/api/auth/me/role', '/api/users/me/role']) {
      const r = await client.req(path, { method: 'PATCH', body: { role: 'SUPER_ADMIN' } });
      expect([403, 404, 405]).toContain(r.status);
    }

    const grants = await db.select().from(userRoles).where(eq(userRoles.userId, (await db.select().from(users).where(eq(users.email, email)).limit(1))[0].id));
    const roleIds = grants.map((g) => g.roleId);
    expect(roleIds).not.toContain(await superAdminRoleId());
  });

  it('does not let a MERCHANT promote itself to SUPER_ADMIN', async () => {
    const { email } = await createPlainUser('MERCHANT');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(login.status).toBe(200);

    const r = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email: `esc-m-${stamp()}@wasit.tn`, password: PASSWORD, role: 'SUPER_ADMIN' },
    });
    expect(r.status).toBe(422);

    const uid = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0].id;
    const grants = await db.select().from(userRoles).where(eq(userRoles.userId, uid));
    expect(grants.map((g) => g.roleId)).not.toContain(await superAdminRoleId());
  });

  it('does not let an ADMIN create a SUPER_ADMIN through the admin API', async () => {
    const { email } = await createPlainUser('ADMIN');
    const client = makeClient();
    await client.req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });

    // The admin surface exposes no role-grant endpoint; every attempt 404s.
    for (const path of ['/api/admin/users/role', '/api/admin/roles', '/api/admin/users/x/role']) {
      const r = await client.req(path, { method: 'POST', body: { role: 'SUPER_ADMIN' } });
      expect([404, 405]).toContain(r.status);
    }
  });

  it('rejects a client-supplied SUPER_ADMIN role on the register endpoint', async () => {
    const client = makeClient();
    const r = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email: `esc-api-${stamp()}@wasit.tn`, password: PASSWORD, role: 'SUPER_ADMIN' },
    });
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('SUPER_ADMIN is the highest role', () => {
  it('has no role above SUPER_ADMIN and grants the full permission set', async () => {
    const { ROLE_HIERARCHY, USER_ROLES, ROLE_PERMISSIONS, PERMISSIONS } = await import('@wasit/shared');
    expect(ROLE_HIERARCHY.SUPER_ADMIN).toBe(100);
    expect(Math.max(...Object.values(ROLE_HIERARCHY))).toBe(100);
    expect(USER_ROLES).not.toContain('PLATFORM_OWNER');
    expect(USER_ROLES).not.toContain('OWNER');

    const all = Object.values(PERMISSIONS);
    for (const p of all) {
      expect(ROLE_PERMISSIONS.SUPER_ADMIN.has(p)).toBe(true);
    }
  });

  it('has exactly one seeded SUPER_ADMIN role row', async () => {
    const rows = await db
      .select({ v: sql<number>`count(*)::int` })
      .from(roles)
      .where(eq(roles.name, 'SUPER_ADMIN'));
    expect(Number(rows[0].v)).toBe(1);
  });
});
