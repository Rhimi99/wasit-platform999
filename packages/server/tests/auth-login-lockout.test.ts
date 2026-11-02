import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';
import { generateTotp } from '../src/lib/mfa.js';

/**
 * Login account lockout (temporary brute-force lock).
 *
 * Drives the real HTTP surface against the real database — no mocks. Every client
 * carries its own `x-forwarded-for` so the per-IP login rate limit (15/min) does
 * not interfere; the concurrency case stays well under that cap.
 */

const app = createApp();

let ipCounter = 40;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
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

const PASSWORD = 'StrongPass123!';

async function registerUser(email: string) {
  const c = makeClient();
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, firstName: 'Lock', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return { c, userId: row.id };
}

/** Attempts a login that is expected to succeed (dev tooling waives the email gate). */
async function loginOk(email: string, ip = nextIp()) {
  return makeClient(ip).req('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD, allowUnverifiedEmail: true },
  });
}

async function loginWrong(email: string, ip = nextIp(), password = 'WrongPass123!') {
  return makeClient(ip).req('/api/auth/login', {
    method: 'POST',
    body: { email, password, allowUnverifiedEmail: true },
  });
}

async function userRow(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row;
}

afterAll(async () => {
  await closeDb();
});

describe('Login lockout — threshold and temporary lock', () => {
  it('locks the account once the failed-attempt cap is reached', async () => {
    const email = `lock-threshold-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    // MAX_LOGIN_ATTEMPTS - 1 failures must not lock yet.
    for (let i = 0; i < env.MAX_LOGIN_ATTEMPTS - 1; i += 1) {
      const r = await loginWrong(email);
      expect(r.status).toBe(401);
    }
    let row = await userRow(userId);
    expect(row.failedLoginAttempts).toBe(env.MAX_LOGIN_ATTEMPTS - 1);
    expect(row.lockedUntil).toBeNull();

    // The cap-reaching failure sets locked_until.
    const cap = await loginWrong(email);
    expect(cap.status).toBe(401);
    row = await userRow(userId);
    expect(row.failedLoginAttempts).toBe(env.MAX_LOGIN_ATTEMPTS);
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // The lock is auditable.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, userId));
    expect(audits.some((a) => a.action === 'AUTH.LOGIN_FAILED')).toBe(true);
    expect(audits.some((a) => a.action === 'AUTH.LOGIN_LOCKED')).toBe(true);
  });

  it('refuses the CORRECT password while the temporary lock is active', async () => {
    const email = `lock-refuse-correct-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    for (let i = 0; i < env.MAX_LOGIN_ATTEMPTS; i += 1) {
      await loginWrong(email);
    }
    const locked = await userRow(userId);
    expect(locked.lockedUntil).not.toBeNull();

    // The right password must not ride out an active lock.
    const attempt = await loginOk(email);
    expect(attempt.status).toBe(401);
    expect(attempt.data.error.code).toBe('UNAUTHORIZED');
    // No session was minted and the lock was not cleared.
    expect(attempt.data.data).toBeUndefined();
    const after = await userRow(userId);
    expect(after.lockedUntil).not.toBeNull();
    expect(after.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('allows a fresh attempt and resets the streak once the lock expires', async () => {
    const email = `lock-expiry-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    // Simulate an elapsed lock window.
    await db
      .update(users)
      .set({ failedLoginAttempts: env.MAX_LOGIN_ATTEMPTS, lockedUntil: new Date(Date.now() - 60_000) })
      .where(eq(users.id, userId));

    const ok = await loginOk(email);
    expect(ok.status).toBe(200);

    // A correct login clears the streak and the lapsed lock.
    const after = await userRow(userId);
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  it('resets the counter after a successful login below the cap', async () => {
    const email = `lock-reset-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    await loginWrong(email);
    await loginWrong(email);
    let row = await userRow(userId);
    expect(row.failedLoginAttempts).toBe(2);

    const ok = await loginOk(email);
    expect(ok.status).toBe(200);

    row = await userRow(userId);
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('honours a configured cap and duration (MAX_LOGIN_ATTEMPTS / LOCKOUT_MINUTES)', async () => {
    const email = `lock-configured-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    const target = env as unknown as Record<string, unknown>;
    const prevMax = target.MAX_LOGIN_ATTEMPTS;
    const prevMin = target.LOCKOUT_MINUTES;
    target.MAX_LOGIN_ATTEMPTS = 3;
    target.LOCKOUT_MINUTES = 1;
    try {
      await loginWrong(email);
      await loginWrong(email);
      expect((await userRow(userId)).lockedUntil).toBeNull();

      await loginWrong(email);
      const row = await userRow(userId);
      expect(row.lockedUntil).not.toBeNull();
      // ~1 minute from now (allow generous slack for clock/scheduling).
      const remainingMs = row.lockedUntil!.getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(30_000);
      expect(remainingMs).toBeLessThanOrEqual(60_000);
    } finally {
      target.MAX_LOGIN_ATTEMPTS = prevMax;
      target.LOCKOUT_MINUTES = prevMin;
    }
  });
});

describe('Login lockout — concurrency', () => {
  it('counts every concurrent wrong password exactly once below the cap (no lost updates)', async () => {
    const email = `lock-race-count-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    // Stay below MAX_LOGIN_ATTEMPTS so no lock is raised: every request reaches
    // the password check, so the streak must equal the burst exactly. A
    // read-then-write would drop concurrent updates and land below the burst.
    const burst = env.MAX_LOGIN_ATTEMPTS - 1;
    const results = await Promise.all(
      Array.from({ length: burst }, () => loginWrong(email)),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);

    const row = await userRow(userId);
    expect(row.failedLoginAttempts).toBe(burst);
    expect(row.lockedUntil).toBeNull();
  });

  it('locks on a concurrent burst without losing the cap-reaching attempts', async () => {
    const email = `lock-race-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    const burst = env.MAX_LOGIN_ATTEMPTS * 2;
    const results = await Promise.all(
      Array.from({ length: burst }, () => loginWrong(email)),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);

    const row = await userRow(userId);
    // A request arriving once the lock is active is refused before the password
    // check (that is the point of the early return), so it is deliberately not
    // counted. Under a concurrent burst the streak therefore lands between the
    // cap and the burst: >= cap means no update was lost before the lock was
    // raised; <= burst means no attempt was counted twice.
    expect(row.failedLoginAttempts).toBeGreaterThanOrEqual(env.MAX_LOGIN_ATTEMPTS);
    expect(row.failedLoginAttempts).toBeLessThanOrEqual(burst);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('refuses every concurrent correct password once locked', async () => {
    const email = `lock-race-correct-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    for (let i = 0; i < env.MAX_LOGIN_ATTEMPTS; i += 1) {
      await loginWrong(email);
    }
    expect((await userRow(userId)).lockedUntil).not.toBeNull();

    const results = await Promise.all(Array.from({ length: 5 }, () => loginOk(email)));
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(results.every((r) => r.data.data === undefined)).toBe(true);
  });
});

describe('Login lockout — permanent lock stays independent', () => {
  it('keeps a permanent isLocked lock when no temporary lock is set, and never clears it', async () => {
    const email = `lock-permanent-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);
    await db.update(users).set({ isLocked: true }).where(eq(users.id, userId));

    const attempt = await loginOk(email);
    expect(attempt.status).toBe(403);
    expect(attempt.data.error.code).toBe('FORBIDDEN');

    const row = await userRow(userId);
    expect(row.isLocked).toBe(true);
    // The permanent lock is not a temporary one, and login left it untouched.
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLoginAttempts).toBe(0);
  });

  it('does not clear a permanent lock when a temporary lock expires', async () => {
    const email = `lock-permanent-expiry-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);
    await db
      .update(users)
      .set({ isLocked: true, failedLoginAttempts: env.MAX_LOGIN_ATTEMPTS, lockedUntil: new Date(Date.now() - 60_000) })
      .where(eq(users.id, userId));

    const attempt = await loginOk(email);
    expect(attempt.status).toBe(403);

    const row = await userRow(userId);
    expect(row.isLocked).toBe(true);
    // The lapsed temporary lock was not "released" into a permanent unlock.
    expect(row.failedLoginAttempts).toBe(env.MAX_LOGIN_ATTEMPTS);
  });
});

describe('Login lockout — no account enumeration', () => {
  it('returns an identical response for unknown account, wrong password, and temporary lock', async () => {
    const email = `lock-enum-${Date.now()}@wasit.tn`;
    const { userId } = await registerUser(email);

    const unknown = await loginWrong(`nobody-${Date.now()}@wasit.tn`);
    const wrong = await loginWrong(email);

    for (let i = 0; i < env.MAX_LOGIN_ATTEMPTS; i += 1) {
      await loginWrong(email);
    }
    expect((await userRow(userId)).lockedUntil).not.toBeNull();
    const locked = await loginOk(email);

    for (const r of [unknown, wrong, locked]) {
      expect(r.status).toBe(401);
      expect(r.data.error.code).toBe('UNAUTHORIZED');
      expect(r.data.error.message).toBe('Invalid credentials');
    }
    // Identical error bodies: nothing distinguishes the three cases. `traceId` is
    // the only field that legitimately varies per request, so it is excluded.
    const shape = (r: { data: { error: Record<string, unknown> } }) => {
      const { traceId: _traceId, ...rest } = r.data.error;
      return JSON.stringify(rest);
    };
    expect(shape(unknown)).toBe(shape(wrong));
    expect(shape(wrong)).toBe(shape(locked));
  });
});

describe('Login lockout — no regression in email-verification and MFA flows', () => {
  it('still returns EMAIL_NOT_VERIFIED for a correct password on an unverified account', async () => {
    const email = `lock-unverified-${Date.now()}@wasit.tn`;
    await registerUser(email);

    // No allowUnverifiedEmail → the email gate still applies.
    const denied = await makeClient().req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('still issues an MFA challenge for a correct password on an MFA account, and counts a wrong one', async () => {
    const email = `lock-mfa-${Date.now()}@wasit.tn`;
    const { c, userId } = await registerUser(email);

    // Enable MFA through the real flow: log in to obtain a session, then enroll.
    const first = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD, allowUnverifiedEmail: true },
    });
    expect(first.status).toBe(200);

    const enroll = await c.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    expect(enroll.status).toBe(200);
    const secretBase32 = enroll.data.data.secretBase32 as string;
    const confirm = await c.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });
    expect(confirm.status).toBe(200);
    await c.req('/api/auth/logout', { method: 'POST' });

    // Correct password → challenge, no session (unchanged behaviour).
    const challenge = await loginOk(email);
    expect(challenge.status).toBe(200);
    expect(challenge.data.data.mfaRequired).toBe(true);
    expect(challenge.data.data.challengeToken).toBeTruthy();

    // A wrong password on the MFA account is still counted toward the lock.
    const wrong = await loginWrong(email);
    expect(wrong.status).toBe(401);
    expect((await userRow(userId)).failedLoginAttempts).toBe(1);
  });
});
