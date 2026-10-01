import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { writeAudit } from '../../lib/audit';
import {
  createDashboardReport,
  getConversionSnapshot,
  getMyAnalyticsOverview,
  getPlatformOverview,
  getRetentionSnapshot,
  getRevenueBreakdown,
  listDashboardReports,
  listDailyKpis,
  recordAnalyticsEvent,
  rollupDailyKpis,
} from '../analytics/service';
import { getUnitEconomics, getCustomerCohorts } from '../analytics/unit-economics';
import { reportingCurrency } from '../../lib/env';
import { parsePositiveIntParam } from '../../lib/query';

const reportSchema = z.object({
  reportCode: z.string().min(2).max(100),
  title: z.string().min(1).max(200),
  reportData: z.record(z.unknown()).optional(),
});

const unitEconomicsQuerySchema = z.object({
  currency: z.string().length(3).optional(),
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  retentionMonths: z.coerce.number().int().min(0).max(120).optional(),
  ordersPerMonth: z.coerce.number().int().min(0).max(1000).optional(),
});

const cohortsQuerySchema = z.object({
  currency: z.string().length(3).optional(),
  months: z.coerce.number().int().min(1).max(36).optional(),
});

/**
 * Currency selector for the money KPIs. Each of these endpoints aggregates in
 * exactly one currency; the caller may name it, otherwise the configured
 * reporting currency is used. There is no "all currencies" option: without an
 * exchange-rate source a combined total would be a fabricated number.
 */
const currencyQuerySchema = z.object({
  currency: z.string().length(3).optional(),
});

function parseCurrencyQuery(raw: Record<string, string | undefined>): string {
  const parsed = currencyQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'query',
        message: i.message,
        code: 'VALIDATION_FAILED',
      })),
    );
  }
  return parsed.data.currency ?? reportingCurrency();
}

export const adminAnalyticsRoutes = new Hono();
adminAnalyticsRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.ADMIN_ANALYTICS));

adminAnalyticsRoutes.get('/overview', async (c) => {
  const ctx = getContext(c);
  const currency = parseCurrencyQuery(c.req.query());
  const data = await getPlatformOverview(ctx.db, currency);
  return c.json({ success: true, data });
});

adminAnalyticsRoutes.get('/retention', async (c) => {
  const ctx = getContext(c);
  const data = await getRetentionSnapshot(ctx.db);
  return c.json({ success: true, data });
});

adminAnalyticsRoutes.get('/conversion', async (c) => {
  const ctx = getContext(c);
  const currency = parseCurrencyQuery(c.req.query());
  const data = await getConversionSnapshot(ctx.db, currency);
  return c.json({ success: true, data });
});

adminAnalyticsRoutes.get('/revenue-breakdown', async (c) => {
  const ctx = getContext(c);
  const currency = parseCurrencyQuery(c.req.query());
  const data = await getRevenueBreakdown(ctx.db, currency);
  return c.json({ success: true, data });
});

// Unit economics — CAC / LTV / contribution margin from real data.
adminAnalyticsRoutes.get('/unit-economics', async (c) => {
  const ctx = getContext(c);
  const parsed = unitEconomicsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'query',
        message: i.message,
        code: 'VALIDATION_FAILED',
      })),
    );
  }
  const q = parsed.data;
  const data = await getUnitEconomics(
    ctx.db,
    q.currency ?? reportingCurrency(),
    q.windowDays ?? 30,
    {
      assumedRetentionMonths: q.retentionMonths ?? 12,
      assumedOrdersPerMonth: q.ordersPerMonth ?? 1,
    },
  );
  await writeAudit(ctx.db, ctx, {
    action: 'ANALYTICS.UNIT_ECONOMICS_READ',
    entityType: 'ANALYTICS',
    metadata: { currencyCode: data.currencyCode, windowDays: data.windowDays },
  });
  return c.json({ success: true, data });
});

// Acquisition cohorts — monthly first-order cohorts with realized GMV/margin.
adminAnalyticsRoutes.get('/cohorts', async (c) => {
  const ctx = getContext(c);
  const parsed = cohortsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'query',
        message: i.message,
        code: 'VALIDATION_FAILED',
      })),
    );
  }
  const q = parsed.data;
  const items = await getCustomerCohorts(ctx.db, q.currency ?? reportingCurrency(), q.months ?? 6);
  return c.json({ success: true, data: { items } });
});

adminAnalyticsRoutes.get('/daily-kpis', async (c) => {
  const ctx = getContext(c);
  const days = parsePositiveIntParam(c.req.query('days'));
  const data = await listDailyKpis(ctx.db, days ?? 14);
  return c.json({ success: true, data: { items: data } });
});

// Compute today's rollup into daily_kpis from real data, then list recent.
adminAnalyticsRoutes.post('/daily-kpis/rollup', async (c) => {
  const ctx = getContext(c);
  const currency = parseCurrencyQuery(c.req.query());
  const inserted = await rollupDailyKpis(ctx.db, currency);
  const items = await listDailyKpis(ctx.db, 14);
  await writeAudit(ctx.db, ctx, {
    action: 'ANALYTICS.KPI_ROLLUP',
    entityType: 'DAILY_KPI',
    metadata: { inserted, currencyCode: currency },
  });
  return c.json({ success: true, data: { inserted, items } });
});

// Admin capture (e.g. for an admin-owned event stream).
const adminCaptureSchema = z.object({
  eventName: z.string().min(1).max(100),
  properties: z.record(z.unknown()).optional(),
});
adminAnalyticsRoutes.post('/events', requirePermission(PERMISSIONS.ADMIN_ANALYTICS), validateBody(adminCaptureSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<{ eventName: string; properties?: Record<string, unknown> }>(c);
  const result = await recordAnalyticsEvent(
    ctx.db,
    ctx.user?.id ?? null,
    null,
    { eventName: body.eventName, properties: body.properties },
    ctx.ipAddress ? Buffer.from(ctx.ipAddress).toString('base64').slice(0, 64) : null,
  );
  await writeAudit(ctx.db, ctx, {
    action: 'ANALYTICS.EVENT_CAPTURED',
    entityType: 'ANALYTICS_EVENT',
    entityId: result.id,
  });
  return c.json({ success: true, data: result }, 201);
});

adminAnalyticsRoutes.get('/reports', async (c) => {
  const ctx = getContext(c);
  const data = await listDashboardReports(ctx.db);
  return c.json({ success: true, data: { items: data } });
});

adminAnalyticsRoutes.post('/reports', validateBody(reportSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<{ reportCode: string; title: string; reportData?: Record<string, unknown> }>(c);
  const result = await createDashboardReport(ctx.db, ctx.user!.id, {
    reportCode: body.reportCode,
    title: body.title,
    reportData: body.reportData,
  });
  await writeAudit(ctx.db, ctx, {
    action: 'ANALYTICS.REPORT_CREATE',
    entityType: 'DASHBOARD_REPORT',
    entityId: result.id,
    metadata: { reportCode: body.reportCode },
  });
  return c.json({ success: true, data: result }, 201);
});

// Entity-scoped helper for admins inspecting any user's own analytics.
adminAnalyticsRoutes.get('/users/:userId/overview', async (c) => {
  const ctx = getContext(c);
  const userId = c.req.param('userId');
  if (!userId) throw ApiError.validation([{ field: 'userId', message: 'userId is required', code: 'VALIDATION_FAILED' }]);
  const currency = parseCurrencyQuery(c.req.query());
  const data = await getMyAnalyticsOverview(ctx.db, userId, currency);
  return c.json({ success: true, data });
});