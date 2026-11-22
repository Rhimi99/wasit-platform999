import { Hono } from 'hono';
import { and, desc, eq, gte, like, notLike, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { env } from '../../lib/env';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { getContext } from '../../lib/request-context';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate';
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
import { buildOperationsSnapshot } from './operations';

/** Supervisor cases live in the same table; they have their own lifecycle. */
const SUPERVISOR_RULE_PREFIX = 'supervisor.';

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
  /** `platform` hides supervisor cases, `supervisor` shows only those. */
  scope: z.enum(['platform', 'supervisor', 'all']).optional(),
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
  if (query.scope === 'platform') conditions.push(notLike(alertEvents.rule, `${SUPERVISOR_RULE_PREFIX}%`));
  if (query.scope === 'supervisor') conditions.push(like(alertEvents.rule, `${SUPERVISOR_RULE_PREFIX}%`));
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

/**
 * OBS-OPS-01 — the GM operational snapshot.
 *
 * One read that answers "is the platform healthy, are the agents working, what
 * needs my decision". Composed entirely from existing sources; it neither
 * writes nor repairs anything. Figures that cannot be trusted are reported as
 * unavailable with a reason (`unavailable[]`).
 */
adminObservabilityRoutes.get('/operations', async (c) => {
  const ctx = getContext(c);
  const snapshot = await buildOperationsSnapshot(ctx.db);
  return c.json({ success: true, data: snapshot });
});

const alertNoteSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
const alertResolveSchema = z.object({ note: z.string().trim().min(3).max(500) }).strict();

/**
 * Loads a platform alert row, refusing supervisor cases: those have their own
 * acknowledgement/resolution endpoints, and mixing the two lifecycles would let
 * one surface silently close a case the other is tracking.
 */
async function loadPlatformAlert(db: ReturnType<typeof getContext>['db'], id: string) {
  const [row] = await db.select().from(alertEvents).where(eq(alertEvents.id, id)).limit(1);
  if (!row) throw ApiError.notFound('Alert');
  if (row.rule.startsWith(SUPERVISOR_RULE_PREFIX)) {
    throw ApiError.conflict('Supervisor escalations are decided on the escalations endpoint');
  }
  return row;
}

/**
 * Acknowledge a firing platform alert.
 *
 * Acknowledgement is a human-attention marker, not a state change: the row stays
 * FIRING until the condition clears, so an acknowledged incident can never be
 * mistaken for a healthy one. Stored in `details.ack` (no migration).
 */
adminObservabilityRoutes.post(
  '/alerts/:id/acknowledge',
  validateBody(alertNoteSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<{ note?: string }>(c);
    const row = await loadPlatformAlert(ctx.db, c.req.param('id')!);
    if (row.status !== 'FIRING') throw ApiError.conflict('Only a FIRING alert can be acknowledged');

    const now = new Date();
    const details = {
      ...((row.details ?? {}) as Record<string, unknown>),
      ack: { by: ctx.user!.id, at: now.toISOString(), note: body.note ?? null },
    };
    const [updated] = await ctx.db
      .update(alertEvents)
      .set({ details })
      .where(eq(alertEvents.id, row.id))
      .returning();

    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      {
        action: 'OBSERVABILITY.ALERT_ACKNOWLEDGED',
        entityType: 'ALERT',
        entityId: row.id,
        after: { rule: row.rule, severity: row.severity, note: body.note ?? null },
      },
    );
    return c.json({ success: true, data: updated });
  },
);

/**
 * Manually close a platform alert row.
 *
 * Refused while the rule is still firing in this process: the engine only
 * resolves a rule when its condition clears, so a manual resolve during an
 * active incident would hide a live problem. This is a cleanup path for rows
 * left open by a restart or a rule that no longer exists — not a mute button.
 */
adminObservabilityRoutes.post(
  '/alerts/:id/resolve',
  validateBody(alertResolveSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<{ note: string }>(c);
    const row = await loadPlatformAlert(ctx.db, c.req.param('id')!);
    if (row.status !== 'FIRING') throw ApiError.conflict('Alert is already resolved');
    if (firingAlerts().some((a) => a.rule === row.rule)) {
      throw ApiError.conflict(
        'The rule is still firing; it resolves itself when the condition clears',
      );
    }

    const now = new Date();
    const details = {
      ...((row.details ?? {}) as Record<string, unknown>),
      resolution: {
        by: ctx.user!.id,
        at: now.toISOString(),
        note: body.note,
        manual: true,
      },
    };
    const [updated] = await ctx.db
      .update(alertEvents)
      .set({ status: 'RESOLVED', resolvedAt: now, details })
      .where(eq(alertEvents.id, row.id))
      .returning();

    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      {
        action: 'OBSERVABILITY.ALERT_RESOLVED_MANUALLY',
        entityType: 'ALERT',
        entityId: row.id,
        after: { rule: row.rule, severity: row.severity, note: body.note },
      },
    );
    return c.json({ success: true, data: updated });
  },
);

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