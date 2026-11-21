import { test, expect, storageFor } from './helpers';

/**
 * Owner Audit Center: `/demo/owner`.
 *
 * DEMO-SEC-01 — the page is an operator tool, not a public entry point. The spec
 * proves the boundary from both sides:
 *
 *  * an anonymous visitor sees the staff-only notice, receives no session, and
 *    `POST /api/auth/demo-audit-session` answers 401 (or 404 where demo mode is
 *    off) — the public URL can no longer mint a SUPER_ADMIN session;
 *  * a staff session (real cookie from `global-setup`) can open the center, and
 *    every claim is confirmed by a follow-up server call;
 *  * an ADMIN session is refused the SUPER_ADMIN desk (403) but may open a trade
 *    desk — a persona never outranks its caller;
 *  * switching persona replaces the session for real, and RBAC follows the role.
 */

const DEMO_TEST_ACCOUNT = 'demo@wasit.tn';
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

test.describe('Owner Audit Center — anonymous visitor', () => {
  test('is shown a staff-only notice and receives no session', async ({ page }) => {
    await page.goto('/demo/owner');

    await expect(page.getByTestId('owner-staff-only')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('owner-roles')).toHaveCount(0);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);

    // The API refuses the escalation directly, not just the UI.
    const res = await page.request.post('/api/auth/demo-audit-session', {
      data: { persona: 'super-admin' },
    });
    expect([401, 404]).toContain(res.status());
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });
});

test.describe('Owner Audit Center — super-admin session', () => {
  test.use({ storageState: storageFor('admin') });

  test('opens the center for a staff session', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');

    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('owner-staff-only')).toHaveCount(0);
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
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(MERCHANT);

    // A staff-only module is now denied for real — the badge is backed by RBAC.
    expect((await page.request.get('/api/admin/stats')).status()).toBe(403);
    // The customer desk still works for that role.
    expect((await page.request.get('/api/orders')).status()).toBe(200);

    // The page itself now shows the staff-only notice: the merchant session has
    // no business in the operator tool, and the server would refuse it anyway.
    await expect(page.getByTestId('owner-staff-only')).toBeVisible({ timeout: 20_000 });
  });

  test('module probes return real status codes against RBAC', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    await page.getByTestId('owner-probe-admin-dashboard').click();
    await expect(page.getByTestId('owner-probe-result-admin-dashboard')).toContainText('200', {
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
    expect((await page.request.get('/api/admin/users')).status()).toBe(200);
  });

  test('logout ends the session', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionEmail(page), { timeout: 20_000 }).toBe(SUPER_ADMIN);

    await page.getByTestId('owner-logout').click();
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('an unknown persona id is refused and grants no session', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });

    const before = await sessionEmail(page);
    const bogus = await page.request.post('/api/auth/demo-audit-session', {
      data: { persona: 'root' },
    });
    expect(bogus.status()).toBe(400);
    expect(await sessionEmail(page)).toBe(before);
  });
});

test.describe('Owner Audit Center — ADMIN session cannot escalate', () => {
  test.use({ storageState: storageFor('admin2') });

  test('sees trade desks but is refused the SUPER_ADMIN desk', async ({ page, request }) => {
    test.skip(!(await autoLoginEnabled(request)), 'Auto-login disabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-roles')).toBeVisible({ timeout: 20_000 });

    // The UI mirrors the server rule: no SUPER_ADMIN switch for an ADMIN.
    await expect(page.getByTestId('owner-switch-super-admin')).toHaveCount(0);
    await expect(page.getByTestId('owner-switch-merchant')).toBeVisible();

    // And the API refuses it even if the UI were bypassed.
    const denied = await page.request.post('/api/auth/demo-audit-session', {
      data: { persona: 'super-admin' },
    });
    expect(denied.status()).toBe(403);

    // A trade desk is allowed and opens a real session.
    const allowed = await page.request.post('/api/auth/demo-audit-session', {
      data: { persona: 'customer' },
    });
    expect(allowed.status()).toBe(200);
    expect(await sessionEmail(page)).toBe(DEMO_TEST_ACCOUNT);
  });
});

test.describe('Owner Audit Center — demo mode off', () => {
  test('the endpoint is refused and mints no session when disabled', async ({ page, request }) => {
    test.skip(await autoLoginEnabled(request), 'Auto-login enabled for this run.');

    await page.goto('/demo/owner');
    await expect(page.getByTestId('owner-staff-only')).toBeVisible({ timeout: 20_000 });

    const res = await request.post('/api/auth/demo-audit-session', {
      data: { persona: 'super-admin' },
    });
    expect(res.status()).toBe(404);
    expect((await request.get('/api/auth/me')).status()).toBe(401);
  });
});
