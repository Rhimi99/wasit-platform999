import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  adjustMyStock,
  listMyInventory,
  getMyInventoryItem,
  setMyStock,
  listMyMovements,
  resolveOwnedSellerId,
} from './service.js';
import type { DB } from '../../db/client.js';

const adjustSchema = z.object({
  quantityChange: z.number().int().refine((v) => v !== 0, { message: 'must be non-zero' }),
  movementType: z.enum(['PURCHASE', 'SALE', 'ADJUSTMENT', 'RETURN']).optional(),
  reason: z.string().max(500).optional(),
});

const setSchema = z.object({
  quantity: z.number().int().nonnegative().optional(),
  reservedQuantity: z.number().int().nonnegative().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
}).refine((v) => v.quantity !== undefined || v.reservedQuantity !== undefined || v.lowStockThreshold !== undefined, {
  message: 'At least one field required',
});

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['LOW_STOCK', 'OUT_OF_STOCK', 'IN_STOCK', 'ALL']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const movementQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const inventoryRoutes = new Hono();

// All inventory routes require authentication and the seller roles with inventory permissions.
inventoryRoutes.use('*', requireAuth, requirePermission(
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.INVENTORY_UPDATE,
  PERMISSIONS.INVENTORY_MOVEMENT_CREATE,
));

/** Resolves the seller entity the current user owns (supplier/merchant/company). */
async function ownedSellerOrThrow(db: DB, userId: string): Promise<string> {
  const sellerId = await resolveOwnedSellerId(db, userId);
  if (!sellerId) {
    throw ApiError.forbidden('You do not own a supplier/merchant/company to manage inventory');
  }
  return sellerId;
}

inventoryRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await listMyInventory(ctx.db, sellerId, query);
  return c.json({ success: true, data: result });
});

inventoryRoutes.get('/:id', async (c) => {
  const ctx = getContext(c);
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const item = await getMyInventoryItem(ctx.db, sellerId, c.req.param('id')!);
  return c.json({ success: true, data: item });
});

inventoryRoutes.post('/:id/adjust', validateBody(adjustSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof adjustSchema>>(c);
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await adjustMyStock(ctx.db, sellerId, c.req.param('id')!, body, ctx.user!.id, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

inventoryRoutes.patch('/:id', validateBody(setSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof setSchema>>(c);
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await setMyStock(ctx.db, sellerId, c.req.param('id')!, body, ctx.user!.id, {
    ipAddress: ctx.ipAddress,
  });
  return c.json({ success: true, data: result });
});

inventoryRoutes.get('/:id/movements', async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = movementQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await listMyMovements(ctx.db, sellerId, c.req.param('id')!, query);
  return c.json({ success: true, data: result });
});