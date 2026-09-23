import { test, expect, storageFor } from './helpers';

/**
 * Admin reports desk — a saved dashboard report must be creatable AND readable
 * from the real interface. Passing this spec requires the payload submitted in
 * the form to come back through `GET /api/admin/analytics/reports` and to be
 * rendered by the page; a 200 on the page is never treated as success.
 */

test.describe('Admin reports desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('creates a report from the UI and reads its payload back', async ({ page }) => {
    const code = `e2e-report-${Date.now()}`;
    const payload = { period: 'W', source: 'e2e' };

    await page.goto('/admin/reports');
    await expect(page.getByTestId('admin-reports-form')).toBeVisible();

    await page.getByTestId('admin-report-code').fill(code);
    await page.getByTestId('admin-report-title').fill('E2E Weekly GMV');
    await page.getByTestId('admin-report-data').fill(JSON.stringify(payload));
    await page.getByTestId('admin-report-submit').click();

    // The saved row appears in the table, keyed by the code the operator typed.
    const row = page.locator('tr', { hasText: code });
    await expect(row).toBeVisible();

    // The same report is visible through the API the page consumes.
    const listed = (await (await page.request.get('/api/admin/analytics/reports')).json()).data.items;
    const apiRow = listed.find((r: { reportCode: string }) => r.reportCode === code);
    expect(apiRow).toBeTruthy();
    expect(apiRow.reportData).toEqual(payload);

    // Clicking "view" reveals the stored payload — proving it round-trips and is
    // not just write-only metadata.
    await row.getByTestId(`admin-report-view-${apiRow.id}`).click();
    const detail = page.getByTestId('admin-report-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('"period"');
    await expect(detail).toContainText('"e2e"');
  });

  test('refresh re-reads reports created behind the page', async ({ page }) => {
    // Open the desk first, so its snapshot predates the new report.
    await page.goto('/admin/reports');
    await expect(page.getByTestId('admin-reports-form')).toBeVisible();
    const rows = page.locator('table.table-base tbody tr');
    await expect.poll(async () => rows.count()).toBeGreaterThan(0);
    const before = await rows.count();

    // Create a report as a *different* admin session while the page is open.
    const code = `e2e-refresh-${Date.now()}`;
    const adminCtx = await page.context().browser()!.newContext({ storageState: storageFor('admin2') });
    const ap = await adminCtx.newPage();
    try {
      const res = await ap.request.post('/api/admin/analytics/reports', {
        data: { reportCode: code, title: 'Behind Page', reportData: { source: 'refresh' } },
      });
      expect(res.ok()).toBeTruthy();
    } finally {
      await adminCtx.close();
    }

    await page.getByTestId('admin-reports-refresh').click();
    await expect.poll(async () => rows.count()).toBeGreaterThan(before);
    await expect(page.locator('tr', { hasText: code })).toBeVisible();
  });

  test('invalid JSON is rejected in the UI without creating a report', async ({ page }) => {
    const code = `e2e-bad-${Date.now()}`;

    await page.goto('/admin/reports');
    await page.getByTestId('admin-report-code').fill(code);
    await page.getByTestId('admin-report-title').fill('Broken');
    await page.getByTestId('admin-report-data').fill('{not json');
    await page.getByTestId('admin-report-submit').click();

    await expect(page.getByText(/JSON/i).first()).toBeVisible();

    const listed = (await (await page.request.get('/api/admin/analytics/reports')).json()).data.items;
    expect(listed.some((r: { reportCode: string }) => r.reportCode === code)).toBe(false);
  });

  test('a non-admin cannot reach the reports endpoint', async ({ browser }) => {
    const customerContext = await browser.newContext({ storageState: storageFor('customer') });
    const res = await customerContext.request.get('/api/admin/analytics/reports');
    expect(res.status()).toBe(403);
    await customerContext.close();
  });
});
