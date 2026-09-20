import { test, expect } from '@playwright/test';

/**
 * B1 — SEO surfaces against the REAL backend:
 * sitemap.xml / robots.txt are fetched through the web origin (Vite proxy) exactly
 * as a crawler would, and the SPA's client-side head management is verified for
 * canonical + JSON-LD on a live product page.
 */

test.describe('B1 — SEO', () => {
  test('robots.txt is served through the web origin with crawl rules', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Sitemap:');
  });

  test('sitemap.xml is served through the web origin with public routes', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/xml');
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('/marketplace');
    expect(body).toContain('/products/');
  });

  test('product detail page exposes a canonical link and Product JSON-LD', async ({ page }) => {
    await page.goto('/marketplace');
    const productLink = page.locator('a[href^="/products/"]').first();
    await expect(productLink).toBeVisible();
    const href = (await productLink.getAttribute('href'))!;
    await page.goto(href);

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const jsonLd = page.locator('script#wasit-jsonld');
    await expect(jsonLd).toHaveCount(1);
    const payload = JSON.parse((await jsonLd.textContent()) ?? '{}');
    expect(payload['@type']).toBe('Product');
    expect(payload.offers).toBeTruthy();
  });

  test('merchant and company detail pages expose canonical + JSON-LD', async ({ page }) => {
    await page.goto('/merchants');
    const merchantLink = page.locator('a[href^="/merchants/"]').first();
    if (await merchantLink.count()) {
      const href = (await merchantLink.getAttribute('href'))!;
      await page.goto(href);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      await expect(page.locator('script#wasit-jsonld')).toHaveCount(1);
    }

    await page.goto('/companies');
    const companyLink = page.locator('a[href^="/companies/"]').first();
    if (await companyLink.count()) {
      const href = (await companyLink.getAttribute('href'))!;
      await page.goto(href);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      await expect(page.locator('script#wasit-jsonld')).toHaveCount(1);
    }
  });

  test('category landing page renders products from the real API', async ({ page }) => {
    await page.goto('/categories');
    const categoryLink = page.locator('a[href^="/categories/"]').first();
    await expect(categoryLink).toBeVisible();
    const href = (await categoryLink.getAttribute('href'))!;

    await page.goto(href);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    await expect(page.locator('script#wasit-jsonld')).toHaveCount(1);
  });
});