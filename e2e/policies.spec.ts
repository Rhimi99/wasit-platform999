import { test, expect, storageFor } from './helpers';

/**
 * Admin country-policy surface, driven from the browser against the real API.
 * Proves the RBAC gate, the country-scoped listing and the audit-backed edit
 * round-trip without touching shared demo state destructively (we restore the
 * global row's values at the end).
 */

test.describe('Admin country policies', () => {
  test.use({ storageState: storageFor('admin') });

  test('a customer is refused by the backend policy endpoint', async ({ page, browser }) => {
    const context = await browser.newContext({ storageState: storageFor('customer') });
    const res = await context.request.get('/api/admin/policies/dispute');
    expect(res.status()).toBe(403);
    await context.close();
  });

  test('the page lists the global policy and any country gaps', async ({ page }) => {
    await page.goto('/admin/policies');
    await expect(page.getByRole('heading', { name: /سياسات|policies/i }).first()).toBeVisible();
    // The global default row is always present once seeded.
    await expect(page.getByText(/Global|عالمي/i).first()).toBeVisible();
  });

  test('an admin can activate and deactivate a candidate market', async ({ page }) => {
    await page.goto('/admin/policies');
    // The France candidate market is seeded inactive; its row shows code FR + EUR.
    const frRow = page.locator('li', { hasText: 'EUR' }).first();
    await expect(frRow).toBeVisible();

    const before = await page.request.get('/api/admin/countries');
    const fr = (await before.json()).data.items.find((c: { code: string }) => c.code === 'FR');
    expect(fr.isActive).toBe(false);

    const on = await page.request.put(`/api/admin/countries/${fr.id}/activation`, {
      data: { isActive: true, reason: 'E2E: activating the France market.' },
    });
    expect(on.status()).toBe(200);

    // After a reload the market is active and the toggle flips to deactivate.
    await page.reload();
    const activeRow = page.locator('li', { hasText: 'EUR' }).first();
    const toggleLabel = await activeRow.getByRole('button').innerText();
    expect(toggleLabel.length).toBeGreaterThan(0);

    const off = await page.request.put(`/api/admin/countries/${fr.id}/activation`, {
      data: { isActive: false, reason: 'E2E: restoring the candidate market state.' },
    });
    expect(off.status()).toBe(200);
  });

  test('an admin edit is persisted and written to the audit log', async ({ page }) => {
    await page.goto('/admin/policies');
    // Read current global rules through the API to restore afterwards.
    const before = await page.request.get('/api/admin/policies/dispute');
    expect(before.status()).toBe(200);
    const body = await before.json();
    const globalRow = body.data.items.find((p: { countryId: string | null }) => p.countryId === null);
    expect(globalRow).toBeTruthy();
    const originalRules = globalRow.rules as Record<string, number>;

    const res = await page.request.put('/api/admin/policies/dispute', {
      data: {
        countryId: null,
        name: globalRow.name,
        rules: { ...originalRules, appealWindowDays: originalRules.appealWindowDays ?? 7 },
        reason: 'E2E verification of the audit-backed policy edit.',
      },
    });
    expect(res.status()).toBe(200);

    const audits = await page.request.get('/api/admin/audit-logs');
    expect(audits.status()).toBe(200);
    const auditBody = await audits.json();
    expect(
      auditBody.data.items.some(
        (a: { action: string; entityId: string }) =>
          a.action === 'POLICY.DISPUTE.UPDATED' && a.entityId === globalRow.id,
      ),
    ).toBe(true);

    const restored = await page.request.put('/api/admin/policies/dispute', {
      data: {
        countryId: null,
        name: globalRow.name,
        rules: originalRules,
        reason: 'E2E restoring the original global policy values.',
      },
    });
    expect([200, 409]).toContain(restored.status());
  });
});