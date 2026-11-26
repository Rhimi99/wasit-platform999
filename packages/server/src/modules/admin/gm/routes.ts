import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../../lib/request-context.js';
import { getValidatedQuery, validateQuery } from '../../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../../middleware/auth.js';
import { buildGmOverview, listGmAudit, listGmTasks } from './service.js';

/**
 * The GM command center API (WASIT-GM-DASHBOARD-01).
 *
 * Read-only by construction: there is no POST/PUT/PATCH/DELETE here. Every
 * operator action the dashboard offers (kill switch, cancel a run, decide an
 * approval, advance the Copilot) goes to the endpoint that already owns it, so
 * this surface adds visibility and no authority.
 *
 * The gate is the one the AI oversight desk already uses (`ai:manage` or
 * `admin:ai`), which is exactly what ADMIN and SUPER_ADMIN hold. No new
 * permission and no new role were introduced: "GM" is a person using an
 * administrative account, and the server still decides what that account may do.
 */

const daysSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .refine((value) => value >= 1 && value <= 90, 'days must be between 1 and 90');

const overviewQuerySchema = z.object({
  days: daysSchema.optional(),
});

const tasksQuerySchema = z.object({
  status: z.string().max(40).optional(),
  agentKey: z.string().max(64).optional(),
  kind: z.enum(['agent_task', 'copilot_run']).optional(),
  severity: z.enum(['high', 'medium', 'low']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const auditQuerySchema = z.object({
  action: z
    .string()
    .max(120)
    .regex(/^[A-Za-z0-9._:-]*$/, 'action must be a prefix, not a pattern')
    .optional(),
  entityType: z.string().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const gmRoutes = new Hono();

gmRoutes.use('*', requireAuth);
gmRoutes.use('*', requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

gmRoutes.get('/overview', validateQuery(overviewQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof overviewQuerySchema>>(c);
  const data = await buildGmOverview(
    ctx.db,
    { id: ctx.user!.id, roles: ctx.user!.roles as string[] },
    query.days ?? 30,
  );
  return c.json({ success: true, data });
});

gmRoutes.get('/tasks', validateQuery(tasksQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof tasksQuerySchema>>(c);
  const data = await listGmTasks(ctx.db, {
    status: query.status,
    agentKey: query.agentKey,
    kind: query.kind,
    severity: query.severity,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    page: query.page,
    pageSize: query.pageSize,
  });
  return c.json({ success: true, data });
});

gmRoutes.get('/audit', validateQuery(auditQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof auditQuerySchema>>(c);
  const data = await listGmAudit(ctx.db, {
    action: query.action || undefined,
    entityType: query.entityType || undefined,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    page: query.page,
    pageSize: query.pageSize,
  });
  return c.json({ success: true, data });
});
