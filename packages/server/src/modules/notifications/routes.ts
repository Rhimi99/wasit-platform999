import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  getUnreadCount,
  listMyDeliveries,
  listNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
} from './service.js';

const idSchema = z.object({ id: z.string().min(1).max(36) });
const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(50).optional(),
});
const preferenceSchema = z.object({
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK']),
  category: z.enum(['ORDER', 'PAYMENT', 'REFUND', 'INVENTORY', 'DISPUTE', 'VERIFICATION', 'SECURITY', 'SYSTEM']),
  enabled: z.boolean(),
});

export const notificationRoutes = new Hono();

notificationRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.MESSAGE_READ_OWN));

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

notificationRoutes.get('/preferences', async (c) => {
  const ctx = getContext(c);
  const items = await listNotificationPreferences(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

notificationRoutes.put('/preferences', validateBody(preferenceSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof preferenceSchema>>(c);
  await setNotificationPreference(ctx.db, ctx.user!.id, body);
  return c.json({ success: true, data: body });
});

notificationRoutes.get('/deliveries', async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const result = await listMyDeliveries(ctx.db, ctx.user!.id, query);
  return c.json({ success: true, data: result });
});

notificationRoutes.post('/:id/read', validateBody(idSchema), async (c) => {
  const ctx = getContext(c);
  const b = getValidatedBody<{ id: string }>(c);
  await markNotificationRead(ctx.db, ctx.user!.id, b.id);
  return c.json({ success: true, data: { id: b.id } });
});