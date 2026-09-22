import { test, expect, storageFor } from './helpers';

/**
 * Admin AI governance desk — functional audit driven from the browser.
 * A page render is never treated as success: each test performs the action in
 * the UI, then reads the real backend state back to prove the effect happened.
 *
 * `page.request` shares the browser context's authenticated session, so setup
 * and verification hit the same real backend with the same RBAC as the UI.
 */

test.describe('Admin AI governance desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('sidebar opens the desk and every tab renders backend data', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/ai"]').click();
    await expect(page).toHaveURL(/\/admin\/ai/);
    await expect(page.getByRole('heading', { name: /حوكمة الذكاء الاصطناعي|AI governance/i })).toBeVisible();

    // Overview KPIs must equal the live /usage payload, not literals.
    const usage = (await (await page.request.get('/api/admin/ai/usage')).json()).data;
    await expect(page.getByTestId('admin-ai-kpi-requests')).toContainText(String(usage.totals.requests));
    await expect(page.getByTestId('admin-ai-kpi-users')).toContainText(String(usage.totals.distinctUsers));

    // Models tab renders the seeded catalogue.
    await page.getByTestId('admin-ai-tab-models').click();
    await expect(page.getByTestId('admin-ai-model-local-heuristic')).toBeVisible();

    // Agents tab renders the registry, including the approval gate.
    await page.getByTestId('admin-ai-tab-agents').click();
    const salesAgent = page.getByTestId('admin-ai-agent-sales-agent');
    await expect(salesAgent).toBeVisible();
    await expect(salesAgent).toContainText(/يتطلب اعتمادًا بشريًا|Requires human approval/i);
  });

  test('a gated agent task appears in the queue and is approved from the UI', async ({ page }) => {
    const created = await page.request.post('/api/ai/agents/sales-agent/tasks', { data: { input: {} } });
    expect(created.status()).toBe(201);
    const body = (await created.json()).data;
    const taskId = body.id as string;
    expect(body.status).toBe('awaiting_approval');

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-tasks').click();
    const row = page.getByTestId(`admin-ai-task-${taskId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('awaiting_approval');

    await page.getByTestId(`admin-ai-approve-${taskId}`).click();
    await expect(page.getByText(/تم اعتماد المهمة|Task approved/i).first()).toBeVisible();

    // Confirm server-side, then in the refreshed UI.
    const after = (await (await page.request.get(`/api/ai/tasks/${taskId}`)).json()).data;
    expect(after.status).toBe('approved');
    await expect(page.getByTestId(`admin-ai-task-${taskId}`)).toContainText('approved');
  });

  test('rejecting a gated task from the UI is persisted server-side', async ({ page }) => {
    const created = await page.request.post('/api/ai/agents/b2b-agent/tasks', { data: { input: {} } });
    expect(created.status()).toBe(201);
    const taskId = (await created.json()).data.id as string;

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-tasks').click();
    await page.getByTestId(`admin-ai-reject-${taskId}`).click();
    await expect(page.getByText(/تم رفض المهمة|Task rejected/i).first()).toBeVisible();

    const after = (await (await page.request.get(`/api/ai/tasks/${taskId}`)).json()).data;
    expect(after.status).toBe('rejected');
  });

  test('a budget created through the API shows in the desk and persists', async ({ page }) => {
    const upsert = await page.request.post('/api/admin/ai/budgets', {
      data: {
        roleTarget: 'SUPPLIER',
        period: 'MONTHLY',
        maxRequests: 77,
        currencyCode: 'USD',
        isActive: true,
      },
    });
    expect([200, 201]).toContain(upsert.status());
    const budgetId = (await upsert.json()).data.id as string;

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-budgets').click();
    await expect(page.getByTestId(`admin-ai-budget-${budgetId}`)).toContainText('77');
  });

  test('requests tab reflects a real AI invocation', async ({ page }) => {
    const run = await page.request.post('/api/ai/run', {
      data: { requestType: 'MARKET_ANALYSIS', user: 'admin-ai-e2e probe' },
    });
    expect(run.ok()).toBeTruthy();
    const requestId = ((await run.json()).data as { requestId: string }).requestId;
    expect(requestId).toBeTruthy();

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-requests').click();
    await expect(page.getByTestId('admin-ai-requests')).toBeVisible();

    // The desk lists the most recent invocations first, so the request just
    // issued must appear as a row — asserting on the id avoids depending on
    // list length, which saturates at the endpoint's 200-row window.
    await expect(page.getByTestId(`admin-ai-request-${requestId}`)).toBeVisible();
    const first = page.locator('[data-testid^="admin-ai-request-"]').first();
    await expect(first).toHaveAttribute('data-testid', `admin-ai-request-${requestId}`);
  });
});

test.describe('Admin AI governance desk — RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the desk and every admin AI API', async ({ page }) => {
    await page.goto('/admin/ai');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
    expect((await page.request.get('/api/admin/ai/usage')).status()).toBe(403);
    expect((await page.request.get('/api/admin/ai/agents')).status()).toBe(403);
    expect((await page.request.get('/api/admin/ai/budgets')).status()).toBe(403);
  });
});
