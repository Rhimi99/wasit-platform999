import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { env } from '../../lib/env.js';
import { categories, products } from '../../db/schema/products.js';
import { countries } from '../../db/schema/geo.js';
import { suppliers, companies, merchants } from '../../db/schema/trade.js';

export interface SitemapEntry {
  loc: string;
  changefreq: 'hourly' | 'daily' | 'weekly' | 'monthly';
  priority: string;
  lastmod?: string;
}

const MAX_URLS = 5000;

function baseUrl(): string {
  return env.APP_URL.replace(/\/$/, '');
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Public URL for a product: canonical path used by the SPA router. */
export function productUrl(slugOrId: string, locale?: string): string {
  const prefix = locale ? `/${locale}` : '';
  return `${baseUrl()}${prefix}/products/${slugOrId}`;
}

export function supplierUrl(slugOrId: string, locale?: string): string {
  const prefix = locale ? `/${locale}` : '';
  return `${baseUrl()}${prefix}/suppliers/${slugOrId}`;
}

export function companyUrl(slugOrId: string, locale?: string): string {
  const prefix = locale ? `/${locale}` : '';
  return `${baseUrl()}${prefix}/companies/${slugOrId}`;
}

export function merchantUrl(slugOrId: string, locale?: string): string {
  const prefix = locale ? `/${locale}` : '';
  return `${baseUrl()}${prefix}/merchants/${slugOrId}`;
}

export function categoryUrl(slug: string, locale?: string): string {
  const prefix = locale ? `/${locale}` : '';
  return `${baseUrl()}${prefix}/categories/${slug}`;
}

/**
 * Builds the dynamic sitemap. Only ACTIVE, publicly visible entities are listed:
 * active products in active categories, active countries, active suppliers/companies.
 * A hard cap keeps a single response bounded even on large catalogs.
 */
export async function buildSitemap(db: DB): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [
    { loc: `${baseUrl()}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl()}/marketplace`, changefreq: 'hourly', priority: '0.9' },
    { loc: `${baseUrl()}/suppliers`, changefreq: 'daily', priority: '0.8' },
    { loc: `${baseUrl()}/merchants`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl()}/companies`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl()}/categories`, changefreq: 'weekly', priority: '0.7' },
  ];

  const activeCountries = await db
    .select({ code: countries.code })
    .from(countries)
    .where(eq(countries.isActive, true));
  for (const c of activeCountries) {
    entries.push({ loc: `${baseUrl()}/markets/${c.code.toLowerCase()}`, changefreq: 'weekly', priority: '0.6' });
  }

  const activeCats = await db
    .select({ slug: categories.slug, updatedAt: categories.updatedAt })
    .from(categories)
    .where(eq(categories.isActive, true));
  for (const c of activeCats) {
    entries.push({
      loc: categoryUrl(c.slug),
      changefreq: 'weekly',
      priority: '0.6',
      lastmod: c.updatedAt?.toISOString(),
    });
  }

  const activeProducts = await db
    .select({ id: products.id, updatedAt: products.updatedAt })
    .from(products)
    .where(and(eq(products.status, 'ACTIVE'), eq(products.isPublished, true)))
    .limit(MAX_URLS);
  for (const p of activeProducts) {
    entries.push({
      loc: productUrl(p.id),
      changefreq: 'daily',
      priority: '0.7',
      lastmod: p.updatedAt?.toISOString(),
    });
  }

  const activeSuppliers = await db
    .select({ id: suppliers.id, updatedAt: suppliers.updatedAt })
    .from(suppliers)
    .where(eq(suppliers.isActive, true))
    .limit(MAX_URLS);
  for (const s of activeSuppliers) {
    entries.push({ loc: supplierUrl(s.id), changefreq: 'weekly', priority: '0.6', lastmod: s.updatedAt?.toISOString() });
  }

  const activeCompanies = await db
    .select({ id: companies.id, updatedAt: companies.updatedAt })
    .from(companies)
    .where(eq(companies.isActive, true))
    .limit(MAX_URLS);
  for (const co of activeCompanies) {
    entries.push({ loc: companyUrl(co.id), changefreq: 'weekly', priority: '0.6', lastmod: co.updatedAt?.toISOString() });
  }

  const activeMerchants = await db
    .select({ id: merchants.id, updatedAt: merchants.updatedAt })
    .from(merchants)
    .where(eq(merchants.isActive, true))
    .limit(MAX_URLS);
  for (const m of activeMerchants) {
    entries.push({ loc: merchantUrl(m.id), changefreq: 'weekly', priority: '0.6', lastmod: m.updatedAt?.toISOString() });
  }

  return entries;
}

export function renderSitemapIndex(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const parts = [`    <loc>${xmlEscape(e.loc)}</loc>`];
      if (e.lastmod) parts.push(`    <lastmod>${e.lastmod}</lastmod>`);
      parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
      parts.push(`    <priority>${e.priority}</priority>`);
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/** robots.txt — allows crawling of public pages, disallows private areas. */
export function renderRobots(): string {
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /marketplace',
    'Allow: /products/',
    'Allow: /suppliers',
    'Allow: /merchants',
    'Allow: /companies',
    'Allow: /categories',
    'Allow: /markets/',
    // Private / authenticated surfaces.
    'Disallow: /admin',
    'Disallow: /dashboard',
    'Disallow: /onboarding',
    'Disallow: /checkout',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /forgot-password',
    'Disallow: /reset-password',
    'Disallow: /search',
    'Disallow: /api/',
    `Sitemap: ${baseUrl()}/sitemap.xml`,
    '',
  ].join('\n');
}