import { test, expect, type Page } from '@playwright/test';

/**
 * LC-02 — cookie consent & privacy controls, end to end in a real browser.
 *
 * This spec is database-free by design (run it with `playwright.cookie.config.ts`):
 * the behaviour under test is client-side — the consent decision, its persistence,
 * the marketing gate on the advertising slot, and the privacy-settings link. The
 * few API reads the public pages perform are answered by Playwright route
 * interception, and every `/api/ads/*` request is recorded so a test can prove no
 * tracking happens without consent. No PostgreSQL, no Docker, no demo stack.
 *
 * Each test starts from a guaranteed first-visit state: an init script removes the
 * stored consent before any app script runs.
 */

const CONSENT_KEY = 'wasit.consent';
const AD_SESSION_KEY = 'wasit.adSession';

interface ApiSpy {
  /** Count of GET /api/ads/served calls (the ad feed fetch). */
  adServed: number;
  /** Bodies of POST /api/ads/events calls (impression/click tracking). */
  adEvents: string[];
  /** Other API paths hit (for debugging; must never include ads when gated). */
  other: string[];
}

async function clearConsent(page: Page) {
  // Clear only on the first load of the tab: an init script runs on every
  // navigation, so without the guard a `page.reload()` would wipe the decision
  // again and the "persists across a reload" cases could never pass.
  await page.addInitScript(() => {
    try {
      if (window.sessionStorage.getItem('__consentCleared') === '1') return;
      window.localStorage.removeItem('wasit.consent');
      window.sessionStorage.removeItem('wasit.adSession');
      window.sessionStorage.setItem('__consentCleared', '1');
    } catch {
      /* ignore */
    }
  });
}

/** Answers the SPA's API reads from memory and records ad traffic. */
async function mockApi(page: Page): Promise<ApiSpy> {
  const spy: ApiSpy = { adServed: 0, adEvents: [], other: [] };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === '/api/ads/served') {
      spy.adServed += 1;
      return route.fulfill({
        json: {
          success: true,
          data: {
            items: [
              {
                campaignId: 'camp-1',
                creativeId: 'crea-1',
                title: 'Sponsored',
                body: 'An ad',
                advertiserType: 'MERCHANT',
                objective: 'AWARENESS',
                targetUrl: 'https://example.com',
                mediaUrl: null,
              },
            ],
          },
        },
      });
    }

    if (path === '/api/ads/events') {
      spy.adEvents.push(route.request().postData() ?? '');
      return route.fulfill({
        json: { success: true, data: { id: 'ev-1', eventType: 'IMPRESSION', campaignId: 'camp-1' } },
      });
    }

    if (path === '/api/auth/me') {
      spy.other.push(path);
      return route.fulfill({
        status: 401,
        json: { success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 } },
      });
    }

    spy.other.push(path);
    // An empty array satisfies every list read the public pages perform
    // (categories expect an array; products/suppliers/countries read `.items`).
    return route.fulfill({ json: { success: true, data: [] } });
  });
  return spy;
}

async function storedConsent(page: Page) {
  return page.evaluate((k) => {
    const raw = window.localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as { categories: Record<string, boolean>; version: number }) : null;
  }, CONSENT_KEY);
}

test.describe('LC-02 — consent decisions', () => {
  test('first visit shows a non-blocking banner (never the modal) and stores nothing', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');

    // The first-visit surface is the persistent banner, not the full-screen modal:
    // the modal would sit over the page and swallow clicks on the sign-in button.
    await expect(page.getByTestId('cookie-consent-banner')).toBeVisible();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    expect(await storedConsent(page)).toBeNull();
  });

  test('the first-visit banner does not block the sign-in button (regression)', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/login');

    // No modal is auto-opened on load...
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.getByTestId('cookie-consent-banner')).toBeVisible();

    // ...so the sign-in button is reachable and clickable without dismissing
    // anything first. Before the fix the modal covered it and the click timed out.
    const submit = page.locator('button[type=submit]').first();
    await expect(submit).toBeVisible();
    await submit.click({ timeout: 5000 });
    expect(await storedConsent(page)).toBeNull();
  });

  test('opening the settings keeps a persistent banner path back (fallback)', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByTestId('cookie-consent-banner')).toBeVisible();

    // The banner's "customise" opens the full settings dialog.
    await page.getByTestId('cookie-customize').click();
    await expect(page.getByTestId('cookie-consent-dialog')).toBeVisible();

    // Click the overlay (top-left corner, outside the centred dialog) to dismiss.
    await page.mouse.click(3, 3);
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.getByTestId('cookie-consent-banner')).toBeVisible();
    expect(await storedConsent(page)).toBeNull();
  });

  test('reject non-essential works, persists, and never re-prompts', async ({ page }) => {
    await clearConsent(page);
    const spy = await mockApi(page);
    await page.goto('/');
    await page.getByTestId('cookie-reject-all').click();

    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.getByTestId('cookie-consent-banner')).toHaveCount(0);
    const record = await storedConsent(page);
    expect(record?.categories).toEqual({ necessary: true, preferences: false, analytics: false, marketing: false });
    expect(spy.adServed).toBe(0);

    await page.reload();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.getByTestId('cookie-consent-banner')).toHaveCount(0);
  });

  test('accept all works, persists, and never re-prompts', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');
    await page.getByTestId('cookie-accept-all').click();

    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    const record = await storedConsent(page);
    expect(record?.categories).toEqual({ necessary: true, preferences: true, analytics: true, marketing: true });

    await page.reload();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.getByTestId('cookie-consent-banner')).toHaveCount(0);
  });

  test('a per-category choice is saved exactly (customise)', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');
    await page.getByTestId('cookie-customize').click();
    await expect(page.getByTestId('cookie-consent-dialog')).toBeVisible();

    await expect(page.getByTestId('cookie-toggle-necessary')).toBeDisabled();
    await expect(page.getByTestId('cookie-toggle-necessary')).toBeChecked();
    await page.getByTestId('cookie-toggle-analytics').check();
    await page.getByTestId('cookie-save').click();

    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    const record = await storedConsent(page);
    expect(record?.categories.analytics).toBe(true);
    expect(record?.categories.marketing).toBe(false);
    expect(record?.categories.preferences).toBe(false);
    expect(record?.categories.necessary).toBe(true);
  });

  test('the privacy settings can be reopened from the persistent link', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');
    await page.getByTestId('cookie-accept-all').click();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);

    await page.getByTestId('cookie-settings-link').first().click();
    await expect(page.getByTestId('cookie-consent-dialog')).toBeVisible();
    await expect(page.getByTestId('cookie-toggle-necessary')).toBeDisabled();
  });

  test('Arabic is the default locale and the surface is RTL', async ({ page }) => {
    await clearConsent(page);
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('cookie-consent-banner')).toContainText('ملفات تعريف الارتباط');
  });
});

test.describe('LC-02 — marketing tracking is gated on consent', () => {
  test('no ad slot and no ad traffic before consent; withdrawal clears the id', async ({ page }) => {
    await clearConsent(page);
    const spy = await mockApi(page);
    await page.goto('/marketplace');

    await expect(page.getByTestId('cookie-consent-banner')).toBeVisible();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);
    await expect(page.locator('[data-testid^="ad-slot-"]')).toHaveCount(0);
    expect(spy.adServed).toBe(0);
    expect(spy.adEvents).toEqual([]);
    expect(await page.evaluate((k) => window.sessionStorage.getItem(k), AD_SESSION_KEY)).toBeNull();

    await page.getByTestId('cookie-accept-all').click();
    await expect(page.locator('[data-testid^="ad-slot-"]')).toHaveCount(1);
    expect(spy.adServed).toBeGreaterThanOrEqual(1);

    await page.evaluate((k) => window.sessionStorage.setItem(k, 'web_test'), AD_SESSION_KEY);
    await page.getByTestId('cookie-settings-link').first().click();
    // The dialog seeds its draft in an effect, so wait for it to reflect the
    // stored decision before toggling (otherwise the uncheck can be overwritten).
    const marketingToggle = page.getByTestId('cookie-toggle-marketing');
    await expect(marketingToggle).toBeChecked();
    await marketingToggle.uncheck();
    await expect(marketingToggle).not.toBeChecked();
    await page.getByTestId('cookie-save').click();
    await expect(page.getByTestId('cookie-consent-dialog')).toHaveCount(0);

    // The stored decision now denies marketing, and the ad-session identifier is gone.
    const stored = await storedConsent(page);
    expect(stored?.categories.marketing).toBe(false);
    expect(await page.evaluate((k) => window.sessionStorage.getItem(k), AD_SESSION_KEY)).toBeNull();
  });
});
