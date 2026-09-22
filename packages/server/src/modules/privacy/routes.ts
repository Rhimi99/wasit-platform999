import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getContext } from '../../lib/request-context.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import {
  validateBody,
  validateQuery,
  getValidatedBody,
  getValidatedQuery,
} from '../../middleware/validate.js';
import {
  getConsentState,
  setConsent,
  createExportRequest,
  createDeletionRequest,
  getDeletionRequest,
  listDeletionRequests,
  advanceDeletionStage,
} from './service.js';

/**
 * Own-data privacy endpoints.
 * Every route is authenticated explicitly. Sensitive routes apply rate limiting
 * BEFORE authentication so that anti-abuse protection also covers unauthenticated
 * attempts (protects the DB from flooding).
 */
export const privacyRoutes = new Hono();

const consentSchema = z.object({
  consentType: z.string().min(1).max(100),
  granted: z.boolean(),
});
const deletionSchema = z.object({
  reason: z.string().max(500).optional(),
});
const advanceSchema = z.object({
  stage: z.enum(['RETENTION', 'REVIEW', 'ELIGIBLE', 'ANONYMIZED', 'REJECTED']),
  // Only honoured for ANONYMIZED: lets an admin scrub despite an open retention
  // window, recording a PRIVACY.LEGAL_HOLD_OVERRIDE audit entry.
  legalHoldOverride: z.boolean().optional().default(false),
});
const listDeletionQuery = z.object({
  stage: z.string().optional(),
});

// The deletion limiter runs before auth, so it keys on the caller's IP. A suite
// that files several real deletion requests would trip the production default
// (2/5min), so — like the auth limits — it is overridable for the E2E process
// only. The production default is unchanged.
const deletionRateMax = Number(process.env.RATE_LIMIT_DELETION_MAX ?? 2);

// GET /api/privacy/me — current consent state + privacy preferences
privacyRoutes.get('/me', requireAuth, async (c) => {
  const ctx = getContext(c);
  const state = await getConsentState(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: state });
});

// GET /api/privacy/consents — list of consents
privacyRoutes.get('/consents', requireAuth, async (c) => {
  const ctx = getContext(c);
  const state = await getConsentState(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: state.consents });
});

// PUT /api/privacy/consents — upsert consent (grant/revoke)
privacyRoutes.put(
  '/consents',
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'privacy-consents' }),
  requireAuth,
  validateBody(consentSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof consentSchema>>(c);
    await setConsent(ctx.db, { userId: ctx.user!.id }, body.consentType, body.granted, 'USER');
    return c.json({ success: true });
  },
);

// POST /api/privacy/export — generate a data export for the current user
privacyRoutes.post(
  '/export',
  rateLimit({ windowSeconds: 60, max: 5, keyPrefix: 'privacy-export' }),
  requireAuth,
  async (c) => {
    const ctx = getContext(c);
    const { exportId, data } = await createExportRequest(ctx.db, ctx.user!.id, ctx.user!.id);
    return c.json({ success: true, data: { exportId, export: data } });
  },
);

// POST /api/privacy/deletion — request account deletion (deactivates immediately)
privacyRoutes.post(
  '/deletion',
  rateLimit({ windowSeconds: 300, max: deletionRateMax, keyPrefix: 'privacy-deletion' }),
  requireAuth,
  validateBody(deletionSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof deletionSchema>>(c);
    const result = await createDeletionRequest(ctx.db, ctx.user!.id, ctx.user!.id, body.reason);
    return c.json({ success: true, data: result });
  },
);

// GET /api/privacy/deletion — current deletion request state
privacyRoutes.get('/deletion', requireAuth, async (c) => {
  const ctx = getContext(c);
  const req = await getDeletionRequest(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: req });
});

// ---------------------------------------------------------------------------
// Admin-only privacy management
// ---------------------------------------------------------------------------
export const adminPrivacyRoutes = new Hono();

adminPrivacyRoutes.use(
  '*',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
);

// GET /api/admin/privacy/deletions?stage= — list deletion requests
adminPrivacyRoutes.get(
  '/deletions',
  validateQuery(listDeletionQuery),
  async (c) => {
    const ctx = getContext(c);
    const q = getValidatedQuery(c) as z.infer<typeof listDeletionQuery>;
    return c.json({ success: true, data: await listDeletionRequests(ctx.db, q.stage) });
  },
);

// PATCH /api/admin/privacy/deletions/:id — advance stage
adminPrivacyRoutes.patch(
  '/deletions/:id',
  validateBody(advanceSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof advanceSchema>>(c);
    const deletionId = c.req.param('id');
    if (!deletionId) {
      return c.json({ success: false, message: 'deletion id required' }, 400 as never);
    }
    await advanceDeletionStage(ctx.db, deletionId, body.stage, ctx.user!.id, {
      legalHoldOverride: body.legalHoldOverride,
    });
    return c.json({ success: true });
  },
);