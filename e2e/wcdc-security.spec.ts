import { test, expect, storageFor, DEMO_USERS } from './helpers';

/**
 * WCDC-01/02 — the GM Security Center, driven through the real UI.
 *
 * No route interception and no fixtures: the browser talks to the real API,
 * which reads the real PostgreSQL rows. The delegation scenario is the whole
 * point of WCDC-02 — the GM issues a scoped grant from the screen, the delegated
 * ADMIN reads with its own session, and revoking the grant from the GM screen
 * closes the door on that same session without a logout or a new login.
 *
 * State: the grant is created and revoked inside the test, so the demo database
 * is left as it was found. If the run dies midway, the grant is identifiable by
 * its reason string and expires within one day.
 */

const DELEGATION_REASON = 'E2E WCDC-02 shift cover';
const ADMIN2_EMAIL = DEMO_USERS.admin2;

test.describe('WCDC — GM security centre', () => {
  test.use({ storageState: storageFor('admin') });

  test('the GM sees live counts, not placeholders', async ({ page }) => {
    await page.goto('/admin/security');

    await expect(page.getByRole('heading', { name: /مركز الأمن السيبراني|Security Centre|centre de sécurité/i })).toBeVisible();

    // Real numbers come from GET /api/admin/security/overview.
    const overview = await page.request.get('/api/admin/security/overview');
    expect(overview.status()).toBe(200);
    const body = (await overview.json()) as { data: { counts: { events24h: number; openIncidents: number } } };
    expect(typeof body.data.counts.events24h).toBe('number');

    await expect(page.getByText(/أحداث 24 ساعة|Events \(24h\)|Événements \(24 h\)/i)).toBeVisible();

    // The delegation card belongs to the GM.
    await expect(page.getByTestId('wcdc-delegations')).toBeVisible();
  });

  test('the tabs open real lists', async ({ page }) => {
    await page.goto('/admin/security');

    for (const [tab, api] of [
      [/^الحوادث$|^Incidents$|^Incidents$/i, '/api/admin/security/incidents'],
      [/^الأحداث$|^Events$|^Événements$/i, '/api/admin/security/events'],
      [/^الإجراءات$|^Actions$|^Actions$/i, '/api/admin/security/actions'],
    ] as const) {
      await page.getByRole('tab', { name: tab }).click();
      const response = await page.request.get(api);
      expect(response.status(), api).toBe(200);
    }
  });

  test('a grant issued on the screen opens the centre for that ADMIN, and revoking it closes it', async ({ page, browser }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('wcdc-delegations')).toBeVisible();

    await page.getByTestId('wcdc-delegation-email').fill(ADMIN2_EMAIL);
    await page.getByTestId('wcdc-delegation-days').fill('1');
    // overview is preselected; add incidents so the delegated admin can read a list.
    await page.getByTestId('wcdc-delegation-scope-incidents').check({ force: true });
    await page.getByTestId('wcdc-delegation-reason').fill(DELEGATION_REASON);
    await page.getByTestId('wcdc-delegation-create').click();

    await expect(page.getByTestId('wcdc-delegation-row').filter({ hasText: ADMIN2_EMAIL })).toBeVisible();

    // The delegated ADMIN reads with its own stored session, in a fresh context.
    const delegated = await browser.newContext({ storageState: storageFor('admin2') });
    const delegatedPage = await delegated.newPage();
    try {
      await delegatedPage.goto('/admin/security');
      await expect(delegatedPage.getByText(/تفويضك|Your delegation|Votre délégation/i)).toBeVisible();
      await expect(delegatedPage.getByText(/النظرة العامة|Overview|Vue d’ensemble/i).first()).toBeVisible();

      // It can read, and it cannot contain: the response action API refuses.
      const overview = await delegatedPage.request.get('/api/admin/security/overview');
      expect(overview.status()).toBe(200);
      const respond = await delegatedPage.request.post('/api/admin/security/incidents/x/respond', {
        data: { action: 'BLOCK_IP', target: '203.0.113.9', reason: 'e2e must stay read-only' },
      });
      expect(respond.status()).toBe(403);
    } finally {
      // Revoke from the GM screen — no logout, no re-login.
      const row = page.getByTestId('wcdc-delegation-row').filter({ hasText: ADMIN2_EMAIL });
      await row.locator('[data-testid^="wcdc-delegation-revoke-"]').click();
      await expect(page.getByTestId('wcdc-delegation-row').filter({ hasText: ADMIN2_EMAIL })).toHaveCount(0);

      // The same delegated session is now refused.
      await delegatedPage.goto('/admin/security');
      await expect(delegatedPage.getByTestId('wcdc-no-access')).toBeVisible();
      const after = await delegatedPage.request.get('/api/admin/security/overview');
      expect(after.status()).toBe(403);

      await delegated.close();
    }
  });
});

test.describe('WCDC — an ADMIN with no delegation', () => {
  test.use({ storageState: storageFor('admin2') });

  test('is told the centre is not delegated instead of being shown an error', async ({ page }) => {
    await page.goto('/admin/security');

    await expect(page.getByTestId('wcdc-no-access')).toBeVisible();
    expect((await page.request.get('/api/admin/security/overview')).status()).toBe(403);
    await expect(page.getByTestId('wcdc-delegations')).toHaveCount(0);
  });
});
