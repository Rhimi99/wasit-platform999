import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { notificationPreferences } from '../../db/schema/messaging.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';

/**
 * PR-10 — the notification preference surface.
 *
 * The `notification_preferences` table has existed since 0000 with no reader and
 * no writer, so a user had no way to state which notifications they want. This
 * module is the single owner of that table: it fixes the vocabulary (channels and
 * categories), reads a user's matrix with defaults applied, and writes one row
 * per (user, channel, category).
 *
 * Scope note, deliberately explicit: these preferences are *stored and returned*
 * but the delivery paths do not consult them yet. Whether a category may be
 * silenced at all (a payment failure notice is arguably not optional) is a
 * product decision this module must not invent — it is recorded as a
 * DECISION REQUIRED in `docs/PR-10_NOTIFICATION_PREFERENCES.md`. `isEnabled()`
 * below is the seam that wiring will use, and it is unit-tested so the future
 * change is a call site, not a rewrite.
 */

/** Channels the platform actually delivers on. */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Categories are the leading token of a notification `type` (`DISPUTE.STATUS`
 * and `INVENTORY_LOW_STOCK` both map to their first word). The list is explicit
 * rather than derived so an unknown type can never silently create a category a
 * user has no setting for — the unit test pins the mapping for every type the
 * codebase writes today.
 */
export const NOTIFICATION_CATEGORIES = [
  'MESSAGE',
  'ORDER',
  'PAYMENT',
  'REFUND',
  'DISPUTE',
  'INVENTORY',
  'VERIFICATION',
  'RISK',
  'AI',
  'PAYOUT',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * `DISPUTE.APPEAL.DECIDED` -> `DISPUTE`; `INVENTORY_LOW_STOCK` -> `INVENTORY`;
 * `payout.completed` -> `PAYOUT`. Returns `null` for a type that does not belong
 * to a known category, so callers can decide instead of guessing.
 */
export function categoryOfNotificationType(type: string): NotificationCategory | null {
  const head = type.split(/[._]/)[0]?.toUpperCase() ?? '';
  return isNotificationCategory(head) ? head : null;
}

export interface NotificationPreferenceRow {
  channel: NotificationChannel;
  category: NotificationCategory;
  /** Effective value: the stored choice, or the default when never set. */
  enabled: boolean;
  /** False when the row is a default and the user has not chosen anything yet. */
  explicit: boolean;
  updatedAt: string | null;
}

export interface NotificationPreferenceMatrix {
  channels: readonly NotificationChannel[];
  categories: readonly NotificationCategory[];
  rows: NotificationPreferenceRow[];
  /** Categories that cannot be silenced yet; empty until the policy is decided. */
  mandatoryCategories: readonly NotificationCategory[];
}

export interface NotificationPreferenceInput {
  channel: NotificationChannel;
  category: NotificationCategory;
  enabled: boolean;
}

/**
 * Everything is on by default: silence is a deliberate act, never the result of
 * a missing row.
 */
export async function listNotificationPreferences(
  db: DB,
  userId: string,
): Promise<NotificationPreferenceMatrix> {
  const stored = await db
    .select({
      channel: notificationPreferences.channel,
      category: notificationPreferences.category,
      enabled: notificationPreferences.enabled,
      updatedAt: notificationPreferences.updatedAt,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  const byKey = new Map(stored.map((r) => [`${r.channel}:${r.category}`, r]));
  const rows: NotificationPreferenceRow[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const category of NOTIFICATION_CATEGORIES) {
      const hit = byKey.get(`${channel}:${category}`);
      rows.push({
        channel,
        category,
        enabled: hit ? hit.enabled : true,
        explicit: Boolean(hit),
        updatedAt: hit ? hit.updatedAt.toISOString() : null,
      });
    }
  }

  return {
    channels: NOTIFICATION_CHANNELS,
    categories: NOTIFICATION_CATEGORIES,
    rows,
    mandatoryCategories: [],
  };
}

/**
 * Writes the requested changes for one user and returns the resulting matrix.
 *
 * Duplicate (user, channel, category) rows are impossible through this path: the
 * table has no unique constraint and this task may not add one, so the pair is
 * serialised with a transaction-scoped advisory lock before the read-then-write.
 * Two concurrent requests for the same key therefore queue instead of both
 * inserting.
 */
export async function updateNotificationPreferences(
  db: DB,
  userId: string,
  items: NotificationPreferenceInput[],
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<NotificationPreferenceMatrix> {
  if (items.length === 0) {
    throw ApiError.validation([
      { field: 'preferences', code: 'REQUIRED', message: 'At least one preference is required' },
    ]);
  }

  const seen = new Set<string>();
  for (const item of items) {
    if (!isNotificationChannel(item.channel)) {
      throw ApiError.validation([
        { field: 'channel', code: 'INVALID', message: `Unknown channel: ${String(item.channel)}` },
      ]);
    }
    if (!isNotificationCategory(item.category)) {
      throw ApiError.validation([
        { field: 'category', code: 'INVALID', message: `Unknown category: ${String(item.category)}` },
      ]);
    }
    const key = `${item.channel}:${item.category}`;
    if (seen.has(key)) {
      throw ApiError.validation([
        {
          field: 'preferences',
          code: 'DUPLICATE',
          message: `Duplicate preference for ${item.channel}/${item.category}`,
        },
      ]);
    }
    seen.add(key);
  }

  const before = await listNotificationPreferences(db, userId);

  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`notif-pref:${userId}:${item.channel}:${item.category}`}))`,
      );
      const [existing] = await tx
        .select({ id: notificationPreferences.id, enabled: notificationPreferences.enabled })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.userId, userId),
            eq(notificationPreferences.channel, item.channel),
            eq(notificationPreferences.category, item.category),
          ),
        )
        .limit(1);

      if (!existing) {
        await tx.insert(notificationPreferences).values({
          id: newId(),
          userId,
          channel: item.channel,
          category: item.category,
          enabled: item.enabled,
          updatedAt: new Date(),
        });
      } else if (existing.enabled !== item.enabled) {
        await tx
          .update(notificationPreferences)
          .set({ enabled: item.enabled, updatedAt: new Date() })
          .where(eq(notificationPreferences.id, existing.id));
      }
    }
  });

  const after = await listNotificationPreferences(db, userId);

  await writeAudit(
    db,
    { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'NOTIFICATION.PREFERENCES_UPDATED',
      entityType: 'USER',
      entityId: userId,
      before: { changed: changedRows(before, after) },
      after: { changed: changedRows(after, before) },
      metadata: { requested: items.length, channels: [...new Set(items.map((i) => i.channel))] },
    },
  );

  return after;
}

/** Only the rows whose effective value differs between the two matrices. */
function changedRows(
  next: NotificationPreferenceMatrix,
  previous: NotificationPreferenceMatrix,
): Array<{ channel: string; category: string; enabled: boolean }> {
  const prev = new Map(previous.rows.map((r) => [`${r.channel}:${r.category}`, r.enabled]));
  return next.rows
    .filter((r) => prev.get(`${r.channel}:${r.category}`) !== r.enabled)
    .map((r) => ({ channel: r.channel, category: r.category, enabled: r.enabled }));
}

/**
 * The read side of a future delivery check: absent a stored row the answer is
 * "on". Kept here (and tested) so the wiring task changes one call site only.
 */
export function isEnabled(
  matrix: Pick<NotificationPreferenceMatrix, 'rows'>,
  channel: NotificationChannel,
  category: NotificationCategory,
): boolean {
  const row = matrix.rows.find((r) => r.channel === channel && r.category === category);
  return row ? row.enabled : true;
}
