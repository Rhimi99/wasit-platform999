import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { inventoryItems, inventoryMovements } from '../../db/schema/commerce_extras';
import { products, productVariants } from '../../db/schema/products';
import { applyStockMovement, emitStockNotifications } from '../../lib/inventory-engine';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';

export interface InventoryListQuery {
  q?: string;
  status?: 'LOW_STOCK' | 'OUT_OF_STOCK' | 'IN_STOCK' | 'ALL';
  page?: number;
  pageSize?: number;
}

export function normalizePage(value: number | undefined, def = 1, maxSize = 100): { page: number; pageSize: number } {
  const page = Math.max(1, value ?? 1);
  const pageSize = Math.min(maxSize, Math.max(1, def));
  return { page, pageSize: 50 };
}

/** Resolves the seller entity (supplier/merchant/company id) owned by the user. */
export async function resolveOwnedSellerId(db: DB, userId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where user_id = ${userId} limit 1
  `) as never;
  const r = rows as unknown as { rows: { id: string }[] };
  return r.rows[0]?.id ?? null;
}

export async function listMyInventory(
  db: DB,
  sellerId: string,
  query: InventoryListQuery = {},
): Promise<{ items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number }> {
  const { page, pageSize } = normalizePage(query.page);

  const conditions: ReturnType<typeof sql>[] = [eq(inventoryItems.merchantId, sellerId)];

  if (query.q) {
    conditions.push(sql`(
      ${inventoryItems.productId} in (
        select p.id from products p
        where p.name ilike ${`%${query.q}%`}
           or p.sku ilike ${`%${query.q}%`}
           or p.name_ar ilike ${`%${query.q}%`}
      )
    )`);
  }

  if (query.status && query.status !== 'ALL') {
    if (query.status === 'OUT_OF_STOCK') {
      conditions.push(eq(inventoryItems.quantity, 0));
    } else if (query.status === 'LOW_STOCK') {
      conditions.push(sql`${inventoryItems.quantity} > 0 and ${inventoryItems.quantity} <= ${inventoryItems.lowStockThreshold}`);
    } else if (query.status === 'IN_STOCK') {
      conditions.push(sql`${inventoryItems.quantity} > ${inventoryItems.lowStockThreshold}`);
    }
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryItems)
    .where(and(...conditions));

  const rows = await db
    .select({
      id: inventoryItems.id,
      productId: inventoryItems.productId,
      productVariantId: inventoryItems.productVariantId,
      merchantId: inventoryItems.merchantId,
      quantity: inventoryItems.quantity,
      reservedQuantity: inventoryItems.reservedQuantity,
      lowStockThreshold: inventoryItems.lowStockThreshold,
      updatedAt: inventoryItems.updatedAt,
      productName: products.name,
      productNameAr: products.nameAr,
      productSku: products.sku,
      productStatus: products.status,
      variantSku: productVariants.sku,
      variantName: productVariants.name,
      currencyCode: products.currencyCode,
      basePrice: products.basePrice,
    })
    .from(inventoryItems)
    .innerJoin(products, eq(products.id, inventoryItems.productId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryItems.productVariantId))
    .where(and(...conditions))
    .orderBy(desc(inventoryItems.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const items = rows.map((r) => ({
    ...r,
    availableQuantity: r.quantity - r.reservedQuantity,
    lowStock: r.quantity > 0 && r.quantity <= r.lowStockThreshold,
    outOfStock: r.quantity === 0,
  }));

  return { items, total: Number(total), page, pageSize };
}

export async function getMyInventoryItem(db: DB, sellerId: string, itemId: string) {
  const item = await db.select().from(inventoryItems).where(and(
    eq(inventoryItems.id, itemId),
    eq(inventoryItems.merchantId, sellerId),
  )).limit(1);
  if (item.length === 0) throw ApiError.notFound('Inventory item not found');

  const product = await db.select().from(products).where(eq(products.id, item[0].productId)).limit(1);
  let variant: typeof productVariants.$inferSelect | null = null;
  if (item[0].productVariantId) {
    const v = await db.select().from(productVariants).where(eq(productVariants.id, item[0].productVariantId!)).limit(1);
    variant = v[0] ?? null;
  }

  return {
    ...item[0],
    availableQuantity: item[0].quantity - item[0].reservedQuantity,
    lowStock: item[0].quantity > 0 && item[0].quantity <= item[0].lowStockThreshold,
    outOfStock: item[0].quantity === 0,
    product: product[0] ?? null,
    variant,
  };
}

export interface AdjustStockInput {
  quantityChange: number;
  movementType?: 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'RETURN';
  reason?: string;
}

export async function adjustMyStock(
  db: DB,
  sellerId: string,
  itemId: string,
  input: AdjustStockInput,
  actorId: string,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
) {
  const item = await getMyInventoryItem(db, sellerId, itemId);
  if (item.product?.status === 'ARCHIVED') {
    throw ApiError.conflict('Product is archived — stock cannot be modified');
  }

  if (!Number.isInteger(input.quantityChange) || input.quantityChange === 0) {
    throw ApiError.validation([{ field: 'quantityChange', message: 'Quantity change must be a non-zero integer', code: 'VALIDATION_FAILED' }]);
  }

  const before = item.quantity;
  const result = await applyStockMovement(db, item.productId, sellerId, {
    movementType: input.movementType ?? (input.quantityChange > 0 ? 'PURCHASE' : 'SALE'),
    quantityChange: input.quantityChange,
    reason: input.reason,
    referenceType: item.productVariantId ? 'VARIANT' : 'PRODUCT',
    referenceId: item.productVariantId ?? item.productId,
    createdById: actorId,
  });

  await writeAudit(db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'INVENTORY.ADJUST',
    entityType: 'INVENTORY_ITEM',
    entityId: item.id,
    before: { quantity: before },
    after: { quantity: result.newQuantity, movementType: input.movementType ?? null },
    metadata: { itemId: item.id, productId: item.productId },
  });

  return result;
}

export interface SetStockInput {
  quantity?: number;
  reservedQuantity?: number;
  lowStockThreshold?: number;
}

export async function setMyStock(
  db: DB,
  sellerId: string,
  itemId: string,
  input: SetStockInput,
  actorId: string,
  ctx: { ipAddress?: string | null },
) {
  const item = await getMyInventoryItem(db, sellerId, itemId);

  const next = {
    quantity: input.quantity ?? item.quantity,
    reservedQuantity: input.reservedQuantity ?? item.reservedQuantity,
    lowStockThreshold: input.lowStockThreshold ?? item.lowStockThreshold,
  };

  for (const [k, v] of Object.entries(next)) {
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw ApiError.validation([{ field: k, message: `${k} must be a non-negative integer`, code: 'VALIDATION_FAILED' }]);
    }
  }
  if (next.quantity < next.reservedQuantity) {
    throw ApiError.conflict('Quantity cannot be lower than reserved quantity');
  }

  const before = {
    quantity: item.quantity,
    reservedQuantity: item.reservedQuantity,
    lowStockThreshold: item.lowStockThreshold,
  };

  await db.update(inventoryItems)
    .set({
      quantity: next.quantity,
      reservedQuantity: next.reservedQuantity,
      lowStockThreshold: next.lowStockThreshold,
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, item.id));

  // Record a corrective movement if quantity changed.
  if (next.quantity !== before.quantity) {
    await db.insert(inventoryMovements).values({
      id: newId(),
      inventoryItemId: item.id,
      movementType: 'ADJUSTMENT',
      quantityChange: next.quantity - before.quantity,
      reason: 'Manual stock set',
      referenceType: item.productVariantId ? 'VARIANT' : 'PRODUCT',
      referenceId: item.productVariantId ?? item.productId,
      createdById: actorId,
    });

    // A manual set can cross the low-stock boundary too — same transition rules.
    await emitStockNotifications(db, item.id, before.quantity, next.quantity, before.lowStockThreshold);
  }

  await writeAudit(db, { actorId, ipAddress: ctx.ipAddress }, {
    action: 'INVENTORY.UPDATE',
    entityType: 'INVENTORY_ITEM',
    entityId: item.id,
    before,
    after: next,
    metadata: { productId: item.productId },
  });

  return { itemId: item.id, ...next };
}

export async function listMyMovements(
  db: DB,
  sellerId: string,
  itemId: string,
  query: { page?: number } = {},
) {
  const item = await getMyInventoryItem(db, sellerId, itemId);
  const { page, pageSize } = normalizePage(query.page);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.inventoryItemId, item.id));

  const rows = await db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.inventoryItemId, item.id))
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { items: rows, total: Number(total), page, pageSize };
}