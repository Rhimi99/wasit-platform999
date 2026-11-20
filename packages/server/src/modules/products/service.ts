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
import { classifyListing, type GoodsClassification } from '../../lib/prohibited-goods.js';

export type SellerType = 'MERCHANT' | 'SUPPLIER' | 'COMPANY';

/**
 * LC-03 — the single enforcement point for the prohibited/restricted goods policy.
 *
 * Every listing is classified from its user-controllable text (names in all
 * locales, description, brand, category, and any extra free text such as specs
 * or variant names). The decision is recorded in the audit trail and then:
 *   - PROHIBITED  -> rejected outright, nothing is written;
 *   - RESTRICTED  -> accepted only as an unpublished DRAFT that no automated
 *                    caller can publish (a human reviewer must approve it);
 *   - ALLOWED     -> published as before.
 *
 * It lives in the service, not the route, so every entry point — HTTP, seed, a
 * future import job — is judged by the same rule and cannot bypass it by calling
 * the service directly.
 */
export interface ListingPolicyOutcome {
  classification: GoodsClassification;
  /** Status to persist: DRAFT for restricted, ACTIVE otherwise. */
  status: 'ACTIVE' | 'DRAFT';
  /** Whether the listing may be visible in the public catalogue. */
  isPublished: boolean;
}

export async function enforceListingPolicy(
  db: DB,
  fields: Parameters<typeof classifyListing>[0],
  ctx: { actorId: string | null; entityId?: string | null },
): Promise<ListingPolicyOutcome> {
  const classification = classifyListing(fields);

  if (classification.severity === 'PROHIBITED') {
    await writeAudit(db, { actorId: ctx.actorId }, {
      action: 'PRODUCT.PROHIBITED_REJECTED',
      entityType: 'PRODUCT',
      entityId: ctx.entityId ?? null,
      metadata: {
        ruleId: classification.ruleId,
        category: classification.category,
        reason: classification.reason,
      },
    });
    throw ApiError.prohibitedGoods(classification.reason ?? undefined, {
      ruleId: classification.ruleId,
      category: classification.category,
    });
  }

  if (classification.severity === 'RESTRICTED') {
    await writeAudit(db, { actorId: ctx.actorId }, {
      action: 'PRODUCT.RESTRICTED_REVIEW_REQUIRED',
      entityType: 'PRODUCT',
      entityId: ctx.entityId ?? null,
      metadata: {
        ruleId: classification.ruleId,
        category: classification.category,
        reason: classification.reason,
      },
    });
    return { classification, status: 'DRAFT', isPublished: false };
  }

  return { classification, status: 'ACTIVE', isPublished: true };
}


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

  // LC-03 — classify before any write. A prohibited listing throws (nothing is
  // inserted); a restricted one is forced to an unpublished DRAFT.
  const policy = await enforceListingPolicy(
    db,
    {
      name: input.name,
      nameAr: input.nameAr,
      nameFr: input.nameFr,
      description: input.description,
      brand: input.brand,
      category: input.categoryId,
      extraTexts: [
        ...(input.variants ?? []).map((v) => v.name),
        ...(input.images ?? []).map((img) => img.altText),
        input.specifications ? JSON.stringify(input.specifications) : null,
      ],
    },
    { actorId: ctx.actorId, entityId: productId },
  );

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
    status: policy.status,
    isPublished: policy.isPublished,
    tags: policy.classification.severity === 'ALLOWED'
      ? null
      : { lc03: { severity: policy.classification.severity, ruleId: policy.classification.ruleId, category: policy.classification.category } },
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
  ctx: { actorId: string; canReviewRestricted?: boolean },
): Promise<void> {
  const existing = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (existing.length === 0) throw ApiError.notFound('Product not found');

  // LC-03 — a listing that the policy classified as RESTRICTED stays unpublished
  // until a human reviewer approves it. Without that permission, activating such
  // a listing is refused here, in the service, so no route can publish it by
  // changing its status (including the admin suspend/reactivate path).
  const lc03 = (existing[0].tags as { lc03?: { severity?: string; ruleId?: string } } | null)?.lc03;
  if (lc03?.severity === 'RESTRICTED' && status === 'ACTIVE' && !ctx.canReviewRestricted) {
    await writeAudit(db, { actorId: ctx.actorId }, {
      action: 'PRODUCT.RESTRICTED_PUBLISH_BLOCKED',
      entityType: 'PRODUCT',
      entityId: productId,
      metadata: { ruleId: lc03.ruleId ?? null },
    });
    throw ApiError.restrictedGoodsReviewRequired('This listing is restricted and needs compliance approval before it can be activated');
  }

  await db.update(products).set({ status, updatedAt: new Date() }).where(eq(products.id, productId));

  await writeAudit(db, { actorId: ctx.actorId }, {
    action: 'PRODUCT.STATUS_CHANGE',
    entityType: 'PRODUCT',
    entityId: productId,
    before: { status: existing[0].status },
    after: { status },
  });
}

/**
 * LC-03 — human compliance review of a RESTRICTED listing.
 *
 * APPROVE clears the restriction marker and publishes the listing; REJECT
 * archives it. The caller must hold `catalog:compliance:review` (enforced at the
 * route); an automated agent never holds it, so this is the only path that can
 * clear a restricted listing — the publish guard in `updateProductStatus` cannot
 * be worked around by any other route.
 */
export async function reviewRestrictedListing(
  db: DB,
  productId: string,
  decision: 'APPROVE' | 'REJECT',
  ctx: { actorId: string; ipAddress?: string | null },
): Promise<void> {
  const existing = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (existing.length === 0) throw ApiError.notFound('Product not found');
  const before = existing[0];
  const lc03 = (before.tags as { lc03?: Record<string, unknown> } | null)?.lc03;
  if (!lc03 || lc03.severity !== 'RESTRICTED') {
    throw ApiError.validation([{ field: 'productId', message: 'Product is not awaiting a restricted-goods review', code: 'VALIDATION_FAILED' }]);
  }

  const approved = decision === 'APPROVE';
  await db
    .update(products)
    .set({
      status: approved ? 'ACTIVE' : 'ARCHIVED',
      isPublished: approved,
      tags: approved ? { lc03: { ...lc03, approved: true, approvedBy: ctx.actorId, approvedAt: new Date().toISOString() } } : before.tags,
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId));

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress }, {
    action: approved ? 'PRODUCT.RESTRICTED_APPROVED' : 'PRODUCT.RESTRICTED_REJECTED',
    entityType: 'PRODUCT',
    entityId: productId,
    before: { status: before.status },
    after: { status: approved ? 'ACTIVE' : 'ARCHIVED' },
    metadata: { ruleId: (lc03.ruleId as string | undefined) ?? null, category: (lc03.category as string | undefined) ?? null },
  });
}

export interface UpdateProductInput {
  categoryId?: string;
  name?: string;
  nameAr?: string | null;
  nameFr?: string | null;
  description?: string | null;
  brand?: string | null;
  barcode?: string | null;
  countryId?: string | null;
  basePrice?: string;
  moq?: number;
  unit?: string;
  purchaseIntent?: 'B2B' | 'B2C';
}

/**
 * Edits the descriptive/commercial fields of an existing product. Seller, SKU,
 * currency and stock are intentionally not editable here: changing them would
 * silently re-key an order history or move stock between owners, so stock stays
 * in the inventory module and identity stays fixed.
 */
export async function updateProduct(
  db: DB,
  productId: string,
  input: UpdateProductInput,
  ctx: { actorId: string; ipAddress?: string | null },
): Promise<void> {
  const existing = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (existing.length === 0) throw ApiError.notFound('Product not found');
  const before = existing[0];

  const patch: Record<string, unknown> = {};
  if (input.categoryId !== undefined) {
    const cat = await db.select().from(categories).where(eq(categories.id, input.categoryId)).limit(1);
    if (cat.length === 0) {
      throw ApiError.validation([{ field: 'categoryId', message: 'Unknown category', code: 'VALIDATION_FAILED' }]);
    }
    patch.categoryId = input.categoryId;
  }
  if (input.name !== undefined) {
    if (input.name.trim().length < 2) {
      throw ApiError.validation([{ field: 'name', message: 'Name is too short', code: 'VALIDATION_FAILED' }]);
    }
    patch.name = input.name;
    patch.slug = slugify(input.name);
  }
  if (input.nameAr !== undefined) patch.nameAr = blankToNull(input.nameAr);
  if (input.nameFr !== undefined) patch.nameFr = blankToNull(input.nameFr);
  if (input.description !== undefined) patch.description = blankToNull(input.description);
  if (input.brand !== undefined) patch.brand = blankToNull(input.brand);
  if (input.barcode !== undefined) patch.barcode = blankToNull(input.barcode);
  if (input.countryId !== undefined) patch.countryId = blankToNull(input.countryId);
  if (input.basePrice !== undefined) {
    assertNonNegative(input.basePrice, 'basePrice');
    patch.basePrice = toDecimal(input.basePrice).toFixed(4);
  }
  if (input.moq !== undefined) patch.moq = input.moq;
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.purchaseIntent !== undefined) patch.purchaseIntent = input.purchaseIntent;

  if (Object.keys(patch).length === 0) return;

  // LC-03 — re-classify the *resulting* listing, not just the changed fields, so
  // a seller cannot rename or re-describe an existing listing into a prohibited
  // or restricted one, nor edit a flagged listing back to a clean state. The
  // classification runs before the write and can throw (prohibited), leaving the
  // stored row untouched.
  const effective = {
    name: (patch.name as string | undefined) ?? before.name,
    nameAr: (patch.nameAr as string | null | undefined) ?? before.nameAr,
    nameFr: (patch.nameFr as string | null | undefined) ?? before.nameFr,
    description: (patch.description as string | null | undefined) ?? before.description,
    brand: (patch.brand as string | null | undefined) ?? before.brand,
    category: (patch.categoryId as string | undefined) ?? before.categoryId,
    extraTexts: [before.specifications ? JSON.stringify(before.specifications) : null],
  };
  const policy = await enforceListingPolicy(db, effective, { actorId: ctx.actorId, entityId: productId });
  if (policy.classification.severity === 'ALLOWED') {
    patch.tags = null;
  } else {
    patch.tags = {
      lc03: {
        severity: policy.classification.severity,
        ruleId: policy.classification.ruleId,
        category: policy.classification.category,
      },
    };
    // A listing that becomes restricted must not stay published.
    if (policy.classification.severity === 'RESTRICTED' && before.status === 'ACTIVE') {
      patch.status = 'DRAFT';
      patch.isPublished = false;
    }
  }

  patch.updatedAt = new Date();
  await db.update(products).set(patch).where(eq(products.id, productId));

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress }, {
    action: 'PRODUCT.UPDATE',
    entityType: 'PRODUCT',
    entityId: productId,
    before: {
      name: before.name,
      categoryId: before.categoryId,
      basePrice: before.basePrice,
      moq: before.moq,
      purchaseIntent: before.purchaseIntent,
    },
    after: {
      name: patch.name ?? before.name,
      categoryId: patch.categoryId ?? before.categoryId,
      basePrice: patch.basePrice ?? before.basePrice,
      moq: patch.moq ?? before.moq,
      purchaseIntent: patch.purchaseIntent ?? before.purchaseIntent,
    },
  });
}