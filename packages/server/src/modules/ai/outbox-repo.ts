import { and, eq, lt, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { eventOutbox } from '../../db/schema/outbox';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/observability/logger';

/**
 * Transactional Outbox repository (AI-08.0).
 *
 * The outbox is the durable hand-off between a committed business change and the
 * asynchronous AI routing it triggers. It exists so the two cannot drift:
 *
 *  - **Enqueue is transactional.** {@link enqueueEvent} runs on the SAME `db`
 *    (transaction handle) as the business write, so the row commits or rolls
 *    back with it. A crash after the business commit still leaves the event; a
 *    rollback removes both. There is no fire-and-forget path.
 *  - **Claim is single-flight.** {@link claimDueEvents} uses a single
 *    `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` statement, so of
 *    any number of concurrent workers exactly one claims a given row; the others
 *    skip it. A row is never processed twice in parallel.
 *  - **A dead worker loses nothing.** A claimed row is `PROCESSING` with a
 *    `locked_at` lease; {@link reapStaleEvents} returns an abandoned lease to
 *    `PENDING` (or fails it once attempts are exhausted), so an event survives a
 *    worker crash.
 */

export interface EnqueueEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Idempotency key (unique), e.g. `order.placed:{orderId}`. */
  dedupeKey: string;
}

export interface OutboxEventRow {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Enqueues one domain event, idempotently.
 *
 * Runs inside the caller's transaction. The unique `dedupeKey` means a repeated
 * enqueue (a retried order path, a duplicate call) inserts nothing rather than a
 * second row — idempotency is enforced by the database, not a read-then-write
 * race. Returns the id of the row that now exists (the existing one on conflict).
 */
export async function enqueueEvent(db: DB, input: EnqueueEventInput): Promise<{ id: string; inserted: boolean }> {
  const id = newId();
  const inserted = await db
    .insert(eventOutbox)
    .values({
      id,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload as never,
      dedupeKey: input.dedupeKey,
      status: 'PENDING',
    })
    .onConflictDoNothing({ target: eventOutbox.dedupeKey })
    .returning({ id: eventOutbox.id });
  if (inserted.length > 0) return { id: inserted[0].id, inserted: true };
  const existing = await db
    .select({ id: eventOutbox.id })
    .from(eventOutbox)
    .where(eq(eventOutbox.dedupeKey, input.dedupeKey))
    .limit(1);
  return { id: existing[0]?.id ?? id, inserted: false };
}

/**
 * Claims up to `limit` due events for processing, atomically.
 *
 * The `FOR UPDATE SKIP LOCKED` subquery is the lock: a row already claimed by a
 * concurrent worker (or held `PROCESSING`) is skipped rather than waited on, so
 * workers never block each other and never claim the same row. The claim also
 * bumps `attempts` and starts the lease (`locked_at`) in the same statement.
 */
export async function claimDueEvents(db: DB, limit = 25): Promise<OutboxEventRow[]> {
  const res = await db.execute<OutboxEventRow & Record<string, unknown>>(sql`
    update event_outbox
       set status = 'PROCESSING',
           locked_at = now(),
           attempts = attempts + 1,
           updated_at = now()
     where id in (
       select id from event_outbox
        where status = 'PENDING' and available_at <= now()
        order by created_at asc
        limit ${limit}
        for update skip locked
     )
     returning id, event_type as "eventType", aggregate_type as "aggregateType",
               aggregate_id as "aggregateId", payload, dedupe_key as "dedupeKey",
               status, attempts, max_attempts as "maxAttempts",
               available_at as "availableAt", locked_at as "lockedAt",
               last_error as "lastError", processed_at as "processedAt",
               created_at as "createdAt", updated_at as "updatedAt"
  `);
  const rows = (res as unknown as { rows: OutboxEventRow[] }).rows ?? [];
  return rows;
}

/** Marks a claimed event as successfully routed (terminal). */
export async function markProcessed(db: DB, id: string): Promise<void> {
  await db
    .update(eventOutbox)
    .set({ status: 'PROCESSED', processedAt: new Date(), lockedAt: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(eventOutbox.id, id), eq(eventOutbox.status, 'PROCESSING')));
}

/**
 * Records a failed attempt. Below the attempt ceiling the row returns to
 * `PENDING` with an exponential backoff; at the ceiling it becomes terminal
 * `FAILED` so a permanently broken event cannot spin forever. The error text is
 * truncated and contains no secrets (routing errors are codes/messages only).
 */
export async function markFailed(db: DB, id: string, error: string): Promise<'PENDING' | 'FAILED'> {
  const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
  const row = rows[0];
  if (!row) return 'FAILED';
  const message = error.length > 500 ? `${error.slice(0, 500)}…` : error;
  const exhausted = row.attempts >= row.maxAttempts;
  if (exhausted) {
    await db
      .update(eventOutbox)
      .set({ status: 'FAILED', lastError: message, lockedAt: null, updatedAt: new Date() })
      .where(and(eq(eventOutbox.id, id), eq(eventOutbox.status, 'PROCESSING')));
    return 'FAILED';
  }
  const delayMs = backoffMs(row.attempts);
  await db
    .update(eventOutbox)
    .set({ status: 'PENDING', lastError: message, lockedAt: null, availableAt: new Date(Date.now() + delayMs), updatedAt: new Date() })
    .where(and(eq(eventOutbox.id, id), eq(eventOutbox.status, 'PROCESSING')));
  return 'PENDING';
}

/** Exponential backoff (seconds), capped, from the attempt number (1-based). */
export function backoffMs(attempts: number): number {
  const base = 5_000;
  const cap = 30 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
}

/**
 * Watchdog: reclaims events abandoned by a worker that died while `PROCESSING`.
 *
 * A lease older than `timeoutSeconds` is returned to `PENDING` so the event is
 * retried (never lost); once its attempts are exhausted it is failed. Safe and
 * idempotent to call on every scheduler tick. Returns the number of rows reset.
 */
export async function reapStaleEvents(db: DB, timeoutSeconds = 300): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const stale = await db
    .select()
    .from(eventOutbox)
    .where(and(eq(eventOutbox.status, 'PROCESSING'), lt(eventOutbox.lockedAt, cutoff)));
  let reset = 0;
  for (const row of stale) {
    if (row.attempts >= row.maxAttempts) {
      await db
        .update(eventOutbox)
        .set({ status: 'FAILED', lastError: 'lease expired (worker crashed)', lockedAt: null, updatedAt: new Date() })
        .where(and(eq(eventOutbox.id, row.id), eq(eventOutbox.status, 'PROCESSING')));
    } else {
      await db
        .update(eventOutbox)
        .set({ status: 'PENDING', availableAt: new Date(), lockedAt: null, updatedAt: new Date() })
        .where(and(eq(eventOutbox.id, row.id), eq(eventOutbox.status, 'PROCESSING')));
    }
    reset += 1;
  }
  if (reset > 0) logger.warn('outbox lease reap', { reset });
  return reset;
}

/** Read-only counts per status (for tests and operator visibility). */
export async function outboxCounts(db: DB): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: eventOutbox.status, n: sql<number>`count(*)::int` })
    .from(eventOutbox)
    .groupBy(eventOutbox.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
