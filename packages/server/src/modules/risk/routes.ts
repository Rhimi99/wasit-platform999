import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateQuery, getValidatedQuery } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { listRiskEvents, listRiskProfiles, getRiskProfile, reassessUserRisk } from './service';

const listQuerySchema = z.object({
  userId: z.string().max(36).optional(),
  level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'SEVERE']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const riskRoutes = new Hono();

// Risk is an internal engine — restricted to RISK/ADMIN/SUPER_ADMIN roles.
riskRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.RISK_READ));

riskRoutes.get('/profiles', async (c) => {
  const ctx = getContext(c);
  const profiles = await listRiskProfiles(ctx.db);
  return c.json({ success: true, data: { items: profiles } });
});

riskRoutes.get('/events', validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const result = await listRiskEvents(ctx.db, query);
  return c.json({ success: true, data: result });
});

riskRoutes.get('/profiles/:userId', async (c) => {
  const ctx = getContext(c);
  const profile = await getRiskProfile(ctx.db, c.req.param('userId')!);
  return c.json({ success: true, data: profile });
});

riskRoutes.post(
  '/profiles/:userId/reassess',
  requirePermission(PERMISSIONS.RISK_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const profile = await reassessUserRisk(ctx.db, c.req.param('userId')!, ctx.user!.id);
    return c.json({ success: true, data: profile });
  },
);