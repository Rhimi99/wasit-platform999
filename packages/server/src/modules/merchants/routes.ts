import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { createMerchant, listMerchants, getMerchant, updateMerchant } from './service.js';

const createMerchantSchema = z.object({
  storeName: z.string().min(2).max(200),
  countryId: z.string().max(36).optional(),
  cityId: z.string().max(36).optional(),
  description: z.string().max(5000).optional(),
  logoUrl: z.string().url().max(2000).optional(),
});

const updateMerchantSchema = createMerchantSchema.partial();

export const merchantRoutes = new Hono();

merchantRoutes.get('/', async (c) => {
  const qs = c.req.query();
  const ctx = getContext(c);
  const result = await listMerchants(ctx.db, { q: qs.q, countryId: qs.countryId });
  return c.json({ success: true, data: result });
});

merchantRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const merchant = await getMerchant(ctx.db, c.req.param('id')!);
  return c.json({ success: true, data: merchant });
});

merchantRoutes.post('/', requireAuth, requireRole('MERCHANT'), validateBody(createMerchantSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof createMerchantSchema>>(c);
  const ctx = getContext(c);
  const result = await createMerchant(ctx.db, { ...body, userId: ctx.user!.id }, { actorId: ctx.user!.id });
  return c.json({ success: true, data: result }, 201 as never);
});

merchantRoutes.patch('/:id', requireAuth, validateBody(updateMerchantSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof updateMerchantSchema>>(c);
  const ctx = getContext(c);
  const merchant = await updateMerchant(ctx.db, c.req.param('id')!, body, ctx.user!.id);
  return c.json({ success: true, data: merchant });
});