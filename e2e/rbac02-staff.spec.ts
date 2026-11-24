import { test, expect, storageFor } from './helpers';

/**
 * RBAC-02 — the staff desk, driven from the real browser against the real API.
 *
 * `admin@wasit.tn` is seeded as SUPER_ADMIN and `admin2@wasit.tn` as ADMIN, so
 * the two halves of the contract are exercised with genuine accounts: the owner
 * can create, re-role and disable a staff member, and the administrator can do
 * neither — the page refuses and the API answers 403.
 *
 * A throwaway staff account is created per run; the shared demo accounts are
 * never modified.
 */

function uniqueEmail(): string {
  return `e2e-staff-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
}

test.describe('RBAC-02 — SUPER_ADMIN runs the staff desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('creates a staff member, re-roles it after a permissions preview, then disables it', async ({ page }) => {
    const email = uniqueEmail();

    await page.goto('/admin/staff');
    await expect(page.getByTestId('staff-new')).toBeVisible();

    // Create — the invite is the default, and the role's permissions are shown
    // before the account exists.
    await page.getByTestId('staff-new').click();
    await page.locator('#staff-email').fill(email);
    await page.locator('#staff-first').fill('E2E');
    await page.locator('#staff-last').fill('Agent');
    await page.locator('#staff-role').selectOption('DISPUTE');
    await expect(page.getByTestId('staff-create-permissions')).toContainText('dispute:');
    await page.getByTestId('staff-create-submit').click();

    await expect(page.getByTestId('staff-notice')).toBeVisible();
    await expect(page.getByTestId('staff-detail')).toContainText(email);

    // Re-role: the preview must list the permissions of the *pending* role
    // before anything is applied.
    await page.getByTestId('staff-role-select').selectOption('RISK');
    const preview = page.getByTestId('staff-role-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('risk:');
    await page.getByTestId('staff-role-apply').click();
    await expect(page.getByTestId('staff-detail')).toContainText('RISK');
    // The permissions block is the effective set of the new role, not the old one.
    await expect(page.getByTestId('staff-permissions')).toContainText('risk:manage');
    await expect(page.getByTestId('staff-permissions')).not.toContainText('dispute:');

    // Disable.
    await page.getByTestId('staff-toggle-status').click();
    await expect(page.getByTestId('staff-notice')).toBeVisible();

    // The server agrees, and the change survives a reload.
    const list = await page.request.get(`/api/admin/staff?q=${encodeURIComponent(email)}`);
    expect(list.status()).toBe(200);
    const body = (await list.json()).data as {
      items: Array<{ email: string; roles: string[]; isActive: boolean }>;
    };
    const member = body.items.find((m) => m.email === email);
    expect(member?.roles).toEqual(['RISK']);
    expect(member?.isActive).toBe(false);

    await page.reload();
    await page.getByTestId('staff-search').fill(email);
    await expect(page.locator('tbody')).toContainText(email);

    // Activity feed records who did what.
    await page.locator('tbody tr').first().click();
    await expect(page.getByTestId('staff-activity')).toContainText('RBAC.STAFF_CREATED');
    await expect(page.getByTestId('staff-activity')).toContainText('RBAC.STAFF_ROLE_CHANGED');
  });

  test('protects SUPER_ADMIN accounts from the desk', async ({ page }) => {
    await page.goto('/admin/staff');
    const list = await page.request.get('/api/admin/staff?role=SUPER_ADMIN&pageSize=100');
    expect(list.status()).toBe(200);
    const items = ((await list.json()).data as { items: Array<{ id: string; email: string }> }).items;
    expect(items.length).toBeGreaterThan(0);

    const target = items[0];
    await page.getByTestId('staff-search').fill(target.email);
    await page.locator('tbody tr').first().click();
    await expect(page.getByTestId('staff-detail')).toContainText(target.email);
    // No role selector, no status toggle for a SUPER_ADMIN row.
    await expect(page.getByTestId('staff-role-select')).toHaveCount(0);
    await expect(page.getByTestId('staff-toggle-status')).toHaveCount(0);

    const attempt = await page.request.patch(`/api/admin/staff/${target.id}/role`, { data: { role: 'ADMIN' } });
    expect(attempt.status()).toBe(403);
    const disable = await page.request.patch(`/api/admin/staff/${target.id}/status`, { data: { isActive: false } });
    expect(disable.status()).toBe(403);
  });
});

test.describe('RBAC-02 — ADMIN is refused', () => {
  test.use({ storageState: storageFor('admin2') });

  test('has no staff desk and gets 403 from the API', async ({ page }) => {
    await page.goto('/admin/staff');
    await expect(page.getByText(/Forbidden: SUPER_ADMIN only/)).toBeVisible();

    const list = await page.request.get('/api/admin/staff');
    expect(list.status()).toBe(403);
    const create = await page.request.post('/api/admin/staff', {
      data: { email: uniqueEmail(), role: 'ADMIN' },
    });
    expect(create.status()).toBe(403);
  });

  test('does not show the staff link in the admin sidebar', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('a[href="/admin/users"]')).toHaveCount(1);
    await expect(page.locator('a[href="/admin/staff"]')).toHaveCount(0);
  });
});

test.describe('RBAC-02 — phone layout', () => {
  test.use({ storageState: storageFor('admin'), viewport: { width: 390, height: 844 } });

  test('renders staff cards without horizontal overflow', async ({ page }) => {
    await page.goto('/admin/staff');
    await expect(page.getByTestId('staff-search')).toBeVisible();
    const cards = page.locator('[data-testid^="staff-card-"]');
    await expect(cards.first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
