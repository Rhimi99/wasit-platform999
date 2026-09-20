import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { supplierContacts, suppliers } from '../../db/schema/trade.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';

export interface CreateSupplierInput {
  userId: string;
  companyName: string;
  countryId?: string;
  cityId?: string;
  description?: string;
  logoUrl?: string;
}

export interface CreateSupplierContactInput {
  supplierId: string;
  fullName: string;
  email?: string;
  phone?: string;
  position?: string;
  isPrimary?: boolean;
}

export async function createSupplier(db: DB, input: CreateSupplierInput, ctx: { actorId: string }) {
  const existing = await db.select().from(suppliers).where(eq(suppliers.userId, input.userId)).limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('Supplier profile already exists for this user');
  }
  const id = newId();
  const slug = `${input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${id.slice(0, 6)}`;
  await db.insert(suppliers).values({
    id,
    userId: input.userId,
    companyName: input.companyName,
    slug,
    countryId: input.countryId ?? null,
    cityId: input.cityId ?? null,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
  });
  await writeAudit(db, { actorId: ctx.actorId }, {
    action: 'SUPPLIER.CREATE',
    entityType: 'SUPPLIER',
    entityId: id,
    after: { companyName: input.companyName },
  });
  return { id };
}

export async function listSuppliers(
  db: DB,
  query: { q?: string; countryId?: string; verifiedOnly?: boolean; page?: number; pageSize?: number },
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const conditions = [eq(suppliers.isActive, true)];
  if (query.q) conditions.push(ilike(suppliers.companyName, `%${query.q}%`));
  if (query.countryId) conditions.push(eq(suppliers.countryId, query.countryId));
  if (query.verifiedOnly) conditions.push(eq(suppliers.verified, true));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(suppliers)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(asc(suppliers.companyName))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getSupplier(db: DB, id: string) {
  const row = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (row.length === 0) throw ApiError.notFound('Supplier not found');
  const contacts = await db.select().from(supplierContacts).where(eq(supplierContacts.supplierId, id));
  return { ...row[0], contacts };
}

export async function addSupplierContact(db: DB, input: CreateSupplierContactInput, ctx: { actorId: string }) {
  const supplier = await db.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
  if (supplier.length === 0) throw ApiError.notFound('Supplier not found');
  if (supplier[0].userId !== ctx.actorId) throw ApiError.forbidden();

  const id = newId();
  await db.insert(supplierContacts).values({
    id,
    supplierId: input.supplierId,
    fullName: input.fullName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    position: input.position ?? null,
    isPrimary: input.isPrimary ?? false,
  });
  return { id };
}