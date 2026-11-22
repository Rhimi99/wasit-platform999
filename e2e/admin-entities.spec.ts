import { test, expect, storageFor } from './helpers';

/**
 * PR-02 slice 1 — Entities Desk, driven from the browser.
 *
 * The console could list users and products but never the businesses behind
 * them. These tests open the real page, switch between the three entity types,
 * filter, and drill into a single business, then confirm the numbers the page
 * shows are the ones the API reports — so a card that rendered a placeholder
 * would fail here.
 *
 * Read-only: nothing in this spec changes an entity's standing.
 */

test.describe('Admin entities desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('renders summary and rows from the live API for each entity type', async ({ page }) => {
    const summary = (await (await page.request.get('/api/admin/entities/summary')).json()).data.items as Array<{
      type: string;
      total: number;
      active: number;
      inactive: number;
      verified: number;
      newLast30Days: number;
    }>;
    expect(summary.length).toBe(3);

    await page.goto('/admin/entities');
    await expect(page.getByTestId('admin-entities-summary')).toBeVisible();

    for (const entityType of ['merchant', 'supplier', 'company']) {
      const block = summary.find((s) => s.type === entityType)!;
      await page.getByTestId(`admin-entities-tab-${entityType}`).click();
      await expect(page.getByTestId('admin-entities-summary-total')).toHaveText(String(block.total));
      await expect(page.getByTestId('admin-entities-summary-active')).toHaveText(String(block.active));
      await expect(page.getByTestId('admin-entities-summary-inactive')).toHaveText(String(block.inactive));
      await expect(page.getByTestId('admin-entities-summary-verified')).toHaveText(String(block.verified));
    }
  });

  test('filters by status and drills into one business', async ({ page }) => {
    await page.goto('/admin/entities');

    const apiRows = (await (await page.request.get('/api/admin/entities?type=merchant&pageSize=100')).json()).data
      .items as Array<{ id: string; name: string; productCount: number; orderCount: number }>;
    test.skip(apiRows.length === 0, 'no merchants in this environment');

    const target = apiRows[0]!;
    await expect(page.getByTestId(`admin-entities-row-${target.id}`)).toBeVisible();

    await page.getByTestId(`admin-entities-open-${target.id}`).click();
    const detail = page.getByTestId('admin-entities-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(target.name);

    const detailApi = (await (await page.request.get(`/api/admin/entities/merchant/${target.id}`)).json()).data;
    await expect(page.getByTestId('admin-entities-detail-orders')).toHaveText(String(detailApi.metrics.orders));
    await expect(page.getByTestId('admin-entities-detail-products')).toHaveText(
      `${detailApi.metrics.publishedProducts} / ${detailApi.metrics.products}`,
    );

    // Suspended-only view must not contain an active entity.
    await page.getByTestId('admin-entities-filter-status').selectOption('inactive');
    await page.getByTestId('admin-entities-apply').click();
    await expect(page.getByTestId(`admin-entities-row-${target.id}`)).toHaveCount(0);
  });

});

test.describe('Admin entities desk — access control', () => {
  test.use({ storageState: storageFor('customer') });

  test('refuses a customer at the API and hides the desk in the UI', async ({ page }) => {
    const summary = await page.request.get('/api/admin/entities/summary');
    expect(summary.status()).toBe(403);

    await page.goto('/admin/entities');
    await expect(page.getByTestId('admin-entities-summary')).toHaveCount(0);
  });
});
