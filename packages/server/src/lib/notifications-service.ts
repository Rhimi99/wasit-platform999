import type { DB } from '../db/client';
import { notify } from './notifications/engine';

/**
 * Records an in-app notification and, for registry events, queues the
 * per-channel deliveries (email/SMS/push/webhook).
 *
 * This is the single entry point every module already uses. It keeps its
 * previous contract — one in-app row with the given copy — while delegating the
 * channel fan-out to the notification engine, so adding a channel does not
 * touch any call site. It performs no network I/O: the caller's transaction
 * only writes rows; delivery happens in the dispatcher.
 */
export async function createNotification(
  db: DB,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    entityType?: string | null;
    entityId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<void> {
  await notify(db, {
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? '',
    data: input.data ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });
}