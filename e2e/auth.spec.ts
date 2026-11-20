import { test, expect, storageFor, loginViaUi, resetPasswordViaApi, DEMO_USERS, DEMO_PASSWORD, E2E_API_URL } from './helpers';
import { request, type Page } from '@playwright/test';

/**
 * Authentication E2E: the real login/register/reset forms against the live API.
 * These specs deliberately drive the UI form (not stored sessions).
 */

test.describe('Login form', () => {
  test('rejects bad credentials with an accessible error', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer, 'WrongPassword!1');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('seeded customer signs in and reaches the dashboard', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: /مرحبًا|Welcome/i })).toBeVisible();
  });
});

test.describe('Password recovery', () => {
  test('forgot → reset → login with the new password', async ({ page }) => {
    const newPassword = 'NewPassw0rd!2026';

    // Fresh registrations require email verification before login, so recovery is
    // exercised on a seeded (already-verified) account. The original password is
    // restored at the end to keep the shared dev/test fixture stable.
    await page.goto('/forgot-password');
    await page.locator('form input[type="email"]').fill(DEMO_USERS.company);
    await page.locator('form button[type="submit"]').click();
    const tokenEl = page.locator('code[dir="ltr"]');
    await expect(tokenEl).toBeVisible();
    const token = (await tokenEl.innerText()).trim();

    try {
      await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
      await page.locator('form input[type="password"]').fill(newPassword);
      await submitAndAwaitReset(page);

      await loginViaUi(page, DEMO_USERS.company, newPassword);
      await expect(page).toHaveURL(/\/dashboard/);
      await page.getByRole('button', { name: /تسجيل الخروج|Sign out/i }).click();
    } finally {
      // Restore on every exit path through the real API — including a UI timeout,
      // which can cancel the test's own request context mid-flight. A dedicated
      // context with a short timeout is independent of the page, so a failure here
      // can never leave the shared demo account on the temporary password and
      // break every later spec that signs in as it.
      const restore = await request.newContext({ baseURL: E2E_API_URL, timeout: 15_000 });
      try {
        await resetPasswordViaApi(restore, DEMO_USERS.company, DEMO_PASSWORD);
      } finally {
        await restore.dispose();
      }
    }
  });
});

/** Submits the reset form and waits for the real API call to complete. */
async function submitAndAwaitReset(page: Page): Promise<void> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/reset-password') && r.request().method() === 'POST'),
    page.locator('form button[type="submit"]').click(),
  ]);
  expect(res.ok()).toBe(true);
}

test.describe('Internationalization', () => {
  test('language selector switches the document direction (RTL ↔ LTR)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('select[aria-label="Language"]').first().selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});

test.describe('Session guards', () => {
  test.use({ storageState: storageFor('customer') });

  test('session persists across reloads for an authenticated role', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    const res = await page.request.get('/api/auth/me');
    expect(res.status()).toBe(200);
  });
});