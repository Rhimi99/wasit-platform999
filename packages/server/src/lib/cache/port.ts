/**
 * Read-cache contract.
 *
 * The platform's hot reads are mostly reference data that changes only when an
 * administrator acts: the geo catalogue, categories, and the SEO sitemap. Those
 * queries are cheap individually but repeated on every page load and by every
 * crawler, so a small bounded cache removes the bulk of the read traffic
 * without changing any response.
 *
 * Two implementations exist, mirroring the rate-limit store:
 *
 *  - `MemoryReadCache`   — in-process, single instance (dev / tests / one node)
 *  - `NoopReadCache`     — used when caching is disabled
 *
 * Values are stored as already-serialised JSON text so the cache never hands a
 * caller a shared mutable object; a hit is parsed fresh on the way out. A
 * cached entry is therefore indistinguishable from one read from the database.
 */
export interface ReadCacheStore {
  /** Implementation id, surfaced by health. */
  readonly id: 'memory' | 'none';
  /** Returns the cached JSON text for `key`, or `null` on a miss/expiry. */
  get(key: string): Promise<string | null>;
  /** Stores `value` (JSON text) under `key` for `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Drops every entry whose key starts with `prefix`. Returns how many were
   * removed. This is how a write invalidates the reads it just changed — the
   * platform never guesses at key values, it namespaces them (`geo:`, `seo:`).
   */
  invalidatePrefix(prefix: string): Promise<number>;
  /** Removes all entries. Used by tests. */
  clear(): Promise<void>;
  /** Live entry count and cumulative hit/miss counters, for health + tests. */
  stats(): Promise<ReadCacheStats>;
}

export interface ReadCacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** Hits / (hits + misses), or null before the first lookup. */
  hitRate: number | null;
}
