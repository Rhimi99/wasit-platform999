import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateQuery, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import {
  listBuyers,
  listMerchantDirectory,
  listMyEntities,
  listSellerPartners,
  listSupplierDirectory,
} from './service.js';

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const buyerTypeSchema = z.enum(['CUSTOMER', 'MERCHANT', 'COMPANY']);

const buyersQuerySchema = listQuerySchema.extend({
  buyerType: buyerTypeSchema.optional(),
});

/**
 * Role-scoped directory reads.
 *
 * Every endpoint requires an authenticated session (`requireAuth` → 401) and the
 * relevant list permission (`requirePermission` → 403 for a role that is signed
 * in but not entitled). Relationship lists are additionally owner-scoped in the
 * service layer, so entitlement alone never exposes another seller's data.
 */
export const directoryRoutes = new Hono();

directoryRoutes.use('*', requireAuth);

/** The entities the caller owns — drives the dashboard's own-profile context. */
directoryRoutes.get('/my-entities', async (c) => {
  const ctx = getContext(c);
  const items = await listMyEntities(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

/** Buyers who have real orders with the caller's entities. */
directoryRoutes.get('/buyers', requirePermission(PERMISSIONS.ORDER_READ_OWN), validateQuery(buyersQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof buyersQuerySchema>>(c);
  const result = await listBuyers(ctx.db, ctx.user!.id, query);
  return c.json({ success: true, data: result });
});

/** A seller list filtered to the caller's own purchase history. */
directoryRoutes.get('/my/:kind', requirePermission(PERMISSIONS.ORDER_READ_OWN), validateQuery(buyersQuerySchema), async (c) => {
  const ctx = getContext(c);
  const kind = c.req.param('kind')!;
  if (kind !== 'suppliers' && kind !== 'merchants') {
    throw ApiError.notFound('Unknown directory kind.');
  }
  const query = getValidatedQuery<z.infer<typeof buyersQuerySchema>>(c);
  const result = await listSellerPartners(
    ctx.db,
    ctx.user!.id,
    kind === 'suppliers' ? 'SUPPLIER' : 'MERCHANT',
    query,
    query.buyerType,
  );
  return c.json({ success: true, data: result });
});

/** Platform-wide supplier directory (active suppliers). */
directoryRoutes.get('/suppliers', requirePermission(PERMISSIONS.SUPPLIER_LIST), validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const result = await listSupplierDirectory(ctx.db, query);
  return c.json({ success: true, data: result });
});

/** Platform-wide merchant directory (active merchants). */
directoryRoutes.get('/merchants', requirePermission(PERMISSIONS.MERCHANT_LIST), validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const result = await listMerchantDirectory(ctx.db, query);
  return c.json({ success: true, data: result });
});
