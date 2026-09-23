import { and, eq, ilike, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { merchants, suppliers } from '../../db/schema/trade.js';
import { listOwnedSellerEntities, resolveOwnedSellerIds } from '../../lib/seller-ownership.js';
import type { OwnedSellerEntity } from '../../lib/seller-ownership.js';

/**
 * Role-scoped directories for the seller dashboards.
 *
 * Every relationship list is derived from real commerce rows: a "customer" or
 * "buyer" is a user who has an actual order with an entity the caller owns, and
 * a supplier/merchant entry comes from the existing entity modules. A seller
 * with no orders therefore sees a genuine empty state, never a filler row.
 *
 * Ownership: `orders.seller_id`/`orders.buyer_id` hold entity/user ids, so the
 * caller is first mapped to the entities they own (`resolveOwnedSellerIds`) and
 * every query is then constrained to those ids — a caller can never read
 * another seller's counterparties.
 */

export type DirectoryKind = 'customers' | 'buyers' | 'suppliers' | 'merchants';

export interface DirectoryQuery {
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface BuyerDirectoryQuery extends DirectoryQuery {
  buyerType?: 'CUSTOMER' | 'MERCHANT' | 'COMPANY';
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

/** A buyer the caller has actually sold to (from real orders). */
export interface BuyerRelationRow {
  userId: string;
  name: string;
  email: string | null;
  buyerType: string;
  orderCount: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
}

/** A seller the caller has actually bought from (from real orders). */
export interface PartnerRelationRow {
  sellerId: string;
  sellerType: string;
  name: string;
  orderCount: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
}

export interface SupplierDirectoryRow {
  id: string;
  companyName: string;
  verified: boolean;
  countryId: string | null;
  cityId: string | null;
  logoUrl: string | null;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface MerchantDirectoryRow {
  id: string;
  storeName: string;
  verified: boolean;
  countryId: string | null;
  cityId: string | null;
  logoUrl: string | null;
  description: string | null;
}

function normalise(query: DirectoryQuery) {
  return {
    q: query.q?.trim() || undefined,
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.min(100, Math.max(1, query.pageSize ?? 20)),
  };
}

function emptyPage(page: number, pageSize: number): Pagination {
  return { page, pageSize, total: 0 };
}

/** `db.execute` returns the raw driver result; unwrap its `rows` array. */
function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? [];
}

/**
 * Distinct buyers who placed real orders with the caller's owned entities.
 * Aggregation happens in the database so the total reflects every matching
 * order relationship, not just the rendered page.
 *
 * `buyerType` narrows to one relationship kind: a merchant's "customers" are
 * the `CUSTOMER` buyers, while "buyers" spans every counterparty that bought.
 */
export async function listBuyers(
  db: DB,
  userId: string,
  query: BuyerDirectoryQuery,
): Promise<{ items: BuyerRelationRow[]; pagination: Pagination }> {
  const { q, page, pageSize } = normalise(query);
  const owned = await resolveOwnedSellerIds(db, userId);
  if (owned.length === 0) return { items: [], pagination: emptyPage(page, pageSize) };

  const ownedList = sql.join(owned.map((id) => sql`${id}`), sql`, `);
  const buyerFilter = query.buyerType ? sql`and o.buyer_type = ${query.buyerType}` : sql``;
  const grouped = sql`(
    select o.buyer_id as user_id,
           coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) as name,
           u.email,
           max(o.buyer_type) as buyer_type,
           count(*)::int as order_count,
           min(o.created_at) as first_order_at,
           max(o.created_at) as last_order_at
    from orders o
    join users u on u.id = o.buyer_id
    where o.seller_id in (${ownedList}) ${buyerFilter}
    group by o.buyer_id, u.email, u.first_name, u.last_name
  ) g`;
  const search = q ? sql`where (g.name ilike ${`%${q}%`} or g.email ilike ${`%${q}%`})` : sql``;

  const [countRes, listRes] = await Promise.all([
    db.execute(sql`select count(*)::int as total from ${grouped} ${search}`),
    db.execute(sql`
      select * from ${grouped} ${search}
      order by g.last_order_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `),
  ]);

  return {
    items: rowsOf<Record<string, unknown>>(listRes).map((r) => ({
      userId: r.user_id as string,
      name: r.name as string,
      email: (r.email as string | null) ?? null,
      buyerType: r.buyer_type as string,
      orderCount: Number(r.order_count),
      firstOrderAt: new Date(r.first_order_at as string),
      lastOrderAt: new Date(r.last_order_at as string),
    })),
    pagination: {
      page,
      pageSize,
      total: Number(rowsOf<{ total: number }>(countRes)[0]?.total ?? 0),
    },
  };
}

/**
 * Distinct seller entities the caller has really bought from. `buyerType`
 * narrows the relationship to the caller's business identity, since one user
 * may own a merchant and a company and hold orders under either.
 */
export async function listSellerPartners(
  db: DB,
  userId: string,
  sellerType: 'SUPPLIER' | 'MERCHANT',
  query: DirectoryQuery,
  buyerType?: 'CUSTOMER' | 'MERCHANT' | 'COMPANY',
): Promise<{ items: PartnerRelationRow[]; pagination: Pagination }> {
  const { q, page, pageSize } = normalise(query);
  const buyerFilter = buyerType ? sql`and o.buyer_type = ${buyerType}` : sql``;
  const grouped = sql`(
    select o.seller_id,
           o.seller_type,
           coalesce(
             (select s.company_name from suppliers s where s.id = o.seller_id),
             (select m.store_name from merchants m where m.id = o.seller_id),
             (select c.legal_name from companies c where c.id = o.seller_id)
           ) as name,
           count(*)::int as order_count,
           min(o.created_at) as first_order_at,
           max(o.created_at) as last_order_at
    from orders o
    where o.buyer_id = ${userId} and o.seller_type = ${sellerType} ${buyerFilter}
    group by o.seller_id, o.seller_type
  ) g`;
  const search = q ? sql`where g.name ilike ${`%${q}%`}` : sql``;

  const [countRes, listRes] = await Promise.all([
    db.execute(sql`select count(*)::int as total from ${grouped} ${search}`),
    db.execute(sql`
      select * from ${grouped} ${search}
      order by g.last_order_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `),
  ]);

  return {
    items: rowsOf<Record<string, unknown>>(listRes).map((r) => ({
      sellerId: r.seller_id as string,
      sellerType: r.seller_type as string,
      name: (r.name as string | null) ?? '',
      orderCount: Number(r.order_count),
      firstOrderAt: new Date(r.first_order_at as string),
      lastOrderAt: new Date(r.last_order_at as string),
    })),
    pagination: {
      page,
      pageSize,
      total: Number(rowsOf<{ total: number }>(countRes)[0]?.total ?? 0),
    },
  };
}

/** Active suppliers in the platform directory (existing suppliers module). */
export async function listSupplierDirectory(
  db: DB,
  query: DirectoryQuery,
): Promise<{ items: SupplierDirectoryRow[]; pagination: Pagination }> {
  const { q, page, pageSize } = normalise(query);
  const conditions = [eq(suppliers.isActive, true)];
  if (q) conditions.push(ilike(suppliers.companyName, `%${q}%`));
  const where = and(...conditions);

  const [countRows, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(suppliers).where(where),
    db
      .select({
        id: suppliers.id,
        companyName: suppliers.companyName,
        verified: suppliers.verified,
        countryId: suppliers.countryId,
        cityId: suppliers.cityId,
        logoUrl: suppliers.logoUrl,
        description: suppliers.description,
        contactEmail: sql<string | null>`(
          select sc.email from supplier_contacts sc
          where sc.supplier_id = ${suppliers.id}
          order by sc.is_primary desc
          limit 1
        )`,
        contactPhone: sql<string | null>`(
          select sc.phone from supplier_contacts sc
          where sc.supplier_id = ${suppliers.id}
          order by sc.is_primary desc
          limit 1
        )`,
      })
      .from(suppliers)
      .where(where)
      .orderBy(suppliers.companyName)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  return { items: rows, pagination: { page, pageSize, total: countRows[0]?.total ?? 0 } };
}

/** Active merchants in the platform directory (existing merchants module). */
export async function listMerchantDirectory(
  db: DB,
  query: DirectoryQuery,
): Promise<{ items: MerchantDirectoryRow[]; pagination: Pagination }> {
  const { q, page, pageSize } = normalise(query);
  const conditions = [eq(merchants.isActive, true)];
  if (q) conditions.push(ilike(merchants.storeName, `%${q}%`));
  const where = and(...conditions);

  const [countRows, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(merchants).where(where),
    db
      .select({
        id: merchants.id,
        storeName: merchants.storeName,
        verified: merchants.verified,
        countryId: merchants.countryId,
        cityId: merchants.cityId,
        logoUrl: merchants.logoUrl,
        description: merchants.description,
      })
      .from(merchants)
      .where(where)
      .orderBy(merchants.storeName)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  return { items: rows, pagination: { page, pageSize, total: countRows[0]?.total ?? 0 } };
}

/** The seller entities the caller owns, for a private "my entities" summary. */
export async function listMyEntities(db: DB, userId: string): Promise<OwnedSellerEntity[]> {
  return listOwnedSellerEntities(db, userId);
}

export function isDirectoryKind(value: string): value is DirectoryKind {
  return value === 'customers' || value === 'buyers' || value === 'suppliers' || value === 'merchants';
}
