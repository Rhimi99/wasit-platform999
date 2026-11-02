import { test, expect, storageFor } from './helpers';

/**
 * AI-06.2 — Agent operations desk (`/admin/agent-ops`), ADMIN + SUPER_ADMIN.
 *
 * Driven from the browser, but a page render is never treated as success: every
 * test compares the rendered figures against the real backend payload fetched
 * through `page.request` (which shares the context's authenticated session and
 * therefore the same RBAC). Nothing here is a literal.
 *
 * `admin` holds SUPER_ADMIN; `admin2` holds ADMIN only — both reach this desk
 * (AI_MANAGE / ADMIN_AI), unlike the SUPER_ADMIN-only Copilot/GM desks.
 * `merchant` and `customer` prove a non-staff role is refused.
 */

test.describe('Agent operations desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('opens from the sidebar and the overview renders live health figures', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/agent-ops"]').click();
    await expect(page).toHaveURL(/\/admin\/agent-ops/);
    await expect(page.getByRole('heading', { name: /مركز عمليات الوكلاء|Agent operations desk/i })).toBeVisible();

    // The scope banner reflects the server-resolved scope, never a client guess.
    const health = (await (await page.request.get('/api/admin/agent-ops/health')).json()).data as {
      scope: string;
      agents: { total: number; active: number; paused: number; disabled: number; unhealthy: number };
    };
    await expect(page.getByTestId('admin-agent-ops-scope')).toContainText(
      health.scope === 'platform' ? /Platform scope|نطاق المنصّة/i : /Owner scope|نطاق المالك/i,
    );

    // Agent KPIs equal the live payload, in order: total, active, paused, disabled, unhealthy.
    const expected = [health.agents.total, health.agents.active, health.agents.paused, health.agents.disabled, health.agents.unhealthy];
    for (let i = 0; i < expected.length; i++) {
      await expect(page.getByTestId(`admin-agent-ops-agent-${i}`)).toContainText(String(expected[i]));
    }

    // The scheduler telemetry block is present for the platform view and separate.
    await expect(page.getByTestId('admin-agent-ops-system')).toBeVisible();
  });

  test('the performance tab renders the exact rows the API returns', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await page.getByTestId('admin-agent-ops-tab-performance').click();

    const perf = (await (await page.request.get('/api/admin/agent-ops/performance')).json()).data as {
      items: Array<{ agentKey: string; total: number; succeeded: number; failed: number }>;
    };
    if (perf.items.length === 0) {
      await expect(page.getByText(/No recorded activity|لا نشاط مسجّل/i)).toBeVisible();
      return;
    }
    await expect(page.getByTestId('admin-agent-ops-performance')).toBeVisible();
    for (const row of perf.items) {
      const cell = page.getByTestId(`admin-agent-ops-perf-${row.agentKey}`);
      await expect(cell).toBeVisible();
      await expect(cell).toContainText(String(row.total));
    }
  });

  test('the activity tab renders the exact rows the API returns', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await page.getByTestId('admin-agent-ops-tab-activity').click();

    const activity = (await (await page.request.get('/api/admin/agent-ops/activity?limit=50')).json()).data as {
      items: Array<{ id: string; agentKey: string; status: string }>;
    };
    if (activity.items.length === 0) {
      await expect(page.getByText(/No recent activity|لا نشاط حديث/i)).toBeVisible();
      return;
    }
    await expect(page.getByTestId('admin-agent-ops-activity')).toBeVisible();
    for (const row of activity.items) {
      await expect(page.getByTestId(`admin-agent-ops-activity-${row.id}`)).toContainText(row.agentKey);
    }
  });

  test('the supervisor tab renders the report the API returns', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await page.getByTestId('admin-agent-ops-tab-supervisor').click();

    const report = (await (await page.request.get('/api/admin/ai/supervisor/report')).json()).data as {
      total: number;
      haltedAgents: Array<{ key: string }>;
      contained: Array<{ id: string }>;
    };
    const summary = page.getByTestId('admin-agent-ops-sup-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(String(report.total));

    await expect(page.getByTestId('admin-agent-ops-sup-halted')).toBeVisible();
    for (const a of report.haltedAgents) {
      await expect(page.getByTestId('admin-agent-ops-sup-halted')).toContainText(a.key);
    }
    await expect(page.getByTestId('admin-agent-ops-sup-contained')).toBeVisible();
    for (const c of report.contained) {
      await expect(page.getByTestId(`admin-agent-ops-contained-${c.id}`)).toBeVisible();
    }
  });

  test('the memory tab renders the exact rows the API returns (G7)', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await page.getByTestId('admin-agent-ops-tab-memory').click();

    const memory = (await (await page.request.get('/api/admin/agent-ops/memory?limit=50')).json()).data as {
      items: Array<{ id: string; agentKey: string; taskId: string | null }>;
      total: number;
    };
    // The total rendered matches the server's own count, never a client guess.
    await expect(page.getByTestId('admin-agent-ops-memory-total')).toContainText(String(memory.total));
    if (memory.items.length === 0) {
      await expect(page.getByText(/No memory notes in your scope|لا توجد ملاحظات ذاكرة في نطاقك/i)).toBeVisible();
      return;
    }
    await expect(page.getByTestId('admin-agent-ops-memory-table')).toBeVisible();
    for (const row of memory.items) {
      await expect(page.getByTestId(`admin-agent-ops-memory-${row.id}`)).toContainText(row.agentKey);
    }
  });

  test('the memory tab is strictly read-only and cannot widen scope (G7)', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await page.getByTestId('admin-agent-ops-tab-memory').click();
    await expect(page.getByTestId('admin-agent-ops-memory')).toBeVisible();

    // No write control exists anywhere on the surface.
    await expect(page.getByRole('button', { name: /delete|حذف|save|حفظ|edit|تعديل/i })).toHaveCount(0);

    // Filtering by an agent narrows the caller's own notes; the server resolves the
    // scope, so the filter can never widen it to another owner.
    const filtered = (await (await page.request.get('/api/admin/agent-ops/memory?agentKey=support-agent')).json()).data as {
      items: Array<{ agentKey: string }>;
    };
    for (const row of filtered.items) expect(row.agentKey).toBe('support-agent');

    // A scope claim in the query is ignored: the result equals the unfiltered one.
    const base = (await (await page.request.get('/api/admin/agent-ops/memory')).json()).data as { total: number };
    const claimed = (await (await page.request.get('/api/admin/agent-ops/memory?scope=platform&isPlatform=true&owner=someone-else')).json()).data as { total: number };
    expect(claimed.total).toBe(base.total);
  });

  test('reading the desk writes nothing: the health payload is stable across two fetches', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    const first = (await (await page.request.get('/api/admin/agent-ops/health')).json()).data as { agents: { total: number }; tasks: { running: number } };
    const activityBefore = (await (await page.request.get('/api/admin/agent-ops/activity?limit=100')).json()).data as { items: unknown[] };
    // Reload the page (the desk issues four GETs) and read again.
    await page.reload();
    const second = (await (await page.request.get('/api/admin/agent-ops/health')).json()).data as { agents: { total: number }; tasks: { running: number } };
    const activityAfter = (await (await page.request.get('/api/admin/agent-ops/activity?limit=100')).json()).data as { items: unknown[] };

    // No task was created or moved by merely viewing the desk.
    expect(second.agents.total).toBe(first.agents.total);
    expect(second.tasks.running).toBe(first.tasks.running);
    expect(activityAfter.items.length).toBe(activityBefore.items.length);
  });
});

test.describe('Agent operations desk — ADMIN (AI_MANAGE) access', () => {
  test.use({ storageState: storageFor('admin2') });

  test('an ADMIN-only user reaches the page and every agent-ops surface', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await expect(page.getByRole('heading', { name: /مركز عمليات الوكلاء|Agent operations desk/i })).toBeVisible();

    expect((await page.request.get('/api/admin/agent-ops/health')).status()).toBe(200);
    expect((await page.request.get('/api/admin/agent-ops/performance')).status()).toBe(200);
    expect((await page.request.get('/api/admin/agent-ops/activity')).status()).toBe(200);
    expect((await page.request.get('/api/admin/ai/supervisor/report')).status()).toBe(200);
  });

  test('the agent-ops link is rendered in the ADMIN sidebar', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('aside nav a[href="/admin/agent-ops"]')).toBeVisible();
  });
});

test.describe('Agent operations desk — RBAC denial', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the page and every agent-ops surface', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();

    expect((await page.request.get('/api/admin/agent-ops/health')).status()).toBe(403);
    expect((await page.request.get('/api/admin/agent-ops/performance')).status()).toBe(403);
    expect((await page.request.get('/api/admin/agent-ops/activity')).status()).toBe(403);
    expect((await page.request.get('/api/admin/ai/supervisor/report')).status()).toBe(403);
  });

  test('the agent-ops link is not rendered in the merchant sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('aside nav a[href="/admin/agent-ops"]')).toHaveCount(0);
  });
});

test.describe('Agent operations desk — customer RBAC', () => {
  test.use({ storageState: storageFor('customer') });

  test('a customer is refused by the agent-ops API', async ({ page }) => {
    await page.goto('/admin/agent-ops');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/agent-ops/health')).status()).toBe(403);
  });
});
