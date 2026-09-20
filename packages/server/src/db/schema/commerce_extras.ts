import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const inventoryMovementTypeEnum = pgEnum('inventory_movement_type', [
  'PURCHASE',
  'SALE',
  'ADJUSTMENT',
  'RETURN',
  'RESERVATION',
  'RELEASE',
]);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    productId: varchar('product_id', { length: 36 }).notNull(),
    productVariantId: varchar('product_variant_id', { length: 36 }),
    merchantId: varchar('merchant_id', { length: 36 }).notNull(),
    quantity: integer('quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: uniqueIndex('inventory_product_merchant_idx').on(t.productId, t.merchantId).where(sql`${t.productVariantId} is null`),
    variantIdx: uniqueIndex('inventory_product_variant_merchant_idx').on(t.productId, t.merchantId, t.productVariantId).where(sql`${t.productVariantId} is not null`),
    merchantIdx: index('inventory_merchant_idx').on(t.merchantId),
    productVariantIdx: index('inventory_variant_idx').on(t.productVariantId),
  }),
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    inventoryItemId: varchar('inventory_item_id', { length: 36 }).notNull(),
    movementType: inventoryMovementTypeEnum('movement_type').notNull(),
    quantityChange: integer('quantity_change').notNull(),
    reason: text('reason'),
    referenceType: varchar('reference_type', { length: 60 }),
    referenceId: varchar('reference_id', { length: 36 }),
    createdById: varchar('created_by_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemIdx: index('inventory_movements_item_idx').on(t.inventoryItemId),
    referenceIdx: index('inventory_movements_ref_idx').on(t.referenceType, t.referenceId),
  }),
);