import { env } from '../env';
import type { DB } from '../../db/client';
import { MemoryRateLimitStore } from './memory';
import { PostgresRateLimitStore } from './postgres';
import { deploymentTier, durableStoreRequired, type RateLimitConfig } from './policy';
import type { RateLimitStore } from './port';

/** The configuration the runtime is actually holding, read at call time. */
export function rateLimitConfigNow(): RateLimitConfig {
  return {
    nodeEnv: env.NODE_ENV,
    store: env.RATE_LIMIT_STORE,
    allowMemoryStore: env.AI_RATE_LIMIT_ALLOW_MEMORY_STORE,
    requireDurable: env.AI_RATE_LIMIT_REQUIRE_DURABLE,
  };
}

/**
 * Whether counters must be shared. True in production and staging no matter what
 * the flags say — that is the point of the hardening: the escape hatch is a
 * local-development affordance, not a deployment setting.
 */
export function rateLimitStoreRequired(): boolean {
  return durableStoreRequired(rateLimitConfigNow());
}

/**
 * Second gate (the first is in `env.ts`): refuse to construct an in-process store
 * in a deployed tier even if the environment object was changed after boot.
 */
function assertStoreAllowed(id: 'memory' | 'postgres'): void {
  if (id === 'memory' && deploymentTier(env.NODE_ENV) !== 'local') {
    throw new Error(
      `Refusing to use the in-process rate-limit store in ${env.NODE_ENV}: counters must be shared`,
    );
  }
}

let store: RateLimitStore | null = null;
let currentDb: DB | null = null;
let forced = false;

/**
 * The store the router uses. `RATE_LIMIT_STORE=postgres` shares counters across
 * instances; any other value falls back to the in-process store, so a mistyped
 * value degrades to single-instance behaviour instead of disabling rate
 * limiting entirely.
 *
 * The first call receives the request-scoped db handle and constructs the store
 * from it. A store set via `setRateLimitStore` is used as-is regardless of which
 * handle is passed, which is what lets a test pin a Postgres store over the test
 * database while the environment still says `memory`.
 */
export function resolveRateLimitStore(db?: DB): RateLimitStore {
  if (store) {
    // A forced store is always honoured; the in-process store is
    // process-global and independent of the db handle; the Postgres store is
    // rebuilt only when the request-scoped handle changes.
    if (forced || store.id === 'memory' || !db || db === currentDb) return store;
  }
  if (env.RATE_LIMIT_STORE === 'postgres') {
    if (!db) {
      throw new Error('RATE_LIMIT_STORE=postgres requires a database handle');
    }
    store = new PostgresRateLimitStore(db);
    currentDb = db;
    forced = false;
    return store;
  }
  assertStoreAllowed('memory');
  store = new MemoryRateLimitStore();
  currentDb = db ?? null;
  forced = false;
  return store;
}

/**
 * Test seam: the currently memoised store, or `null` when none was built yet.
 * Lets test helpers clear buckets without forcing construction of a store.
 */
export function peekRateLimitStore(): RateLimitStore | null {
  return store;
}

/**
 * Test seam: pins a specific store and forgets the memoised one. Pass `null` to
 * fall back to the environment-driven selection.
 */
export function setRateLimitStore(next: RateLimitStore | null): void {
  if (next) assertStoreAllowed(next.id);
  store = next;
  currentDb = null;
  forced = next !== null;
}

export interface RateLimitStoreStatus {
  store: 'memory' | 'postgres';
  durable: boolean;
}

/** Non-secret status for health surfaces. */
export function rateLimitStoreStatus(db?: DB): RateLimitStoreStatus {
  const id = resolveRateLimitStore(db).id;
  return { store: id, durable: id !== 'memory' };
}

export type { RateLimitStore } from './port';