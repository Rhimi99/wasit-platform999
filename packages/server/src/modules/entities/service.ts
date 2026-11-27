import { eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { companies, merchants, suppliers } from '../../db/schema/trade.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { EDITABLE_FIELDS } from './fields.js';
import type { EntityType } from './types.js';

export interface MerchantView {
  id: string;
  type: 'merchant';
  storeName: string;
  slug: string;
  countryId: string | null;
  cityId: string | null;
  description: string | null;
  logoUrl: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierView {
  id: string;
  type: 'supplier';
  companyName: string;
  slug: string;
  countryId: string | null;
  cityId: string | null;
  description: string | null;
  logoUrl: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyView {
  id: string;
  type: 'company';
  legalName: string;
  slug: string;
  countryId: string | null;
  cityId: string | null;
  industry: string | null;
  description: string | null;
  logoUrl: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MyEntities {
  merchant: MerchantView | null;
  supplier: SupplierView | null;
  company: CompanyView | null;
}

/** Owner view: the caller's own row, without the ownership key. */
function toMerchantView(row: typeof merchants.$inferSelect): MerchantView {
  return {
    id: row.id,
    type: 'merchant',
    storeName: row.storeName,
    slug: row.slug,
    countryId: row.countryId,
    cityId: row.cityId,
    description: row.description,
    logoUrl: row.logoUrl,
    verified: row.verified,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSupplierView(row: typeof suppliers.$inferSelect): SupplierView {
  return {
    id: row.id,
    type: 'supplier',
    companyName: row.companyName,
    slug: row.slug,
    countryId: row.countryId,
    cityId: row.cityId,
    description: row.description,
    logoUrl: row.logoUrl,
    verified: row.verified,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCompanyView(row: typeof companies.$inferSelect): CompanyView {
  return {
    id: row.id,
    type: 'company',
    legalName: row.legalName,
    slug: row.slug,
    countryId: row.countryId,
    cityId: row.cityId,
    industry: row.industry,
    description: row.description,
    logoUrl: row.logoUrl,
    verified: row.verified,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Keeps only the allow-listed fields that actually change.
 *
 * The schemas already reject protected keys with a 422; this second pass means
 * a future route that forgets `.strict()` still cannot write them.
 */
function diffPatch(type: EntityType, row: Record<string, unknown>, patch: Record<string, unknown>) {
  const changes: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS[type]) {
    if (!(field in patch)) continue;
    const next = patch[field];
    if (next === undefined) continue;
    if ((next ?? null) === (row[field] ?? null)) continue;
    changes[field] = next;
  }
  return changes;
}

function changedSnapshot(fields: string[], row: Record<string, unknown>) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

async function auditUpdate(
  db: DB,
  ctx: AuditContext,
  type: EntityType,
  id: string,
  fields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  await writeAudit(db, ctx, {
    action: 'ENTITY.UPDATE',
    entityType: type.toUpperCase(),
    entityId: id,
    before: changedSnapshot(fields, before),
    after: changedSnapshot(fields, after),
    metadata: { fields, source: 'self-service' },
  });
}

/** The caller's entities, each `null` when the account owns none of that type. */
export async function getMyEntities(db: DB, userId: string): Promise<MyEntities> {
  const [merchantRows, supplierRows, companyRows] = await Promise.all([
    db.select().from(merchants).where(eq(merchants.userId, userId)).limit(1),
    db.select().from(suppliers).where(eq(suppliers.userId, userId)).limit(1),
    db.select().from(companies).where(eq(companies.userId, userId)).limit(1),
  ]);
  return {
    merchant: merchantRows[0] ? toMerchantView(merchantRows[0]) : null,
    supplier: supplierRows[0] ? toSupplierView(supplierRows[0]) : null,
    company: companyRows[0] ? toCompanyView(companyRows[0]) : null,
  };
}

export interface EntityUpdateResult<T> {
  entity: T;
  changed: boolean;
}

/**
 * Writes an allow-listed patch to a row the caller already owns.
 *
 * Ownership is decided by the caller (`userId` lookup for `/me`, an explicit
 * owner comparison for `/:id`), so this function never has to trust an id from
 * the request body.
 */
async function applyMerchantUpdate(
  db: DB,
  row: typeof merchants.$inferSelect,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<MerchantView>> {
  const changes = diffPatch('merchant', row, patch);
  const fields = Object.keys(changes);
  if (fields.length === 0) return { entity: toMerchantView(row), changed: false };
  const [updated] = await db
    .update(merchants)
    .set({ ...(changes as Partial<typeof merchants.$inferInsert>), updatedAt: new Date() })
    .where(eq(merchants.id, row.id))
    .returning();
  await auditUpdate(db, ctx, 'merchant', row.id, fields, row, updated);
  return { entity: toMerchantView(updated), changed: true };
}

async function applySupplierUpdate(
  db: DB,
  row: typeof suppliers.$inferSelect,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<SupplierView>> {
  const changes = diffPatch('supplier', row, patch);
  const fields = Object.keys(changes);
  if (fields.length === 0) return { entity: toSupplierView(row), changed: false };
  const [updated] = await db
    .update(suppliers)
    .set({ ...(changes as Partial<typeof suppliers.$inferInsert>), updatedAt: new Date() })
    .where(eq(suppliers.id, row.id))
    .returning();
  await auditUpdate(db, ctx, 'supplier', row.id, fields, row, updated);
  return { entity: toSupplierView(updated), changed: true };
}

async function applyCompanyUpdate(
  db: DB,
  row: typeof companies.$inferSelect,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<CompanyView>> {
  const changes = diffPatch('company', row, patch);
  const fields = Object.keys(changes);
  if (fields.length === 0) return { entity: toCompanyView(row), changed: false };
  const [updated] = await db
    .update(companies)
    .set({ ...(changes as Partial<typeof companies.$inferInsert>), updatedAt: new Date() })
    .where(eq(companies.id, row.id))
    .returning();
  await auditUpdate(db, ctx, 'company', row.id, fields, row, updated);
  return { entity: toCompanyView(updated), changed: true };
}

/** Self-service write: the row is resolved from the authenticated user only. */
export async function updateMyEntity(
  db: DB,
  type: 'merchant',
  userId: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<MerchantView>>;
export async function updateMyEntity(
  db: DB,
  type: 'supplier',
  userId: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<SupplierView>>;
export async function updateMyEntity(
  db: DB,
  type: 'company',
  userId: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<CompanyView>>;
export async function updateMyEntity(
  db: DB,
  type: EntityType,
  userId: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<MerchantView | SupplierView | CompanyView>> {
  if (type === 'merchant') {
    const [row] = await db.select().from(merchants).where(eq(merchants.userId, userId)).limit(1);
    if (!row) throw ApiError.notFound('Merchant profile');
    return applyMerchantUpdate(db, row, patch, ctx);
  }
  if (type === 'supplier') {
    const [row] = await db.select().from(suppliers).where(eq(suppliers.userId, userId)).limit(1);
    if (!row) throw ApiError.notFound('Supplier profile');
    return applySupplierUpdate(db, row, patch, ctx);
  }
  const [row] = await db.select().from(companies).where(eq(companies.userId, userId)).limit(1);
  if (!row) throw ApiError.notFound('Company profile');
  return applyCompanyUpdate(db, row, patch, ctx);
}

/**
 * Addressed write kept for the existing `PATCH /api/{type}/:id` contract.
 * Ownership is checked here, before any column is touched — holding the
 * `*:update` permission is not enough to edit somebody else's profile.
 */
export async function updateEntityById(
  db: DB,
  type: 'merchant',
  id: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<MerchantView>>;
export async function updateEntityById(
  db: DB,
  type: 'supplier',
  id: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<SupplierView>>;
export async function updateEntityById(
  db: DB,
  type: 'company',
  id: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<CompanyView>>;
export async function updateEntityById(
  db: DB,
  type: EntityType,
  id: string,
  patch: Record<string, unknown>,
  ctx: AuditContext,
): Promise<EntityUpdateResult<MerchantView | SupplierView | CompanyView>> {
  if (type === 'merchant') {
    const [row] = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    if (!row) throw ApiError.notFound('Merchant');
    if (row.userId !== ctx.actorId) throw ApiError.forbidden();
    return applyMerchantUpdate(db, row, patch, ctx);
  }
  if (type === 'supplier') {
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    if (!row) throw ApiError.notFound('Supplier');
    if (row.userId !== ctx.actorId) throw ApiError.forbidden();
    return applySupplierUpdate(db, row, patch, ctx);
  }
  const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (!row) throw ApiError.notFound('Company');
  if (row.userId !== ctx.actorId) throw ApiError.forbidden();
  return applyCompanyUpdate(db, row, patch, ctx);
}
