import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, STAFF_ROLES } from '@wasit/shared';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getValidatedBody, getValidatedQuery, validateBody, validateQuery } from '../../middleware/validate.js';
import { getContext } from '../../lib/request-context.js';
import { parsePositiveIntParam } from '../../lib/query.js';
import { devToolingActive } from '../../lib/env.js';
import {
  ASSIGNABLE_STAFF_ROLES,
  STAFF_STATUS_FILTERS,
  type StaffStatusFilter,
} from './types.js';
import {
  changeStaffRole,
  createStaffMember,
  getStaffMember,
  listStaff,
  listStaffActivity,
  roleCatalog,
  setStaffStatus,
} from './service.js';

/**
 * Staff desk — `/api/admin/staff`.
 *
 * Guarded by `requireRole('SUPER_ADMIN')` on the sub-app itself, not by the
 * blanket `/api/admin` guard, so the desk stays closed even if the broader admin
 * surface is ever relaxed. There is deliberately no `staff:*` permission: the
 * role→permission matrix is not touched by this feature, and ADMIN — which holds
 * `user:create`/`user:update` for business accounts — gains nothing here.
 */
export const staffRoutes = new Hono();

staffRoutes.use('*', requireAuth, requireRole('SUPER_ADMIN'));

const listQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    role: z.enum([...ASSIGNABLE_STAFF_ROLES, 'SUPER_ADMIN']).optional(),
    status: z.enum(STAFF_STATUS_FILTERS).optional(),
    page: z.string().optional(),
    pageSize: z.string().optional(),
  })
  .strict();

const createSchema = z
  .object({
    email: z.string().trim().email().max(320),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    role: z.enum(ASSIGNABLE_STAFF_ROLES),
    sendInvite: z.boolean().optional(),
  })
  .strict();

const roleSchema = z.object({ role: z.enum(ASSIGNABLE_STAFF_ROLES) }).strict();
const statusSchema = z.object({ isActive: z.boolean() }).strict();

const idSchema = z.string().uuid();

function auditContext(c: Context) {
  const ctx = getContext(c);
  return {
    ctx,
    audit: {
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    },
  };
}

/** The roles a SUPER_ADMIN may hand out, with the permissions each one produces. */
staffRoutes.get('/roles', (c) => {
  return c.json({
    success: true,
    data: {
      assignable: roleCatalog(),
      allStaffRoles: STAFF_ROLES,
      protectedRole: 'SUPER_ADMIN',
    },
  });
});

staffRoutes.get('/', validateQuery(listQuerySchema), async (c) => {
  const { ctx } = auditContext(c);
  const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
  const pageSize = Math.min(parsePositiveIntParam(query.pageSize) ?? 25, 100);
  const page = parsePositiveIntParam(query.page) ?? 1;
  const result = await listStaff(ctx.db, {
    q: query.q,
    role: query.role,
    status: (query.status ?? 'all') as StaffStatusFilter,
    page,
    pageSize,
  });
  return c.json({ success: true, data: result });
});

staffRoutes.get('/:id', async (c) => {
  const { ctx } = auditContext(c);
  const id = c.req.param('id')!;
  if (!idSchema.safeParse(id).success) throw ApiError.notFound('Staff member');
  const member = await getStaffMember(ctx.db, id);
  return c.json({ success: true, data: { member } });
});

staffRoutes.get('/:id/activity', async (c) => {
  const { ctx } = auditContext(c);
  const id = c.req.param('id')!;
  if (!idSchema.safeParse(id).success) throw ApiError.notFound('Staff member');
  await getStaffMember(ctx.db, id);
  const items = await listStaffActivity(ctx.db, id);
  return c.json({ success: true, data: { items } });
});

staffRoutes.post('/', validateBody(createSchema), async (c) => {
  const { ctx, audit } = auditContext(c);
  const body = getValidatedBody<z.infer<typeof createSchema>>(c);
  const result = await createStaffMember(
    ctx.db,
    {
      email: body.email,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      role: body.role,
      sendInvite: body.sendInvite ?? true,
    },
    audit,
  );
  return c.json(
    {
      success: true,
      data: {
        member: result.member,
        inviteSent: result.inviteSent,
        // Mirrors `POST /api/auth/forgot-password`: the token is only surfaced to
        // local tooling, never to a deployment.
        devResetToken: devToolingActive() ? result.devResetToken : undefined,
      },
    },
    201,
  );
});

staffRoutes.patch('/:id/role', validateBody(roleSchema), async (c) => {
  const { ctx, audit } = auditContext(c);
  const id = c.req.param('id')!;
  if (!idSchema.safeParse(id).success) throw ApiError.notFound('Staff member');
  const body = getValidatedBody<z.infer<typeof roleSchema>>(c);
  const member = await changeStaffRole(ctx.db, id, body.role, ctx.user!.id, audit);
  return c.json({ success: true, data: { member } });
});

staffRoutes.patch('/:id/status', validateBody(statusSchema), async (c) => {
  const { ctx, audit } = auditContext(c);
  const id = c.req.param('id')!;
  if (!idSchema.safeParse(id).success) throw ApiError.notFound('Staff member');
  const body = getValidatedBody<z.infer<typeof statusSchema>>(c);
  const member = await setStaffStatus(
    ctx.db,
    id,
    body.isActive,
    { id: ctx.user!.id, roles: ctx.user!.roles },
    audit,
  );
  return c.json({ success: true, data: { member } });
});
