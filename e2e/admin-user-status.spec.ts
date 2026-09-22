import { test, expect, storageFor } from './helpers';

/**
 * Admin user suspension — driven from the browser.
 *
 * The backend route `PATCH /api/admin/users/:id/status` (audited) and the
 * `api.adminSetUserStatus` client both existed, but the Users page rendered the
 * active flag as read-only text, so an admin had no way to suspend or reactivate
 * an account. These tests exercise the button in the real page and prove the
 * effect server-side, then confirm the enforcement actually holds (a suspended
 * user can no longer authenticate).
 *
 * A dedicated throwaway account is registered per run so the shared demo users
 * are never altered.
 */

function uniqueEmail(): string {
  return `e2e-suspend-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
}

test.describe('Admin user suspend / reactivate', () => {
  test.use({ storageState: storageFor('admin') });

  test('an admin suspends and reactivates a user from the Users page', async ({ page }) => {
    const email = uniqueEmail();
    const registered = await page.request.post('/api/auth/register', {
      data: { email, password: 'Passw0rd!2026', role: 'CUSTOMER', locale: 'en' },
    });
    expect(registered.status()).toBe(201);
    const userId = ((await registered.json()).data as { userId: string }).userId;

    await page.goto('/admin/users');
    const row = page.getByTestId(`admin-user-status-${userId}`);
    await expect(row).toBeVisible();
    // A freshly registered account starts active.
    await expect(page.getByTestId(`admin-user-toggle-${userId}`)).toContainText(/Suspend account|إيقاف الحساب/i);

    // Suspend from the UI.
    await page.getByTestId(`admin-user-toggle-${userId}`).click();
    await expect(page.getByTestId('admin-users-notice')).toBeVisible();
    await expect(page.getByTestId(`admin-user-toggle-${userId}`)).toContainText(/Reactivate|إعادة التنشيط/i);

    // Confirm server-side: the list endpoint now reports the account inactive.
    const listed = (await (await page.request.get('/api/admin/users')).json()).data.items as Array<{ id: string; isActive: boolean }>;
    expect(listed.find((u) => u.id === userId)?.isActive).toBe(false);

    // Enforcement is real: the suspended account can no longer log in.
    // `allowUnverifiedEmail` isolates the active-flag gate from the separate
    // email-verification gate on this freshly registered account.
    const denied = await page.request.post('/api/auth/login', {
      data: { email, password: 'Passw0rd!2026', allowUnverifiedEmail: true },
    });
    expect(denied.status()).toBe(403);

    // Reactivate from the UI and prove login works again.
    await page.getByTestId(`admin-user-toggle-${userId}`).click();
    await expect(page.getByTestId(`admin-user-toggle-${userId}`)).toContainText(/Suspend account|إيقاف الحساب/i);

    const listedAfter = (await (await page.request.get('/api/admin/users')).json()).data.items as Array<{ id: string; isActive: boolean }>;
    expect(listedAfter.find((u) => u.id === userId)?.isActive).toBe(true);

    const allowed = await page.request.post('/api/auth/login', {
      data: { email, password: 'Passw0rd!2026', allowUnverifiedEmail: true },
    });
    expect(allowed.status()).toBe(200);
  });

  test('the status change is written to the audit log', async ({ page }) => {
    const email = uniqueEmail();
    const registered = await page.request.post('/api/auth/register', {
      data: { email, password: 'Passw0rd!2026', role: 'CUSTOMER', locale: 'en' },
    });
    const userId = ((await registered.json()).data as { userId: string }).userId;

    await page.goto('/admin/users');
    await page.getByTestId(`admin-user-toggle-${userId}`).click();
    await expect(page.getByTestId(`admin-user-toggle-${userId}`)).toContainText(/Reactivate|إعادة التنشيط/i);

    // The backend must have recorded ADMIN.USER_STATUS for this exact entity.
    const audit = (await (await page.request.get('/api/admin/audit-logs')).json()).data;
    const items = (audit.items ?? audit) as Array<{ action: string; entityId: string }>;
    expect(items.some((a) => a.action === 'ADMIN.USER_STATUS' && a.entityId === userId)).toBe(true);
  });

  test('a non-admin cannot change a user status', async ({ browser }) => {
    const customerContext = await browser.newContext({ storageState: storageFor('customer') });
    const res = await customerContext.request.patch('/api/admin/users/some-id/status', { data: { isActive: false } });
    expect(res.status()).toBe(403);
    await customerContext.close();
  });
});
