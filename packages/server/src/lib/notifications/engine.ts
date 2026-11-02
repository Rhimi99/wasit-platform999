import { and, asc, eq } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { notifications, notificationDeliveries, notificationPreferences } from '../../db/schema/messaging';
import { users } from '../../db/schema/auth';
import { newId } from '../ids';
import { env, notificationExternalApproved } from '../env';
import { logger } from '../observability/logger';
import { resolveMailTransport } from '../mail/resolve';
import { resolveSmsTransport } from '../sms/resolve';
import { sendMail } from '../mail/send';
import { sendSms } from '../sms/send';
import { renderNotification, emailParts, smsBody, templatePlaceholders } from './templates';
import {
  eventDefinition,
  type NotificationChannel,
  type NotificationCategory,
  type DeliveryStatus,
} from './types';
import { resolveNotificationWebhook } from './webhook';
import { resolvePushTransport } from './push';

export interface NotifyEvent {
  /** Recipient user id. */
  userId: string;
  /** Registry event type (e.g. `ORDER_CREATED`). */
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Template variables (orderNumber, amount, currency, status, …). */
  vars?: Record<string, string>;
  /** Structured payload stored on the in-app row. */
  data?: Record<string, unknown> | null;
  /** Explicit copy. When omitted, the event's template is used. */
  title?: string;
  body?: string;
  /** Override the registry's default channel set. */
  channels?: readonly NotificationChannel[];
  /**
   * Caller-supplied idempotency token. When set, a repeat of the same
   * (event, entity, recipient, channel, token) inserts nothing, so a webhook
   * redelivery or a retried transition never notifies twice. When omitted, each
   * call is a distinct occurrence.
   */
  idempotencyKey?: string | null;
}

/**
 * Records a lifecycle notification and queues its per-channel deliveries.
 *
 * This runs inside the caller's transaction: it writes the in-app row and one
 * PENDING ledger row per non-in-app channel, but performs **no network I/O**.
 * Sending happens later through {@link dispatchPendingDeliveries}, so a slow or
 * failing provider can never hold a business transaction open, and the PENDING
 * rows commit atomically with the business state they describe. A notification
 * that was never queued (rolled back) is therefore never sent.
 */
export async function notify(db: DB, event: NotifyEvent): Promise<{ notificationId: string | null }> {
  const def = eventDefinition(event.type);
  const channels = event.channels ?? def.channels;
  const wantsInApp = channels.includes('IN_APP');

  const vars = event.vars ?? {};
  const copy =
    event.title !== undefined || event.body !== undefined
      ? { title: event.title ?? event.type, body: event.body ?? '' }
      : renderNotification(event.type, vars, null);
  // Refuse to queue a template whose variables are missing. `fill` substitutes an
  // absent key with an empty string, so the result cannot be detected by scanning
  // for braces — the placeholder set must be checked against the supplied keys.
  // Without this a call site that forgets `vars` would enqueue a body of blank
  // fields ("Order  is now .") that only surfaces on a real transport, a silent
  // user-visible defect. The error names the missing keys.
  assertTemplateVars(event.type, vars);

  // The ledger stores the exact copy that will be delivered, under reserved
  // keys, so dispatch never re-renders with a different (empty) locale/vars set.
  const storedVars: Record<string, string> = {
    ...vars,
    [STORED_TITLE]: copy.title,
    [STORED_BODY]: copy.body,
  };

  // One token for the whole call: without an explicit idempotency key each call
  // is a distinct occurrence, and a shared token keeps the per-channel keys
  // (and the in-app relink below) consistent.
  const token = event.idempotencyKey ?? newId();

  // The ledger rows are inserted first: their unique `dedupe_key` is what makes
  // the whole call idempotent. A repeat of the same (event, entity, recipient,
  // channel, token) inserts nothing, and the in-app row below is written only
  // when its own IN_APP ledger row was the one that got in — so a redelivered
  // webhook does not leave a second copy in the feed either.
  const insertedChannels = new Set<NotificationChannel>();
  for (const channel of channels) {
    const rows = await db
      .insert(notificationDeliveries)
      .values({
        id: newId(),
        notificationId: null,
        userId: event.userId,
        eventType: event.type,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        channel,
        // The in-app row *is* the in-app delivery; it is written just below.
        status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
        attempts: channel === 'IN_APP' ? 1 : 0,
        vars: storedVars,
        dedupeKey: buildDedupeKey(event, channel, token),
      })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id });
    if (rows.length > 0) insertedChannels.add(channel);
  }

  let notificationId: string | null = null;
  if (wantsInApp && insertedChannels.has('IN_APP')) {
    notificationId = newId();
    await db.insert(notifications).values({
      id: notificationId,
      userId: event.userId,
      type: event.type,
      title: copy.title,
      // An absent body stays NULL (the feed's prior contract), not ''.
      body: copy.body === '' ? null : copy.body,
      data: event.data ?? null,
    });
    // Link the ledger row to the feed row it stands for.
    await db
      .update(notificationDeliveries)
      .set({ notificationId })
      .where(eq(notificationDeliveries.dedupeKey, buildDedupeKey(event, 'IN_APP', token)));
  }

  return { notificationId };
}

/** Reserved `vars` keys holding the resolved copy for dispatch to replay. */
export const STORED_TITLE = '__title';
export const STORED_BODY = '__body';

/**
 * Thrown when a call site fails to supply a variable a template needs. It is a
 * programming error, surfaced loudly at queue time rather than delivered as a
 * blank field.
 */
export class NotificationTemplateError extends Error {
  readonly eventType: string;
  readonly missing: string[];
  constructor(eventType: string, missing: string[]) {
    super(`Notification template ${eventType} is missing variables: ${missing.join(', ')}`);
    this.name = 'NotificationTemplateError';
    this.eventType = eventType;
    this.missing = missing;
  }
}

/**
 * Rejects a call whose variables do not cover the event template's placeholders.
 * A missing key is a programming error at the call site: fail loudly at queue
 * time rather than deliver a blank field.
 */
function assertTemplateVars(eventType: string, vars: Record<string, string>): void {
  const required = templatePlaceholders(eventType);
  const missing = required.filter((key) => vars[key] === undefined || vars[key] === '');
  if (missing.length > 0) throw new NotificationTemplateError(eventType, missing);
}

function buildDedupeKey(event: NotifyEvent, channel: NotificationChannel, token: string): string {
  return [
    event.type,
    event.entityType ?? '-',
    event.entityId ?? '-',
    event.userId,
    channel,
    token,
  ].join(':');
}

interface Recipient {
  email: string;
  phone: string | null;
  locale: string;
}

async function resolveRecipient(db: DB, userId: string): Promise<Recipient | null> {
  const rows = await db
    .select({ email: users.email, phone: users.phone, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether the user has left this channel/category on. Absent row = enabled. */
export async function isChannelEnabled(
  db: DB,
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
): Promise<boolean> {
  const rows = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.channel, channel),
        eq(notificationPreferences.category, category),
      ),
    )
    .limit(1);
  return rows[0]?.enabled ?? true;
}

/** A real (non-sandbox) transport reaches a provider; the gate guards those. */
function isRealTransport(channel: NotificationChannel): boolean {
  switch (channel) {
    case 'EMAIL':
      return resolveMailTransport().id !== 'log';
    case 'SMS':
      return resolveSmsTransport().id !== 'log';
    case 'PUSH':
      return resolvePushTransport().id !== 'log';
    case 'WEBHOOK':
      return resolveNotificationWebhook().id !== 'log';
    default:
      return false;
  }
}

interface SendOutcome {
  status: Extract<DeliveryStatus, 'SENT' | 'FAILED' | 'SKIPPED'>;
  attempts: number;
  error?: string;
}

/** Sends one delivery through its channel, with bounded retry. Never throws. */
async function sendOnChannel(
  db: DB,
  row: typeof notificationDeliveries.$inferSelect,
): Promise<SendOutcome> {
  const channel = row.channel as NotificationChannel;
  const def = eventDefinition(row.eventType);

  if (!(await isChannelEnabled(db, row.userId, channel, def.category))) {
    return { status: 'SKIPPED', attempts: 0, error: 'channel disabled by user preference' };
  }

  // A real external provider must not be switched on in production before its
  // contract is approved; the sandbox `log` transports are exempt.
  if (isRealTransport(channel) && !notificationExternalApproved()) {
    return { status: 'SKIPPED', attempts: 0, error: 'external delivery not approved in this environment' };
  }

  const recipient = await resolveRecipient(db, row.userId);
  if (!recipient) return { status: 'SKIPPED', attempts: 0, error: 'recipient not found' };

  // Replay the copy captured at queue time rather than re-rendering. Re-rendering
  // from `row.vars` under the recipient's locale would lose the amount/status
  // that only the call site knew, and a template change between queue and send
  // could produce a different message than the one recorded. The stored keys are
  // authoritative; the render is a fallback for rows queued before this change.
  const vars = (row.vars as Record<string, string> | null) ?? {};
  const copy = {
    title: vars[STORED_TITLE] ?? renderNotification(row.eventType, vars, recipient.locale).title,
    body: vars[STORED_BODY] ?? renderNotification(row.eventType, vars, recipient.locale).body,
  };
  const attempts = env.NOTIFICATION_RETRY_ATTEMPTS;
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (channel === 'EMAIL') {
        const parts = emailParts(copy);
        const result = await sendMail(db, { to: recipient.email, ...parts });
        if (!result.ok) throw new Error(result.error);
      } else if (channel === 'SMS') {
        if (!recipient.phone) return { status: 'SKIPPED', attempts: 0, error: 'recipient has no phone number' };
        const result = await sendSms(db, { to: recipient.phone, text: smsBody(copy) });
        if (!result.ok) throw new Error(result.error);
      } else if (channel === 'PUSH') {
        await resolvePushTransport().send({
          topic: `user-${row.userId}`,
          title: copy.title,
          body: copy.body,
          data: { eventType: row.eventType, entityId: row.entityId ?? undefined },
        });
      } else if (channel === 'WEBHOOK') {
        await resolveNotificationWebhook().send({
          eventType: row.eventType,
          entityType: row.entityType,
          entityId: row.entityId,
          recipientUserId: row.userId,
          title: copy.title,
          body: copy.body,
          data: null,
          occurredAt: new Date().toISOString(),
        });
      }
      return { status: 'SENT', attempts: attempt };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < attempts && env.NOTIFICATION_RETRY_BACKOFF_MS > 0) {
        await new Promise((r) => setTimeout(r, env.NOTIFICATION_RETRY_BACKOFF_MS));
      }
    }
  }

  return { status: 'FAILED', attempts, error: lastError };
}

export interface DispatchResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Drains PENDING deliveries, sending each through its channel and recording the
 * outcome. Delivery is at-least-once: a row that was sent but whose status
 * update did not commit (a crash in between) is retried on the next drain, so a
 * recipient can in the worst case receive a duplicate — but a queued delivery is
 * never silently dropped. The scheduler is the single driver in a deployment;
 * tests call this directly.
 */
export async function dispatchPendingDeliveries(db: DB, limit = 100): Promise<DispatchResult> {
  const pending = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, 'PENDING'))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(limit);

  const result: DispatchResult = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  for (const row of pending) {
    let outcome: SendOutcome;
    try {
      outcome = await sendOnChannel(db, row);
    } catch (err) {
      // sendOnChannel is written not to throw; this is a belt-and-braces guard so
      // one bad row can never abort the whole drain.
      outcome = { status: 'FAILED', attempts: 1, error: (err as Error).message };
    }

    await db
      .update(notificationDeliveries)
      .set({
        status: outcome.status,
        attempts: outcome.attempts,
        lastError: outcome.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, row.id));

    result.processed++;
    if (outcome.status === 'SENT') result.sent++;
    else if (outcome.status === 'FAILED') result.failed++;
    else result.skipped++;
  }

  if (result.processed > 0) {
    logger.info('notification dispatch', { ...result });
  }
  return result;
}
