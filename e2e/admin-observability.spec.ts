import { test, expect, storageFor } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Admin observability desk — functional audit driven from the browser.
 * Rendering a page is never treated as success: each test performs the action
 * in the UI, then reads the real backend state back to prove the effect.
 *
 * `page.request` shares the browser context's authenticated session, so setup
 * and verification exercise the same real backend and RBAC as the UI.
 */

test.describe('Admin observability desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('sidebar opens the desk and every tab renders live backend data', async ({ page }) => {
    // Read the counter baseline BEFORE navigating so the assertion cannot be
    // beaten by this test's own requests incrementing the (monotonic) counter.
    const baseline = (await (await page.request.get('/api/admin/observability/metrics')).json()).data;
    const baselineRequests = (baseline.metrics.counters.wasit_http_requests_total ?? []).reduce(
      (acc: number, s: { value: number }) => acc + s.value,
      0,
    );

    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/observability"]').click();
    await expect(page).toHaveURL(/\/admin\/observability/);
    await expect(page.getByRole('heading', { name: /المراقبة التشغيلية|Observability/i })).toBeVisible();

    // Overview KPIs must reflect the live snapshot, not literals.
    await expect.poll(async () => {
      const text = (await page.getByTestId('admin-obs-kpi-requests').innerText()).replace(/\D/g, '');
      return Number(text);
    }).toBeGreaterThanOrEqual(baselineRequests);
    await expect(page.getByTestId('admin-obs-notifier')).toBeVisible();

    // Metrics tab renders the registry tables.
    await page.getByTestId('admin-obs-tab-metrics').click();
    await expect(page.getByTestId('admin-obs-counters')).toBeVisible();
    await expect(page.getByTestId('admin-obs-gauges')).toBeVisible();
    await expect(page.getByTestId('admin-obs-gauge-wasit_uptime_seconds')).toBeVisible();

    // Logs tab renders real records (the request above wrote several).
    await page.getByTestId('admin-obs-tab-logs').click();
    await expect(page.getByTestId('admin-obs-logs')).toBeVisible();
    await expect(page.locator('[data-testid^="admin-obs-log-"]').first()).toBeVisible();
  });

  test('evaluating alerts from the UI is audited and lands in the history table', async ({ page }) => {
    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-alerts').click();
    await expect(page.getByTestId('admin-obs-evaluate')).toBeVisible();

    await page.getByTestId('admin-obs-evaluate').click();
    await expect(page.getByText(/قواعد قُيّمت|Rules evaluated/i).first()).toBeVisible();

    // The evaluation must be persisted server-side as an audit entry.
    const audit = await (await page.request.get('/api/admin/audit-logs')).json();
    const actions = (audit.data.items as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('OBSERVABILITY.ALERTS_EVALUATED');
  });

  test('log level filter narrows the table to that level only', async ({ page }) => {
    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-logs').click();
    await page.getByTestId('admin-obs-level').selectOption('error');
    await page.getByTestId('admin-obs-apply-filter').click();

    // Whatever renders must agree with the filtered API response.
    const filtered = (await (await page.request.get('/api/admin/observability/logs?level=error&limit=100')).json()).data;
    const rows = page.locator('[data-testid^="admin-obs-log-"]');
    await expect.poll(async () => rows.count()).toBe(filtered.length);
    if (filtered.length > 0) {
      await expect(page.getByTestId('admin-obs-logs')).toContainText('error');
    }
  });

  test('firing alerts are surfaced as badges driven by the live snapshot', async ({ page }) => {
    await page.goto('/admin/observability');
    const snap = (await (await page.request.get('/api/admin/observability/metrics')).json()).data;
    // KPI must be a real number, never a literal placeholder.
    await expect(page.getByTestId('admin-obs-kpi-firing')).toContainText(/\d/);
    for (const a of snap.alerts.firing as Array<{ rule: string }>) {
      await expect(page.getByTestId(`admin-obs-firing-${a.rule}`)).toBeVisible();
    }
  });

  test('backup freshness is reported and a stale heartbeat raises a CRITICAL alert in the UI', async ({ page }) => {
    const heartbeat = path.resolve('.e2e/backup-heartbeat.json');
    fs.mkdirSync(path.dirname(heartbeat), { recursive: true });

    // Healthy schedule: a fresh heartbeat reports age ~0 and nothing fires.
    fs.writeFileSync(heartbeat, JSON.stringify({ at: new Date().toISOString() }));
    const healthy = (await (await page.request.get('/api/health/channels')).json()).backup;
    expect(healthy.configured).toBe(true);
    expect(healthy.ageHours).toBeLessThan(1);

    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-alerts').click();
    await page.getByTestId('admin-obs-evaluate').click();
    await page.getByTestId('admin-obs-tab-overview').click();
    await expect(page.getByTestId('admin-obs-firing-backup_stale')).toHaveCount(0);

    // The schedule stops: age the heartbeat past the 26h threshold on disk, then
    // evaluate through the real scheduler path (the same code the interval runs).
    const aged = new Date(Date.now() - 30 * 3_600_000).toISOString();
    fs.writeFileSync(heartbeat, JSON.stringify({ at: aged }));
    const stale = (await (await page.request.get('/api/health/channels')).json()).backup;
    expect(stale.ageHours).toBeGreaterThan(26);

    await page.getByTestId('admin-obs-tab-alerts').click();
    await page.getByTestId('admin-obs-evaluate').click();
    await page.getByTestId('admin-obs-tab-overview').click();
    await expect(page.getByTestId('admin-obs-firing-backup_stale')).toBeVisible();

    // The firing rule must be persisted, not just rendered from local state.
    const firing = (await (await page.request.get('/api/admin/observability/alerts?status=FIRING')).json()).data;
    expect((firing as Array<{ rule: string; severity: string }>).some(
      (r) => r.rule === 'backup_stale' && r.severity === 'CRITICAL',
    )).toBe(true);

    // Recovery: a fresh heartbeat resolves it on the next evaluation.
    fs.writeFileSync(heartbeat, JSON.stringify({ at: new Date().toISOString() }));
    await page.getByTestId('admin-obs-tab-alerts').click();
    await page.getByTestId('admin-obs-evaluate').click();
    await page.getByTestId('admin-obs-tab-overview').click();
    await expect(page.getByTestId('admin-obs-firing-backup_stale')).toHaveCount(0);
    const after = (await (await page.request.get('/api/admin/observability/alerts?status=FIRING')).json()).data;
    expect((after as Array<{ rule: string }>).some((r) => r.rule === 'backup_stale')).toBe(false);
  });
});

test.describe('Admin observability desk — RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the desk and every admin observability API', async ({ page }) => {
    await page.goto('/admin/observability');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/observability/metrics')).status()).toBe(403);
    expect((await page.request.get('/api/admin/observability/logs')).status()).toBe(403);
    expect((await page.request.get('/api/admin/observability/alerts')).status()).toBe(403);
    expect((await page.request.post('/api/admin/observability/alerts/evaluate')).status()).toBe(403);
  });
});
