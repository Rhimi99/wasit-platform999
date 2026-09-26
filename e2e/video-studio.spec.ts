import { test, expect, storageFor } from './helpers';

/**
 * Marketing Video Studio — the full merchant journey through the real UI:
 * pick a product, language, audience, style and duration, generate, wait for the
 * asset to become READY, preview it, download it, then delete it.
 *
 * The suite runs against the real `structural` renderer (the offline engine the
 * demo stack installs), so the video is a real MP4 written to local media
 * storage — no mock and no external service.
 */
test.describe('Marketing Video Studio', () => {
  test.use({ storageState: storageFor('merchant') });

  test('generates a real video from the UI, previews, downloads and deletes it', async ({ page }) => {
    await page.goto('/dashboard/video-studio');

    const product = page.getByTestId('studio-product');
    await expect(product).toBeVisible();

    // The select is populated from the merchant's own ACTIVE products, which is
    // what makes the rest of the form usable at all.
    const optionValues = await product.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    expect(optionValues.length).toBeGreaterThan(0);
    await product.selectOption(optionValues[0]);

    await page.getByTestId('studio-language').selectOption('fr');
    await page.getByTestId('studio-audience').selectOption('B2C');
    await page.getByTestId('studio-style').selectOption('BOLD');
    await page.getByTestId('studio-duration').fill('45');

    await page.getByTestId('studio-generate').click();

    // The user gets a real confirmation, and the render is already terminal
    // (READY) for the offline engine rather than a spinner that never resolves.
    await expect(page.getByTestId('studio-notice')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('studio-error')).toHaveCount(0);

    const assets = await (
      await page.request.get('/api/media/assets?kind=MARKETING_VIDEO&limit=50')
    ).json();
    const items = assets.data.items as Array<{
      id: string;
      status: string;
      language: string;
      durationSeconds: number | null;
      mimeType: string;
      sizeBytes: number;
      previewable: boolean;
      downloadUrl: string | null;
    }>;

    const created = items.find((a) => a.language === 'fr' && a.durationSeconds === 45 && a.status !== 'DELETED');
    expect(created, 'a FR/45s marketing video was created server-side').toBeTruthy();
    expect(created!.status).toBe('READY');
    expect(created!.mimeType).toBe('video/mp4');
    expect(created!.sizeBytes).toBeGreaterThan(0);
    expect(created!.previewable).toBe(true);

    // Preview and download are reachable from the card the user actually sees.
    const preview = page.getByTestId(`studio-preview-${created!.id}`);
    await expect(preview).toBeVisible();
    await expect(page.getByTestId(`studio-asset-${created!.id}`)).toContainText('READY');

    const download = page.getByTestId(`studio-download-${created!.id}`);
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    const fetched = await page.request.get(href!);
    expect(fetched.ok()).toBeTruthy();
    expect((await fetched.body()).length).toBeGreaterThan(0);

    // Delete removes it from the library the user is looking at.
    await page.getByTestId(`studio-delete-${created!.id}`).click();
    await expect(page.getByTestId(`studio-asset-${created!.id}`)).toHaveCount(0, { timeout: 20_000 });

    // The removal is a soft delete: the asset is retained as DELETED for the audit
    // trail and its content is unlinked, which is what the UI filter hides.
    const after = await (
      await page.request.get('/api/media/assets?kind=MARKETING_VIDEO&limit=50')
    ).json();
    const deleted = (after.data.items as Array<{ id: string; status: string; downloadUrl: string | null }>).find(
      (a) => a.id === created!.id,
    );
    expect(deleted?.status).toBe('DELETED');
    expect(deleted?.downloadUrl ?? null).toBeNull();
    await expect(page.getByTestId(`studio-asset-${created!.id}`)).toHaveCount(0);
  });

  test('refuses to generate without a product selected', async ({ page }) => {
    await page.goto('/dashboard/video-studio');
    await expect(page.getByTestId('studio-product')).toBeVisible();

    // The form is `required`, so the browser blocks the submit and the user is
    // told what is missing rather than getting a silent no-op.
    await page.getByTestId('studio-duration').fill('45');
    await page.getByTestId('studio-generate').click();

    await expect(page.getByTestId('studio-product')).toBeFocused();
    const product = page.getByTestId('studio-product');
    const invalid = await product.evaluate((el) => !(el as HTMLSelectElement).checkValidity());
    expect(invalid).toBe(true);
  });

  test('a customer cannot reach the studio endpoint', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageFor('customer') });
    const customerPage = await ctx.newPage();

    // The page itself is behind the merchant dashboard layout; the API is the
    // authority and must refuse a caller without the media-upload permission.
    const products = await (await customerPage.request.get('/api/products?limit=1')).json();
    const productId = products.data.items[0].id as string;
    const res = await customerPage.request.post('/api/media/marketing-videos', {
      data: { productId, language: 'ar', audience: 'B2B', style: 'MODERN', durationSeconds: 45 },
    });
    expect(res.status()).toBe(403);

    await ctx.close();
  });
});
