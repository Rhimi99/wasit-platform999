import { test, expect, storageFor } from './helpers';

/**
 * PR-02 slice 2 — Categories Desk, driven from the browser.
 *
 * The page must show the tree the API reports, not a flattened or guessed one:
 * these tests read the same endpoints the page calls and compare the rendered
 * cells against them, then check the drill-down and the filters.
 *
 * Read-only: no category is created, renamed or deactivated here.
 */

test.describe('Admin categories desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('renders the summary and the tree from the live API', async ({ page }) => {
    const summary = (await (await page.request.get('/api/admin/categories/summary')).json()).data as {
      total: number;
      active: number;
      inactive: number;
      roots: number;
      maxDepth: number;
    };

    await page.goto('/admin/categories');
    await expect(page.getByTestId('admin-categories-summary')).toBeVisible();
    await expect(page.getByTestId('admin-categories-summary-total')).toHaveText(String(summary.total));
    await expect(page.getByTestId('admin-categories-summary-active')).toHaveText(String(summary.active));
    await expect(page.getByTestId('admin-categories-summary-inactive')).toHaveText(String(summary.inactive));
    await expect(page.getByTestId('admin-categories-summary-depth')).toHaveText(String(summary.maxDepth));

    const roots = (await (await page.request.get('/api/admin/categories?level=root&pageSize=100')).json()).data
      .items as Array<{ id: string; productCount: number; subtreeProductCount: number }>;
    test.skip(roots.length === 0, 'no categories in this environment');

    const first = roots[0]!;
    await expect(page.getByTestId(`admin-categories-row-${first.id}`)).toBeVisible();
    await expect(page.getByTestId(`admin-categories-products-${first.id}`)).toHaveText(String(first.productCount));
    await expect(page.getByTestId(`admin-categories-subtree-${first.id}`)).toHaveText(
      String(first.subtreeProductCount),
    );
  });

  test('filters by level and drills into a category', async ({ page }) => {
    const roots = (await (await page.request.get('/api/admin/categories?level=root&pageSize=100')).json()).data
      .items as Array<{ id: string; path: string }>;
    test.skip(roots.length === 0, 'no categories in this environment');
    const target = roots[0]!;

    await page.goto('/admin/categories');
    await page.getByTestId('admin-categories-filter-level').selectOption('leaf');
    await page.getByTestId('admin-categories-apply').click();
    await expect(page.getByTestId(`admin-categories-row-${target.id}`)).toHaveCount(0);

    await page.getByTestId('admin-categories-filter-level').selectOption('all');
    await page.getByTestId('admin-categories-apply').click();
    await page.getByTestId(`admin-categories-open-${target.id}`).click();

    const detail = page.getByTestId('admin-categories-detail');
    await expect(detail).toBeVisible();

    const api = (await (await page.request.get(`/api/admin/categories/${target.id}`)).json()).data as {
      category: { path: string; depth: number };
      metrics: { directProducts: number; subtreeProducts: number; children: number; descendants: number };
    };
    await expect(page.getByTestId('admin-categories-detail-path')).toHaveText(api.category.path);
    await expect(page.getByTestId('admin-categories-detail-depth')).toHaveText(String(api.category.depth));
    await expect(page.getByTestId('admin-categories-detail-direct')).toHaveText(
      String(api.metrics.directProducts),
    );
    await expect(page.getByTestId('admin-categories-detail-subtree')).toHaveText(
      String(api.metrics.subtreeProducts),
    );
    await expect(page.getByTestId('admin-categories-detail-descendants')).toHaveText(
      String(api.metrics.descendants),
    );
  });
});

test.describe('Admin categories desk — access control', () => {
  test.use({ storageState: storageFor('customer') });

  test('refuses a customer at the API and hides the desk in the UI', async ({ page }) => {
    expect((await page.request.get('/api/admin/categories/summary')).status()).toBe(403);
    expect((await page.request.get('/api/admin/categories')).status()).toBe(403);

    await page.goto('/admin/categories');
    await expect(page.getByTestId('admin-categories-summary')).toHaveCount(0);
  });
});
