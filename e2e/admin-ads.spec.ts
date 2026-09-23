import { request } from '@playwright/test';
import { test, expect, storageFor } from './helpers';

/**
 * Admin advertising desk — functional audit driven from the browser.
 *
 * `GET /api/admin/ads/summary` was implemented and tested server-side, but no
 * page, route or nav entry ever called it and `api.adminAdsSummary` had zero
 * consumers, so an operator could not see or moderate advertising at all.
 * These tests open the desk from the sidebar, prove the KPIs match the live
 * payload, and pause/end a real campaign through the buttons, confirming the
 * effect against the backend.
 *
 * `page.request` shares the browser context session, so setup/verification hit
 * the same real backend with the same RBAC as the UI.
 */

/**
 * Creates a DRAFT campaign under an advertiser the merchant really owns. Ownership
 * is enforced by the API (only the owning seller may create a campaign), so this
 * must run with the merchant's own session — not the admin's.
 */
async function createMerchantCampaign(title: string): Promise<string> {
  const ctx = await request.newContext({ baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000' });
  const login = await ctx.post('/api/auth/login', { data: { email: 'merchanta@wasit.tn', password: 'Passw0rd!2026' } });
  expect(login.ok()).toBeTruthy();
  const advertisers = (await (await ctx.get('/api/ads/my-advertisers')).json()).data.items as Array<{
    id: string;
    type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  }>;
  expect(advertisers.length).toBeGreaterThan(0);
  const res = await ctx.post('/api/ads/campaigns', {
    data: {
      advertiserId: advertisers[0].id,
      advertiserType: advertisers[0].type,
      title,
      objective: 'PRODUCT_ADS',
      budget: '500',
      currencyCode: 'TND',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  expect(res.status()).toBe(201);
  const id = ((await res.json()).data as { id: string }).id;
  await ctx.dispose();
  return id;
}

test.describe('Admin advertising desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('sidebar opens the desk and KPIs match the live admin summary', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/ads"]').click();
    await expect(page).toHaveURL(/\/admin\/ads/);
    await expect(page.getByRole('heading', { name: /إدارة الإعلانات|Advertising management/i })).toBeVisible();

    // The KPI numbers must come from the server payload, not literals.
    const summary = (await (await page.request.get('/api/admin/ads/summary')).json()).data as {
      campaigns: number;
      activeCampaigns: number;
    };
    await expect(page.getByTestId('admin-ads-kpi-campaigns')).toContainText(String(summary.campaigns));
    await expect(page.getByTestId('admin-ads-kpi-active')).toContainText(String(summary.activeCampaigns));

    // The table lists the real cross-advertiser campaigns with owner context.
    await expect(page.getByTestId('admin-ads-table')).toBeVisible();
    await expect(page.locator('[data-testid^="admin-ads-campaign-"]').first()).toBeVisible();
  });

  test('an admin pauses and ends another advertiser\'s campaign from the UI', async ({ page }) => {
    // Seed a DRAFT campaign under a real demo merchant advertiser.
    const title = `E2E Admin Ads ${Date.now()}`;
    const campaignId = await createMerchantCampaign(title);

    await page.goto('/admin/ads');
    const row = page.getByTestId(`admin-ads-campaign-${campaignId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(title);
    // A DRAFT campaign can only go to ACTIVE or CANCELLED (real state machine).
    await expect(page.getByTestId(`admin-ads-active-${campaignId}`)).toBeVisible();
    await expect(page.getByTestId(`admin-ads-paused-${campaignId}`)).toHaveCount(0);

    // Activate from the UI.
    await page.getByTestId(`admin-ads-active-${campaignId}`).click();
    await expect(page.getByRole('status')).toContainText(/تنشيط|activated/i);
    await expect(row).toContainText('ACTIVE');

    // Pause from the UI.
    await page.getByTestId(`admin-ads-paused-${campaignId}`).click();
    await expect(row).toContainText('PAUSED');

    // Confirm server-side: the campaign is really paused and no longer serving.
    const detail = (await (await page.request.get(`/api/ads/campaigns/${campaignId}`)).json()).data as {
      status: string;
      isActive: boolean;
    };
    expect(detail.status).toBe('PAUSED');
    expect(detail.isActive).toBe(false);

    // End from the UI; a COMPLETED campaign has no further transitions.
    await page.getByTestId(`admin-ads-completed-${campaignId}`).click();
    await expect(row).toContainText('COMPLETED');
    await expect(page.getByTestId(`admin-ads-paused-${campaignId}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-ads-active-${campaignId}`)).toHaveCount(0);

    const ended = (await (await page.request.get(`/api/ads/campaigns/${campaignId}`)).json()).data as { status: string };
    expect(ended.status).toBe('COMPLETED');
  });

  test('refresh re-reads campaign state changed by another actor behind the page', async ({ page }) => {
    await page.goto('/admin/ads');
    await expect(page.getByTestId('admin-ads-table')).toBeVisible();

    // A campaign created only after the page rendered its snapshot.
    const title = `E2E Admin Ads Refresh ${Date.now()}`;
    const campaignId = await createMerchantCampaign(title);
    // The late campaign is not on screen yet — the list is a snapshot.
    await expect(page.getByTestId(`admin-ads-campaign-${campaignId}`)).toHaveCount(0);

    // A different actor activates it directly against the backend.
    const ctx = await request.newContext({ baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000' });
    const login = await ctx.post('/api/auth/login', { data: { email: 'merchanta@wasit.tn', password: 'Passw0rd!2026' } });
    expect(login.ok()).toBeTruthy();
    const activated = await ctx.patch(`/api/ads/campaigns/${campaignId}`, { data: { status: 'ACTIVE' } });
    expect(activated.ok()).toBeTruthy();
    await ctx.dispose();

    // Refresh is a real reload: the new campaign and its server status appear.
    await page.getByTestId('admin-ads-refresh').click();
    const row = page.getByTestId(`admin-ads-campaign-${campaignId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(title);
    await expect(row).toContainText('ACTIVE');
  });

  test('a non-admin cannot reach the ads APIs', async () => {
    // Isolated context: the merchant session must not touch (or log out) the
    // shared admin storage state that the other tests in this file rely on.
    const ctx = await request.newContext({ baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000' });
    const login = await ctx.post('/api/auth/login', { data: { email: 'merchanta@wasit.tn', password: 'Passw0rd!2026' } });
    expect(login.ok()).toBeTruthy();

    expect((await ctx.get('/api/admin/ads/campaigns')).status()).toBe(403);
    expect((await ctx.get('/api/admin/ads/summary')).status()).toBe(403);
    await ctx.dispose();
  });
});
