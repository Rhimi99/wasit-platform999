import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { createOrder, getOrder, listMyOrders, updateOrderStatus } from './service.js';

const createOrderSchema = z.object({
  buyerId: z.string().min(1),
  buyerType: z.enum(['CUSTOMER', 'MERCHANT', 'COMPANY']).default('CUSTOMER'),
  // An assertion only: the service checks it against the caller's own company.
  companyId: z.string().min(1).max(36).optional(),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ).min(1).max(100),
  currencyCode: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
});

const updateStatusSchema = z.object({
  status: z.string().min(1),
  // Which seller suborder the transition targets. Required to disambiguate a
  // multi-seller parent order; omitted for a single-seller order.
  sellerOrderId: z.string().min(1).optional(),
});

export const ordersRoutes = new Hono();

ordersRoutes.use('*', requireAuth);

ordersRoutes.post('/', validateBody(createOrderSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof createOrderSchema>>(c);
  const ctx = getContext(c);
  // `createOrder` refuses a buyerId that is not the caller, so the invariant holds
  // for every caller of the service, not only this route.
  const result = await createOrder(ctx.db, body, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress });
  return c.json({ success: true, data: result }, 201 as never);
});

ordersRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const result = await listMyOrders(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: result });
});

ordersRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const order = await getOrder(ctx.db, c.req.param('id')!, ctx.user!.id);
  return c.json({ success: true, data: order });
});

ordersRoutes.patch('/:id/status', validateBody(updateStatusSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof updateStatusSchema>>(c);
  const ctx = getContext(c);
  const id = c.req.param('id')!;
  await updateOrderStatus(ctx.db, id, body.status, ctx.user!.id, { sellerOrderId: body.sellerOrderId });
  return c.json({ success: true });
});