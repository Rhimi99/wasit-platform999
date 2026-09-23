import { request } from '@playwright/test';
import { Pool } from 'pg';
import { test, expect, storageFor, DEMO_PASSWORD } from './helpers';

/**
 * Admin subscriptions desk — functional audit driven entirely from the browser.
 * Every assertion reads the real backend state back through the API to prove the
 * UI action had a real effect (a 200 on the page render is not enough).
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

/** Registers + verifies + subscribes a throwaway customer through the real API. */
async function createSubscribedCustomer(planCode: string): Promise<{ email: string; subscriptionId: string; invoiceId: string }> {
  const ctx = await request.newContext({ baseURL: API_URL });
  const email = `adminsub-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await ctx.post('/api/auth/register', {
    data: { email, password: DEMO_PASSWORD, firstName: 'AdminSub', role: 'CUSTOMER' },
  });
  expect(reg.status()).toBe(201);
  const link = await ctx.post('/api/auth/dev/verification-link', { data: { email } });
  const { token } = (await link.json()).data as { token: string };
  expect((await ctx.post('/api/auth/verify-email', { data: { token } })).ok()).toBeTruthy();
  expect((await ctx.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } })).ok()).toBeTruthy();

  const plansBody = await (await ctx.get('/api/subscriptions/plans')).json();
  const plan = (plansBody.data.items as Array<{ id: string; code: string }>).find((p) => p.code === planCode);
  expect(plan).toBeTruthy();
  const sub = await ctx.post('/api/subscriptions/subscribe', {
    data: { planId: plan!.id, billingCycle: 'MONTHLY' },
  });
  expect(sub.ok()).toBeTruthy();
  const subscriptionId = (await sub.json()).data.subscription.id as string;

  const invoicesBody = await (await ctx.get('/api/subscriptions/me/invoices')).json();
  const invoiceId = (invoicesBody.data.items as Array<{ id: string }>)[0].id;
  await ctx.dispose();
  return { email, subscriptionId, invoiceId };
}

/**
 * Ages a real subscription past its end with autoRenew off, so the lapsed-sweep
 * legitimately picks it up. Time cannot be travelled through the UI; the fixture
 * is written directly and the real sweep is then driven from the browser, exactly
 * as the privacy desk ages a retention window.
 */
async function expireSubscriptionInDb(subscriptionId: string): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev',
  });
  try {
    await pool.query(
      "UPDATE subscriptions SET auto_renew = false, ends_at = $1, updated_at = now() WHERE id = $2",
      [new Date(Date.now() - 60_000), subscriptionId],
    );
  } finally {
    await pool.end();
  }
}

test.describe('Admin subscriptions desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('sidebar link opens the desk and renders live plans + subscriptions + invoices', async ({ page }) => {
    // The seeder does not create subscriptions, and the desk loads its data on
    // mount, so mint a real subscription before opening the page.
    const { subscriptionId, invoiceId } = await createSubscribedCustomer('SMALL_MERCHANT');

    await page.goto('/admin');
    await page.locator('aside nav a[href="/admin/subscriptions"]').click();
    await expect(page).toHaveURL(/\/admin\/subscriptions/);
    await expect(page.getByRole('heading', { name: /إدارة الاشتراكات|Subscription management/i })).toBeVisible();

    // Plans tab: the rendered price must come from the backend, not a literal.
    await page.getByTestId('admin-sub-tab-plans').click();
    const planCards = page.locator('[data-testid^="admin-sub-plan-"]');
    await expect.poll(async () => planCards.count()).toBeGreaterThan(0);

    const plans = (await (await page.request.get('/api/subscriptions/admin/plans')).json()).data
      .items as Array<{ code: string; priceMonthly: string; currencyCode: string; isActive: boolean }>;
    const first = plans[0];
    const card = page.getByTestId(`admin-sub-plan-${first.code}`);
    const expected = new Intl.NumberFormat('fr-TN', { style: 'currency', currency: first.currencyCode })
      .format(Number(first.priceMonthly));
    const normalize = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
    await expect.poll(async () => normalize(await card.innerText())).toContain(normalize(expected));

    // Subscriptions + invoices tabs render the subscription created above.
    await page.getByTestId('admin-sub-tab-subscriptions').click();
    await expect(page.getByTestId(`admin-sub-${subscriptionId}`)).toBeVisible();
    await page.getByTestId('admin-sub-tab-invoices').click();
    await expect(page.getByTestId(`admin-sub-invoice-${invoiceId}`)).toBeVisible();
  });

  test('toggling a plan activates/deactivates it server-side and back', async ({ page }) => {
    await page.goto('/admin/subscriptions');
    await page.getByTestId('admin-sub-tab-plans').click();

    const plans = (await (await page.request.get('/api/subscriptions/admin/plans')).json()).data
      .items as Array<{ code: string; isActive: boolean }>;
    const target = plans[0];
    const toggle = page.getByTestId(`admin-sub-plan-toggle-${target.code}`);
    await expect(toggle).toBeVisible();

    const before = target.isActive;
    await toggle.click();
    await expect(page.getByText(/تم تحديث حالة الخطة|Plan status updated/i).first()).toBeVisible();

    const afterBody = (await (await page.request.get('/api/subscriptions/admin/plans')).json()).data
      .items as Array<{ code: string; isActive: boolean }>;
    expect(afterBody.find((p) => p.code === target.code)!.isActive).toBe(!before);

    // Restore so the suite stays idempotent.
    await page.getByTestId(`admin-sub-plan-toggle-${target.code}`).click();
    await expect(page.getByText(/تم تحديث حالة الخطة|Plan status updated/i).first()).toBeVisible();
  });

  test('a real customer subscription and its invoice appear in the desk', async ({ page }) => {
    const { email, subscriptionId, invoiceId } = await createSubscribedCustomer('SMALL_MERCHANT');

    await page.goto('/admin/subscriptions');
    const subsRes = (await (await page.request.get('/api/subscriptions/admin/subscriptions')).json()).data
      .items as Array<{ id: string; userEmail: string | null }>;
    const row = subsRes.find((s) => s.id === subscriptionId);
    expect(row).toBeTruthy();
    expect(row!.userEmail).toBe(email);
    await expect(page.getByTestId(`admin-sub-${subscriptionId}`)).toContainText(email);

    await page.getByTestId('admin-sub-tab-invoices').click();
    await expect(page.getByTestId(`admin-sub-invoice-${invoiceId}`)).toContainText(email);
  });

  test('collecting a pending invoice settles it and the UI reflects PAID', async ({ page }) => {
    const { invoiceId } = await createSubscribedCustomer('SMALL_MERCHANT');

    await page.goto('/admin/subscriptions');
    await page.getByTestId('admin-sub-tab-invoices').click();
    const collect = page.getByTestId(`admin-sub-collect-${invoiceId}`);
    await expect(collect).toBeVisible();
    await collect.click();

    await expect(page.getByText(/تم تحصيل الفاتورة|Invoice collected/i).first()).toBeVisible();
    const afterBody = (await (await page.request.get('/api/subscriptions/admin/invoices')).json()).data
      .items as Array<{ id: string; status: string }>;
    expect(afterBody.find((i) => i.id === invoiceId)!.status).toBe('PAID');

    await page.getByTestId('admin-sub-tab-invoices').click();
    await expect(page.getByTestId(`admin-sub-invoice-${invoiceId}`)).toContainText('PAID');
  });

  test('dunning: pending queue is shown and the renewal rollover action runs', async ({ page }) => {
    const { invoiceId } = await createSubscribedCustomer('SMALL_MERCHANT');

    await page.goto('/admin/subscriptions');
    await page.getByTestId('admin-sub-tab-dunning').click();
    await expect(page.getByTestId(`admin-sub-pending-${invoiceId}`)).toBeVisible();

    await page.getByTestId('admin-sub-rollover').click();
    await expect(page.getByText(/تم تشغيل التجديد|Renewal rollover finished/i).first()).toBeVisible();
  });

  test('expiring lapsed subscriptions from the UI moves them to EXPIRED and the desk reflects it', async ({ page }) => {
    // Gap this guards: `admin-sub-expire` existed and was wired to
    // POST /api/subscriptions/admin/expire-lapsed, but no test ever clicked it —
    // the service had unit coverage yet the UI path (handler -> route -> service
    // -> DB -> reflection) was unproven. Time cannot be travelled through the
    // UI, so a real subscription is aged past its end exactly as the privacy
    // desk ages a retention window, then the sweep is driven from the browser.
    const { subscriptionId } = await createSubscribedCustomer('SMALL_MERCHANT');
    await expireSubscriptionInDb(subscriptionId);

    await page.goto('/admin/subscriptions');
    await expect(page.getByTestId(`admin-sub-${subscriptionId}`)).toContainText('ACTIVE');

    await page.getByTestId('admin-sub-tab-dunning').click();
    await page.getByTestId('admin-sub-expire').click();
    await expect(page.getByText(/تم إنهاء الاشتراكات المنتهية|Lapsed subscriptions expired/i).first()).toBeVisible();

    // The DB must hold the sweep's effect, not just a transient toast.
    await expect.poll(async () => {
      const subs = (await (await page.request.get('/api/subscriptions/admin/subscriptions')).json()).data
        .items as Array<{ id: string; status: string }>;
      return subs.find((s) => s.id === subscriptionId)?.status;
    }).toBe('EXPIRED');

    // And the desk row the admin sees mirrors it.
    await page.getByTestId('admin-sub-tab-subscriptions').click();
    await expect(page.getByTestId(`admin-sub-${subscriptionId}`)).toContainText('EXPIRED');
  });
});

test.describe('Admin subscriptions desk — RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is blocked from the UI desk and the admin API', async ({ page }) => {
    await page.goto('/admin/subscriptions');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();
    const res = await page.request.get('/api/subscriptions/admin/subscriptions');
    expect(res.status()).toBe(403);
  });
});
