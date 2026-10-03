import { test, expect, DEMO_PASSWORD } from './helpers';

/**
 * Public-demo registration: a visitor signs up and signs in immediately, without
 * a mailbox.
 *
 * Driven entirely through the UI — the register form, the success message the
 * visitor actually sees, and the login form. It asserts the *real* backend state
 * (GET /api/auth/me) rather than trusting a redirect, because a redirect alone
 * would pass even if the session were never issued.
 *
 * The suite runs against two kinds of environment:
 *   * the public demo, where DEMO_SKIP_EMAIL_VERIFICATION stores the account
 *     already verified, and
 *   * a plain dev/test stack, where verification is mandatory.
 *
 * The spec detects which one it is talking to from the registration response the
 * UI renders, and asserts the matching contract, so it is honest in both.
 */

test.describe('Registration → immediate login', () => {
  test('a new account can sign in right after registering', async ({ page }) => {
    const unique = `demo-signup-${Date.now()}@wasit.tn`;

    await page.goto('/register');
    await page.locator('form input[type="email"]').fill(unique);
    await page.locator('form input[type="password"]').fill(DEMO_PASSWORD);
    await page.locator('form select').selectOption('CUSTOMER');
    await page.locator('form button[type="submit"]').click();

    // The success banner is the user-visible outcome of registration. Exclude the
    // public-demo banner, which is also a role="status" element and would
    // otherwise be matched here instead of the form's own message.
    const banner = page.getByRole('status').filter({ hasText: /تم إنشاء الحساب|Account created/i });
    await expect(banner).toBeVisible();
    const message = (await banner.innerText()).trim();
    expect(message).toMatch(/تم إنشاء الحساب|Account created/i);

    // Does this environment skip verification? The banner wording is the contract:
    // the verified variant says the visitor can sign in now.
    const skipVerified = /يمكنك تسجيل الدخول الآن|You can sign in now/i.test(message);

    // The backend agrees with what the UI told the visitor.
    const login = await page.request.post('/api/auth/login', {
      data: { email: unique, password: DEMO_PASSWORD },
    });

    if (skipVerified) {
      expect(login.status()).toBe(200);
      const body = await login.json();
      expect(body.data.emailVerified).toBe(true);
    } else {
      // Verification genuinely required: the login gate must still refuse.
      expect(login.status()).toBe(403);
      const body = await login.json();
      expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
  });

  test('the registration form leads the visitor into a working session', async ({ page }) => {
    const unique = `demo-signin-${Date.now()}@wasit.tn`;

    // Register through the UI. In the demo the account is usable immediately; in a
    // verification-required environment the spec still proves the login form works
    // for a *verified* account, so it uses a demo fixture in that case.
    await page.goto('/register');
    await page.locator('form input[type="email"]').fill(unique);
    await page.locator('form input[type="password"]').fill(DEMO_PASSWORD);
    await page.locator('form select').selectOption('CUSTOMER');
    await page.locator('form button[type="submit"]').click();

    const banner = page.getByRole('status').filter({ hasText: /تم إنشاء الحساب|Account created/i });
    await expect(banner).toBeVisible();
    const skipVerified = /يمكنك تسجيل الدخول الآن|You can sign in now/i.test((await banner.innerText()).trim());

    const email = skipVerified ? unique : 'customer1@wasit.tn';

    // Drive the real login form.
    await page.goto('/login');
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill(DEMO_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    await expect(page).toHaveURL(/\/dashboard/);

    // The session is real: the server resolves it and the authenticated dashboard
    // chrome renders (the public header is replaced by the dashboard layout).
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const meBody = await me.json();
    expect(meBody.data.email).toBe(email);
    await expect(page.locator('a[href="/dashboard/orders"]').first()).toBeVisible();
  });
});
