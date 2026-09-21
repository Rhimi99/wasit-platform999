/**
 * Cache key namespaces and TTLs, in one place so a write and the read it
 * invalidates cannot drift apart. Invalidate a whole namespace by passing the
 * constant with its trailing colon (e.g. `CACHE_PREFIX.GEO`).
 */
export const CACHE_PREFIX = {
  /** Countries, regions, cities, currencies, languages, exchange rates. */
  GEO: 'geo:',
  /** Product categories. */
  CATEGORIES: 'categories:',
  /** SEO sitemap. */
  SEO: 'seo:',
} as const;

/** Reference data changes only through an admin action, so a long TTL is safe. */
export const REFERENCE_DATA_TTL_SECONDS = 300;
