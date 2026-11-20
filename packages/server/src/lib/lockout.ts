import { env } from './env';

/**
 * Account lockout policy (LC-07).
 *
 * A short, self-expiring lock — never a permanent one — so a burst of wrong
 * passwords cannot disable an account, while a brute-force run is throttled far
 * below the route-level per-IP rate limit. Both bounds are configuration, not
 * literals: `MAX_LOGIN_ATTEMPTS` and `LOCKOUT_MINUTES`.
 *
 * Two distinct locks are modelled on `users`:
 *  * a **permanent administrative lock** — `isLocked` with no `lockedUntil`. Set
 *    out of band (e.g. `anonymize`); this policy never writes it.
 *  * a **temporary brute-force lock** — `lockedUntil` in the future. Set by
 *    {@link nextFailureOutcome}'s SQL twin when the streak reaches the maximum,
 *    and cleared automatically once it lapses.
 */
export interface LockoutPolicy {
  maxAttempts: number;
  lockMinutes: number;
}

export function lockoutPolicy(): LockoutPolicy {
  return { maxAttempts: env.MAX_LOGIN_ATTEMPTS, lockMinutes: env.LOCKOUT_MINUTES };
}

/** Fields the policy reads; kept structural so tests can pass plain objects. */
export interface LockState {
  isLocked: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/** A temporary lock is active only while `lockedUntil` is in the future. */
export function hasActiveTemporaryLock(
  state: Pick<LockState, 'lockedUntil'>,
  now: Date = new Date(),
): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * Whether login must be refused before the password is even checked.
 *
 * A permanent administrative lock (`isLocked`) always blocks — including when a
 * stale, already-lapsed `lockedUntil` also happens to be present. An active
 * temporary lock blocks while it lasts; once it lapses the account is usable
 * again and the counter is cleared lazily by the next wrong password.
 */
export function isLoginBlocked(state: LockState, now: Date = new Date()): boolean {
  if (state.isLocked) return true;
  return hasActiveTemporaryLock(state, now);
}

export interface FailureOutcome {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  locked: boolean;
}

/**
 * Pure mirror of the atomic SQL increment applied on a wrong password. Kept here
 * so the threshold/expiry arithmetic is documented and unit-tested without a
 * database; the login path performs the same computation in a single `UPDATE`.
 */
export function nextFailureOutcome(
  previousAttempts: number,
  now: Date,
  policy: LockoutPolicy,
): FailureOutcome {
  const failedLoginAttempts = previousAttempts + 1;
  if (failedLoginAttempts >= policy.maxAttempts) {
    return {
      failedLoginAttempts,
      lockedUntil: new Date(now.getTime() + policy.lockMinutes * 60_000),
      locked: true,
    };
  }
  return { failedLoginAttempts, lockedUntil: null, locked: false };
}
