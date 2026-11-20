import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles, mfaChallenges, auditLogs } from '../src/db/schema/index.js';
import { enrollMfa, confirmMfa, generateTotp } from '../src/lib/mfa.js';
import { hashPassword, hashToken } from '../src/lib/security.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * Account lockout (LC-07) — database-backed half.
 *
 * Proves the end-to-end behaviour against a real database: wrong passwords
 * increment the streak, reaching the cap sets a temporary lock, a locked account
 * is refused with an indistinguishable error, the lock lapses automatically, a
 * correct password resets the streak, concurrent failures do not lose counts,
 * and neither MFA nor an alternate entry point bypasses the lock. The pure
 * policy arithmetic is covered in `unit/lockout-policy.test.ts`.
 *
 * Needs the integration database (`globalSetup` recreates it and runs
 * migrations). Part of the ordinary suite; not run when no database is present.
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

const PASSWORD = 'CorrectHorse123!';

/** Inserts an active, verified user with the given role. */
async function createUser(roleName: 'CUSTOMER' | 'SUPPLIER' | 'ADMIN' | 'SUPER_ADMIN') {
  const id = randomUUID();
  const email = `lc07-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  // Use the application's `hashPassword` (argon2id m=19456,t=2,p=1) rather than
  // argon2's defaults (m=65536,t=3,p=4). Otherwise a wrong-password attempt
  // verifies a *more expensive* fixture hash than the parameter-matched
  // `DUMMY_ARGON2_HASH` the no-session paths use, and the timing comparison below
  // would measure the fixture's cost, not the production paths'.
  const passwordHash = await hashPassword(PASSWORD);
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: 'LC07',
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} missing — seed did not run`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  return { id, email, password: PASSWORD };
}

async function readLock(id: string) {
  const [row] = await db
    .select({
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
      isLocked: users.isLocked,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row;
}

async function countAudit(action: string, entityId: string): Promise<number> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
  return rows.length;
}

async function login(email: string, password: string) {
  const client = makeClient();
  return client.req('/api/auth/login', { method: 'POST', body: { email, password, allowUnverifiedEmail: true } });
}

describe('account lockout (LC-07)', () => {
  it('increments the failure counter on a wrong password', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      const res = await login(user.email, 'wrong-password');
      expect(res.status).toBe(401);
      expect((res.data.error as { code: string }).code).toBe('UNAUTHORIZED');
      const lock = await readLock(user.id);
      expect(lock.failedLoginAttempts).toBe(1);
      expect(lock.lockedUntil).toBeNull();
    });
  });

  it('resets the counter on a successful login', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      await login(user.email, 'wrong-1');
      await login(user.email, 'wrong-2');
      expect((await readLock(user.id)).failedLoginAttempts).toBe(2);

      const ok = await login(user.email, user.password);
      expect(ok.status).toBe(200);
      expect((await readLock(user.id)).failedLoginAttempts).toBe(0);
    });
  });

  it('locks the account at the configured cap and logs AUTH.ACCOUNT_LOCKED once', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 3, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      for (let i = 1; i <= 2; i += 1) {
        expect((await login(user.email, 'wrong')).status).toBe(401);
      }
      const locking = await login(user.email, 'wrong');
      expect(locking.status).toBe(401);
      expect((locking.data.error as { code: string }).code).toBe('UNAUTHORIZED');

      const lock = await readLock(user.id);
      expect(lock.failedLoginAttempts).toBe(3);
      expect(lock.lockedUntil).toBeInstanceOf(Date);
      expect(lock.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(await countAudit('AUTH.ACCOUNT_LOCKED', user.id)).toBe(1);
    });
  });

  it('refuses attempts while locked, even with the correct password, without leaking the state', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 2, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      await login(user.email, 'wrong');
      await login(user.email, 'wrong'); // now locked

      const withCorrect = await login(user.email, user.password);
      const withWrong = await login(user.email, 'wrong');
      // Same status and code whether or not the password was right.
      for (const res of [withCorrect, withWrong]) {
        expect(res.status).toBe(401);
        expect((res.data.error as { code: string }).code).toBe('UNAUTHORIZED');
        expect((res.data.error as { message: string }).message).toBe('Invalid credentials');
      }
      // The counter is not advanced by attempts during an active lock.
      expect((await readLock(user.id)).failedLoginAttempts).toBe(2);
      // No session cookie was ever issued.
      expect(withCorrect.res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('allows a new attempt once the lock lapses and clears the streak', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 2, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      await login(user.email, 'wrong');
      await login(user.email, 'wrong'); // locked

      // Simulate the passage of the lock window.
      await db
        .update(users)
        .set({ lockedUntil: new Date(Date.now() - 1000) })
        .where(eq(users.id, user.id));

      const ok = await login(user.email, user.password);
      expect(ok.status).toBe(200);
      const lock = await readLock(user.id);
      expect(lock.failedLoginAttempts).toBe(0);
      expect(lock.lockedUntil).toBeNull();
      // The automatic release is recorded.
      expect(await countAudit('AUTH.ACCOUNT_UNLOCKED', user.id)).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not lose counter updates under concurrent failures', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 100, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => login(user.email, 'wrong')),
      );
      for (const r of results) expect(r.status).toBe(401);
      // A read-modify-write would report fewer than N; the atomic UPDATE does not.
      expect((await readLock(user.id)).failedLoginAttempts).toBe(N);
    });
  });

  it('applies to staff accounts (ADMIN) too — no role exemption', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 2, LOCKOUT_MINUTES: 15, STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      const admin = await createUser('ADMIN');
      await login(admin.email, 'wrong');
      await login(admin.email, 'wrong');
      const lock = await readLock(admin.id);
      expect(lock.lockedUntil).toBeInstanceOf(Date);
      const blocked = await login(admin.email, admin.password);
      expect(blocked.status).toBe(401);
    });
  });

  it('applies to SUPER_ADMIN too — no privileged exemption', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 2, LOCKOUT_MINUTES: 15, STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      const su = await createUser('SUPER_ADMIN');
      await login(su.email, 'wrong');
      await login(su.email, 'wrong');
      expect((await readLock(su.id)).lockedUntil).toBeInstanceOf(Date);
      const blocked = await login(su.email, su.password);
      expect(blocked.status).toBe(401);
      expect(blocked.res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('does not lock a customer or supplier under normal use', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      for (const role of ['CUSTOMER', 'SUPPLIER'] as const) {
        const user = await createUser(role);
        const res = await login(user.email, user.password);
        expect(res.status, role).toBe(200);
        expect((await readLock(user.id)).lockedUntil).toBeNull();
      }
    });
  });

  it('is not bypassed through the MFA path', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 2, LOCKOUT_MINUTES: 15, STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      const user = await createUser('CUSTOMER');
      // Enable MFA and open a challenge with a correct password.
      const { secretBase32 } = await enrollMfa(db, user.id, user.email);
      await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, user.id));
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;
      expect(token).toBeTruthy();

      // The account gets locked out from another device.
      await db
        .update(users)
        .set({ lockedUntil: new Date(Date.now() + 60_000) })
        .where(eq(users.id, user.id));

      // A valid TOTP cannot complete the locked account's challenge.
      const code = generateTotp(secretBase32);
      const client = makeClient();
      const res = await client.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code },
      });
      expect(res.status).toBe(401);
      expect(res.res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('does not lock a clean account and does not leak account existence', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      const known = await login(user.email, 'wrong');
      const unknown = await login(`nobody-${Date.now()}@wasit.tn`, 'wrong');
      expect(known.status).toBe(unknown.status);
      expect((known.data.error as { code: string }).code).toBe(
        (unknown.data.error as { code: string }).code,
      );
    });
  });

  it('never writes a password into the audit log', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 1, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      const secret = 'dummy-not-a-real-password-42!';
      await login(user.email, secret);
      const rows = await db
        .select({ metadata: auditLogs.metadata, before: auditLogs.before, after: auditLogs.after })
        .from(auditLogs)
        .where(eq(auditLogs.entityId, user.id));
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(secret);
    });
  });
});

/**
 * The second-factor half of the lockout policy (LC-07 review): the password
 * streak must not be cleared on the password alone when a second factor is still
 * pending, and a wrong second factor must not advance the password streak — the
 * MFA challenge carries its own independent attempt cap.
 */
describe('account lockout (LC-07) — MFA interaction', () => {
  async function createMfaUser() {
    const user = await createUser('CUSTOMER');
    const { secretBase32 } = await enrollMfa(db, user.id, user.email);
    // `confirmMfa` enables the authenticator row and flips `users.mfaEnabled`;
    // `enrollMfa` alone leaves `enabled=false`, which `verifyMfaChallenge` rejects.
    await confirmMfa(db, user.id, generateTotp(secretBase32));
    return { ...user, secretBase32 };
  }

  async function setStreak(id: string, attempts: number) {
    await db.update(users).set({ failedLoginAttempts: attempts }).where(eq(users.id, id));
  }

  it('does not reset the streak on a correct password while MFA is pending', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      await setStreak(user.id, 3);
      const res = await login(user.email, user.password);
      expect(res.status).toBe(200);
      expect((res.data.data as { mfaRequired: boolean }).mfaRequired).toBe(true);
      expect((await readLock(user.id)).failedLoginAttempts).toBe(3);
    });
  });

  it('a wrong TOTP does not change the password streak (independent MFA cap)', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      await setStreak(user.id, 3);
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;
      const client = makeClient();
      const bad = await client.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: '000000' },
      });
      expect(bad.status).toBe(401);
      // The password streak is untouched; only the challenge's own counter moved.
      expect((await readLock(user.id)).failedLoginAttempts).toBe(3);
      const [ch] = await db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, hashToken(token))).limit(1);
      expect(ch.attempts).toBe(1);
    });
  });

  it('resets the streak only after a full MFA login', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      await setStreak(user.id, 3);
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;
      const client = makeClient();
      const ok = await client.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: generateTotp(user.secretBase32) },
      });
      expect(ok.status).toBe(200);
      expect((await readLock(user.id)).failedLoginAttempts).toBe(0);
    });
  });

  it('rejects an expired MFA challenge and does not consume the password streak', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      await setStreak(user.id, 2);
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;

      // Age the challenge past its TTL.
      await db
        .update(mfaChallenges)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(mfaChallenges.tokenHash, hashToken(token)));

      const client = makeClient();
      const expired = await client.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: generateTotp(user.secretBase32) },
      });
      expect(expired.status).toBe(401);
      expect(expired.res.headers.get('set-cookie')).toBeNull();
      // The password streak is untouched by the expired challenge.
      expect((await readLock(user.id)).failedLoginAttempts).toBe(2);
    });
  });

  it('consumes a successful MFA challenge so it cannot be reused', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 5, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;

      const first = makeClient();
      const ok = await first.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: generateTotp(user.secretBase32) },
      });
      expect(ok.status).toBe(200);

      // Same token, fresh client, another valid code → refused (single-use).
      const second = makeClient();
      const reuse = await second.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: generateTotp(user.secretBase32) },
      });
      expect(reuse.status).toBe(401);
      expect(reuse.res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('enforces the MFA attempt cap under concurrent wrong codes', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 100, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createMfaUser();
      const challenge = await login(user.email, user.password);
      const token = (challenge.data.data as { challengeToken: string }).challengeToken;

      // Fire more wrong codes than the cap, concurrently.
      const N = env.MFA_CHALLENGE_MAX_ATTEMPTS + 5;
      await Promise.all(
        Array.from({ length: N }, () => {
          const c = makeClient();
          return c.req('/api/auth/mfa/challenge', { method: 'POST', body: { challengeToken: token, code: '000000' } });
        }),
      );

      const tokenHash = hashToken(token);
      const [ch] = await db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash)).limit(1);
      // The cap is enforced: requests that arrive after the count already reached
      // `MFA_CHALLENGE_MAX_ATTEMPTS` are refused *without* incrementing, so the
      // final count lands in [cap, N]. Atomic increments mean it never falls below
      // the cap (no lost updates) and never double-counts past N.
      expect(ch.attempts).toBeGreaterThanOrEqual(env.MFA_CHALLENGE_MAX_ATTEMPTS);
      expect(ch.attempts).toBeLessThanOrEqual(N);

      // The correct code is now refused — the challenge is spent.
      const c = makeClient();
      const good = await c.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken: token, code: generateTotp(user.secretBase32) },
      });
      expect(good.status).toBe(401);
    });
  });
});

/**
 * Timing equalisation (LC-07 review), measured live. The unknown / locked /
 * wrong-password paths must not be separable by latency. This is a smoke
 * measurement, not a proof of constant time, so the bound is generous.
 */
describe('account lockout (LC-07) — response timing is not an oracle', () => {
  async function medianMs(fn: () => Promise<unknown>, iterations = 7): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  it('unknown, locked, and wrong-password paths answer within a comparable time', async () => {
    await withEnv({ MAX_LOGIN_ATTEMPTS: 100, LOCKOUT_MINUTES: 15 }, async () => {
      const user = await createUser('CUSTOMER');
      const locked = await createUser('CUSTOMER');
      await db.update(users).set({ lockedUntil: new Date(Date.now() + 60_000) }).where(eq(users.id, locked.id));
      const unknownEmail = `nobody-${Date.now()}@wasit.tn`;

      // Warm up argon2 and the connection pool on every path so the first-call
      // cost does not skew the medians.
      await login(user.email, 'wrong');
      await login(unknownEmail, 'wrong');
      await login(locked.email, 'wrong');

      const wrongMs = await medianMs(() => login(user.email, 'wrong'), 9);
      const unknownMs = await medianMs(() => login(unknownEmail, 'wrong'), 9);
      const lockedMs = await medianMs(() => login(locked.email, 'wrong'), 9);

      const times = [wrongMs, unknownMs, lockedMs];
      const ratio = Math.max(...times) / Math.min(...times);
      // All three paths run one parameter-matched argon2 verification, so the
      // medians should be close. The bound is deliberately loose because the full
      // suite runs concurrently and adds DB latency noise — but it still fails
      // loudly if a path skips the hash entirely (that measured ~20-60x, not <5x).
      expect(
        ratio,
        `wrong=${wrongMs.toFixed(1)}ms unknown=${unknownMs.toFixed(1)}ms locked=${lockedMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}`,
      ).toBeLessThan(5);
    });
  });
});
