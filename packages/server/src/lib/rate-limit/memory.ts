import type { RateLimitStore } from './port';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Single-process store used by development, tests, and single-instance
 * deployments. Behaviour is unchanged from the original in-memory limiter:
 * fixed window, reset on first hit after expiry.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly id = 'memory' as const;
  private readonly buckets = new Map<string, Bucket>();

  increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return Promise.resolve(1);
    }
    bucket.count += 1;
    return Promise.resolve(bucket.count);
  }

  reset(): Promise<void> {
    this.buckets.clear();
    return Promise.resolve();
  }

  purgeExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}