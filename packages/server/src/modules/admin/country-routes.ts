import { Hono } from 'hono';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { countries } from '../../db/schema/geo';
import { writeAudit } from '../../lib/audit';

/**
 * Admin control over market activation. A country row can be seeded as a
 * candidate (inactive) long before it goes live; turning it on is a business/
 * legal decision taken here — never hardcoded — and is always audited.
 */
const activationSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().min(5).max(1000),
});

export const adminCountryRoutes = new Hono();

adminCountryRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.ADMIN_POLICIES));

/** Every country, active or candidate, for the admin market list. */
adminCountryRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: countries.id,
      code: countries.code,
      iso3: countries.iso3,
      name: countries.name,
      nameAr: countries.nameAr,
      nameFr: countries.nameFr,
      currencyCode: countries.currencyCode,
      defaultLanguage: countries.defaultLanguage,
      isActive: countries.isActive,
      activatedAt: countries.activatedAt,
    })
    .from(countries)
    .orderBy(asc(countries.name));
  return c.json({ success: true, data: { items: rows } });
});

/** Activates or deactivates a market. */
adminCountryRoutes.put('/:id/activation', validateBody(activationSchema), async (c) => {
  const ctx = getContext(c);
  const { isActive, reason } = getValidatedBody<z.infer<typeof activationSchema>>(c);
  const id = c.req.param('id')!;

  const [before] = await ctx.db.select().from(countries).where(eq(countries.id, id)).limit(1);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Country not found.');

  await ctx.db
    .update(countries)
    .set({ isActive, activatedAt: isActive ? before.activatedAt ?? new Date() : before.activatedAt, updatedAt: new Date() })
    .where(eq(countries.id, id));

  await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: isActive ? 'COUNTRY.ACTIVATED' : 'COUNTRY.DEACTIVATED',
    entityType: 'COUNTRY',
    entityId: id,
    before: { isActive: before.isActive },
    after: { isActive, reason },
  });

  return c.json({ success: true, data: { id, code: before.code, isActive } });
});