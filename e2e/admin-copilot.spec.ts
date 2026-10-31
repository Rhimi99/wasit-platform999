import { test, expect, storageFor } from './helpers';

/**
 * AI-02.2 — Admin Copilot desk (`/admin/copilot`), SUPER_ADMIN only.
 *
 * Driven from the browser, but a page render is never treated as success: every
 * test performs the action in the UI and then reads the real backend state back
 * through `page.request` (which shares the context's authenticated session) to
 * prove the effect happened with the real RBAC.
 *
 * The `admin` demo fixture holds SUPER_ADMIN (plus ADMIN); `admin2` holds ADMIN
 * only, which is exactly the boundary this feature adds — ADMIN must NOT reach
 * the Copilot desk even though it reaches the AI governance desk.
 */

test.describe('Admin Copilot desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('opens from the sidebar and the control tab renders the preview affordance', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/copilot"]').click();
    await expect(page).toHaveURL(/\/admin\/copilot/);
    await expect(page.getByTestId('admin-copilot-events')).toBeVisible();
    await expect(page.getByTestId('admin-copilot-preview-btn')).toBeVisible();
    // Confirm is disabled until a preview has been produced.
    await expect(page.getByTestId('admin-copilot-confirm-btn')).toBeDisabled();
  });

  test('previewing an instruction shows the proposed agent and creates no task', async ({ page }) => {
    const before = (await (await page.request.get('/api/admin/copilot/tasks?limit=200')).json()).data.items as Array<{ id: string }>;

    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-events').fill('order.placed');
    await page.getByTestId('admin-copilot-preview-btn').click();

    const row = page.getByTestId('admin-copilot-preview-row-0');
    await expect(row).toBeVisible();
    await expect(row).toContainText('order.placed');
    await expect(row).toContainText('operations-agent');

    // Preview is a dry run: no new task exists server-side.
    const after = (await (await page.request.get('/api/admin/copilot/tasks?limit=200')).json()).data.items as Array<{ id: string }>;
    expect(after.length).toBe(before.length);
  });

  test('confirming a previewed route creates the task and persists the run', async ({ page }) => {
    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-events').fill('order.placed');
    await page.getByTestId('admin-copilot-preview-btn').click();
    await expect(page.getByTestId('admin-copilot-preview-row-0')).toBeVisible();

    await page.getByTestId('admin-copilot-confirm-btn').click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();

    // The run is real: a task exists for the routed agent and is audited.
    const tasks = (await (await page.request.get('/api/admin/copilot/tasks?agentKey=operations-agent&limit=50')).json()).data.items as Array<{ id: string }>;
    expect(tasks.length).toBeGreaterThan(0);
    const audit = (await (await page.request.get('/api/admin/copilot/audit?action=AI.COPILOT_ROUTED&limit=5')).json()).data.items as Array<{ action: string }>;
    expect(audit.length).toBeGreaterThan(0);
  });

  test('a gated task is approved and then explicitly run from the tasks tab', async ({ page }) => {
    // Seed a gated task directly (sales-agent is approval-gated).
    const created = await page.request.post('/api/admin/copilot/agents/sales-agent/tasks', { data: { input: {} } });
    expect(created.status()).toBe(201);
    const taskId = (await created.json()).data.id as string;

    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-tab-tasks').click();
    const row = page.getByTestId(`admin-copilot-task-${taskId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('awaiting_approval');

    // Approve records the decision only — the task is not executed yet.
    await page.getByTestId(`admin-copilot-approve-${taskId}`).click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();
    const approved = (await (await page.request.get(`/api/admin/copilot/tasks/${taskId}`)).json()).data as { status: string; result: unknown };
    expect(approved.status).toBe('approved');
    expect(approved.result).toBeNull();

    // Run is a separate, explicit action and executes the task.
    await expect(page.getByTestId(`admin-copilot-run-${taskId}`)).toBeVisible();
    await page.getByTestId(`admin-copilot-run-${taskId}`).click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();

    const ran = (await (await page.request.get(`/api/admin/copilot/tasks/${taskId}`)).json()).data as { status: string };
    expect(['succeeded', 'failed']).toContain(ran.status);
  });

  test('the approvals tab lists pending tasks and rejects one from the UI', async ({ page }) => {
    const created = await page.request.post('/api/admin/copilot/agents/b2b-agent/tasks', { data: { input: {} } });
    expect(created.status()).toBe(201);
    const taskId = (await created.json()).data.id as string;

    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-tab-approvals').click();
    const row = page.getByTestId(`admin-copilot-approval-${taskId}`);
    await expect(row).toBeVisible();

    await page.getByTestId(`admin-copilot-approval-reject-${taskId}`).click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();

    const after = (await (await page.request.get(`/api/admin/copilot/tasks/${taskId}`)).json()).data as { status: string };
    expect(after.status).toBe('rejected');
  });

  test('pausing and resuming an agent from the desk persists server-side', async ({ page }) => {
    const agentKey = 'b2b-agent';

    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-tab-agents').click();
    const card = page.getByTestId(`admin-copilot-agent-${agentKey}`);
    await expect(card).toBeVisible();

    await page.getByTestId(`admin-copilot-agent-pause-${agentKey}`).click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();
    const paused = (await (await page.request.get('/api/admin/copilot/agents')).json()).data.items as Array<{ key: string; status: string }>;
    expect(paused.find((a) => a.key === agentKey)?.status).toBe('PAUSED');

    // Restore so other specs see the seeded ACTIVE state.
    await page.getByTestId(`admin-copilot-agent-resume-${agentKey}`).click();
    await expect(page.getByTestId('admin-copilot-notice')).toBeVisible();
    const resumed = (await (await page.request.get('/api/admin/copilot/agents')).json()).data.items as Array<{ key: string; status: string }>;
    expect(resumed.find((a) => a.key === agentKey)?.status).toBe('ACTIVE');
  });

  test('the audit tab shows only AI.* activity', async ({ page }) => {
    await page.goto('/admin/copilot');
    await page.getByTestId('admin-copilot-tab-audit').click();
    const rows = page.locator('[data-testid^="admin-copilot-audit-"]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      await expect(rows.nth(i)).toContainText(/^AI\./);
    }
  });
});

test.describe('Admin Copilot desk — RBAC', () => {
  test.use({ storageState: storageFor('admin2') });

  test('an ADMIN-only user is blocked from the page and every Copilot API', async ({ page }) => {
    await page.goto('/admin/copilot');
    await expect(page.getByText(/Forbidden: Super Admin area/i)).toBeVisible();

    // The server is the real control: ADMIN gets 403 on every route.
    expect((await page.request.get('/api/admin/copilot')).status()).toBe(403);
    expect((await page.request.get('/api/admin/copilot/agents')).status()).toBe(403);
    expect((await page.request.get('/api/admin/copilot/tasks')).status()).toBe(403);
    expect((await page.request.get('/api/admin/copilot/audit')).status()).toBe(403);
    expect(
      (await page.request.post('/api/admin/copilot/route', { data: { events: [{ event: 'order.placed' }] } })).status(),
    ).toBe(403);
  });

  test('the Copilot link is not rendered in the ADMIN sidebar', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('aside nav a[href="/admin/ai"]')).toBeVisible();
    await expect(page.locator('aside nav a[href="/admin/copilot"]')).toHaveCount(0);
  });
});

test.describe('Admin Copilot desk — merchant RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the page and the Copilot API', async ({ page }) => {
    await page.goto('/admin/copilot');
    await expect(page.getByText(/Forbidden: Super Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/copilot/tasks')).status()).toBe(403);
  });
});
