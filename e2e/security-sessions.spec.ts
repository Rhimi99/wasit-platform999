import { test, expect, storageFor, DEMO_PASSWORD, DEMO_USERS } from './helpers';

/**
 * Session management on the Security page.
 *
 * `api.revokeSession` and `POST /api/auth/sessions/revoke` existed but nothing
 * in the UI called them: `/dashboard/security` listed sessions with no way to
 * end one, so a user noticing an unfamiliar device had no remediation. These
 * tests drive the button the user actually sees and prove the effect.
 *
 * The revoke test targets a non-current session created via a separate login
 * context, so revoking it cannot invalidate the storage state the rest of the
 * suite relies on.
 */

test.describe('Security page — session revocation', () => {
  test.use({ storageState: storageFor('customer') });

  test('a signed-in user revokes another session from the Security page', async ({ page, browser }) => {
    // Create a second, independent session for the same account.
    const second = await browser.newContext();
    const login = await second.request.post('/api/auth/login', {
      data: { email: DEMO_USERS.customer, password: DEMO_PASSWORD },
    });
    expect(login.status()).toBe(200);

    await page.goto('/dashboard/security');
    await expect(page.locator('[data-testid^="session-revoke-"]').first()).toBeVisible();

    const sessions = (await (await page.request.get('/api/auth/sessions')).json()).data as Array<{ id: string; isCurrent: boolean }>;
    // The list marks exactly one session as the current device.
    expect(sessions.filter((s) => s.isCurrent)).toHaveLength(1);
    const target = sessions.find((s) => !s.isCurrent);
    expect(target).toBeTruthy();

    await page.getByTestId(`session-revoke-${target!.id}`).click();
    await expect(page.getByTestId('security-sessions-notice')).toBeVisible();

    // The revoked session must no longer be accepted by the API.
    expect((await second.request.get('/api/auth/me')).status()).toBe(401);
    // The session driving the UI stays valid.
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);

    await second.close();
  });

  test('a user cannot revoke a session they do not own', async ({ page, browser }) => {
    // Sign in as a different account to obtain one of its session ids.
    const other = await browser.newContext();
    const login = await other.request.post('/api/auth/login', {
      data: { email: DEMO_USERS.supplier, password: DEMO_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const otherSessions = (await (await other.request.get('/api/auth/sessions')).json()).data as Array<{ id: string }>;
    const foreignId = otherSessions[0].id;

    // The customer session must not be able to revoke the supplier's session.
    const res = await page.request.post('/api/auth/sessions/revoke', { data: { sessionId: foreignId } });
    expect(res.status()).toBe(404);

    // The supplier session is untouched.
    expect((await other.request.get('/api/auth/me')).status()).toBe(200);

    await other.close();
  });
});
