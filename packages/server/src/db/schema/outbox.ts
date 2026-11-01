import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Transactional Outbox (AI-08.0).
 *
 * A durable, append-only record of a domain event that must be routed to the AI
 * layer. The row is written INSIDE the same transaction as the business change
 * it describes (e.g. order creation), so the event and the state that produced
 * it commit or roll back together — an event can never be lost to a crash after
 * the business write, nor announced for a transaction that never committed.
 *
 * Delivery is at-least-once: a worker claims due rows, routes them, then marks
 * them terminal. A worker that dies mid-claim leaves a PROCESSING row that a
 * watchdog reaps back to PENDING, so no event is lost. Exactly-once *effect* is
 * provided downstream by the routing dedupe key, not by the outbox itself.
 *
 * `dedupeKey` is unique, so re-enqueuing the same logical event (a retried
 * order path, a duplicate call) inserts nothing — idempotency is enforced by the
 * database, not by a read-then-write race.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /** Domain event name, e.g. `order.placed`. Bounded to the routing table. */
    eventType: varchar('event_type', { length: 64 }).notNull(),
    /** The kind of entity the event is about, e.g. `ORDER`. */
    aggregateType: varchar('aggregate_type', { length: 60 }).notNull(),
    /** The entity id, e.g. the order id. */
    aggregateId: varchar('aggregate_id', { length: 36 }).notNull(),
    /** Minimal, non-secret data the routing layer needs (ids, totals, counts). */
    payload: jsonb('payload').notNull(),
    /** Idempotency key, e.g. `order.placed:{orderId}`. Unique in the database. */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    /** PENDING | PROCESSING | PROCESSED | FAILED. */
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    /** Earliest time the row may be claimed (set forward for backoff). */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the row was last claimed (the lease start, for the watchdog). */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** Short, non-secret failure reason for the last attempt. */
    lastError: text('last_error'),
    /** Set when the row reaches PROCESSED. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency is enforced by the database: a repeated logical event inserts
    // nothing, so a retried order path can never enqueue a second row.
    dedupeIdx: uniqueIndex('event_outbox_dedupe_idx').on(t.dedupeKey),
    // The worker's claim scan: due rows by status, oldest first.
    dueIdx: index('event_outbox_due_idx').on(t.status, t.availableAt, t.createdAt),
    aggregateIdx: index('event_outbox_aggregate_idx').on(t.aggregateType, t.aggregateId),
    createdIdx: index('event_outbox_created_idx').on(t.createdAt),
  }),
);
