import { Hono } from 'hono';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { env } from '../../lib/env';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { getContext } from '../../lib/request-context';
import { validateQuery, getValidatedQuery } from '../../middleware/validate';
import { writeAudit } from '../../lib/audit';
import { metrics } from '../../lib/observability/metrics';
import { recentLogs, type LogLevel } from '../../lib/observability/logger';
import {
  evaluateAlerts,
  firingAlerts,
  lastAlertEvaluationAt,
} from '../../lib/observability/alerts';
import { alertStatus } from '../../lib/observability/resolve-notifier';
import { alertEvents } from '../../db/schema/observability';

/**
 * Public Prometheus scrape endpoint. Mounted at `/metrics`, outside `/api`, so
 * a scrape config is a one-liner. When `METRICS_TOKEN` is set the bearer token
 * is required; otherwise the endpoint is meant to be reachable only from the
 * scraping network (documented in DEPLOYMENT.md).
 */
export const metricsRoutes = new Hono();
metricsRoutes.get('/metrics', (c) => {
  if (!env.METRICS_ENABLED) {
    return c.text('metrics disabled', 404 as never);
  }
  if (env.METRICS_TOKEN) {
    const header = c.req.header('authorization') ?? '';
    const expected = `Bearer ${env.METRICS_TOKEN}`;
    // Constant-time-ish comparison is unnecessary here: the token is not a
    // session secret and a timing side channel on a scrape endpoint is noise.
    if (header !== expected) {
      return c.text('unauthorized', 401 as never);
    }
  }
  return c.text(metrics.renderPrometheus(), 200 as never, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  });
});

const logsQuerySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const alertsQuerySchema = z.object({
  status: z.enum(['FIRING', 'RESOLVED']).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * Admin observability surface. All routes require `admin:system`; none of them
 * returns request bodies, credentials, or PII — only counters, timings, alert
 * metadata, and already-redacted log records.
 */
export const adminObservabilityRoutes = new Hono();
adminObservabilityRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.ADMIN_SYSTEM));

adminObservabilityRoutes.get('/metrics', (c) => {
  const ctx = getContext(c);
  return c.json({
    success: true,
    data: {
      metrics: metrics.snapshot(),
      alerts: {
        firing: firingAlerts(),
        lastEvaluatedAt: lastAlertEvaluationAt()?.toISOString() ?? null,
        notifier: alertStatus(),
      },
      db: ctx.db ? 'configured' : 'missing',
    },
  });
});

adminObservabilityRoutes.get('/logs', validateQuery(logsQuerySchema), (c) => {
  const query = getValidatedQuery<z.infer<typeof logsQuerySchema>>(c);
  return c.json({
    success: true,
    data: recentLogs({ level: query.level as LogLevel | undefined, limit: query.limit }),
  });
});

adminObservabilityRoutes.get('/alerts', validateQuery(alertsQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof alertsQuerySchema>>(c);
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(alertEvents.status, query.status));
  if (query.since) conditions.push(gte(alertEvents.createdAt, new Date(query.since)));
  const rows = await ctx.db
    .select()
    .from(alertEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(alertEvents.createdAt))
    .limit(query.limit ?? 50);
  return c.json({
    success: true,
    data: rows,
    meta: { firing: firingAlerts(), lastEvaluatedAt: lastAlertEvaluationAt()?.toISOString() ?? null },
  });
});

/** Runs the rules immediately; the scheduler also does this on an interval. */
adminObservabilityRoutes.post('/alerts/evaluate', async (c) => {
  const ctx = getContext(c);
  const result = await evaluateAlerts(ctx.db);
  await writeAudit(
    ctx.db,
    { actorId: ctx.user?.id ?? null, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'OBSERVABILITY.ALERTS_EVALUATED',
      entityType: 'ALERT',
      after: {
        evaluated: result.evaluated,
        fired: result.fired,
        resolved: result.resolved,
      },
    },
  );
  return c.json({ success: true, data: result });
});