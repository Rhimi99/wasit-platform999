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
import { agentRegistry, agentTasks } from '../../db/schema/agents.js';
import { adminUsageSummary } from '../ai/service.js';

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

  // Upsert: find an existing active budget for the same target+period.
  const existing = await ctx.db
    .select({ id: aiBudgets.id })
    .from(aiBudgets)
    .where(
      body.userId
        ? eq(aiBudgets.userId, body.userId)
        : eq(aiBudgets.roleTarget ?? '___', body.roleTarget ?? '___'),
    )
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
  const rows = await ctx.db.select().from(agentRegistry).orderBy(desc(agentRegistry.createdAt));
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