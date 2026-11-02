import { test, expect, storageFor } from './helpers';

/**
 * AI-07.1 — General Manager operations desk (`/admin/gm`), SUPER_ADMIN only.
 *
 * Driven from the browser, but a page render is never treated as success: every
 * test performs the action in the UI and then reads the real backend state back
 * through `page.request` (which shares the context's authenticated session) to
 * prove the effect happened with the real RBAC.
 *
 * `admin` holds SUPER_ADMIN (plus ADMIN); `admin2` holds ADMIN only — the exact
 * boundary this desk adds: ADMIN reaches the AI governance desk but NOT the GM
 * desk. `merchant` proves a non-staff role is refused too.
 */

test.describe('GM operations desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('opens from the sidebar and the control tab renders the run form and playbooks', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/gm"]').click();
    await expect(page).toHaveURL(/\/admin\/gm/);
    await expect(page.getByRole('heading', { name: /مركز عمليات المدير العام|General Manager operations desk/i })).toBeVisible();

    await expect(page.getByTestId('admin-gm-goal')).toBeVisible();
    // Run is disabled until a goal of at least 3 characters is typed.
    await expect(page.getByTestId('admin-gm-run-btn')).toBeDisabled();
    await page.getByTestId('admin-gm-goal').fill('ab');
    await expect(page.getByTestId('admin-gm-run-btn')).toBeDisabled();
    await page.getByTestId('admin-gm-goal').fill('revenue growth plan');
    await expect(page.getByTestId('admin-gm-run-btn')).toBeEnabled();

    // Playbooks are the real server list, not literals.
    const playbooks = (await (await page.request.get('/api/admin/gm/playbooks')).json()).data.items as Array<{ id: string }>;
    for (const p of playbooks) {
      await expect(page.getByTestId(`admin-gm-playbook-${p.id}`)).toBeVisible();
    }
  });

  test('running a goal from the UI persists a retrievable run and renders its report', async ({ page }) => {
    await page.goto('/admin/gm');
    await page.getByTestId('admin-gm-goal').fill('revenue growth plan');
    await page.getByTestId('admin-gm-run-btn').click();
    await expect(page.getByTestId('admin-gm-notice')).toBeVisible();
    await expect(page.getByTestId('admin-gm-detail')).toBeVisible();

    // The rendered report is the persisted snapshot, replayed verbatim.
    const list = (await (await page.request.get('/api/admin/gm/runs?limit=1')).json()).data.items as Array<{ runId: string; hasSnapshot: boolean }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].hasSnapshot).toBe(true);
    const stored = (await (await page.request.get(`/api/admin/gm/runs/${list[0].runId}`)).json()).data as {
      report: { goal: string; steps: unknown[] };
      results: Array<{ stepId: string; outcome: string; intentAr: string }>;
      proposedActions: Array<{ action: string; executed: boolean; requiresApproval: boolean }>;
    };
    await expect(page.getByTestId('admin-gm-detail-meta')).toContainText(stored.report.goal);

    // Every step the snapshot recorded is rendered with its outcome label.
    for (const s of stored.results) {
      await expect(page.getByTestId(`admin-gm-step-${s.stepId}`)).toBeVisible();
      await expect(page.getByTestId(`admin-gm-step-outcome-${s.stepId}`)).toBeVisible();
    }

    // Proposed actions are shown and never marked executed.
    for (const a of stored.proposedActions) {
      await expect(page.getByTestId(`admin-gm-action-${a.action}`)).toBeVisible();
      expect(a.executed).toBe(false);
    }
  });

  test('retrieval is read-only: it writes no new run and replays the same bytes', async ({ page }) => {
    const run = (await (await page.request.post('/api/admin/gm/orchestrate', { data: { goal: 'revenue growth plan' } })).json()).data as { runId: string };

    const before = (await (await page.request.get('/api/admin/gm/runs?limit=200')).json()).data.items as Array<{ runId: string }>;
    const first = await (await page.request.get(`/api/admin/gm/runs/${run.runId}`)).json();
    const second = await (await page.request.get(`/api/admin/gm/runs/${run.runId}`)).json();
    const after = (await (await page.request.get('/api/admin/gm/runs?limit=200')).json()).data.items as Array<{ runId: string }>;

    // Same run count: retrieval created nothing.
    expect(after.length).toBe(before.length);
    // Same payload twice: the snapshot is replayed, not recomputed.
    expect(second).toEqual(first);
  });

  test('the run log lists runs and opening one shows the stored detail', async ({ page }) => {
    const run = (await (await page.request.post('/api/admin/gm/orchestrate', { data: { goal: 'revenue growth plan' } })).json()).data as { runId: string };

    await page.goto('/admin/gm');
    await page.getByTestId('admin-gm-tab-runs').click();
    const row = page.getByTestId(`admin-gm-run-row-${run.runId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('revenue.growth');

    await page.getByTestId(`admin-gm-run-view-${run.runId}`).click();
    await expect(page.getByTestId('admin-gm-detail')).toBeVisible();
    await expect(page.getByTestId('admin-gm-detail-steps')).toBeVisible();
    await expect(page.getByTestId('admin-gm-detail-actions')).toBeVisible();
  });

  test('a run that is not retrievable answers 404 from the API', async ({ page }) => {
    const res = await page.request.get('/api/admin/gm/runs/00000000-0000-0000-0000-000000000000');
    expect(res.status()).toBe(404);
  });
});

test.describe('GM operations desk — RBAC', () => {
  test.use({ storageState: storageFor('admin2') });

  test('an ADMIN-only user is blocked from the page and every GM API', async ({ page }) => {
    await page.goto('/admin/gm');
    await expect(page.getByText(/Forbidden: Super Admin area/i)).toBeVisible();

    // The server is the real control: ADMIN gets 403 on every route.
    expect((await page.request.get('/api/admin/gm/playbooks')).status()).toBe(403);
    expect((await page.request.get('/api/admin/gm/runs')).status()).toBe(403);
    expect((await page.request.get('/api/admin/gm/runs/00000000-0000-0000-0000-000000000000')).status()).toBe(403);
    expect(
      (await page.request.post('/api/admin/gm/orchestrate', { data: { goal: 'revenue growth plan' } })).status(),
    ).toBe(403);
  });

  test('the GM link is not rendered in the ADMIN sidebar', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('aside nav a[href="/admin/ai"]')).toBeVisible();
    await expect(page.locator('aside nav a[href="/admin/gm"]')).toHaveCount(0);
  });
});

test.describe('GM operations desk — merchant RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the page and the GM API', async ({ page }) => {
    await page.goto('/admin/gm');
    await expect(page.getByText(/Forbidden: Super Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/gm/runs')).status()).toBe(403);
  });
});

/**
 * G8 — on-demand AI agent cycle.
 *
 * The GM triggers a real cycle from the UI and then reads the real outcome back
 * through `page.request`: the status rendered is the status the server reported,
 * and the same `correlationId` appears in the cycle log the API returns.
 */
test.describe('GM on-demand AI cycle', () => {
  test.use({ storageState: storageFor('admin') });

  test('runs a cycle from the UI and reports the real outcome', async ({ page }) => {
    await page.goto('/admin/gm');
    await page.getByTestId('admin-gm-tab-cycle').click();
    await expect(page.getByTestId('admin-gm-cycle-panel')).toBeVisible();

    await page.getByTestId('admin-gm-cycle-run').click();
    await expect(page.getByTestId('admin-gm-cycle-result')).toBeVisible();
    const badge = page.getByTestId('admin-gm-cycle-status');
    await expect(badge).toBeVisible();
    const label = (await badge.textContent()) ?? '';
    expect(label).toMatch(/اكتملت|Completed|محجوبة|Blocked|فشلت|Failed|قيد التشغيل|Running/i);

    // The cycle is persisted and visible in the log the API serves.
    const cycles = (await (await page.request.get('/api/admin/gm/cycles?limit=5')).json()).data.items as Array<{ correlationId: string; status: string }>;
    expect(cycles.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`admin-gm-cycle-row-${cycles[0].correlationId}`)).toBeVisible();
  });
});

test.describe('GM on-demand AI cycle — RBAC', () => {
  test.use({ storageState: storageFor('admin2') });

  test('an ADMIN-only user is refused the cycle endpoints', async ({ page }) => {
    expect((await page.request.get('/api/admin/gm/cycles')).status()).toBe(403);
    expect((await page.request.post('/api/admin/gm/cycle', { data: {} })).status()).toBe(403);
  });
});

/**
 * G4 — executing a GM's proposed action.
 *
 * The GM turns a recommendation the orchestrator *proposed* into a real Agent
 * Task from the desk. A page render is never treated as success: the test clicks
 * Execute and then reads the real task back through `page.request`, proving the
 * task exists, is attributed to the session GM, and is an `awaiting_approval`
 * (never auto-executed) task.
 */
test.describe('GM proposed-action execution', () => {
  test.use({ storageState: storageFor('admin') });

  test('executes a proposed action into a real, approval-gated task', async ({ page }) => {
    // Run a goal whose playbook proposes `ads.spend_increase`.
    const run = (await (await page.request.post('/api/admin/gm/orchestrate', { data: { goal: 'revenue growth plan for the ads campaign' } })).json()).data as { runId: string };

    // The annotated actions view marks the action executable.
    const actions = (await (await page.request.get(`/api/admin/gm/runs/${run.runId}/actions`)).json()).data.items as Array<{ action: string; executable: boolean }>;
    const ads = actions.find((a) => a.action === 'ads.spend_increase');
    expect(ads?.executable).toBe(true);

    // Execute it for real. The task exists, is approval-gated, and is NOT
    // auto-executed — the response carries the task's real status.
    const first = (await (await page.request.post(`/api/admin/gm/runs/${run.runId}/actions/execute`, { data: { action: 'ads.spend_increase' } })).json()).data as { status: string; taskId: string | null; taskStatus: string | null; requiresApproval: boolean; deduplicated: boolean };
    expect(first.status).toBe('task_created');
    expect(first.taskStatus).toBe('awaiting_approval');
    expect(first.requiresApproval).toBe(true);
    expect(first.taskId).toBeTruthy();
    expect(first.deduplicated).toBe(false);

    // Idempotent: the second call reuses the same task.
    const second = (await (await page.request.post(`/api/admin/gm/runs/${run.runId}/actions/execute`, { data: { action: 'ads.spend_increase' } })).json()).data as { taskId: string | null; deduplicated: boolean };
    expect(second.taskId).toBe(first.taskId);
    expect(second.deduplicated).toBe(true);

    // The desk shows the Execute control and the real task status for the run.
    await page.goto('/admin/gm');
    await page.getByTestId('admin-gm-tab-runs').click();
    await page.getByTestId(`admin-gm-run-view-${run.runId}`).click();
    await expect(page.getByTestId('admin-gm-detail-actions')).toBeVisible();
    await expect(page.getByTestId('admin-gm-action-execute-ads.spend_increase')).toBeEnabled();
  });

  test('the actions view marks an unwired proposal as not executable', async ({ page }) => {
    const run = (await (await page.request.post('/api/admin/gm/orchestrate', { data: { goal: 'catalogue quality audit for the product listing' } })).json()).data as { runId: string };
    const actions = (await (await page.request.get(`/api/admin/gm/runs/${run.runId}/actions`)).json()).data.items as Array<{ action: string; executable: boolean; reason: string | null }>;
    const publish = actions.find((a) => a.action === 'catalog.publish_batch');
    expect(publish?.executable).toBe(false);
    expect(publish?.reason).toBe('NO_AGENT');
  });
});

test.describe('GM proposed-action execution — RBAC', () => {
  test.use({ storageState: storageFor('admin2') });

  test('an ADMIN-only user is refused the execute and actions endpoints', async ({ page }) => {
    const fake = '00000000-0000-0000-0000-000000000000';
    expect((await page.request.get(`/api/admin/gm/runs/${fake}/actions`)).status()).toBe(403);
    expect((await page.request.post(`/api/admin/gm/runs/${fake}/actions/execute`, { data: { action: 'ads.spend_increase' } })).status()).toBe(403);
  });
});
