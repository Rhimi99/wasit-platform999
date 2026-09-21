import {
  boolean,
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

export const productStatusEnum = pgEnum('product_status', [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
  'SUSPENDED',
]);

export const sellerTypeEnum = pgEnum('seller_type', ['MERCHANT', 'SUPPLIER', 'COMPANY']);

export const categories = pgTable(
  'categories',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    parentId: varchar('parent_id', { length: 36 }),
    name: varchar('name', { length: 200 }).notNull(),
    nameAr: varchar('name_ar', { length: 200 }),
    nameFr: varchar('name_fr', { length: 200 }),
    slug: varchar('slug', { length: 250 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 200 }),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('categories_slug_idx').on(t.slug),
    parentIdx: index('categories_parent_idx').on(t.parentId),
  }),
);

export const products = pgTable(
  'products',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    categoryId: varchar('category_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 250 }).notNull(),
    nameAr: varchar('name_ar', { length: 250 }),
    nameFr: varchar('name_fr', { length: 250 }),
    slug: varchar('slug', { length: 300 }).notNull(),
    description: text('description'),
    brand: varchar('brand', { length: 150 }),
    sku: varchar('sku', { length: 100 }).notNull(),
    barcode: varchar('barcode', { length: 100 }),
    countryId: varchar('country_id', { length: 36 }),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    basePrice: numeric('base_price', { precision: 18, scale: 4 }).notNull(),
    moq: integer('moq').notNull().default(1),
    unit: varchar('unit', { length: 30 }).notNull().default('piece'),
    status: productStatusEnum('status').notNull().default('DRAFT'),
    isPublished: boolean('is_published').notNull().default(false),
    tags: jsonb('tags'),
    specifications: jsonb('specifications'),
    purchaseIntent: varchar('purchase_intent', { length: 10 }).notNull().default('B2B'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: index('products_slug_idx').on(t.slug),
    sellerIdx: index('products_seller_idx').on(t.sellerId, t.sellerType),
    categoryIdx: index('products_category_idx').on(t.categoryId),
    countryIdx: index('products_country_idx').on(t.countryId),
    statusIdx: index('products_status_idx').on(t.status),
    // The public catalogue lists `is_published AND status='ACTIVE'` ordered by
    // newest first; a single-column status index cannot serve both the filter
    // and the sort.
    publicCreatedIdx: index('products_public_created_idx').on(t.isPublished, t.status, t.createdAt),
    // Category browse applies the same visibility filter within one category.
    publicCategoryCreatedIdx: index('products_public_category_created_idx').on(
      t.categoryId,
      t.isPublished,
      t.status,
      t.createdAt,
    ),
  }),
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    productId: varchar('product_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    sku: varchar('sku', { length: 100 }).notNull(),
    price: numeric('price', { precision: 18, scale: 4 }).notNull(),
    attributes: jsonb('attributes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('variants_product_idx').on(t.productId),
    skuIdx: index('variants_sku_idx').on(t.sku),
  }),
);

export const productImages = pgTable(
  'product_images',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    productId: varchar('product_id', { length: 36 }).notNull(),
    url: text('url').notNull(),
    altText: varchar('alt_text', { length: 200 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('images_product_idx').on(t.productId),
  }),
);