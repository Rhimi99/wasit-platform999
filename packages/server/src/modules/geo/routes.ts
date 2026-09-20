import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateQuery, getValidatedQuery } from '../../middleware/validate.js';
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

geoRoutes.get('/countries', validateQuery(countriesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof countriesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listCountries(ctx.db, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/countries/:id', async (c) => {
  const ctx = getContext(c);
  const country = await getCountryById(ctx.db, c.req.param('id')!);
   return c.json({ success: true, data: country });
});

geoRoutes.get('/countries/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const country = await getCountryByCode(ctx.db, c.req.param('code')!);
   return c.json({ success: true, data: country });
});

geoRoutes.get('/countries/:id/regions', validateQuery(regionsQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof regionsQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listRegionsByCountry(ctx.db, c.req.param('id')!, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/countries/:id/cities', validateQuery(citiesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof citiesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listCitiesByCountry(ctx.db, c.req.param('id')!, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/regions/:id', async (c) => {
  const ctx = getContext(c);
  const region = await getRegionById(ctx.db, c.req.param('id')!);
   return c.json({ success: true, data: region });
});

geoRoutes.get('/regions/:id/cities', validateQuery(citiesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof citiesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listCitiesByRegion(ctx.db, c.req.param('id')!, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/cities/:id', async (c) => {
  const ctx = getContext(c);
  const city = await getCityById(ctx.db, c.req.param('id')!);
   return c.json({ success: true, data: city });
});

geoRoutes.get('/currencies', validateQuery(pageQuery), async (c) => {
  const query = getValidatedQuery<z.infer<typeof pageQuery>>(c);
  const ctx = getContext(c);
  const result = await listCurrencies(ctx.db, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/currencies/:id', async (c) => {
  const ctx = getContext(c);
  const currency = await getCurrencyById(ctx.db, c.req.param('id')!);
   return c.json({ success: true, data: currency });
});

geoRoutes.get('/currencies/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const currency = await getCurrencyByCode(ctx.db, c.req.param('code')!);
   return c.json({ success: true, data: currency });
});

geoRoutes.get('/languages', validateQuery(pageQuery), async (c) => {
  const query = getValidatedQuery<z.infer<typeof pageQuery>>(c);
  const ctx = getContext(c);
  const result = await listLanguages(ctx.db, query);
   return c.json({ success: true, data: result });
});

geoRoutes.get('/languages/:id', async (c) => {
  const ctx = getContext(c);
  const language = await getLanguageById(ctx.db, c.req.param('id')!);
   return c.json({ success: true, data: language });
});

geoRoutes.get('/languages/by-code/:code', async (c) => {
  const ctx = getContext(c);
  const language = await getLanguageByCode(ctx.db, c.req.param('code')!);
   return c.json({ success: true, data: language });
});

geoRoutes.get('/exchange-rates', validateQuery(exchangeRatesQuerySchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof exchangeRatesQuerySchema>>(c);
  const ctx = getContext(c);
  const result = await listExchangeRates(ctx.db, query);
   return c.json({ success: true, data: result });
});