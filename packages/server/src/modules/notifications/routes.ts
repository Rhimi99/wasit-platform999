import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './service.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  listNotificationPreferences,
  updateNotificationPreferences,
} from './preferences.js';

const idSchema = z.object({ id: z.string().min(1).max(36) });
const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(50).optional(),
});

export const notificationRoutes = new Hono();

notificationRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.MESSAGE_READ_OWN));

/**
 * PR-10: the preference matrix. Read returns every channel/category pair with the
 * effective value (default on), so the client never has to know the defaults.
 */
notificationRoutes.get('/preferences', async (c) => {
  const ctx = getContext(c);
  const matrix = await listNotificationPreferences(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: matrix });
});

const preferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: z.enum(NOTIFICATION_CHANNELS),
        category: z.enum(NOTIFICATION_CATEGORIES),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(NOTIFICATION_CHANNELS.length * NOTIFICATION_CATEGORIES.length),
});

notificationRoutes.put('/preferences', validateBody(preferencesSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<{ preferences: Array<{ channel: (typeof NOTIFICATION_CHANNELS)[number]; category: (typeof NOTIFICATION_CATEGORIES)[number]; enabled: boolean }> }>(c);
  const matrix = await updateNotificationPreferences(ctx.db, ctx.user!.id, body.preferences, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: matrix });
});

notificationRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const result = await listNotifications(ctx.db, ctx.user!.id, query);
  return c.json({ success: true, data: result });
});

notificationRoutes.get('/unread-count', async (c) => {
  const ctx = getContext(c);
  const count = await getUnreadCount(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { count } });
});

notificationRoutes.post('/read-all', async (c) => {
  const ctx = getContext(c);
  await markAllNotificationsRead(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { count: 0 } });
});

notificationRoutes.post('/:id/read', validateBody(idSchema), async (c) => {
  const ctx = getContext(c);
  const b = getValidatedBody<{ id: string }>(c);
  await markNotificationRead(ctx.db, ctx.user!.id, b.id);
  return c.json({ success: true, data: { id: b.id } });
});