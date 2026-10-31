import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { deriveScope, derivePlatformScope, userHasPlatformScope, type AgentScopeCtx } from '../ai/scope.js';
import { agentPerformance, teamHealth, recentActivity } from '../ai/agent-monitor.js';

/**
 * Agent operations & monitoring desk (AI-06.0) — the unified health view for the
 * General Manager.
 *
 * Read-only. Every route delegates to `agent-monitor.ts`, which derives its
 * numbers from real operational records (`agent_metrics`, `agent_tasks`,
 * `ai_requests`, `audit_logs`). Nothing here writes or mutates a task.
 *
 * Scope: the caller's platform scope is confirmed **server-side** against the
 * database (`userHasPlatformScope`), never taken from the request. An admin
 * (`ADMIN`/`SUPER_ADMIN`) sees the platform-wide picture; any other holder of the
 * governance permission sees only their own rows — no row from another owner is
 * ever returned, only aggregates.
 *
 * Access control mirrors the AI governance desk: `requireAuth` +
 * `requirePermission(AI_MANAGE, ADMIN_AI)`. A caller without either is refused
 * before any query runs.
 */

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  overdueSeconds: z.coerce.number().int().positive().max(86_400).optional(),
});

export const agentMonitorRoutes = new Hono();

agentMonitorRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

/** Resolves the caller's scope, confirming platform rights against the database. */
async function callerScope(c: Parameters<typeof getContext>[0]): Promise<AgentScopeCtx> {
  const ctx = getContext(c);
  const userId = ctx.user!.id;
  const isPlatform = await userHasPlatformScope(ctx.db, userId);
  // Platform scope is granted only after the database confirms an admin role;
  // `derivePlatformScope` re-checks the session roles as a second gate. Everyone
  // else gets owner-only scope, which can never widen to another owner's rows.
  return isPlatform
    ? derivePlatformScope({ userId }, { roles: ctx.user!.roles })
    : deriveScope({ userId });
}

/** Per-agent performance for the caller's scope. */
agentMonitorRoutes.get('/performance', async (c) => {
  const ctx = getContext(c);
  const q = querySchema.parse({
    limit: c.req.query('limit'),
    overdueSeconds: c.req.query('overdueSeconds'),
  });
  const scope = await callerScope(c);
  const items = await agentPerformance(ctx.db, scope, { overdueSeconds: q.overdueSeconds });
  return c.json({ success: true, data: { scope: scope.isPlatform ? 'platform' : 'owner', items } });
});

/** The unified team-health picture with alerts and attention items. */
agentMonitorRoutes.get('/health', async (c) => {
  const ctx = getContext(c);
  const q = querySchema.parse({ overdueSeconds: c.req.query('overdueSeconds') });
  const scope = await callerScope(c);
  const data = await teamHealth(ctx.db, scope, { overdueSeconds: q.overdueSeconds });
  return c.json({ success: true, data });
});

/** The most recent significant agent activity. */
agentMonitorRoutes.get('/activity', async (c) => {
  const ctx = getContext(c);
  const q = querySchema.parse({ limit: c.req.query('limit') });
  const scope = await callerScope(c);
  const items = await recentActivity(ctx.db, scope, q.limit);
  return c.json({ success: true, data: { items } });
});
