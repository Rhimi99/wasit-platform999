import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../db/client';
import { inventoryItems, inventoryMovements } from '../db/schema/commerce_extras';
import { createNotification } from './notifications-service';
import { resolveSellerUserId } from './seller-ownership';
import { newId } from './ids';

export type MovementType = 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION' | 'RELEASE';

export interface InventoryItemRecord {
  id: string;
  productId: string;
  productVariantId: string | null;
  merchantId: string;
  quantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Inventory Engine: manages stock levels, reserved quantities, and movements
 * with a full auditable history. Low-stock notifications are created.
 * Stock is tracked per (product, variant?, merchant) — never shared across sellers.
 */
export async function ensureInventoryItem(
  db: DB,
  productId: string,
  merchantId: string,
  productVariantId?: string | null,
  lowStockThreshold = 5,
): Promise<InventoryItemRecord> {
  const existing = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.productId, productId),
        eq(inventoryItems.merchantId, merchantId),
        productVariantId
          ? eq(inventoryItems.productVariantId, productVariantId)
          : sql`${inventoryItems.productVariantId} is null`,
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return existing[0] as InventoryItemRecord;
  }

  const id = newId();
  await db.insert(inventoryItems).values({
    id,
    productId,
    merchantId,
    productVariantId: productVariantId ?? null,
    lowStockThreshold,
  });
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1);
  return rows[0] as InventoryItemRecord;
}

export async function getInventory(
  db: DB,
  productId: string,
  merchantId: string,
  productVariantId?: string,
) {
  return ensureInventoryItem(db, productId, merchantId, productVariantId);
}

export interface StockMovementInput {
  movementType: MovementType;
  quantityChange: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  createdById: string;
}

/** Applies a stock movement atomically, recording history and emitting low-stock notifications. */
export async function applyStockMovement(
  db: DB,
  productId: string,
  merchantId: string,
  input: StockMovementInput,
) {
  if (input.quantityChange === 0) {
    throw ApiError.validation([{ field: 'quantityChange', message: 'Quantity change must be non-zero', code: 'VALIDATION_FAILED' }]);
  }

  const item = await ensureInventoryItem(db, productId, merchantId);

  const previousQuantity = item.quantity;
  const newQuantity = previousQuantity + input.quantityChange;
  if (newQuantity < 0) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock');
  }

  // Atomic guarded increment: rejects concurrent movements that would drive stock
  // negative (row-level lock on the item) instead of relying on a read-then-write.
  const updated = await db
    .update(inventoryItems)
    .set({
      quantity: sql`${inventoryItems.quantity} + ${input.quantityChange}`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(inventoryItems.id, item.id),
      sql`${inventoryItems.quantity} + ${input.quantityChange} >= 0`,
    ))
    .returning({ quantity: inventoryItems.quantity });

  if (updated.length === 0) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock');
  }
  const committedQuantity = updated[0].quantity;

  await db.insert(inventoryMovements).values({
    id: newId(),
    inventoryItemId: item.id,
    movementType: input.movementType,
    quantityChange: input.quantityChange,
    reason: input.reason ?? null,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    createdById: input.createdById,
  });

  await emitStockNotifications(db, item.id, previousQuantity, committedQuantity);

  return { itemId: item.id, newQuantity: committedQuantity };
}

/** Stock status bucket used to detect transitions between movements. */
type StockStatus = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'IN_STOCK';

function stockStatus(quantity: number, threshold: number): StockStatus {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  if (quantity <= threshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/**
 * Emits stock notifications based on the status transition between the previous
 * and the new quantity, so a seller is notified once when entering a warning
 * state and again only after recovering and dropping back into it:
 *
 * - IN_STOCK  -> LOW_STOCK     : low-stock alert
 * - IN_STOCK  -> OUT_OF_STOCK  : out-of-stock alert
 * - LOW_STOCK -> OUT_OF_STOCK  : out-of-stock alert (now fully depleted)
 * - any       -> same status   : no notification (avoids duplicates)
 *
 * `previousThreshold` allows callers that also change the threshold in the same
 * operation to compute the old status against the old boundary.
 * The notification is delivered to the user who owns the inventory seller entity.
 */
export async function emitStockNotifications(
  db: DB,
  itemId: string,
  previousQuantity: number,
  newQuantity: number,
  previousThreshold?: number,
) {
  const item = await db.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
  if (item.length === 0) return;

  const threshold = item[0].lowStockThreshold;
  const previousStatus = stockStatus(previousQuantity, previousThreshold ?? threshold);
  const nextStatus = stockStatus(newQuantity, threshold);

  // Only notify on a downward transition into a warning state — recovery back to
  // IN_STOCK is silent, but re-arms the item so a later drop notifies again.
  if (nextStatus === previousStatus || nextStatus === 'IN_STOCK') return;

  const userId = await resolveSellerUserId(db, item[0].merchantId);
  if (!userId) return;

  const { productId, productVariantId } = item[0];
  if (nextStatus === 'OUT_OF_STOCK') {
    await createNotification(db, {
      userId,
      type: 'INVENTORY_OUT_OF_STOCK',
      title: 'Out of stock',
      body: `Product ${productId} is out of stock`,
      data: { productId, productVariantId, quantity: newQuantity, threshold, status: nextStatus },
    });
  } else {
    await createNotification(db, {
      userId,
      type: 'INVENTORY_LOW_STOCK',
      title: 'Low stock',
      body: `Product ${productId} is low on stock (${newQuantity} left, threshold ${threshold})`,
      data: { productId, productVariantId, quantity: newQuantity, threshold, status: nextStatus },
    });
  }
}

export async function reserveStock(
  db: DB,
  productId: string,
  merchantId: string,
  quantity: number,
  referenceId?: string,
  createdById?: string,
) {
  const item = await ensureInventoryItem(db, productId, merchantId);
  if (item.quantity - item.reservedQuantity < quantity) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient available stock');
  }
  const newReserved = item.reservedQuantity + quantity;
  await db
    .update(inventoryItems)
    .set({ reservedQuantity: newReserved, updatedAt: new Date() })
    .where(eq(inventoryItems.id, item.id));

  await db.insert(inventoryMovements).values({
    id: newId(),
    inventoryItemId: item.id,
    movementType: 'RESERVATION',
    quantityChange: quantity,
    reason: 'Order reservation',
    referenceType: 'ORDER',
    referenceId: referenceId ?? null,
    createdById: createdById ?? 'system',
  });
  return newReserved;
}

export async function releaseReservation(
  db: DB,
  productId: string,
  merchantId: string,
  quantity: number,
  referenceId?: string,
) {
  const item = await ensureInventoryItem(db, productId, merchantId);
  const newReserved = Math.max(0, item.reservedQuantity - quantity);
  await db
    .update(inventoryItems)
    .set({ reservedQuantity: newReserved, updatedAt: new Date() })
    .where(eq(inventoryItems.id, item.id));

  await db.insert(inventoryMovements).values({
    id: newId(),
    inventoryItemId: item.id,
    movementType: 'RELEASE',
    quantityChange: -quantity,
    reason: 'Release reservation',
    referenceType: 'ORDER',
    referenceId: referenceId ?? null,
    createdById: 'system',
  });
  return newReserved;
}

/**
 * Commits a reservation as a real SALE (decrement) when an order is confirmed.
 * - Decrements the on-hand stock by quantity.
 * - Releases the corresponding reservation.
 * - Records movement `SALE` with referenceType=ORDER.
 */
export async function commitReservationToSale(
  db: DB,
  productId: string,
  merchantId: string,
  quantity: number,
  orderId?: string,
) {
  const item = await ensureInventoryItem(db, productId, merchantId);
  const saleQty = Math.min(quantity, item.reservedQuantity);
  if (saleQty <= 0) {
    // No reservation existed — apply as plain SALE movement if stock permits.
    if (item.quantity < quantity) {
      throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock');
    }
    await applyStockMovement(db, productId, merchantId, {
      movementType: 'SALE',
      quantityChange: -quantity,
      reason: 'Order confirmed',
      referenceType: 'ORDER',
      referenceId: orderId ?? undefined,
      createdById: 'system',
    });
    return item.id;
  }

  const newQuantity = item.quantity - saleQty;
  const newReserved = item.reservedQuantity - saleQty;
  if (newQuantity < 0) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock');

  await db
    .update(inventoryItems)
    .set({ quantity: newQuantity, reservedQuantity: newReserved, updatedAt: new Date() })
    .where(eq(inventoryItems.id, item.id));

  await db.insert(inventoryMovements).values({
    id: newId(),
    inventoryItemId: item.id,
    movementType: 'SALE',
    quantityChange: -saleQty,
    reason: 'Order confirmed',
    referenceType: 'ORDER',
    referenceId: orderId ?? null,
    createdById: 'system',
  });

  await emitStockNotifications(db, item.id, item.quantity, newQuantity);
  return item.id;
}

/**
 * Restores stock when an order is cancelled (reinstates the quantity previously reserved/sold).
 * The quantity is added back as RETURN movement and any remaining reservation released.
 */
export async function restoreStockForCancelledOrder(
  db: DB,
  productId: string,
  merchantId: string,
  quantity: number,
  orderId?: string,
) {
  const item = await ensureInventoryItem(db, productId, merchantId);
  const newQuantity = item.quantity + quantity;
  const newReserved = Math.max(0, item.reservedQuantity - quantity);

  await db
    .update(inventoryItems)
    .set({ quantity: newQuantity, reservedQuantity: newReserved, updatedAt: new Date() })
    .where(eq(inventoryItems.id, item.id));

  await db.insert(inventoryMovements).values({
    id: newId(),
    inventoryItemId: item.id,
    movementType: 'RETURN',
    quantityChange: quantity,
    reason: 'Order cancelled',
    referenceType: 'ORDER',
    referenceId: orderId ?? null,
    createdById: 'system',
  });

  await emitStockNotifications(db, item.id, item.quantity, newQuantity);
  return item.id;
}

export async function getMovements(
  db: DB,
  productId: string,
  merchantId: string,
  productVariantId?: string,
) {
  const item = await ensureInventoryItem(db, productId, merchantId, productVariantId);
  return db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.inventoryItemId, item.id))
    .orderBy(inventoryMovements.createdAt);
}