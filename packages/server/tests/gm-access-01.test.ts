import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, like, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { authenticatorApp, roles, sessions, userRoles, users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { gmAccessTickets } from '../src/db/schema/gm-access.js';
import { generateMfaSecret, generateTotp } from '../src/lib/mfa.js';
import { issueGmAccessTicket } from '../src/lib/gm-access.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();
const PASSWORD = 'GmAcc3ss!Pass#2026';
const PREFIX = 'gmacc';
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  // Remove everything this file created so no other spec sees a stray SUPER_ADMIN
  // (super-admin-bootstrap.test.ts asserts on the roster).
  const created = await db.select({ id: users.id }).from(users).where(like(users.email, `${PREFIX}-%`));
  const ids = created.map((u) => u.id);
  for (const id of ids) {
    await db.delete(gmAccessTickets).where(eq(gmAccessTickets.userId, id));
    await db.delete(authenticatorApp).where(eq(authenticatorApp.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(userRoles).where(eq(userRoles.userId, id));
  }
  await db.delete(users).where(like(users.email, `${PREFIX}-%`));
  await db.delete(auditLogs).where(like(auditLogs.action, 'GM_ACCESS.%'));
  await resetRateLimitStore();
});

function makeClient(ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip, Origin: 'http://localhost:5173' };
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

async function roleId(name: string): Promise<string> {
  const rows = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (rows.length === 0) throw new Error(`missing role ${name}`);
  return rows[0].id;
}

async function createUser(
  label: string,
  options: { role?: 'SUPER_ADMIN' | 'ADMIN' | 'CUSTOMER' | 'MERCHANT'; verified?: boolean } = {},
) {
  const id = randomUUID();
  const email = `${PREFIX}-${label}-${stamp()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: label,
    emailVerified: options.verified ?? false,
    isActive: true,
  });
  if (options.role) await grantRole(id, options.role);
  return { id, email, password: PASSWORD };
}

async function grantRole(userId: string, name: string): Promise<void> {
  const id = await roleId(name);
  const existing = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, id)))
    .limit(1);
  if (existing.length === 0) await db.insert(userRoles).values({ id: randomUUID(), userId, roleId: id });
}

/**
 * The bootstrap spec clears every SUPER_ADMIN grant while it runs (files run in
 * parallel against one database), so the grant is re-asserted per test rather
 * than once in beforeAll.
 */
async function ensureSuperAdmin(userId: string): Promise<void> {
  await grantRole(userId, 'SUPER_ADMIN');
}

async function createGm(label = 'gm'): Promise<{ id: string; email: string; password: string }> {
  const user = await createUser(label, { role: 'SUPER_ADMIN', verified: false });
  await ensureSuperAdmin(user.id);
  return user;
}

async function rolesOf(userId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${userId}
  `);
  const list = ((rows as unknown as { rows?: { name: string }[] }).rows ?? (rows as unknown as { name: string }[])) ?? [];
  return list.map((r) => r.name).sort();
}

async function auditsFor(action: string, entityId?: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return entityId ? rows.filter((r) => r.entityId === entityId) : rows;
}

/**
 * Enrols a confirmed TOTP for an account through the real HTTP endpoints.
 *
 * Enrolment happens from an authenticated session, so the address is marked
 * verified first — the gate is what the caller is testing, not the setup.
 */
async function enrolFactor(email: string, password: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  const client = makeClient();
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status).toBe(200);
  const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: { password } });
  expect(enroll.status).toBe(200);
  const { secretBase32, recoveryCodes } = enroll.data.data as { secretBase32: string; recoveryCodes: string[] };
  const confirm = await client.req('/api/auth/mfa/confirm', {
    method: 'POST',
    body: { code: generateTotp(secretBase32) },
  });
  expect(confirm.status).toBe(200);
  await client.req('/api/auth/logout', { method: 'POST' });
  return { secret: secretBase32, recoveryCodes };
}

describe('GM-ACCESS-01 — general manager sign-in without a delivered email', () => {
  it('refuses an unverified SUPER_ADMIN without a ticket, then admits it with a valid ticket', async () => {
    const gm = await createGm('ticket');
    const client = makeClient();

    const blocked = await client.req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } });
    expect(blocked.status).toBe(403);
    expect(blocked.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(client.cookie).not.toMatch(/wasit_session=/);

    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Mailbox unreachable, verified by phone', issuedBy: 'test-operator' });

    const ok = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(ok.status).toBe(200);
    expect(client.cookie).toMatch(/wasit_session=/);
    expect(JSON.stringify(ok.data)).not.toContain(issued.ticket);

    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(200);

    const [row] = await db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, gm.id));
    expect(row.emailVerified).toBe(true);

    expect((await auditsFor('GM_ACCESS.TICKET_ISSUED', gm.id)).length).toBe(1);
    expect((await auditsFor('GM_ACCESS.EMAIL_GATE_SATISFIED', gm.id)).length).toBe(1);
  });

  it('accepts a ticket exactly once', async () => {
    const gm = await createGm('once');
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'First and only use expected', issuedBy: 'test-operator' });

    const first = makeClient();
    const ok = await first.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(ok.status).toBe(200);

    // Reset the verification flag so the gate is the blocker again: reuse must
    // still fail on the ticket itself, not merely be skipped.
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, gm.id));
    const replay = makeClient();
    const again = await replay.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(again.status).toBe(403);
    expect(again.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(replay.cookie).not.toMatch(/wasit_session=/);
    expect((await auditsFor('GM_ACCESS.TICKET_REJECTED', gm.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('does not let a ticket issued for one account open another', async () => {
    const gm = await createGm('owner');
    const other = await createUser('bystander', { role: 'CUSTOMER', verified: false });
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Ticket must stay account bound', issuedBy: 'test-operator' });

    const client = makeClient();
    const attempt = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: other.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    const [row] = await db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, other.id));
    expect(row.emailVerified).toBe(false);
  });

  it('refuses an expired ticket', async () => {
    const gm = await createGm('expired');
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Expiry must be enforced', issuedBy: 'test-operator' });
    await db
      .update(gmAccessTickets)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(gmAccessTickets.id, issued.ticketId));

    const client = makeClient();
    const attempt = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(attempt.status).toBe(403);
    expect(client.cookie).not.toMatch(/wasit_session=/);
  });

  it('revokes the previous ticket when a new one is issued', async () => {
    const gm = await createGm('superseded');
    const first = await issueGmAccessTicket(db, { email: gm.email, reason: 'First ticket gets superseded', issuedBy: 'test-operator' });
    const second = await issueGmAccessTicket(db, { email: gm.email, reason: 'Second ticket replaces the first', issuedBy: 'test-operator' });

    const stale = makeClient();
    const staleAttempt = await stale.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: first.ticket },
    });
    expect(staleAttempt.status).toBe(403);

    const fresh = makeClient();
    const freshAttempt = await fresh.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: second.ticket },
    });
    expect(freshAttempt.status).toBe(200);
  });

  it('refuses to issue a ticket for any account that is not a SUPER_ADMIN', async () => {
    const customer = await createUser('notgm', { role: 'CUSTOMER', verified: false });
    await expect(
      issueGmAccessTicket(db, { email: customer.email, reason: 'Attempting to widen the tool', issuedBy: 'test-operator' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const admin = await createUser('adminonly', { role: 'ADMIN', verified: false });
    await expect(
      issueGmAccessTicket(db, { email: admin.email, reason: 'ADMIN must not become the GM', issuedBy: 'test-operator' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const refused = await auditsFor('GM_ACCESS.TICKET_REFUSED');
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the role roster untouched: a ticket never grants or changes a role', async () => {
    const gm = await createGm('roles');
    const before = await rolesOf(gm.id);
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Role roster must not change', issuedBy: 'test-operator' });
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });
    expect(await rolesOf(gm.id)).toEqual(before);
  });

  it('a confirmed authenticator satisfies the gate with no email and no ticket', async () => {
    const gm = await createGm('factor');
    const { secret } = await enrolFactor(gm.email, PASSWORD);
    // The enrolment login verified the address; reset it to prove the gate is
    // satisfied by the factor alone.
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, gm.id));

    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.data.data.mfaRequired).toBe(true);
    expect(client.cookie).not.toMatch(/wasit_session=/);

    const done = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: login.data.data.challengeToken, code: generateTotp(secret) },
    });
    expect(done.status).toBe(200);
    expect(client.cookie).toMatch(/wasit_session=/);
    expect((await auditsFor('AUTH.EMAIL_VERIFIED_VIA_MFA', gm.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('does not accept a half-finished enrolment as proof', async () => {
    const gm = await createGm('unconfirmed');
    const pending = generateMfaSecret();
    await db.insert(authenticatorApp).values({
      id: randomUUID(),
      userId: gm.id,
      secret: pending.secretBase32,
      enabled: false,
      confirmedAt: null,
    });
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } });
    expect(login.status).toBe(403);
    expect(login.data.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('a ticket never bypasses an enabled second factor', async () => {
    const gm = await createGm('bypass');
    await enrolFactor(gm.email, PASSWORD);
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Ticket must not skip the TOTP step', issuedBy: 'test-operator' }).catch(
      () => null,
    );
    // A confirmed factor means the CLI refuses to mint a ticket at all; if one
    // somehow exists, presenting it must still not produce a session.
    if (issued) {
      const client = makeClient();
      const login = await client.req('/api/auth/login', {
        method: 'POST',
        body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
      });
      expect(login.status).toBe(200);
      expect(login.data.data.mfaRequired).toBe(true);
      expect(client.cookie).not.toMatch(/wasit_session=/);
    }
    expect(issued).toBeNull();
  });

  it('keeps the gate for everyone else: an unverified customer is still refused', async () => {
    const customer = await createUser('plaincustomer', { role: 'CUSTOMER', verified: false });
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: customer.email, password: PASSWORD } });
    expect(login.status).toBe(403);
    expect(login.data.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('does not change the normal sign-in of verified users', async () => {
    const customer = await createUser('verifiedcustomer', { role: 'CUSTOMER', verified: true });
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: customer.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(client.cookie).toMatch(/wasit_session=/);
  });
});

describe('GM-ACCESS-01 — session and factor lifecycle', () => {
  it('rejects an expired session', async () => {
    const user = await createUser('sessionexpiry', { role: 'CUSTOMER', verified: true });
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id));
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const user = await createUser('sessionlogout', { role: 'CUSTOMER', verified: true });
    const client = makeClient();
    await client.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    expect((await client.req('/api/auth/me')).status).toBe(200);
    await client.req('/api/auth/logout', { method: 'POST' });
    expect((await client.req('/api/auth/me')).status).toBe(401);
  });

  it('requires the password to start enrolment and revokes other sessions when the factor changes', async () => {
    const user = await createUser('factorchange', { role: 'CUSTOMER', verified: true });
    const first = makeClient();
    const second = makeClient();
    await first.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    await second.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    expect((await second.req('/api/auth/me')).status).toBe(200);

    // A hijacked cookie alone cannot displace the factor.
    const noPassword = await first.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    expect(noPassword.status).toBeGreaterThanOrEqual(400);
    const wrongPassword = await first.req('/api/auth/mfa/enroll', { method: 'POST', body: { password: 'not-the-password' } });
    expect(wrongPassword.status).toBe(401);

    const enroll = await first.req('/api/auth/mfa/enroll', { method: 'POST', body: { password: PASSWORD } });
    expect(enroll.status).toBe(200);
    const { secretBase32 } = enroll.data.data as { secretBase32: string };
    const confirm = await first.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.data.data.sessionsRevoked).toBeGreaterThanOrEqual(1);

    // The second device was signed in before the factor existed.
    expect((await second.req('/api/auth/me')).status).toBe(401);
    // The session that made the change survives.
    expect((await first.req('/api/auth/me')).status).toBe(200);
  });

  it('consumes a recovery code once at the login challenge', async () => {
    const user = await createUser('recoverycode', { role: 'CUSTOMER', verified: true });
    const { recoveryCodes } = await enrolFactor(user.email, PASSWORD);
    const code = recoveryCodes[0];

    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    expect(login.data.data.mfaRequired).toBe(true);
    const ok = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: login.data.data.challengeToken, code },
    });
    expect(ok.status).toBe(200);

    const replay = makeClient();
    const login2 = await replay.req('/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    const reused = await replay.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: login2.data.data.challengeToken, code },
    });
    expect(reused.status).toBe(401);
    expect(replay.cookie).not.toMatch(/wasit_session=/);
  });

  it('never writes a ticket, password or code into the audit trail', async () => {
    const gm = await createGm('leak');
    const issued = await issueGmAccessTicket(db, { email: gm.email, reason: 'Checking the trail holds no secrets', issuedBy: 'test-operator' });
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: gm.email, password: PASSWORD, gmTicket: issued.ticket },
    });

    const rows = await db.select().from(auditLogs).where(like(auditLogs.action, 'GM_ACCESS.%'));
    expect(rows.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(issued.ticket);
    expect(serialised).not.toContain(PASSWORD);
    // The stored hash must not be there either.
    expect(serialised).not.toContain('tokenHash');
  });
});
