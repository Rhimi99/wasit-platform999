import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { getRevenueProfitability, calculateScenario, listScenarioReports } from './service';
import type { ScenarioInput } from './types';

const scenarioInputSchema = z.object({
  transactionVolume: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount'),
  commissionRate: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid rate'),
  paymentFeeRate: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid rate'),
  expectedOrders: z.string().regex(/^\d+$/, 'Invalid count').optional(),
  avgOrderValue: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount').optional(),
  subscriptionRevenue: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount').optional(),
  advertisingRevenue: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount').optional(),
  aiCosts: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount').optional(),
  operationalExpenses: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid amount').optional(),
  refundRate: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid rate').optional(),
  currencyCode: z.string().length(3).default('TND'),
});

export const revenueRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /api/revenue/report
// Requires REVENUE_READ (staff/admin). Real aggregates only.
// ---------------------------------------------------------------------------
revenueRoutes.get(
  '/report',
  requireAuth,
  requirePermission(PERMISSIONS.REVENUE_READ),
  async (c) => {
    const ctx = getContext(c);
    const report = await getRevenueProfitability(ctx.db);
    await writeAudit(ctx.db, ctx, {
      action: 'REVENUE.REPORT_READ',
      entityType: 'REVENUE',
      entityId: null,
      metadata: { currencyCode: report.currencyCode },
    });
    return c.json({ success: true, data: report });
  },
);

// ---------------------------------------------------------------------------
// POST /api/revenue/scenario
// Requires REVENUE_SIMULATE. Pure calculation — no writes to live data.
// ---------------------------------------------------------------------------
revenueRoutes.post(
  '/scenario',
  requireAuth,
  requirePermission(PERMISSIONS.REVENUE_SIMULATE),
  validateBody(scenarioInputSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<ScenarioInput>(c);
    const result = calculateScenario(body);
    await writeAudit(ctx.db, ctx, {
      action: 'REVENUE.SCENARIO_SIMULATED',
      entityType: 'REVENUE',
      metadata: { outputId: result.outputId, currencyCode: body.currencyCode },
    });
    return c.json({ success: true, data: result });
  },
);

// ---------------------------------------------------------------------------
// GET /api/revenue/scenarios?createdById=...
// Requires REVENUE_READ. Returns saved scenario reports (read-only).
// ---------------------------------------------------------------------------
revenueRoutes.get(
  '/scenarios',
  requireAuth,
  requirePermission(PERMISSIONS.REVENUE_READ),
  async (c) => {
    const ctx = getContext(c);
    const createdById = c.req.query('createdById');
    if (!createdById || createdById !== ctx.user!.id) {
      throw ApiError.forbidden('E_FORBIDDEN: can only list your own scenarios');
    }
    const items = await listScenarioReports(ctx.db, createdById);
    return c.json({ success: true, data: { items } });
  },
);