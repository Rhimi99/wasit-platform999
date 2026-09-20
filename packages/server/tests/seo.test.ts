import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { categories, products } from '../src/db/schema/products.js';
import { suppliers, companies, merchants } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';

const app = createApp();

async function get(path: string) {
  const res = await app.request(path);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json: json as any, contentType: res.headers.get('content-type') ?? '' };
}

let categoryId = '';
let categorySlug = '';
let productId = '';
let supplierId = '';
let companyId = '';
let merchantId = '';
let ownerUserId = '';

beforeAll(async () => {
  categorySlug = `seo-cat-${Date.now()}`;
  categoryId = randomUUID();
  await db.insert(categories).values({
    id: categoryId,
    name: `SEO Category ${Date.now()}`,
    nameAr: 'تصنيف السيو',
    slug: categorySlug,
    isActive: true,
  });

  ownerUserId = randomUUID();
  await db.insert(users).values({
    id: ownerUserId,
    email: `seo-owner-${Date.now()}@wasit.tn`,
    passwordHash: 'not-a-real-hash',
    firstName: 'SeoOwner',
    isActive: true,
    emailVerified: true,
  });

  supplierId = randomUUID();
  await db.insert(suppliers).values({
    id: supplierId,
    userId: ownerUserId,
    companyName: 'SEO Test Supplier',
    slug: `seo-sup-${Date.now()}`,
    description: 'A supplier used in SEO tests',
    verified: true,
  });

  companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    userId: ownerUserId,
    legalName: 'SEO Test Company SARL',
    slug: `seo-co-${Date.now()}`,
    description: 'A company used in SEO tests',
  });

  merchantId = randomUUID();
  await db.insert(merchants).values({
    id: merchantId,
    userId: ownerUserId,
    storeName: 'SEO Test Merchant',
    slug: `seo-mer-${Date.now()}`,
    description: 'A merchant used in SEO tests',
  });

  productId = randomUUID();
  await db.insert(products).values({
    id: productId,
    sellerId: supplierId,
    sellerType: 'SUPPLIER',
    categoryId,
    name: 'SEO Test Product',
    nameAr: 'منتج السيو',
    slug: `seo-prod-${Date.now()}`,
    sku: `SKU-SEO-${Date.now()}`,
    description: 'A product used in SEO tests',
    brand: 'WasitBrand',
    currencyCode: 'TND',
    basePrice: '19.5000',
    status: 'ACTIVE',
    isPublished: true,
  });
});

afterAll(async () => {
  await db.delete(products).where(eq(products.id, productId));
  await db.delete(suppliers).where(eq(suppliers.id, supplierId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(merchants).where(eq(merchants.id, merchantId));
  await db.delete(categories).where(eq(categories.id, categoryId));
  closeDb();
});

describe('B1 — SEO surfaces', () => {
  describe('robots.txt', () => {
    it('serves plain text with crawl rules and a sitemap pointer', async () => {
      const r = await get('/robots.txt');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/plain');
      expect(r.text).toContain('User-agent: *');
      expect(r.text).toContain('Disallow: /admin');
      expect(r.text).toContain('Disallow: /dashboard');
      expect(r.text).toContain('Disallow: /api/');
      expect(r.text).toContain('Sitemap: http://localhost:5173/sitemap.xml');
    });
  });

  describe('sitemap.xml', () => {
    it('serves valid XML with the public marketing routes', async () => {
      const r = await get('/sitemap.xml');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('application/xml');
      expect(r.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(r.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(r.text).toContain('<loc>http://localhost:5173/marketplace</loc>');
      expect(r.text).toContain('<loc>http://localhost:5173/suppliers</loc>');
      expect(r.text).toContain('<loc>http://localhost:5173/merchants</loc>');
      expect(r.text).toContain('<loc>http://localhost:5173/companies</loc>');
    });

    it('includes the ACTIVE product, supplier and company just created', async () => {
      const r = await get('/sitemap.xml');
      expect(r.text).toContain(`<loc>http://localhost:5173/products/${productId}</loc>`);
      expect(r.text).toContain(`<loc>http://localhost:5173/suppliers/${supplierId}</loc>`);
      expect(r.text).toContain(`<loc>http://localhost:5173/companies/${companyId}</loc>`);
      expect(r.text).toContain(`<loc>http://localhost:5173/categories/${categorySlug}</loc>`);
    });

    it('excludes private routes and pure search from the sitemap', async () => {
      const r = await get('/sitemap.xml');
      expect(r.text).not.toContain('/admin');
      expect(r.text).not.toContain('/dashboard');
      expect(r.text).not.toContain('/checkout');
      expect(r.text).not.toContain('/login');
      expect(r.text).not.toContain('/search');
    });

    it('excludes non-ACTIVE products from the sitemap', async () => {
      const draftId = randomUUID();
      await db.insert(products).values({
        id: draftId,
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        categoryId,
        name: 'SEO Draft Product',
        slug: `seo-draft-${Date.now()}`,
        sku: `SKU-SEO-DRAFT-${Date.now()}`,
        currencyCode: 'TND',
        basePrice: '5.0000',
        status: 'DRAFT',
        isPublished: false,
      });
      const r = await get('/sitemap.xml');
      expect(r.text).not.toContain(draftId);
      await db.delete(products).where(eq(products.id, draftId));
    });
  });

  describe('structured data (JSON-LD)', () => {
    it('returns a schema.org Product with an Offer for an ACTIVE product', async () => {
      const r = await get(`/api/seo/structured-data/PRODUCT/${productId}`);
      expect(r.status).toBe(200);
      expect(r.json.success).toBe(true);
      expect(r.json.data['@type']).toBe('Product');
      expect(r.json.data.name).toBe('SEO Test Product');
      expect(r.json.data.sku).toBeDefined();
      expect(r.json.data.offers.priceCurrency).toBe('TND');
      expect(r.json.data.offers.price).toBe('19.5000');
      expect(r.json.data.offers.seller.name).toBe('SEO Test Supplier');
    });

    it('returns Organization for a supplier and a company, and Store for a merchant', async () => {
      const s = await get(`/api/seo/structured-data/SUPPLIER/${supplierId}`);
      expect(s.status).toBe(200);
      expect(s.json.data['@type']).toBe('Organization');
      expect(s.json.data.name).toBe('SEO Test Supplier');

      const co = await get(`/api/seo/structured-data/COMPANY/${companyId}`);
      expect(co.status).toBe(200);
      expect(co.json.data['@type']).toBe('Organization');
      expect(co.json.data.name).toBe('SEO Test Company SARL');

      const m = await get(`/api/seo/structured-data/MERCHANT/${merchantId}`);
      expect(m.status).toBe(200);
      expect(m.json.data['@type']).toBe('Store');
      expect(m.json.data.name).toBe('SEO Test Merchant');
    });

    it('does not expose structured data for deactivated entities', async () => {
      await db.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, supplierId));
      const inactive = await get(`/api/seo/structured-data/SUPPLIER/${supplierId}`);
      expect(inactive.status).toBe(404);
      await db.update(suppliers).set({ isActive: true }).where(eq(suppliers.id, supplierId));
    });

    it('returns CollectionPage for a category looked up by slug', async () => {
      const r = await get(`/api/seo/structured-data/CATEGORY/${categorySlug}`);
      expect(r.status).toBe(200);
      expect(r.json.data['@type']).toBe('CollectionPage');
    });

    it('returns 404 for an unknown entity and 422 for an unknown type', async () => {
      const missing = await get(`/api/seo/structured-data/PRODUCT/${randomUUID()}`);
      expect(missing.status).toBe(404);

      const bad = await get('/api/seo/structured-data/WIDGET/abc');
      expect(bad.status).toBe(422);
      expect(bad.json.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
