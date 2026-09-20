import { and, eq, ilike, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { categories, products } from '../../db/schema/products.js';
import { companies, merchants, suppliers } from '../../db/schema/trade.js';

export interface SearchQuery {
  q: string;
  type?: 'products' | 'suppliers' | 'merchants' | 'companies' | 'categories' | 'locations' | 'all';
  countryId?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  type: string;
  count: number;
  items: Array<Record<string, unknown>>;
}

const MAX_PAGE_SIZE = 50;

export async function runSearch(db: DB, query: SearchQuery) {
  const q = query.q.trim();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));
  const types = query.type === 'all' || !query.type ? ['products', 'suppliers', 'merchants', 'companies', 'categories'] as const : [query.type];

  const results: SearchResult[] = [];

  for (const type of types) {
    if (type === 'products') {
      const conditions = [eq(products.isPublished, true), eq(products.status, 'ACTIVE')];
      if (q) conditions.push(sql`(${products.name} ILIKE ${`%${q}%`} OR ${products.nameAr} ILIKE ${`%${q}%`} OR ${products.nameFr} ILIKE ${`%${q}%`} OR ${products.description} ILIKE ${`%${q}%`})`);
      if (query.countryId) conditions.push(eq(products.countryId, query.countryId));
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(products).where(and(...conditions));
      const rows = await db
        .select({
          id: products.id, name: products.name, nameAr: products.nameAr, nameFr: products.nameFr,
          slug: products.slug, basePrice: products.basePrice, currencyCode: products.currencyCode,
          brand: products.brand, sellerId: products.sellerId, sellerType: products.sellerType,
        })
        .from(products)
        .where(and(...conditions))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      results.push({ type, count: total, items: rows as unknown as Record<string, unknown>[] });
    } else if (type === 'suppliers') {
      const conditions = [eq(suppliers.isActive, true)];
      if (q) conditions.push(ilike(suppliers.companyName, `%${q}%`));
      if (query.countryId) conditions.push(eq(suppliers.countryId, query.countryId));
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(suppliers).where(and(...conditions));
      const rows = await db
        .select({ id: suppliers.id, companyName: suppliers.companyName, slug: suppliers.slug, verified: suppliers.verified, countryId: suppliers.countryId, logoUrl: suppliers.logoUrl })
        .from(suppliers)
        .where(and(...conditions))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      results.push({ type, count: total, items: rows as unknown as Record<string, unknown>[] });
    } else if (type === 'merchants') {
      const conditions = [eq(merchants.isActive, true)];
      if (q) conditions.push(ilike(merchants.storeName, `%${q}%`));
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(merchants).where(and(...conditions));
      const rows = await db
        .select({ id: merchants.id, storeName: merchants.storeName, slug: merchants.slug, verified: merchants.verified, countryId: merchants.countryId, logoUrl: merchants.logoUrl })
        .from(merchants)
        .where(and(...conditions))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      results.push({ type, count: total, items: rows as unknown as Record<string, unknown>[] });
    } else if (type === 'companies') {
      const conditions = [eq(companies.isActive, true)];
      if (q) conditions.push(ilike(companies.legalName, `%${q}%`));
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(companies).where(and(...conditions));
      const rows = await db
        .select({ id: companies.id, legalName: companies.legalName, slug: companies.slug, verified: companies.verified, countryId: companies.countryId, logoUrl: companies.logoUrl })
        .from(companies)
        .where(and(...conditions))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      results.push({ type, count: total, items: rows as unknown as Record<string, unknown>[] });
    } else if (type === 'categories') {
      const conditions = [eq(categories.isActive, true)];
      if (q) conditions.push(ilike(categories.name, `%${q}%`));
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(categories).where(and(...conditions));
      const rows = await db
        .select({ id: categories.id, name: categories.name, nameAr: categories.nameAr, slug: categories.slug })
        .from(categories)
        .where(and(...conditions))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      results.push({ type, count: total, items: rows as unknown as Record<string, unknown>[] });
    }
  }

  return { query: q, page, pageSize, results };
}