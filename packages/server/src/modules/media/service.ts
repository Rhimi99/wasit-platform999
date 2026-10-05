import Decimal from 'decimal.js';
import { and, desc, eq } from 'drizzle-orm';
import { ApiError, type UserRole, MARKETING_VIDEO_DURATION } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { mediaAssets } from '../../db/schema/media.js';
import { products } from '../../db/schema/products.js';
import { companies, merchants, suppliers } from '../../db/schema/trade.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { assertSellerOwnership, resolveSellerUserId } from '../../lib/seller-ownership.js';
import { newId } from '../../lib/ids.js';
import { assertWithinBudget, recordAiRequest, resolveLimit, upsertAiUsage } from '../../lib/ai/cost-control.js';
import { env } from '../../lib/env.js';
import { resolveMediaStorage, resolveVideoProvider } from '../../lib/media/resolve.js';
import { measureMp4DurationSeconds } from '../../lib/media/mp4.js';
import { downloadTtlSeconds, signDownloadToken, verifyDownloadToken } from '../../lib/media/tokens.js';
import type { RenderSpec } from '../../lib/media/video-types.js';

/**
 * Marketing Video Generation — real, end-to-end media pipeline.
 *
 * Flow: product (live DB) → render spec → video provider (ffmpeg/libass by
 * default) → private media storage → `media_assets` row → signed preview and
 * download URLs surfaced in the API/UI.
 *
 * The renderer is provider-agnostic (see `lib/media/video-types.ts`). WASIT's
 * AI cost-control layer governs generation: each render is recorded in
 * `ai_requests` (requestType MARKETING_VIDEO) and aggregated into `ai_usage`,
 * so video generation cannot silently bypass the platform's AI budget.
 */

export const VIDEO_REQUEST_TYPE = 'MARKETING_VIDEO';
/** Estimated USD cost booked for a local structural render (no vendor call). */
const RENDER_ESTIMATED_COST_USD = '0.000000';

export const VIDEO_LANGUAGES = ['ar', 'fr', 'en', 'zh'] as const;
export const VIDEO_AUDIENCES = ['B2B', 'B2C'] as const;
export const VIDEO_STYLES = ['MODERN', 'MINIMAL', 'BOLD', 'ELEGANT'] as const;

export interface MediaAssetView {
  id: string;
  kind: string;
  status: string;
  title: string;
  productId: string | null;
  campaignId: string | null;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  provider: string;
  language: string;
  previewable: boolean;
  downloadable: boolean;
  createdAt: string;
  updatedAt: string;
  /** Signed, short-lived URLs. Null when the asset is not READY. */
  previewUrl: string | null;
  downloadUrl: string | null;
}

function toView(row: typeof mediaAssets.$inferSelect, origin: string): MediaAssetView {
  const ready = row.status === 'READY';
  const tokens = ready
    ? (() => {
        const t = signDownloadToken(row.id, row.ownerUserId, downloadTtlSeconds());
        return { preview: `${origin}/api/media/assets/${row.id}/content?token=${t}`, download: `${origin}/api/media/assets/${row.id}/content?token=${t}&download=1` };
      })()
    : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    productId: row.productId,
    campaignId: row.campaignId,
    mimeType: row.mimeType,
    extension: row.extension,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds ? Number(row.durationSeconds) : null,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    provider: row.provider,
    language: row.language,
    previewable: ready,
    downloadable: ready,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    previewUrl: tokens?.preview ?? null,
    downloadUrl: tokens?.download ?? null,
  };
}

async function getOwnedAsset(db: DB, assetId: string, userId: string, roles: UserRole[]) {
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Media asset not found');
  const asset = rows[0];
  // Owner-or-admin: an admin may read any asset.
  const isAdmin = roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  if (asset.ownerUserId !== userId && !isAdmin) {
    throw ApiError.forbidden('You do not have access to this media asset');
  }
  return asset;
}

/** Derives the localized product name for a language, with a safe fallback. */
function localizedName(
  product: { name: string; nameAr: string | null; nameFr: string | null },
  language: string,
): string {
  if (language === 'ar' && product.nameAr) return product.nameAr;
  if (language === 'fr' && product.nameFr) return product.nameFr;
  return product.name;
}

async function sellerDisplayName(db: DB, sellerId: string, sellerType: string): Promise<string | null> {
  if (sellerType === 'MERCHANT') {
    const r = await db.select({ n: merchants.storeName }).from(merchants).where(eq(merchants.id, sellerId)).limit(1);
    return r[0]?.n ?? null;
  }
  if (sellerType === 'SUPPLIER') {
    const r = await db.select({ n: suppliers.companyName }).from(suppliers).where(eq(suppliers.id, sellerId)).limit(1);
    return r[0]?.n ?? null;
  }
  if (sellerType === 'COMPANY') {
    const r = await db.select({ n: companies.legalName }).from(companies).where(eq(companies.id, sellerId)).limit(1);
    return r[0]?.n ?? null;
  }
  return null;
}

export interface GenerateVideoInput {
  productId?: string;
  title?: string;
  language?: (typeof VIDEO_LANGUAGES)[number];
  audience?: (typeof VIDEO_AUDIENCES)[number];
  style?: (typeof VIDEO_STYLES)[number];
  durationSeconds?: number;
  campaignId?: string | null;
}

/**
 * Generates a marketing video for a product the caller can sell/see.
 *
 * Authorization: caller must hold MEDIA_UPLOAD and, when a productId is given,
 * own the product (or be an admin) and the product must be ACTIVE.
 */
export async function generateMarketingVideo(
  db: DB,
  actor: { userId: string; roles: UserRole[]; locale?: string },
  input: GenerateVideoInput,
  audit: Omit<AuditContext, 'actorId'>,
): Promise<MediaAssetView & { requestId: string }> {
  const isAdmin = actor.roles.includes('ADMIN') || actor.roles.includes('SUPER_ADMIN');
  if (!input.productId) {
    throw ApiError.validation([{ field: 'productId', message: 'A product is required', code: 'REQUIRED' }]);
  }

  const prodRows = await db.select().from(products).where(eq(products.id, input.productId)).limit(1);
  if (prodRows.length === 0) throw ApiError.notFound('Product not found');
  const product = prodRows[0];

  if (!isAdmin) {
    // `products.sellerId` is a business entity id — ownership must be resolved
    // through the seller table, never compared to the caller's user id.
    await assertSellerOwnership(db, actor.userId, product.sellerId, product.sellerType);
  }
  if (product.status !== 'ACTIVE') {
    throw new ApiError(422, 'PRODUCT_NOT_ACTIVE', 'Marketing videos can only be generated for ACTIVE products');
  }

  const language = input.language ?? (['ar', 'fr', 'en', 'zh'].includes(actor.locale ?? '') ? (actor.locale as 'ar') : 'en');
  const audience = input.audience ?? (product.purchaseIntent === 'B2C' ? 'B2C' : 'B2B');
  const style = input.style ?? 'MODERN';
  const durationSeconds = clamp(
    input.durationSeconds ?? MARKETING_VIDEO_DURATION.default,
    MARKETING_VIDEO_DURATION.min,
    MARKETING_VIDEO_DURATION.max,
  );

  // AI cost-control: the render is booked against the user's video budget.
  const { periodWindow, currencyCode } = await resolveLimit(
    db,
    actor.userId,
    actor.roles,
    'MONTHLY',
    env.AI_BUDGET_MONTHLY_USD,
  );
  await assertWithinBudget(
    db,
    actor.userId,
    actor.roles,
    'MONTHLY',
    {
      requestsDelta: 1,
      tokensInputDelta: 0,
      tokensOutputDelta: 0,
      costDelta: new Decimal(RENDER_ESTIMATED_COST_USD),
    },
    env.AI_BUDGET_MONTHLY_USD,
  );

  const provider = resolveVideoProvider();
  const storage = resolveMediaStorage();
  const sellerName = (await sellerDisplayName(db, product.sellerId, product.sellerType)) ?? null;

  const spec: RenderSpec = {
    productId: product.id,
    productName: localizedName(product, language),
    description: product.description?.trim() || localizedName(product, language),
    brand: product.brand,
    price: product.basePrice,
    currencyCode: product.currencyCode,
    sellerName,
    imageUrl: null,
    language,
    audience,
    style,
    durationSeconds,
  };

  // Persist a PENDING row first so a render crash is observable, not silent.
  // The owner is always the seller's *user*, resolved from the entity, so a
  // delegated admin generating on a seller's behalf never takes ownership.
  const ownerUserId = (await resolveSellerUserId(db, product.sellerId)) ?? actor.userId;

  const assetId = newId();
  const title = (input.title?.trim() || `${localizedName(product, language)} — ${language.toUpperCase()}`).slice(0, 250);
  await db.insert(mediaAssets).values({
    id: assetId,
    ownerUserId,
    kind: 'MARKETING_VIDEO',
    status: 'PENDING',
    title,
    productId: product.id,
    campaignId: input.campaignId ?? null,
    mimeType: 'video/mp4',
    extension: 'mp4',
    provider: provider.id,
    language,
    generationSpec: { audience, style, durationSeconds, requestedBy: actor.userId },
  });

  const startedAt = Date.now();
  let requestId: string;
  try {
    const rendered = await provider.render(spec);
    if (rendered.bytes.length > env.MEDIA_MAX_VIDEO_BYTES) {
      throw new Error(`Rendered video exceeds the ${env.MEDIA_MAX_VIDEO_BYTES} byte limit`);
    }
    // Verify the ACTUAL asset, not the requested number: read the duration back
    // out of the rendered bytes and refuse anything outside the WASIT window.
    // `rendered.durationSeconds` is only a fallback for a non-MP4/external
    // provider, which is still held to the same policy bounds.
    const measuredDuration = measureMp4DurationSeconds(rendered.bytes) ?? rendered.durationSeconds;
    if (
      measuredDuration < MARKETING_VIDEO_DURATION.min ||
      measuredDuration > MARKETING_VIDEO_DURATION.max
    ) {
      throw new Error(
        `Rendered video is ${measuredDuration}s, outside the required ` +
          `${MARKETING_VIDEO_DURATION.min}–${MARKETING_VIDEO_DURATION.max}s range`,
      );
    }
    const storageKey = `videos/${assetId}.${rendered.extension}`;
    const stored = await storage.put({ key: storageKey, body: rendered.bytes, contentType: rendered.mimeType });

    const [updated] = await db
      .update(mediaAssets)
      .set({
        status: 'READY',
        storageKey,
        mimeType: rendered.mimeType,
        extension: rendered.extension,
        sizeBytes: stored.size,
        durationSeconds: String(Math.round(measuredDuration)),
        width: String(rendered.width),
        height: String(rendered.height),
        provider: rendered.provider,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, assetId))
      .returning();

    requestId = await recordAiRequest(db, {
      userId: actor.userId,
      requestType: VIDEO_REQUEST_TYPE,
      model: `video:${rendered.provider}`,
      tokensInput: 0,
      tokensOutput: 0,
      cost: RENDER_ESTIMATED_COST_USD,
      currencyCode,
      status: 'SUCCESS',
      latencyMs: Date.now() - startedAt,
      metadata: { assetId, productId: product.id, language, style, audience, bytes: stored.size },
    });
    await upsertAiUsage(db, actor.userId, 'MONTHLY', periodWindow, {
      requests: 1,
      cost: RENDER_ESTIMATED_COST_USD,
      currencyCode,
    });

    await writeAudit(db, { actorId: actor.userId, ...audit }, {
      action: 'MEDIA.MARKETING_VIDEO_GENERATED',
      entityType: 'MEDIA_ASSET',
      entityId: assetId,
      after: { productId: product.id, provider: rendered.provider, language, style, audience, sizeBytes: stored.size },
    });

    return { ...toView(updated, publicOrigin()), requestId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Video generation failed';
    await db
      .update(mediaAssets)
      .set({ status: 'FAILED', error: { message }, updatedAt: new Date() })
      .where(eq(mediaAssets.id, assetId));
    requestId = await recordAiRequest(db, {
      userId: actor.userId,
      requestType: VIDEO_REQUEST_TYPE,
      model: `video:${provider.id}`,
      tokensInput: 0,
      tokensOutput: 0,
      cost: '0',
      currencyCode,
      status: 'FAILED',
      latencyMs: Date.now() - startedAt,
      metadata: { assetId, productId: product.id, error: message },
    });
    await writeAudit(db, { actorId: actor.userId, ...audit }, {
      action: 'MEDIA.MARKETING_VIDEO_FAILED',
      entityType: 'MEDIA_ASSET',
      entityId: assetId,
      metadata: { productId: product.id, error: message },
    });
    throw new ApiError(502, 'SERVICE_UNAVAILABLE', `Video generation failed: ${message}`);
  }
}

/** Lists the caller's own marketing media (most recent first). */
export async function listMyMedia(
  db: DB,
  userId: string,
  opts: { kind?: string; productId?: string; limit?: number } = {},
): Promise<MediaAssetView[]> {
  const where = [eq(mediaAssets.ownerUserId, userId)];
  if (opts.kind) where.push(eq(mediaAssets.kind, opts.kind as 'MARKETING_VIDEO'));
  if (opts.productId) where.push(eq(mediaAssets.productId, opts.productId));
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(...where))
    .orderBy(desc(mediaAssets.createdAt))
    .limit(Math.min(opts.limit ?? 50, 100));
  const origin = publicOrigin();
  return rows.map((r) => toView(r, origin));
}

/** Returns one owned asset with fresh signed URLs. */
export async function getMediaAsset(
  db: DB,
  assetId: string,
  userId: string,
  roles: UserRole[],
): Promise<MediaAssetView> {
  const asset = await getOwnedAsset(db, assetId, userId, roles);
  return toView(asset, publicOrigin());
}

/** Soft-deletes an owned asset and removes its binary from storage. */
export async function deleteMediaAsset(
  db: DB,
  assetId: string,
  userId: string,
  roles: UserRole[],
  audit: Omit<AuditContext, 'actorId'>,
): Promise<void> {
  const asset = await getOwnedAsset(db, assetId, userId, roles);
  if (asset.storageKey) {
    try {
      await resolveMediaStorage().delete(asset.storageKey);
    } catch {
      // The binary may already be gone; the metadata transition still matters.
    }
  }
  await db
    .update(mediaAssets)
    .set({ status: 'DELETED', storageKey: null, updatedAt: new Date() })
    .where(eq(mediaAssets.id, assetId));
  await writeAudit(db, { actorId: userId, ...audit }, {
    action: 'MEDIA.ASSET_DELETED',
    entityType: 'MEDIA_ASSET',
    entityId: assetId,
    before: { status: asset.status, storageKey: asset.storageKey },
  });
}

/**
 * Opens a stored asset for streaming/download using an unauthenticated signed
 * token. The token binds the asset to a user and expires; ownership is
 * re-checked here against the current DB row, so a revoked/transferred asset
 * cannot be read with an old link.
 */
export async function openAssetForDownload(
  db: DB,
  assetId: string,
  token: string,
  range?: { start: number; end?: number },
): Promise<{ asset: typeof mediaAssets.$inferSelect; body: Buffer; size: number; start: number; end: number }> {
  const claims = verifyDownloadToken(token);
  if (!claims || claims.assetId !== assetId) {
    throw ApiError.unauthorized('Invalid or expired media link');
  }
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (rows.length === 0 || rows[0].status !== 'READY' || !rows[0].storageKey) {
    throw ApiError.notFound('Media asset not available');
  }
  const asset = rows[0];
  const storageKey = asset.storageKey;
  if (!storageKey) throw ApiError.notFound('Media asset not available');
  if (asset.ownerUserId !== claims.userId) {
    throw ApiError.forbidden('You do not have access to this media asset');
  }

  const storage = resolveMediaStorage();
  const size = await storage.size(storageKey);
  // A READY row whose object is gone (store wiped, or a deployment pointed at a
  // different MEDIA_STORAGE_DIR) is missing content, not a server fault. Report
  // it as such so the client sees a clean 404 instead of an unhandled ENOENT 500.
  if (size === null) throw ApiError.notFound('Media asset not available');
  const start = range?.start && range.start >= 0 ? Math.min(range.start, Math.max(size - 1, 0)) : 0;
  const end = range?.end !== undefined ? Math.min(range.end, size - 1) : size - 1;
  const body = range ? await storage.getRange(storageKey, start, end) : await storage.get(storageKey);
  return { asset, body, size, start, end: range ? end : size - 1 };
}

export function publicOrigin(): string {
  return env.PUBLIC_API_URL?.replace(/\/$/, '') ?? '';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Recent videos for the marketing-agent executor, joined to live product data. */
export async function listRecentMarketingVideos(db: DB, userId: string, limit = 5): Promise<MediaAssetView[]> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.ownerUserId, userId), eq(mediaAssets.kind, 'MARKETING_VIDEO')))
    .orderBy(desc(mediaAssets.createdAt))
    .limit(limit);
  const origin = publicOrigin();
  return rows.map((r) => toView(r, origin));
}