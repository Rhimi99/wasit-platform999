import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS, type UserRole } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody, validateQuery, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { createProduct, getProduct, listMyProducts, listMySellerEntities, listProducts, updateProduct, updateProductStatus } from './service.js';
import { db } from '../../db/client.js';
import { assertSellerOwnership as assertSellerOwnershipDb } from '../../lib/seller-ownership.js';

const PERM_PRODUCT_MANAGE = PERMISSIONS.PRODUCT_MANAGE;

const createProductSchema = z.object({
  sellerId: z.string().min(1),
  sellerType: z.enum(['MERCHANT', 'SUPPLIER', 'COMPANY']),
  categoryId: z.string().min(1),
  name: z.string().min(2).max(250),
  nameAr: z.string().max(250).optional(),
  nameFr: z.string().max(250).optional(),
  description: z.string().max(5000).optional(),
  brand: z.string().max(150).optional(),
  sku: z.string().min(1).max(100),
  barcode: z.string().max(100).optional(),
  countryId: z.string().max(36).optional(),
  currencyCode: z.string().length(3),
  basePrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
  moq: z.number().int().min(1).optional(),
  unit: z.string().max(30).optional(),
  purchaseIntent: z.enum(['B2B', 'B2C']).optional(),
  initialQuantity: z.number().int().nonnegative().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  images: z.array(z.object({ url: z.string().url(), altText: z.string().max(200).optional(), isPrimary: z.boolean().optional(), sortOrder: z.number().optional() })).max(20).optional(),
  variants: z.array(z.object({ name: z.string().min(1).max(200), sku: z.string().min(1).max(100), price: z.string().regex(/^\d+(\.\d{1,4})?$/), attributes: z.record(z.unknown()).optional() })).max(100).optional(),
  specifications: z.record(z.unknown()).optional(),
});

const listProductsSchema = z.object({
  q: z.string().max(200).optional(),
  categoryId: z.string().max(36).optional(),
  sellerId: z.string().max(36).optional(),
  sellerType: z.enum(['MERCHANT', 'SUPPLIER', 'COMPANY']).optional(),
  countryId: z.string().max(36).optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED', 'SUSPENDED']) });

const updateProductSchema = z.object({
  categoryId: z.string().min(1).optional(),
  name: z.string().min(2).max(250).optional(),
  nameAr: z.string().max(250).nullable().optional(),
  nameFr: z.string().max(250).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  brand: z.string().max(150).nullable().optional(),
  barcode: z.string().max(100).nullable().optional(),
  countryId: z.string().max(36).nullable().optional(),
  basePrice: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  moq: z.number().int().min(1).optional(),
  unit: z.string().max(30).optional(),
  purchaseIntent: z.enum(['B2B', 'B2C']).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const SELLER_TYPES = ['MERCHANT', 'SUPPLIER', 'COMPANY'] as const;

async function assertSellerOwnership(userId: string, sellerId: string, sellerType: string): Promise<void> {
  await assertSellerOwnershipDb(db, userId, sellerId, sellerType);
}

const myProductsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const productsRoutes = new Hono();

productsRoutes.get('/', validateQuery(listProductsSchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof listProductsSchema>>(c);
  const ctx = getContext(c);
  const result = await listProducts(ctx.db, query);
  return c.json({ success: true, data: result });
});

// Declared before `/:id` so "mine" is never parsed as a product id.
productsRoutes.get('/mine/entities', requireAuth, async (c) => {
  const ctx = getContext(c);
  const items = await listMySellerEntities(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

productsRoutes.get('/mine', requireAuth, validateQuery(myProductsQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof myProductsQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listMyProducts(ctx.db, ctx.user!.id, query);
  return c.json({ success: true, data: result });
});

productsRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const id = c.req.param('id');
  const product = await getProduct(ctx.db, id);
  return c.json({ success: true, data: product });
});

productsRoutes.post('/', requireAuth, validateBody(createProductSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof createProductSchema>>(c);
  const ctx = getContext(c);
  const user = ctx.user!;
  const sellerRole = body.sellerType as UserRole;

  // A user may publish under their own business entity only, unless admin.
  const isAdmin = user.roles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(r));
  if (!isAdmin) {
    const allowed = user.roles.includes(sellerRole as never) || user.roles.includes('MERCHANT' as never) || user.roles.includes('COMPANY' as never) || user.roles.includes('SUPPLIER' as never);
    if (!allowed) throw ApiError.forbidden();
    await assertSellerOwnership(user.id, body.sellerId, body.sellerType);
  }

  const result = await createProduct(ctx.db, body, { actorId: user.id, ipAddress: ctx.ipAddress });
  return c.json({ success: true, data: result }, 201 as never);
});

productsRoutes.patch('/:id/status', requireAuth, validateBody(statusSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof statusSchema>>(c);
  const ctx = getContext(c);
  const user = ctx.user!;
  const product = await getProduct(ctx.db, c.req.param('id')!);
  const isAdmin = user.roles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(r));

  if (!isAdmin) {
    // Only the owning seller may change status
    await assertSellerOwnership(user.id, product.sellerId, product.sellerType);
    // A seller may activate/unpublish their own listing, but must not be able to
    // lift an administrative suspension — otherwise an admin's enforcement
    // action is reversible by the party it applies to.
    if (product.status === 'SUSPENDED' && body.status !== 'SUSPENDED') {
      throw ApiError.forbidden('A suspended product can only be reactivated by an administrator');
    }
  }
  await updateProductStatus(ctx.db, product.id, body.status, { actorId: user.id });
  return c.json({ success: true });
});

productsRoutes.patch('/:id', requireAuth, validateBody(updateProductSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof updateProductSchema>>(c);
  const ctx = getContext(c);
  const user = ctx.user!;
  const product = await getProduct(ctx.db, c.req.param('id')!);

  const isAdmin = user.roles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(r));
  if (!isAdmin) {
    await assertSellerOwnership(user.id, product.sellerId, product.sellerType);
    // An administrative suspension is not lifted by editing content.
    if (product.status === 'SUSPENDED') {
      throw ApiError.forbidden('A suspended product can only be edited by an administrator');
    }
  }

  await updateProduct(ctx.db, product.id, body, { actorId: user.id, ipAddress: ctx.ipAddress });
  return c.json({ success: true });
});

// Admin-only: suspend/unpublish any product
productsRoutes.patch('/:id/suspend', requireAuth, requirePermission(PERM_PRODUCT_MANAGE), async (c) => {
  const ctx = getContext(c);
  const product = await getProduct(ctx.db, c.req.param('id')!);
  await updateProductStatus(ctx.db, product.id, 'SUSPENDED', { actorId: ctx.user!.id });
  return c.json({ success: true });
});