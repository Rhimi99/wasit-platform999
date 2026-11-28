import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import argon2 from 'argon2';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { securityReadGrants } from '../src/db/schema/security-delegations.js';
import { resetWcdcCounters } from '../src/lib/wcdc/collector.js';
import { resetWcdcEnforcement } from '../src/lib/wcdc/enforcement.js';
import { resetWcdcMiddlewareCache } from '../src/lib/wcdc/middleware.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import { env } from '../src/lib/env.js';
import { expireSecurityReadGrants } from '../src/modules/security/delegations.js';
import type { UserRole } from '@wasit/shared';

/**
 * WCDC-02 — delegated read access to the security centre.
 *
 * The GM's policy, asserted end to end against real Postgres and a real HTTP
 * listener: `SECURITY_READ` is SUPER_ADMIN-only; an ADMIN reads only through an
 * explicit, scoped, expiring grant; revocation applies on the next request; and
 * no grant can ever unlock a containment action.
 */

const app = createApp();
const createdUserIds: string[] = [];
const PASSWORD = 'WcdcDelegation!2026-xyz';

let baseUrl = '';
let server: ReturnType<typeof serve> | null = null;
const savedHops = env.TRUSTED_PROXY_HOPS;
const savedCidrs = env.TRUSTED_PROXY_CIDRS;

let ipCounter = 0;

function makeClient(cookie?: string) {
  ipCounter += 1;
  const ip = `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  let current = cookie ?? '';
  return {
    ip,
    get cookie() {
      return current;
    },
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip, ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (current) headers.Cookie = current;
      const res = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) current = setCookie.split(';')[0];
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

async function createUser(role: UserRole, tag: string, options: { active?: boolean } = {}) {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `wcdc02-${tag}-${randomUUID()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: tag,
    isActive: options.active ?? true,
    emailVerified: true,
  });
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  if (roleRow) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow.id });
  const client = makeClient();
  if (options.active !== false) {
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD, allowUnverifiedEmail: true },
    });
    expect(login.status, `login ${role}`).toBe(200);
  }
  return { id, email, client };
}

function grantBody(adminUserId: string, overrides: Partial<{ scopes: string[]; expiresInDays: number; reason: string }> = {}) {
  return {
    adminUserId,
    scopes: overrides.scopes ?? ['overview', 'incidents'],
    expiresInDays: overrides.expiresInDays ?? 1,
    reason: overrides.reason ?? 'cover the night shift (WCDC-02 test)',
  };
}

async function grantsOf(userId: string) {
  return db.select().from(securityReadGrants).where(eq(securityReadGrants.adminUserId, userId));
}

async function auditsOf(action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(desc(auditLogs.createdAt))
    .limit(20);
}

let gm: Awaited<ReturnType<typeof createUser>>;
let gm2: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  env.TRUSTED_PROXY_HOPS = 1;
  env.TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128';
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    const started = server as unknown as { on: (event: string, cb: () => void) => void };
    if ((server as unknown as { listening?: boolean }).listening) return resolve();
    started.on('listening', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  gm = await createUser('SUPER_ADMIN', 'gm');
  gm2 = await createUser('SUPER_ADMIN', 'gm2');
});

beforeEach(async () => {
  resetWcdcCounters();
  resetWcdcEnforcement();
  resetWcdcMiddlewareCache();
  await resetRateLimitStore();
});

afterAll(async () => {
  env.TRUSTED_PROXY_HOPS = savedHops;
  env.TRUSTED_PROXY_CIDRS = savedCidrs;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  if (createdUserIds.length > 0) {
    await db.delete(securityReadGrants).where(inArray(securityReadGrants.adminUserId, createdUserIds));
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('WCDC-02 — who may read the security centre', () => {
  it('lets the GM read without any grant (SECURITY_READ is his by role)', async () => {
    expect((await gm.client.req('/api/admin/security/overview')).status).toBe(200);
    expect((await gm.client.req('/api/admin/security/incidents')).status).toBe(200);

    const me = await gm.client.req('/api/admin/security/delegations/me');
    expect(me.status).toBe(200);
    expect(me.data.data.heldByRole).toBe(true);
    expect(me.data.data.grant).toBeNull();
  });

  it('refuses an ADMIN that holds no delegation', async () => {
    const admin = await createUser('ADMIN', 'plain');

    // ADMIN no longer carries SECURITY_READ at all.
    const overview = await admin.client.req('/api/admin/security/overview');
    expect(overview.status).toBe(403);
    expect((await admin.client.req('/api/admin/security/incidents')).status).toBe(403);
    expect((await admin.client.req('/api/admin/security/blocks')).status).toBe(403);

    const refused = await auditsOf('SECURITY.READ_REFUSED');
    expect(refused.some((row) => row.actorId === admin.id)).toBe(true);

    const me = await admin.client.req('/api/admin/security/delegations/me');
    expect(me.status).toBe(200);
    expect(me.data.data.grant).toBeNull();
  });

  it('opens only the delegated scopes, and refuses the rest', async () => {
    const admin = await createUser('ADMIN', 'scoped');
    const created = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['overview'] }),
    });
    expect(created.status).toBe(200);
    expect(created.data.data.scopes).toEqual(['overview']);
    expect(created.data.data.grantedById).toBe(gm.id);

    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);
    expect((await admin.client.req('/api/admin/security/rules')).status).toBe(403);
    expect((await admin.client.req('/api/admin/security/events')).status).toBe(403);

    const scopeRefusals = await auditsOf('SECURITY.READ_SCOPE_REFUSED');
    expect(scopeRefusals.some((row) => row.actorId === admin.id)).toBe(true);

    const me = await admin.client.req('/api/admin/security/delegations/me');
    expect(me.data.data.grant?.id).toBe(created.data.data.id);
    expect(me.data.data.grant?.scopes).toEqual(['overview']);
  });

  it('audits a delegated read of sensitive surfaces', async () => {
    const admin = await createUser('ADMIN', 'sens');
    await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['incidents', 'events'] }),
    });

    expect((await admin.client.req('/api/admin/security/incidents')).status).toBe(200);
    expect((await admin.client.req('/api/admin/security/events')).status).toBe(200);

    const reads = await auditsOf('SECURITY.DELEGATED_READ');
    const mine = reads.filter((row) => row.actorId === admin.id);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((row) => row.entityId !== null)).toBe(true);
  });
});

describe('WCDC-02 — issuing, amending, revoking', () => {
  it('rejects a self-issued grant, a grant to another ADMIN, and a grant to a non-ADMIN', async () => {
    const admin = await createUser('ADMIN', 'issuer-target');
    const secondAdmin = await createUser('ADMIN', 'issuer-target-2');
    const customer = await createUser('CUSTOMER', 'customer-target');

    // The ADMIN cannot issue anything at all — not to itself, not to anyone.
    expect(
      (await admin.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(admin.id) })).status,
    ).toBe(403);
    expect(
      (await admin.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(secondAdmin.id) }))
        .status,
    ).toBe(403);

    // Nor can the ADMIN revoke or amend somebody else's grant.
    const grant = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id),
    });
    const grantId = grant.data.data.id as string;
    expect(
      (await admin.client.req(`/api/admin/security/delegations/${grantId}/revoke`, { method: 'POST', body: {} })).status,
    ).toBe(403);
    expect(
      (await admin.client.req(`/api/admin/security/delegations/${grantId}`, { method: 'PATCH', body: { scopes: ['rules'] } }))
        .status,
    ).toBe(403);
    expect((await grantsOf(admin.id))[0].scopes).toEqual(['overview', 'incidents']);

    // A SUPER_ADMIN has SECURITY_READ by role, so a grant is meaningless.
    expect(
      (await gm.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(gm.id) })).status,
    ).toBe(409);
    // A grant can only name an ADMIN.
    expect(
      (await gm.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(customer.id) })).status,
    ).toBe(409);
    // And the account must exist.
    expect(
      (await gm.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(randomUUID()) })).status,
    ).toBe(404);
  });

  it('validates scope, expiry, reason and refuses a second live grant', async () => {
    const admin = await createUser('ADMIN', 'validation');

    expect(
      (
        await gm.client.req('/api/admin/security/delegations', {
          method: 'POST',
          body: grantBody(admin.id, { scopes: ['overview', 'everything'] }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await gm.client.req('/api/admin/security/delegations', {
          method: 'POST',
          body: grantBody(admin.id, { expiresInDays: env.SECURITY_DELEGATION_MAX_DAYS + 1 }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await gm.client.req('/api/admin/security/delegations', {
          method: 'POST',
          body: { adminUserId: admin.id, scopes: ['overview'], expiresInDays: 2, reason: 'short' },
        })
      ).status,
    ).toBe(422);

    expect(
      (await gm.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(admin.id) })).status,
    ).toBe(200);
    const again = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id),
    });
    expect(again.status).toBe(409);
    expect(await grantsOf(admin.id)).toHaveLength(1);
  });

  it('amends a live grant: the new scope set applies on the next request', async () => {
    const admin = await createUser('ADMIN', 'amend');
    const created = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['overview', 'rules'] }),
    });
    expect((await admin.client.req('/api/admin/security/rules')).status).toBe(200);

    const amended = await gm.client.req(`/api/admin/security/delegations/${created.data.data.id}`, {
      method: 'PATCH',
      body: { scopes: ['overview'], expiresInDays: 3, reason: 'narrowed after handover' },
    });
    expect(amended.status).toBe(200);
    expect(amended.data.data.scopes).toEqual(['overview']);
    expect(amended.data.data.lastAmendedById).toBe(gm.id);

    expect((await admin.client.req('/api/admin/security/rules')).status).toBe(403);
    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);

    const updates = await auditsOf('SECURITY.DELEGATION_UPDATED');
    const row = updates.find((entry) => entry.entityId === created.data.data.id);
    expect(row).toBeDefined();
    expect(row?.before).toMatchObject({ scopes: ['overview', 'rules'] });
    expect(row?.after).toMatchObject({ scopes: ['overview'] });
  });

  it('revokes immediately, on the existing session, and keeps the trail', async () => {
    const admin = await createUser('ADMIN', 'revoke');
    const created = await gm.client.req('/api/admin/security/delegations', { method: 'POST', body: grantBody(admin.id) });
    const grantId = created.data.data.id as string;

    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);

    const revoked = await gm2.client.req(`/api/admin/security/delegations/${grantId}/revoke`, {
      method: 'POST',
      body: { reason: 'shift ended' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.data.data.revokedById).toBe(gm2.id);

    // Same cookie, no new login: the next call is refused.
    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(403);
    expect((await admin.client.req('/api/admin/security/delegations/me')).data.data.grant).toBeNull();

    // A revoked grant cannot be revoked twice.
    expect(
      (await gm.client.req(`/api/admin/security/delegations/${grantId}/revoke`, { method: 'POST', body: {} })).status,
    ).toBe(409);

    const revocation = (await auditsOf('SECURITY.DELEGATION_REVOKED')).find((row) => row.entityId === grantId);
    expect(revocation).toBeDefined();
    expect(revocation?.actorId).toBe(gm2.id);
  });

  it('refuses an expired grant without waiting for a login, and records the expiry', async () => {
    const admin = await createUser('ADMIN', 'expiry');
    const created = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { expiresInDays: 1 }),
    });
    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);

    // Move the clock past the expiry, as time would.
    await db
      .update(securityReadGrants)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(securityReadGrants.id, created.data.data.id));

    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(403);

    const expired = await expireSecurityReadGrants(db);
    expect(expired).toBeGreaterThanOrEqual(1);
    const [row] = await grantsOf(admin.id);
    expect(row.expiredAt).not.toBeNull();
    expect((await auditsOf('SECURITY.DELEGATION_EXPIRED')).some((entry) => entry.entityId === row.id)).toBe(true);

    // An expired grant does not block a new one from the GM.
    const regrant = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['overview'] }),
    });
    expect(regrant.status).toBe(200);
    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);
  });
});

describe('WCDC-02 — a read grant is only a read grant', () => {
  it('never unlocks a containment action, a policy change or an approval', async () => {
    const admin = await createUser('ADMIN', 'no-respond');
    const allScopes = ['overview', 'incidents', 'events', 'actions', 'blocks', 'rules', 'sessions', 'external'];
    const created = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: allScopes }),
    });
    expect(created.status).toBe(200);

    // Reads all work.
    for (const path of [
      '/api/admin/security/overview',
      '/api/admin/security/incidents',
      '/api/admin/security/events',
      '/api/admin/security/actions',
      '/api/admin/security/blocks',
      '/api/admin/security/rules',
      '/api/admin/security/sessions/at-risk',
      '/api/admin/security/external',
    ]) {
      expect((await admin.client.req(path)).status, path).toBe(200);
    }

    const [incident] = await db.execute<{ id: string }>(sql`SELECT id FROM security_incidents LIMIT 1`).then((r) =>
      (r as unknown as { rows: Array<{ id: string }> }).rows ?? [],
    );

    // Every state change stays with the GM.
    expect(
      (
        await admin.client.req(`/api/admin/security/incidents/${incident?.id ?? randomUUID()}/status`, {
          method: 'POST',
          body: { status: 'ACKNOWLEDGED' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client.req(`/api/admin/security/incidents/${incident?.id ?? randomUUID()}/respond`, {
          method: 'POST',
          body: { action: 'BLOCK_IP', target: '203.0.113.200', reason: 'delegated read must not contain' },
        })
      ).status,
    ).toBe(403);
    expect((await admin.client.req(`/api/admin/security/blocks/${randomUUID()}/revoke`, { method: 'POST' })).status).toBe(
      403,
    );
    expect((await admin.client.req(`/api/admin/security/actions/${randomUUID()}/approve`, { method: 'POST' })).status).toBe(
      403,
    );
    expect((await admin.client.req('/api/admin/security/scan', { method: 'POST', body: {} })).status).toBe(403);
  });

  it('cannot be edited or erased by the beneficiary, and leaves a durable trail', async () => {
    const admin = await createUser('ADMIN', 'tamper');
    const created = await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['overview'] }),
    });
    const grantId = created.data.data.id as string;
    const before = await grantsOf(admin.id);

    // No route lets the beneficiary write the delegation table.
    const attempts = [
      await admin.client.req(`/api/admin/security/delegations/${grantId}`, { method: 'PATCH', body: { scopes: ['rules'] } }),
      await admin.client.req(`/api/admin/security/delegations/${grantId}/revoke`, { method: 'POST', body: {} }),
      await admin.client.req(`/api/admin/security/delegations`, { method: 'POST', body: grantBody(admin.id) }),
      await admin.client.req(`/api/admin/security/delegations/${grantId}`, { method: 'DELETE' }),
    ];
    for (const attempt of attempts) expect([403, 404, 405]).toContain(attempt.status);

    const after = await grantsOf(admin.id);
    expect(after).toHaveLength(before.length);
    expect(after[0].scopes).toEqual(before[0].scopes);
    expect(after[0].revokedAt).toBeNull();

    // The audit rows exist and are written by the system, not the beneficiary.
    const granted = (await auditsOf('SECURITY.DELEGATION_GRANTED')).find((row) => row.entityId === grantId);
    expect(granted?.actorId).toBe(gm.id);

    // And a deleted audit route does not exist for anyone, not even the GM.
    const deleteAudit = await gm.client.req(`/api/admin/audit-logs/${granted?.id}`, { method: 'DELETE' });
    expect([403, 404, 405]).toContain(deleteAudit.status);
    const stillThere = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.id, granted!.id)));
    expect(stillThere).toHaveLength(1);
  });

  it('stops working the moment the ADMIN loses the role, even with a live grant', async () => {
    const admin = await createUser('ADMIN', 'role-removed');
    await gm.client.req('/api/admin/security/delegations', {
      method: 'POST',
      body: grantBody(admin.id, { scopes: ['overview'] }),
    });
    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(200);

    await db.delete(userRoles).where(eq(userRoles.userId, admin.id));

    expect((await admin.client.req('/api/admin/security/overview')).status).toBe(403);
  });
});
