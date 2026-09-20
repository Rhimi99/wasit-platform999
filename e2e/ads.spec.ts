import { test, expect, storageFor } from './helpers';

/**
 * Advertising is a core revenue engine, so its UI flow is exercised against the
 * real campaigns API (no mocks). CAMPAIGN_CREATE is granted to seller roles and
 * staff only — enforced server-side, not just hidden in the UI.
 */

test.describe('Supplier creates a campaign', () => {
  test.use({ storageState: storageFor('supplier') });

  test('campaign is created for the owned advertiser entity and listed', async ({ page }) => {
    await page.goto('/dashboard/ads');
    await expect(page.getByRole('heading', { name: /الإعلانات|Advertising/i }).first()).toBeVisible();

    const title = `E2E Campaign ${Date.now()}`;
    const form = page.locator('form').first();
    await form.locator('input[placeholder]').first().fill(title);
    await form.locator('select').last().selectOption({ index: 1 });
    await form.getByRole('button', { name: /إنشاء|Create/i }).first().click();

    await expect(page.getByText(/تم إنشاء الحملة|Campaign created/i)).toBeVisible();
    await expect(page.getByText(title).first()).toBeVisible();

    // The campaign is persisted: the campaigns API returns it.
    const res = await page.request.get('/api/ads/campaigns');
    const body = await res.json();
    expect(body.data.items.some((c: { title: string }) => c.title === title)).toBe(true);
  });
});

test.describe('Customer is denied campaign creation', () => {
  test.use({ storageState: storageFor('customer') });

  test('GET /api/ads/campaigns is refused by the server RBAC', async ({ page }) => {
    const res = await page.request.get('/api/ads/campaigns');
    expect(res.status()).toBe(403);
  });
});