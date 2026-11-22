import { sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';

/**
 * PR-02 slice 1 — the Entities Desk.
 *
 * Merchants, suppliers and companies are the platform's supply side, and until
 * now the console could list users and products but never the *businesses*
 * behind them: no way to answer "who is registered, who is active, who is
 * verified, how much do they actually sell". The three tables are identical in
 * shape (owner, name, slug, country, verified, is_active, timestamps), so one
 * parameterised reader serves all three instead of three near-copies.
 *
 * Read-only by design: suspending a merchant or flipping `verified` changes a
 * real business's standing and belongs to a decision this slice does not make.
 * Nothing here writes, and no row is invented — every number is an aggregate the
 * database computes from the same rows the rest of the platform uses.
 */

export const ENTITY_TYPES = ['merchant', 'supplier', 'company'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Table and column names cannot be bound as parameters, so each type carries a
 * whitelisted descriptor. The values are the only thing the caller controls.
 */
const SPEC: Record<
  EntityType,
  { table: string; nameColumn: string; sellerType: string; label: string }
> = {
  merchant: { table: 'merchants', nameColumn: 'store_name', sellerType: 'MERCHANT', label: 'Merchant' },
  supplier: { table: 'suppliers', nameColumn: 'company_name', sellerType: 'SUPPLIER', label: 'Supplier' },
  company: { table: 'companies', nameColumn: 'legal_name', sellerType: 'COMPANY', label: 'Company' },
};

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? [];
}

/** Order states that never count towards revenue: they were never fulfilled. */
const VOID_ORDER_STATUSES = sql`('CANCELLED', 'REFUNDED')`;

export interface EntitySummary {
  type: EntityType;
  total: number;
  active: number;
  inactive: number;
  verified: number;
  unverified: number;
  newLast30Days: number;
}

export interface EntityListRow {
  type: EntityType;
  id: string;
  name: string;
  slug: string;
  verified: boolean;
  isActive: boolean;
  createdAt: string;
  ownerEmail: string | null;
  ownerActive: boolean | null;
  countryCode: string | null;
  productCount: number;
  orderCount: number;
  gmv: string;
}

export interface EntityListQuery {
  type: EntityType;
  q?: string;
  status?: 'all' | 'active' | 'inactive';
  verified?: 'all' | 'yes' | 'no';
  countryId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * One row per type. Counted in the database, so the totals cover every row and
 * not just the page the console happens to be showing.
 */
export async function entitySummary(db: DB): Promise<EntitySummary[]> {
  const queries = ENTITY_TYPES.map((type) => {
    const spec = SPEC[type];
    return db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where is_active)::int as active,
        count(*) filter (where not is_active)::int as inactive,
        count(*) filter (where verified)::int as verified,
        count(*) filter (where not verified)::int as unverified,
        count(*) filter (where created_at >= now() - interval '30 days')::int as new_last_30
      from ${sql.raw(spec.table)}
    `);
  });

  const results = await Promise.all(queries);
  return results.map((result, index) => {
    const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
    return {
      type: ENTITY_TYPES[index]!,
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      inactive: Number(row.inactive ?? 0),
      verified: Number(row.verified ?? 0),
      unverified: Number(row.unverified ?? 0),
      newLast30Days: Number(row.new_last_30 ?? 0),
    };
  });
}

export async function listEntities(
  db: DB,
  query: EntityListQuery,
): Promise<{ items: EntityListRow[]; page: number; pageSize: number; total: number }> {
  const spec = SPEC[query.type];
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));

  const filters = [sql`1 = 1`];
  if (query.q) {
    filters.push(sql`${sql.raw(`e.${spec.nameColumn}`)} ilike ${`%${query.q}%`}`);
  }
  if (query.status === 'active') filters.push(sql`e.is_active`);
  if (query.status === 'inactive') filters.push(sql`not e.is_active`);
  if (query.verified === 'yes') filters.push(sql`e.verified`);
  if (query.verified === 'no') filters.push(sql`not e.verified`);
  if (query.countryId) filters.push(sql`e.country_id = ${query.countryId}`);
  const where = sql.join(filters, sql` and `);

  const [countResult, listResult] = await Promise.all([
    db.execute(sql`select count(*)::int as total from ${sql.raw(spec.table)} e where ${where}`),
    db.execute(sql`
      select
        e.id,
        ${sql.raw(`e.${spec.nameColumn}`)} as name,
        e.slug,
        e.verified,
        e.is_active,
        e.created_at,
        u.email as owner_email,
        u.is_active as owner_active,
        c.code as country_code,
        (select count(*) from products p
          where p.seller_id = e.id and p.seller_type = ${spec.sellerType}::seller_type)::int as product_count,
        (select count(*) from orders o
          where o.seller_id = e.id and o.seller_type = ${spec.sellerType}::seller_type)::int as order_count,
        (select coalesce(sum(o.grand_total), 0)::text from orders o
          where o.seller_id = e.id and o.seller_type = ${spec.sellerType}::seller_type
            and o.status::text not in ${VOID_ORDER_STATUSES}) as gmv
      from ${sql.raw(spec.table)} e
      left join users u on u.id = e.user_id
      left join countries c on c.id = e.country_id
      where ${where}
      order by e.created_at desc, e.id
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `),
  ]);

  return {
    items: rowsOf<Record<string, unknown>>(listResult).map((r) => ({
      type: query.type,
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      verified: Boolean(r.verified),
      isActive: Boolean(r.is_active),
      createdAt: new Date(r.created_at as string).toISOString(),
      ownerEmail: (r.owner_email as string | null) ?? null,
      ownerActive: r.owner_active === null ? null : Boolean(r.owner_active),
      countryCode: (r.country_code as string | null) ?? null,
      productCount: Number(r.product_count ?? 0),
      orderCount: Number(r.order_count ?? 0),
      gmv: String(r.gmv ?? '0'),
    })),
    page,
    pageSize,
    total: Number(rowsOf<{ total: number }>(countResult)[0]?.total ?? 0),
  };
}

export interface EntityDetail {
  type: EntityType;
  entity: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    verified: boolean;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    countryCode: string | null;
    countryName: string | null;
    /** Company-only identifiers; null for merchants and suppliers. */
    registrationNumber: string | null;
    taxId: string | null;
    industry: string | null;
  };
  owner: { id: string; email: string; isActive: boolean; createdAt: string } | null;
  metrics: {
    products: number;
    publishedProducts: number;
    orders: number;
    gmv: string;
    openDisputes: number;
    openDisputeValue: string;
  };
  trust: { score: number; level: string } | null;
  verification: { status: string; targetLevel: string; submittedAt: string } | null;
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    grandTotal: string;
    currencyCode: string;
    createdAt: string;
  }>;
}

/**
 * A single business, with the numbers a GM needs before acting on it.
 *
 * `null`-safe throughout: a business whose owner row is missing (data imported
 * before accounts existed) still renders rather than 500s.
 */
export async function getEntityDetail(db: DB, type: EntityType, id: string): Promise<EntityDetail> {
  const spec = SPEC[type];
  const [entityResult] = await Promise.all([
    db.execute(sql`
      select
        e.id,
        ${sql.raw(`e.${spec.nameColumn}`)} as name,
        e.slug,
        e.description,
        e.verified,
        e.is_active,
        e.created_at,
        e.updated_at,
        e.country_id,
        c.code as country_code,
        c.name as country_name
      from ${sql.raw(spec.table)} e
      left join countries c on c.id = e.country_id
      where e.id = ${id}
      limit 1
    `),
  ]);

  const row = rowsOf<Record<string, unknown>>(entityResult)[0];
  if (!row) throw ApiError.notFound(`${spec.label} not found`);

  // Company identifiers only exist on the companies table; ask for them only there.
  let registrationNumber: string | null = null;
  let taxId: string | null = null;
  let industry: string | null = null;
  if (type === 'company') {
    const extra = rowsOf<Record<string, unknown>>(
      await db.execute(sql`select registration_number, tax_id, industry from companies where id = ${id} limit 1`),
    )[0];
    registrationNumber = (extra?.registration_number as string | null) ?? null;
    taxId = (extra?.tax_id as string | null) ?? null;
    industry = (extra?.industry as string | null) ?? null;
  }

  const [ownerResult, metricsResult, trustResult, verificationResult, ordersResult] = await Promise.all([
    db.execute(sql`
      select u.id, u.email, u.is_active, u.created_at
      from users u
      where u.id = (select user_id from ${sql.raw(spec.table)} where id = ${id})
      limit 1
    `),
    db.execute(sql`
      select
        (select count(*) from products p
          where p.seller_id = ${id} and p.seller_type = ${spec.sellerType}::seller_type)::int as products,
        (select count(*) from products p
          where p.seller_id = ${id} and p.seller_type = ${spec.sellerType}::seller_type
            and p.is_published)::int as published_products,
        (select count(*) from orders o
          where o.seller_id = ${id} and o.seller_type = ${spec.sellerType}::seller_type)::int as orders,
        (select coalesce(sum(o.grand_total), 0)::text from orders o
          where o.seller_id = ${id} and o.seller_type = ${spec.sellerType}::seller_type
            and o.status::text not in ${VOID_ORDER_STATUSES}) as gmv,
        (select count(*) from disputes d
          join orders o on o.id = d.order_id
          where o.seller_id = ${id} and o.seller_type = ${spec.sellerType}::seller_type
            and d.status::text in ('OPEN', 'UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED'))::int as open_disputes,
        (select coalesce(sum(o.grand_total), 0)::text from disputes d
          join orders o on o.id = d.order_id
          where o.seller_id = ${id} and o.seller_type = ${spec.sellerType}::seller_type
            and d.status::text in ('OPEN', 'UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED')) as open_dispute_value
    `),
    db.execute(sql`
      select t.score, t.level
      from trust_scores t
      where t.user_id = (select user_id from ${sql.raw(spec.table)} where id = ${id})
      limit 1
    `),
    db.execute(sql`
      select v.status, v.target_level, v.created_at
      from verification_requests v
      where v.user_id = (select user_id from ${sql.raw(spec.table)} where id = ${id})
      order by v.created_at desc
      limit 1
    `),
    db.execute(sql`
      select o.id, o.order_number, o.status, o.grand_total, o.currency_code, o.created_at
      from orders o
      where o.seller_id = ${id} and o.seller_type = ${spec.sellerType}::seller_type
      order by o.created_at desc
      limit 5
    `),
  ]);

  const owner = rowsOf<Record<string, unknown>>(ownerResult)[0];
  const metrics = rowsOf<Record<string, unknown>>(metricsResult)[0] ?? {};
  const trust = rowsOf<Record<string, unknown>>(trustResult)[0];
  const verification = rowsOf<Record<string, unknown>>(verificationResult)[0];

  return {
    type,
    entity: {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      description: (row.description as string | null) ?? null,
      verified: Boolean(row.verified),
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      countryCode: (row.country_code as string | null) ?? null,
      countryName: (row.country_name as string | null) ?? null,
      registrationNumber,
      taxId,
      industry,
    },
    owner: owner
      ? {
          id: owner.id as string,
          email: owner.email as string,
          isActive: Boolean(owner.is_active),
          createdAt: new Date(owner.created_at as string).toISOString(),
        }
      : null,
    metrics: {
      products: Number(metrics.products ?? 0),
      publishedProducts: Number(metrics.published_products ?? 0),
      orders: Number(metrics.orders ?? 0),
      gmv: String(metrics.gmv ?? '0'),
      openDisputes: Number(metrics.open_disputes ?? 0),
      openDisputeValue: String(metrics.open_dispute_value ?? '0'),
    },
    trust: trust ? { score: Number(trust.score), level: String(trust.level) } : null,
    verification: verification
      ? {
          status: String(verification.status),
          targetLevel: String(verification.target_level),
          submittedAt: new Date(verification.created_at as string).toISOString(),
        }
      : null,
    recentOrders: rowsOf<Record<string, unknown>>(ordersResult).map((o) => ({
      id: o.id as string,
      orderNumber: o.order_number as string,
      status: String(o.status),
      grandTotal: String(o.grand_total),
      currencyCode: String(o.currency_code),
      createdAt: new Date(o.created_at as string).toISOString(),
    })),
  };
}
