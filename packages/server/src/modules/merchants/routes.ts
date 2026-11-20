import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRoleOrPermission, requirePermission, optionalAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '@wasit/shared';
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

// Public directory of active merchants — public projection only.
merchantRoutes.get('/', optionalAuth, async (c) => {
  const qs = c.req.query();
  const ctx = getContext(c);
  const result = await listMerchants(ctx.db, { q: qs.q, countryId: qs.countryId });
  return c.json({ success: true, data: result });
});

// A merchant profile: public projection for everyone, 404 when inactive unless
// the caller is the owner or internal staff.
merchantRoutes.get('/:id', optionalAuth, async (c) => {
  const ctx = getContext(c);
  const merchant = await getMerchant(ctx.db, c.req.param('id')!, {
    userId: ctx.user?.id,
    roles: ctx.user?.roles,
  });
  return c.json({ success: true, data: merchant });
});

merchantRoutes.post(
  '/',
  requireAuth,
  requireRoleOrPermission('MERCHANT', PERMISSIONS.MERCHANT_CREATE),
  validateBody(createMerchantSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof createMerchantSchema>>(c);
    const ctx = getContext(c);
    const result = await createMerchant(ctx.db, { ...body, userId: ctx.user!.id }, { actorId: ctx.user!.id });
    return c.json({ success: true, data: result }, 201 as never);
  },
);

// Ownership is enforced in the service (`row.userId !== actorId` → 403): holding
// merchant:update is not enough to edit another merchant's profile.
merchantRoutes.patch(
  '/:id',
  requireAuth,
  requirePermission(PERMISSIONS.MERCHANT_UPDATE),
  validateBody(updateMerchantSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof updateMerchantSchema>>(c);
    const ctx = getContext(c);
    const merchant = await updateMerchant(ctx.db, c.req.param('id')!, body, ctx.user!.id);
    return c.json({ success: true, data: merchant });
  },
);