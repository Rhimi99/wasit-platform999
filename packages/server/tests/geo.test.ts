import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { countries, regions, cities, currencies, languages, exchangeRates } from '../src/db/schema/geo.js';

const app = createApp();

async function get(path: string) {
  const res = await app.request(path);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: data as any };
}

async function countryByCode(code: string) {
  const [row] = await db.select().from(countries).where(eq(countries.code, code)).limit(1);
  if (!row) throw new Error(`seed missing country ${code}`);
  return row;
}

async function regionByName(name: string) {
  const [row] = await db.select().from(regions).where(eq(regions.name, name)).limit(1);
  if (!row) throw new Error(`seed missing region ${name}`);
  return row;
}

async function cityByName(name: string) {
  const [row] = await db.select().from(cities).where(eq(cities.name, name)).limit(1);
  if (!row) throw new Error(`seed missing city ${name}`);
  return row;
}

// A private, inactive market created for the visibility assertions.
let hiddenCountryId = '';
let hiddenRegionId = '';
let hiddenCityId = '';

beforeAll(async () => {
  hiddenCountryId = randomUUID();
  await db.insert(countries).values({
    id: hiddenCountryId,
    code: 'ZZ',
    iso3: 'ZZZ',
    name: 'Hiddenland',
    nameAr: 'أرض مخفية',
    nameFr: 'Pays caché',
    phonePrefix: '+999',
    currencyCode: 'TND',
    defaultLanguage: 'ar',
    isActive: false,
  });
  hiddenRegionId = randomUUID();
  await db.insert(regions).values({
    id: hiddenRegionId,
    countryId: hiddenCountryId,
    name: 'Hidden Region',
    code: 'HR',
    isActive: false,
  });
  hiddenCityId = randomUUID();
  await db.insert(cities).values({
    id: hiddenCityId,
    regionId: hiddenRegionId,
    name: 'Hidden City',
    isActive: false,
  });
});

afterAll(async () => {
  await db.delete(cities).where(eq(cities.id, hiddenCityId));
  await db.delete(regions).where(eq(regions.id, hiddenRegionId));
  await db.delete(countries).where(eq(countries.id, hiddenCountryId));
});

describe('B5 — geo module (countries / regions / cities / currencies / languages / rates)', () => {
  describe('countries', () => {
    it('lists only active countries and paginates', async () => {
      const r = await get('/api/geo/countries?page=1&pageSize=5');
      expect(r.status).toBe(200);
      expect(r.data.success).toBe(true);
      expect(r.data.data.items.length).toBeLessThanOrEqual(5);
      expect(r.data.data.pagination.page).toBe(1);
      const codes = r.data.data.items.map((c: { code: string }) => c.code);
      expect(codes).toContain('TN');
      expect(codes).not.toContain('ZZ');
    });

    it('filters by query across localized names', async () => {
      const byAr = await get(`/api/geo/countries?q=${encodeURIComponent('تونس')}`);
      expect(byAr.status).toBe(200);
      expect(byAr.data.data.items.some((c: { code: string }) => c.code === 'TN')).toBe(true);

      const byEn = await get('/api/geo/countries?q=Tunis');
      expect(byEn.data.data.items.some((c: { code: string }) => c.code === 'TN')).toBe(true);
    });

    it('fetches a country by id and by code (case-insensitive)', async () => {
      const tn = await countryByCode('TN');
      const byId = await get(`/api/geo/countries/${tn.id}`);
      expect(byId.status).toBe(200);
      expect(byId.data.data.code).toBe('TN');

      const byCode = await get('/api/geo/countries/by-code/tn');
      expect(byCode.status).toBe(200);
      expect(byCode.data.data.id).toBe(tn.id);
    });

    it('hides an inactive country behind a structured 404', async () => {
      const byId = await get(`/api/geo/countries/${hiddenCountryId}`);
      expect(byId.status).toBe(404);
      expect(byId.data.error.code).toBe('NOT_FOUND');

      const byCode = await get('/api/geo/countries/by-code/ZZ');
      expect(byCode.status).toBe(404);
    });

    it('rejects an unknown country with 404', async () => {
      const r = await get(`/api/geo/countries/${randomUUID()}`);
      expect(r.status).toBe(404);
    });
  });

  describe('regions', () => {
    it('lists regions of a country with pagination and search', async () => {
      const tn = await countryByCode('TN');
      const all = await get(`/api/geo/countries/${tn.id}/regions?pageSize=100`);
      expect(all.status).toBe(200);
      expect(all.data.data.items.length).toBeGreaterThan(20);
      expect(all.data.data.items.every((r: { countryId: string }) => r.countryId === tn.id)).toBe(true);

      const filtered = await get(`/api/geo/countries/${tn.id}/regions?q=Sfax`);
      expect(filtered.data.data.items.some((r: { name: string }) => r.name === 'Sfax')).toBe(true);
    });

    it('fetches a region by id and hides inactive regions', async () => {
      const sfax = await regionByName('Sfax');
      const ok = await get(`/api/geo/regions/${sfax.id}`);
      expect(ok.status).toBe(200);
      expect(ok.data.data.name).toBe('Sfax');

      const hidden = await get(`/api/geo/regions/${hiddenRegionId}`);
      expect(hidden.status).toBe(404);
    });
  });

  describe('cities', () => {
    it('lists cities by region and by country', async () => {
      const tunis = await regionByName('Tunis');
      const byRegion = await get(`/api/geo/regions/${tunis.id}/cities?pageSize=100`);
      expect(byRegion.status).toBe(200);
      expect(byRegion.data.data.items.some((c: { name: string }) => c.name === 'La Marsa')).toBe(true);

      const tn = await countryByCode('TN');
      const byCountry = await get(`/api/geo/countries/${tn.id}/cities?q=Sfax&pageSize=100`);
      expect(byCountry.status).toBe(200);
      expect(byCountry.data.data.items.some((c: { name: string }) => c.name === 'Sfax')).toBe(true);
    });

    it('fetches a city by id and hides inactive cities', async () => {
      const marsa = await cityByName('La Marsa');
      const ok = await get(`/api/geo/cities/${marsa.id}`);
      expect(ok.status).toBe(200);
      expect(ok.data.data.name).toBe('La Marsa');

      const hidden = await get(`/api/geo/cities/${hiddenCityId}`);
      expect(hidden.status).toBe(404);
    });
  });

  describe('currencies', () => {
    it('lists active currencies, sorted by code, with search', async () => {
      const all = await get('/api/geo/currencies?pageSize=100');
      expect(all.status).toBe(200);
      const codes = all.data.data.items.map((c: { code: string }) => c.code);
      expect(codes).toContain('TND');
      expect(codes).toContain('EUR');
      expect([...codes].sort()).toEqual(codes);

      const search = await get('/api/geo/currencies?q=Tunisian');
      expect(search.data.data.items.some((c: { code: string }) => c.code === 'TND')).toBe(true);
    });

    it('exposes TND decimal rules and fetches by id/code', async () => {
      const tnd = await get('/api/geo/currencies/by-code/tnd');
      expect(tnd.status).toBe(200);
      expect(tnd.data.data.decimals).toBe(3);
      expect(tnd.data.data.symbol).toBe('د.ت');

      const byId = await get(`/api/geo/currencies/${tnd.data.data.id}`);
      expect(byId.status).toBe(200);
      expect(byId.data.data.code).toBe('TND');
    });

    it('rejects an unknown currency with 404', async () => {
      const r = await get('/api/geo/currencies/by-code/XYZ');
      expect(r.status).toBe(404);
    });
  });

  describe('languages', () => {
    it('lists languages ordered by sortOrder and flags RTL for Arabic', async () => {
      const r = await get('/api/geo/languages');
      expect(r.status).toBe(200);
      const ar = r.data.data.items.find((l: { code: string }) => l.code === 'ar');
      expect(ar).toBeTruthy();
      expect(ar.isRtl).toBe(true);
      expect(r.data.data.items[0].code).toBe('ar');
    });

    it('fetches a language by id and by code', async () => {
      const byCode = await get('/api/geo/languages/by-code/fr');
      expect(byCode.status).toBe(200);
      expect(byCode.data.data.nativeName).toBe('Français');

      const byId = await get(`/api/geo/languages/${byCode.data.data.id}`);
      expect(byId.status).toBe(200);
      expect(byId.data.data.code).toBe('fr');
    });

    it('rejects an unknown language with 404', async () => {
      const r = await get('/api/geo/languages/by-code/xx');
      expect(r.status).toBe(404);
    });
  });

  describe('exchange rates', () => {
    it('returns a list (empty is valid) and filters by from/to code', async () => {
      const rateId = randomUUID();
      await db.insert(exchangeRates).values({
        id: rateId,
        fromCode: 'EUR',
        toCode: 'TND',
        rate: '3.380000',
        effectiveAt: new Date(),
      });
      try {
        const all = await get('/api/geo/exchange-rates');
        expect(all.status).toBe(200);
        expect(Array.isArray(all.data.data.items)).toBe(true);

        const filtered = await get('/api/geo/exchange-rates?fromCode=eur&toCode=tnd');
        expect(filtered.data.data.items.some((x: { id: string }) => x.id === rateId)).toBe(true);
        expect(filtered.data.data.items.every((x: { fromCode: string; toCode: string }) => x.fromCode === 'EUR' && x.toCode === 'TND')).toBe(true);
      } finally {
        await db.delete(exchangeRates).where(eq(exchangeRates.id, rateId));
      }
    });
  });
});