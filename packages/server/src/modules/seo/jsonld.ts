import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { categories, products, productImages } from '../../db/schema/products.js';
import { countries } from '../../db/schema/geo.js';
import { suppliers, companies, merchants } from '../../db/schema/trade.js';
import { productUrl, supplierUrl, companyUrl, categoryUrl, merchantUrl } from './service.js';

type Json = Record<string, unknown>;

const CURRENCY_BY_PRODUCT = 'product';

/** schema.org Product with an Offer — powers rich product results. */
export async function productJsonLd(db: DB, productId: string): Promise<Json | null> {
  const [p] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!p || p.status !== 'ACTIVE' || !p.isPublished) return null;
  const images = await db
    .select({ url: productImages.url })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  let seller: Json | undefined;
  if (p.sellerType === 'SUPPLIER') {
    const [s] = await db.select().from(suppliers).where(eq(suppliers.id, p.sellerId)).limit(1);
    if (s) seller = { '@type': 'Organization', name: s.companyName, url: supplierUrl(s.id) };
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description ?? undefined,
    sku: p.sku,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    image: images.map((i) => i.url),
    url: productUrl(p.id),
    offers: {
      '@type': 'Offer',
      price: p.basePrice,
      priceCurrency: p.currencyCode,
      availability: p.status === 'ACTIVE' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller,
    },
  };
}

/** schema.org Organization for a supplier storefront. */
export async function supplierJsonLd(db: DB, supplierId: string): Promise<Json | null> {
  const [s] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  if (!s || !s.isActive) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: s.companyName,
    description: s.description ?? undefined,
    url: supplierUrl(s.id),
  };
}

export async function companyJsonLd(db: DB, companyId: string): Promise<Json | null> {
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!co || !co.isActive) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: co.legalName,
    description: co.description ?? undefined,
    url: companyUrl(co.id),
  };
}

export async function merchantJsonLd(db: DB, merchantId: string): Promise<Json | null> {
  const [m] = await db.select().from(merchants).where(eq(merchants.id, merchantId)).limit(1);
  if (!m || !m.isActive) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: m.storeName,
    description: m.description ?? undefined,
    url: merchantUrl(m.id),
  };
}

export async function categoryJsonLd(db: DB, slug: string): Promise<Json | null> {
  const [c] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  if (!c || !c.isActive) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: c.name,
    description: c.description ?? undefined,
    url: categoryUrl(c.slug),
  };
}

export async function countryJsonLd(db: DB, code: string): Promise<Json | null> {
  const [c] = await db.select().from(countries).where(eq(countries.code, code.toUpperCase())).limit(1);
  if (!c || !c.isActive) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: c.name,
    address: { '@type': 'PostalAddress', addressCountry: c.code },
  };
}

export const JSONLD_CURRENCY_KEY = CURRENCY_BY_PRODUCT;