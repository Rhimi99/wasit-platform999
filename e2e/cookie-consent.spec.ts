import { test, expect, storageFor, loginViaUi, DEMO_USERS, type Page } from './helpers';

/**
 * LC-02 — cookie/GDPR consent from the UI, against the real backend.
 *
 * The platform exposes no anonymous consent endpoint (`PUT /api/privacy/consents`
 * sits behind `requireAuth`), so the notice is scoped to a signed-in account. The
 * specs below drive the real banner and the Settings card, and verify every
 * decision through `GET /api/privacy/me` rather than through the rendered text
 * alone.
 *
 * The first-visit specs deliberately do NOT reuse a stored session: global-setup
 * records the "already answered" marker in each stored state, so only a session
 * established in a fresh context (here, through the real login form) can prove
 * the notice appears at all.
 */

/** Reads the caller's consent map straight from the API. */
async function consentMap(page: Page): Promise<Record<string, boolean>> {
  const res = await page.request.get('/api/privacy/me');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const consents = body.data.consents as Array<{ type: string; granted: boolean }>;
  return Object.fromEntries(consents.map((c) => [c.type, c.granted]));
}

test.describe('Cookie consent — first visit (signed in)', () => {
  test.use({ suppressCookieConsent: false });

  test('the notice appears once signed in and is absent for anonymous visitors', async ({ page }) => {
    // Anonymous: no session, and the server has nowhere to record a decision.
    await page.goto('/');
    await expect(page.getByTestId('cookie-consent')).toHaveCount(0);

    // Signed in through the real form: the notice appears.
    await loginViaUi(page, DEMO_USERS.customer);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('cookie-consent')).toBeVisible();
  });

  test('accept all records every optional consent and hides the notice for good', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer);
    const banner = page.getByTestId('cookie-consent');
    await expect(banner).toBeVisible();

    await page.getByTestId('cookie-accept-all').click();
    await expect(banner).toHaveCount(0);

    const consents = await consentMap(page);
    // Every optional type must now be on. The baseline types (TERMS,
    // PRIVACY_POLICY, DATA_PROCESSING) are terms of use, not cookie choices, so
    // this UI never writes them — only the optional decision is persisted.
    expect(consents.MARKETING).toBe(true);
    expect(consents.ANALYTICS).toBe(true);
    expect(consents.THIRD_PARTY_SHARING).toBe(true);

    // A reload must not bring it back — the decision was recorded, not just hidden.
    await page.reload();
    await expect(page.getByTestId('cookie-consent')).toHaveCount(0);
  });

  test('reject non-essential records the refusal and hides the notice', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer);
    await expect(page.getByTestId('cookie-consent')).toBeVisible();

    await page.getByTestId('cookie-reject').click();
    await expect(page.getByTestId('cookie-consent')).toHaveCount(0);

    const consents = await consentMap(page);
    expect(consents.MARKETING).toBe(false);
    expect(consents.ANALYTICS).toBe(false);
    expect(consents.THIRD_PARTY_SHARING).toBe(false);
  });

  test('manage preferences saves a granular selection the API agrees with', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer);
    await page.getByTestId('cookie-manage').click();

    // Turn on analytics only, leaving marketing off, then save.
    await page.getByTestId('cookie-type-ANALYTICS').check();
    await page.getByTestId('cookie-type-MARKETING').uncheck();
    await page.getByTestId('cookie-save').click();

    // A successful save closes the notice; the decision is what matters.
    await expect(page.getByTestId('cookie-consent')).toHaveCount(0);
    const consents = await consentMap(page);
    expect(consents.ANALYTICS).toBe(true);
    expect(consents.MARKETING).toBe(false);
  });
});

test.describe('Cookie consent — Settings card', () => {
  // A returning session: the notice is suppressed, so the card is the only
  // consent surface on screen.
  test.use({ storageState: storageFor('customer') });

  test('reflects the stored decision and updates it from Settings', async ({ page }) => {
    await page.goto('/dashboard/settings');
    const card = page.getByTestId('cookie-settings');
    await expect(card).toBeVisible();

    // Drive a real change and verify it landed server-side.
    const analytics = card.getByTestId('cookie-type-ANALYTICS');
    const wasOn = await analytics.isChecked();
    if (wasOn) {
      await analytics.uncheck();
    } else {
      await analytics.check();
    }
    await card.getByTestId('cookie-save').click();
    await expect(card.getByTestId('cookie-notice')).toBeVisible();

    const consents = await consentMap(page);
    expect(consents.ANALYTICS).toBe(!wasOn);
  });
});
