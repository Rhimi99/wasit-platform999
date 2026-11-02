import { request } from '@playwright/test';
import { test, expect, storageFor } from './helpers';

/**
 * Admin trade desk — seller vetting driven from the browser.
 *
 * `verified` and `isActive` on suppliers / merchants / companies are read by the
 * public directory, search and sitemap, but nothing wrote them: the trust badge
 * could never be earned and a seller could not be suspended. These tests open the
 * new desk from the sidebar, verify a real entity through the button, prove the
 * badge reaches the public directory, then suspend it and prove it disappears from
 * that directory — and finally restore the entity's original flags so the shared
 * demo data is left exactly as it was found.
 *
 * `page.request` shares the browser session, so setup/verification hit the same
 * real backend with the same RBAC as the UI.
 */

interface TradeRow {
  id: string;
  kind: string;
  name: string;
  verified: boolean;
  isActive: boolean;
}

test.describe('Admin trade desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('an admin verifies and suspends a supplier, with the directory following', async ({ page }) => {
    // Target the seeded demo supplier by name: the demo DB is shared across the
    // suite, and other specs create their own suppliers, so "first row" is not
    // deterministic. Record its starting flags so the test can restore them.
    const DEMO_SUPPLIER = 'Tunisian Harvest Exports SARL';
    const list = await page.request.get(`/api/admin/trade/suppliers?q=${encodeURIComponent(DEMO_SUPPLIER)}`);
    expect(list.ok()).toBeTruthy();
    const suppliers = ((await list.json()).data.items as TradeRow[]);
    const target = suppliers.find((s) => s.name === DEMO_SUPPLIER) ?? suppliers[0];
    expect(target).toBeDefined();
    const original = { verified: target.verified, isActive: target.isActive };

    try {
      await page.goto('/admin/trade');
      const row = page.getByTestId(`admin-trade-row-${target.id}`);
      await expect(row).toBeVisible();

      // Verify through the UI (only click if it starts unverified, else the
      // toggle would remove the badge we then assert on).
      if (!target.verified) {
        await page.getByTestId(`admin-trade-toggle-verified-${target.id}`).click();
        await expect(page.getByTestId('admin-trade-notice')).toBeVisible();
      }
      await expect(page.getByTestId(`admin-trade-verified-${target.id}`)).toContainText(/Verified|موثّق/i);

      // The badge the public directory serves is now true.
      const dir = await page.request.get(`/api/directory/suppliers?q=${encodeURIComponent(DEMO_SUPPLIER)}`);
      expect(dir.ok()).toBeTruthy();
      const dirRow = ((await dir.json()).data.items as Array<{ id: string; verified: boolean }>).find((r) => r.id === target.id);
      expect(dirRow?.verified).toBe(true);

      // Suspend: the entity leaves the public directory.
      await page.getByTestId(`admin-trade-toggle-active-${target.id}`).click();
      await expect(page.getByTestId(`admin-trade-active-${target.id}`)).toContainText(/Off|إيقاف|معطّل/i);

      const dirAfter = await page.request.get(`/api/directory/suppliers?q=${encodeURIComponent(DEMO_SUPPLIER)}`);
      const stillListed = ((await dirAfter.json()).data.items as Array<{ id: string }>).some((r) => r.id === target.id);
      expect(stillListed).toBe(false);

      // The desk still shows it (so it can be brought back).
      await page.reload();
      await expect(page.getByTestId(`admin-trade-row-${target.id}`)).toBeVisible();
    } finally {
      // Restore the exact starting state via the API.
      await page.request.patch(`/api/admin/trade/suppliers/${target.id}`, { data: original });
    }
  });

  test('the desk exposes all three seller kinds', async ({ page }) => {
    await page.goto('/admin/trade');
    for (const kind of ['suppliers', 'merchants', 'companies']) {
      await expect(page.getByTestId(`admin-trade-tab-${kind}`)).toBeVisible();
    }
    await page.getByTestId('admin-trade-tab-merchants').click();
    const res = await page.request.get('/api/admin/trade/merchants?pageSize=1');
    expect(res.ok()).toBeTruthy();
  });

  test('the trade desk API refuses an unauthenticated caller', async () => {
    // `request.newContext()` inherits the suite's `storageState`, so an explicit
    // empty state is required to be truly anonymous; without it the admin cookie
    // would be sent and the guard would never be exercised.
    const anon = await request.newContext({
      baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000',
      storageState: { cookies: [], origins: [] },
    });
    const res = await anon.get('/api/admin/trade/suppliers');
    expect(res.status()).toBe(401);
    await anon.dispose();
  });
});
