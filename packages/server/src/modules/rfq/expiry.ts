import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { rfqQuotes, rfqRecipients, rfqs } from '../../db/schema/rfq';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { createNotification } from '../../lib/notifications-service';
import { logger } from '../../lib/observability/logger';
import { recordRfqEvent } from './events';

export type RfqDb = DB;
type RfqRow = typeof rfqs.$inferSelect;

/**
 * B2B-01 — the single implementation of "this negotiation window lapsed".
 *
 * Two callers need it and they must not drift apart: the request path evaluates
 * expiry lazily (a lapsed RFQ must refuse a quote even if nobody swept it), and
 * the scheduler sweeps on a timer. Both go through the guarded statements here,
 * which is what makes the pair safe together — whoever reaches the row first
 * writes the transition and the `EXPIRED` event, and the other caller gets zero
 * rows back and writes nothing.
 *
 * The guard is the `where` clause, never a read-then-write in application code:
 *   ... where status = 'OPEN' and expires_at <= now() returning id
 * Under two concurrent callers Postgres re-evaluates the predicate after the
 * lock is released, so exactly one of them sees a row.
 */

export interface RfqExpiryOutcome {
  /** The row as it stands after the call, whether or not this call moved it. */
  rfq: RfqRow;
  /**
   * True only for the caller that actually wrote the transition. The loser of a
   * race sees the row expired but `transitioned === false`, which is what keeps
   * a sweep's counters honest and its events written exactly once.
   */
  transitioned: boolean;
}

/**
 * Moves a due RFQ to EXPIRED, reporting whether this call was the one that did
 * it. The caller that wins writes the event, the notification and the audit
 * entry; every other caller just reads the outcome.
 */
export async function expireRfqIfDue(db: RfqDb, rfq: RfqRow): Promise<RfqExpiryOutcome> {
  if (rfq.status !== 'OPEN' || !rfq.expiresAt || rfq.expiresAt.getTime() > Date.now()) {
    return { rfq, transitioned: false };
  }

  const result = await db.execute<{ id: string }>(sql`
    update rfqs set status = 'EXPIRED', updated_at = now()
    where id = ${rfq.id} and status = 'OPEN' and expires_at is not null and expires_at <= now()
    returning id
  `);
  const won = rowsOf(result).length > 0;

  const [fresh] = await db.select().from(rfqs).where(sql`${rfqs.id} = ${rfq.id}`).limit(1);
  const current = fresh ?? rfq;
  if (!won) return { rfq: current, transitioned: false };

  await recordRfqEvent(db, {
    rfqId: rfq.id,
    eventType: 'EXPIRED',
    actorUserId: null,
    actorType: 'SYSTEM',
    payload: {
      scope: 'RFQ',
      expiresAt: rfq.expiresAt.toISOString(),
      /** Why the transition happened, in the timeline itself. */
      reason: 'RESPONSE_WINDOW_LAPSED',
      fromStatus: 'OPEN',
    },
    visibleToBuyer: true,
    visibleToSeller: true,
  });

  await createNotification(db, {
    userId: rfq.buyerUserId,
    type: 'RFQ_EXPIRED',
    title: 'Request for quotation expired',
    body: `${rfq.rfqNumber} passed its response window without being closed.`,
    data: { rfqId: rfq.id },
  });
  const invited = await db
    .select({ sellerUserId: rfqRecipients.sellerUserId })
    .from(rfqRecipients)
    .where(sql`${rfqRecipients.rfqId} = ${rfq.id}`);
  for (const row of invited) {
    await createNotification(db, {
      userId: row.sellerUserId,
      type: 'RFQ_EXPIRED',
      title: 'Request for quotation expired',
      body: `${rfq.rfqNumber} is no longer accepting quotes.`,
      data: { rfqId: rfq.id },
    });
  }

  await writeAudit(
    db,
    { actorId: null, actorType: 'SYSTEM' },
    {
      action: 'RFQ.EXPIRED',
      entityType: 'RFQ',
      entityId: rfq.id,
      before: { status: 'OPEN' },
      after: { status: 'EXPIRED', reason: 'RESPONSE_WINDOW_LAPSED' },
    },
  );
  return { rfq: current, transitioned: true };
}

/**
 * Marks lapsed submissions of one RFQ EXPIRED and returns how many moved.
 *
 * Only `SUBMITTED` quotes can lapse: every other status is terminal and the
 * predicate is what keeps a rejected or withdrawn revision from being rewritten.
 */
export async function expireLapsedQuotes(db: RfqDb, rfqId: string): Promise<number> {
  const result = await db.execute<{
    id: string;
    seller_id: string;
    seller_user_id: string;
    revision: number;
    valid_until: Date;
  }>(sql`
    update rfq_quotes set quote_status = 'EXPIRED', expired_at = now(), updated_at = now()
    where rfq_id = ${rfqId} and quote_status = 'SUBMITTED' and valid_until <= now()
    returning id, seller_id, seller_user_id, revision, valid_until
  `);
  const rows = rowsOf<{
    id: string;
    seller_id: string;
    seller_user_id: string;
    revision: number;
    valid_until: Date;
  }>(result);

  for (const row of rows) {
    await recordRfqEvent(db, {
      rfqId,
      eventType: 'EXPIRED',
      actorUserId: null,
      actorType: 'SYSTEM',
      payload: {
        scope: 'QUOTE',
        revision: row.revision,
        validUntil: new Date(row.valid_until).toISOString(),
        reason: 'QUOTE_VALIDITY_LAPSED',
        fromStatus: 'SUBMITTED',
      },
      visibleToBuyer: true,
      visibleToSeller: true,
      sellerId: row.seller_id,
      quoteId: row.id,
      quoteRevision: row.revision,
    });
    await createNotification(db, {
      userId: row.seller_user_id,
      type: 'RFQ_QUOTE_EXPIRED',
      title: 'Your quote expired',
      body: `Revision ${row.revision} of your quote is no longer valid.`,
      data: { rfqId, quoteId: row.id },
    });
  }
  return rows.length;
}

export interface RfqExpirySweepOptions {
  /** Rows handled per statement and per batch. Bounds lock scope and latency. */
  batchSize?: number;
  /** Hard ceiling on batches per tick so one tick can never monopolise a worker. */
  maxBatches?: number;
}

export interface RfqExpirySweepResult {
  rfqsExpired: number;
  quotesExpired: number;
  batches: number;
  /** True when `maxBatches` was reached and the next tick must continue. */
  truncated: boolean;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 20;

/**
 * Periodic expiry sweep, meant to be called from the in-process scheduler (or a
 * cron hitting the same function) and safe to run concurrently or repeatedly.
 *
 * Properties, each enforced rather than assumed:
 *  - idempotent: a second run finds nothing left to move and reports zeros;
 *  - concurrent-safe: each transition is the guarded UPDATE above, so only one
 *    caller can write it and only that caller writes the event and notification;
 *  - terminal states are never touched: the predicates are `status = 'OPEN'` and
 *    `quote_status = 'SUBMITTED'`, so AWARDED/CANCELLED/EXPIRED RFQs and
 *    REJECTED/WITHDRAWN/SUPERSEDED quotes are outside the statement entirely;
 *  - nothing is deleted: only status, timestamps and append-only events;
 *  - no external side effects: notifications are in-app rows, no mail/SMS/webhook.
 *
 * Batches are ordered by deadline so a backlog drains oldest-first and two
 * workers take the same rows in the same order (no lock-order deadlocks).
 */
export async function runRfqExpirySweep(
  db: DB,
  options: RfqExpirySweepOptions = {},
): Promise<RfqExpirySweepResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);

  let rfqsExpired = 0;
  let quotesExpired = 0;
  let batches = 0;
  let truncated = false;

  for (;;) {
    if (batches >= maxBatches) {
      truncated = true;
      break;
    }
    batches += 1;

    const result = await db.transaction(async (tx) => {
      const scoped = tx as unknown as DB;
      let rfqsMoved = 0;
      let quotesMoved = 0;

      const dueRfqs = await scoped
        .select({ id: rfqs.id })
        .from(rfqs)
        .where(sql`${rfqs.status} = 'OPEN' and ${rfqs.expiresAt} is not null and ${rfqs.expiresAt} <= now()`)
        .orderBy(rfqs.expiresAt)
        .limit(batchSize);
      for (const row of dueRfqs) {
        const [before] = await scoped.select().from(rfqs).where(sql`${rfqs.id} = ${ row.id}`).limit(1);
        if (!before) continue;
        const outcome = await expireRfqIfDue(scoped, before);
        if (outcome.transitioned) rfqsMoved += 1;
      }

      const lapsed = await scoped
        .select({ rfqId: rfqQuotes.rfqId })
        .from(rfqQuotes)
        .where(sql`${rfqQuotes.quoteStatus} = 'SUBMITTED' and ${rfqQuotes.validUntil} <= now()`)
        .groupBy(rfqQuotes.rfqId)
        .orderBy(rfqQuotes.rfqId)
        .limit(batchSize);
      for (const row of lapsed) {
        quotesMoved += await expireLapsedQuotes(scoped, row.rfqId);
      }

      return { rfqsMoved, quotesMoved, scanned: dueRfqs.length + lapsed.length };
    });

    rfqsExpired += result.rfqsMoved;
    quotesExpired += result.quotesMoved;
    if (result.scanned < batchSize) break;
  }

  if (rfqsExpired > 0 || quotesExpired > 0) {
    logger.info('rfq expiry sweep', { rfqsExpired, quotesExpired, batches, truncated });
  }
  return { rfqsExpired, quotesExpired, batches, truncated };
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
