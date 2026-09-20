import { and, eq, ilike, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { companies } from '../../db/schema/trade.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';

export interface CreateCompanyInput {
  userId: string;
  legalName: string;
  registrationNumber?: string;
  taxId?: string;
  countryId?: string;
  cityId?: string;
  industry?: string;
  description?: string;
  logoUrl?: string;
}

export async function createCompany(db: DB, input: CreateCompanyInput, ctx: { actorId: string }) {
  const existing = await db.select().from(companies).where(eq(companies.userId, input.userId)).limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('Company profile already exists for this user');
  }
  const id = newId();
  const slug = `${input.legalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${id.slice(0, 6)}`;
  await db.insert(companies).values({
    id,
    userId: input.userId,
    legalName: input.legalName,
    slug,
    registrationNumber: input.registrationNumber ?? null,
    taxId: input.taxId ?? null,
    countryId: input.countryId ?? null,
    cityId: input.cityId ?? null,
    industry: input.industry ?? null,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
  });
  await writeAudit(db, { actorId: ctx.actorId }, {
    action: 'COMPANY.CREATE',
    entityType: 'COMPANY',
    entityId: id,
    after: { legalName: input.legalName },
  });
  return { id };
}

export async function listCompanies(
  db: DB,
  query: { q?: string; countryId?: string; page?: number; pageSize?: number },
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const conditions = [eq(companies.isActive, true)];
  if (query.q) conditions.push(ilike(companies.legalName, `%${query.q}%`));
  if (query.countryId) conditions.push(eq(companies.countryId, query.countryId));
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(companies)
    .where(and(...conditions));
  const rows = await db
    .select()
    .from(companies)
    .where(and(...conditions))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getCompany(db: DB, id: string) {
  const rows = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Company not found');
  return rows[0];
}

export async function updateCompany(
  db: DB,
  id: string,
  input: Partial<CreateCompanyInput>,
  actorId: string,
) {
  const row = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (row.length === 0) throw ApiError.notFound('Company not found');
  if (row[0].userId !== actorId) throw ApiError.forbidden();
  const before = row[0];
  await db
    .update(companies)
    .set({
      legalName: input.legalName ?? before.legalName,
      description: input.description ?? before.description,
      logoUrl: input.logoUrl ?? before.logoUrl,
      industry: input.industry ?? before.industry,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, id));
  return getCompany(db, id);
}