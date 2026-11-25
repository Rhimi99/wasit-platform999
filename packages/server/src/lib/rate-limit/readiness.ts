import type { DB } from '../../db/client';
import { logger } from '../observability/logger';
import { resolveRateLimitStore, rateLimitStoreRequired } from './resolve';
import type { RateLimitStoreId } from './policy';

/**
 * AI-RATE-LIMIT-HARDENING-01 — is the counter store usable right now?
 *
 * Used twice: as a boot gate (`index.ts` refuses to serve when this says no) and
 * as the readiness probe (`GET /api/health/ready`). Both surfaces stay
 * secret-free: `detail` is a fixed phrase, never a driver message that could
 * carry a host or a DSN.
 */
export interface RateLimitReadiness {
  store: RateLimitStoreId;
  durable: boolean;
  /** True in production and staging: the store must be shared. */
  required: boolean;
  ready: boolean;
  detail?: string;
}

const UNREACHABLE = 'counter store unreachable';
const NOT_CONFIGURED = 'a shared counter store is required in this environment';

export async function checkRateLimitStoreReadiness(db?: DB): Promise<RateLimitReadiness> {
  const required = rateLimitStoreRequired();

  let store;
  try {
    store = resolveRateLimitStore(db);
  } catch (err) {
    logger.error('rate-limit store cannot be constructed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { store: 'memory', durable: false, required, ready: false, detail: NOT_CONFIGURED };
  }

  const durable = store.id !== 'memory';
  if (required && !durable) {
    return { store: store.id, durable, required, ready: false, detail: NOT_CONFIGURED };
  }

  try {
    await store.probe();
    return { store: store.id, durable, required, ready: true };
  } catch (err) {
    logger.error('rate-limit store probe failed', {
      store: store.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { store: store.id, durable, required, ready: false, detail: UNREACHABLE };
  }
}
