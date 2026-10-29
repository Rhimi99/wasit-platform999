import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requireRole, requirePermission } from '../../middleware/auth.js';
import { listTradeEntities, updateTradeStatus, type TradeKind } from './trade-service.js';

/**
 * Admin "trade desk" — vetting of seller entities (suppliers, merchants,
 * companies). These three share the `verified` / `isActive` governance columns
 * that the public directory, search and sitemap read, but until now nothing
 * wrote them, so the trust badge could never be earned and a seller could not be
 * suspended. This desk closes that loop.
 *
 * RBAC is enforced on the server in two layers:
 *  1. the sub-app is restricted to ADMIN / SUPER_ADMIN, and
 *  2. each route additionally requires the per-kind list/update permission.
 * Layer 2 matters because the MERCHANT, SUPPLIER and COMPANY roles each hold
 * their own `*_UPDATE` permission; without the role gate they would satisfy a
 * permission-only check and could verify or suspend themselves.
 */
export const adminTradeRoutes = new Hono();

adminTradeRoutes.use('*', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

const booleanParam = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  verified: booleanParam,
  isActive: booleanParam,
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** At least one flag must be present, otherwise the request is a no-op. */
const updateSchema = z
  .object({
    verified: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.verified !== undefined || v.isActive !== undefined, {
    message: 'Provide verified and/or isActive',
    path: ['verified'],
  });

/** Per-kind permissions, so the desk grants no capability beyond the existing RBAC. */
const LIST_PERMISSION: Record<TradeKind, string> = {
  suppliers: PERMISSIONS.SUPPLIER_LIST,
  merchants: PERMISSIONS.MERCHANT_LIST,
  companies: PERMISSIONS.COMPANY_LIST,
};

const UPDATE_PERMISSION: Record<TradeKind, string> = {
  suppliers: PERMISSIONS.SUPPLIER_UPDATE,
  merchants: PERMISSIONS.MERCHANT_UPDATE,
  companies: PERMISSIONS.COMPANY_UPDATE,
};

function listHandler(kind: TradeKind) {
  return async (c: Context) => {
    const ctx = getContext(c);
    const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
    const result = await listTradeEntities(ctx.db, kind, query);
    return c.json({ success: true, data: result });
  };
}

function updateHandler(kind: TradeKind) {
  return async (c: Context) => {
    const ctx = getContext(c);
    const input = getValidatedBody<z.infer<typeof updateSchema>>(c);
    const id = c.req.param('id')!;
    const result = await updateTradeStatus(ctx.db, kind, id, input, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: result });
  };
}

for (const kind of ['suppliers', 'merchants', 'companies'] as const) {
  adminTradeRoutes.get(
    `/${kind}`,
    requirePermission(LIST_PERMISSION[kind] as never),
    validateQuery(listQuerySchema),
    listHandler(kind),
  );
  adminTradeRoutes.patch(
    `/${kind}/:id`,
    requirePermission(UPDATE_PERMISSION[kind] as never),
    validateBody(updateSchema),
    updateHandler(kind),
  );
}

/** Guard against a typo'd kind reaching the DB layer with a confusing error. */
adminTradeRoutes.all('/:kind/*', (c) => {
  throw ApiError.notFound('Trade desk resource');
});
