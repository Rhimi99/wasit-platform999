import { test, expect, storageFor } from './helpers';

/**
 * PR-10 — notification preferences, end to end in a real browser.
 *
 * Signs in as the demo customer, drives the real settings page, and proves the
 * choice survives a reload because it is stored server-side. The last test puts
 * the shared account back where it started: these specs run against a demo
 * database other suites also use, so a leaked "off" switch would quietly change
 * their environment.
 */

const CATEGORIES = 10;
const CHANNELS = 3;

test.use({ storageState: storageFor('customer') });

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/dashboard/settings');
  await expect(page.getByTestId('notification-preferences')).toBeVisible();
}

test.describe('PR-10 — notification preferences', () => {
  test('lists every category and channel for the signed-in user', async ({ page }) => {
    await openSettings(page);

    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeVisible();
    await expect(page.getByTestId('notif-pref-IN_APP-DISPUTE')).toBeVisible();
    await expect(page.getByTestId('notif-pref-SMS-PAYOUT')).toBeVisible();

    const switches = page.locator('[data-testid^="notif-pref-"] input[type="checkbox"]');
    await expect(switches).toHaveCount(CATEGORIES * CHANNELS);

    // Nothing is saved until the user asks for it.
    await expect(page.getByTestId('notification-preferences-save')).toBeDisabled();
  });

  test('saves a choice that survives a reload, then restores it', async ({ page }) => {
    await openSettings(page);

    const target = page.getByTestId('notif-pref-EMAIL-MESSAGE');
    const wasChecked = await target.isChecked();

    await target.setChecked(!wasChecked);
    await expect(page.getByTestId('notification-preferences-save')).toBeEnabled();
    await page.getByTestId('notification-preferences-save').click();
    await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('notification-preferences')).toBeVisible();
    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeChecked({ checked: !wasChecked });

    // Restore the shared demo account.
    const restore = page.getByTestId('notif-pref-EMAIL-MESSAGE');
    await restore.setChecked(wasChecked);
    await page.getByTestId('notification-preferences-save').click();
    await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeChecked({ checked: wasChecked });
  });

  test('the API refuses an unknown category with the real session', async ({ page }) => {
    await openSettings(page);

    // In-page fetch keeps the session cookie (a Secure cookie is dropped by
    // Playwright's request context over plain HTTP).
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferences: [{ channel: 'EMAIL', category: 'NOPE', enabled: false }] }),
      });
      return res.status;
    });
    expect(status).toBe(422);
  });
});
