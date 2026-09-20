import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import type { RateLimitStore } from './port';

/**
 * Shared rate-limit store backed by Postgres.
 *
 * A single statement both creates a missing bucket and rolls over an expired
 * one, so concurrent requests from different instances can never double-count
 * or resurrect a stale window. The window reset test uses the application clock
 * passed in as `expiresAtMs`, not the database clock, to avoid drift between
 * instances.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  readonly id = 'postgres' as const;

  constructor(private readonly db: DB) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const expiresAtMs = now + windowSeconds * 1000;

    const result = await this.db.execute(sql`
      INSERT INTO rate_limit_counters (bucket_key, count, expires_at, expires_at_ms, created_at, updated_at)
      VALUES (${key}, 1, to_timestamp(${expiresAtMs} / 1000.0), ${expiresAtMs}, now(), now())
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE
          WHEN rate_limit_counters.expires_at_ms <= ${now} THEN 1
          ELSE rate_limit_counters.count + 1
        END,
        expires_at = CASE
          WHEN rate_limit_counters.expires_at_ms <= ${now} THEN to_timestamp(${expiresAtMs} / 1000.0)
          ELSE rate_limit_counters.expires_at
        END,
        expires_at_ms = CASE
          WHEN rate_limit_counters.expires_at_ms <= ${now} THEN ${expiresAtMs}
          ELSE rate_limit_counters.expires_at_ms
        END,
        updated_at = now()
      RETURNING count
    `);

    const rows = result.rows as Array<{ count: number | string }>;
    return Number(rows[0]?.count ?? 1);
  }

  async reset(): Promise<void> {
    await this.db.execute(sql`DELETE FROM rate_limit_counters`);
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    const result = await this.db.execute(
      sql`DELETE FROM rate_limit_counters WHERE expires_at_ms <= ${now} RETURNING bucket_key`,
    );
    return result.rows.length;
  }
}