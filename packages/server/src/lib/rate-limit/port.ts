/**
 * Rate-limit store contract.
 *
 * The middleware owns the window/limit semantics; a store only has to answer
 * "how many hits has this bucket seen in the current window?" atomically and
 * cheaply. Two implementations exist:
 *
 *  - `MemoryRateLimitStore`   — single-process (dev / tests / one instance)
 *  - `PostgresRateLimitStore` — shared across instances, survives restarts
 *
 * Keeping the interface this small is what makes the distributed store a swap
 * rather than a rewrite: the router does not know which one is active.
 */
export interface RateLimitStore {
  /** Implementation id, surfaced by health. */
  readonly id: 'memory' | 'postgres';
  /**
   * Records one hit for `key` and returns the count within the current window.
   * Must create the bucket (count = 1) when absent or expired.
   */
  increment(key: string, windowSeconds: number): Promise<number>;
  /** Removes all buckets. Used by tests; never called in production flows. */
  reset(): Promise<void>;
  /** Deletes expired buckets. Returns how many rows were removed. */
  purgeExpired(now?: number): Promise<number>;
}