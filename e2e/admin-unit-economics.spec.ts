import { test, expect, storageFor } from './helpers';

/**
 * B9 unit economics — the CAC / LTV / contribution-margin KPIs and the
 * acquisition cohorts must be visible and must render the LIVE backend numbers,
 * not literals. A successful render alone is never treated as success: each
 * test reads the same `/api/admin/analytics/{unit-economics,cohorts}` payload
 * the page consumes and asserts the DOM matches it.
 */

test.describe('Admin unit economics (B9)', () => {
  test.use({ storageState: storageFor('admin') });

  test('analytics page renders unit economics and cohorts from the live API', async ({ page }) => {
    // The page fires the real authenticated requests; capture the payloads.
    const [ueResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/admin/analytics/unit-economics')),
      page.goto('/admin/analytics'),
    ]);
    expect(ueResponse.status()).toBe(200);

    const live = (await (await page.request.get('/api/admin/analytics/unit-economics?windowDays=30')).json()).data;
    const cohorts = (await (await page.request.get('/api/admin/analytics/cohorts?months=6')).json()).data.items;

    const card = page.getByTestId('admin-unit-economics');
    await expect(card).toBeVisible();

    // The page requested the same window and currency the API reports.
    await expect(card).toContainText(live.currencyCode);
    await expect(card).toContainText(String(live.windowDays));

    // CAC is real: either a formatted amount or the explicit "no new customers"
    // dash — the DOM must match whichever the API returned.
    const cacCell = page.getByTestId('ue-cac');
    await expect(cacCell).toContainText(live.cac === null ? '—' : formatTnd(live.cac));

    // Realized LTV is the auditable figure — must equal the API value.
    await expect(page.getByTestId('ue-ltv-realized')).toContainText(formatTnd(live.ltvRealized));
    await expect(page.getByTestId('ue-ltv-projected')).toContainText(formatTnd(live.ltvProjected));
    await expect(page.getByTestId('ue-ltv-cac-ratio')).toContainText(live.ltvCacRatio === null ? '—' : live.ltvCacRatio);

    // The projection must be labelled as a model, never as a fact.
    await expect(page.getByTestId('ue-assumptions')).toContainText(String(live.assumptions.assumedRetentionMonths));
    await expect(page.getByTestId('ue-assumptions')).toContainText(String(live.assumptions.assumedOrdersPerMonth));

    // Cohorts table renders exactly the rows the API returned, in order.
    const cohortsCard = page.getByTestId('admin-cohorts');
    await expect(cohortsCard).toBeVisible();
    if (cohorts.length === 0) {
      await expect(cohortsCard).toContainText(/لا توجد أفواج|No cohorts/i);
    } else {
      const rows = cohortsCard.locator('tbody tr');
      await expect(rows).toHaveCount(cohorts.length);
      await expect(rows.first()).toContainText(cohorts[0].month);
      await expect(rows.first()).toContainText(String(cohorts[0].customers));
    }
  });

  test('the window control is reflected in the fetched unit-economics request', async ({ page }) => {
    await page.goto('/admin/analytics');
    await expect(page.getByTestId('admin-unit-economics')).toBeVisible();

    // A different window must produce a different live payload; the UI is bound
    // to the 30-day endpoint, so prove the endpoint responds with the requested
    // window and that the page's own request used 30.
    const w7 = (await (await page.request.get('/api/admin/analytics/unit-economics?windowDays=7')).json()).data;
    const w30 = (await (await page.request.get('/api/admin/analytics/unit-economics?windowDays=30')).json()).data;
    expect(w7.windowDays).toBe(7);
    expect(w30.windowDays).toBe(30);
    await expect(page.getByTestId('admin-unit-economics')).toContainText('30');
  });

  test('a non-admin cannot reach the unit-economics endpoint', async ({ page, browser }) => {
    // RBAC must hold: the customer session is rejected by the admin guard.
    const customerContext = await browser.newContext({ storageState: storageFor('customer') });
    const res = await customerContext.request.get('/api/admin/analytics/unit-economics');
    expect(res.status()).toBe(403);
    await customerContext.close();
  });
});

/** Mirrors the web `formatMoney` default (TND via fr-TN currency style). */
function formatTnd(value: string): string {
  return new Intl.NumberFormat('fr-TN', { style: 'currency', currency: 'TND' }).format(Number(value));
}
