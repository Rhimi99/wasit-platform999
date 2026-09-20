import { test, expect, DEMO_PASSWORD } from './helpers';
import type { Page } from '@playwright/test';

/**
 * MFA E2E — drives the real UI against the real backend.
 *
 * Flow: register a dedicated account → verify email → login → enable 2FA on the
 * Security page → confirm with a TOTP obtained through the dev-only
 * `/api/auth/mfa/dev-totp` endpoint → sign out → the next login must demand a
 * second factor → complete the challenge → regenerate recovery codes → disable.
 *
 * The dev-totp endpoint returns a code computed by the same RFC 6238
 * implementation the server verifies with, so no secret handling is mocked.
 */

const PASSWORD = 'MfaE2e!Passw0rd2026';
void DEMO_PASSWORD;

/** Registers a fresh account, verifies it via the real token path, and signs in. */
async function registerAndLogin(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('status')).toBeVisible();

  // Fetch the verification token through the real dev helper, then consume it
  // through the same endpoint the email link would hit (POST /verify-email).
  const linkRes = await page.request.post('/api/auth/dev/verification-link', { data: { email } });
  expect(linkRes.ok()).toBeTruthy();
  const { data } = (await linkRes.json()) as { data: { token: string } };
  const verifyRes = await page.request.post('/api/auth/verify-email', { data: { token: data.token } });
  expect(verifyRes.ok()).toBeTruthy();

  await signIn(page, email, PASSWORD);
}

/** Drives the real login form and waits for the dashboard. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
}

/** Signs out through the sidebar and lands on the public home page. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /تسجيل الخروج|Sign out/i }).click();
  await expect(page).toHaveURL(/\/$|\/login/);
}

/** Asks the backend for the current TOTP for a secret (dev-only endpoint). */
async function currentTotp(page: Page, secretBase32: string): Promise<string> {
  const res = await page.request.post('/api/auth/mfa/dev-totp', { data: { secretBase32 } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { data: { code: string } };
  return body.data.code;
}

test.describe('MFA UI end-to-end', () => {
  test('enroll → confirm → login challenge → verify → regenerate → disable', async ({ page }) => {
    const email = `mfa.e2e.${Date.now()}@wasit.tn`;
    await registerAndLogin(page, email);
    await expect(page).toHaveURL(/\/dashboard/);

    // --- Enable MFA from the Security page ---
    await page.goto('/dashboard/security');
    await expect(page.getByTestId('mfa-status')).toHaveText(/غير مفعّلة|Disabled/i);
    await page.getByTestId('mfa-enable').click();

    const secret = (await page.getByTestId('mfa-secret').innerText()).trim();
    expect(secret.length).toBeGreaterThan(10);
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();

    await page.getByTestId('mfa-code').fill(await currentTotp(page, secret));
    await page.getByTestId('mfa-confirm').click();
    await expect(page.getByTestId('mfa-status')).toHaveText(/مفعّلة|Enabled/i);

    // The dev-totp helper requires a session, so grab the code while still
    // signed in. TOTP verification tolerates ±1 time step, so a code minted
    // moments earlier remains valid across the sign-out/sign-in round trip.
    const challengeCode = await currentTotp(page, secret);

    // --- Sign out; the next login must demand the second factor ---
    await signOut(page);
    await signIn(page, email, PASSWORD);

    // The password step alone must NOT reach the dashboard.
    await expect(page.getByText(/رمز تطبيق المصادقة|authenticator code/i)).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard/);

    await page.locator('form input[autocomplete="one-time-code"]').fill(challengeCode);
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/dashboard/);

    // --- Regenerate recovery codes (requires a fresh TOTP) ---
    await page.goto('/dashboard/security');
    await expect(page.getByTestId('mfa-status')).toHaveText(/مفعّلة|Enabled/i);
    await page.getByTestId('mfa-code').fill(await currentTotp(page, secret));
    await page.getByTestId('mfa-regenerate').click();
    await expect(page.getByTestId('mfa-regenerated-codes')).toBeVisible();

    // --- Disable MFA (requires a fresh TOTP) ---
    await page.getByTestId('mfa-code').fill(await currentTotp(page, secret));
    await page.getByTestId('mfa-disable').click();
    await expect(page.getByTestId('mfa-status')).toHaveText(/غير مفعّلة|Disabled/i);

    // --- A subsequent login now returns to the password-only path ---
    await signOut(page);
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a wrong TOTP is rejected and no session is granted', async ({ page }) => {
    const email = `mfa.e2e.bad.${Date.now()}@wasit.tn`;
    await registerAndLogin(page, email);
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/dashboard/security');
    await page.getByTestId('mfa-enable').click();
    const secret = (await page.getByTestId('mfa-secret').innerText()).trim();
    await page.getByTestId('mfa-code').fill(await currentTotp(page, secret));
    await page.getByTestId('mfa-confirm').click();
    await expect(page.getByTestId('mfa-status')).toHaveText(/مفعّلة|Enabled/i);

    await signOut(page);
    await signIn(page, email, PASSWORD);
    await expect(page.getByText(/رمز تطبيق المصادقة|authenticator code/i)).toBeVisible();

    await page.locator('form input[autocomplete="one-time-code"]').fill('000000');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard/);

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(401);
  });
});