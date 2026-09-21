import { env } from '../env';
import { metrics } from '../observability/metrics';
import { MemoryReadCache, NoopReadCache } from './memory';
import type { ReadCacheStats, ReadCacheStore } from './port';

let store: ReadCacheStore | null = null;
let forced = false;

/**
 * The cache the app uses. `CACHE_ENABLED=true` turns on the in-process store;
 * anything else selects the no-op store, so a mistyped or absent value degrades
 * to "always read the source" — never to stale data.
 *
 * Memoised process-wide: the store owns the entries and the counters, so it must
 * be the same object for every request, not one per request-scoped db handle.
 */
export function resolveReadCache(): ReadCacheStore {
  if (store) return store;
  store = env.CACHE_ENABLED ? new MemoryReadCache(env.CACHE_MAX_ENTRIES) : new NoopReadCache();
  forced = false;
  return store;
}

/** Test seam: pins a specific store and forgets the memoised one. */
export function setReadCache(next: ReadCacheStore | null): void {
  store = next;
  forced = next !== null;
}

/** Test seam: the memoised store, or `null` before the first resolution. */
export function peekReadCache(): ReadCacheStore | null {
  return store;
}

export interface ReadCacheStatus {
  enabled: boolean;
  store: 'memory' | 'none';
  ttlSeconds: number;
  stats: ReadCacheStats;
}

/** Non-secret status for health surfaces. */
export async function readCacheStatus(): Promise<ReadCacheStatus> {
  const cache = resolveReadCache();
  return {
    enabled: cache.id !== 'none',
    store: cache.id,
    ttlSeconds: env.CACHE_TTL_SECONDS,
    stats: await cache.stats(),
  };
}

/**
 * Reads `key`, returning the parsed value from cache when present, otherwise
 * loading it, storing the serialised result, and returning it.
 *
 * Failures are never cached: if `load` throws, the error propagates and nothing
 * is written, so a transient database error cannot be frozen into a 200.
 *
 * A `forced` flag is intentionally not exposed — invalidation is prefix-based
 * from the write paths, which keeps staleness bounded by the TTL rather than by
 * how diligently every caller remembers to bust a key.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cache = resolveReadCache();
  if (cache.id === 'none') return load();

  const hit = await cache.get(key);
  if (hit !== null) {
    metrics.incCounter('wasit_cache_lookups_total', { result: 'hit' });
    metrics.setGauge('wasit_cache_entries', (await cache.stats()).entries);
    return JSON.parse(hit) as T;
  }
  metrics.incCounter('wasit_cache_lookups_total', { result: 'miss' });

  const value = await load();
  await cache.set(key, JSON.stringify(value), ttlSeconds);
  metrics.setGauge('wasit_cache_entries', (await cache.stats()).entries);
  return value;
}

/** Drops every entry under `prefix`. Called by writes that change cached data. */
export async function invalidateCache(prefix: string): Promise<number> {
  const removed = await resolveReadCache().invalidatePrefix(prefix);
  if (removed > 0) metrics.incCounter('wasit_cache_invalidations_total', undefined, removed);
  return removed;
}

export type { ReadCacheStore, ReadCacheStats } from './port';
