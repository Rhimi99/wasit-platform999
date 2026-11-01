import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getGmRun, listGmPlaybooks, listGmRuns, orchestrateGmGoal } from '../ai/orchestrator.js';
import { resolveUserRoles } from '../ai/runner.js';

/**
 * General Manager (GM) Orchestrator desk — the central command surface for the
 * platform owner (`SUPER_ADMIN`).
 *
 * This module adds no execution machinery of its own. Every route delegates to
 * `orchestrateGmGoal`, which itself only calls `createAgentTask`. So the caller's
 * real RBAC, the per-agent data scope, the kill switch, the human-approval gate,
 * the per-run budget guard and the `AI.*` audit trail are identical to every
 * other path — the desk is a *view + trigger*, never a second engine.
 *
 * Access control: `requireRole('SUPER_ADMIN')` guards every route. The GM
 * orchestrator runs as the authenticated owner, and it never fabricates a
 * `SUPER_ADMIN` principal for a lesser role.
 */

const orchestrateSchema = z.object({
  goal: z.string().min(3).max(1000),
  maxSteps: z.number().int().positive().max(8).optional(),
});

export const gmRoutes = new Hono();

gmRoutes.use('*', requireAuth, requireRole('SUPER_ADMIN'));

/** The deterministic playbooks the orchestrator can run, for the desk UI. */
gmRoutes.get('/playbooks', async (c) => {
  return c.json({ success: true, data: { items: listGmPlaybooks() } });
});

/**
 * Lists recent orchestrations (the run log).
 *
 * Summaries are decoded from the audit `metadata`; nothing is recomputed from
 * live state and nothing is written. A run without a snapshot (pre-AI-07.0a) is
 * still listed with `hasSnapshot: false` — its full report is not retrievable.
 */
gmRoutes.get('/runs', async (c) => {
  const ctx = getContext(c);
  const rawLimit = Number(c.req.query('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
  const items = await listGmRuns(ctx.db, { limit });
  return c.json({ success: true, data: { items } });
});

/**
 * Reads a completed orchestration back from its persisted snapshot.
 *
 * The run is identified by its `correlationId` (equal to the `runId` returned by
 * `/orchestrate`). The response is decoded verbatim from the snapshot stored at
 * execution time, so it is the run as it happened — not a recomputation from
 * current state. A missing run, a legacy run with no snapshot, or a run the
 * caller may not read all answer `404`.
 */
gmRoutes.get('/runs/:correlationId', async (c) => {
  const ctx = getContext(c);
  const correlationId = c.req.param('correlationId')!;
  const run = await getGmRun(ctx.db, correlationId, ctx.user!.id);
  return c.json({ success: true, data: run });
});

/**
 * Runs one management goal end to end.
 *
 * The caller's roles are resolved from the database (never trusted from the
 * request body), and the orchestrator is executed under that real identity, so
 * the delegation inherits the same gates as a direct agent-task call.
 */
gmRoutes.post('/orchestrate', validateBody(orchestrateSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof orchestrateSchema>>(c);
  const roles = await resolveUserRoles(ctx.db, ctx.user!.id);
  const result = await orchestrateGmGoal(ctx.db, {
    goal: body.goal,
    requestedBy: ctx.user!.id,
    role: roles,
    audit: { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    options: { maxSteps: body.maxSteps },
  });
  return c.json({ success: true, data: result }, 201);
});
