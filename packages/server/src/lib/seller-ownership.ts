import { sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../db/client';

/**
 * Resolves the seller entity ids (supplier/merchant/company) owned by a user.
 * WASIT's commerce model stores `seller_id` as an entity id, while buyers are
 * always stored as user ids — this helper bridges the two for trust/risk and
 * disputes participation checks.
 */
export async function resolveOwnedSellerIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where user_id = ${userId}
  `) as never;
  const r = rows as unknown as { rows: { id: string }[] };
  return (r.rows ?? []).map((row) => row.id);
}

export interface OwnedSellerEntity {
  id: string;
  sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY';
  name: string;
}

/**
 * Lists the seller entities owned by a user, with the display name and
 * seller type needed to publish products. Keeps `seller_id` resolution and
 * entity naming in one place so the UI never has to guess an entity id.
 */
export async function listOwnedSellerEntities(db: DB, userId: string): Promise<OwnedSellerEntity[]> {
  const rows = await db.execute<{ id: string; seller_type: string; name: string }>(sql`
    select id, seller_type, name from (
      select id, user_id, 'SUPPLIER' as seller_type, company_name as name from suppliers
      union all
      select id, user_id, 'MERCHANT' as seller_type, store_name as name from merchants
      union all
      select id, user_id, 'COMPANY' as seller_type, legal_name as name from companies
    ) owned where user_id = ${userId}
    order by name
  `) as never;
  const r = rows as unknown as { rows: { id: string; seller_type: string; name: string }[] };
  return (r.rows ?? []).map((row) => ({
    id: row.id,
    sellerType: row.seller_type as OwnedSellerEntity['sellerType'],
    name: row.name,
  }));
}

/**
 * Resolves the owning user id for a seller entity (supplier/merchant/company).
 * Inverse of {@link resolveOwnedSellerIds} — used when an entity id (e.g. the
 * inventory owner) must be mapped back to the user who should be notified.
 */
export async function resolveSellerUserId(db: DB, sellerId: string): Promise<string | null> {
  const rows = await db.execute<{ user_id: string }>(sql`
    select user_id from (
      select id, user_id from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where id = ${sellerId} limit 1
  `) as never;
  const r = rows as unknown as { rows: { user_id: string }[] };
  return r.rows[0]?.user_id ?? null;
}

/**
 * Verifies a caller owns a specific seller entity (supplier/merchant/company).
 * `products.sellerId` stores the *entity* id, not the user id, so every
 * ownership check must compare against the owning user id.
 */
export async function assertSellerOwnership(
  db: DB,
  userId: string,
  sellerId: string,
  sellerType: string,
): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id, 'SUPPLIER' as seller_type from suppliers
      union all
      select id, user_id, 'MERCHANT' as seller_type from merchants
      union all
      select id, user_id, 'COMPANY' as seller_type from companies
    ) owned
    where id = ${sellerId} and user_id = ${userId} and seller_type = ${sellerType}
    limit 1
  `) as never;
  const r = rows as unknown as { rows: { id: string }[] };
  if ((r.rows ?? []).length === 0) {
    throw ApiError.forbidden('You do not own this business entity');
  }
}

/** True if the user participates in an order as buyer or seller. */
export async function isOrderParticipant(db: DB, orderId: string, userId: string): Promise<boolean> {
  const owned = await resolveOwnedSellerIds(db, userId);
  const sellerCondition = owned.length > 0
    ? sql`seller_id in (${sql.join(owned.map((id) => sql`${id}`), sql`, `)})`
    : sql`seller_id = ${userId}`;
  const rows = await db.execute<{ id: string }>(sql`
    select id from orders
    where id = ${orderId}
      and (buyer_id = ${userId} or ${sellerCondition})
    limit 1
  `) as never;
  const r = rows as unknown as { rows: { id: string }[] };
  if (r.rows.length > 0) return true;
  // Fallback for orders created with seller_id = user id (legacy/dev shape).
  const legacy = await db.execute<{ id: string }>(sql`
    select id from orders where id = ${orderId} and seller_id = ${userId} limit 1
  `) as never;
  const lr = legacy as unknown as { rows: { id: string }[] };
  return (lr.rows ?? []).length > 0;
}