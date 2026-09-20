import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import {
  getMyVerificationStatus,
  listMyVerificationRequests,
  listVerificationPolicies,
  submitVerificationRequest,
} from './service';

const submitSchema = z.object({
  targetLevel: z.enum(['BASIC', 'VERIFIED', 'BUSINESS_VERIFIED', 'INTERNATIONAL_VERIFIED']),
  documentType: z.string().max(100).optional(),
  documentRef: z.string().max(200).optional(),
  isBusiness: z.boolean().optional(),
  businessId: z.string().max(36).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const verificationRoutes = new Hono();

verificationRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.VERIFICATION_READ));

// Shows the authenticated user their verification status + policies (submit allowed via POST)
verificationRoutes.get('/me', async (c) => {
  const ctx = getContext(c);
  const status = await getMyVerificationStatus(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: status });
});

verificationRoutes.get('/policies', async (c) => {
  const ctx = getContext(c);
  const policies = await listVerificationPolicies(ctx.db);
  return c.json({ success: true, data: policies });
});

verificationRoutes.get('/requests', validateQuery(listQuerySchema), async (c) => {
  const ctx = getContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const requests = await listMyVerificationRequests(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items: requests } });
});

verificationRoutes.post(
  '/requests',
  validateBody(submitSchema),
  requirePermission(PERMISSIONS.VERIFICATION_SUBMIT),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof submitSchema>>(c);
    const result = await submitVerificationRequest(ctx.db, ctx.user!.id, body, {
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: result });
  },
);