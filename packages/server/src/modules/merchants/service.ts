import { and, eq, ilike, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { merchants } from '../../db/schema/trade.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';
import { isEntityStaff, type EntityViewer } from '../../lib/entity-access.js';

/**
 * The merchant columns a public profile may expose. `userId`, `isActive` and the
 * timestamps are operational and stay out of every response.
 */
export const MERCHANT_PUBLIC_FIELDS = {
  id: merchants.id,
  storeName: merchants.storeName,
  slug: merchants.slug,
  countryId: merchants.countryId,
  cityId: merchants.cityId,
  description: merchants.description,
  logoUrl: merchants.logoUrl,
  verified: merchants.verified,
} as const;

/** Public fields plus the columns needed to authorize the caller (never returned). */
const MERCHANT_ROW_FIELDS = {
  ...MERCHANT_PUBLIC_FIELDS,
  userId: merchants.userId,
  isActive: merchants.isActive,
} as const;

/** Strips the authorization-only columns, yielding exactly the public projection. */
function toPublicMerchant(row: Record<string, unknown>): Record<string, unknown> {
  const { userId: _userId, isActive: _isActive, ...publicFields } = row;
  void _userId;
  void _isActive;
  return publicFields;
}

export interface CreateMerchantInput {
  userId: string;
  storeName: string;
  countryId?: string;
  cityId?: string;
  description?: string;
  logoUrl?: string;
}

export async function createMerchant(db: DB, input: CreateMerchantInput, ctx: { actorId: string }) {
  const existing = await db.select().from(merchants).where(eq(merchants.userId, input.userId)).limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('Merchant profile already exists for this user');
  }
  const id = newId();
  const slug = `${input.storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${id.slice(0, 6)}`;
  await db.insert(merchants).values({
    id,
    userId: input.userId,
    storeName: input.storeName,
    slug,
    countryId: input.countryId ?? null,
    cityId: input.cityId ?? null,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
  });
  await writeAudit(db, { actorId: ctx.actorId }, {
    action: 'MERCHANT.CREATE',
    entityType: 'MERCHANT',
    entityId: id,
    after: { storeName: input.storeName },
  });
  return { id };
}

export async function listMerchants(
  db: DB,
  query: { q?: string; countryId?: string; page?: number; pageSize?: number },
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const conditions = [eq(merchants.isActive, true)];
  if (query.q) conditions.push(ilike(merchants.storeName, `%${query.q}%`));
  if (query.countryId) conditions.push(eq(merchants.countryId, query.countryId));
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(merchants)
    .where(and(...conditions));
  const rows = await db
    .select(MERCHANT_PUBLIC_FIELDS)
    .from(merchants)
    .where(and(...conditions))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows, pagination: { page, pageSize, total } };
}

/**
 * A single merchant profile.
 *
 * Everyone receives the public projection. An inactive profile is a 404 to the
 * public and to anyone who is not the owner or internal staff, so a suspended
 * merchant's existence is never disclosed.
 */
export async function getMerchant(db: DB, id: string, viewer: EntityViewer = {}) {
  const rows = await db.select(MERCHANT_ROW_FIELDS).from(merchants).where(eq(merchants.id, id)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Merchant not found');

  const isOwner = !!viewer.userId && viewer.userId === rows[0].userId;
  const isStaff = isEntityStaff(viewer);
  if (!rows[0].isActive && !isOwner && !isStaff) throw ApiError.notFound('Merchant not found');

  return toPublicMerchant(rows[0] as unknown as Record<string, unknown>);
}

export async function updateMerchant(
  db: DB,
  id: string,
  input: Partial<CreateMerchantInput>,
  actorId: string,
) {
  const row = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
  if (row.length === 0) throw ApiError.notFound('Merchant not found');
  if (row[0].userId !== actorId) throw ApiError.forbidden();
  const before = row[0];
  await db
    .update(merchants)
    .set({
      storeName: input.storeName ?? before.storeName,
      description: input.description ?? before.description,
      logoUrl: input.logoUrl ?? before.logoUrl,
      updatedAt: new Date(),
    })
    .where(eq(merchants.id, id));
  // The owner just wrote the row, so the private/owner view is the right response.
  return getMerchant(db, id, { userId: actorId });
}