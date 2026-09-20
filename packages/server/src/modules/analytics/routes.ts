import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { writeAudit } from '../../lib/audit';
import {
  getMyAnalyticsOverview,
  listAnalyticsEvents,
  recordAnalyticsEvent,
} from './service';

const EVENT_NAME_RE = /^[a-z0-9._-]{1,100}$/i;

const captureEventSchema = z.object({
  eventName: z.string().regex(EVENT_NAME_RE, 'Invalid event name'),
  properties: z.record(z.unknown()).optional(),
});

export const analyticsRoutes = new Hono();

// Own-analytics: business user sees their entity's KPIs (owner-scoped).
analyticsRoutes.get('/my-overview', requireAuth, requirePermission(PERMISSIONS.ANALYTICS_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const data = await getMyAnalyticsOverview(ctx.db, ctx.user!.id);
  return c.json({ success: true, data });
});

// Own analytics events (self-scoped, user only).
analyticsRoutes.get('/events', requireAuth, requirePermission(PERMISSIONS.ANALYTICS_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const { limit, eventName } = c.req.query();
  const data = await listAnalyticsEvents(ctx.db, ctx.user!.id, {
    limit: limit ? Number(limit) : undefined,
    eventName,
  });
  return c.json({ success: true, data: { items: data } });
});

// Capture a real analytics event (self).
analyticsRoutes.post('/events', requireAuth, requirePermission(PERMISSIONS.ANALYTICS_READ_OWN), validateBody(captureEventSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<{ eventName: string; properties?: Record<string, unknown> }>(c);
  const result = await recordAnalyticsEvent(ctx.db, ctx.user!.id, null, {
    eventName: body.eventName,
    properties: body.properties,
  }, ctx.ipAddress ? Buffer.from(ctx.ipAddress).toString('base64').slice(0, 64) : null);
  await writeAudit(ctx.db, ctx, {
    action: 'ANALYTICS.EVENT_CAPTURED',
    entityType: 'ANALYTICS_EVENT',
    entityId: result.id,
    metadata: { eventName: body.eventName },
  });
  return c.json({ success: true, data: result }, 201);
});