import type { ReadCacheStats, ReadCacheStore } from './port';

interface Entry {
  value: string;
  /** Epoch ms after which the entry is dead. */
  expiresAt: number;
}

/**
 * Bounded in-process cache with per-entry TTL and LRU eviction.
 *
 * The bound matters more than the algorithm: reference data is small, so a few
 * hundred entries cover the whole catalogue, and the ceiling stops a pathological
 * key space (arbitrary search strings, say) from turning the cache into a leak.
 * Eviction order is Map insertion order, refreshed on read — a plain LRU.
 */
export class MemoryReadCache implements ReadCacheStore {
  readonly id = 'memory' as const;
  private entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number = 500, private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses += 1;
      return null;
    }
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    // Re-insert to move the key to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async invalidatePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async stats(): Promise<ReadCacheStats> {
    this.dropExpired();
    const total = this.hits + this.misses;
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? null : this.hits / total,
    };
  }

  private dropExpired(): void {
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
  }
}

/** Disabled cache: every read misses and every write is discarded. */
export class NoopReadCache implements ReadCacheStore {
  readonly id = 'none' as const;

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _ttlSeconds: number): Promise<void> {}

  async invalidatePrefix(_prefix: string): Promise<number> {
    return 0;
  }

  async clear(): Promise<void> {}

  async stats(): Promise<ReadCacheStats> {
    return { entries: 0, hits: 0, misses: 0, hitRate: null };
  }
}
