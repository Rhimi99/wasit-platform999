import type { Context, Next } from 'hono';
import { ApiError } from '@wasit/shared';
import { getDb, getContext } from '../lib/request-context';
import { resolveRateLimitStore, setRateLimitStore, peekRateLimitStore } from '../lib/rate-limit/resolve';
import { metrics } from '../lib/observability/metrics';

/**
 * Test-only helper: clears rate-limit buckets and forgets the memoised store.
 * Not used in production; exposed for isolated integration tests.
 */
export async function resetRateLimitStore(): Promise<void> {
  const store = peekRateLimitStore();
  if (store) await store.reset();
  setRateLimitStore(null);
}

/**
 * Identifies the subject a rate limit applies to.
 *
 * Per-user limiting is the point of the distributed store: an authenticated
 * subject is limited by user id, so one account hammering the API from rotating
 * IPs is still caught, and legitimate users behind a shared NAT are not.
 * Anonymous requests fall back to the client IP.
 */
function limitSubject(c: Context): string {
  const userId = getContext(c)?.user?.id;
  if (userId) return `user:${userId}`;
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return `ip:${ip ?? c.req.header('x-real-ip') ?? 'unknown'}`;
}

// Limits are persisted (Postgres) or kept in-process (memory); see
// `lib/rate-limit/resolve.ts`. The window/limit semantics live here.
export function rateLimit(opts: { windowSeconds: number; max: number; keyPrefix: string }) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const store = resolveRateLimitStore(getDb(c));
    const key = `${opts.keyPrefix}:${limitSubject(c)}`;
    const count = await store.increment(key, opts.windowSeconds);
    if (count > opts.max) {
      metrics.incCounter('wasit_rate_limit_rejections_total', { prefix: opts.keyPrefix });
      throw ApiError.tooManyRequests();
    }
    return next();
  };
}