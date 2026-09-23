import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS, type UserRole } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  addCreative,
  createCampaign,
  getCampaignStats,
  getMyCampaign,
  listMyAdvertisers,
  listMyCampaigns,
  recordAdEvent,
  servePlacement,
  updateCampaign,
} from './service.js';

const campaignObjectiveEnum = z.enum([
  'PRODUCT_ADS',
  'STORE_ADS',
  'SUPPLIER_ADS',
  'COMPANY_ADS',
  'B2B_ADS',
  'B2C_ADS',
  'TOP_ADS',
  'SPONSORED_SEARCH',
]);
const campaignStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']);
const advertiserTypeEnum = z.enum(['MERCHANT', 'SUPPLIER', 'COMPANY']);

const createCampaignSchema = z.object({
  advertiserId: z.string().min(1).max(36),
  advertiserType: advertiserTypeEnum,
  title: z.string().min(2).max(200),
  objective: campaignObjectiveEnum,
  budget: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid budget'),
  currencyCode: z.string().length(3).default('TND'),
  startsAt: z.string().min(1),
  endsAt: z.string().optional().nullable(),
  targeting: z.record(z.unknown()).optional().nullable(),
  adUnits: z.record(z.unknown()).optional().nullable(),
});

const updateCampaignSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  budget: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid budget').optional(),
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().optional().nullable(),
  targeting: z.record(z.unknown()).optional().nullable(),
  adUnits: z.record(z.unknown()).optional().nullable(),
  status: campaignStatusEnum.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

const createCreativeSchema = z.object({
  type: z.string().min(1).max(60),
  title: z.string().min(1).max(250),
  body: z.string().max(2000).optional().nullable(),
  mediaUrl: z.string().url().max(1000).optional().nullable(),
  targetUrl: z.string().url().max(1000).optional().nullable(),
});

const eventTypeEnum = z.enum(['IMPRESSION', 'CLICK', 'CONVERSION']);

const createEventSchema = z.object({
  campaignId: z.string().min(1).max(36),
  creativeId: z.string().min(1).max(36).optional().nullable(),
  eventType: eventTypeEnum,
  sessionId: z.string().max(100).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).refine((v) => v.eventType !== 'CONVERSION' || v.metadata !== undefined, {
  message: 'Conversion events require metadata (e.g. cost, orderId)',
});

const servedQuerySchema = z.object({
  placement: z.string().max(60).optional(),
});

const listQuerySchema = z.object({
  status: campaignStatusEnum.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const adsRoutes = new Hono();

// Authenticated + advertiser permission for campaign management endpoints.
adsRoutes.use('/campaigns/*', requireAuth, requirePermission(
  PERMISSIONS.CAMPAIGN_CREATE,
  PERMISSIONS.CAMPAIGN_MANAGE,
));
adsRoutes.use('/events', optionalAuth);

// Serve endpoint is public (no auth) — it only returns active creatives for placements.
adsRoutes.get('/served', (c) => {
  const qs = c.req.query();
  const parsed = servedQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const ctx = getContext(c);
  return servePlacement(ctx.db, {
    placement: query.placement,
    userId: ctx.user?.id ?? null,
  }).then((items) => c.json({ success: true, data: items }));
});

// List advertiser entities owned by the current user (for the ads UI to create campaigns).
adsRoutes.get('/my-advertisers', requireAuth, async (c) => {
  const ctx = getContext(c);
  const items = await listMyAdvertisers(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

adsRoutes.post('/campaigns', validateBody(createCampaignSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof createCampaignSchema>>(c);
  const result = await createCampaign(ctx.db, body, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result }, 201);
});

adsRoutes.get('/campaigns', async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const roles = (ctx.user?.roles ?? []) as UserRole[];
  const result = await listMyCampaigns(ctx.db, ctx.user!.id, roles, {
    status: query.status,
    page: query.page,
    pageSize: query.pageSize,
  });
  return c.json({ success: true, data: result });
});

adsRoutes.get('/campaigns/:id', async (c) => {
  const ctx = getContext(c);
  const roles = (ctx.user?.roles ?? []) as UserRole[];
  const result = await getMyCampaign(ctx.db, c.req.param('id')!, ctx.user!.id, roles);
  return c.json({ success: true, data: result });
});

adsRoutes.patch('/campaigns/:id', validateBody(updateCampaignSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof updateCampaignSchema>>(c);
  const roles = (ctx.user?.roles ?? []) as UserRole[];
  const result = await updateCampaign(ctx.db, c.req.param('id')!, ctx.user!.id, body, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }, roles);
  return c.json({ success: true, data: result });
});

adsRoutes.post('/campaigns/:id/creatives', validateBody(createCreativeSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof createCreativeSchema>>(c);
  const roles = (ctx.user?.roles ?? []) as UserRole[];
  const result = await addCreative(ctx.db, c.req.param('id')!, body, ctx.user!.id, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }, roles);
  return c.json({ success: true, data: result }, 201);
});

adsRoutes.get('/campaigns/:id/stats', async (c) => {
  const ctx = getContext(c);
  const roles = (ctx.user?.roles ?? []) as UserRole[];
  const result = await getCampaignStats(ctx.db, c.req.param('id')!, ctx.user!.id, roles);
  return c.json({ success: true, data: result });
});

adsRoutes.post('/events', validateBody(createEventSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof createEventSchema>>(c);
  // Impressions and clicks are anonymous, viewable-page telemetry. A conversion
  // moves money (it consumes budget), so it must come from an authenticated actor.
  if (body.eventType === 'CONVERSION' && !ctx.user) {
    throw ApiError.unauthorized('Authentication required to record a conversion');
  }
  const result = await recordAdEvent(ctx.db, body, {
    actorId: ctx.user?.id ?? null,
    ipAddress: ctx.ipAddress,
  });
  return c.json({ success: true, data: result }, 201);
});