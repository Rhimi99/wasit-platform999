import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import {
  addDisputeMessage,
  addEvidence,
  createDispute,
  createDisputeAppeal,
  getDisputeDetail,
  listDisputeAppeals,
  listDisputePolicyRules,
  listMyDisputes,
} from './service';

const createSchema = z.object({
  orderId: z.string().min(1).max(36),
  reasonCode: z.string().min(2).max(100),
  description: z.string().min(10).max(5000),
});

const messageSchema = z.object({
  body: z.string().min(1).max(5000),
});

const evidenceSchema = z.object({
  fileRef: z.string().min(1).max(500),
  description: z.string().max(1000).optional(),
  contentType: z.string().max(100).optional(),
});

const appealSchema = z.object({
  reason: z.string().min(10).max(5000),
});

export const disputeRoutes = new Hono();

disputeRoutes.use('*', requireAuth, requirePermission(
  PERMISSIONS.DISPUTE_CREATE,
  PERMISSIONS.DISPUTE_READ_OWN,
  PERMISSIONS.DISPUTE_READ,
));

disputeRoutes.get('/policies', async (c) => {
  const ctx = getContext(c);
  const orderId = c.req.query('orderId');
  // Without an order the response keeps the original `{ rules }` shape; with an
  // order it adds the resolved country source/version so callers can show context.
  if (!orderId) {
    const rules = await listDisputePolicyRules(ctx.db);
    return c.json({ success: true, data: { rules } });
  }
  const result = await listDisputePolicyRules(ctx.db, orderId);
  return c.json({ success: true, data: result });
});

disputeRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const items = await listMyDisputes(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

disputeRoutes.post('/', validateBody(createSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof createSchema>>(c);
  const result = await createDispute(ctx.db, ctx.user!.id, body, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

disputeRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const detail = await getDisputeDetail(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data: detail });
});

disputeRoutes.post('/:id/messages', validateBody(messageSchema), requirePermission(PERMISSIONS.DISPUTE_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof messageSchema>>(c);
  const result = await addDisputeMessage(ctx.db, ctx.user!.id, c.req.param('id')!, body.body);
  return c.json({ success: true, data: result });
});

disputeRoutes.post('/:id/evidence', validateBody(evidenceSchema), requirePermission(PERMISSIONS.DISPUTE_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof evidenceSchema>>(c);
  const result = await addEvidence(ctx.db, ctx.user!.id, c.req.param('id')!, body);
  return c.json({ success: true, data: result });
});

disputeRoutes.get('/:id/appeals', requirePermission(PERMISSIONS.DISPUTE_READ_OWN, PERMISSIONS.DISPUTE_READ), async (c) => {
  const ctx = getContext(c);
  const items = await listDisputeAppeals(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data: { items } });
});

disputeRoutes.post('/:id/appeals', validateBody(appealSchema), requirePermission(PERMISSIONS.DISPUTE_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof appealSchema>>(c);
  const result = await createDisputeAppeal(ctx.db, ctx.user!.id, c.req.param('id')!, body, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});