import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requireRoleOrPermission, requirePermission, optionalAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '@wasit/shared';
import { createSupplier, listSuppliers, getSupplier, addSupplierContact } from './service.js';

const createSupplierSchema = z.object({
  companyName: z.string().min(2).max(200),
  countryId: z.string().max(36).optional(),
  cityId: z.string().max(36).optional(),
  description: z.string().max(5000).optional(),
  logoUrl: z.string().url().max(2000).optional(),
});

const contactSchema = z.object({
  supplierId: z.string().min(1),
  fullName: z.string().min(1).max(150),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  position: z.string().max(100).optional(),
  isPrimary: z.boolean().optional(),
});

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  countryId: z.string().max(36).optional(),
  verifiedOnly: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const suppliersRoutes = new Hono();

// Public directory of active suppliers. The response carries the public
// projection only (no owner id, no operational columns) and filters to active
// rows, so an anonymous visitor sees exactly what the marketplace shows.
suppliersRoutes.get('/', optionalAuth, async (c) => {
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const ctx = getContext(c);
  const result = await listSuppliers(ctx.db, { ...query, verifiedOnly: query.verifiedOnly === 'true' });
  return c.json({ success: true, data: result });
});

// A supplier profile. The public projection is always returned; the owner and
// internal staff additionally receive the contact list. An inactive supplier is
// a 404 to everyone else.
suppliersRoutes.get('/:id', optionalAuth, async (c) => {
  const ctx = getContext(c);
  const supplier = await getSupplier(ctx.db, c.req.param('id')!, {
    userId: ctx.user?.id,
    roles: ctx.user?.roles,
  });
  return c.json({ success: true, data: supplier });
});

suppliersRoutes.post(
  '/',
  requireAuth,
  requireRoleOrPermission('SUPPLIER', PERMISSIONS.SUPPLIER_CREATE),
  validateBody(createSupplierSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof createSupplierSchema>>(c);
    const ctx = getContext(c);
    const result = await createSupplier(ctx.db, { ...body, userId: ctx.user!.id }, { actorId: ctx.user!.id });
    return c.json({ success: true, data: result }, 201 as never);
  },
);

// Adding a contact modifies an existing supplier profile, so it needs the
// supplier update permission; ownership is enforced in the service.
suppliersRoutes.post(
  '/contacts',
  requireAuth,
  requirePermission(PERMISSIONS.SUPPLIER_UPDATE),
  validateBody(contactSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof contactSchema>>(c);
    const ctx = getContext(c);
    const result = await addSupplierContact(ctx.db, body, { actorId: ctx.user!.id });
    return c.json({ success: true, data: result }, 201 as never);
  },
);