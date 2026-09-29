import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { listAllVerificationRequests, reviewVerificationRequest } from '../verification/service';
import { adminRecomputeFor, listAllLatestTrustScores } from '../trust/service';
import { getRiskProfile, listRiskProfiles, reassessUserRisk } from '../risk/service';
import {
  assignDispute,
  decideDispute,
  getDisputeDetail,
  listAllDisputes,
  listDisputeAppeals,
  reviewDisputeAppeal,
  updateDisputeStatus,
} from '../disputes/service';
import { listRiskEvents } from '../risk/service';
import { writeAudit } from '../../lib/audit';
import { resolveRateLimitStore } from '../../lib/rate-limit/resolve';

const statusRegex = /^(PENDING|SUBMITTED|IN_REVIEW|APPROVED|REJECTED|EXPIRED|REVOKED)$/;
const levelRegex = /^(BASIC|VERIFIED|BUSINESS_VERIFIED|INTERNATIONAL_VERIFIED)$/;

const reviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(2000).optional(),
});

const reassignStatusSchema = z.object({
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED', 'DECIDED', 'CLOSED', 'ARCHIVED']),
  note: z.string().max(1000).optional(),
});

const decideSchema = z.object({
  decision: z.enum(['IN_FAVOR_OF_BUYER', 'IN_FAVOR_OF_SELLER', 'SPLIT', 'REJECTED']),
  note: z.string().max(2000).optional(),
  // Optional explicit refund amount for a policy that maps the decision to
  // REFUND_BUYER without a ratio (SPLIT). Validated as a money string so a
  // malformed amount is rejected rather than silently rounded.
  partialRefundAmount: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
});

const assignSchema = z.object({
  reviewerUserId: z.string().min(1).max(36),
});

const reviewAppealSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().max(2000).optional(),
});

export const adminEnginesRoutes = new Hono();
adminEnginesRoutes.use('*', requireAuth, requirePermission(
  PERMISSIONS.ADMIN_VERIFICATION,
  PERMISSIONS.ADMIN_TRUST,
  PERMISSIONS.ADMIN_RISK,
  PERMISSIONS.ADMIN_DISPUTES,
  PERMISSIONS.ADMIN_REPORTS,
));

// ----- Verification -----
adminEnginesRoutes.get('/verification/requests', async (c) => {
  const ctx = getContext(c);
  const queries = c.req.query();
  const result = await listAllVerificationRequests(ctx.db, {
    status: statusRegex.test(queries.status ?? '') ? (queries.status as never) : undefined,
    level: levelRegex.test(queries.level ?? '') ? (queries.level as never) : undefined,
    q: queries.q,
    page: queries.page ? Number(queries.page) : undefined,
    pageSize: queries.pageSize ? Number(queries.pageSize) : undefined,
  });
  return c.json({ success: true, data: result });
});

adminEnginesRoutes.post(
  '/verification/requests/:id/review',
  validateBody(reviewSchema),
  requirePermission(PERMISSIONS.VERIFICATION_APPROVE, PERMISSIONS.VERIFICATION_REJECT),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof reviewSchema>>(c);
    // Only approvers can approve; only rejecters can reject (both are admin here)
    const decision = body.decision;
    const result = await reviewVerificationRequest(ctx.db, c.req.param('id')!, ctx.user!.id, {
      decision,
      notes: body.notes,
    }, { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    return c.json({ success: true, data: result });
  },
);

// ----- Trust -----
adminEnginesRoutes.get('/trust', async (c) => {
  const ctx = getContext(c);
  const items = await listAllLatestTrustScores(ctx.db);
  return c.json({ success: true, data: { items } });
});

adminEnginesRoutes.post('/trust/:userId/recompute', requirePermission(PERMISSIONS.TRUST_READ_ALL), async (c) => {
  const ctx = getContext(c);
  const latest = await adminRecomputeFor(ctx.db, c.req.param('userId')!, ctx.user!.id);
  return c.json({ success: true, data: { latest } });
});

// ----- Risk -----
adminEnginesRoutes.get('/risk/profiles', async (c) => {
  const ctx = getContext(c);
  const profiles = await listRiskProfiles(ctx.db);
  return c.json({ success: true, data: { items: profiles } });
});

adminEnginesRoutes.get('/risk/profiles/:userId', async (c) => {
  const ctx = getContext(c);
  const profile = await getRiskProfile(ctx.db, c.req.param('userId')!);
  return c.json({ success: true, data: profile });
});

adminEnginesRoutes.post('/risk/profiles/:userId/reassess', requirePermission(PERMISSIONS.RISK_MANAGE), async (c) => {
  const ctx = getContext(c);
  const profile = await reassessUserRisk(ctx.db, c.req.param('userId')!, ctx.user!.id);
  return c.json({ success: true, data: profile });
});

adminEnginesRoutes.get('/risk/events', async (c) => {
  const ctx = getContext(c);
  const queries = c.req.query();
  const result = await listRiskEvents(ctx.db, {
    userId: queries.userId,
    level: queries.level as never,
    page: queries.page ? Number(queries.page) : undefined,
    pageSize: queries.pageSize ? Number(queries.pageSize) : undefined,
  });
  return c.json({ success: true, data: result });
});

// ----- Disputes -----
adminEnginesRoutes.get('/disputes', async (c) => {
  const ctx = getContext(c);
  const queries = c.req.query();
  const result = await listAllDisputes(ctx.db, {
    status: queries.status as never,
    decision: queries.decision as never,
    q: queries.q,
    page: queries.page ? Number(queries.page) : undefined,
    pageSize: queries.pageSize ? Number(queries.pageSize) : undefined,
  });
  return c.json({ success: true, data: result });
});

adminEnginesRoutes.get('/disputes/:id', async (c) => {
  const ctx = getContext(c);
  const detail = await getDisputeDetail(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data: detail });
});

adminEnginesRoutes.post('/disputes/:id/assign', validateBody(assignSchema), requirePermission(PERMISSIONS.DISPUTE_ASSIGN), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof assignSchema>>(c);
  const result = await assignDispute(ctx.db, c.req.param('id')!, ctx.user!.id, body.reviewerUserId);
  return c.json({ success: true, data: result });
});

adminEnginesRoutes.post('/disputes/:id/status', validateBody(reassignStatusSchema), requirePermission(PERMISSIONS.DISPUTE_REVIEW, PERMISSIONS.DISPUTE_MANAGE), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof reassignStatusSchema>>(c);
  const result = await updateDisputeStatus(ctx.db, c.req.param('id')!, ctx.user!.id, body.status, body.note);
  return c.json({ success: true, data: result });
});

adminEnginesRoutes.post('/disputes/:id/decide', validateBody(decideSchema), requirePermission(PERMISSIONS.DISPUTE_DECIDE), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof decideSchema>>(c);
  const result = await decideDispute(ctx.db, c.req.param('id')!, ctx.user!.id, { decision: body.decision, note: body.note, partialRefundAmount: body.partialRefundAmount });
  return c.json({ success: true, data: result });
});

adminEnginesRoutes.get('/disputes/:id/appeals', requirePermission(PERMISSIONS.DISPUTE_REVIEW), async (c) => {
  const ctx = getContext(c);
  const items = await listDisputeAppeals(ctx.db, ctx.user!.id, c.req.param('id')!);
  return c.json({ success: true, data: { items } });
});

adminEnginesRoutes.post('/disputes/:id/appeals/:appealId/review', validateBody(reviewAppealSchema), requirePermission(PERMISSIONS.DISPUTE_MANAGE), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof reviewAppealSchema>>(c);
  const result = await reviewDisputeAppeal(ctx.db, ctx.user!.id, c.req.param('id')!, c.req.param('appealId')!, body);
  return c.json({ success: true, data: result });
});

// Rate-limit bucket maintenance. The scheduler purges on an interval; this lets
// an operator (or an external cron) trigger the same idempotent cleanup.
adminEnginesRoutes.post(
  '/rate-limits/purge',
  requireAuth,
  requirePermission(PERMISSIONS.ADMIN_SYSTEM),
  async (c) => {
    const ctx = getContext(c);
    const store = resolveRateLimitStore(ctx.db);
    const removed = await store.purgeExpired();
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      {
        action: 'RATE_LIMIT.PURGE_RUN',
        entityType: 'RATE_LIMIT',
        after: { removed, store: store.id },
      },
    );
    return c.json({ success: true, data: { removed, store: store.id } });
  },
);