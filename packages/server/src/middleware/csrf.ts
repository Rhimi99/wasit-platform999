import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { ApiError } from '@wasit/shared';
import { env } from '../lib/env';
import { SESSION_COOKIE } from './auth';

/**
 * Cross-Site Request Forgery protection for cookie-authenticated writes.
 *
 * WASIT authenticates browsers with an ambient session cookie (`wasit_session`,
 * `SameSite=Lax`). A cookie is attached by the browser to *any* request that
 * targets the API — including one triggered by a foreign site — so a
 * state-changing request authenticated only by that cookie needs a second proof
 * that it came from our own front-end. That proof is the `Origin` header (with
 * `Referer` as the fallback), which the browser sets and a page cannot forge.
 *
 * Scope is deliberately narrow so nothing else is affected:
 *  - Only `POST`/`PUT`/`PATCH`/`DELETE` are checked; safe methods never are.
 *  - Only requests that actually present the session cookie are checked. A
 *    request without the cookie carries no ambient credential to abuse, so
 *    token clients and the HMAC payment-webhook mount pass through untouched.
 *  - The check is a strict same-origin allow-list (`APP_URL` plus any configured
 *    `CORS_ORIGIN` entries). It never widens CORS or weakens RBAC; it runs after
 *    CORS and before routing, and the RBAC guards still run per route.
 *
 * Enforcement is deployment-scoped (`CSRF_PROTECTION`): `auto` (default) turns it
 * on for production/staging and leaves local development/test frictionless;
 * `on`/`off` force it. No route is exempt.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True for the HTTP methods that can mutate server state. */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/**
 * Whether CSRF enforcement applies to this deployment. In `auto` mode it is on
 * wherever the session cookie is actually delivered (production/staging) and off
 * in local development/test; `on`/`off` override that.
 */
export function csrfEnforced(): boolean {
  if (env.CSRF_PROTECTION === 'off') return false;
  if (env.CSRF_PROTECTION === 'on') return true;
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
}

/** Parses a value to a bare origin (`scheme://host[:port]`), or null if malformed. */
function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The set of origins allowed to make credentialed state-changing requests. */
export function trustedOrigins(): Set<string> {
  const set = new Set<string>();
  const self = normalizeOrigin(env.APP_URL);
  if (self) set.add(self);
  for (const raw of env.CORS_ORIGIN.split(',')) {
    const origin = normalizeOrigin(raw.trim());
    if (origin) set.add(origin);
  }
  return set;
}

/**
 * The origin a request claims to come from: the `Origin` header, or the origin
 * of the `Referer` when `Origin` is absent. A malformed `Origin` is returned as
 * the sentinel `"null"`, which is never trusted, rather than being ignored.
 */
export function requestOrigin(c: Context): string | null {
  const origin = c.req.header('origin');
  if (origin && origin.trim()) {
    return normalizeOrigin(origin.trim()) ?? 'null';
  }
  const referer = c.req.header('referer');
  if (referer && referer.trim()) {
    return normalizeOrigin(referer.trim());
  }
  return null;
}

/** Whether a request origin is same-origin or on the configured allow-list. */
export function isTrustedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return trustedOrigins().has(origin);
}

export function csrfProtection() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!csrfEnforced()) return next();
    if (!isStateChangingMethod(c.req.method)) return next();

    // No ambient cookie ⇒ nothing for a foreign site to ride on. This keeps
    // bearer/token clients and the signature-authenticated webhook mount working.
    if (!getCookie(c, SESSION_COOKIE)) return next();

    if (isTrustedOrigin(requestOrigin(c))) return next();

    // Deliberately terse: a caller learns the request was rejected, not which
    // origin values are accepted.
    throw ApiError.forbidden('Request origin could not be verified');
  };
}
