import { describe, it, expect, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, emailVerificationTokens, passwordResetTokens, phoneVerificationTokens } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { hashToken } from '../src/lib/security.js';
import { newId } from '../src/lib/ids.js';
import {
  requestPasswordReset,
  issueEmailVerificationToken,
  issuePhoneVerificationCode,
} from '../src/modules/auth/service.js';

/**
 * Single-use enforcement for email-verification and password-reset tokens.
 *
 * These drive the real HTTP surface against the real database (no mocks). Each
 * client carries its own `x-forwarded-for` so the auth rate-limit buckets do not
 * bleed between cases.
 */

const app = createApp();

let ipCounter = 90;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function makeClient(ip = nextIp()) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
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
      return { status: res.status, data: data as any };
    },
  };
}

async function registerUnverified(email: string, ip = nextIp()) {
  const c = makeClient(ip);
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Token', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return { c, userId: row.id };
}

/** Mints a real reset token through the public flow and returns it. */
async function issueResetToken(email: string, ip = nextIp()): Promise<string> {
  const c = makeClient(ip);
  const res = await c.req('/api/auth/forgot-password', { method: 'POST', body: { email } });
  expect(res.status).toBe(200);
  const token = res.data?.data?.devResetToken as string | undefined;
  expect(token).toBeTruthy();
  return token as string;
}

afterAll(async () => {
  await closeDb();
});

describe('Password-reset token is single-use', () => {
  it('accepts a valid unused token exactly once', async () => {
    const email = `reset-once-${Date.now()}@wasit.tn`;
    const { c } = await registerUnverified(email);
    const token = await issueResetToken(email);

    const first = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'FirstPass123!' },
    });
    expect(first.status).toBe(200);

    // The new password is live.
    const login = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'FirstPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    // The token row is marked used.
    const [row] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashToken(token)))
      .limit(1);
    expect(row.usedAt).not.toBeNull();
  });

  it('rejects a replayed reset token and leaves the newer password in place', async () => {
    const email = `reset-replay-${Date.now()}@wasit.tn`;
    const { c } = await registerUnverified(email);
    const token = await issueResetToken(email);

    const first = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'FirstPass123!' },
    });
    expect(first.status).toBe(200);

    const replay = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'ReplayPass123!' },
    });
    expect(replay.status).toBe(401);

    // The replay changed nothing: the first password still authenticates and the
    // attempted one does not.
    const good = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'FirstPass123!', allowUnverifiedEmail: true },
    });
    expect(good.status).toBe(200);
    const bad = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'ReplayPass123!', allowUnverifiedEmail: true },
    });
    expect(bad.status).toBe(401);
  });

  it('rejects an unknown reset token', async () => {
    const c = makeClient();
    const res = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token: 'test-never-issued-token-value', newPassword: 'WhateverPass123!' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired reset token', async () => {
    const email = `reset-expired-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUnverified(email);
    const token = 'test-expired-reset-token-fixture';
    await db.insert(passwordResetTokens).values({
      id: newId(),
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'ExpiredPass123!' },
    });
    expect(res.status).toBe(401);

    // An expired token is not silently consumed as if it had worked.
    const [row] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashToken(token)))
      .limit(1);
    expect(row.usedAt).toBeNull();
  });

  it('does not consume the token when the request fails (short password)', async () => {
    const email = `reset-rollback-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUnverified(email);
    const token = await issueResetToken(email);

    const tooShort = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'short' },
    });
    expect(tooShort.status).toBe(422);

    // The claim was rolled back, so the token is still outstanding and usable.
    const stillActive = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    expect(stillActive.length).toBe(1);

    const retry = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'RecoveredPass123!' },
    });
    expect(retry.status).toBe(200);
  });

  it('lets only one of two concurrent requests consume the token', async () => {
    const email = `reset-race-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);
    const token = await issueResetToken(email);

    const a = makeClient();
    const b = makeClient();
    const [ra, rb] = await Promise.all([
      a.req('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'RacePassOne123!' } }),
      b.req('/api/auth/reset-password', { method: 'POST', body: { token, newPassword: 'RacePassTwo123!' } }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 401]);

    // Exactly one reset happened — the loser wrote no audit row and changed nothing.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, 'AUTH.PASSWORD_RESET')));
    expect(audits.length).toBe(1);
  });
});

describe('Password-reset token rotation (newest link only)', () => {
  it('invalidates the previous token when a new one is issued', async () => {
    const email = `reset-rotate-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUnverified(email);

    const first = await issueResetToken(email);
    const second = await issueResetToken(email);

    // Only the newest token is active.
    const active = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    expect(active.length).toBe(1);
    expect(active[0].tokenHash).toBe(hashToken(second));

    // The superseded token is dead; the newest one works.
    const oldTry = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token: first, newPassword: 'RotatedOne123!' },
    });
    expect(oldTry.status).toBe(401);

    const newTry = await c.req('/api/auth/reset-password', {
      method: 'POST',
      body: { token: second, newPassword: 'RotatedTwo123!' },
    });
    expect(newTry.status).toBe(200);
  });

  it('keeps the response uniform for a known and an unknown account', async () => {
    const known = `reset-uniform-known-${Date.now()}@wasit.tn`;
    await registerUnverified(known);

    const knownRes = await makeClient().req('/api/auth/forgot-password', { method: 'POST', body: { email: known } });
    const unknownRes = await makeClient().req('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: `reset-uniform-missing-${Date.now()}@wasit.tn` },
    });

    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    expect(unknownRes.data.data?.devResetToken).toBeUndefined();
  });

  it('leaves exactly one active token under concurrent issuance', async () => {
    const email = `reset-rotate-race-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => requestPasswordReset(db, email)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const active = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    expect(active.length).toBe(1);

    // All issued rows exist, but only the newest is active.
    const all = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userId));
    expect(all.length).toBe(10);
  });

  it('does not leave a superseded token active when the new issuance fails', async () => {
    const email = `reset-rotate-fail-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);

    const token = await issueResetToken(email);
    expect(
      (await db
        .select()
        .from(passwordResetTokens)
        .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt))))
        .length,
    ).toBe(1);

    // Drive the real issuance inside an outer transaction that then fails: the
    // rotation and the new insert are rolled back together, so the previously
    // outstanding token is left exactly as it was — one active token, not zero.
    await expect(
      db.transaction(async (outer) => {
        await requestPasswordReset(outer as unknown as typeof db, email);
        throw new Error('forced-rollback');
      }),
    ).rejects.toThrow('forced-rollback');

    const stillActive = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    expect(stillActive.length).toBe(1);
    expect(stillActive[0].tokenHash).toBe(hashToken(token));
  });
});

describe('Email-verification token is single-use', () => {
  it('accepts a valid unused token exactly once and verifies the account', async () => {
    const email = `verify-once-${Date.now()}@wasit.tn`;
    const { c } = await registerUnverified(email);

    const link = await c.req('/api/auth/dev/verification-link', { method: 'POST', body: { email } });
    expect(link.status).toBe(200);
    const token = link.data.data.token as string;

    const first = await c.req('/api/auth/verify-email', { method: 'POST', body: { token } });
    expect(first.status).toBe(200);

    const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!' } });
    expect(login.status).toBe(200);
  });

  it('rejects a replayed verification token', async () => {
    const email = `verify-replay-${Date.now()}@wasit.tn`;
    const { c } = await registerUnverified(email);

    const link = await c.req('/api/auth/dev/verification-link', { method: 'POST', body: { email } });
    const token = link.data.data.token as string;

    const first = await c.req('/api/auth/verify-email', { method: 'POST', body: { token } });
    expect(first.status).toBe(200);
    const replay = await c.req('/api/auth/verify-email', { method: 'POST', body: { token } });
    expect(replay.status).toBe(401);
  });

  it('rejects an unknown verification token', async () => {
    const c = makeClient();
    const res = await c.req('/api/auth/verify-email', { method: 'POST', body: { token: 'never-issued-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects an expired verification token without consuming it', async () => {
    const email = `verify-expired-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUnverified(email);
    const token = 'test-expired-verification-token-fixture';
    await db.insert(emailVerificationTokens).values({
      id: newId(),
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await c.req('/api/auth/verify-email', { method: 'POST', body: { token } });
    expect(res.status).toBe(401);

    const [row] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, hashToken(token)))
      .limit(1);
    expect(row.usedAt).toBeNull();
  });

  it('lets only one of two concurrent requests consume the token', async () => {
    const email = `verify-race-${Date.now()}@wasit.tn`;
    const { c } = await registerUnverified(email);

    const link = await c.req('/api/auth/dev/verification-link', { method: 'POST', body: { email } });
    const token = link.data.data.token as string;

    const a = makeClient();
    const b = makeClient();
    const [ra, rb] = await Promise.all([
      a.req('/api/auth/verify-email', { method: 'POST', body: { token } }),
      b.req('/api/auth/verify-email', { method: 'POST', body: { token } }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 401]);
  });
});

describe('Atomic issuance of verification tokens (one active per user per kind)', () => {
  async function registerWithPhone(email: string, phone: string) {
    const c = makeClient();
    const reg = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', firstName: 'Issue', role: 'CUSTOMER', phone },
    });
    expect(reg.status).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return { c, userId: row.id };
  }

  const activeEmail = (userId: string) =>
    db
      .select()
      .from(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));

  const activePhone = (userId: string) =>
    db
      .select()
      .from(phoneVerificationTokens)
      .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)));

  it('email issuance invalidates the previous token', async () => {
    const email = `issue-email-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUnverified(email);

    const first = await issueEmailVerificationToken(db, userId);
    const second = await issueEmailVerificationToken(db, userId);

    const active = await activeEmail(userId);
    expect(active.length).toBe(1);
    expect(active[0].tokenHash).toBe(hashToken(second));

    // The superseded link is dead; the newest one verifies.
    const oldTry = await c.req('/api/auth/verify-email', { method: 'POST', body: { token: first } });
    expect(oldTry.status).toBe(401);
    const newTry = await c.req('/api/auth/verify-email', { method: 'POST', body: { token: second } });
    expect(newTry.status).toBe(200);
  });

  it('email issuance keeps one active token under concurrent issuance', async () => {
    const email = `issue-email-race-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);

    // Registration already issued one token; measure the delta of this batch.
    const before = (await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId))).length;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => issueEmailVerificationToken(db, userId)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const active = await activeEmail(userId);
    expect(active.length).toBe(1);

    const after = (await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId))).length;
    expect(after - before).toBe(10);
  });

  it('phone issuance invalidates the previous code', async () => {
    const email = `issue-phone-${Date.now()}@wasit.tn`;
    const { userId } = await registerWithPhone(email, '+21620555001');

    await issuePhoneVerificationCode(db, userId, undefined);
    const [first] = await activePhone(userId);
    await issuePhoneVerificationCode(db, userId, undefined);

    const active = await activePhone(userId);
    expect(active.length).toBe(1);
    expect(active[0].id).not.toBe(first.id);

    // The superseded code is no longer active; the newest row is.
    const [old] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(eq(phoneVerificationTokens.id, first.id))
      .limit(1);
    expect(old.usedAt).not.toBeNull();
  });

  it('phone issuance keeps one active code under concurrent issuance', async () => {
    const email = `issue-phone-race-${Date.now()}@wasit.tn`;
    const { userId } = await registerWithPhone(email, '+21620555002');

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => issuePhoneVerificationCode(db, userId, undefined)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const active = await activePhone(userId);
    expect(active.length).toBe(1);

    const all = await db
      .select()
      .from(phoneVerificationTokens)
      .where(eq(phoneVerificationTokens.userId, userId));
    expect(all.length).toBe(10);
  });

  it('email issuance does not leave partial state when the transaction fails', async () => {
    const email = `issue-email-fail-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);

    const token = await issueEmailVerificationToken(db, userId);
    expect((await activeEmail(userId)).length).toBe(1);

    await expect(
      db.transaction(async (outer) => {
        await issueEmailVerificationToken(outer as unknown as typeof db, userId);
        throw new Error('forced-rollback');
      }),
    ).rejects.toThrow('forced-rollback');

    // The rotation and the new insert rolled back together: the original link is
    // still the single active token, not zero and not two.
    const stillActive = await activeEmail(userId);
    expect(stillActive.length).toBe(1);
    expect(stillActive[0].tokenHash).toBe(hashToken(token));
  });

  it('phone issuance does not leave partial state when the transaction fails', async () => {
    const email = `issue-phone-fail-${Date.now()}@wasit.tn`;
    const { userId } = await registerWithPhone(email, '+21620555003');

    await issuePhoneVerificationCode(db, userId, undefined);
    const [first] = await activePhone(userId);

    await expect(
      db.transaction(async (outer) => {
        await issuePhoneVerificationCode(outer as unknown as typeof db, userId, undefined);
        throw new Error('forced-rollback');
      }),
    ).rejects.toThrow('forced-rollback');

    const stillActive = await activePhone(userId);
    expect(stillActive.length).toBe(1);
    expect(stillActive[0].id).toBe(first.id);
  });

  it('mixed concurrent issuance and consumption neither deadlocks nor doubles tokens', async () => {
    const email = `issue-mixed-${Date.now()}@wasit.tn`;
    const { userId } = await registerUnverified(email);

    const issued = await Promise.all(
      Array.from({ length: 8 }, () => issueEmailVerificationToken(db, userId)),
    );

    const mixed = await Promise.allSettled([
      ...issued.slice(0, 4).map((t) => app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ token: t }),
      })),
      ...Array.from({ length: 4 }, () => issueEmailVerificationToken(db, userId)),
    ]);

    const deadlocks = mixed
      .filter((x) => x.status === 'rejected')
      .filter((x) => /deadlock/i.test(String((x as PromiseRejectedResult).reason)));
    expect(deadlocks.length).toBe(0);

    const active = await activeEmail(userId);
    expect(active.length).toBeLessThanOrEqual(1);
  });
});
