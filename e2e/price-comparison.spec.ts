import { test, expect, storageFor } from './helpers';

/**
 * Price Comparison Engine — exercised from the real UI against the real backend
 * and PostgreSQL. The demo seeder ships two comparable items (same item, shared
 * barcode, different sellers, different prices), so these assertions read live
 * API data rather than fixtures.
 */

test.describe('Price comparison (public)', () => {
  test('home page links to the comparison experience', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: /مقارنة الأسعار|Price comparison/i }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/price-comparison/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('searching an item returns a real multi-seller comparison with ranked prices', async ({ page }) => {
    await page.goto('/price-comparison');
    const input = page.getByTestId('comparison-search-input');
    await expect(input).toBeVisible();
    await input.fill('olive oil');
    await page.getByTestId('comparison-search-button').click();

    const group = page.getByTestId('comparison-group').first();
    await expect(group).toBeVisible();

    const offers = group.getByTestId('comparison-offer');
    await expect(offers).toHaveCount(2);

    // A real comparison must show the lowest-price highlight and a non-zero spread.
    await expect(group.getByTestId('lowest-price-badge').first()).toBeVisible();
    const spread = group.getByTestId('price-spread');
    await expect(spread).toBeVisible();
    await expect(spread).not.toHaveText(/0[.,]00/);

    // Prices must be ordered cheapest first.
    const prices = await offers.getByTestId('offer-price').allInnerTexts();
    const numeric = prices.map((p) => Number(p.replace(/[^\d.]/g, '')));
    expect(numeric.length).toBe(2);
    expect(numeric[0]).toBeLessThan(numeric[1]);

    // Availability is shown as a real band, never a raw quantity.
    await expect(offers.getByTestId('offer-availability').first()).toBeVisible();
  });

  test('clicking a seller offer opens the real product detail page', async ({ page }) => {
    await page.goto('/price-comparison?query=olive%20oil');
    const offer = page.getByTestId('comparison-offer').first();
    await expect(offer).toBeVisible();
    await offer.getByRole('link', { name: /عرض المنتج|View product/i }).click();
    await expect(page).toHaveURL(/\/products\//);
  });

  test('shows an empty state for a term with no comparable offers', async ({ page }) => {
    await page.goto('/price-comparison?query=zzz-no-such-product-zzz');
    await expect(page.getByTestId('comparison-group')).toHaveCount(0);
    await expect(page.getByText(/لا توجد عروض قابلة للمقارنة|No comparable offers/i)).toBeVisible();
  });

  test('filtering by search term updates the URL and result set', async ({ page }) => {
    await page.goto('/price-comparison');
    await page.getByTestId('comparison-search-input').fill('dates');
    await page.getByTestId('comparison-search-button').click();
    await expect(page).toHaveURL(/query=dates/);
    await expect(page.getByTestId('comparison-group').first()).toBeVisible();
  });
});

test.describe('Price comparison (dashboard)', () => {
  test.use({ storageState: storageFor('merchant') });

  test('merchant dashboard comparison lists real groups from the live API', async ({ page }) => {
    await page.goto('/dashboard/comparison');
    await page.getByTestId('dashboard-comparison-search-input').fill('olive oil');
    await page.getByTestId('dashboard-comparison-search-button').click();
    await expect(page.getByTestId('dashboard-comparison-group').first()).toBeVisible();
  });
});
