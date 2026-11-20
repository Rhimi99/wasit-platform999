import { describe, it, expect, vi, afterEach } from 'vitest';
import * as security from '../../src/lib/security.js';
import { loginUser } from '../../src/modules/auth/service.js';
import { users, userRoles } from '../../src/db/schema/auth.js';
import type { DB } from '../../src/db/client.js';

/**
 * Login lockout flow (LC-07 review) — database-free, real service code.
 *
 * `loginUser` is driven with a hand-built fake DB (the same style as
 * `ai029-agent-registry-seeding-unit.test.ts`) and a spy on
 * `lib/security.verifyPassword`. This exercises the *real* control flow and pins
 * the ordering/equalisation guarantees that need a database to observe otherwise:
 *
 *  1. unknown / locked / disabled accounts each run one verification against the
 *     parameter-matched `DUMMY_ARGON2_HASH` (timing equalisation) and never
 *     against a real stored hash;
 *  2. a wrong password increments the streak and never resets it;
 *  3. a correct password with MFA pending does NOT reset the streak (reset only
 *     after full authentication) and issues a challenge instead of a session;
 *  4. a correct password with no second factor resets the streak and opens a
 *     session.
 */

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  isLocked: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
}

function makeUser(partial: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-1',
    email: 'user@wasit.tn',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$AAA$BBB',
    isActive: true,
    isLocked: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    emailVerified: true,
    mfaEnabled: false,
    ...partial,
  };
}

interface FakeCalls {
  updates: { table: unknown; values: Record<string, unknown> }[];
  inserts: { table: unknown; row: Record<string, unknown> }[];
  executes: unknown[];
}

function makeFakeDb(userRows: UserRow[]) {
  const calls: FakeCalls = { updates: [], inserts: [], executes: [] };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === users) {
          return { where: () => ({ limit: () => Promise.resolve(userRows) }) };
        }
        // userRoles (roles lookup) and anything else: no rows.
        void userRoles;
        return {
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
          where: () => Promise.resolve([]),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        calls.inserts.push({ table, row });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          calls.updates.push({ table, values });
          return Promise.resolve();
        },
      }),
    }),
    execute: (query: unknown) => {
      calls.executes.push(query);
      return Promise.resolve({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
    },
  };
  return { db: db as unknown as DB, calls };
}

/** A verification that always fails (wrong password / dummy), never true. */
function stubVerify(fn: (password: string, hash: string) => boolean) {
  return vi.spyOn(security, 'verifyPassword').mockImplementation(async (p: string, h: string) => fn(p, h));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const dummyHash = security.DUMMY_ARGON2_HASH;

describe('login lockout flow (unit) — timing equalisation', () => {
  it('runs the dummy verification for an unknown account and returns 401', async () => {
    const spy = stubVerify(() => false);
    const { db, calls } = makeFakeDb([]);
    await expect(loginUser(db, { email: 'nobody@wasit.tn', password: 'x' }, {})).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(dummyHash);
    expect(calls.updates).toHaveLength(0);
  });

  it('runs the dummy verification for a locked account (not the stored hash)', async () => {
    const spy = stubVerify(() => false);
    const locked = makeUser({ lockedUntil: new Date(Date.now() + 60_000) });
    const { db, calls } = makeFakeDb([locked]);
    await expect(loginUser(db, { email: locked.email, password: 'x' }, {})).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(dummyHash);
    expect(calls.updates).toHaveLength(0);
  });

  it('runs the dummy verification for a disabled account and returns 403', async () => {
    const spy = stubVerify(() => false);
    const disabled = makeUser({ isActive: false });
    const { db, calls } = makeFakeDb([disabled]);
    await expect(loginUser(db, { email: disabled.email, password: 'x' }, {})).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(dummyHash);
    expect(calls.updates).toHaveLength(0);
  });
});

describe('login lockout flow (unit) — counter lifecycle', () => {
  it('a wrong password verifies the stored hash, bumps the counter, and does not reset it', async () => {
    const spy = stubVerify(() => false);
    const user = makeUser({ failedLoginAttempts: 2 });
    const { db, calls } = makeFakeDb([user]);
    await expect(loginUser(db, { email: user.email, password: 'wrong' }, {})).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(spy.mock.calls[0][1]).toBe(user.passwordHash);
    // The atomic increment ran (db.execute), and no reset (update) happened.
    expect(calls.executes).toHaveLength(1);
    expect(calls.updates.filter((u) => u.values.failedLoginAttempts === 0)).toHaveLength(0);
  });

  it('a correct password with MFA pending does NOT reset the counter and issues a challenge', async () => {
    const spy = stubVerify(() => true);
    const user = makeUser({ failedLoginAttempts: 4, mfaEnabled: true });
    const { db, calls } = makeFakeDb([user]);
    const outcome = await loginUser(db, { email: user.email, password: 'right' }, {});
    expect(outcome.kind).toBe('mfa_required');
    expect(spy.mock.calls[0][1]).toBe(user.passwordHash);
    // No reset happened yet — it must wait for the second factor.
    expect(calls.updates.filter((u) => u.values.failedLoginAttempts === 0)).toHaveLength(0);
    // A challenge row was written, not a session.
    expect(calls.inserts.some((i) => i.row.tokenHash !== undefined)).toBe(true);
    expect(calls.inserts.some((i) => i.row.userId === user.id && i.row.expiresAt !== undefined)).toBe(true);
  });

  it('a correct password with no second factor resets the counter and opens a session', async () => {
    stubVerify(() => true);
    const user = makeUser({ failedLoginAttempts: 4 });
    const { db, calls } = makeFakeDb([user]);
    const outcome = await loginUser(db, { email: user.email, password: 'right' }, {});
    expect(outcome.kind).toBe('session');
    // The streak was reset.
    expect(calls.updates.some((u) => u.values.failedLoginAttempts === 0)).toBe(true);
    // A session row was inserted.
    expect(calls.inserts.some((i) => i.row.tokenHash !== undefined)).toBe(true);
  });
});
