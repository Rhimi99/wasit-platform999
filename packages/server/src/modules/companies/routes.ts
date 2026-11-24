import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRoleOrPermission, requirePermission, optionalAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '@wasit/shared';
import { createCompany, listCompanies, getCompany, getMyCompany, updateCompany } from './service.js';
import { companyUpdateSchema } from '../entities/schemas.js';

const createCompanySchema = z.object({
  legalName: z.string().min(2).max(250),
  registrationNumber: z.string().max(100).optional(),
  taxId: z.string().max(100).optional(),
  countryId: z.string().max(36).optional(),
  cityId: z.string().max(36).optional(),
  industry: z.string().max(150).optional(),
  description: z.string().max(5000).optional(),
  logoUrl: z.string().url().max(2000).optional(),
});

export const companyRoutes = new Hono();

// Public directory of active companies — public projection only (no legal/tax
// identifiers, no owner id).
companyRoutes.get('/', optionalAuth, async (c) => {
  const qs = c.req.query();
  const ctx = getContext(c);
  const result = await listCompanies(ctx.db, { q: qs.q, countryId: qs.countryId });
  return c.json({ success: true, data: result });
});

// The caller's own company (or `null`). Registered before `/:id` so the literal
// path is never read as a company id.
companyRoutes.get('/mine', requireAuth, async (c) => {
  const ctx = getContext(c);
  const company = await getMyCompany(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { company } });
});

// A company profile: public projection for everyone; the owner and internal staff
// also receive the legal/tax identifiers. Inactive → 404 unless owner/staff.
companyRoutes.get('/:id', optionalAuth, async (c) => {
  const ctx = getContext(c);
  const company = await getCompany(ctx.db, c.req.param('id')!, {
    userId: ctx.user?.id,
    roles: ctx.user?.roles,
  });
  return c.json({ success: true, data: company });
});

companyRoutes.post(
  '/',
  requireAuth,
  requireRoleOrPermission('COMPANY', PERMISSIONS.COMPANY_CREATE),
  validateBody(createCompanySchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof createCompanySchema>>(c);
    const ctx = getContext(c);
    const result = await createCompany(ctx.db, { ...body, userId: ctx.user!.id }, { actorId: ctx.user!.id });
    return c.json({ success: true, data: result }, 201 as never);
  },
);

// Ownership is enforced in the service (`row.userId !== actorId` → 403).
companyRoutes.patch(
  '/:id',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_UPDATE),
  validateBody(companyUpdateSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof companyUpdateSchema>>(c);
    const ctx = getContext(c);
    const company = await updateCompany(ctx.db, c.req.param('id')!, body, ctx.user!.id);
    return c.json({ success: true, data: company });
  },
);