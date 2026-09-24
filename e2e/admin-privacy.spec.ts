import { request } from '@playwright/test';
import { Pool } from 'pg';
import { test, expect, storageFor, DEMO_PASSWORD, completeEmailVerification } from './helpers';

/**
 * Admin privacy / data-deletion desk — functional audit driven from the browser.
 * Rendering a page is never treated as success: each test performs the action in
 * the UI, then reads the real backend state back to prove the effect.
 *
 * Every test mints its own deletion request through the real API instead of
 * relying on data left behind by another spec, so the suite is order-independent.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

/**
 * Registers a throwaway customer and files a real deletion request. The backend
 * deactivates the account and resolves the retention window from the Policy
 * Engine, so the returned row reflects genuine server state.
 */
async function createDeletionRequest(reason: string): Promise<{ userId: string; email: string; requestId: string }> {
  const ctx = await request.newContext({ baseURL: API_URL });
  const email = `privdel-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await ctx.post('/api/auth/register', {
    data: { email, password: DEMO_PASSWORD, firstName: 'PrivDel', role: 'CUSTOMER' },
  });
  expect(reg.status()).toBe(201);
  const userId = (await reg.json()).data.userId as string;
  await completeEmailVerification(ctx, email);
  expect((await ctx.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } })).ok()).toBeTruthy();
  const del = await ctx.post('/api/privacy/deletion', { data: { reason } });
  expect(del.ok()).toBeTruthy();
  const requestId = (await del.json()).data.requestId as string;
  await ctx.dispose();
  return { userId, email, requestId };
}

async function deletionRow(page: import('@playwright/test').Page, requestId: string) {
  const body = await (await page.request.get('/api/admin/privacy/deletions')).json();
  return (body.data as Array<{
    requestId: string; stage: string; userEmail: string | null; retentionUntil: string | null;
  }>).find((r) => r.requestId === requestId);
}

/**
 * Moves a request's retention deadline into the past. Time cannot be travelled
 * through the UI, so the fixture is written directly and then the real sweep is
 * driven from the browser; the assertion itself is against genuine server state.
 */
async function expireRetentionWindow(requestId: string): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev',
  });
  try {
    await pool.query(
      'UPDATE data_deletion_requests SET retention_until = $1 WHERE id = $2',
      [new Date(Date.now() - 60_000), requestId],
    );
  } finally {
    await pool.end();
  }
}

test.describe('Admin privacy desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('sidebar opens the desk and renders the real deletion queue', async ({ page }) => {
    const { email, requestId } = await createDeletionRequest('ui-desk');

    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/privacy"]').click();
    await expect(page).toHaveURL(/\/admin\/privacy/);
    await expect(page.getByRole('heading', { name: /الخصوصية وحذف البيانات|Privacy & data deletion/i })).toBeVisible();

    // The row must show the real account email, not the raw id or a literal.
    const row = page.getByTestId(`admin-privacy-row-${requestId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(email);
    await expect(page.getByTestId(`admin-privacy-stage-${requestId}`)).toContainText('DEACTIVATED');

    // The KPI must be driven by the live list, not a hardcoded number.
    const apiRows = (await (await page.request.get('/api/admin/privacy/deletions')).json()).data;
    const deactivated = (apiRows as Array<{ stage: string }>).filter((r) => r.stage === 'DEACTIVATED').length;
    await expect(page.getByTestId('admin-privacy-kpi-DEACTIVATED')).toContainText(String(deactivated));
  });

  test('advancing a request through the desk persists server-side and is audited', async ({ page }) => {
    const { requestId } = await createDeletionRequest('ui-advance');

    await page.goto('/admin/privacy');
    await page.getByTestId(`admin-privacy-advance-RETENTION-${requestId}`).click();
    await expect(page.getByText(/تم تحديث المرحلة|Stage updated/i).first()).toBeVisible();

    // Persisted, not just rendered.
    await expect.poll(async () => (await deletionRow(page, requestId))?.stage).toBe('RETENTION');
    await expect(page.getByTestId(`admin-privacy-stage-${requestId}`)).toContainText('RETENTION');

    const audit = await (await page.request.get('/api/admin/audit-logs')).json();
    const actions = (audit.data.items as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('PRIVACY.DELETION_STAGE');
  });

  test('refresh re-reads deletion requests filed behind the page', async ({ page }) => {
    // Open the desk with an existing queue, then file a NEW request from another
    // actor while the page is live.
    await createDeletionRequest('ui-refresh-seed');
    await page.goto('/admin/privacy');
    const rows = page.locator('[data-testid^="admin-privacy-row-"]');
    await expect.poll(async () => rows.count()).toBeGreaterThan(0);
    const before = await rows.count();

    const { requestId } = await createDeletionRequest('ui-refresh');

    await page.getByTestId('admin-privacy-refresh').click();
    await expect.poll(async () => rows.count()).toBeGreaterThan(before);
    await expect(page.getByTestId(`admin-privacy-row-${requestId}`)).toBeVisible();
  });

  test('the stage filter narrows the queue to that stage only', async ({ page }) => {
    const { requestId } = await createDeletionRequest('ui-filter');
    await page.goto('/admin/privacy');
    await page.getByTestId(`admin-privacy-advance-REVIEW-${requestId}`).click();
    await expect.poll(async () => (await deletionRow(page, requestId))?.stage).toBe('REVIEW');

    await page.getByTestId('admin-privacy-stage').selectOption('REVIEW');

    // Whatever renders must agree with the filtered API response.
    const filtered = (await (await page.request.get('/api/admin/privacy/deletions?stage=REVIEW')).json()).data as Array<{
      requestId: string;
      stage: string;
    }>;
    const rows = page.locator('[data-testid^="admin-privacy-row-"]');
    await expect.poll(async () => rows.count()).toBe(filtered.length);
    expect(filtered.every((r) => r.stage === 'REVIEW')).toBe(true);
    await expect(page.getByTestId(`admin-privacy-row-${requestId}`)).toBeVisible();
  });

  test('rejecting a request reactivates the account server-side', async ({ page }) => {
    const { requestId, userId, email } = await createDeletionRequest('ui-reject');

    await page.goto('/admin/privacy');
    await page.getByTestId(`admin-privacy-advance-REJECTED-${requestId}`).click();
    await expect(page.getByText(/تم تحديث المرحلة|Stage updated/i).first()).toBeVisible();

    await expect.poll(async () => (await deletionRow(page, requestId))?.stage).toBe('REJECTED');

    const list = await (await page.request.get('/api/admin/privacy/deletions')).json();
    const row = (list.data as Array<{ requestId: string; accountActive: boolean | null; userId: string }>)
      .find((r) => r.requestId === requestId);
    expect(row?.userId).toBe(userId);
    expect(row?.accountActive).toBe(true);

    // A real login proves the account is usable again — a flag read would not.
    const ctx = await request.newContext({ baseURL: API_URL });
    const login = await ctx.post('/api/auth/login', {
      data: { email, password: DEMO_PASSWORD, allowUnverifiedEmail: true },
    });
    expect(login.status()).toBe(200);
    await ctx.dispose();
  });

  test('anonymizing scrubs PII through the legal-hold override and keeps the record', async ({ page }) => {
    const { requestId, email } = await createDeletionRequest('ui-anonymize');

    // The retention window resolved from policy is open, so the desk must ask for
    // confirmation before sending the override; accept it to proceed.
    page.on('dialog', (d) => void d.accept());

    await page.goto('/admin/privacy');
    await page.getByTestId(`admin-privacy-advance-ANONYMIZED-${requestId}`).click();
    await expect(page.getByText(/تم تحديث المرحلة|Stage updated/i).first()).toBeVisible();

    await expect.poll(async () => (await deletionRow(page, requestId))?.stage).toBe('ANONYMIZED');
    await expect(page.getByTestId(`admin-privacy-stage-${requestId}`)).toContainText('ANONYMIZED');

    // The PII must actually be gone from the account, and the request row must
    // survive (financial/audit retention) rather than being deleted.
    const row = await deletionRow(page, requestId);
    expect(row).toBeTruthy();
    expect(row?.userEmail).not.toBe(email);

    const audit = await (await page.request.get('/api/admin/audit-logs')).json();
    const actions = (audit.data.items as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('PRIVACY.LEGAL_HOLD_OVERRIDE');
    expect(actions).toContain('PRIVACY.DELETION_ANONYMIZED');
  });

  test('the retention sweep button advances requests whose window has elapsed', async ({ page }) => {
    const { requestId } = await createDeletionRequest('ui-sweep');
    // The request is created DEACTIVATED with a future policy window; make it due.
    await expireRetentionWindow(requestId);

    await page.goto('/admin/privacy');
    await page.getByTestId('admin-privacy-run-sweep').click();
    await expect(page.getByText(/لا توجد طلبات مستحقة|No requests are due|تم تقديم الطلبات|Requests advanced/i).first()).toBeVisible();

    // The due request must move, and the move must be real server state reflected
    // in the table, not just a notice.
    await expect.poll(async () => (await deletionRow(page, requestId))?.stage).toBe('RETENTION');
    await expect(page.getByTestId(`admin-privacy-stage-${requestId}`)).toContainText('RETENTION');
  });

  test('the sweep never anonymizes a request on its own', async ({ page }) => {
    const { requestId } = await createDeletionRequest('ui-sweep-guard');
    await expireRetentionWindow(requestId);

    await page.goto('/admin/privacy');
    // Three runs: DEACTIVATED → RETENTION → ELIGIBLE → (stops).
    for (let i = 0; i < 3; i += 1) {
      await page.getByTestId('admin-privacy-run-sweep').click();
      await expect(page.getByText(/لا توجد طلبات مستحقة|No requests are due|تم تقديم الطلبات|Requests advanced/i).first()).toBeVisible();
      await expect(page.getByTestId('admin-privacy-run-sweep')).toBeEnabled();
    }

    const after = await deletionRow(page, requestId);
    expect(after?.stage).toBe('ELIGIBLE');
    // Automated runs must stop at ELIGIBLE; scrubbing PII stays an operator action.
    expect(after?.stage).not.toBe('ANONYMIZED');
  });
});

test.describe('Admin privacy desk — RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the desk and every admin privacy API', async ({ page }) => {
    await page.goto('/admin/privacy');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/privacy/deletions')).status()).toBe(403);
    expect((await page.request.patch('/api/admin/privacy/deletions/does-not-exist', {
      data: { stage: 'REVIEW' },
    })).status()).toBe(403);
    expect((await page.request.post('/api/admin/privacy/deletions/retention-sweep')).status()).toBe(403);
  });
});
