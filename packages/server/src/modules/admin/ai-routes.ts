import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, PERMISSIONS, type UserRole } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { newId } from '../../lib/ids.js';
import { aiBudgets, aiModels, aiRequests } from '../../db/schema/ai.js';
import { agentTasks } from '../../db/schema/agents.js';
import { adminUsageSummary } from '../ai/service.js';
import { agentLayerSummary, copilotAgent, listAgents } from '../ai/agents.js';
import {
  dispatchStep,
  approveRunStep,
  cancelRun,
  recoverRun,
  getRunWithSteps,
} from '../ai/dispatcher.js';
import {
  createAgentSchedule,
  updateAgentSchedule,
  deleteAgentSchedule,
  listAgentSchedules,
  getAgentSchedule,
  MIN_SCHEDULE_INTERVAL_MINUTES,
} from '../ai/scheduling.js';
import { buildSupervisorOverview, containRunManually } from '../ai/supervisor.js';
import { buildCompanyMetricsForAdmin } from '../ai/agent-metrics.js';
import {
  buildMetricsReport,
  buildSeries,
  metricsCoverage,
  backfillAgentMetrics,
  auditBackfill,
} from '../ai/metrics.js';
import {
  acknowledgeEscalation,
  deliverEscalationToGm,
  getEscalation,
  lastScanAt,
  listEscalations,
  resolveEscalation,
  scanEscalations,
} from '../ai/escalations.js';
import {
  memorySummaryForAdmin,
  listMemoryMetadataForAdmin,
  inspectMemoryForAdmin,
  purgeExpiredMemories,
} from '../ai/memory.js';
import { derivePlatformScope } from '../ai/scope.js';
import {
  getAiExecutionSwitchState,
  setAiExecutionEnabled,
} from '../../lib/ai/kill-switch.js';

const budgetSchema = z
  .object({
    userId: z.string().max(36).optional().nullable(),
    roleTarget: z.string().max(50).optional().nullable(),
    period: z.enum(['DAILY', 'MONTHLY']).default('MONTHLY'),
    maxRequests: z.number().int().positive().optional().nullable(),
    maxTokensInput: z.number().int().positive().optional().nullable(),
    maxTokensOutput: z.number().int().positive().optional().nullable(),
    maxCost: z.string().regex(/^\d+(\.\d{1,10})?$/).optional().nullable(),
    currencyCode: z.string().length(3).default('USD'),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.userId || v.roleTarget, { message: 'Provide either userId or roleTarget' })
  .refine(
    (v) => !v.userId || !v.roleTarget,
    { message: 'Provide exactly one of userId or roleTarget' },
  );

const modelSchema = z.object({
  key: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  contextWindow: z.number().int().nonnegative().default(0),
  maxOutputTokens: z.number().int().nonnegative().default(0),
  inputPer1k: z.string().regex(/^\d+(\.\d{1,10})?$/).default('0'),
  outputPer1k: z.string().regex(/^\d+(\.\d{1,10})?$/).default('0'),
  currencyCode: z.string().length(3).default('USD'),
  isActive: z.boolean().default(true),
});

const taskStatusQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'awaiting_approval', 'approved', 'rejected']).optional(),
  agentKey: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const scheduleCreateSchema = z.object({
  agentKey: z.string().min(1).max(64),
  input: z.record(z.unknown()).default({}),
  intervalMinutes: z.number().int().min(MIN_SCHEDULE_INTERVAL_MINUTES),
  isActive: z.boolean().default(true),
});

const scheduleUpdateSchema = z
  .object({
    intervalMinutes: z.number().int().min(MIN_SCHEDULE_INTERVAL_MINUTES).optional(),
    isActive: z.boolean().optional(),
    input: z.record(z.unknown()).optional(),
  })
  .refine((v) => v.intervalMinutes !== undefined || v.isActive !== undefined || v.input !== undefined, {
    message: 'Provide at least one of intervalMinutes, isActive, input',
  });

const containSchema = z.object({
  reason: z.string().min(1).max(300),
});

export const adminAiRoutes = new Hono();

adminAiRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

// ----- Usage / overview ----------------------------------------------------
adminAiRoutes.get('/usage', async (c) => {
  const ctx = getContext(c);
  const summary = await adminUsageSummary(ctx.db);
  return c.json({ success: true, data: summary });
});

// ----- AI Company metrics (A3) ---------------------------------------------
// Agent execution / performance / cost / outcome metrics for the GM. Read-only:
// derived entirely from durable rows (agent_tasks, ai_requests, agent_run_steps,
// audit_logs). The platform scope is derived SERVER-SIDE from the authenticated
// identity — never from request input — so cross-owner aggregation is granted
// only to an admin, and a non-admin is refused by `derivePlatformScope`.
const companyMetricsQuerySchema = z.object({
  agentKey: z.string().max(64).optional(),
  since: z.string().datetime().optional(),
});

adminAiRoutes.get('/company-metrics', async (c) => {
  const ctx = getContext(c);
  const qs = companyMetricsQuerySchema.safeParse(c.req.query());
  const query = qs.success ? qs.data : {};
  const scope = derivePlatformScope(
    { userId: ctx.user!.id },
    { roles: ctx.user!.roles as UserRole[] },
  );
  const data = await buildCompanyMetricsForAdmin(ctx.db, scope, {
    agentKey: query.agentKey,
    since: query.since ? new Date(query.since) : undefined,
  });
  return c.json({ success: true, data });
});

adminAiRoutes.get('/requests', async (c) => {
  const ctx = getContext(c);
  const limit = Number(c.req.query('limit') ?? 50);
  const safeLimit = Number.isFinite(limit) && limit > 0 && limit <= 200 ? limit : 50;
  const rows = await ctx.db
    .select()
    .from(aiRequests)
    .orderBy(desc(aiRequests.createdAt))
    .limit(safeLimit);
  return c.json({ success: true, data: { items: rows } });
});

adminAiRoutes.get('/requests/totals', async (c) => {
  const ctx = getContext(c);
  // Latest usage aggregate already available via /usage; keep this endpoint
  // for per-user views later. Return nothing but a stable shape.
  return c.json({ success: true, data: { items: [] } });
});

// ----- Budgets -------------------------------------------------------------
adminAiRoutes.get('/budgets', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db.select().from(aiBudgets).orderBy(desc(aiBudgets.updatedAt));
  return c.json({ success: true, data: { items: rows } });
});

adminAiRoutes.post('/budgets', validateBody(budgetSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof budgetSchema>>(c);

  // Upsert: a budget is unique per (target, period). Matching on the target
  // alone would silently collapse a DAILY and a MONTHLY budget onto one row,
  // while enforcement (resolveLimit) resolves them by period independently.
  const targetMatch = body.userId
    ? eq(aiBudgets.userId, body.userId)
    : eq(aiBudgets.roleTarget ?? '___', body.roleTarget ?? '___');
  const existing = await ctx.db
    .select({ id: aiBudgets.id })
    .from(aiBudgets)
    .where(and(targetMatch, eq(aiBudgets.period, body.period)))
    .limit(1);

  const values = {
    userId: body.userId ?? null,
    roleTarget: body.roleTarget ?? null,
    period: body.period,
    maxRequests: body.maxRequests ?? null,
    maxTokensInput: body.maxTokensInput ?? null,
    maxTokensOutput: body.maxTokensOutput ?? null,
    maxCost: body.maxCost ?? null,
    currencyCode: body.currencyCode,
    isActive: body.isActive,
    updatedAt: new Date(),
  };

  let id: string;
  if (existing.length > 0) {
    id = existing[0].id;
    await ctx.db.update(aiBudgets).set(values).where(eq(aiBudgets.id, id));
  } else {
    id = newId();
    await ctx.db.insert(aiBudgets).values({ id, ...values });
  }

  await writeAudit(ctx.db, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }, {
    action: 'AI.BUDGET_UPSERTED',
    entityType: 'AI_BUDGET',
    entityId: id,
    after: values as never,
  });

  const saved = await ctx.db.select().from(aiBudgets).where(eq(aiBudgets.id, id)).limit(1);
  return c.json({ success: true, data: saved[0] }, existing.length > 0 ? 200 : 201);
});

// ----- Model catalogue -----------------------------------------------------
adminAiRoutes.get('/models', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db.select().from(aiModels).orderBy(desc(aiModels.updatedAt));
  return c.json({ success: true, data: { items: rows } });
});

adminAiRoutes.post('/models', validateBody(modelSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof modelSchema>>(c);
  const existing = await ctx.db.select({ id: aiModels.id }).from(aiModels).where(eq(aiModels.key, body.key)).limit(1);

  const values = {
    key: body.key,
    displayName: body.displayName,
    provider: body.provider,
    contextWindow: body.contextWindow,
    maxOutputTokens: body.maxOutputTokens,
    inputPer1k: body.inputPer1k,
    outputPer1k: body.outputPer1k,
    currencyCode: body.currencyCode,
    isActive: body.isActive,
    updatedAt: new Date(),
  };

  let id: string;
  if (existing.length > 0) {
    id = existing[0].id;
    await ctx.db.update(aiModels).set(values).where(eq(aiModels.id, id));
  } else {
    id = newId();
    await ctx.db.insert(aiModels).values({ id, ...values });
  }

  await writeAudit(ctx.db, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }, {
    action: 'AI.MODEL_UPSERTED',
    entityType: 'AI_MODEL',
    entityId: id,
    after: values as never,
  });

  const saved = await ctx.db.select().from(aiModels).where(eq(aiModels.id, id)).limit(1);
  return c.json({ success: true, data: saved[0] }, existing.length > 0 ? 200 : 201);
});

// ----- Agents & tasks (admin oversight) ------------------------------------
adminAiRoutes.get('/agents', async (c) => {
  const ctx = getContext(c);
  // AI-REG-01: the oversight desk sees the whole layer — identity from the
  // reference catalogue, lifecycle from the registry — so an operator can tell
  // an executable agent from one that is declared only.
  const items = await listAgents(ctx.db);
  return c.json({
    success: true,
    data: { items, counts: agentLayerSummary(), copilot: copilotAgent() },
  });
});

adminAiRoutes.get('/tasks', async (c) => {
  const ctx = getContext(c);
  const qs = taskStatusQuerySchema.safeParse(c.req.query());
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

// ----- Agent schedules (AI-01) ---------------------------------------------
// Creating a schedule is a governance action: it authorises the platform to run
// an agent automatically. The whole router is already gated by AI_MANAGE or
// ADMIN_AI (see `.use('*', …)` above), and the service re-checks the agent is
// schedulable (registered, active, not approval-gated) and that the creator's
// role covers the agent's permissions.
adminAiRoutes.get('/agent-schedules', async (c) => {
  const ctx = getContext(c);
  const items = await listAgentSchedules(ctx.db);
  return c.json({ success: true, data: { items, minIntervalMinutes: MIN_SCHEDULE_INTERVAL_MINUTES } });
});

adminAiRoutes.post('/agent-schedules', validateBody(scheduleCreateSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof scheduleCreateSchema>>(c);
  const created = await createAgentSchedule(
    ctx.db,
    ctx.user!.id,
    { agentKey: body.agentKey, input: body.input, intervalMinutes: body.intervalMinutes, isActive: body.isActive },
    { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: created }, 201);
});

adminAiRoutes.get('/agent-schedules/:id', async (c) => {
  const ctx = getContext(c);
  const row = await getAgentSchedule(ctx.db, c.req.param('id')!);
  if (!row) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent schedule' } }, 404);
  return c.json({ success: true, data: row });
});

adminAiRoutes.patch('/agent-schedules/:id', validateBody(scheduleUpdateSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof scheduleUpdateSchema>>(c);
  const updated = await updateAgentSchedule(
    ctx.db,
    c.req.param('id')!,
    ctx.user!.id,
    { intervalMinutes: body.intervalMinutes, isActive: body.isActive, input: body.input },
    { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: updated });
});

adminAiRoutes.delete('/agent-schedules/:id', async (c) => {
  const ctx = getContext(c);
  await deleteAgentSchedule(ctx.db, c.req.param('id')!, ctx.user!.id, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: { id: c.req.param('id')!, deleted: true } });
});

// ----- Agent runs (AI-02.3.1) ----------------------------------------------
// The operational surface for the run layer: inspect a run, dispatch one ready
// step, record a human approval, cancel, and reconcile. Every action goes
// through the same services the tests exercise; no executor or parallel task
// path is introduced here.
const runStepParam = (c: { req: { param: (k: string) => string | undefined } }): { runId: string; stepKey: string } => ({
  runId: c.req.param('runId')!,
  stepKey: c.req.param('stepKey')!,
});

adminAiRoutes.get('/agent-runs/:runId', async (c) => {
  const ctx = getContext(c);
  const data = await getRunWithSteps(ctx.db, c.req.param('runId')!);
  return c.json({ success: true, data });
});

adminAiRoutes.post('/agent-runs/:runId/steps/:stepKey/dispatch', async (c) => {
  const ctx = getContext(c);
  const { runId, stepKey } = runStepParam(c);
  const result = await dispatchStep(ctx.db, runId, stepKey, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

adminAiRoutes.post('/agent-runs/:runId/steps/:stepKey/approve', async (c) => {
  const ctx = getContext(c);
  const { runId, stepKey } = runStepParam(c);
  const result = await approveRunStep(ctx.db, runId, stepKey, ctx.user!.id, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

adminAiRoutes.post('/agent-runs/:runId/cancel', async (c) => {
  const ctx = getContext(c);
  const status = await cancelRun(ctx.db, c.req.param('runId')!, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: { runId: c.req.param('runId')!, status } });
});

adminAiRoutes.post('/agent-runs/:runId/recover', async (c) => {
  const ctx = getContext(c);
  const status = await recoverRun(ctx.db, c.req.param('runId')!, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: { runId: c.req.param('runId')!, status } });
});

// ----- Supervisor (AI-02.S1) -----------------------------------------------
// Read-only operational overview plus a single, explicit manual containment
// action. The router is already gated by AI_MANAGE | ADMIN_AI (see `.use('*')`),
// so no new permission is introduced. Containment only ever walks a run to
// FAILED through the state machine — it never completes one.
adminAiRoutes.get('/supervisor/overview', async (c) => {
  const ctx = getContext(c);
  const data = await buildSupervisorOverview(ctx.db);
  return c.json({ success: true, data });
});

adminAiRoutes.post('/supervisor/runs/:runId/contain', validateBody(containSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof containSchema>>(c);
  const result = await containRunManually(ctx.db, c.req.param('runId')!, body.reason, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

// ----- Central AI Kill Switch (A1) -----------------------------------------
// ONE central control for AI execution. The router is already gated by
// AI_MANAGE | ADMIN_AI (see `.use('*')`), so no new permission is introduced and
// an unprivileged user (e.g. CUSTOMER) is refused before reaching the handler.
// The switch is an emergency *subsystem* stop, not a permission: it grants no
// authority and RBAC/approvals/budgets/audit all still apply on top of it.
const killSwitchSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(300).optional().nullable(),
});

adminAiRoutes.get('/kill-switch', async (c) => {
  const state = getAiExecutionSwitchState();
  return c.json({ success: true, data: state });
});

adminAiRoutes.post('/kill-switch', validateBody(killSwitchSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof killSwitchSchema>>(c);
  const before = getAiExecutionSwitchState();
  setAiExecutionEnabled(body.enabled);
  const after = getAiExecutionSwitchState();
  await writeAudit(
    ctx.db,
    {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    },
    {
      action: body.enabled ? 'AI.KILL_SWITCH_ENABLED' : 'AI.KILL_SWITCH_DISABLED',
      entityType: 'AI_KILL_SWITCH',
      entityId: null,
      before: { enabled: before.enabled, source: before.source },
      after: { enabled: after.enabled, source: after.source },
      // A reason is free text supplied by the operator; never a secret. Kept
      // short and optional so the audit stays a decision record, not a log dump.
      metadata: { reason: body.reason ?? null },
    },
  );
  return c.json({ success: true, data: after });
});

// ----- Agent memory supervision (AI-MEM-01) -------------------------------
// A supervisor gets an accountable interface, not a master key: aggregates and
// metadata by default, one note's content only with a stated reason, and every
// call audited. There is no bulk content export and no cross-owner write.

const memoryTypeEnum = z.enum(['operational', 'contextual', 'procedural', 'task_result']);

const memoryListSchema = z
  .object({
    ownerId: z.string().max(36).optional(),
    agentKey: z.string().max(64).optional(),
    type: memoryTypeEnum.optional(),
    includeExpired: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

const memoryInspectSchema = z
  .object({ reason: z.string().min(10).max(500) })
  .strict();

const memoryPurgeSchema = z
  .object({ ownerId: z.string().max(36).optional().nullable(), limit: z.number().int().positive().max(5000).optional() })
  .strict();

adminAiRoutes.get('/memory/summary', async (c) => {
  const summary = await memorySummaryForAdmin(getContext(c).db);
  return c.json({ success: true, data: summary });
});

adminAiRoutes.get('/memory/entries', validateQuery(memoryListSchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof memoryListSchema>>(c);
  const items = await listMemoryMetadataForAdmin(ctx.db, {
    ownerId: query.ownerId ?? null,
    agentKey: query.agentKey ?? null,
    type: query.type ?? null,
    includeExpired: query.includeExpired ?? false,
    limit: query.limit,
  });
  await writeAudit(
    ctx.db,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'AI.MEMORY_METADATA_LISTED',
      entityType: 'AGENT_MEMORY',
      metadata: {
        ownerId: query.ownerId ?? null,
        agentKey: query.agentKey ?? null,
        type: query.type ?? null,
        includeExpired: query.includeExpired ?? false,
        count: items.length,
      },
    },
  );
  return c.json({ success: true, data: { items } });
});

adminAiRoutes.get('/memory/entries/:memoryId', validateQuery(memoryInspectSchema), async (c) => {
  const ctx = getContext(c);
  const { reason } = getValidatedQuery<z.infer<typeof memoryInspectSchema>>(c);
  const memory = await inspectMemoryForAdmin(ctx.db, c.req.param('memoryId')!, reason, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: memory });
});

adminAiRoutes.post('/memory/purge', validateBody(memoryPurgeSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof memoryPurgeSchema>>(c);
  const deleted = await purgeExpiredMemories(ctx.db, {
    ownerId: body.ownerId ?? undefined,
    limit: body.limit,
  });
  await writeAudit(
    ctx.db,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'AI.MEMORY_EXPIRED_PURGED',
      entityType: 'AGENT_MEMORY',
      metadata: { ownerId: body.ownerId ?? null, deleted },
    },
  );
  return c.json({ success: true, data: { deleted } });
});

// ----- Persistent agent metrics (AI-MET-01) --------------------------------
// The durable counterpart of /company-metrics: aggregates read from the
// append-only agent_metrics log plus the live sources that own each figure
// (agent_tasks for approvals/stalls, audit_logs for tool and memory events,
// ai_requests for actual spend). Admin-only through the route-level AI_MANAGE
// guard; per-owner data is never broken out — only a distinct-owner count.

const metricsWindowSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    agentKey: z.string().max(64).optional(),
    taskType: z.string().max(64).optional(),
    granularity: z.enum(['day', 'week', 'month']).optional(),
  })
  .strict();

const MAX_METRICS_RANGE_DAYS = 366;

function parseMetricsWindow(raw: unknown): { from: Date; to: Date; granularity?: 'day' | 'week' | 'month'; agentKey?: string; taskType?: string } {
  const parsed = metricsWindowSchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message, code: issue.code })),
    );
  }
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from.getTime() > to.getTime()) {
    throw ApiError.validation([{ field: 'from', message: '`from` must be before `to`', code: 'RANGE' }]);
  }
  if (to.getTime() - from.getTime() > MAX_METRICS_RANGE_DAYS * 86_400_000) {
    throw ApiError.validation([
      { field: 'from', message: `Window cannot exceed ${MAX_METRICS_RANGE_DAYS} days`, code: 'RANGE' },
    ]);
  }
  return {
    from,
    to,
    granularity: parsed.data.granularity,
    agentKey: parsed.data.agentKey,
    taskType: parsed.data.taskType,
  };
}

adminAiRoutes.get('/metrics/report', async (c) => {
  const ctx = getContext(c);
  const window = parseMetricsWindow(c.req.query());
  const report = await buildMetricsReport(ctx.db, window);
  await writeAudit(
    ctx.db,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'AI.METRICS_REPORT_READ',
      entityType: 'AGENT_METRICS',
      entityId: window.agentKey ?? null,
      metadata: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        agentKey: window.agentKey ?? null,
        taskType: window.taskType ?? null,
        granularity: window.granularity ?? 'day',
      },
    },
  );
  return c.json({ success: true, data: report });
});

adminAiRoutes.get('/metrics/series', async (c) => {
  const ctx = getContext(c);
  const window = parseMetricsWindow(c.req.query());
  const points = await buildSeries(ctx.db, {
    from: window.from,
    to: window.to,
    granularity: window.granularity ?? 'day',
    agentKey: window.agentKey,
    taskType: window.taskType,
  });
  return c.json({
    success: true,
    data: {
      window: { from: window.from.toISOString(), to: window.to.toISOString(), granularity: window.granularity ?? 'day' },
      points,
    },
  });
});

adminAiRoutes.get('/metrics/coverage', async (c) => {
  const ctx = getContext(c);
  const window = parseMetricsWindow(c.req.query());
  const coverage = await metricsCoverage(ctx.db, {
    from: window.from,
    to: window.to,
    agentKey: window.agentKey,
  });
  return c.json({ success: true, data: coverage });
});

adminAiRoutes.post('/metrics/backfill', validateBody(
  z.object({ from: z.string().datetime().optional(), limit: z.number().int().positive().max(5000).optional() }).strict(),
), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<{ from?: string; limit?: number }>(c);
  const result = await backfillAgentMetrics(ctx.db, {
    since: body.from ? new Date(body.from) : undefined,
    limit: body.limit,
  });
  await auditBackfill(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, result);
  return c.json({ success: true, data: result });
});

// ----- Supervisor escalations to the General Manager (AI-SUP-02) ------------
// The Supervisor acts (contain/retry); these routes make its findings visible to
// a human who can decide. Detection is deterministic and reads only real rows.
// Reading and deciding are both `AI_MANAGE` (ADMIN/SUPER_ADMIN) — the router-level
// guard already enforces it, so no new permission is introduced. The notification
// targets SUPER_ADMIN only; an ADMIN can triage but cannot silence the GM's inbox.

const escalationsQuerySchema = z
  .object({
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
    severity: z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']).optional(),
    agentKey: z.string().max(64).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

adminAiRoutes.get('/escalations', validateQuery(escalationsQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof escalationsQuerySchema>>(c);
  const result = await listEscalations(ctx.db, query);
  return c.json({ success: true, data: { ...result, lastScanAt: await lastScanAt(ctx.db) } });
});

// Registered before `/:id` so a literal path is never read as an id.
adminAiRoutes.post(
  '/escalations/scan',
  validateBody(
    z
      .object({
        windowMinutes: z.number().int().positive().max(1440).optional(),
        maxCases: z.number().int().positive().max(1000).optional(),
      })
      .strict(),
  ),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<{ windowMinutes?: number; maxCases?: number }>(c);
    const audit = { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent };
    const result = await scanEscalations(ctx.db, audit, {
      limits: body.windowMinutes
        ? {
            windowMinutes: body.windowMinutes,
            failureRateThreshold: env.AI_ESCALATION_FAILURE_RATE,
            minSamples: env.AI_ESCALATION_MIN_SAMPLES,
            degradationDelta: env.AI_ESCALATION_DEGRADATION_DELTA,
            stallMinutes: env.AI_ESCALATION_STALL_MINUTES,
            pendingApprovalMinutes: env.AI_ESCALATION_PENDING_APPROVAL_MINUTES,
            toolFailureCount: env.AI_ESCALATION_TOOL_FAILURES,
            refusalCount: env.AI_ESCALATION_REFUSALS,
            cycleFailureCount: env.AI_ESCALATION_CYCLE_FAILURES,
          }
        : undefined,
      maxCases: body.maxCases,
      supervisorEnabled: env.AI_AGENT_RUNS_SUPERVISOR_ENABLED,
    });
    return c.json({ success: true, data: result });
  },
);

adminAiRoutes.get('/escalations/:id', async (c) => {
  const ctx = getContext(c);
  const escalation = await getEscalation(ctx.db, c.req.param('id')!);
  return c.json({ success: true, data: escalation });
});

adminAiRoutes.post(
  '/escalations/:id/acknowledge',
  validateBody(z.object({ note: z.string().max(1000).optional() }).strict()),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<{ note?: string }>(c);
    const escalation = await acknowledgeEscalation(
      ctx.db,
      c.req.param('id')!,
      ctx.user!.id,
      body.note ?? null,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    );
    return c.json({ success: true, data: escalation });
  },
);

adminAiRoutes.post(
  '/escalations/:id/resolve',
  validateBody(z.object({ note: z.string().trim().min(3).max(1000) }).strict()),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<{ note: string }>(c);
    const escalation = await resolveEscalation(
      ctx.db,
      c.req.param('id')!,
      ctx.user!.id,
      body.note,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    );
    return c.json({ success: true, data: escalation });
  },
);

// Re-delivery after a failed inbox write. Idempotent per (case, recipient,
// channel, generation): the ledger row is updated, never duplicated.
adminAiRoutes.post('/escalations/:id/notify', async (c) => {
  const ctx = getContext(c);
  const id = c.req.param('id')!;
  const escalation = await getEscalation(ctx.db, id);
  const delivery = await deliverEscalationToGm(ctx.db, id);
  await writeAudit(
    ctx.db,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: delivery.sent > 0 ? 'AI.ESCALATION_NOTIFIED' : 'AI.ESCALATION_NOTIFY_FAILED',
      entityType: 'AI_ESCALATION',
      entityId: id,
      metadata: {
        code: escalation.code,
        severity: escalation.severity,
        manual: true,
        recipients: delivery.recipients,
        sent: delivery.sent,
        failed: delivery.failed,
      },
    },
  );
  return c.json({ success: true, data: { ...delivery, escalation: await getEscalation(ctx.db, id) } });
});
