import { test, expect, storageFor, DEMO_USERS } from './helpers';

/**
 * Permission + protected-surface coverage driven from the browser. Role sessions
 * come from real API logins (global-setup); the assertions prove the real RBAC
 * refuses non-privileged roles, and that the frontend guards match the backend.
 */

test.describe('Customer RBAC', () => {
  test.use({ storageState: storageFor('customer') });

  test('customer sees the customer dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /مرحبًا|Welcome/i })).toBeVisible();
  });

  test('customer is forbidden from /admin by the frontend guard', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
  });

  test('customer cannot reach seller-only inventory', async ({ page }) => {
    const res = await page.request.get('/api/inventory');
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('Unauthenticated access', () => {
  test('requests to protected APIs are rejected with 401', async ({ page }) => {
    const res = await page.request.get('/api/orders');
    expect(res.status()).toBe(401);
  });
});

test.describe('Supplier dashboard', () => {
  test.use({ storageState: storageFor('supplier') });

  test('supplier lands on a seller dashboard with product management', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: /مخزون|Inventory/i }).first()).toBeVisible();
  });
});

test.describe('Merchant inventory', () => {
  test.use({ storageState: storageFor('merchant') });

  test('merchant sees real stock rows for its catalog', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    await expect(page.getByRole('heading', { name: /المخزون|Inventory/i }).first()).toBeVisible();
    await expect(page.locator('table.table-base tbody tr').first()).toBeVisible();
  });

  test('merchant can add stock and the movement is reflected server-side', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    const row = page.locator('table.table-base tbody tr').first();
    await expect(row).toBeVisible();
    const before = Number(await row.locator('td').nth(3).innerText());

    await row.getByRole('button', { name: /إضافة مخزون|Add stock/i }).click();
    await page.getByRole('dialog').locator('input[type="number"]').first().fill('2');
    await page.getByRole('dialog').getByRole('button', { name: /حفظ|Save/i }).click();
    await expect(page.getByText(/تمت إضافة الكمية|تم تحديث المخزون|Inventory updated|quantity added/i).first()).toBeVisible();

    const after = Number(await page.locator('table.table-base tbody tr').first().locator('td').nth(3).innerText());
    expect(after).toBe(before + 2);
  });
});

test.describe('Admin RBAC', () => {
  test.use({ storageState: storageFor('admin') });

  test('admin sees the KPIs dashboard fed by the live admin API', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /مؤشرات الأداء|KPIs/i }).first()).toBeVisible();
  });

  test('admin can read users, orders, ledger and audit logs', async ({ page }) => {
    for (const [path, heading] of [
      ['/admin/users', /المستخدمون|Users/i],
      ['/admin/orders', /الطلبات|Orders/i],
      ['/admin/ledger', /دفتر الحسابات|Ledger/i],
      ['/admin/audit', /سجل التدقيق|Audit/i],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    }
  });

  test('admin ledger shows the commission entry written by the order engine', async ({ page }) => {
    await page.goto('/admin/ledger');
    await expect(page.locator('table.table-base tbody tr').first()).toBeVisible();
    await expect(page.getByText(/عمولة|Commission/i).first()).toBeVisible();
  });

  test('admin audit log records the order creation action', async ({ page }) => {
    await page.goto('/admin/audit');
    await expect(page.locator('table.table-base tbody tr').first()).toBeVisible();
    await expect(page.getByText(/ORDER\.CREATE/).first()).toBeVisible();
  });

  test('admin demo account is the documented SUPER_ADMIN', async ({ page }) => {
    const res = await page.request.get('/api/auth/me');
    const body = await res.json();
    expect(body.data.email).toBe(DEMO_USERS.admin);
    expect(body.data.roles).toContain('SUPER_ADMIN');
  });
});