import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateQuery, getValidatedQuery } from '../../middleware/validate.js';
import { cached } from '../../lib/cache/resolve.js';
import { CACHE_PREFIX, REFERENCE_DATA_TTL_SECONDS } from '../../lib/cache/keys.js';
import {
  getCityById,
  getCountryByCode,
  getCountryById,
  getCurrencyByCode,
  getCurrencyById,
  getLanguageByCode,
  getLanguageById,
  getRegionById,
  listCitiesByCountry,
  listCitiesByRegion,
  listCountries,
  listCurrencies,
  listExchangeRates,
  listLanguages,
  listRegionsByCountry,
} from './service.js';

const pageQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const countriesQuerySchema = pageQuery.extend({
  q: z.string().max(200).optional(),
  iso3: z.string().length(3).optional(),
});

const regionsQuerySchema = pageQuery.extend({
  q: z.string().max(200).optional(),
});

const citiesQuerySchema = pageQuery.extend({
  q: z.string().max(200).optional(),
});

const exchangeRatesQuerySchema = z.object({
  fromCode: z.string().length(3).optional(),
  toCode: z.string().length(3).optional(),
});

export const geoRoutes = new Hono();

/**
 * Geo reference data is read on nearly every page and written only by seeding or
 * an admin action, so every read below is cached under `CACHE_PREFIX.GEO` and
 * the admin activation route invalidates the namespace on write.
 */
geoRoutes.get('/countries', validateQuery(countriesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof countriesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}countries:${query.page ?? 1}:${query.pageSize ?? 20}:${query.q ?? ''}:${query.iso3 ?? ''}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listCountries(ctx.db, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/countries/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const country = await cached(
    `${CACHE_PREFIX.GEO}country-by-code:${c.req.param('code')!.toUpperCase()}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getCountryByCode(ctx.db, c.req.param('code')!),
  );
   return c.json({ success: true, data: country });
});

geoRoutes.get('/countries/:id', async (c) => {
  const ctx = getContext(c);
  const country = await cached(
    `${CACHE_PREFIX.GEO}country:${c.req.param('id')}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getCountryById(ctx.db, c.req.param('id')!),
  );
   return c.json({ success: true, data: country });
});

geoRoutes.get('/countries/:id/regions', validateQuery(regionsQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof regionsQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}regions:${c.req.param('id')}:${query.page ?? 1}:${query.pageSize ?? 20}:${query.q ?? ''}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listRegionsByCountry(ctx.db, c.req.param('id')!, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/countries/:id/cities', validateQuery(citiesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof citiesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}country-cities:${c.req.param('id')}:${query.page ?? 1}:${query.pageSize ?? 20}:${query.q ?? ''}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listCitiesByCountry(ctx.db, c.req.param('id')!, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/regions/:id', async (c) => {
  const ctx = getContext(c);
  const region = await cached(
    `${CACHE_PREFIX.GEO}region:${c.req.param('id')}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getRegionById(ctx.db, c.req.param('id')!),
  );
   return c.json({ success: true, data: region });
});

geoRoutes.get('/regions/:id/cities', validateQuery(citiesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof citiesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}region-cities:${c.req.param('id')}:${query.page ?? 1}:${query.pageSize ?? 20}:${query.q ?? ''}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listCitiesByRegion(ctx.db, c.req.param('id')!, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/cities/:id', async (c) => {
  const ctx = getContext(c);
  const city = await cached(
    `${CACHE_PREFIX.GEO}city:${c.req.param('id')}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getCityById(ctx.db, c.req.param('id')!),
  );
   return c.json({ success: true, data: city });
});

geoRoutes.get('/currencies', validateQuery(pageQuery), async (c) => {
  const query = getValidatedQuery<z.infer<typeof pageQuery>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}currencies:${query.page ?? 1}:${query.pageSize ?? 20}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listCurrencies(ctx.db, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/currencies/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const currency = await cached(
    `${CACHE_PREFIX.GEO}currency-by-code:${c.req.param('code')!.toUpperCase()}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getCurrencyByCode(ctx.db, c.req.param('code')!),
  );
   return c.json({ success: true, data: currency });
});

geoRoutes.get('/currencies/:id', async (c) => {
  const ctx = getContext(c);
  const currency = await cached(
    `${CACHE_PREFIX.GEO}currency:${c.req.param('id')}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getCurrencyById(ctx.db, c.req.param('id')!),
  );
   return c.json({ success: true, data: currency });
});

geoRoutes.get('/languages', validateQuery(pageQuery), async (c) => {
  const query = getValidatedQuery<z.infer<typeof pageQuery>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}languages:${query.page ?? 1}:${query.pageSize ?? 20}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listLanguages(ctx.db, query),
  );
   return c.json({ success: true, data: result });
});

geoRoutes.get('/languages/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const language = await cached(
    `${CACHE_PREFIX.GEO}language-by-code:${c.req.param('code')!}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getLanguageByCode(ctx.db, c.req.param('code')!),
  );
   return c.json({ success: true, data: language });
});

geoRoutes.get('/languages/:id', async (c) => {
  const ctx = getContext(c);
  const language = await cached(
    `${CACHE_PREFIX.GEO}language:${c.req.param('id')}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => getLanguageById(ctx.db, c.req.param('id')!),
  );
   return c.json({ success: true, data: language });
});

geoRoutes.get('/exchange-rates', validateQuery(exchangeRatesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof exchangeRatesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await cached(
    `${CACHE_PREFIX.GEO}exchange-rates:${query.fromCode ?? ''}:${query.toCode ?? ''}`,
    REFERENCE_DATA_TTL_SECONDS,
    () => listExchangeRates(ctx.db, query),
  );
   return c.json({ success: true, data: result });
});