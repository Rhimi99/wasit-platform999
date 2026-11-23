import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { mediaAssets } from '../../db/schema/media.js';
import { productImages, products } from '../../db/schema/products.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { assertSellerOwnership, resolveSellerUserId } from '../../lib/seller-ownership.js';
import { newId } from '../../lib/ids.js';
import { env } from '../../lib/env.js';
import { buildImageDerivative } from '../../lib/media/image-derivative.js';
import { hasPathTraversal, probeImage } from '../../lib/media/image-probe.js';
import { resolveMediaStorage } from '../../lib/media/resolve.js';

/**
 * Product images — upload, link, delete.
 *
 * The binary lives in the same private media store as marketing videos; only
 * its metadata row (`media_assets`, kind IMAGE) and the public link in
 * `product_images` are persisted. Because the storefront is public, the read
 * path is a separate endpoint authorized by the *product's* visibility rather
 * than by the uploader's session, and it never reveals a storage key.
 */

/** Multipart overhead (boundaries, part headers) allowed on top of the image. */
export const PRODUCT_IMAGE_UPLOAD_ENVELOPE_BYTES = 65_536;

export interface ProductImageUploadInput {
  productId: string;
  bytes: Buffer;
  /** Client-declared name; only used to refuse traversal, never for storage. */
  filename?: string | null;
  altText?: string | null;
  isPrimary?: boolean;
}

export interface ProductImageView {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

/** Public, host-independent link stored in `product_images.url`. */
export function productImageUrl(productId: string, assetId: string): string {
  return `/api/media/products/${productId}/images/${assetId}/content`;
}

function assetIdFromUrl(url: string): string | null {
  return /\/images\/([0-9a-f-]{36})\/content$/.exec(url)?.[1] ?? null;
}

function toView(row: typeof mediaAssets.$inferSelect, link: typeof productImages.$inferSelect): ProductImageView {
  return {
    id: row.id,
    productId: link.productId,
    url: link.url,
    altText: link.altText,
    isPrimary: link.isPrimary,
    sortOrder: link.sortOrder,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadOwnedProduct(db: DB, productId: string, userId: string, roles: UserRole[]) {
  const rows = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Product not found');
  const product = rows[0];
  const isAdmin = roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    // `products.sellerId` is an entity id, never a user id: ownership has to be
    // resolved through the seller table or a merchant could edit a peer's
    // catalog by guessing the entity id.
    await assertSellerOwnership(db, userId, product.sellerId, product.sellerType);
  }
  return product;
}

async function loadOwnedImage(db: DB, assetId: string, userId: string, roles: UserRole[]) {
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  const asset = rows[0];
  const productId = asset?.productId;
  if (!asset || asset.kind !== 'IMAGE' || !productId) {
    throw ApiError.notFound('Image not found');
  }
  const product = await loadOwnedProduct(db, productId, userId, roles);
  return { asset, product };
}

async function linkedRow(db: DB, assetId: string) {
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (rows.length === 0 || !rows[0].productId) return null;
  const links = await db
    .select()
    .from(productImages)
    .where(eq(productImages.url, productImageUrl(rows[0].productId, assetId)))
    .limit(1);
  return links[0] ?? null;
}

/**
 * Validates, stores and links one product image.
 *
 * Every refusal happens before anything is written: the bytes are sniffed (the
 * declared type and filename are ignored), the dimensions must parse, the size
 * and per-product count are bounded, and the caller must own the product.
 */
export async function uploadProductImage(
  db: DB,
  actor: { userId: string; roles: UserRole[] },
  input: ProductImageUploadInput,
  audit: Omit<AuditContext, 'actorId'>,
): Promise<ProductImageView> {
  if (input.filename && hasPathTraversal(input.filename)) {
    throw ApiError.validation([{ field: 'file', message: 'Invalid file name', code: 'INVALID_FILENAME' }]);
  }
  if (input.bytes.length === 0) {
    throw ApiError.validation([{ field: 'file', message: 'The file is empty', code: 'EMPTY_FILE' }]);
  }
  if (input.bytes.length > env.MEDIA_MAX_IMAGE_BYTES) {
    throw ApiError.payloadTooLarge(
      `The image exceeds the ${Math.floor(env.MEDIA_MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`,
    );
  }

  const probe = probeImage(input.bytes);
  if (!probe) {
    throw new ApiError(
      422,
      'UNPROCESSABLE_ENTITY',
      'Unsupported image. Upload a JPEG, PNG or WebP photo (SVG, HTML and other files are refused).',
    );
  }

  const product = await loadOwnedProduct(db, input.productId, actor.userId, actor.roles);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.productId, product.id),
        eq(mediaAssets.kind, 'IMAGE'),
        eq(mediaAssets.status, 'READY'),
      ),
    );
  if (count >= env.MEDIA_MAX_IMAGES_PER_PRODUCT) {
    throw new ApiError(
      422,
      'UNPROCESSABLE_ENTITY',
      `This product already has the maximum of ${env.MEDIA_MAX_IMAGES_PER_PRODUCT} images`,
    );
  }

  // Downscale for the storefront when the original is larger than the display
  // bound. A failed conversion keeps the validated original rather than
  // failing an otherwise valid upload.
  const derivative = await buildImageDerivative(input.bytes, probe.mimeType, env.MEDIA_IMAGE_MAX_DIMENSION);
  const storedBytes = derivative?.bytes ?? input.bytes;
  const storedProbe = derivative ?? probe;
  const provider = derivative ? 'ffmpeg' : 'original';

  const assetId = newId();
  const storageKey = `products/${product.id}/${assetId}.${storedProbe.extension}`;
  const storage = resolveMediaStorage();
  await storage.put({ key: storageKey, body: storedBytes, contentType: storedProbe.mimeType });

  const ownerUserId = (await resolveSellerUserId(db, product.sellerId)) ?? actor.userId;
  const altText = input.altText?.trim() ? input.altText.trim().slice(0, 200) : null;

  try {
    const created = await db.transaction(async (tx) => {
      const [asset] = await tx
        .insert(mediaAssets)
        .values({
          id: assetId,
          ownerUserId,
          kind: 'IMAGE',
          status: 'READY',
          title: `${product.name}`.slice(0, 250),
          productId: product.id,
          storageKey,
          mimeType: storedProbe.mimeType,
          extension: storedProbe.extension,
          sizeBytes: storedBytes.length,
          width: String(storedProbe.width),
          height: String(storedProbe.height),
          provider,
          language: 'en',
          generationSpec: { uploadedBy: actor.userId, originalBytes: input.bytes.length },
        })
        .returning();

      const existing = await tx
        .select({ id: productImages.id, isPrimary: productImages.isPrimary, sortOrder: productImages.sortOrder })
        .from(productImages)
        .where(eq(productImages.productId, product.id));
      const hasPrimary = existing.some((r) => r.isPrimary);
      const makePrimary = input.isPrimary === true || !hasPrimary;
      if (makePrimary) {
        await tx.update(productImages).set({ isPrimary: false }).where(eq(productImages.productId, product.id));
      }
      const nextOrder = existing.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
      const [link] = await tx
        .insert(productImages)
        .values({
          id: newId(),
          productId: product.id,
          url: productImageUrl(product.id, assetId),
          altText,
          sortOrder: nextOrder,
          isPrimary: makePrimary,
        })
        .returning();

      return { asset, link };
    });

    await writeAudit(db, { actorId: actor.userId, ...audit }, {
      action: 'MEDIA.PRODUCT_IMAGE_UPLOADED',
      entityType: 'MEDIA_ASSET',
      entityId: assetId,
      after: {
        productId: product.id,
        mimeType: storedProbe.mimeType,
        width: storedProbe.width,
        height: storedProbe.height,
        sizeBytes: storedBytes.length,
        provider,
        isPrimary: created.link.isPrimary,
      },
    });

    return toView(created.asset, created.link);
  } catch (err) {
    await storage.delete(storageKey).catch(() => {});
    throw err;
  }
}

/** Makes one of the product's images the cover. */
export async function setPrimaryProductImage(
  db: DB,
  actor: { userId: string; roles: UserRole[] },
  assetId: string,
  audit: Omit<AuditContext, 'actorId'>,
): Promise<ProductImageView> {
  const { asset } = await loadOwnedImage(db, assetId, actor.userId, actor.roles);
  const link = await linkedRow(db, assetId);
  if (!link) throw ApiError.notFound('Image not found');
  const productId = link.productId;

  const updated = await db.transaction(async (tx) => {
    await tx.update(productImages).set({ isPrimary: false }).where(eq(productImages.productId, productId));
    const [row] = await tx
      .update(productImages)
      .set({ isPrimary: true })
      .where(eq(productImages.id, link.id))
      .returning();
    return row;
  });

  await writeAudit(db, { actorId: actor.userId, ...audit }, {
    action: 'MEDIA.PRODUCT_IMAGE_PRIMARY_SET',
    entityType: 'MEDIA_ASSET',
    entityId: assetId,
    after: { productId },
  });

  return toView(asset, updated);
}

/**
 * Deletes an image and its link. The product itself is never touched, and when
 * the removed image was the cover the next remaining image is promoted so the
 * catalog card does not silently lose its picture.
 */
export async function deleteProductImage(
  db: DB,
  actor: { userId: string; roles: UserRole[] },
  assetId: string,
  audit: Omit<AuditContext, 'actorId'>,
): Promise<void> {
  const { asset } = await loadOwnedImage(db, assetId, actor.userId, actor.roles);
  const link = await linkedRow(db, assetId);
  if (!link) throw ApiError.notFound('Image not found');

  await db.transaction(async (tx) => {
    await tx.delete(productImages).where(eq(productImages.id, link.id));
    if (link.isPrimary) {
      const [next] = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, link.productId))
        .orderBy(asc(productImages.sortOrder))
        .limit(1);
      if (next) {
        await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, next.id));
      }
    }
    await tx
      .update(mediaAssets)
      .set({ status: 'DELETED', storageKey: null, updatedAt: new Date() })
      .where(eq(mediaAssets.id, assetId));
  });

  if (asset.storageKey) {
    await resolveMediaStorage().delete(asset.storageKey).catch(() => {});
  }

  await writeAudit(db, { actorId: actor.userId, ...audit }, {
    action: 'MEDIA.PRODUCT_IMAGE_DELETED',
    entityType: 'MEDIA_ASSET',
    entityId: assetId,
    before: { productId: link.productId, url: link.url, isPrimary: link.isPrimary },
  });
}

/** Lists a product's images in display order (owner/staff view). */
export async function listProductImages(
  db: DB,
  actor: { userId: string; roles: UserRole[] },
  productId: string,
): Promise<ProductImageView[]> {
  await loadOwnedProduct(db, productId, actor.userId, actor.roles);
  const links = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder));
  if (links.length === 0) return [];
  const ids = links.map((l) => assetIdFromUrl(l.url)).filter((v): v is string => Boolean(v));
  const assets = ids.length
    ? await db.select().from(mediaAssets).where(and(inArray(mediaAssets.id, ids), eq(mediaAssets.status, 'READY')))
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  return links
    .map((l) => {
      const id = assetIdFromUrl(l.url);
      const asset = id ? byId.get(id) : undefined;
      return asset ? toView(asset, l) : null;
    })
    .filter((v): v is ProductImageView => v !== null);
}

/**
 * Serves a product image.
 *
 * Authorization is the product's, not the uploader's: the asset must belong to
 * the requested product, be linked in `product_images`, and the product must be
 * published and ACTIVE. Anything else is a 404, so an unpublished draft cannot
 * be enumerated through image ids.
 *
 * The seller's own dashboard renders the same URL, so an authenticated owner
 * (or platform staff) may read a non-public product's image; the response is
 * then marked private instead of cacheable.
 */
export async function openPublicProductImage(
  db: DB,
  productId: string,
  assetId: string,
  viewer: { userId: string; roles: UserRole[] } | null = null,
): Promise<{ asset: typeof mediaAssets.$inferSelect; body: Buffer; publicVisible: boolean }> {
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Image not found');
  const asset = rows[0];
  if (asset.kind !== 'IMAGE' || asset.status !== 'READY' || !asset.storageKey || asset.productId !== productId) {
    throw ApiError.notFound('Image not found');
  }

  const product = await db
    .select({ status: products.status, isPublished: products.isPublished, sellerId: products.sellerId })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (product.length === 0) throw ApiError.notFound('Image not found');

  const publicVisible = product[0].isPublished && product[0].status === 'ACTIVE';
  if (!publicVisible) {
    const isStaff = viewer?.roles.includes('ADMIN') || viewer?.roles.includes('SUPER_ADMIN');
    const isOwner =
      viewer !== null && (await resolveSellerUserId(db, product[0].sellerId)) === viewer.userId;
    if (!isStaff && !isOwner) throw ApiError.notFound('Image not found');
  }

  const link = await db
    .select({ id: productImages.id })
    .from(productImages)
    .where(eq(productImages.url, productImageUrl(productId, assetId)))
    .limit(1);
  if (link.length === 0) throw ApiError.notFound('Image not found');

  const storage = resolveMediaStorage();
  const size = await storage.size(asset.storageKey);
  if (size === null) throw ApiError.notFound('Image not found');
  const body = await storage.get(asset.storageKey);
  return { asset, body, publicVisible };
}
