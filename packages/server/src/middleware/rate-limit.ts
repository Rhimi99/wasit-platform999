import type { Context, Next } from 'hono';
import { ApiError } from '@wasit/shared';
import { getDb, getContext } from '../lib/request-context';
import { resolveRateLimitStore, setRateLimitStore, peekRateLimitStore } from '../lib/rate-limit/resolve';
import type { StoreErrorMode } from '../lib/rate-limit/ai-policy';
import { resolveClientIp, UNKNOWN_CLIENT_KEY } from '../lib/net/client-ip';
import { metrics } from '../lib/observability/metrics';
import { logger } from '../lib/observability/logger';
import { loadAuthUser } from './auth';

/**
 * Test-only helper: clears rate-limit buckets and forgets the memoised store.
 * Not used in production; exposed for isolated integration tests.
 */
export async function resetRateLimitStore(): Promise<void> {
  const store = peekRateLimitStore();
  if (store) await store.reset();
  setRateLimitStore(null);
}

/** Which subject a limit is counted against. */
export type LimitSubject = 'auto' | 'user' | 'ip';

/**
 * Identifies the subject a rate limit applies to.
 *
 * Per-user limiting is the point of the distributed store: an authenticated
 * subject is limited by user id, so one account hammering the API from rotating
 * IPs is still caught, and legitimate users behind a shared NAT are not.
 * Anonymous requests fall back to the trusted client address from
 * `resolveClientIp` — never a raw forwarded header, so a client cannot rotate
 * its own bucket key. When no address can be established safely, every such
 * request shares one bucket (fail closed) instead of each getting a fresh key.
 *
 * `mode` narrows this: `'ip'` always keys on the client address (a per-host
 * backstop that also bounds an attacker rotating accounts), `'user'` keys on the
 * user when present and otherwise falls back to the address, and `'auto'` (the
 * default) is user-when-authenticated else address.
 */
function limitSubject(c: Context, mode: LimitSubject = 'auto'): string {
  const userId = getContext(c)?.user?.id;
  if (mode !== 'ip' && userId) return `user:${userId}`;
  const ip = resolveClientIp(c);
  return `ip:${ip ?? UNKNOWN_CLIENT_KEY}`;
}

/** Platform staff, whose admin limits are multiplied (never exempted). */
function isPlatformStaff(c: Context): boolean {
  const roles = getContext(c)?.user?.roles ?? [];
  return roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
}

// Limits are persisted (Postgres) or kept in-process (memory); see
// `lib/rate-limit/resolve.ts`. The window/limit semantics live here.
export function rateLimit(opts: {
  windowSeconds: number;
  /** Requests per window. A function is resolved per request from live config. */
  max: number | (() => number);
  keyPrefix: string;
  /** Subject to count against. Defaults to user-when-authenticated else IP. */
  subject?: LimitSubject;
  /** Paths (prefix or exact) exempt from this limit. */
  exemptPaths?: readonly string[];
  /** Methods this limit applies to; anything else passes straight through. */
  methods?: readonly string[];
  /**
   * What to do when the counter store fails. `closed` (default) refuses the
   * request with 503 — an outage must not silently disable a limit. `open` lets
   * the request through, which is only acceptable for surfaces that cost
   * nothing (a DB outage breaks them anyway).
   */
  onStoreError?: StoreErrorMode;
  /** Multiplier applied for platform staff (ADMIN/SUPER_ADMIN). Never unlimited. */
  staffMultiplier?: number | (() => number);
  /**
   * Refuse when the active store is in-process. On N instances an in-memory
   * counter grants N × max, so a money path cannot rely on it.
   */
  requireDurableStore?: boolean | (() => boolean);
}) {
  const onStoreError: StoreErrorMode = opts.onStoreError ?? 'closed';
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (opts.exemptPaths?.some((base) => c.req.path === base || c.req.path.startsWith(`${base}/`))) {
      return next();
    }
    if (opts.methods && !opts.methods.includes(c.req.method.toUpperCase())) {
      return next();
    }

    // A per-user limit must resolve the session first, since this middleware can
    // run before the route's own auth guard. The loader is memoised, so the
    // route's later `requireAuth` costs nothing extra. `'auto'` deliberately
    // does NOT force a load: existing limits rely on "limit runs before auth"
    // and must keep keying on the client address until a route attaches a user,
    // so their bucket identity cannot change mid-window. The limiter only ever
    // *reads* identity; it grants no access — RBAC/auth checks still run.
    const subject = opts.subject ?? 'auto';
    if (subject === 'user') await loadAuthUser(c);

    const baseMax = typeof opts.max === 'function' ? opts.max() : opts.max;
    const multiplier =
      typeof opts.staffMultiplier === 'function' ? opts.staffMultiplier() : opts.staffMultiplier;
    const max =
      multiplier && multiplier > 1 && isPlatformStaff(c) ? Math.ceil(baseMax * multiplier) : baseMax;
    const store = resolveRateLimitStore(getDb(c));

    const durableRequired =
      typeof opts.requireDurableStore === 'function'
        ? opts.requireDurableStore()
        : opts.requireDurableStore === true;
    if (durableRequired && store.id === 'memory') {
      logger.error('rate-limit store is not shared; refusing a paid route', {
        prefix: opts.keyPrefix,
        store: store.id,
      });
      metrics.incCounter('wasit_rate_limit_store_errors_total', {
        prefix: opts.keyPrefix,
        mode: 'durable-required',
      });
      throw ApiError.serviceUnavailable('Rate limiting is not available for this route');
    }

    const key = `${opts.keyPrefix}:${limitSubject(c, subject)}`;

    let count: number;
    try {
      count = await store.increment(key, opts.windowSeconds);
    } catch (err) {
      // Fail closed: if the counter cannot be read/written we must not let the
      // request through, or an outage of the shared store would silently disable
      // the limit. A 503 tells the client to retry rather than pretending the
      // request was allowed. No internal detail is surfaced.
      logger.error('rate-limit store unavailable', {
        prefix: opts.keyPrefix,
        mode: onStoreError,
        error: err instanceof Error ? err.message : String(err),
      });
      metrics.incCounter('wasit_rate_limit_store_errors_total', {
        prefix: opts.keyPrefix,
        mode: onStoreError,
      });
      if (onStoreError === 'open') return next();
      throw ApiError.serviceUnavailable('Rate limiting temporarily unavailable');
    }

    if (count > max) {
      metrics.incCounter('wasit_rate_limit_rejections_total', { prefix: opts.keyPrefix });
      // Tell a well-behaved client when the window lapses instead of leaving it
      // to guess; the value is the window length, never internal state.
      c.header('Retry-After', String(opts.windowSeconds));
      throw ApiError.tooManyRequests();
    }
    return next();
  };
}