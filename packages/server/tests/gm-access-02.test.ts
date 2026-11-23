import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { eq, like, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { authenticatorApp, roles, sessions, userRoles, users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { gmAccessTickets } from '../src/db/schema/gm-access.js';
import {
  assertStrongGmPassword,
  generateGmPassword,
  GM_PASSWORD_MIN_LENGTH,
  setSuperAdminPassword,
} from '../src/lib/gm-access.js';
import { generateMfaSecret, generateTotp } from '../src/lib/mfa.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();
const PASSWORD = 'GmAcc3ss!Pass#2026';
const PREFIX = 'gmrot';
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  await resetRateLimitStore();
});

afterAll(async () => {
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

function makeClient(ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`) {
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

async function grantRole(userId: string, name: string): Promise<void> {
  const id = await roleId(name);
  await db.insert(userRoles).values({ id: randomUUID(), userId, roleId: id }).onConflictDoNothing();
}

async function createUser(
  label: string,
  options: { role?: 'SUPER_ADMIN' | 'ADMIN' | 'CUSTOMER'; verified?: boolean; password?: string } = {},
) {
  const id = randomUUID();
  const email = `${PREFIX}-${label}-${stamp()}@wasit.tn`;
  const password = options.password ?? PASSWORD;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: label,
    emailVerified: options.verified ?? true,
    isActive: true,
  });
  if (options.role) await grantRole(id, options.role);
  return { id, email, password };
}

async function rolesOf(userId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${userId}
  `);
  const list = ((rows as unknown as { rows?: { name: string }[] }).rows ?? (rows as unknown as { name: string }[])) ?? [];
  return list.map((r) => r.name).sort();
}

async function auditRows(action: string, entityId: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return rows.filter((r) => r.entityId === entityId);
}

describe('GM-ACCESS-02 — password generation', () => {
  it('generates 32 characters that satisfy the policy', () => {
    const password = generateGmPassword();
    expect(password).toHaveLength(32);
    expect(password.length).toBeGreaterThanOrEqual(GM_PASSWORD_MIN_LENGTH);
    expect(() => assertStrongGmPassword(password, 'owner@wasit.tn')).not.toThrow();
    expect(/[a-z]/.test(password)).toBe(true);
    expect(/[A-Z]/.test(password)).toBe(true);
    expect(/[0-9]/.test(password)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(password)).toBe(true);
  });

  it('never repeats a generated password', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateGmPassword());
    expect(seen.size).toBe(200);
  });

  it('refuses the credential it exists to replace, short and re-used passwords', () => {
    expect(() => assertStrongGmPassword('Rhimi123', 'owner@wasit.tn')).toThrow();
    expect(() => assertStrongGmPassword('Passw0rd!2026', 'owner@wasit.tn')).toThrow();
    expect(() => assertStrongGmPassword('Short1!', 'owner@wasit.tn')).toThrow();
    // 24 characters but only three classes.
    expect(() => assertStrongGmPassword('abcdefghijklmnopqrstuvwx', 'owner@wasit.tn')).toThrow();
    // Long and mixed, but contains the account name.
    expect(() => assertStrongGmPassword('OwnerName-Fixed!Passw0rd-2026', 'ownername@wasit.tn')).toThrow();
  });
});

describe('GM-ACCESS-02 — rotation against the real endpoints', () => {
  it('replaces the password of one SUPER_ADMIN and revokes every old session', async () => {
    const gm = await createUser('gm', { role: 'SUPER_ADMIN' });
    const other = await createUser('other', { role: 'SUPER_ADMIN' });

    const first = makeClient();
    expect((await first.req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } })).status).toBe(200);
    const second = makeClient();
    expect((await second.req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } })).status).toBe(200);
    const bystander = makeClient();
    expect((await bystander.req('/api/auth/login', { method: 'POST', body: { email: other.email, password: PASSWORD } })).status).toBe(200);

    const otherHashBefore = (await db.select().from(users).where(eq(users.id, other.id)).limit(1))[0].passwordHash;

    const newPassword = generateGmPassword();
    const rotation = await setSuperAdminPassword(db, {
      email: gm.email,
      password: newPassword,
      reason: 'Rotating a credential that was published in a chat',
      changedBy: 'vitest',
    });

    expect(rotation.userId).toBe(gm.id);
    expect(rotation.sessionsRevoked).toBe(2);

    // Both old sessions are dead; the bystander's session is not.
    expect((await first.req('/api/auth/me')).status).toBe(401);
    expect((await second.req('/api/auth/me')).status).toBe(401);
    expect((await bystander.req('/api/auth/me')).status).toBe(200);

    // Old password refused, new one accepted.
    const stale = await makeClient().req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: PASSWORD } });
    expect(stale.status).toBe(401);
    const fresh = await makeClient().req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: newPassword } });
    expect(fresh.status).toBe(200);

    // The other account is untouched, bit for bit.
    const otherAfter = (await db.select().from(users).where(eq(users.id, other.id)).limit(1))[0];
    expect(otherAfter.passwordHash).toBe(otherHashBefore);
    expect(otherAfter.emailVerified).toBe(true);
  });

  it('keeps the email gate, the roles and the authenticator exactly as they were', async () => {
    const gm = await createUser('gates', { role: 'SUPER_ADMIN', verified: false });
    const pending = generateMfaSecret();
    await db.insert(authenticatorApp).values({
      id: randomUUID(),
      userId: gm.id,
      secret: pending.secretBase32,
      enabled: false,
      confirmedAt: null,
    });
    const rolesBefore = await rolesOf(gm.id);

    const newPassword = generateGmPassword();
    await setSuperAdminPassword(db, {
      email: gm.email,
      password: newPassword,
      reason: 'Owner lost the previous password',
      changedBy: 'vitest',
    });

    const after = (await db.select().from(users).where(eq(users.id, gm.id)).limit(1))[0];
    expect(after.emailVerified).toBe(false); // gate intact: no free verification
    expect(after.isActive).toBe(true);
    expect(await rolesOf(gm.id)).toEqual(rolesBefore);

    const factor = (await db.select().from(authenticatorApp).where(eq(authenticatorApp.userId, gm.id)).limit(1))[0];
    expect(factor.secret).toBe(pending.secretBase32);
    expect(factor.enabled).toBe(false);

    // Unverified account: the new password alone still hits the gate, and no
    // password change turned the gate off.
    const login = await makeClient().req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: newPassword } });
    expect(login.status).toBe(403);
    expect(login.data.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('still requires the second factor after the password changes', async () => {
    const gm = await createUser('mfa', { role: 'SUPER_ADMIN' });
    const secret = generateMfaSecret();
    await db.insert(authenticatorApp).values({
      id: randomUUID(),
      userId: gm.id,
      secret: secret.secretBase32,
      enabled: true,
      confirmedAt: new Date(),
    });
    await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, gm.id));

    const newPassword = generateGmPassword();
    await setSuperAdminPassword(db, {
      email: gm.email,
      password: newPassword,
      reason: 'Rotating after a suspected leak',
      changedBy: 'vitest',
    });

    const login = await makeClient().req('/api/auth/login', { method: 'POST', body: { email: gm.email, password: newPassword } });
    expect(login.status).toBe(200);
    expect(login.data.data.mfaRequired).toBe(true);
    expect(login.data.data.challengeToken).toBeTruthy();
    // No session was handed out on password alone.
    expect((await makeClient().req('/api/auth/me')).status).toBe(401);

    const verified = makeClient();
    const challenge = await verified.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: login.data.data.challengeToken, code: generateTotp(secret.secretBase32) },
    });
    expect(challenge.status).toBe(200);
    expect(verified.cookie).toContain('wasit_session');
    expect((await verified.req('/api/auth/me')).status).toBe(200);
  });

  it('refuses any account that is not SUPER_ADMIN and changes nothing', async () => {
    const customer = await createUser('customer', { role: 'CUSTOMER' });
    const admin = await createUser('admin', { role: 'ADMIN' });
    const hashBefore = (await db.select().from(users).where(eq(users.id, customer.id)).limit(1))[0].passwordHash;
    const adminHashBefore = (await db.select().from(users).where(eq(users.id, admin.id)).limit(1))[0].passwordHash;

    const attempt = generateGmPassword();
    await expect(
      setSuperAdminPassword(db, { email: customer.email, password: attempt, reason: 'Attempt to widen the tool', changedBy: 'vitest' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      setSuperAdminPassword(db, { email: admin.email, password: attempt, reason: 'Attempt to widen the tool', changedBy: 'vitest' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect((await db.select().from(users).where(eq(users.id, customer.id)).limit(1))[0].passwordHash).toBe(hashBefore);
    expect((await db.select().from(users).where(eq(users.id, admin.id)).limit(1))[0].passwordHash).toBe(adminHashBefore);
    expect(await auditRows('GM_ACCESS.PASSWORD_RESET_REFUSED', customer.id)).toHaveLength(1);
    expect(await auditRows('GM_ACCESS.PASSWORD_RESET_REFUSED', admin.id)).toHaveLength(1);
    expect(await auditRows('GM_ACCESS.PASSWORD_RESET', customer.id)).toHaveLength(0);
  });

  it('refuses a weak password and a short reason without touching the account', async () => {
    const gm = await createUser('weak', { role: 'SUPER_ADMIN' });
    const hashBefore = (await db.select().from(users).where(eq(users.id, gm.id)).limit(1))[0].passwordHash;

    await expect(
      setSuperAdminPassword(db, { email: gm.email, password: 'Rhimi123', reason: 'Trying the old password', changedBy: 'vitest' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      setSuperAdminPassword(db, { email: gm.email, password: generateGmPassword(), reason: 'short', changedBy: 'vitest' }),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect((await db.select().from(users).where(eq(users.id, gm.id)).limit(1))[0].passwordHash).toBe(hashBefore);
    expect(await auditRows('GM_ACCESS.PASSWORD_RESET', gm.id)).toHaveLength(0);
  });

  it('records who, why and what was revoked, and never the credential', async () => {
    const gm = await createUser('audit', { role: 'SUPER_ADMIN' });
    const newPassword = generateGmPassword();
    await setSuperAdminPassword(db, {
      email: gm.email,
      password: newPassword,
      reason: 'Owner request after device loss',
      changedBy: 'operator@host',
    });

    const rows = await auditRows('GM_ACCESS.PASSWORD_RESET', gm.id);
    expect(rows).toHaveLength(1);
    const metadata = JSON.stringify(rows[0].metadata);
    expect(rows[0].metadata).toMatchObject({ reason: 'Owner request after device loss', changedBy: 'operator@host' });
    expect(metadata).not.toContain(newPassword);
    const hash = (await db.select().from(users).where(eq(users.id, gm.id)).limit(1))[0].passwordHash;
    expect(metadata).not.toContain(hash);
  });

  it('stores the new password as an argon2 hash, not as text', async () => {
    const gm = await createUser('hash', { role: 'SUPER_ADMIN' });
    const newPassword = generateGmPassword();
    await setSuperAdminPassword(db, {
      email: gm.email,
      password: newPassword,
      reason: 'Rotating for the owner',
      changedBy: 'vitest',
    });
    const hash = (await db.select().from(users).where(eq(users.id, gm.id)).limit(1))[0].passwordHash;
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(hash).not.toContain(newPassword);
    expect(await argon2.verify(hash, newPassword)).toBe(true);
  });
});

describe('GM-ACCESS-02 — vault file handling', () => {
  it('writes the secret with 0600 in a 0700 directory outside any Git tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasit-vault-'));
    const target = join(dir, 'nested', 'gm-owner.txt');
    try {
      // Mirrors writeSecretFile in src/scripts/gm-access.ts.
      mkdirSync(join(dir, 'nested'), { recursive: true, mode: 0o700 });
      chmodSync(join(dir, 'nested'), 0o700);
      const fd = openSync(target, 'wx', 0o600);
      try {
        writeSync(fd, 'placeholder\n');
      } finally {
        closeSync(fd);
      }
      chmodSync(target, 0o600);

      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
      expect(readFileSync(target, 'utf8').trim()).toBe('placeholder');
      // `wx` refuses to overwrite an existing secret.
      expect(() => openSync(target, 'wx', 0o600)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a group-readable secret file as a refusal, not a warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasit-vault-'));
    const target = join(dir, 'loose.txt');
    try {
      writeFileSync(target, 'something\n');
      chmodSync(target, 0o644);
      expect((statSync(target).mode & 0o077) !== 0).toBe(true);
      chmodSync(target, 0o600);
      expect((statSync(target).mode & 0o077) === 0).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
