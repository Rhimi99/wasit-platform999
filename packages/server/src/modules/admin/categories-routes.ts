import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getValidatedQuery, validateQuery } from '../../middleware/validate.js';
import { categorySummary, getCategoryDetail, listCategories } from './categories-service.js';

/**
 * PR-02 slice 2 — Categories Desk routes.
 *
 * Same authority as the rest of the console (`ADMIN`/`SUPER_ADMIN`); no new
 * permission is minted and no specialized desk is bypassed. Read-only.
 *
 * The guard is attached per route, never as `use('*')`: a catch-all middleware
 * in a sub-app mounted on `/api/admin` also runs for the specialized staff desks
 * (`/api/admin/trust`, `/api/admin/disputes`, ...) and would shut SUPPORT, RISK
 * and DISPUTE out of their own desks.
 */
export const adminCategoriesRoutes = new Hono();

const guard = [requireAuth, requireRole('ADMIN', 'SUPER_ADMIN')] as const;

adminCategoriesRoutes.get('/categories/summary', ...guard, async (c) => {
  const ctx = getContext(c);
  return c.json({ success: true, data: await categorySummary(ctx.db) });
});

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional(),
  level: z.enum(['all', 'root', 'child', 'leaf']).optional(),
  parentId: z.string().min(1).max(36).optional(),
  hasProducts: z.enum(['all', 'yes', 'no']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

adminCategoriesRoutes.get('/categories', ...guard, validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  return c.json({ success: true, data: await listCategories(ctx.db, query) });
});

adminCategoriesRoutes.get('/categories/:id', ...guard, async (c) => {
  const ctx = getContext(c);
  const id = c.req.param('id')!;
  return c.json({ success: true, data: await getCategoryDetail(ctx.db, id) });
});
