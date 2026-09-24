import { test, expect, DEMO_TEST_ACCOUNT, DEMO_TEST_ACCOUNT_PASSWORD } from './helpers';

/**
 * The official PUBLIC-DEMO test account (`seed-demo.ts`), exercised through the
 * real UI.
 *
 * It must behave as an ordinary customer — created by the demo seeder, never by
 * a login special-case — so this spec asserts the useful contract and, just as
 * importantly, the absence of privilege: it can sign in and reach its dashboard,
 * and it is refused the staff surface.
 */
test.describe('Official demo test account', () => {
  test('signs in as an ordinary customer from the UI', async ({ page }) => {
    await page.goto('/login');
    await page.locator('form input[type="email"]').fill(DEMO_TEST_ACCOUNT);
    await page.locator('form input[type="password"]').fill(DEMO_TEST_ACCOUNT_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as { data: { email: string; emailVerified: boolean; roles: string[] } };
    expect(body.data.email).toBe(DEMO_TEST_ACCOUNT);
    expect(body.data.emailVerified).toBe(true);
    expect(body.data.roles).toEqual(['CUSTOMER']);
  });

  test('carries no staff privileges', async ({ page }) => {
    await page.goto('/login');
    await page.locator('form input[type="email"]').fill(DEMO_TEST_ACCOUNT);
    await page.locator('form input[type="password"]').fill(DEMO_TEST_ACCOUNT_PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

    // The admin route renders a Forbidden state in place for a normal customer
    // (the URL stays /admin, the page does not), and the API refuses outright.
    await page.goto('/admin');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible({ timeout: 15_000 });

    const kpis = await page.request.get('/api/admin/stats');
    expect(kpis.status()).toBe(403);
  });
});
