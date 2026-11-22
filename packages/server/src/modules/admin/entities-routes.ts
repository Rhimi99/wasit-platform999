import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getValidatedQuery, validateQuery } from '../../middleware/validate.js';
import {
  ENTITY_TYPES,
  entitySummary,
  getEntityDetail,
  listEntities,
  type EntityType,
} from './entities-service.js';

/**
 * PR-02 slice 1 — Entities Desk routes.
 *
 * Guarded by the same general admin authority the console already uses
 * (`ADMIN`/`SUPER_ADMIN`); no new permission is minted and no specialized desk
 * (verification, trust, disputes) is bypassed. Every handler is read-only, so the
 * desk cannot change a business's standing by accident.
 */
export const adminEntitiesRoutes = new Hono();

/**
 * The guard is attached per route, never as `use('*')`: a catch-all middleware in
 * a sub-app mounted on `/api/admin` also runs for the specialized staff desks
 * (`/api/admin/trust`, `/api/admin/disputes`, ...) and would shut SUPPORT and
 * DISPUTE out of their own desks.
 */
const guard = [requireAuth, requireRole('ADMIN', 'SUPER_ADMIN')] as const;

adminEntitiesRoutes.get('/entities/summary', ...guard, async (c) => {
  const ctx = getContext(c);
  return c.json({ success: true, data: { items: await entitySummary(ctx.db) } });
});

const listQuerySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional(),
  verified: z.enum(['all', 'yes', 'no']).optional(),
  countryId: z.string().min(1).max(36).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

adminEntitiesRoutes.get('/entities', ...guard, validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const result = await listEntities(ctx.db, query);
  return c.json({ success: true, data: result });
});

adminEntitiesRoutes.get('/entities/:type/:id', ...guard, async (c) => {
  const ctx = getContext(c);
  const type = c.req.param('type')!;
  const id = c.req.param('id')!;
  const parsed = z.enum(ENTITY_TYPES).safeParse(type);
  if (!parsed.success) {
    return c.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          fieldErrors: [{ field: 'type', code: 'INVALID', message: `Unknown entity type: ${type}` }],
        },
      },
      422 as never,
    );
  }
  const detail = await getEntityDetail(ctx.db, parsed.data as EntityType, id);
  return c.json({ success: true, data: detail });
});
