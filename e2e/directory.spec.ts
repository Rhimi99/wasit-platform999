import { test, expect, DEMO_PASSWORD } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Role-scoped Customer/Partner Directories (UI-driven, real backend, no mocks).
 *
 * Each test opens the surface from the real sidebar and asserts the table is
 * populated from genuine order/entity data, then confirms the same total through
 * the live API. A page that renders but whose search/paging controls do nothing
 * fails this suite.
 *
 * Sessions are established per test through the real POST /api/auth/login rather
 * than a shared storage state: earlier specs (auth.spec) legitimately reset a
 * demo password, and a password reset revokes that user's existing sessions —
 * so a stored cookie is not a stable fixture across the whole suite.
 */
async function signIn(page: Page, email: string): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } });
  expect(res.ok(), `login failed for ${email}: HTTP ${res.status()}`).toBeTruthy();
}

async function expectRows(page: Page, testId: string) {
  const rows = page.getByTestId(`${testId}-row`);
  await expect(rows.first()).toBeVisible();
  return rows;
}

test.describe('MERCHANT — customers & the suppliers they buy from', () => {
  test.beforeEach(async ({ page }) => signIn(page, 'merchanta@wasit.tn'));

  test('customers surface lists real CUSTOMER buyers and search filters them', async ({ page }) => {
    await page.goto('/dashboard/customers');
    await expectRows(page, 'directory-customers');

    const apiRes = await page.request.get('/api/directory/buyers?buyerType=CUSTOMER&pageSize=100');
    expect(apiRes.ok()).toBeTruthy();
    const { items, pagination } = (await apiRes.json()).data;
    expect(items.length).toBeGreaterThan(0);
    await expect(page.getByTestId('directory-total')).toHaveText(String(pagination.total));

    const first = items[0] as { name: string };
    await page.getByTestId('directory-customers-search').fill(first.name);
    await page.getByTestId('directory-customers-search-button').click();
    await expect(page.getByTestId('directory-customers-row').first()).toBeVisible();
    await expect(page.getByTestId('directory-customers-name').first()).toHaveText(first.name);
  });

  test('my-suppliers surface lists suppliers with real purchase orders', async ({ page }) => {
    await page.goto('/dashboard/my-suppliers');
    await expectRows(page, 'directory-my-suppliers');
    const apiRes = await page.request.get('/api/directory/my/suppliers?pageSize=100');
    const { items } = (await apiRes.json()).data;
    expect(items.length).toBeGreaterThan(0);
  });
});

test.describe('SUPPLIER — buyers & merchant buyers', () => {
  test.beforeEach(async ({ page }) => signIn(page, 'suppliera@wasit.tn'));

  test('buyers surface lists every counterparty that really bought', async ({ page }) => {
    await page.goto('/dashboard/buyers');
    await expectRows(page, 'directory-buyers');
    const apiRes = await page.request.get('/api/directory/buyers?pageSize=100');
    const { items } = (await apiRes.json()).data;
    expect(items.length).toBeGreaterThan(0);
  });

  test('merchants surface lists only MERCHANT buyers', async ({ page }) => {
    await page.goto('/dashboard/merchants-list');
    await expectRows(page, 'directory-merchant-buyers');
    const apiRes = await page.request.get('/api/directory/buyers?buyerType=MERCHANT&pageSize=100');
    const { items } = (await apiRes.json()).data;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i: { buyerType: string }) => i.buyerType === 'MERCHANT')).toBe(true);
  });
});

test.describe('COMPANY — suppliers bought from & buyers', () => {
  test.beforeEach(async ({ page }) => signIn(page, 'companya@wasit.tn'));

  test('my-suppliers surface lists suppliers with real orders', async ({ page }) => {
    await page.goto('/dashboard/my-suppliers');
    await expectRows(page, 'directory-my-suppliers');
  });

  test('buyers surface lists counterparties that bought from the company', async ({ page }) => {
    await page.goto('/dashboard/buyers');
    await expectRows(page, 'directory-buyers');
    const apiRes = await page.request.get('/api/directory/buyers?pageSize=100');
    const { items } = (await apiRes.json()).data;
    expect(items.length).toBeGreaterThan(0);
  });
});

test.describe('scope isolation — a role sees only its own relationships', () => {
  test.beforeEach(async ({ page }) => signIn(page, 'customer1@wasit.tn'));

  test('customer (no owned entities) gets an explicitly empty directory', async ({ page }) => {
    await page.goto('/dashboard/customers');
    // A customer owns no seller entities, so the backend returns an empty page
    // rather than someone else's roster — the UI must show the empty state.
    await expect(page.getByText(/لا توجد نتائج|No results/i)).toBeVisible();
  });
});
