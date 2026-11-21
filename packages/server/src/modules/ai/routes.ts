import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS, type UserRole } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  analyzeProduct,
  getAiStatus,
  listMyAiActivity,
} from './service.js';
import {
  agentLayerSummary,
  copilotAgent,
  createAgentTask,
  decideAgentTask,
  getTask,
  listAgents,
  listMyTasks,
} from './agents.js';
import {
  runMarketAnalysis,
  runRecommendations,
  runSupplierRecommendations,
  runPriceIntelligence,
  runAdsRecommendations,
  recentAiActivity,
} from '../../lib/ai/endpoints.js';
import {
  runSmartSearch,
  runSalesIntelligence,
  myActivity,
} from '../../lib/ai/self-endpoints.js';
import {
  resolveAiRoute,
  listActiveModels,
  catalogHeartbeat,
} from '../../lib/ai/routing.js';
import { currentPeriodWindow, aiUsageForPeriod } from '../../lib/ai/cost-control.js';
import { writeAudit } from '../../lib/audit.js';
import {
  rememberMemory,
  recallMemories,
  getMemory,
  updateMemory,
  forgetMemory,
} from './memory.js';

const runSchema = z.object({
  requestType: z.string().min(1).max(50),
  system: z.string().max(8000).optional(),
  user: z.string().min(1).max(20000),
  maxTokens: z.number().int().positive().max(8192).optional(),
  model: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const smartSearchSchema = z.object({
  q: z.string().max(80).optional(),
  product: z.string().max(80).optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

const analyzeProductSchema = z.object({
  productId: z.string().min(1).max(36),
});

const createTaskSchema = z.object({
  input: z.record(z.unknown()).default({}),
  requestedModel: z.string().max(100).optional(),
});

const decideSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(1000).optional().nullable(),
});

// AI-MEM-01. `strict()` is the anti-spoofing guard: a body that names
// `scopeOwner`/`ownerId`/`requestedBy` is rejected instead of silently ignored,
// so a caller cannot even express "write this into someone else's memory".
const memoryTypeEnum = z.enum(['operational', 'contextual', 'procedural', 'task_result']);

const rememberSchema = z
  .object({
    agentKey: z.string().min(1).max(64),
    type: memoryTypeEnum,
    text: z.string().min(1).max(20_000),
    taskId: z.string().min(1).max(36).optional().nullable(),
    entityType: z.string().min(1).max(32).optional().nullable(),
    entityId: z.string().min(1).max(36).optional().nullable(),
    ttlDays: z.number().int().min(1).max(3650).optional().nullable(),
  })
  .strict();

const updateMemorySchema = z
  .object({
    type: memoryTypeEnum.optional(),
    text: z.string().min(1).max(20_000).optional(),
    ttlDays: z.number().int().min(1).max(3650).optional().nullable(),
    entityType: z.string().min(1).max(32).optional().nullable(),
    entityId: z.string().min(1).max(36).optional().nullable(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();

const recallQuerySchema = z
  .object({
    agentKey: z.string().min(1).max(64),
    type: z
      .union([memoryTypeEnum, z.array(memoryTypeEnum)])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    taskId: z.string().max(36).optional(),
    entityType: z.string().max(32).optional(),
    entityId: z.string().max(36).optional(),
    q: z.string().max(80).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

const memoryScopeSchema = z.object({ agentKey: z.string().min(1).max(64) }).strict();

export const aiRoutes = new Hono();

// Every AI endpoint requires an authenticated user.
aiRoutes.use('*', requireAuth);

// ----- Status / usage ------------------------------------------------------
aiRoutes.get('/status', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await getAiStatus(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[]);
  return c.json({ success: true, data: result });
});

aiRoutes.get('/activity', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await listMyAiActivity(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items: result } });
});

// ----- Model catalogue (own view) ------------------------------------------
aiRoutes.get('/models', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const models = await listActiveModels(ctx.db);
  return c.json({ success: true, data: { items: models } });
});

// ----- My budget & usage (own view) ----------------------------------------
aiRoutes.get('/budgets/me', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const window = currentPeriodWindow('MONTHLY');
  const usage = await aiUsageForPeriod(ctx.db, ctx.user!.id, window.start, window.end);
  return c.json({
    success: true,
    data: {
      period: 'MONTHLY',
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      usage: {
        requests: usage.requests,
        tokensInput: usage.tokensIn,
        tokensOutput: usage.tokensOut,
        cost: usage.cost.toFixed(6),
      },
    },
  });
});

// ----- Feature execution / routing -----------------------------------------
aiRoutes.post('/run', requirePermission(PERMISSIONS.AI_USE), validateBody(runSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof runSchema>>(c);
  const route = await resolveAiRoute(ctx.db, body.requestType, ctx.user!.roles as UserRole[], body.model);
  const { runAIFeature } = await import('../../lib/ai/runtime.js');
  const out = await runAIFeature(ctx.db, {
    userId: ctx.user!.id,
    roles: ctx.user!.roles as UserRole[],
    requestType: body.requestType,
    system: body.system,
    user: body.user,
    maxTokens: body.maxTokens ?? 256,
    modelKey: route.modelKey,
    vendorModel: route.vendorModel,
    provider: route.provider,
    metadata: body.metadata,
  });
  await writeAudit(ctx.db, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  }, {
    action: 'AI.FEATURE_RUN',
    entityType: 'AI_REQUEST',
    entityId: out.requestId,
    metadata: { requestType: body.requestType, model: out.model, status: 'SUCCESS' },
  });
  return c.json({
    success: true,
    data: {
      requestId: out.requestId,
      kind: body.requestType,
      model: out.model,
      content: out.content,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
      cost: out.cost,
      currencyCode: out.currencyCode,
    },
  });
});

// ----- Smart features ------------------------------------------------------
aiRoutes.post('/smart-search', requirePermission(PERMISSIONS.AI_USE), validateBody(smartSearchSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof smartSearchSchema>>(c);
  const result = await runSmartSearch(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[], { q: body.q, product: body.product });
  return c.json({ success: true, data: result });
});

aiRoutes.post('/recommendations', requirePermission(PERMISSIONS.AI_USE), validateBody(smartSearchSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof smartSearchSchema>>(c);
  const result = await runRecommendations(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[], body.limit ?? 8);
  return c.json({ success: true, data: result });
});

aiRoutes.post('/market-analysis', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await runMarketAnalysis(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[]);
  return c.json({ success: true, data: result });
});

aiRoutes.post('/supplier-recommendations', requirePermission(PERMISSIONS.AI_USE), validateBody(smartSearchSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof smartSearchSchema>>(c);
  const result = await runSupplierRecommendations(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[], body.limit ?? 8);
  return c.json({ success: true, data: result });
});

aiRoutes.post('/price-intelligence', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await runPriceIntelligence(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[]);
  return c.json({ success: true, data: result });
});

aiRoutes.post('/sales-intelligence', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await runSalesIntelligence(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[]);
  return c.json({ success: true, data: result });
});

aiRoutes.post('/ads-recommendations', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const result = await runAdsRecommendations(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[]);
  return c.json({ success: true, data: result });
});

aiRoutes.get('/recent', requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI), async (c) => {
  const ctx = getContext(c);
  const result = await recentAiActivity(ctx.db, 25);
  return c.json({ success: true, data: { items: result } });
});

// ----- Product analysis ----------------------------------------------------
aiRoutes.post('/analyze/product', requirePermission(PERMISSIONS.AI_USE), validateBody(analyzeProductSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof analyzeProductSchema>>(c);
  const result = await analyzeProduct(ctx.db, ctx.user!.id, ctx.user!.roles as UserRole[], body.productId);
  return c.json({ success: true, data: result });
});

// ----- Agents --------------------------------------------------------------
aiRoutes.get('/agents', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  // AI-REG-01: the full layer is returned (20 agents, each with its real
  // `executable` state) plus the Copilot apart — it is a coordinator, not agent
  // #21, and is never counted in `counts.total`.
  const result = await listAgents(ctx.db);
  return c.json({
    success: true,
    data: { agents: result, counts: agentLayerSummary(), copilot: copilotAgent() },
  });
});

aiRoutes.post('/agents/:agentKey/tasks', requirePermission(PERMISSIONS.AI_USE), validateBody(createTaskSchema), async (c) => {
  const ctx = getContext(c);
  const agentKey = c.req.param('agentKey')!;
  const body = getValidatedBody<z.infer<typeof createTaskSchema>>(c);
  const result = await createAgentTask(
    ctx.db,
    ctx.user!.roles as UserRole[],
    ctx.user!.id,
    { agentKey, requestedBy: ctx.user!.id, input: body.input, requestedModel: body.requestedModel },
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: result }, 201);
});

aiRoutes.get('/agents/:agentKey/tasks', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const tasks = await listMyTasks(ctx.db, ctx.user!.id);
  const filtered = tasks.filter((t) => t.agentKey === c.req.param('agentKey'));
  return c.json({ success: true, data: { items: filtered } });
});

aiRoutes.get('/tasks', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const tasks = await listMyTasks(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items: tasks } });
});

aiRoutes.get('/tasks/:taskId', requirePermission(PERMISSIONS.AI_USE), async (c) => {
  const ctx = getContext(c);
  const task = await getTask(ctx.db, c.req.param('taskId')!);
  if (task.requestedBy !== ctx.user!.id && !ctx.user!.roles.includes('ADMIN') && !ctx.user!.roles.includes('SUPER_ADMIN')) {
    throw ApiError.forbidden('Task does not belong to you');
  }
  return c.json({ success: true, data: task });
});

// Approval of sensitive agent tasks is restricted to AI_MANAGE holders.
aiRoutes.post('/tasks/:taskId/approve', requirePermission(PERMISSIONS.AI_MANAGE), validateBody(decideSchema), async (c) => {
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

aiRoutes.post('/tasks/:taskId/reject', requirePermission(PERMISSIONS.AI_MANAGE), validateBody(decideSchema), async (c) => {
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
// ----- Agent memory (AI-MEM-01) -------------------------------------------
// Owner-scoped by construction: `scope.ownerId` is always `ctx.user.id`, and the
// agent key must be named on every operation, so one agent's memory is never
// reachable through another agent's path.

aiRoutes.get('/memory', requirePermission(PERMISSIONS.AI_USE), validateQuery(recallQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof recallQuerySchema>>(c);
  const items = await recallMemories(
    ctx.db,
    { ownerId: ctx.user!.id, agentKey: query.agentKey },
    {
      agentKey: query.agentKey,
      types: query.type,
      taskId: query.taskId ?? null,
      entityType: query.entityType ?? null,
      entityId: query.entityId ?? null,
      q: query.q ?? null,
      limit: query.limit,
    },
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: { items } });
});

aiRoutes.post('/memory', requirePermission(PERMISSIONS.AI_USE), validateBody(rememberSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof rememberSchema>>(c);
  const memory = await rememberMemory(
    ctx.db,
    { ownerId: ctx.user!.id, agentKey: body.agentKey },
    body,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: memory }, 201);
});

aiRoutes.get('/memory/:memoryId', requirePermission(PERMISSIONS.AI_USE), validateQuery(memoryScopeSchema), async (c) => {
  const ctx = getContext(c);
  const { agentKey } = getValidatedQuery<z.infer<typeof memoryScopeSchema>>(c);
  const memory = await getMemory(
    ctx.db,
    { ownerId: ctx.user!.id, agentKey },
    c.req.param('memoryId')!,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: memory });
});

aiRoutes.patch(
  '/memory/:memoryId',
  requirePermission(PERMISSIONS.AI_USE),
  validateQuery(memoryScopeSchema),
  validateBody(updateMemorySchema),
  async (c) => {
    const ctx = getContext(c);
    const { agentKey } = getValidatedQuery<z.infer<typeof memoryScopeSchema>>(c);
    const body = getValidatedBody<z.infer<typeof updateMemorySchema>>(c);
    const memory = await updateMemory(
      ctx.db,
      { ownerId: ctx.user!.id, agentKey },
      c.req.param('memoryId')!,
      body,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    );
    return c.json({ success: true, data: memory });
  },
);

aiRoutes.delete('/memory/:memoryId', requirePermission(PERMISSIONS.AI_USE), validateQuery(memoryScopeSchema), async (c) => {
  const ctx = getContext(c);
  const { agentKey } = getValidatedQuery<z.infer<typeof memoryScopeSchema>>(c);
  const result = await forgetMemory(
    ctx.db,
    { ownerId: ctx.user!.id, agentKey },
    c.req.param('memoryId')!,
    { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  );
  return c.json({ success: true, data: result });
});
