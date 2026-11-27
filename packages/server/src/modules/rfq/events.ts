import type { DB } from '../../db/client';
import { rfqEvents } from '../../db/schema/rfq';
import { newId } from '../../lib/ids';

export interface RfqEventInput {
  rfqId: string;
  eventType: (typeof rfqEvents.$inferInsert)['eventType'];
  actorUserId: string | null;
  actorType?: 'USER' | 'SYSTEM';
  payload?: Record<string, unknown> | null;
  visibleToBuyer?: boolean;
  visibleToSeller?: boolean;
  sellerId?: string | null;
  quoteId?: string | null;
  quoteRevision?: number | null;
}

/**
 * The only writer of the RFQ timeline. Kept apart from `service.ts` so the
 * expiry path (lazy and scheduled) can record `SYSTEM` events without importing
 * the whole service and creating a cycle.
 *
 * `rfq_events` is append-only (migration 0046), so callers must never plan to
 * "fix" an entry afterwards — write it once, with the reason inside `payload`.
 */
export async function recordRfqEvent(db: DB, input: RfqEventInput): Promise<void> {
  await db.insert(rfqEvents).values({
    id: newId(),
    rfqId: input.rfqId,
    actorUserId: input.actorUserId,
    actorType: input.actorType ?? 'USER',
    eventType: input.eventType,
    payload: input.payload ?? null,
    visibleToBuyer: input.visibleToBuyer ?? true,
    visibleToSeller: input.visibleToSeller ?? false,
    sellerId: input.sellerId ?? null,
    quoteId: input.quoteId ?? null,
    quoteRevision: input.quoteRevision ?? null,
  });
}
