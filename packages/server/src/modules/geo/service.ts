import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { cities, countries, currencies, exchangeRates, languages, regions } from '../../db/schema/geo';

type CountryRow = typeof countries.$inferSelect;
type RegionRow = typeof regions.$inferSelect;
type CityRow = typeof cities.$inferSelect;
type CurrencyRow = typeof currencies.$inferSelect;
type LanguageRow = typeof languages.$inferSelect;

interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

function paginate(pageRaw?: number, pageSizeRaw?: number): Pagination {
  const page = Math.max(1, pageRaw ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export async function listCountries(
  db: DB,
  query: { q?: string; iso3?: string; page?: number; pageSize?: number },
): Promise<{ items: CountryRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions: (SQL | undefined)[] = [eq(countries.isActive, true)];

  if (query.q) {
    conditions.push(
      or(
        like(countries.name, `%${query.q}%`),
        like(countries.nameAr, `%${query.q}%`),
        like(countries.nameFr, `%${query.q}%`),
        like(countries.code, `%${query.q}%`),
      ),
    );
  }
  if (query.iso3) conditions.push(eq(countries.iso3, query.iso3));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(countries)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(countries)
    .where(and(...conditions))
    .orderBy(asc(countries.name))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getCountryById(db: DB, id: string): Promise<CountryRow> {
  const rows = await db
    .select()
    .from(countries)
    .where(and(eq(countries.id, id), eq(countries.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Country not found');
  return rows[0];
}

export async function getCountryByCode(db: DB, code: string): Promise<CountryRow> {
  const rows = await db
    .select()
    .from(countries)
    .where(and(eq(countries.code, code.toUpperCase()), eq(countries.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Country not found');
  return rows[0];
}

export async function listRegionsByCountry(
  db: DB,
  countryId: string,
  query: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: RegionRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions = [eq(regions.countryId, countryId), eq(regions.isActive, true)];
  if (query.q) conditions.push(like(regions.name, `%${query.q}%`));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(regions)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(regions)
    .where(and(...conditions))
    .orderBy(asc(regions.name))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getRegionById(db: DB, id: string): Promise<RegionRow> {
  const rows = await db
    .select()
    .from(regions)
    .where(and(eq(regions.id, id), eq(regions.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Region not found');
  return rows[0];
}

export async function listCitiesByRegion(
  db: DB,
  regionId: string,
  query: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: CityRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions = [eq(cities.regionId, regionId), eq(cities.isActive, true)];
  if (query.q) conditions.push(like(cities.name, `%${query.q}%`));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cities)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(cities)
    .where(and(...conditions))
    .orderBy(asc(cities.name))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function listCitiesByCountry(
  db: DB,
  countryId: string,
  query: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: CityRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions = [eq(regions.countryId, countryId), eq(cities.isActive, true)];
  if (query.q) conditions.push(like(cities.name, `%${query.q}%`));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cities)
    .innerJoin(regions, eq(cities.regionId, regions.id))
    .where(and(...conditions));

  const rows = await db
    .select({
      id: cities.id,
      regionId: cities.regionId,
      name: cities.name,
      isActive: cities.isActive,
      createdAt: cities.createdAt,
    })
    .from(cities)
    .innerJoin(regions, eq(cities.regionId, regions.id))
    .where(and(...conditions))
    .orderBy(asc(cities.name))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getCityById(db: DB, id: string): Promise<CityRow> {
  const rows = await db
    .select()
    .from(cities)
    .where(and(eq(cities.id, id), eq(cities.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('City not found');
  return rows[0];
}

export async function listCurrencies(
  db: DB,
  query: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: CurrencyRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions: (SQL | undefined)[] = [eq(currencies.isActive, true)];
  if (query.q) {
    conditions.push(or(like(currencies.code, `%${query.q}%`), like(currencies.name, `%${query.q}%`)));
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(currencies)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(currencies)
    .where(and(...conditions))
    .orderBy(asc(currencies.code))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getCurrencyById(db: DB, id: string): Promise<CurrencyRow> {
  const rows = await db
    .select()
    .from(currencies)
    .where(and(eq(currencies.id, id), eq(currencies.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Currency not found');
  return rows[0];
}

export async function getCurrencyByCode(db: DB, code: string): Promise<CurrencyRow> {
  const rows = await db
    .select()
    .from(currencies)
    .where(and(eq(currencies.code, code.toUpperCase()), eq(currencies.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Currency not found');
  return rows[0];
}

export async function listLanguages(
  db: DB,
  query: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: LanguageRow[]; pagination: { page: number; pageSize: number; total: number } }> {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions: (SQL | undefined)[] = [eq(languages.isActive, true)];
  if (query.q) {
    conditions.push(
      or(
        like(languages.code, `%${query.q}%`),
        like(languages.name, `%${query.q}%`),
        like(languages.nativeName, `%${query.q}%`),
      ),
    );
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(languages)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(languages)
    .where(and(...conditions))
    .orderBy(asc(languages.sortOrder), asc(languages.code))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function getLanguageById(db: DB, id: string): Promise<LanguageRow> {
  const rows = await db
    .select()
    .from(languages)
    .where(and(eq(languages.id, id), eq(languages.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Language not found');
  return rows[0];
}

export async function getLanguageByCode(db: DB, code: string): Promise<LanguageRow> {
  const rows = await db
    .select()
    .from(languages)
    .where(and(eq(languages.code, code), eq(languages.isActive, true)))
    .limit(1);

  if (rows.length === 0) throw ApiError.notFound('Language not found');
  return rows[0];
}

export async function listExchangeRates(
  db: DB,
  query: { fromCode?: string; toCode?: string } = {},
): Promise<{ items: Array<typeof exchangeRates.$inferSelect> }> {
  const conditions = [];
  if (query.fromCode) conditions.push(eq(exchangeRates.fromCode, query.fromCode.toUpperCase()));
  if (query.toCode) conditions.push(eq(exchangeRates.toCode, query.toCode.toUpperCase()));

  const rows = await db
    .select()
    .from(exchangeRates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(exchangeRates.effectiveAt));

  return { items: rows };
}