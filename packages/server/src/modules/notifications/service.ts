import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { notifications } from '../../db/schema/messaging';

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