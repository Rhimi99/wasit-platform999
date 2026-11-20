import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS, userHasAnyRole, type UserRole } from '@wasit/shared';
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

// Every inventory route requires authentication.
inventoryRoutes.use('*', requireAuth);

// Reads need only `inventory:read` (held by the seller roles and, read-only, by
// ADMIN). Writes additionally require the seller write permissions, so a
// read-only holder such as ADMIN can follow stock without being able to change
// it. `inventory:read:all` widens the read scope from the caller's own entity to
// every seller, and grants nothing on the write routes.
const inventoryRead = requirePermission(PERMISSIONS.INVENTORY_READ, PERMISSIONS.INVENTORY_READ_ALL);
const inventoryWrite = requirePermission(PERMISSIONS.INVENTORY_UPDATE, PERMISSIONS.INVENTORY_MOVEMENT_CREATE);

/** True when the caller may read inventory across every seller, not only its own. */
function canReadAllInventory(roles: UserRole[]): boolean {
  return userHasAnyRole(roles, PERMISSIONS.INVENTORY_READ_ALL);
}

/**
 * Resolves the seller scope a read must use. A seller sees its own entity; a
 * caller holding `inventory:read:all` (ADMIN) sees every seller — but only for
 * reads. Writes never call this and stay pinned to the caller's own entity.
 */
async function resolveReadScope(db: DB, user: { id: string; roles: UserRole[] }): Promise<string | null> {
  if (canReadAllInventory(user.roles)) return null;
  const sellerId = await resolveOwnedSellerId(db, user.id);
  if (!sellerId) {
    throw ApiError.forbidden('You do not own a supplier/merchant/company to manage inventory');
  }
  return sellerId;
}

/** Resolves the seller entity the current user owns (supplier/merchant/company). */
async function ownedSellerOrThrow(db: DB, userId: string): Promise<string> {
  const sellerId = await resolveOwnedSellerId(db, userId);
  if (!sellerId) {
    throw ApiError.forbidden('You do not own a supplier/merchant/company to manage inventory');
  }
  return sellerId;
}

inventoryRoutes.get('/', inventoryRead, async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = listQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const scope = await resolveReadScope(ctx.db, ctx.user!);
  const result = await listMyInventory(ctx.db, scope, query);
  return c.json({ success: true, data: result });
});

inventoryRoutes.get('/:id', inventoryRead, async (c) => {
  const ctx = getContext(c);
  const scope = await resolveReadScope(ctx.db, ctx.user!);
  const item = await getMyInventoryItem(ctx.db, scope, c.req.param('id')!);
  return c.json({ success: true, data: item });
});

inventoryRoutes.post('/:id/adjust', inventoryWrite, validateBody(adjustSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof adjustSchema>>(c);
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await adjustMyStock(ctx.db, sellerId, c.req.param('id')!, body, ctx.user!.id, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: result });
});

inventoryRoutes.patch('/:id', inventoryWrite, validateBody(setSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof setSchema>>(c);
  const sellerId = await ownedSellerOrThrow(ctx.db, ctx.user!.id);
  const result = await setMyStock(ctx.db, sellerId, c.req.param('id')!, body, ctx.user!.id, {
    ipAddress: ctx.ipAddress,
  });
  return c.json({ success: true, data: result });
});

inventoryRoutes.get('/:id/movements', inventoryRead, async (c) => {
  const ctx = getContext(c);
  const qs = c.req.query();
  const parsed = movementQuerySchema.safeParse(qs);
  const query = parsed.success ? parsed.data : {};
  const scope = await resolveReadScope(ctx.db, ctx.user!);
  const result = await listMyMovements(ctx.db, scope, c.req.param('id')!, query);
  return c.json({ success: true, data: result });
});