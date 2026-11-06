import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { aiBudgets, aiModels, aiRequests } from '../../db/schema/ai.js';
import { agentTasks } from '../../db/schema/agents.js';
import { adminUsageSummary } from '../ai/service.js';
import { listRegistryAgents } from '../ai/agents.js';
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

export const adminAiRoutes = new Hono();

adminAiRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

// ----- Usage / overview ----------------------------------------------------
adminAiRoutes.get('/usage', async (c) => {
  const ctx = getContext(c);
  const summary = await adminUsageSummary(ctx.db);
  return c.json({ success: true, data: summary });
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
  const rows = await listRegistryAgents(ctx.db);
  return c.json({ success: true, data: { items: rows } });
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