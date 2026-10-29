import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { companies, merchants, suppliers } from '../../db/schema/trade.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * The seller entities an admin can vet from one desk. All three tables share the
 * same governance columns (`verified`, `isActive`) and the same shape, so the
 * desk is written once and parameterised by kind rather than copied three times.
 */
export const TRADE_KINDS = ['suppliers', 'merchants', 'companies'] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

export function isTradeKind(value: string): value is TradeKind {
  return (TRADE_KINDS as readonly string[]).includes(value);
}

interface TradeTable {
  id: AnyPgColumn;
  userId: AnyPgColumn;
  name: AnyPgColumn;
  slug: AnyPgColumn;
  verified: AnyPgColumn;
  isActive: AnyPgColumn;
  countryId: AnyPgColumn;
  createdAt: AnyPgColumn;
  updatedAt: AnyPgColumn;
}

/** Each table names its display column differently; normalise to `name` for the desk. */
const TABLES: Record<TradeKind, TradeTable> = {
  suppliers: {
    id: suppliers.id,
    userId: suppliers.userId,
    name: suppliers.companyName,
    slug: suppliers.slug,
    verified: suppliers.verified,
    isActive: suppliers.isActive,
    countryId: suppliers.countryId,
    createdAt: suppliers.createdAt,
    updatedAt: suppliers.updatedAt,
  },
  merchants: {
    id: merchants.id,
    userId: merchants.userId,
    name: merchants.storeName,
    slug: merchants.slug,
    verified: merchants.verified,
    isActive: merchants.isActive,
    countryId: merchants.countryId,
    createdAt: merchants.createdAt,
    updatedAt: merchants.updatedAt,
  },
  companies: {
    id: companies.id,
    userId: companies.userId,
    name: companies.legalName,
    slug: companies.slug,
    verified: companies.verified,
    isActive: companies.isActive,
    countryId: companies.countryId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  },
};

/** Raw tables, for the write path (Drizzle needs the concrete table instance). */
const RAW_TABLES = { suppliers, merchants, companies } as const;

/** Singular, upper-case audit entity type per kind (naive `slice(-1)` would yield "COMPANIE"). */
const ENTITY_TYPES: Record<TradeKind, string> = {
  suppliers: 'SUPPLIER',
  merchants: 'MERCHANT',
  companies: 'COMPANY',
};

const NOT_FOUND_LABELS: Record<TradeKind, string> = {
  suppliers: 'Supplier',
  merchants: 'Merchant',
  companies: 'Company',
};

export interface TradeListQuery {
  q?: string;
  verified?: boolean;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TradeRow {
  id: string;
  kind: TradeKind;
  name: string;
  slug: string;
  userId: string;
  countryId: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Lists seller entities of one kind for the admin desk.
 *
 * Unlike the public directory (which hides inactive rows), the desk must show
 * suspended entities so an admin can reactivate them, so no `isActive` filter is
 * applied unless the caller asks for one.
 */
export async function listTradeEntities(
  db: DB,
  kind: TradeKind,
  query: TradeListQuery,
): Promise<{ items: TradeRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const t = TABLES[kind];
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

  const conditions = [];
  if (query.q) conditions.push(ilike(t.name, `%${query.q}%`));
  if (query.verified !== undefined) conditions.push(eq(t.verified, query.verified));
  if (query.isActive !== undefined) conditions.push(eq(t.isActive, query.isActive));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(RAW_TABLES[kind])
    .where(where);

  const rows = await db
    .select({
      id: t.id,
      name: t.name,
      slug: t.slug,
      userId: t.userId,
      countryId: t.countryId,
      verified: t.verified,
      isActive: t.isActive,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .from(RAW_TABLES[kind])
    .where(where)
    .orderBy(asc(t.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    items: rows.map((r) => ({ ...r, kind })),
    pagination: { page, pageSize, total },
  };
}

export interface UpdateTradeStatusInput {
  verified?: boolean;
  isActive?: boolean;
}

/**
 * Updates the vetting flags of one seller entity and records the change.
 *
 * `verified` is what the public directory and search surface as a trust badge;
 * `isActive` is what removes the entity from those listings. Both are
 * governance decisions taken here, never hardcoded, and always audited with the
 * before/after pair so the trail shows what actually changed.
 */
export async function updateTradeStatus(
  db: DB,
  kind: TradeKind,
  id: string,
  input: UpdateTradeStatusInput,
  ctx: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string; verified: boolean; isActive: boolean }> {
  const t = TABLES[kind];
  const table = RAW_TABLES[kind];

  const [before] = await db.select().from(table).where(eq(t.id, id)).limit(1);
  if (!before) throw ApiError.notFound(NOT_FOUND_LABELS[kind]);

  const nextVerified = input.verified ?? before.verified;
  const nextActive = input.isActive ?? before.isActive;

  await db
    .update(table)
    .set({ verified: nextVerified, isActive: nextActive, updatedAt: new Date() })
    .where(eq(t.id, id));

  // Name the audit action after what actually changed. A caller may send a value
  // identical to the current one (idempotent retry), which must not be recorded as
  // a fresh verification/suspension event.
  let action: string;
  if (nextActive !== before.isActive) {
    action = nextActive ? 'TRADE.REACTIVATED' : 'TRADE.SUSPENDED';
  } else if (nextVerified !== before.verified) {
    action = nextVerified ? 'TRADE.VERIFIED' : 'TRADE.UNVERIFIED';
  } else {
    action = 'TRADE.STATUS_UNCHANGED';
  }

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action,
    entityType: ENTITY_TYPES[kind],
    entityId: id,
    before: { verified: before.verified, isActive: before.isActive },
    after: { verified: nextVerified, isActive: nextActive },
  });

  return { id, verified: nextVerified, isActive: nextActive };
}
