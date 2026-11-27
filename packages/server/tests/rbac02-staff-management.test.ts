import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { ROLE_PERMISSIONS, STAFF_ROLES } from '@wasit/shared';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { staffStatusRefusal } from '../src/modules/staff/service.js';
import { ASSIGNABLE_STAFF_ROLES } from '../src/modules/staff/types.js';

/**
 * RBAC-02 — staff management and role administration.
 *
 * The suite pins the properties the desk exists for:
 *  1. only SUPER_ADMIN reaches it — ADMIN keeps `user:*` for business accounts
 *     and gains nothing here;
 *  2. the population is staff only, and a business account is a 404 (no probing);
 *  3. SUPER_ADMIN can never be created or re-roled through HTTP;
 *  4. nobody changes their own role or status, and the last active SUPER_ADMIN
 *     cannot be disabled;
 *  5. role/status changes revoke live sessions and land in the audit trail
 *     without a password, token or MFA secret anywhere.
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
      return { res, data: data as any, status: res.status, raw: JSON.stringify(data ?? {}) };
    },
    clearCookie() {
      cookie = '';
    },
  };
}

type Client = ReturnType<typeof makeClient>;

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Inserts a staff account directly (public registration refuses staff roles) and logs it in. */
async function createStaff(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'RISK' | 'DISPUTE') {
  const id = randomUUID();
  const email = `rbac02-${roleName.toLowerCase()}-${stamp()}@wasit.tn`;
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

async function registerBusiness(role: 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY') {
  const client = makeClient();
  const email = `rbac02-${role.toLowerCase()}-${stamp()}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'RB', role },
  });
  expect(r.status).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await client.req('/api/auth/me');
  return { client, id: me.data.data.id as string, email };
}

function staffPayload(email: string, role = 'SUPPORT', extra: Record<string, unknown> = {}) {
  return { email, role, firstName: 'New', lastName: 'Agent', ...extra };
}

// --------------------------------------------------------------------------
// Access control
// --------------------------------------------------------------------------

describe('RBAC-02 — who may reach the staff desk', () => {
  it('rejects anonymous callers', async () => {
    const client = makeClient();
    expect((await client.req('/api/admin/staff')).status).toBe(401);
    expect((await client.req('/api/admin/staff/roles')).status).toBe(401);
    expect(
      (await client.req('/api/admin/staff', { method: 'POST', body: staffPayload(`anon-${stamp()}@wasit.tn`) })).status,
    ).toBe(401);
  });

  it('rejects every business role', async () => {
    for (const role of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY'] as const) {
      const { client } = await registerBusiness(role);
      expect((await client.req('/api/admin/staff')).status, `${role} list`).toBe(403);
      expect(
        (await client.req('/api/admin/staff', { method: 'POST', body: staffPayload(`x-${role}-${stamp()}@wasit.tn`) }))
          .status,
        `${role} create`,
      ).toBe(403);
      expect((await client.req('/api/admin/staff/roles')).status, `${role} roles`).toBe(403);
      expect(
        (await client.req(`/api/admin/staff/${randomUUID()}/role`, { method: 'PATCH', body: { role: 'ADMIN' } })).status,
        `${role} role`,
      ).toBe(403);
      expect(
        (await client.req(`/api/admin/staff/${randomUUID()}/status`, { method: 'PATCH', body: { isActive: false } }))
          .status,
        `${role} status`,
      ).toBe(403);
    }
  });

  it('rejects ADMIN on every staff endpoint — user:* is not role administration', async () => {
    const { client } = await createStaff('ADMIN');
    const target = await createStaff('SUPPORT');
    expect((await client.req('/api/admin/staff')).status).toBe(403);
    expect((await client.req('/api/admin/staff/roles')).status).toBe(403);
    expect((await client.req(`/api/admin/staff/${target.id}`)).status).toBe(403);
    expect(
      (await client.req('/api/admin/staff', { method: 'POST', body: staffPayload(`adm-created-${stamp()}@wasit.tn`) }))
        .status,
    ).toBe(403);
    expect(
      (await client.req(`/api/admin/staff/${target.id}/role`, { method: 'PATCH', body: { role: 'ADMIN' } })).status,
    ).toBe(403);
    expect(
      (await client.req(`/api/admin/staff/${target.id}/status`, { method: 'PATCH', body: { isActive: false } })).status,
    ).toBe(403);

    // …and the target really is untouched.
    const still = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, target.id));
    expect(still[0].isActive).toBe(true);
  });

  it('lets SUPER_ADMIN read the desk and the role catalogue', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const list = await client.req('/api/admin/staff');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.data.items)).toBe(true);

    const catalog = await client.req('/api/admin/staff/roles');
    expect(catalog.status).toBe(200);
    const assignable = catalog.data.data.assignable.map((r: { role: string }) => r.role);
    expect(assignable).toEqual([...ASSIGNABLE_STAFF_ROLES]);
    expect(assignable).not.toContain('SUPER_ADMIN');
    // The preview is the real matrix, not a copy that can drift.
    const dispute = catalog.data.data.assignable.find((r: { role: string }) => r.role === 'DISPUTE');
    expect(new Set(dispute.permissions)).toEqual(new Set(ROLE_PERMISSIONS.DISPUTE));
  });
});

// --------------------------------------------------------------------------
// Listing
// --------------------------------------------------------------------------

describe('RBAC-02 — the list is staff only', () => {
  it('never returns a business account and never leaks credential material', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const support = await createStaff('SUPPORT');
    const customer = await registerBusiness('CUSTOMER');

    const res = await client.req('/api/admin/staff?pageSize=100');
    expect(res.status).toBe(200);
    const emails = res.data.data.items.map((m: { email: string }) => m.email);
    expect(emails).toContain(support.email);
    expect(emails).not.toContain(customer.email);
    expect(res.data.data.items.every((m: { roles: string[] }) => m.roles.some((r) => STAFF_ROLES.includes(r as never)))).toBe(true);

    expect(res.raw).not.toMatch(/passwordHash|password_hash|recoveryCodes|recovery_codes|secret|tokenHash/i);

    // A business id is not addressable either: 404, so the desk cannot probe.
    expect((await client.req(`/api/admin/staff/${customer.id}`)).status).toBe(404);
  });

  it('filters by role, status and free text', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const risk = await createStaff('RISK');

    const byRole = await client.req('/api/admin/staff?role=RISK&pageSize=100');
    expect(byRole.status).toBe(200);
    expect(byRole.data.data.items.length).toBeGreaterThan(0);
    expect(byRole.data.data.items.every((m: { roles: string[] }) => m.roles.includes('RISK'))).toBe(true);
    expect(byRole.data.data.items.map((m: { id: string }) => m.id)).toContain(risk.id);

    const byQuery = await client.req(`/api/admin/staff?q=${encodeURIComponent(risk.email)}`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.data.data.items.map((m: { id: string }) => m.id)).toEqual([risk.id]);

    await client.req(`/api/admin/staff/${risk.id}/status`, { method: 'PATCH', body: { isActive: false } });
    const inactive = await client.req('/api/admin/staff?status=inactive&pageSize=100');
    expect(inactive.data.data.items.map((m: { id: string }) => m.id)).toContain(risk.id);
    const active = await client.req('/api/admin/staff?status=active&pageSize=100');
    expect(active.data.data.items.map((m: { id: string }) => m.id)).not.toContain(risk.id);
  });
});

// --------------------------------------------------------------------------
// Creation
// --------------------------------------------------------------------------

describe('RBAC-02 — creating a staff account', () => {
  it('creates the account, assigns the role and sends an invite instead of a password', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const email = `rbac02-invite-${stamp()}@wasit.tn`;
    const created = await client.req('/api/admin/staff', {
      method: 'POST',
      body: staffPayload(email, 'DISPUTE'),
    });
    expect(created.status).toBe(201);
    const member = created.data.data.member;
    expect(member.email).toBe(email);
    expect(member.roles).toEqual(['DISPUTE']);
    expect(member.emailVerified).toBe(true);
    expect(member.isActive).toBe(true);
    expect(created.data.data.inviteSent).toBe(true);
    expect(created.raw).not.toMatch(/password/i);

    // The invite is the real reset flow: the token from the dev tooling works.
    const token = created.data.data.devResetToken as string;
    expect(typeof token).toBe('string');
    const anon = makeClient();
    const reset = await anon.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'InvitedPass123!' },
    });
    expect(reset.status).toBe(200);
    const login = await anon.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'InvitedPass123!' },
    });
    expect(login.status).toBe(200);
    expect(login.data.data.roles).toEqual(['DISPUTE']);

    const audit = await db
      .select({ action: auditLogs.action, after: auditLogs.after, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, member.id), eq(auditLogs.action, 'RBAC.STAFF_CREATED')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toMatch(/password|token/i);
  });

  it('refuses to mint a SUPER_ADMIN, an unknown role, or a duplicate email', async () => {
    const { client } = await createStaff('SUPER_ADMIN');

    const asSuper = await client.req('/api/admin/staff', {
      method: 'POST',
      body: staffPayload(`rbac02-super-${stamp()}@wasit.tn`, 'SUPER_ADMIN'),
    });
    expect(asSuper.status).toBe(422);

    for (const role of ['OWNER', 'PLATFORM_OWNER', 'SUPERADMIN', 'MERCHANT']) {
      const res = await client.req('/api/admin/staff', {
        method: 'POST',
        body: staffPayload(`rbac02-bad-${role.toLowerCase()}-${stamp()}@wasit.tn`, role),
      });
      expect(res.status, role).toBe(422);
    }

    const duplicate = await client.req('/api/admin/staff', {
      method: 'POST',
      body: staffPayload('SUPPORT-DUP@wasit.tn', 'SUPPORT'),
    });
    expect(duplicate.status).toBe(201);
    const dup = await client.req('/api/admin/staff', {
      method: 'POST',
      body: staffPayload('support-dup@wasit.tn', 'RISK'),
    });
    expect(dup.status).toBe(409);
  });

  it('refuses credential or privilege fields in the body (no silent mass assignment)', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    for (const extra of [
      { password: 'ChosenByAdmin123!' },
      { passwordHash: 'x' },
      { permissions: ['admin:system'] },
      { roles: ['SUPER_ADMIN'] },
      { isActive: false },
      { mfaEnabled: true },
    ]) {
      const res = await client.req('/api/admin/staff', {
        method: 'POST',
        body: staffPayload(`rbac02-extra-${stamp()}@wasit.tn`, 'SUPPORT', extra),
      });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
  });
});

// --------------------------------------------------------------------------
// Role changes
// --------------------------------------------------------------------------

describe('RBAC-02 — changing a role', () => {
  it('replaces the staff role, revokes live sessions and audits before/after', async () => {
    const { client: superClient, id: superId } = await createStaff('SUPER_ADMIN');
    const target = await createStaff('SUPPORT');

    expect((await target.client.req('/api/auth/me')).status).toBe(200);

    const changed = await superClient.req(`/api/admin/staff/${target.id}/role`, {
      method: 'PATCH',
      body: { role: 'DISPUTE' },
    });
    expect(changed.status).toBe(200);
    expect(changed.data.data.member.roles).toEqual(['DISPUTE']);

    // The old cookie was minted under SUPPORT; it must be dead.
    expect((await target.client.req('/api/auth/me')).status).toBe(401);

    const fresh = makeClient();
    const login = await fresh.req('/api/auth/login', {
      method: 'POST',
      body: { email: target.email, password: 'StaffPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);
    expect(login.data.data.roles).toEqual(['DISPUTE']);

    const audit = await db
      .select({ actorId: auditLogs.actorId, before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, target.id), eq(auditLogs.action, 'RBAC.STAFF_ROLE_CHANGED')));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(superId);
    expect(audit[0].before).toEqual({ roles: ['SUPPORT'] });
    expect(audit[0].after).toEqual({ roles: ['DISPUTE'] });
  });

  it('refuses SUPER_ADMIN as the new role and refuses to re-role a SUPER_ADMIN', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const support = await createStaff('SUPPORT');
    const other = await createStaff('SUPER_ADMIN');

    const escalation = await client.req(`/api/admin/staff/${support.id}/role`, {
      method: 'PATCH',
      body: { role: 'SUPER_ADMIN' },
    });
    expect(escalation.status).toBe(422);

    const protectedTarget = await client.req(`/api/admin/staff/${other.id}/role`, {
      method: 'PATCH',
      body: { role: 'ADMIN' },
    });
    expect(protectedTarget.status).toBe(403);

    const rejected = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, other.id), eq(auditLogs.action, 'RBAC.ESCALATION_REJECTED')));
    expect(rejected).toHaveLength(1);
    expect((rejected[0].metadata as { reason: string }).reason).toBe('super_admin_protected');

    // Still a SUPER_ADMIN.
    const rows = await db
      .select({ role: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, other.id));
    expect(rows.map((r) => r.role)).toEqual(['SUPER_ADMIN']);
  });

  it('refuses a self role change even when it is a demotion', async () => {
    const { client, id } = await createStaff('SUPER_ADMIN');
    const res = await client.req(`/api/admin/staff/${id}/role`, { method: 'PATCH', body: { role: 'SUPPORT' } });
    expect(res.status).toBe(403);

    const rows = await db
      .select({ role: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, id));
    expect(rows.map((r) => r.role)).toEqual(['SUPER_ADMIN']);
  });

  it('keeps a business role that the account also holds', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const target = await createStaff('SUPPORT');
    const [merchantRole] = await db.select().from(roles).where(eq(roles.name, 'MERCHANT')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: target.id, roleId: merchantRole.id });

    const changed = await client.req(`/api/admin/staff/${target.id}/role`, {
      method: 'PATCH',
      body: { role: 'RISK' },
    });
    expect(changed.status).toBe(200);

    const rows = await db
      .select({ role: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, target.id));
    expect(rows.map((r) => r.role).sort()).toEqual(['MERCHANT', 'RISK']);
  });
});

// --------------------------------------------------------------------------
// Account protection
// --------------------------------------------------------------------------

describe('RBAC-02 — account protection', () => {
  it('refuses a self status change', async () => {
    const { client, id } = await createStaff('SUPER_ADMIN');
    const res = await client.req(`/api/admin/staff/${id}/status`, { method: 'PATCH', body: { isActive: false } });
    expect(res.status).toBe(403);
    const row = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, id));
    expect(row[0].isActive).toBe(true);
  });

  it('disables a staff member, revokes the session and blocks the login', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const target = await createStaff('SUPPORT');
    expect((await target.client.req('/api/auth/me')).status).toBe(200);

    const off = await client.req(`/api/admin/staff/${target.id}/status`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    expect(off.status).toBe(200);
    expect(off.data.data.member.isActive).toBe(false);
    expect((await target.client.req('/api/auth/me')).status).toBe(401);

    const blocked = makeClient();
    const login = await blocked.req('/api/auth/login', {
      method: 'POST',
      body: { email: target.email, password: 'StaffPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(403);

    const audit = await db
      .select({ before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, target.id), eq(auditLogs.action, 'RBAC.STAFF_STATUS_CHANGED')));
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toEqual({ isActive: true });
    expect(audit[0].after).toEqual({ isActive: false });

    // …and it can be restored.
    const on = await client.req(`/api/admin/staff/${target.id}/status`, {
      method: 'PATCH',
      body: { isActive: true },
    });
    expect(on.status).toBe(200);
    const relogin = makeClient();
    const ok = await relogin.req('/api/auth/login', {
      method: 'POST',
      body: { email: target.email, password: 'StaffPass123!', allowUnverifiedEmail: true },
    });
    expect(ok.status).toBe(200);
  });

  it('pins the last-active-SUPER_ADMIN rule as a pure decision (every branch)', () => {
    const base = {
      isSelf: false,
      isDeactivating: true,
      targetIsSuperAdmin: true,
      actorIsSuperAdmin: true,
      activeSuperAdmins: 3,
    };
    expect(staffStatusRefusal(base)).toBeNull();
    expect(staffStatusRefusal({ ...base, activeSuperAdmins: 1 })).toBe('last_super_admin');
    expect(staffStatusRefusal({ ...base, activeSuperAdmins: 0 })).toBe('last_super_admin');
    expect(staffStatusRefusal({ ...base, actorIsSuperAdmin: false })).toBe('super_admin_protected');
    expect(staffStatusRefusal({ ...base, isSelf: true })).toBe('self_status_change');
    // The last-owner rule outranks the self rule: that is the real blocker.
    expect(staffStatusRefusal({ ...base, isSelf: true, activeSuperAdmins: 1 })).toBe('last_super_admin');
    // A non-SUPER_ADMIN target is only blocked by the self rule.
    expect(
      staffStatusRefusal({ ...base, targetIsSuperAdmin: false, actorIsSuperAdmin: false }),
    ).toBeNull();
    // Re-activation is never blocked by the owner rule.
    expect(
      staffStatusRefusal({ ...base, isDeactivating: false, activeSuperAdmins: 0 }),
    ).toBeNull();
  });

  it('never lets a non-SUPER_ADMIN actor disable a SUPER_ADMIN (service guard)', async () => {
    const superAdmin = await createStaff('SUPER_ADMIN');
    const { setStaffStatus } = await import('../src/modules/staff/service.js');
    await expect(
      setStaffStatus(db, superAdmin.id, false, { id: randomUUID(), roles: ['ADMIN'] }, { actorId: null }),
    ).rejects.toThrow(/Only a SUPER_ADMIN/);
    const row = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, superAdmin.id));
    expect(row[0].isActive).toBe(true);
  });

  it('keeps staff accounts out of the legacy users status route', async () => {
    const { client: adminClient } = await createStaff('ADMIN');
    const support = await createStaff('SUPPORT');
    const superAdmin = await createStaff('SUPER_ADMIN');
    const customer = await registerBusiness('CUSTOMER');

    expect(
      (await adminClient.req(`/api/admin/users/${support.id}/status`, { method: 'PATCH', body: { isActive: false } }))
        .status,
    ).toBe(403);
    expect(
      (
        await adminClient.req(`/api/admin/users/${superAdmin.id}/status`, {
          method: 'PATCH',
          body: { isActive: false },
        })
      ).status,
    ).toBe(403);

    // Business accounts keep working exactly as before…
    expect(
      (await adminClient.req(`/api/admin/users/${customer.id}/status`, { method: 'PATCH', body: { isActive: false } }))
        .status,
    ).toBe(200);
    // …and nobody disables their own account through it.
    const me = await adminClient.req('/api/auth/me');
    expect(
      (await adminClient.req(`/api/admin/users/${me.data.data.id}/status`, { method: 'PATCH', body: { isActive: false } }))
        .status,
    ).toBe(403);
  });
});

// --------------------------------------------------------------------------
// Audit trail
// --------------------------------------------------------------------------

describe('RBAC-02 — the activity feed', () => {
  it('returns the staff timeline without secrets', async () => {
    const { client } = await createStaff('SUPER_ADMIN');
    const created = await client.req('/api/admin/staff', {
      method: 'POST',
      body: staffPayload(`rbac02-feed-${stamp()}@wasit.tn`, 'SUPPORT'),
    });
    const id = created.data.data.member.id as string;
    await client.req(`/api/admin/staff/${id}/role`, { method: 'PATCH', body: { role: 'RISK' } });

    const feed = await client.req(`/api/admin/staff/${id}/activity`);
    expect(feed.status).toBe(200);
    const actions = feed.data.data.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('RBAC.STAFF_CREATED');
    expect(actions).toContain('RBAC.STAFF_ROLE_CHANGED');
    expect(feed.data.data.items[0].actorEmail).toMatch(/@wasit\.tn$/);
    expect(feed.raw).not.toMatch(/password|token|recovery/i);
  });
});
