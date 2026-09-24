import { test, expect } from './helpers';

/**
 * Owner Audit Center: `/demo/owner`.
 *
 * A real browser drives the page the WASIT owner opens on the public demo. It is
 * honest in both environments:
 *
 *  * **auto-login on** (public demo): the route opens a real staff session with no
 *    login form, the persona controls switch the session for real (verified through
 *    `GET /api/auth/me`), and RBAC holds — the customer persona is refused by the
 *    staff API exactly as any customer would be;
 *  * **auto-login off** (production, plain dev/test): the endpoint 404s, the page
 *    shows the "not available" state, and no session is minted.
 *
 * Nothing here asserts a page render as success: every claim is confirmed by a
 * follow-up server call that has to carry the session cookie.
 */

const DEMO_TEST_ACCOUNT = 'rhimiimed18@gmail.com';
const SUPER_ADMIN = 'admin@wasit.tn';
const MERCHANT = 'merchanta@wasit.tn';

/** True when the backend has the demo auto-login flag on for this run. */
async function autoLoginEnabled(
  request: import('@playwright/test').APIRequestContext,
): Promise<boolean> {
  return (await request.post('/api/auth/demo-session')).status() === 200;
}

/** Reads the signed-in address, or a sentinel when no session is live. */
async function sessionEmail(page: import('@playwright/test').Page): Promise<string> {
  const me = await page.request.get('/api/auth/me');
  if (me.status() !== 200) return `http-${me.status()}`;
  return ((await me.json()) as { data: { email: string } }).data.email;
}

test.describe('Owner Audit Center', () => {
  test('opens a real staff session from /demo/owner with no login form', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');

    // Lands on the audit center, not the login form.
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/login/);

    // The session is real: it is the super-admin fixture, and the staff API answers it.
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);
    const me = await page.request.get('/api/auth/me');
    const roles = ((await me.json()) as { data: { roles: string[] } }).data.roles;
    expect(roles).toContain('SUPER_ADMIN');
    expect((await page.request.get('/api/admin/stats')).status()).toBe(200);

    // The catalog really rendered: every persona control and a module card exist.
    for (const persona of ['super-admin', 'admin', 'customer', 'merchant', 'supplier', 'company']) {
      await expect(page.getByTestId(`owner-switch-${persona}`)).toBeVisible();
      await expect(page.getByTestId(`owner-session-${persona}`)).toBeVisible();
    }
    await expect(page.getByTestId('owner-module-admin-dashboard')).toBeVisible();
    await expect(page.getByTestId('owner-module-marketplace')).toBeVisible();
  });

  test('switching persona replaces the session, and RBAC follows the role', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    // Switch to the merchant fixture: the session becomes the merchant account.
    await page.getByTestId('owner-session-merchant').click();
    await expect(page.getByTestId('owner-switch-merchant')).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(MERCHANT);

    // A staff-only module is now denied for real — the badge is backed by RBAC.
    expect((await page.request.get('/api/admin/stats')).status()).toBe(403);

    // The customer entry point opens its own account, and never staff.
    await page.getByTestId('owner-session-customer').click();
    await expect(page.getByTestId('owner-switch-customer')).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(DEMO_TEST_ACCOUNT);
    expect((await page.request.get('/api/admin/stats')).status()).toBe(403);

    // And it is a working customer session, not merely a signed-in shell.
    expect((await page.request.get('/api/orders')).status()).toBe(200);
  });

  test('module probes return real status codes against RBAC', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    // As super-admin the admin KPI probe answers 200.
    await page.getByTestId('owner-probe-admin-dashboard').click();
    await expect(page.getByTestId('owner-probe-result-admin-dashboard')).toContainText('200', {
      timeout: 20_000,
    });

    // Switch to the customer, then the same probe is denied — proving the badge is
    // a live server result rather than a static label.
    await page.getByTestId('owner-session-customer').click();
    await expect(page.getByTestId('owner-switch-customer')).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(DEMO_TEST_ACCOUNT);
    await page.getByTestId('owner-probe-admin-dashboard').click();
    await expect(page.getByTestId('owner-probe-result-admin-dashboard')).toContainText('403', {
      timeout: 20_000,
    });
  });

  test('opens a module from the catalog into the real desk', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    await page.getByTestId('owner-open-admin-users').click();
    await page.waitForURL(/\/admin\/users/, { timeout: 20_000 });
    // The desk loads its real rows through the authenticated API.
    expect((await page.request.get('/api/admin/users')).status()).toBe(200);
  });

  test('logout ends the session', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    await page.getByTestId('owner-logout').click();
    await expect(page.getByTestId('owner-logout')).toBeDisabled({ timeout: 20_000 });
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('the endpoint is refused and mints no session when disabled', async ({ page, request }) => {
    test.skip(await autoLoginEnabled(request), 'Auto-login enabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByText(/غير مُتاح|not available/i)).toBeVisible({ timeout: 15_000 });

    const res = await request.post('/api/auth/demo-audit-session', { data: { persona: 'super-admin' } });
    expect([403, 404]).toContain(res.status());
    expect((await request.get('/api/auth/me')).status()).toBe(401);
  });
});

test.describe('Owner Audit Center — security', () => {
  test('the persona comes from the page control, never the query string', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    // A crafted URL asks for the customer persona and smuggles an address and a
    // credential. The app must read neither.
    await page.goto('/demo/owner?persona=customer&email=attacker@evil.example&password=whatever');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });

    // The visitor still lands on the default super-admin session, not the persona
    // the query asked for.
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    // The smuggled values are never reflected into the rendered DOM.
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('attacker@evil.example');
    expect(text).not.toContain('password=whatever');

    // An unknown persona id is refused outright, and grants no session.
    const bogus = await request.post('/api/auth/demo-audit-session', { data: { persona: 'root' } });
    expect(bogus.status()).toBe(400);
  });
});
