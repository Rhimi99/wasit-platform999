import type { Context, Next } from 'hono';
import { ApiError, isStaffRole } from '@wasit/shared';
import { staffMfaEnforced } from '../lib/env';
import { getContext } from '../lib/request-context';
import { loadAuthUser } from './auth';

/**
 * Mandatory MFA for internal staff (LC-06).
 *
 * WASIT already ships a complete, optional TOTP second factor (enrollment,
 * login challenge, recovery codes, audit). This middleware turns that second
 * factor into a *requirement* for internal staff roles: a staff account must not
 * reach a staff API until it has an enabled authenticator.
 *
 * Enforcement is a property of the account (its roles and its `mfaEnabled`
 * flag), not of the request, so it cannot be bypassed by client state, by
 * refreshing a session, or by reusing a session that predates the policy:
 * `loadAuthUser` re-reads `users.mfa_enabled` on every request, and this check
 * runs after it. It adds no permission and removes none — SUPER_ADMIN keeps
 * exactly its RBAC grants; it only gates *access* on the second factor.
 *
 * Scope is deliberately the staff roles only (SUPPORT, RISK, DISPUTE, ADMIN,
 * SUPER_ADMIN). Customers, merchants, suppliers, companies and marketers keep
 * their existing behaviour — the gate never inspects or restricts them.
 *
 * Deployment-scoped (`STAFF_MFA_ENFORCEMENT`): `auto` (default) enforces it in
 * production and leaves local development/test and the public demo (staging)
 * frictionless; `on`/`off` force it. It is mounted once, over the whole `/api`
 * surface in `app.ts`, so a staff account without a second factor is refused on
 * every staff surface — admin, the desks, revenue, and every mixed route a staff
 * role can reach — with no per-route list to drift.
 */

/** The distinct error code a blocked staff request carries, so the SPA can route to enrollment. */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED' as const;

/**
 * Surfaces a staff member must always be able to reach, so a staff account
 * without a factor can bootstrap one instead of being locked out entirely:
 * `/api/auth` (sign in, self-service enroll/confirm, sessions, sign out) and
 * `/api/health` (public probes). Everything else under `/api` is gated.
 */
const STAFF_MFA_EXEMPT_PREFIXES = ['/api/auth', '/api/health'] as const;

/** True when the path is an exempt surface (the auth/health prefix or itself). */
export function isExemptFromStaffMfa(path: string): boolean {
  return STAFF_MFA_EXEMPT_PREFIXES.some((base) => path === base || path.startsWith(`${base}/`));
}

export function requireStaffMfa() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!staffMfaEnforced()) return next();
    // Exempt before resolving the session: the enrollment/sign-in routes must be
    // reachable by a staff account that has no factor yet.
    if (isExemptFromStaffMfa(c.req.path)) return next();
    // Resolve the session first so this works both mounted before a router's own
    // `requireAuth` and after it (the loader is memoised per request).
    await loadAuthUser(c);
    const user = getContext(c)?.user;
    // No authenticated user: the route's own `requireAuth`/RBAC guard handles it.
    if (!user) return next();
    if (!isStaffRole(user.roles)) return next();
    if (user.mfaEnabled === true) return next();

    throw new ApiError(
      403,
      MFA_REQUIRED_CODE,
      'Multi-factor authentication is required for staff accounts',
    );
  };
}
