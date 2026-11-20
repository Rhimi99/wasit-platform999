import { describe, it, expect } from 'vitest';
import {
  isLoginBlocked,
  hasActiveTemporaryLock,
  nextFailureOutcome,
  lockoutPolicy,
  type LockState,
} from '../../src/lib/lockout.js';
import { env } from '../../src/lib/env.js';

/**
 * Account lockout policy (LC-07) — database-free half.
 *
 * The login path applies the counter with a single conditional `UPDATE`
 * (`registerFailedLogin`); this file pins the pure decision logic that the SQL
 * mirrors, plus the configuration bounds, so the threshold/expiry arithmetic is
 * covered without a database. The end-to-end behaviour (increments, lock,
 * automatic unlock, concurrency, audit, MFA interaction) lives in
 * `account-lockout.test.ts`.
 */

function state(partial: Partial<LockState>): LockState {
  return { isLocked: false, failedLoginAttempts: 0, lockedUntil: null, ...partial };
}

const policy = { maxAttempts: 5, lockMinutes: 15 };

describe('lockout policy — configuration', () => {
  it('reads the bounds from configuration, not literals', () => {
    const previous = { max: env.MAX_LOGIN_ATTEMPTS, min: env.LOCKOUT_MINUTES };
    try {
      (env as unknown as Record<string, unknown>).MAX_LOGIN_ATTEMPTS = 7;
      (env as unknown as Record<string, unknown>).LOCKOUT_MINUTES = 30;
      expect(lockoutPolicy()).toEqual({ maxAttempts: 7, lockMinutes: 30 });
    } finally {
      (env as unknown as Record<string, unknown>).MAX_LOGIN_ATTEMPTS = previous.max;
      (env as unknown as Record<string, unknown>).LOCKOUT_MINUTES = previous.min;
    }
  });
});

describe('lockout policy — failure streak', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('increments the streak below the cap without locking', () => {
    for (let i = 1; i < policy.maxAttempts; i += 1) {
      const outcome = nextFailureOutcome(i - 1, now, policy);
      expect(outcome.failedLoginAttempts).toBe(i);
      expect(outcome.locked).toBe(false);
      expect(outcome.lockedUntil).toBeNull();
    }
  });

  it('locks exactly at the cap, for the configured duration', () => {
    const outcome = nextFailureOutcome(policy.maxAttempts - 1, now, policy);
    expect(outcome.failedLoginAttempts).toBe(policy.maxAttempts);
    expect(outcome.locked).toBe(true);
    expect(outcome.lockedUntil?.getTime()).toBe(now.getTime() + policy.lockMinutes * 60_000);
  });
});

describe('lockout policy — lock state', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('blocks an active temporary lock', () => {
    const until = new Date(now.getTime() + 60_000);
    expect(hasActiveTemporaryLock({ lockedUntil: until }, now)).toBe(true);
    expect(isLoginBlocked(state({ lockedUntil: until }), now)).toBe(true);
  });

  it('does not block a lapsed temporary lock', () => {
    const until = new Date(now.getTime() - 1);
    expect(hasActiveTemporaryLock({ lockedUntil: until }, now)).toBe(false);
    expect(isLoginBlocked(state({ lockedUntil: until }), now)).toBe(false);
  });

  it('blocks a permanent administrative lock even with a stale lapsed lock', () => {
    const until = new Date(now.getTime() - 1);
    expect(isLoginBlocked(state({ isLocked: true, lockedUntil: until }), now)).toBe(true);
  });

  it('does not block a clean account', () => {
    expect(isLoginBlocked(state({}), now)).toBe(false);
  });
});
