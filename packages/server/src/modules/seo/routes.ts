import { Hono } from 'hono';
import { getDb } from '../../lib/request-context.js';
import { ApiError } from '@wasit/shared';
import {
  buildSitemap,
  renderRobots,
  renderSitemapIndex,
} from './service.js';
import {
  productJsonLd,
  supplierJsonLd,
  companyJsonLd,
  merchantJsonLd,
  categoryJsonLd,
  countryJsonLd,
} from './jsonld.js';

/**
 * Public SEO surfaces. Mounted at the app root (no /api prefix) so crawlers see
 * `/sitemap.xml` and `/robots.txt` at the conventional locations. No auth: these
 * expose only already-public, ACTIVE catalog data.
 */
export const seoRoutes = new Hono();

seoRoutes.get('/sitemap.xml', async (c) => {
  const db = getDb(c);
  const entries = await buildSitemap(db);
  return c.body(renderSitemapIndex(entries), 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
});

seoRoutes.get('/robots.txt', (c) =>
  c.body(renderRobots(), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  }),
);

/**
 * SPA-facing structured data. Mounted under `/api/seo` so it travels through the
 * web dev-server's `/api` proxy alongside every other client call.
 */
export const seoApiRoutes = new Hono();

/**
 * Structured data endpoint for the SPA: the client fetches the schema.org object
 * for the entity it is rendering and injects it as a JSON-LD script tag.
 * Returns 404 when the entity is missing or not public.
 */
seoApiRoutes.get('/structured-data/:type/:id', async (c) => {
  const db = getDb(c);
  const type = (c.req.param('type') ?? '').toUpperCase();
  const id = c.req.param('id')!;
  let data: Record<string, unknown> | null = null;
  switch (type) {
    case 'PRODUCT':
      data = await productJsonLd(db, id);
      break;
    case 'SUPPLIER':
      data = await supplierJsonLd(db, id);
      break;
    case 'COMPANY':
      data = await companyJsonLd(db, id);
      break;
    case 'MERCHANT':
      data = await merchantJsonLd(db, id);
      break;
    case 'CATEGORY':
      data = await categoryJsonLd(db, id);
      break;
    case 'COUNTRY':
      data = await countryJsonLd(db, id);
      break;
    default:
      throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown structured-data type', {
        fieldErrors: [{ field: 'type', message: 'PRODUCT, SUPPLIER, COMPANY, MERCHANT, CATEGORY or COUNTRY', code: 'INVALID_ENUM' }],
      });
  }
  if (!data) throw new ApiError(404, 'NOT_FOUND', 'Entity not found or not public');
  return c.json({ success: true, data });
});