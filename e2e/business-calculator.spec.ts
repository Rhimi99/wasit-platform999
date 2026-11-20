import { test, expect } from '@playwright/test';

/**
 * PR-05 — business calculator, end to end in a real browser.
 *
 * Database-free by design (run with `playwright.tools.config.ts`): the page is
 * entirely client-side, so it needs only the built web app. This proves the page
 * renders, is reachable from the footer, and that the live math matches the
 * platform's fee model — not just that the module's unit tests pass.
 */

test.describe('PR-05 — business calculator page', () => {
  test('renders and computes the base breakdown on a first visit', async ({ page }) => {
    await page.goto('/tools/calculator');

    await expect(page.getByRole('heading', { name: /حاسبة هامش الأعمال/ })).toBeVisible();
    await expect(page.getByTestId('calc-inputs')).toBeVisible();
    await expect(page.getByTestId('calc-results')).toBeVisible();

    // Defaults: 100 × 1 → buyer pays 102, seller nets 96.
    await expect(page.getByTestId('calc-buyer-total')).toContainText(/102/);
    await expect(page.getByTestId('calc-seller-net')).toContainText(/96/);
    await expect(page.getByTestId('calc-wasit-gross')).toContainText(/6/);
    await expect(page.getByTestId('calc-invalid')).toHaveCount(0);
  });

  test('recomputes live when quantity changes', async ({ page }) => {
    await page.goto('/tools/calculator');

    await page.getByTestId('calc-quantity').fill('3');
    // 100 × 3 = 300 → buyer pays 306, seller nets 288.
    await expect(page.getByTestId('calc-buyer-total')).toContainText(/306/);
    await expect(page.getByTestId('calc-seller-net')).toContainText(/288/);
  });

  test('rejects an invalid quantity instead of showing a number', async ({ page }) => {
    await page.goto('/tools/calculator');

    await page.getByTestId('calc-quantity').fill('0');
    await expect(page.getByTestId('calc-invalid')).toBeVisible();
    await expect(page.getByTestId('calc-seller-net')).toHaveCount(0);
  });

  test('is reachable from the public footer', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /حاسبة الأعمال/ }).first().click();
    await expect(page).toHaveURL(/\/tools\/calculator$/);
    await expect(page.getByTestId('calc-results')).toBeVisible();
  });
});
