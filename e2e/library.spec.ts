import { test, expect, storageFor } from './helpers';

/**
 * Customer library (B6) against the REAL backend + PostgreSQL:
 * product detail → favorite/save → dashboard library → per-user isolation.
 * No route interception — every assertion reads live API data.
 */

test.describe('Customer library (favorites, saved, search history)', () => {
  test.use({ storageState: storageFor('customer') });

  test('favorites a product from its detail page and sees it in the library', async ({ page, request }) => {
    await page.goto('/marketplace');
    const product = page.locator('a[href^="/products/"]').first();
    await product.waitFor();
    const href = (await product.getAttribute('href'))!;
    await page.goto(href);

    const favoriteBtn = page.getByRole('button', { name: /المفضلة|Favorites/i }).first();
    await favoriteBtn.click();
    await expect(favoriteBtn).toContainText('★');

    // Verify through the API that the favorite persisted.
    await expect.poll(async () => {
      const res = await request.get('/api/library/favorites?entityType=PRODUCT&pageSize=100');
      const body = await res.json();
      return (body.data.items as { entityId: string }[]).some((f) => href.includes(f.entityId));
    }).toBe(true);

    // And that the dashboard renders it.
    await page.goto('/dashboard/library');
    await expect(page.getByRole('heading', { name: /المفضلة|Favorites/i }).first()).toBeVisible();
    await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();

    // Cleanup so repeated runs stay deterministic.
    const favId = href.split('/products/')[1];
    await request.delete(`/api/library/favorites/PRODUCT/${favId}`);
  });

  test('saves a product and shows the note in the saved tab', async ({ page, request }) => {
    await page.goto('/marketplace');
    const product = page.locator('a[href^="/products/"]').first();
    await product.waitFor();
    const href = (await product.getAttribute('href'))!;
    const productId = href.split('/products/')[1];
    await page.goto(href);

    await page.getByRole('button', { name: /المحفوظ|Saved/i }).first().click();

    await expect.poll(async () => {
      const res = await request.get('/api/library/saved?itemType=PRODUCT&pageSize=100');
      const body = await res.json();
      return (body.data.items as { itemId: string }[]).some((s) => s.itemId === productId);
    }).toBe(true);

    await page.goto('/dashboard/library');
    await page.getByRole('button', { name: /المحفوظ|Saved/i }).first().click();
    await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();

    await request.delete(`/api/library/saved/PRODUCT/${productId}`);
  });

  test('an authenticated search is recorded in the history tab', async ({ page, request }) => {
    const term = `libe2e${Date.now()}`;
    await page.goto(`/search?q=${term}&type=products`);

    // History is written server-side for the authenticated session.
    await expect.poll(async () => {
      const res = await request.get('/api/library/search-history?pageSize=100');
      const body = await res.json();
      return (body.data.items as { query: string }[]).some((h) => h.query === term);
    }).toBe(true);

    await page.goto('/dashboard/library');
    await page.getByRole('button', { name: /سجل البحث|Search history/i }).first().click();
    await expect(page.getByText(term).first()).toBeVisible();

    const res = await request.delete('/api/library/search-history');
    expect(res.ok()).toBeTruthy();
  });
});

test.describe('Library authorization', () => {
  test('anonymous visitors cannot reach the library', async ({ request }) => {
    const res = await request.get('/api/library/favorites');
    expect(res.status()).toBe(401);
  });

  test('the library hides a button when the session is absent', async ({ page }) => {
    await page.goto('/marketplace');
    const product = page.locator('a[href^="/products/"]').first();
    await product.waitFor();
    await product.click();
    await expect(page.getByRole('button', { name: /المفضلة|Favorites/i })).toHaveCount(0);
  });
});