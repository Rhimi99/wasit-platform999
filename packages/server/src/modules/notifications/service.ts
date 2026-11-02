import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { notifications, notificationDeliveries, notificationPreferences } from '../../db/schema/messaging';
import { newId } from '../../lib/ids';
import { NOTIFICATION_CHANNELS, NOTIFICATION_CATEGORIES } from '../../lib/notifications/types';

export const COUNT_SQL = sql<number>`count(*)::int`;

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export async function listNotifications(
  db: DB,
  userId: string,
  query: { page?: number; pageSize?: number } = {},
): Promise<{ items: NotificationItem[]; page: number; pageSize: number; total: number; unreadCount: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));

  const [{ total, unreadCount }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unreadCount: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      data: r.data as Record<string, unknown> | null,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total: Number(total),
    unreadCount: Number(unreadCount),
  };
}

export async function getUnreadCount(db: DB, userId: string): Promise<number> {
  const rows = await db
    .select({ count: COUNT_SQL })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(rows[0]?.count ?? 0);
}

export async function markNotificationRead(
  db: DB,
  userId: string,
  notificationId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw ApiError.notFound('Notification');
  await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notificationId));
}

export async function markAllNotificationsRead(db: DB, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

export async function markAllThreadNotificationsRead(db: DB, userId: string, threadId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(notifications.userId, userId),
      eq(notifications.type, 'MESSAGE.NEW'),
      sql`${notifications.data}->>'threadId' = ${threadId}`,
    ));
}

export interface PreferenceEntry {
  channel: string;
  category: string;
  enabled: boolean;
}

/**
 * Returns the user's explicit preferences, plus the defaults for every
 * channel/category pair they have not set. Absence of a row means "enabled", so
 * the UI can render the full matrix without the engine needing a row per pair.
 */
export async function listNotificationPreferences(db: DB, userId: string): Promise<PreferenceEntry[]> {
  const rows = await db
    .select({
      channel: notificationPreferences.channel,
      category: notificationPreferences.category,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const set = new Map(rows.map((r) => [`${r.channel}:${r.category}`, r.enabled]));
  const out: PreferenceEntry[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const category of NOTIFICATION_CATEGORIES) {
      out.push({ channel, category, enabled: set.get(`${channel}:${category}`) ?? true });
    }
  }
  return out;
}

/**
 * Upserts one preference. `IN_APP`/`SYSTEM` (security and system notices) cannot
 * be disabled — a user must always receive account/security events in-app — so
 * the write is refused for that pair rather than silently stored.
 */
export async function setNotificationPreference(
  db: DB,
  userId: string,
  input: { channel: string; category: string; enabled: boolean },
): Promise<void> {
  if (!NOTIFICATION_CHANNELS.includes(input.channel as never)) {
    throw ApiError.validation([{ field: 'channel', message: `Unknown channel: ${input.channel}`, code: 'VALIDATION_FAILED' }]);
  }
  if (!NOTIFICATION_CATEGORIES.includes(input.category as never)) {
    throw ApiError.validation([{ field: 'category', message: `Unknown category: ${input.category}`, code: 'VALIDATION_FAILED' }]);
  }
  if (input.channel === 'IN_APP' && (input.category === 'SECURITY' || input.category === 'SYSTEM') && !input.enabled) {
    throw ApiError.validation([{
      field: 'enabled',
      message: 'Security and system notifications cannot be disabled',
      code: 'VALIDATION_FAILED',
    }]);
  }

  const existing = await db
    .select({ id: notificationPreferences.id })
    .from(notificationPreferences)
    .where(and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.channel, input.channel),
      eq(notificationPreferences.category, input.category),
    ))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(notificationPreferences)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing[0].id));
    return;
  }
  await db.insert(notificationPreferences).values({
    id: newId(),
    userId,
    channel: input.channel,
    category: input.category,
    enabled: input.enabled,
  });
}

export interface DeliveryLogItem {
  id: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** The user's own channel-delivery history (for transparency/debugging). */
export async function listMyDeliveries(
  db: DB,
  userId: string,
  query: { page?: number; pageSize?: number } = {},
): Promise<{ items: DeliveryLogItem[]; page: number; pageSize: number; total: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.userId, userId));
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.userId, userId))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    items: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      entityType: r.entityType,
      entityId: r.entityId,
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total: Number(total),
  };
}