import { Hono } from 'hono';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { getTrustOverview, getTrustScoreHistory, recomputeTrust } from './service';

export const trustRoutes = new Hono();

trustRoutes.use('*', requireAuth);

// A user can read their own trust score.
trustRoutes.get('/me', requirePermission(PERMISSIONS.TRUST_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const overview = await getTrustOverview(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: overview });
});

// Full score history (per-snapshot) for the current user.
trustRoutes.get('/me/history', requirePermission(PERMISSIONS.TRUST_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const history = await getTrustScoreHistory(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items: history } });
});

trustRoutes.post('/me/recompute', requirePermission(PERMISSIONS.TRUST_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const result = await recomputeTrust(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: result });
});