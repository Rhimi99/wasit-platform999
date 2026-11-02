import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { deriveScope, derivePlatformScope, userHasPlatformScope, type AgentScopeCtx } from '../ai/scope.js';
import { agentPerformance, teamHealth, recentActivity } from '../ai/agent-monitor.js';
import { listMemoryPage, taskBelongsToOwner, MAX_MEMORY_LIMIT, DEFAULT_MEMORY_LIMIT } from '../ai/memory-repo.js';
import { toMemoryView } from '../ai/memory-service.js';

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

/**
 * G7 — the operational-memory read query.
 *
 * All three filters are optional and validated: `agentKey` is a bounded token,
 * `taskId` must be a UUID, and `limit`/`offset` are bounded integers. Nothing
 * here selects a *scope* — the scope is always the authenticated caller's own
 * (resolved server-side in `callerScope`), so a filter can only narrow the
 * caller's own rows, never widen them to another owner's.
 */
const memoryQuerySchema = z.object({
  agentKey: z.string().min(1).max(64).optional(),
  taskId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(MAX_MEMORY_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(100_000).optional(),
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

/**
 * G7 — the caller's operational memory, read-only.
 *
 * Scope is **always** the authenticated caller's own owner (`scope.owner`), never
 * a request parameter: a filter can narrow the caller's own notes but can never
 * widen to another owner's, and platform scope deliberately grants no extra
 * memory visibility (see `scope.ts`). A `taskId` that does not name a task owned
 * by the caller is refused with 404, so the endpoint never confirms the existence
 * of another owner's task. The response carries only the allow-listed projection
 * from `toMemoryView` — no raw content, no secrets, no internal columns.
 */
agentMonitorRoutes.get('/memory', async (c) => {
  const ctx = getContext(c);
  const q = memoryQuerySchema.parse({
    agentKey: c.req.query('agentKey'),
    taskId: c.req.query('taskId'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  const scope = await callerScope(c);

  // The scope owner is the identity whose notes are visible — it is derived from
  // the session, never from the query. A task filter is only honoured when the
  // named task belongs to that same owner.
  if (q.taskId && !(await taskBelongsToOwner(ctx.db, scope.owner, q.taskId))) {
    throw ApiError.notFound('Task');
  }

  const page = await listMemoryPage(ctx.db, scope, {
    agentKey: q.agentKey,
    taskId: q.taskId,
    limit: q.limit ?? DEFAULT_MEMORY_LIMIT,
    offset: q.offset ?? 0,
  });

  return c.json({
    success: true,
    data: {
      items: page.items.map(toMemoryView),
      total: page.total,
      limit: q.limit ?? DEFAULT_MEMORY_LIMIT,
      offset: q.offset ?? 0,
    },
  });
});
