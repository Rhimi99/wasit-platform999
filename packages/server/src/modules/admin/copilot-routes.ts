import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { agentTasks } from '../../db/schema/agents.js';
import {
  agentTaskSummary,
  createAgentTask,
  decideAgentTask,
  getRegistryAgent,
  getTask,
  listRegistryAgents,
  resolveUserRoles,
  runApprovedTask,
  setAgentStatus,
} from '../ai/runner.js';
import {
  copilotRunDetail,
  copilotSpec,
  listCopilotActivity,
  pendingApprovalsCount,
  planRouteEvents,
  routeEvents,
} from '../ai/copilot.js';

/**
 * Admin Copilot desk — the operational control centre for SUPER_ADMIN.
 *
 * This module adds *no* new execution machinery. Every route wraps the same
 * runner/copilot services the platform already uses, so the kill switch, the
 * per-agent RBAC, the human-approval gate, the per-run cost cap and the
 * `AI.*` audit trail are identical to every other path. The desk is a
 * SUPER_ADMIN-only *view + trigger* over those services, not a second engine.
 *
 * Access control:
 *   - `requireRole('SUPER_ADMIN')` guards every route. Hiding UI is not the
 *     control; the server is. ADMIN does not gain access here (its existing
 *     `/api/admin/ai` surface is untouched).
 *   - A `taskId`/`agentKey`/`correlationId` from the client is only ever an
 *     identifier to look up — the server re-resolves the record and re-checks
 *     the caller's roles before acting, never trusting the id as authority.
 */

const TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'awaiting_approval',
  'approved',
  'rejected',
  'blocked',
] as const;

const previewSchema = z.object({
  events: z.array(z.string().min(1).max(64)).min(1).max(20),
});

const routeSchema = z.object({
  events: z
    .array(z.object({ event: z.string().min(1).max(64), payload: z.record(z.unknown()).optional() }))
    .min(1)
    .max(20),
});

const createTaskSchema = z.object({
  input: z.record(z.unknown()).default({}),
  taskType: z.string().max(64).optional(),
  requestedModel: z.string().max(100).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});

const decideSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(1000).optional().nullable(),
});

const agentStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']),
  reason: z.string().max(500).optional().nullable(),
});

const tasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  agentKey: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const auditQuerySchema = z.object({
  action: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const adminCopilotRoutes = new Hono();

// SUPER_ADMIN only. Not AI_MANAGE (which ADMIN also holds) — the Copilot desk is
// deliberately the highest-privilege surface and is never reachable by ADMIN.
adminCopilotRoutes.use('*', requireAuth, requireRole('SUPER_ADMIN'));

/** The coordinator spec, so the desk can render the Copilot row. */
adminCopilotRoutes.get('/', async (c) => {
  return c.json({ success: true, data: copilotSpec() });
});

// ----- Routing preview -------------------------------------------------------

/**
 * Dry-run of a routing request: what each event *would* delegate to, whether
 * that agent is runnable, and whether the delegation would be gated behind a
 * human approval. Writes nothing and creates no task — the operator confirms
 * afterwards through `POST /route`.
 */
adminCopilotRoutes.post('/route/preview', validateBody(previewSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof previewSchema>>(c);
  const roles = await resolveUserRoles(ctx.db, ctx.user!.id);
  const preview = await planRouteEvents(ctx.db, body.events, roles);
  return c.json({
    success: true,
    data: {
      preview,
      routable: preview.filter((p) => p.runnable).length,
      gated: preview.filter((p) => p.runnable && p.requiresApproval).length,
    },
  });
});

/** Confirms a previewed routing request: delegates the events (creates tasks). */
adminCopilotRoutes.post('/route', validateBody(routeSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof routeSchema>>(c);
  const roles = await resolveUserRoles(ctx.db, ctx.user!.id);
  const result = await routeEvents(ctx.db, body.events, ctx.user!.id, roles, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result }, 201);
});

/** A single run (correlation) with its aggregated cost. */
adminCopilotRoutes.get('/runs/:correlationId', async (c) => {
  const ctx = getContext(c);
  const correlationId = c.req.param('correlationId')!;
  const detail = await copilotRunDetail(ctx.db, correlationId);
  return c.json({ success: true, data: detail });
});

// ----- Agents ----------------------------------------------------------------

adminCopilotRoutes.get('/agents', async (c) => {
  const ctx = getContext(c);
  const rows = await listRegistryAgents(ctx.db);
  return c.json({ success: true, data: { items: rows } });
});

adminCopilotRoutes.get('/agents/summary', async (c) => {
  const ctx = getContext(c);
  const [summary, pending] = await Promise.all([
    agentTaskSummary(ctx.db),
    pendingApprovalsCount(ctx.db),
  ]);
  return c.json({ success: true, data: { ...summary, pendingApprovals: pending } });
});

/** Kill switch. Audited by `setAgentStatus`; the change is re-read from the DB. */
adminCopilotRoutes.post('/agents/:agentKey/status', validateBody(agentStatusSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof agentStatusSchema>>(c);
  const agentKey = c.req.param('agentKey')!;
  await setAgentStatus(ctx.db, agentKey, body.status, body.reason ?? null, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  const updated = await getRegistryAgent(ctx.db, agentKey);
  return c.json({ success: true, data: updated });
});

/**
 * Creates one agent task directly (not via an event). The agent key is resolved
 * through the catalogue inside `createAgentTask`, which also re-checks the
 * caller's permissions, the agent's scope, the task-type allow-list and the
 * approval gate — so a client-supplied `agentKey` is never trusted as authority.
 */
adminCopilotRoutes.post('/agents/:agentKey/tasks', validateBody(createTaskSchema), async (c) => {
  const ctx = getContext(c);
  const agentKey = c.req.param('agentKey')!;
  const body = getValidatedBody<z.infer<typeof createTaskSchema>>(c);
  const roles = await resolveUserRoles(ctx.db, ctx.user!.id);
  const result = await createAgentTask(
    ctx.db,
    roles,
    ctx.user!.id,
    {
      agentKey,
      requestedBy: ctx.user!.id,
      taskType: body.taskType,
      input: body.input,
      requestedModel: body.requestedModel,
      priority: body.priority,
    },
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: result }, 201);
});

// ----- Tasks -----------------------------------------------------------------

adminCopilotRoutes.get('/tasks', async (c) => {
  const ctx = getContext(c);
  const qs = tasksQuerySchema.safeParse(c.req.query());
  const query = qs.success ? qs.data : { limit: 50 };
  const conditions = [];
  if (query.status) conditions.push(eq(agentTasks.status, query.status));
  if (query.agentKey) conditions.push(eq(agentTasks.agentKey, query.agentKey));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await ctx.db
    .select()
    .from(agentTasks)
    .where(where)
    .orderBy(desc(agentTasks.createdAt))
    .limit(query.limit ?? 50);
  return c.json({ success: true, data: { items: rows } });
});

adminCopilotRoutes.get('/tasks/:taskId', async (c) => {
  const ctx = getContext(c);
  const task = await getTask(ctx.db, c.req.param('taskId')!);
  return c.json({ success: true, data: task });
});

/**
 * Records the approval decision only. Deliberately does NOT execute the task:
 * `approve` and `run` are separate operations, so approving can never be a
 * silent side effect that starts work. The task must be `awaiting_approval`;
 * `decideAgentTask` enforces that server-side.
 */
adminCopilotRoutes.post('/tasks/:taskId/approve', validateBody(decideSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof decideSchema>>(c);
  const result = await decideAgentTask(
    ctx.db,
    c.req.param('taskId')!,
    ctx.user!.id,
    body.decision,
    body.reason ?? null,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: result });
});

adminCopilotRoutes.post('/tasks/:taskId/reject', validateBody(decideSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof decideSchema>>(c);
  const result = await decideAgentTask(
    ctx.db,
    c.req.param('taskId')!,
    ctx.user!.id,
    body.decision,
    body.reason ?? null,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: result });
});

/**
 * Executes one already-approved task. `runApprovedTask` refuses anything not in
 * `approved` state (a task still `awaiting_approval` is a 409), and its
 * single-flight claim makes a concurrent/repeated run a 409 rather than a double
 * execution. Execution reuses the one runner, so every guard applies.
 */
adminCopilotRoutes.post('/tasks/:taskId/run', async (c) => {
  const ctx = getContext(c);
  const result = await runApprovedTask(ctx.db, c.req.param('taskId')!, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

// ----- Audit trail -----------------------------------------------------------

/** `AI.*` audit entries (Copilot/agent activity), newest first. */
adminCopilotRoutes.get('/audit', async (c) => {
  const ctx = getContext(c);
  const qs = auditQuerySchema.safeParse(c.req.query());
  const query = qs.success ? qs.data : { limit: 50 };
  const items = await listCopilotActivity(ctx.db, { action: query.action, limit: query.limit });
  return c.json({ success: true, data: { items } });
});
