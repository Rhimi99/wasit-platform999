import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { categories } from '../../db/schema/products.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';
import { slugify } from '../products/service.js';

const createCategorySchema = z.object({
  name: z.string().min(2).max(200),
  nameAr: z.string().max(200).optional(),
  nameFr: z.string().max(200).optional(),
  parentId: z.string().max(36).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(200).optional(),
  sortOrder: z.number().int().optional(),
});

export const categoriesRoutes = new Hono();

categoriesRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sortOrder));
  return c.json({ success: true, data: rows });
});

categoriesRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db.select().from(categories).where(eq(categories.id, c.req.param('id'))).limit(1);
  if (rows.length === 0) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Category not found', statusCode: 404 } }, 404 as never);
  }
  return c.json({ success: true, data: rows[0] });
});

categoriesRoutes.post('/', requireAuth, requirePermission(PERMISSIONS.PRODUCT_MANAGE), validateBody(createCategorySchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof createCategorySchema>>(c);
  const ctx = getContext(c);
  const id = newId();
  await ctx.db.insert(categories).values({
    id,
    name: body.name,
    nameAr: body.nameAr ?? null,
    nameFr: body.nameFr ?? null,
    slug: slugify(body.name),
    parentId: body.parentId ?? null,
    description: body.description ?? null,
    icon: body.icon ?? null,
    sortOrder: body.sortOrder ?? 0,
  });
  await writeAudit(ctx.db, { actorId: ctx.user!.id }, {
    action: 'CATEGORY.CREATE',
    entityType: 'CATEGORY',
    entityId: id,
    after: { name: body.name },
  });
  return c.json({ success: true, data: { id } }, 201 as never);
});