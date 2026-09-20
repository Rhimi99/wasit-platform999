import { bigint, index, jsonb, pgEnum, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Media Asset — a record of a generated/stored media binary (today: product
 * marketing videos). The binary lives in private storage; this row holds only
 * metadata and the opaque storage key, so no public URL is ever persisted.
 *
 * `ownerUserId` is the user who may preview/download the asset. The row is
 * also linked to the source product and (optionally) the marketing campaign it
 * was produced for, keeping the media pipeline inside the existing Ads/Product
 * architecture instead of a parallel one.
 */
export const mediaAssetKindEnum = pgEnum('media_asset_kind', ['MARKETING_VIDEO', 'IMAGE', 'OTHER']);

export const mediaAssetStatusEnum = pgEnum('media_asset_status', [
  'PENDING',
  'READY',
  'FAILED',
  'DELETED',
]);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerUserId: varchar('owner_user_id', { length: 36 }).notNull(),
    kind: mediaAssetKindEnum('kind').notNull().default('MARKETING_VIDEO'),
    status: mediaAssetStatusEnum('status').notNull().default('PENDING'),
    title: varchar('title', { length: 250 }).notNull(),
    // Source references (nullable: an asset may not be tied to a product).
    productId: varchar('product_id', { length: 36 }),
    campaignId: varchar('campaign_id', { length: 36 }),
    /** Opaque storage key inside the private media store (never a public URL). */
    storageKey: text('storage_key'),
    mimeType: varchar('mime_type', { length: 100 }).notNull().default('video/mp4'),
    /** Declared extension for the stored binary, e.g. 'mp4'. */
    extension: varchar('extension', { length: 10 }).notNull().default('mp4'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    durationSeconds: varchar('duration_seconds', { length: 20 }),
    width: varchar('width', { length: 10 }),
    height: varchar('height', { length: 10 }),
    /** Provider/routing info: which engine produced the asset and its language. */
    provider: varchar('provider', { length: 60 }).notNull().default('structural'),
    language: varchar('language', { length: 5 }).notNull().default('en'),
    /** The brief (audience, style, duration, price snapshot) used to render. */
    generationSpec: jsonb('generation_spec'),
    /** Error payload when status = FAILED. */
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('media_assets_owner_idx').on(t.ownerUserId),
    productIdx: index('media_assets_product_idx').on(t.productId),
    kindIdx: index('media_assets_kind_idx').on(t.kind, t.status),
    createdIdx: index('media_assets_created_idx').on(t.createdAt),
  }),
);
