import { Hono } from 'hono';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { getMyEntities, updateMyEntity } from './service.js';
import {
  companyUpdateSchema,
  merchantUpdateSchema,
  supplierUpdateSchema,
  type CompanyUpdateInput,
  type MerchantUpdateInput,
  type SupplierUpdateInput,
} from './schemas.js';

export const entityRoutes = new Hono();

/**
 * The caller's own entity profiles. Reading is scoped to the authenticated
 * user, so there is no id to guess and nothing to enumerate.
 */
entityRoutes.get('/me', requireAuth, async (c) => {
  const ctx = getContext(c);
  const entities = await getMyEntities(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: entities });
});

entityRoutes.patch(
  '/merchant/me',
  requireAuth,
  requirePermission(PERMISSIONS.MERCHANT_UPDATE),
  validateBody(merchantUpdateSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<MerchantUpdateInput>(c);
    const { entity, changed } = await updateMyEntity(ctx.db, 'merchant', ctx.user!.id, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: { entity, changed } });
  },
);

entityRoutes.patch(
  '/supplier/me',
  requireAuth,
  requirePermission(PERMISSIONS.SUPPLIER_UPDATE),
  validateBody(supplierUpdateSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<SupplierUpdateInput>(c);
    const { entity, changed } = await updateMyEntity(ctx.db, 'supplier', ctx.user!.id, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: { entity, changed } });
  },
);

entityRoutes.patch(
  '/company/me',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_UPDATE),
  validateBody(companyUpdateSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<CompanyUpdateInput>(c);
    const { entity, changed } = await updateMyEntity(ctx.db, 'company', ctx.user!.id, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: { entity, changed } });
  },
);
