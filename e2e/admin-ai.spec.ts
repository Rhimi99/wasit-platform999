import { test, expect, storageFor, completeEmailVerification, loginViaUi, DEMO_PASSWORD, type DemoRole } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Admin AI governance desk — functional audit driven from the browser.
 * A page render is never treated as success: each test performs the action in
 * the UI, then reads the real backend state back to prove the effect happened.
 *
 * `page.request` shares the browser context's authenticated session, so setup
 * and verification hit the same real backend with the same RBAC as the UI.
 */

/** Runs `fn` against a fresh authenticated API context for `role`, then disposes it. */
async function asRole<T>(page: Page, role: DemoRole, fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await page.context().browser()!.newContext({ storageState: storageFor(role) });
  try {
    return await fn(ctx.request);
  } finally {
    await ctx.close();
  }
}

/** Raises a gated agent task as `role` and returns its id (asserts it is gated). */
async function createTaskAs(page: Page, role: DemoRole, agentKey: string): Promise<string> {
  return asRole(page, role, async (ctx) => {
    const created = await ctx.post(`/api/ai/agents/${agentKey}/tasks`, { data: { input: {} } });
    expect(created.status()).toBe(201);
    const body = (await created.json()).data as { id: string; status: string };
    expect(body.status).toBe('awaiting_approval');
    return body.id;
  });
}


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
    // Separation of duties (AI-02.P0): the requester may never approve their own
    // task. Raise the task as an INDEPENDENT authorised user (admin2) so the
    // signed-in admin is a genuine second party and the approval is legitimate.
    const taskId = await createTaskAs(page, 'admin2', 'sales-agent');

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

  test('a requester cannot approve their own task, but an independent approver can', async ({ page }) => {
    // The signed-in admin raises their OWN gated task…
    const ownTaskId = await createTaskAs(page, 'admin', 'sales-agent');

    // …and the server refuses the self-approval outright (separation of duties).
    const selfApprove = await page.request.post(`/api/ai/tasks/${ownTaskId}/approve`, {
      data: { decision: 'APPROVE' },
    });
    expect(selfApprove.status()).toBe(403);
    // The task is untouched by the refused attempt.
    expect((await (await page.request.get(`/api/ai/tasks/${ownTaskId}`)).json()).data.status).toBe('awaiting_approval');

    // A DIFFERENT authorised approver (admin2 holds ai:manage) succeeds.
    const decision = await asRole(page, 'admin2', (ctx) =>
      ctx.post(`/api/ai/tasks/${ownTaskId}/approve`, { data: { decision: 'APPROVE' } }),
    );
    expect(decision.ok()).toBeTruthy();
    expect((await (await page.request.get(`/api/ai/tasks/${ownTaskId}`)).json()).data.status).toBe('approved');
  });

  test('a user without ai:manage cannot approve a gated task', async ({ page }) => {
    // A merchant may raise an ai:use task, but holds no ai:manage permission.
    const taskId = await createTaskAs(page, 'merchant', 'sales-agent');

    const attempt = await asRole(page, 'merchant', (ctx) =>
      ctx.post(`/api/ai/tasks/${taskId}/approve`, { data: { decision: 'APPROVE' } }),
    );
    expect(attempt.status()).toBe(403);
    // RBAC held: the task is still awaiting an authorised approver.
    expect((await (await page.request.get(`/api/ai/tasks/${taskId}`)).json()).data.status).toBe('awaiting_approval');
  });

  test('rejecting a gated task from the UI is persisted server-side', async ({ page }) => {
    const taskId = await createTaskAs(page, 'admin2', 'b2b-agent');

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-tasks').click();
    await page.getByTestId(`admin-ai-reject-${taskId}`).click();
    await expect(page.getByText(/تم رفض المهمة|Task rejected/i).first()).toBeVisible();

    const after = (await (await page.request.get(`/api/ai/tasks/${taskId}`)).json()).data;
    expect(after.status).toBe('rejected');
  });

  test('refresh re-reads the requests table changed behind the page', async ({ page }) => {
    // The table renders only when at least one request exists, so the fixture is
    // created here instead of being inherited from whichever test ran before.
    const seedCtx = await page.context().browser()!.newContext({ storageState: storageFor('customer') });
    try {
      const seedPage = await seedCtx.newPage();
      expect((await seedPage.request.post('/api/ai/smart-search', { data: { q: 'refresh seed' } })).ok()).toBeTruthy();
    } finally {
      await seedCtx.close();
    }

    // Mutate the server after the page has already loaded its snapshot: another
    // actor issues a real AI request after this table has rendered.
    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-requests').click();
    await expect(page.getByTestId('admin-ai-requests')).toBeVisible();
    const rows = page.locator('[data-testid^="admin-ai-request-"]');
    await expect(rows.first()).toBeVisible();
    const firstBefore = await rows.first().getAttribute('data-testid');

    const customerCtx = await page.context().browser()!.newContext({ storageState: storageFor('customer') });
    const cp = await customerCtx.newPage();
    try {
      expect((await cp.request.post('/api/ai/smart-search', { data: { q: 'refresh audit' } })).ok()).toBeTruthy();
    } finally {
      await customerCtx.close();
    }

    await page.getByTestId('admin-ai-refresh').click();

    // The refresh must surface the newly created request at the top: the newest
    // rendered row has to match the newest row the API reports.
    const apiNewest = (await (await page.request.get('/api/admin/ai/requests?limit=1')).json()).data.items[0] as { id: string };
    await expect.poll(async () => rows.first().getAttribute('data-testid')).toBe(`admin-ai-request-${apiNewest.id}`);
    expect(await rows.first().getAttribute('data-testid')).not.toBe(firstBefore);
  });

  test('stops one agent from the desk and lifts that stop again', async ({ page }) => {
    // The fleet scope: one agent stops, the others keep working. The UI must
    // offer the control, show the state the server reports, and offer the way
    // back — a stop with no reachable resume is a trap.
    const agentKey = 'analytics-agent';
    page.on('dialog', (dialog) => void dialog.accept());

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-agents').click();
    const toggle = page.getByTestId(`admin-ai-agent-switch-${agentKey}`);
    await expect(toggle).toBeVisible();

    try {
      await toggle.click();
      await expect(page.getByTestId(`admin-ai-agent-stopped-${agentKey}`)).toBeVisible();
      const stopped = (await (await page.request.get('/api/admin/ai/execution-switch')).json()).data;
      expect(stopped.stoppedAgents).toContain(agentKey);
      // Only that agent: the global switch is untouched.
      expect(stopped.globalStopped).toBe(false);
      expect(stopped.enabled).toBe(true);

      await expect(toggle).toHaveText(/إعادة تفعيل هذا الوكيل|Re-enable this agent/i);
      await toggle.click();
      await expect(page.getByTestId(`admin-ai-agent-stopped-${agentKey}`)).toHaveCount(0);
      const resumed = (await (await page.request.get('/api/admin/ai/execution-switch')).json()).data;
      expect(resumed.stoppedAgents).not.toContain(agentKey);
    } finally {
      // Other specs drive this agent; leave the fleet open on every exit path.
      await page.request.post(`/api/admin/ai/execution-switch/agents/${agentKey}`, {
        data: { stopped: false, reason: 'e2e cleanup' },
      });
    }
  });

  test('creates a model from the desk and reads it back from the server', async ({ page }) => {
    // Fixed key: the model catalogue has no delete route by design, so re-runs
    // must upsert the same row rather than accumulate fixtures.
    const key = 'e2e-model-desk';

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-models').click();
    await page.getByTestId('admin-ai-model-key').fill(key);
    await page.getByTestId('admin-ai-model-name').fill('E2E Smoke Model');
    await page.getByTestId('admin-ai-model-provider').fill('local');
    await page.getByTestId('admin-ai-model-input').fill('0.25');
    await page.getByTestId('admin-ai-model-output').fill('0.75');
    await page.getByTestId('admin-ai-model-submit').click();

    await expect(page.getByText(/Model saved|تم حفظ النموذج/).first()).toBeVisible();
    const row = page.getByTestId(`admin-ai-model-${key}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('E2E Smoke Model');

    // Prove the write landed server-side and not just in component state.
    const list = (await (await page.request.get('/api/admin/ai/models')).json()).data.items as Array<
      { id: string; key: string; inputPer1k: string; isActive: boolean }
    >;
    const persisted = list.find((m) => m.key === key);
    expect(persisted).toBeTruthy();

    // Deactivate through the row action, then confirm via the API.
    await page.getByTestId(`admin-ai-model-toggle-${key}`).click();
    await expect(page.getByText(/Model deactivated|تم إيقاف النموذج/).first()).toBeVisible();
    const after = (await (await page.request.get('/api/admin/ai/models')).json()).data.items as Array<
      { key: string; isActive: boolean }
    >;
    expect(after.find((m) => m.key === key)?.isActive).toBe(false);

    // Restore so the shared catalogue is unchanged for other tests.
    await page.request.post('/api/admin/ai/models', {
      data: { key, displayName: 'E2E Smoke Model', provider: 'local', isActive: true },
    });
  });

  test('editing a model pre-fills the form and updates in place', async ({ page }) => {
    const key = 'e2e-model-edit';
    await page.request.post('/api/admin/ai/models', {
      data: { key, displayName: 'Before Edit', provider: 'local', isActive: true },
    });

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-models').click();
    const row = page.getByTestId(`admin-ai-model-${key}`);
    await expect(row).toBeVisible();

    await page.getByTestId(`admin-ai-model-edit-${key}`).click();
    await expect(page.getByTestId('admin-ai-model-name')).toHaveValue('Before Edit');
    await page.getByTestId('admin-ai-model-name').fill('After Edit');
    await page.getByTestId('admin-ai-model-submit').click();
    await expect(page.getByText(/Model saved|تم حفظ النموذج/).first()).toBeVisible();

    await expect(page.getByTestId(`admin-ai-model-${key}`)).toContainText('After Edit');
    const rows = (await (await page.request.get('/api/admin/ai/models')).json()).data.items as Array<
      { id: string; key: string; displayName: string }
    >;
    const matches = rows.filter((m) => m.key === key);
    expect(matches.length).toBe(1);
    expect(matches[0].displayName).toBe('After Edit');
  });

  test('cancelling an edit discards the typed changes without touching the server', async ({ page }) => {
    // A pure client-side reset, but it must still be proven: Cancel has to clear
    // the edited buffer AND leave the persisted model untouched.
    const key = 'e2e-model-cancel';
    await page.request.post('/api/admin/ai/models', {
      data: { key, displayName: 'Original Name', provider: 'local', isActive: true },
    });

    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-models').click();
    await expect(page.getByTestId(`admin-ai-model-${key}`)).toBeVisible();

    await page.getByTestId(`admin-ai-model-edit-${key}`).click();
    await page.getByTestId('admin-ai-model-name').fill('Discarded Edit');
    await page.getByTestId('admin-ai-model-cancel').click();

    // The form resets (create mode: empty key, Cancel itself disappears).
    await expect(page.getByTestId('admin-ai-model-key')).toHaveValue('');
    await expect(page.getByTestId('admin-ai-model-cancel')).toHaveCount(0);

    // The server still holds the original name — Cancel issued no write.
    const rows = (await (await page.request.get('/api/admin/ai/models')).json()).data.items as Array<
      { key: string; displayName: string }
    >;
    expect(rows.find((m) => m.key === key)?.displayName).toBe('Original Name');
  });

  test('creates a budget from the desk and toggles it from the row', async ({ page }) => {
    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-budgets').click();
    await page.getByTestId('admin-ai-budget-role').selectOption('COMPANY');
    await page.getByTestId('admin-ai-budget-maxreq').fill('131');
    await page.getByTestId('admin-ai-budget-maxcost').fill('12.5000000000');
    await page.getByTestId('admin-ai-budget-submit').click();

    await expect(page.getByText(/Budget saved|تم حفظ الميزانية/).first()).toBeVisible();

    const budgets = (await (await page.request.get('/api/admin/ai/budgets')).json()).data.items as Array<
      { id: string; roleTarget: string | null; period: string; maxRequests: number | null; isActive: boolean }
    >;
    const company = budgets.find((b) => b.roleTarget === 'COMPANY');
    expect(company).toBeTruthy();
    expect(company?.maxRequests).toBe(131);

    await expect(page.getByTestId(`admin-ai-budget-${company!.id}`)).toContainText('131');

    // Toggle from the row and verify the persisted flag flips.
    await page.getByTestId(`admin-ai-budget-toggle-${company!.id}`).click();
    await expect(page.getByText(/Budget deactivated|تم إيقاف الميزانية/).first()).toBeVisible();
    const after = (await (await page.request.get('/api/admin/ai/budgets')).json()).data.items as Array<
      { id: string; isActive: boolean }
    >;
    expect(after.find((b) => b.id === company!.id)?.isActive).toBe(false);

    // Leave the row active again so other specs see the seeded state.
    await page.request.post('/api/admin/ai/budgets', {
      data: {
        roleTarget: 'COMPANY', period: company!.period,
        maxRequests: 131, currencyCode: 'USD', isActive: true,
      },
    });
  });

  test('a budget written by the API shows in the desk and persists', async ({ page }) => {
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

  test('DAILY and MONTHLY budgets for the same target coexist', async ({ page }) => {
    // A budget is scoped by (target, period): cost-control resolves the DAILY
    // and MONTHLY windows independently. Saving them from the desk must not
    // collapse both onto one row.
    await page.goto('/admin/ai');
    await page.getByTestId('admin-ai-tab-budgets').click();

    await page.getByTestId('admin-ai-budget-kind').selectOption('ROLE');
    await page.getByTestId('admin-ai-budget-role').selectOption('ADMIN');

    await page.getByTestId('admin-ai-budget-period').selectOption('DAILY');
    await page.getByTestId('admin-ai-budget-maxreq').fill('5001');
    await page.getByTestId('admin-ai-budget-submit').click();
    await expect(page.getByText(/Budget saved|تم حفظ الميزانية/).first()).toBeVisible();

    await page.getByTestId('admin-ai-budget-period').selectOption('MONTHLY');
    await page.getByTestId('admin-ai-budget-maxreq').fill('5002');
    await page.getByTestId('admin-ai-budget-submit').click();
    await expect(page.getByText(/Budget saved|تم حفظ الميزانية/).first()).toBeVisible();

    const budgets = (await (await page.request.get('/api/admin/ai/budgets')).json()).data.items as Array<
      { id: string; roleTarget: string | null; period: string; maxRequests: number | null }
    >;
    const daily = budgets.find((b) => b.roleTarget === 'ADMIN' && b.period === 'DAILY');
    const monthly = budgets.find((b) => b.roleTarget === 'ADMIN' && b.period === 'MONTHLY');
    expect(daily?.maxRequests).toBe(5001);
    expect(monthly?.maxRequests).toBe(5002);

    // Both rows and both periods are rendered back in the desk.
    await expect(page.getByTestId(`admin-ai-budget-${daily!.id}`)).toContainText('DAILY');
    await expect(page.getByTestId(`admin-ai-budget-${daily!.id}`)).toContainText('5001');
    await expect(page.getByTestId(`admin-ai-budget-${monthly!.id}`)).toContainText('MONTHLY');
    await expect(page.getByTestId(`admin-ai-budget-${monthly!.id}`)).toContainText('5002');

    // Re-saving the same target+period updates in place instead of duplicating.
    await page.getByTestId('admin-ai-budget-period').selectOption('DAILY');
    await page.getByTestId('admin-ai-budget-maxreq').fill('5003');
    await page.getByTestId('admin-ai-budget-submit').click();
    await expect(page.getByText(/Budget saved|تم حفظ الميزانية/).first()).toBeVisible();

    const after = (await (await page.request.get('/api/admin/ai/budgets')).json()).data.items as Array<
      { roleTarget: string | null; period: string; maxRequests: number | null }
    >;
    const adminRows = after.filter((b) => b.roleTarget === 'ADMIN');
    expect(adminRows.length).toBe(2);
    expect(adminRows.find((b) => b.period === 'DAILY')?.maxRequests).toBe(5003);
    expect(adminRows.find((b) => b.period === 'MONTHLY')?.maxRequests).toBe(5002);

    // Restore a generous DAILY cap so other admin AI calls are unaffected.
    await page.request.post('/api/admin/ai/budgets', {
      data: { roleTarget: 'ADMIN', period: 'DAILY', maxRequests: 100000, currencyCode: 'USD', isActive: true },
    });
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

/**
 * B19 — the requesting user must be able to see the result of an agent task they
 * ran once an approver acts on it. Before the fix the merchant AI page rendered
 * only `/api/ai/activity` (raw LLM invocations), so an approved gated task stayed
 * invisible: the backend held the result but the UI never surfaced it.
 */
test.describe('Agent task results reach the requesting user', () => {
  // A dedicated seller, not the shared demo merchant: agent work is metered per
  // account (`ai.agent`), and the other merchant specs spend that quota. Sharing
  // it made this spec fail on a 429 that had nothing to do with task results.
  const ISOLATED_MERCHANT = { email: 'e2e-ai-merchant@wasit.tn', password: DEMO_PASSWORD };

  test('an approved gated task appears with its result on the merchant AI page', async ({ page, playwright }) => {
    // Idempotent fixture: register once, then reuse. Verification goes through
    // the real dev link, and the sign-in is the real form.
    const setup = await playwright.request.newContext({ baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000' });
    try {
      const reg = await setup.post('/api/auth/register', {
        data: { email: ISOLATED_MERCHANT.email, password: ISOLATED_MERCHANT.password, firstName: 'E2E AI', role: 'MERCHANT' },
      });
      expect([201, 409]).toContain(reg.status());
      // A demo stack registers accounts already verified and hides the dev link,
      // so a missing link is not fatal there; the login below is the real check.
      if (reg.status() === 201) {
        await completeEmailVerification(setup, ISOLATED_MERCHANT.email).catch(() => false);
      }
    } finally {
      await setup.dispose();
    }
    await loginViaUi(page, ISOLATED_MERCHANT.email, ISOLATED_MERCHANT.password);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect((await page.request.get('/api/auth/me')).ok(), 'the isolated merchant is signed in').toBeTruthy();

    await page.goto('/dashboard/ai');

    // Run the gated Sales Agent from the merchant UI.
    const salesCard = page
      .locator('div')
      .filter({ has: page.getByText('Sales Agent', { exact: true }) })
      .filter({ has: page.getByRole('button', { name: /تنفيذ|Run/ }) })
      .last();
    await salesCard.getByRole('button', { name: /تنفيذ|Run/ }).click();

    // The merchant sees the row while it is still awaiting approval.
    const pendingRow = page.locator('[data-testid^="ai-task-"]').filter({ hasText: /قيد الموافقة|Awaiting approval/i }).first();
    await expect(pendingRow).toBeVisible({ timeout: 15_000 });
    const taskId = (await pendingRow.getAttribute('data-testid'))!.replace('ai-task-', '');

    // An independent admin session approves the task through the real route.
    const adminApi = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000',
      storageState: storageFor('admin'),
    });
    const approved = await adminApi.post(`/api/ai/tasks/${taskId}/approve`, { data: { decision: 'APPROVE' } });
    expect(approved.ok()).toBeTruthy();
    expect((await approved.json()).data.status).toBe('approved');
    await adminApi.dispose();

    // Reload: the approved task and its computed result must now be visible.
    await page.reload();
    const approvedRow = page.getByTestId(`ai-task-${taskId}`);
    await expect(approvedRow).toBeVisible();
    await expect(approvedRow).toContainText(/معتمد|Approved/i);
    await expect(approvedRow.getByTestId('ai-task-result')).toBeVisible();

    // Prove the rendered result matches the real backend payload.
    const task = (await (await page.request.get(`/api/ai/tasks/${taskId}`)).json()).data;
    expect(task.status).toBe('approved');
    expect(task.result).toBeTruthy();
  });
});
