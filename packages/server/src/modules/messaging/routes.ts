import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  getThread,
  listMyThreads,
  markThreadRead,
  openDirectThread,
  searchMessaging,
  sendMessage,
} from './service.js';
import { markAllThreadNotificationsRead } from '../notifications/service.js';
import type { DB } from '../../db/client.js';

const openThreadSchema = z.object({
  participantUserId: z.string().min(1).max(36),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
});

const sendSchema = z.object({
  body: z.string().min(1).max(5000),
  messageType: z.enum(['TEXT', 'SYSTEM', 'ORDER', 'OFFER']).optional(),
});

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  scope: z.enum(['all', 'threads', 'messages']).default('all'),
});

export const messagingRoutes = new Hono();

messagingRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.MESSAGE_READ_OWN, PERMISSIONS.MESSAGE_SEND));

function auditCtx(c: import('hono').Context) {
  const ctx = getContext(c);
  return { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent };
}

messagingRoutes.get('/', validateQuery(listQuerySchema), async (c) => {
  const q = getValidatedQuery<{ q?: string; page?: number }>(c);
  const ctx = getContext(c);
  const result = await listMyThreads(ctx.db, ctx.user!.id, q);
  return c.json({ success: true, data: result });
});

messagingRoutes.post('/', validateBody(openThreadSchema), async (c) => {
  const b = getValidatedBody<z.infer<typeof openThreadSchema>>(c);
  const ctx = getContext(c);
  const result = await openDirectThread(ctx.db, ctx.user!.id, b, { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  // Clear pending "new message" notifications for this thread for the recipient when they open it.
  await markAllThreadNotificationsRead(ctx.db, ctx.user!.id, result.threadId);
  return c.json({ success: true, data: result });
});

messagingRoutes.get('/search', validateQuery(searchQuerySchema), async (c) => {
  const q = getValidatedQuery<{ q: string; scope?: string }>(c);
  const ctx = getContext(c);
  const result = await searchMessaging(ctx.db, ctx.user!.id, q.q);
  return c.json({ success: true, data: result });
});

messagingRoutes.post('/:threadId/read', async (c) => {
  const ctx = getContext(c);
  const threadId = c.req.param('threadId')!;
  await markThreadRead(ctx.db, ctx.user!.id, threadId);
  await markAllThreadNotificationsRead(ctx.db, ctx.user!.id, threadId);
  return c.json({ success: true, data: { threadId } });
});

messagingRoutes.get('/:threadId', async (c) => {
  const ctx = getContext(c);
  const thread = await getThread(ctx.db, ctx.user!.id, c.req.param('threadId')!, { markRead: true });
  await markAllThreadNotificationsRead(ctx.db, ctx.user!.id, thread.id);
  return c.json({ success: true, data: thread });
});

messagingRoutes.post('/:threadId/messages', validateBody(sendSchema), async (c) => {
  const b = getValidatedBody<z.infer<typeof sendSchema>>(c);
  const ctx = getContext(c);
  const result = await sendMessage(ctx.db, ctx.user!.id, c.req.param('threadId')!, b, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result }, 201 as never);
});