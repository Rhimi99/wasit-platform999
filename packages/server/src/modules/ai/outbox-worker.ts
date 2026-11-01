import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { agentTasks } from '../../db/schema/agents';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/observability/logger';
import { OUTBOX_ROUTES } from './outbox-routes';
import { claimDueEvents, markFailed, markProcessed, reapStaleEvents, type OutboxEventRow } from './outbox-repo';
import { createAgentTask, OUTBOX_PRINCIPAL } from './runner';

/**
 * Outbox worker (AI-08.0).
 *
 * Drains the transactional outbox: it claims due events, routes each to its
 * owning agent through the SAME {@link createAgentTask} path every other caller
 * uses (so RBAC, data scope, the kill switch, the per-run budget, the approval
 * gate and the Tool Gateway all still apply), then marks the event terminal.
 *
 * Guarantees:
 *  - **No parallel double-processing.** {@link claimDueEvents} is single-flight
 *    (`FOR UPDATE SKIP LOCKED`), so a concurrent worker cannot claim a row another
 *    already holds.
 *  - **Exactly-once routing effect.** The task's `correlationId` is the outbox
 *    row id; before creating a task the worker checks for an existing one, so a
 *    retry after a crash (or a reaped lease) never spawns a second task for the
 *    same event.
 *  - **No loss, retry with backoff.** A routing failure returns the row to
 *    `PENDING` with exponential backoff; a worker that dies mid-run leaves a
 *    lease that {@link reapStaleEvents} reclaims.
 *  - **Never changes the business outcome.** The worker runs strictly AFTER the
 *    producing transaction has committed, so an agent failure (or a worker
 *    failure) can never roll back — or alter — the order it describes.
 *
 * The principal it runs under is the bounded {@link OUTBOX_PRINCIPAL}: it carries
 * automation roles only for an agent on the outbox allow-list, and the runner
 * re-asserts the (event → agent, task type) route at execution time.
 */

export interface OutboxDispatchResult {
  claimed: number;
  processed: number;
  failed: number;
  reaped: number;
}

/**
 * Routes one claimed event to its owning agent. Idempotent on `correlationId`:
 * an event already routed returns its existing task instead of creating another.
 */
async function routeEvent(
  db: DB,
  event: OutboxEventRow,
): Promise<{ taskId: string | null; alreadyRouted: boolean }> {
  const route = OUTBOX_ROUTES[event.eventType];
  if (!route) {
    // Not on the allow-list: this task only wires the events it declares. Refuse
    // loudly rather than silently routing an unapproved event.
    throw new Error(`event ${event.eventType} is not on the outbox allow-list`);
  }

  // Exactly-once routing: a retry (reaped lease, worker restart) must not create
  // a second task for the same event. The outbox row id is the stable correlation.
  const existing = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(eq(agentTasks.correlationId, event.id))
    .limit(1);
  if (existing.length > 0) return { taskId: existing[0].id, alreadyRouted: true };

  const task = await createAgentTask(
    db,
    ['SUPER_ADMIN'],
    OUTBOX_PRINCIPAL,
    {
      agentKey: route.agentKey,
      taskType: route.taskType,
      input: { orderId: event.aggregateId, eventId: event.id, ...(event.payload ?? {}) },
      correlationId: event.id,
      triggeredBy: `outbox:${event.eventType}`,
      dedupeKey: `outbox:${event.eventType}:${event.aggregateType}:${event.aggregateId}`,
    },
    { actorId: OUTBOX_PRINCIPAL },
  );
  return { taskId: task.id, alreadyRouted: false };
}

/**
 * Claims and processes up to `limit` due events, then reaps abandoned leases.
 *
 * Safe to call on every scheduler tick: the claim is single-flight and every
 * terminal transition is guarded, so a duplicate tick is a no-op.
 */
export async function dispatchOutboxEvents(db: DB, limit = 25): Promise<OutboxDispatchResult> {
  const claimed = await claimDueEvents(db, limit);
  let processed = 0;
  let failed = 0;

  for (const event of claimed) {
    try {
      const { taskId, alreadyRouted } = await routeEvent(db, event);
      await markProcessed(db, event.id);
      processed += 1;
      await writeAudit(db, { actorId: OUTBOX_PRINCIPAL }, {
        action: 'AI.OUTBOX_PROCESSED',
        entityType: 'EVENT_OUTBOX',
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          correlationId: event.id,
          taskId,
          alreadyRouted,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'outbox routing failed';
      const next = await markFailed(db, event.id, message);
      failed += 1;
      logger.warn('outbox event routing failed', {
        eventId: event.id,
        eventType: event.eventType,
        attempts: event.attempts,
        next,
        error: message,
      });
      await writeAudit(db, { actorId: OUTBOX_PRINCIPAL }, {
        action: 'AI.OUTBOX_FAILED',
        entityType: 'EVENT_OUTBOX',
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          correlationId: event.id,
          attempts: event.attempts,
          next,
          error: message,
        },
      });
    }
  }

  const reaped = await reapStaleEvents(db);
  return { claimed: claimed.length, processed, failed, reaped };
}
