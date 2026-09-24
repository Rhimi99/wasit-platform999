import { test, expect } from './helpers';

/**
 * Public-demo auto-login entry point: `POST /api/auth/demo-session`, reached in
 * the UI through the `/demo/customer` SPA route.
 *
 * The endpoint is gated by the backend flag (`DEMO_AUTO_LOGIN`), which is
 * independent of the web build, so this spec probes the flag rather than guessing
 * from the DOM. It is honest in both environments:
 *
 *  * **auto-login on** (public demo): `/demo/customer` lands on the dashboard with
 *    a real session, confirmed server-side through `GET /api/auth/me` — never a
 *    redirect alone, which would pass even if no session were issued;
 *  * **auto-login off** (production, plain dev/test): the endpoint is refused, the
 *    page shows the "not available" state, and no session is minted.
 */

/** The one account the demo seeder provisions; auto-login never mints staff. */
const DEMO_TEST_ACCOUNT = 'rhimiimed18@gmail.com';

async function autoLoginEnabled(
  request: import('@playwright/test').APIRequestContext,
): Promise<boolean> {
  const res = await request.post('/api/auth/demo-session');
  return res.status() === 200;
}

test.describe('Public-demo auto-login entry point', () => {
  test('opens a real customer session from /demo/customer', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    // A visitor arrives with no credentials and no login form.
    await page.goto('/demo/customer');
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

    // The session is real and belongs to the one seeded demo account.
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as {
      data: { email: string; roles: string[]; emailVerified: boolean };
    };
    expect(body.data.email).toBe(DEMO_TEST_ACCOUNT);
    expect(body.data.emailVerified).toBe(true);
    expect(body.data.roles).toEqual(['CUSTOMER']);

    // The authenticated dashboard chrome is rendered, not the public header.
    await expect(page.locator('a[href="/dashboard/orders"]').first()).toBeVisible();
  });

  test('the auto-login session reaches no staff surface', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/customer');
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

    const kpis = await page.request.get('/api/admin/stats');
    expect(kpis.status()).toBe(403);
  });

  test('the endpoint is refused and mints no session when disabled', async ({ page, request }) => {
    test.skip(await autoLoginEnabled(request), 'Auto-login enabled for this run.');

    // The page itself tells the visitor auto-login is unavailable, rather than
    // silently failing or bouncing to the login form.
    await page.goto('/demo/customer');
    await expect(page.getByText(/غير مُتاح|not available/i)).toBeVisible({ timeout: 15_000 });

    const res = await request.post('/api/auth/demo-session');
    expect([403, 404]).toContain(res.status());

    const me = await request.get('/api/auth/me');
    expect(me.status()).toBe(401);
  });
});
