import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../../lib/request-context';
import { getValidatedBody, validateBody } from '../../../middleware/validate';
import {
  advanceCopilotRun,
  buildCopilotReport,
  createCopilotRequest,
  listCopilotRequests,
} from './service';

/**
 * WASIT-COPILOT-01 — the General Manager's coordination surface.
 *
 * Mounted under `/api/admin/ai/copilot`, so it inherits the existing
 * `requireAuth + requirePermission(AI_MANAGE | ADMIN_AI)` gate and the
 * `ai.admin.control` / `ai.admin.read` rate-limit classes. No new permission, no
 * new auth path, no privileged principal: the requester's own id and roles are
 * used for planning and dispatch.
 */
export const copilotRoutes = new Hono();

const createSchema = z
  .object({
    request: z.string().min(8).max(2000),
    locale: z.enum(['ar', 'fr', 'en']).optional(),
    requestId: z.string().min(1).max(64).optional(),
    autoAdvance: z.boolean().optional(),
  })
  .strict();

copilotRoutes.post('/requests', validateBody(createSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof createSchema>>(c);
  const view = await createCopilotRequest(ctx.db, ctx.user!.id, body, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: view }, view.report ? 201 : 200);
});

copilotRoutes.get('/requests', async (c) => {
  const ctx = getContext(c);
  const items = await listCopilotRequests(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

copilotRoutes.get('/requests/:runId', async (c) => {
  const ctx = getContext(c);
  const report = await buildCopilotReport(ctx.db, c.req.param('runId')!, ctx.user!.id);
  return c.json({ success: true, data: report });
});

copilotRoutes.post('/requests/:runId/advance', async (c) => {
  const ctx = getContext(c);
  const runId = c.req.param('runId')!;
  // Reading the report first enforces ownership: a caller cannot advance a run
  // it is not allowed to see.
  await buildCopilotReport(ctx.db, runId, ctx.user!.id);
  const result = await advanceCopilotRun(ctx.db, runId, {
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({
    success: true,
    data: { ...result, report: await buildCopilotReport(ctx.db, runId, ctx.user!.id) },
  });
});
