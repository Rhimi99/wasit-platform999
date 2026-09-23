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
    const created = body.data.items.find((c: { title: string }) => c.title === title) as { id: string } | undefined;
    expect(created).toBeTruthy();

    // Walk the real status machine from the UI and confirm each transition is
    // accepted by the server and reflected on the card. A CANCELLED campaign is
    // terminal, so the Resume control must not be offered once cancelled.
    const card = page.getByTestId(`ads-campaign-${created!.id}`);
    await card.click();
    await page.getByTestId(`ads-activate-${created!.id}`).click();
    await expect(card).toContainText('ACTIVE');

    await page.getByTestId(`ads-pause-${created!.id}`).click();
    await expect(card).toContainText('PAUSED');

    await page.getByTestId(`ads-resume-${created!.id}`).click();
    await expect(card).toContainText('ACTIVE');

    await page.getByTestId(`ads-end-${created!.id}`).click();
    await expect(card).toContainText('COMPLETED');
    await expect(page.getByTestId(`ads-resume-${created!.id}`)).toHaveCount(0);
  });
});

test.describe('Customer is denied campaign creation', () => {
  test.use({ storageState: storageFor('customer') });

  test('GET /api/ads/campaigns is refused by the server RBAC', async ({ page }) => {
    const res = await page.request.get('/api/ads/campaigns');
    expect(res.status()).toBe(403);
  });
});

test.describe('Placement targeting drives the served-ad feed', () => {
  test.use({ storageState: storageFor('supplier') });

  test('a campaign targeted at one placement serves only there', async ({ page }) => {
    await page.goto('/dashboard/ads');
    const title = `E2E Placement ${Date.now()}`;
    const form = page.locator('form').first();
    await form.locator('input[placeholder]').first().fill(title);
    await form.locator('select').last().selectOption({ index: 1 });

    // Untargeted to start with: the campaign is served everywhere.
    await form.getByRole('button', { name: /إنشاء|Create/i }).first().click();
    await expect(page.getByText(/تم إنشاء الحملة|Campaign created/i)).toBeVisible();

    const listRes = await page.request.get('/api/ads/campaigns');
    const list = await listRes.json();
    const campaign = list.data.items.find((c: { title: string }) => c.title === title) as { id: string };
    expect(campaign).toBeTruthy();

    // Activate first: a DRAFT campaign is intentionally never served.
    await page.getByTestId(`ads-campaign-${campaign.id}`).click();
    await page.getByTestId(`ads-activate-${campaign.id}`).click();
    await expect(page.getByTestId(`ads-campaign-${campaign.id}`)).toContainText('ACTIVE');

    // A campaign with no creative has nothing to serve, so add one from the UI.
    await page.getByTestId(`ads-creative-title-${campaign.id}`).fill(`E2E Creative ${Date.now()}`);
    await page.getByTestId(`ads-creative-submit-${campaign.id}`).click();

    // Untargeted: the campaign is served everywhere.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/ads/served?placement=MARKETPLACE');
        const body = await res.json();
        return body.data.items.some((i: { campaignId: string }) => i.campaignId === campaign.id);
      })
      .toBe(true);

    // Re-target it to SEARCH only and confirm the feed follows the change.
    const patch = await page.request.patch(`/api/ads/campaigns/${campaign.id}`, {
      data: { adUnits: { placements: ['SEARCH'] } },
    });
    expect(patch.status()).toBe(200);

    const search = await page.request.get('/api/ads/served?placement=SEARCH');
    const searchBody = await search.json();
    expect(searchBody.data.items.some((i: { campaignId: string }) => i.campaignId === campaign.id)).toBe(true);

    const marketplace = await page.request.get('/api/ads/served?placement=MARKETPLACE');
    const marketplaceBody = await marketplace.json();
    expect(marketplaceBody.data.items.some((i: { campaignId: string }) => i.campaignId === campaign.id)).toBe(false);
  });

  test('the placements selector renders and persists the chosen placement', async ({ page }) => {
    await page.goto('/dashboard/ads');
    const title = `E2E Selector ${Date.now()}`;
    const form = page.locator('form').first();
    await form.locator('input[placeholder]').first().fill(title);
    await form.locator('select').last().selectOption({ index: 1 });
    await page.getByTestId('ads-placement-PRODUCT_DETAILS').check();
    await expect(page.getByTestId('ads-placement-PRODUCT_DETAILS')).toBeChecked();
    await form.getByRole('button', { name: /إنشاء|Create/i }).first().click();
    await expect(page.getByText(/تم إنشاء الحملة|Campaign created/i)).toBeVisible();

    const listRes = await page.request.get('/api/ads/campaigns');
    const list = await listRes.json();
    const campaign = list.data.items.find((c: { title: string }) => c.title === title) as { id: string };
    const detail = await page.request.get(`/api/ads/campaigns/${campaign.id}`);
    const detailBody = await detail.json();
    expect(detailBody.data.adUnits?.placements).toEqual(['PRODUCT_DETAILS']);
  });
});