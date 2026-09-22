import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import {
  categories,
  productImages,
  productVariants,
  products,
} from '../../db/schema/products.js';
import { writeAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { toDecimal, assertNonNegative } from '../../lib/money.js';
import { ensureInventoryItem } from '../../lib/inventory-engine.js';
import { inventoryItems } from '../../db/schema/commerce_extras.js';
import { resolveOwnedSellerIds, listOwnedSellerEntities, type OwnedSellerEntity } from '../../lib/seller-ownership.js';

export type SellerType = 'MERCHANT' | 'SUPPLIER' | 'COMPANY';

/** Normalizes optional localised names so a blank form field is stored as NULL, not ''. */
function blankToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface CreateProductInput {
  sellerId: string;
  sellerType: SellerType;
  categoryId: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  description?: string;
  brand?: string;
  sku: string;
  barcode?: string;
  countryId?: string;
  currencyCode: string;
  basePrice: string;
  moq?: number;
  unit?: string;
  purchaseIntent?: 'B2B' | 'B2C';
  images?: { url: string; altText?: string; isPrimary?: boolean; sortOrder?: number }[];
  variants?: { name: string; sku: string; price: string; attributes?: Record<string, unknown> }[];
  specifications?: Record<string, unknown>;
  /** Initial stock for the product inventory. Optional; defaults to 0. */
  initialQuantity?: number;
  lowStockThreshold?: number;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/** Lists the seller entities (supplier/merchant/company) owned by a user. */
export async function listMySellerEntities(db: DB, userId: string): Promise<OwnedSellerEntity[]> {
  return listOwnedSellerEntities(db, userId);
}

/** Lists every product owned by a user's business entities (any status). */
export async function listMyProducts(
  db: DB,
  userId: string,
  query: { page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const sellerIds = await resolveOwnedSellerIds(db, userId);
  if (sellerIds.length === 0) {
    return { items: [], pagination: { page, pageSize, total: 0 } };
  }

  const conditions = [inArray(products.sellerId, sellerIds)];
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(and(...conditions));

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      nameAr: products.nameAr,
      nameFr: products.nameFr,
      slug: products.slug,
      brand: products.brand,
      sku: products.sku,
      basePrice: products.basePrice,
      currencyCode: products.currencyCode,
      moq: products.moq,
      unit: products.unit,
      sellerId: products.sellerId,
      sellerType: products.sellerType,
      categoryId: products.categoryId,
      countryId: products.countryId,
      purchaseIntent: products.purchaseIntent,
      status: products.status,
      createdAt: products.createdAt,
    })
    .from(products)
    .where(and(...conditions))
    .orderBy(desc(products.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const productIds = rows.map((r) => r.id);
  const images = productIds.length > 0
    ? await db
        .select()
        .from(productImages)
        .where(and(inArray(productImages.productId, productIds), eq(productImages.isPrimary, true)))
    : [];
  const imageMap = new Map<string, string>();
  for (const img of images) imageMap.set(img.productId, img.url);

  return {
    items: rows.map((r) => ({ ...r, image: imageMap.get(r.id) ?? null })),
    pagination: { page, pageSize, total },
  };
}

export async function createProduct(
  db: DB,
  input: CreateProductInput,
  ctx: { actorId: string; ipAddress?: string | null },
): Promise<{ id: string }> {
  if (input.name.length < 2) {
    throw ApiError.validation([{ field: 'name', message: 'Name is too short', code: 'VALIDATION_FAILED' }]);
  }
  assertNonNegative(input.basePrice, 'basePrice');

  const sellerCheck = await db
    .select()
    .from(products)
    .where(and(eq(products.sellerId, input.sellerId), eq(products.sku, input.sku)))
    .limit(1);
  if (sellerCheck.length > 0) {
    throw ApiError.conflict('A product with this SKU already exists for this seller');
  }

  const productId = newId();
  const slug = slugify(input.name);

  await db.insert(products).values({
    id: productId,
    sellerId: input.sellerId,
    sellerType: input.sellerType,
    categoryId: input.categoryId,
    name: input.name,
    nameAr: blankToNull(input.nameAr),
    nameFr: blankToNull(input.nameFr),
    slug,
    description: input.description ?? null,
    brand: input.brand ?? null,
    sku: input.sku,
    barcode: input.barcode ?? null,
    countryId: input.countryId ?? null,
    currencyCode: input.currencyCode,
    basePrice: toDecimal(input.basePrice).toFixed(4),
    moq: input.moq ?? 1,
    unit: input.unit ?? 'piece',
    status: 'ACTIVE',
    isPublished: true,
    tags: null,
    specifications: input.specifications ? (input.specifications as unknown as Record<string, unknown>) : null,
    purchaseIntent: input.purchaseIntent ?? 'B2B',
  });

  if (input.images && input.images.length > 0) {
    await db.insert(productImages).values(
      input.images.map((img, i) => ({
        id: newId(),
        productId,
        url: img.url,
        altText: img.altText ?? null,
        isPrimary: img.isPrimary ?? (i === 0),
        sortOrder: img.sortOrder ?? i,
      })),
    );
  }

  if (input.variants && input.variants.length > 0) {
    await db.insert(productVariants).values(
      input.variants.map((v) => ({
        id: newId(),
        productId,
        name: v.name,
        sku: v.sku,
        price: toDecimal(v.price).toFixed(4),
        attributes: v.attributes ?? null,
      })),
    );
  }

  // Create an inventory record for the product (and each variant). Stock is always linked
  // to the product catalog so orders can validate availability atomically.
  const defaultThreshold = input.lowStockThreshold ?? input.moq ?? 5;
  const initialQty = input.initialQuantity ?? 0;
  if (!Number.isInteger(initialQty) || initialQty < 0) {
    throw ApiError.validation([{ field: 'initialQuantity', message: 'Initial quantity must be a non-negative integer', code: 'VALIDATION_FAILED' }]);
  }
  if (!Number.isInteger(defaultThreshold) || defaultThreshold < 0) {
    throw ApiError.validation([{ field: 'lowStockThreshold', message: 'Low stock threshold must be a non-negative integer', code: 'VALIDATION_FAILED' }]);
  }
  if (initialQty > 0) {
    await db.insert(inventoryItems).values({
      id: newId(),
      productId,
      productVariantId: null,
      merchantId: input.sellerId,
      quantity: initialQty,
      reservedQuantity: 0,
      lowStockThreshold: defaultThreshold,
    });
  } else {
    await ensureInventoryItem(db, productId, input.sellerId, null, defaultThreshold);
  }
  if (input.variants && input.variants.length > 0) {
    const variantRows = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
    for (const v of variantRows) {
      await db.insert(inventoryItems).values({
        id: newId(),
        productId,
        productVariantId: v.id,
        merchantId: input.sellerId,
        quantity: initialQty,
        reservedQuantity: 0,
        lowStockThreshold: defaultThreshold,
      });
    }
  }

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress }, {
    action: 'PRODUCT.CREATE',
    entityType: 'PRODUCT',
    entityId: productId,
    after: { name: input.name, sku: input.sku, sellerId: input.sellerId },
  });

  return { id: productId };
}

export interface ListProductsQuery {
  q?: string;
  categoryId?: string;
  sellerId?: string;
  sellerType?: SellerType;
  countryId?: string;
  minPrice?: string;
  maxPrice?: string;
  status?: string;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'popular';
  page?: number;
  pageSize?: number;
}

export async function listProducts(db: DB, query: ListProductsQuery) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const conditions = [eq(products.isPublished, true), eq(products.status, 'ACTIVE')];

  if (query.q) {
    conditions.push(
      sql`(${products.name} ILIKE ${`%${query.q}%`} OR ${products.nameAr} ILIKE ${`%${query.q}%`} OR ${products.nameFr} ILIKE ${`%${query.q}%`} OR ${products.description} ILIKE ${`%${query.q}%`})`,
    );
  }
  if (query.categoryId) conditions.push(eq(products.categoryId, query.categoryId));
  if (query.sellerId) conditions.push(eq(products.sellerId, query.sellerId));
  if (query.sellerType) conditions.push(eq(products.sellerType, query.sellerType));
  if (query.countryId) conditions.push(eq(products.countryId, query.countryId));
  if (query.minPrice) conditions.push(sql`${products.basePrice} >= ${query.minPrice}`);
  if (query.maxPrice) conditions.push(sql`${products.basePrice} <= ${query.maxPrice}`);

  const orderBy =
    query.sort === 'price_asc'
      ? [asc(products.basePrice)]
      : query.sort === 'price_desc'
        ? [desc(products.basePrice)]
        : [desc(products.createdAt)];

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(and(...conditions));

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      nameAr: products.nameAr,
      nameFr: products.nameFr,
      slug: products.slug,
      brand: products.brand,
      sku: products.sku,
      basePrice: products.basePrice,
      currencyCode: products.currencyCode,
      moq: products.moq,
      unit: products.unit,
      sellerId: products.sellerId,
      sellerType: products.sellerType,
      categoryId: products.categoryId,
      countryId: products.countryId,
      purchaseIntent: products.purchaseIntent,
      status: products.status,
      createdAt: products.createdAt,
    })
    .from(products)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const productIds = rows.map((r) => r.id);
  const images = productIds.length > 0
    ? await db
        .select()
        .from(productImages)
        .where(and(inArray(productImages.productId, productIds), eq(productImages.isPrimary, true)))
    : [];

  const imageMap = new Map<string, string>();
  for (const img of images) imageMap.set(img.productId, img.url);

  return {
    items: rows.map((r) => ({ ...r, image: imageMap.get(r.id) ?? null })),
    pagination: { page, pageSize, total },
  };
}

export async function getProduct(db: DB, productId: string) {
  const row = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (row.length === 0) throw ApiError.notFound('Product not found');
  const prod = row[0];

  const [imgs, variants, cat] = await Promise.all([
    db.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder)),
    db.select().from(productVariants).where(eq(productVariants.productId, productId)),
    prod.categoryId ? db.select().from(categories).where(eq(categories.id, prod.categoryId)).limit(1) : Promise.resolve([]),
  ]);

  return { ...prod, images: imgs, variants, category: cat[0] ?? null };
}

export async function updateProductStatus(
  db: DB,
  productId: string,
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'SUSPENDED',
  ctx: { actorId: string },
): Promise<void> {
  const existing = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (existing.length === 0) throw ApiError.notFound('Product not found');

  await db.update(products).set({ status, updatedAt: new Date() }).where(eq(products.id, productId));

  await writeAudit(db, { actorId: ctx.actorId }, {
    action: 'PRODUCT.STATUS_CHANGE',
    entityType: 'PRODUCT',
    entityId: productId,
    before: { status: existing[0].status },
    after: { status },
  });
}