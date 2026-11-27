import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { configEnvironment } from '../../lib/ai/provider-config.js';
import {
  deleteSpendLimit,
  listSpendLimits,
  spendOverview,
  upsertSpendLimit,
  type SpendPeriod,
  type SpendScope,
} from '../../lib/ai/spend-limits.js';

/**
 * AI consumption and spend control (AI-05).
 *
 * Read routes answer "which agent spent what, on which provider and model, in
 * which environment, over which window" from recorded rows only. Write routes
 * manage the caps; nothing here can spend money, and no route returns a key or
 * a prompt.
 */
export const adminAiSpendRoutes = new Hono();

adminAiSpendRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

const overviewQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
  environment: z.string().min(1).max(30).optional(),
});

adminAiSpendRoutes.get('/', validateQuery(overviewQuery), async (c) => {
  const ctx = getContext(c);
  const q = getValidatedQuery<z.infer<typeof overviewQuery>>(c);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - (q.days ?? 30) * 86_400_000);
  if (from.getTime() >= to.getTime()) {
    throw ApiError.validation(
      [{ field: 'from', message: 'Must be earlier than `to`', code: 'INVALID' }],
      '`from` must be earlier than `to`',
    );
  }
  const environment = q.environment ?? configEnvironment();
  const data = await spendOverview(ctx.db, { from, to, environment });
  return c.json({ success: true, data });
});

const limitBody = z.object({
  environment: z.string().min(1).max(30).optional(),
  scope: z.enum(['GLOBAL', 'PROVIDER', 'AGENT']),
  targetKey: z.string().max(100).optional().nullable(),
  period: z.enum(['DAILY', 'MONTHLY']),
  maxCost: z.union([z.string(), z.number()]).optional().nullable(),
  maxRequests: z.number().int().min(0).optional().nullable(),
  warnRatio: z.union([z.string(), z.number()]).optional(),
  currencyCode: z.string().length(3).optional(),
  isActive: z.boolean().optional(),
});

adminAiSpendRoutes.get('/limits', async (c) => {
  const ctx = getContext(c);
  const environment = c.req.query('environment') ?? configEnvironment();
  const rows = await listSpendLimits(ctx.db, environment);
  return c.json({ success: true, data: { environment, limits: rows } });
});

adminAiSpendRoutes.put('/limits', validateBody(limitBody), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof limitBody>>(c);
  const row = await upsertSpendLimit(
    ctx.db,
    {
      environment: body.environment ?? configEnvironment(),
      scope: body.scope as SpendScope,
      targetKey: body.targetKey ?? null,
      period: body.period as SpendPeriod,
      maxCost: body.maxCost ?? null,
      maxRequests: body.maxRequests ?? null,
      warnRatio: body.warnRatio,
      currencyCode: body.currencyCode,
      isActive: body.isActive,
    },
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: row });
});

adminAiSpendRoutes.delete('/limits/:id', async (c) => {
  const ctx = getContext(c);
  await deleteSpendLimit(ctx.db, c.req.param('id')!, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: { deleted: true } });
});
