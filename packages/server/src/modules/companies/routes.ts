import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { createCompany, listCompanies, getCompany, updateCompany } from './service.js';

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

const updateCompanySchema = createCompanySchema.partial();

export const companyRoutes = new Hono();

companyRoutes.get('/', async (c) => {
  const qs = c.req.query();
  const ctx = getContext(c);
  const result = await listCompanies(ctx.db, { q: qs.q, countryId: qs.countryId });
  return c.json({ success: true, data: result });
});

companyRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const company = await getCompany(ctx.db, c.req.param('id')!);
  return c.json({ success: true, data: company });
});

companyRoutes.post('/', requireAuth, requireRole('COMPANY'), validateBody(createCompanySchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof createCompanySchema>>(c);
  const ctx = getContext(c);
  const result = await createCompany(ctx.db, { ...body, userId: ctx.user!.id }, { actorId: ctx.user!.id });
  return c.json({ success: true, data: result }, 201 as never);
});

companyRoutes.patch('/:id', requireAuth, validateBody(updateCompanySchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof updateCompanySchema>>(c);
  const ctx = getContext(c);
  const company = await updateCompany(ctx.db, c.req.param('id')!, body, ctx.user!.id);
  return c.json({ success: true, data: company });
});