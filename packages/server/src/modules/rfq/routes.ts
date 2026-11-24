import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  cancelRfq,
  createRfq,
  declineInvitation,
  getRfq,
  getTimeline,
  listMyRfqs,
  listQuoteRevisions,
  listQuotes,
  listSellerInbox,
  rejectQuote,
  sendRfq,
  submitQuote,
  withdrawQuote,
} from './service';

const money = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Must be a positive decimal with at most 4 places');

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(5000).nullable().optional(),
  currencyCode: z.string().trim().length(3).transform((v) => v.toUpperCase()),
  neededBy: z.string().datetime({ offset: true }).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1).max(36).nullable().optional(),
        freeTextName: z.string().trim().min(1).max(200).nullable().optional(),
        quantity: money,
        unit: z.string().trim().max(40).nullable().optional(),
        targetPrice: money.nullable().optional(),
        specifications: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
}).strict();

const sendSchema = z.object({
  sellerIds: z.array(z.string().min(1).max(36)).min(1).max(50),
  acknowledgeDisclosure: z.boolean(),
}).strict();

const quoteSchema = z.object({
  currencyCode: z.string().trim().length(3).transform((v) => v.toUpperCase()),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  paymentTerms: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  lines: z
    .array(
      z.object({
        rfqItemId: z.string().min(1).max(36),
        unitPrice: money,
        quantity: money,
      }),
    )
    .min(1)
    .max(200),
}).strict();

const cancelSchema = z.object({ reason: z.string().max(1000).nullable().optional() }).strict();
const declineSchema = z.object({ reason: z.string().max(1000).nullable().optional() }).strict();
const withdrawSchema = z.object({ reason: z.string().max(1000).nullable().optional() }).strict();
const rejectSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export const rfqRoutes = new Hono();

rfqRoutes.use('*', requireAuth);

/**
 * Every route states the participant permission it needs, and each service call
 * re-derives the caller's side from the database. A permission alone never
 * grants access to a specific RFQ: `assertRfqAccess` decides that.
 */
rfqRoutes.post(
  '/',
  requirePermission(PERMISSIONS.RFQ_CREATE),
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'rfq-create' }),
  validateBody(createSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof createSchema>>(c);
    const result = await createRfq(ctx.db, ctx.user!.id, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: result }, 201);
  },
);

rfqRoutes.get('/', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  return c.json({ success: true, data: await listMyRfqs(ctx.db, ctx.user!.id) });
});

rfqRoutes.get('/inbox', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  return c.json({ success: true, data: await listSellerInbox(ctx.db, ctx.user!.id) });
});

rfqRoutes.get('/:id', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const data = await getRfq(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data });
});

rfqRoutes.get('/:id/quotes', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const data = await listQuotes(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data });
});

rfqRoutes.get('/:id/timeline', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const data = await getTimeline(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data });
});

rfqRoutes.post(
  '/:id/send',
  requirePermission(PERMISSIONS.RFQ_CREATE),
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'rfq-send' }),
  validateBody(sendSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof sendSchema>>(c);
    const data = await sendRfq(ctx.db, ctx.user!.id, c.req.param('id')!, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data });
  },
);

rfqRoutes.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.RFQ_CREATE),
  validateBody(cancelSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof cancelSchema>>(c);
    const data = await cancelRfq(ctx.db, ctx.user!.id, c.req.param('id')!, body.reason ?? null, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data });
  },
);

rfqRoutes.post(
  '/:id/quotes',
  requirePermission(PERMISSIONS.RFQ_QUOTE),
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'rfq-quote' }),
  validateBody(quoteSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof quoteSchema>>(c);
    const data = await submitQuote(ctx.db, ctx.user!.id, c.req.param('id')!, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data }, 201);
  },
);

rfqRoutes.post(
  '/:id/decline',
  requirePermission(PERMISSIONS.RFQ_QUOTE),
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'rfq-decline' }),
  validateBody(declineSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof declineSchema>>(c);
    const data = await declineInvitation(ctx.db, ctx.user!.id, c.req.param('id')!, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data });
  },
);

rfqRoutes.post(
  '/:id/quotes/:quoteId/withdraw',
  requirePermission(PERMISSIONS.RFQ_QUOTE),
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'rfq-quote-withdraw' }),
  validateBody(withdrawSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof withdrawSchema>>(c);
    const data = await withdrawQuote(ctx.db, ctx.user!.id, c.req.param('id')!, c.req.param('quoteId')!, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data });
  },
);

rfqRoutes.post(
  '/:id/quotes/:quoteId/reject',
  requirePermission(PERMISSIONS.RFQ_DECIDE),
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'rfq-quote-reject' }),
  validateBody(rejectSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof rejectSchema>>(c);
    const data = await rejectQuote(ctx.db, ctx.user!.id, c.req.param('id')!, c.req.param('quoteId')!, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data });
  },
);

rfqRoutes.get('/:id/quotes/:quoteId/revisions', requirePermission(PERMISSIONS.RFQ_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const data = await listQuoteRevisions(ctx.db, ctx.user!.id, c.req.param('id')!, c.req.param('quoteId')!);
  return c.json({ success: true, data });
});
