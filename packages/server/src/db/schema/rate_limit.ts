import { bigint, index, integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Distributed rate-limit counters. One row per bucket (prefix + subject).
 *
 * This is the shared store behind `middleware/rate-limit.ts` when
 * `RATE_LIMIT_STORE=postgres`: unlike an in-process Map it is visible to every
 * instance of the API, so the limits hold across a multi-instance deployment.
 *
 * The row is a counter, not a user record: `subject` is an IP or a user id and
 * carries no other data. `expiresAt` is the end of the counting window.
 */
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    bucketKey: varchar('bucket_key', { length: 200 }).primaryKey(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** End of window in epoch milliseconds — the app clock, comparable via bigint. */
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('rate_limit_expires_idx').on(t.expiresAtMs),
  }),
);