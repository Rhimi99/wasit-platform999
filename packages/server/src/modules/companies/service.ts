import { and, eq, ilike, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { companies } from '../../db/schema/trade.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';
import { isEntityStaff, type EntityViewer } from '../../lib/entity-access.js';

/**
 * The company columns a public profile may expose. The legal identifiers
 * (`registrationNumber`, `taxId`) are private, as are `userId`, `isActive` and the
 * timestamps — none of them reach a public response.
 */
export const COMPANY_PUBLIC_FIELDS = {
  id: companies.id,
  legalName: companies.legalName,
  slug: companies.slug,
  countryId: companies.countryId,
  cityId: companies.cityId,
  industry: companies.industry,
  description: companies.description,
  logoUrl: companies.logoUrl,
  verified: companies.verified,
} as const;

/** Public fields plus the columns needed to authorize the caller (never returned). */
const COMPANY_ROW_FIELDS = {
  ...COMPANY_PUBLIC_FIELDS,
  userId: companies.userId,
  isActive: companies.isActive,
  registrationNumber: companies.registrationNumber,
  taxId: companies.taxId,
} as const;

/** Strips the authorization-only and private columns, yielding the public projection. */
function toPublicCompany(row: Record<string, unknown>): Record<string, unknown> {
  const { userId: _userId, isActive: _isActive, registrationNumber: _rn, taxId: _taxId, ...publicFields } = row;
  void _userId;
  void _isActive;
  void _rn;
  void _taxId;
  return publicFields;
}

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
    .select(COMPANY_PUBLIC_FIELDS)
    .from(companies)
    .where(and(...conditions))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows, pagination: { page, pageSize, total } };
}

/**
 * A single company profile.
 *
 * Everyone receives the public projection (no legal/tax identifiers). The owner
 * and internal staff additionally receive `registrationNumber`/`taxId`. An
 * inactive profile is a 404 to the public and to anyone who is not the
 * owner/staff.
 */
export async function getCompany(db: DB, id: string, viewer: EntityViewer = {}) {
  const rows = await db.select(COMPANY_ROW_FIELDS).from(companies).where(eq(companies.id, id)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Company not found');

  const isOwner = !!viewer.userId && viewer.userId === rows[0].userId;
  const isStaff = isEntityStaff(viewer);
  if (!rows[0].isActive && !isOwner && !isStaff) throw ApiError.notFound('Company not found');

  const publicFields = toPublicCompany(rows[0] as unknown as Record<string, unknown>);
  if (isOwner || isStaff) {
    return {
      ...publicFields,
      registrationNumber: rows[0].registrationNumber,
      taxId: rows[0].taxId,
    };
  }
  return publicFields;
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
  // The owner just wrote the row, so the private/owner view is the right response.
  return getCompany(db, id, { userId: actorId });
}