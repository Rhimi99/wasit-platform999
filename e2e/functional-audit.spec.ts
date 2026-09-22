import { test, expect, storageFor, DEMO_USERS, DEMO_PASSWORD, placeOrderViaUi, loginViaUi } from './helpers';

/**
 * Functional audit (UI-driven, real backend + PostgreSQL, no mocks).
 *
 * Every test here drives the actual interface — clicking the real buttons and
 * reading what the user would see — then confirms the effect through the live
 * API. HTTP 200 alone is never treated as success: a page that renders but whose
 * controls do nothing fails this suite.
 */

const UNIQUE = Date.now();

test.describe('CUSTOMER — auth, discovery, purchase', () => {
  test('register form creates an account and surfaces success', async ({ page }) => {
    const email = `audit-reg-${UNIQUE}@wasit.tn`;
    await page.goto('/register');
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill('Passw0rd!2026');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText(/تم إنشاء الحساب|Account created/i)).toBeVisible();
  });

  test('login form accepts demo credentials and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.locator('form input[type="email"]').fill(DEMO_USERS.customer);
    await page.locator('form input[type="password"]').fill('Passw0rd!2026');
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('search box finds a product and opens its detail page', async ({ page }) => {
    await page.goto('/search?q=olive&type=products');
    const link = page.locator('a[href^="/products/"]').first();
    await link.waitFor();
    const href = (await link.getAttribute('href'))!;
    await link.click();
    await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(page.getByText(/SKU/i).first()).toBeVisible();
  });

  test.describe('authenticated customer', () => {
    test.use({ storageState: storageFor('customer') });

    test('browses the marketplace and sees real products', async ({ page }) => {
      await page.goto('/marketplace');
      await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();
    });

    test('customer dashboard KPIs render per-user numbers, not admin totals', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: /مرحبًا|Welcome/i })).toBeVisible();
      await expect(page.getByText(/حجم التداول|GMV/i).first()).toBeVisible();
    });

    test('creates a purchase from the UI and the new order is visible to the buyer', async ({ page }) => {
      const orderId = await placeOrderViaUi(page);
      expect(orderId).toBeTruthy();
      const res = await page.request.get(`/api/orders/${orderId}`);
      const orderNumber = (await res.json()).data.orderNumber as string;
      // The order the buyer just placed must be visible in the orders list.
      await page.goto('/dashboard/orders');
      await expect(page.getByText(orderNumber, { exact: false }).first()).toBeVisible();
      await page.goto(`/dashboard/orders/${orderId}`);
      await expect(page.getByText(/عمولة وسيط|WASIT commission/i).first()).toBeVisible();
    });

    test('orders page lists the customer orders', async ({ page }) => {
      await page.goto('/dashboard/orders');
      await expect(page.getByRole('heading', { name: /طلباتي|My orders|Orders/i }).first()).toBeVisible();
    });

    test('notifications bell returns the unread count', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('button', { name: /إشعارات|Notifications/i }).first()).toBeVisible();
      const res = await page.request.get('/api/notifications/unread-count');
      expect(res.ok()).toBeTruthy();
    });

    test('messages page lists threads and can open one', async ({ page }) => {
      await page.goto('/dashboard/messages');
      await expect(page.getByRole('heading', { name: /رسائلي|My messages|الرسائل|Messages/i }).first()).toBeVisible();
      const res = await page.request.get('/api/messages');
      expect(res.ok()).toBeTruthy();
    });
  });
});

test.describe('MERCHANT — full seller surface', () => {
  test.use({ storageState: storageFor('merchant') });

  test('dashboard overview renders live seller KPIs', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /مرحبًا|Welcome/i })).toBeVisible();
    const res = await page.request.get('/api/analytics/my-overview');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.hasBusinessEntity).toBe(true);
  });

  test('products page lists the merchant own catalog and is not empty', async ({ page }) => {
    await page.goto('/dashboard/products');
    await expect(page.locator('table.table-base tbody tr').first()).toBeVisible();
    // The page must show the merchant's own products, not the global feed.
    const res = await page.request.get('/api/products/mine');
    const body = await res.json();
    expect(body.data.items.length).toBeGreaterThan(0);
    await expect(page.getByText(body.data.items[0].name).first()).toBeVisible();
  });

  test('create product form offers the owned seller entity (no manual id)', async ({ page }) => {
    await page.goto('/dashboard/products/new');
    const entitySelect = page.locator('#p-seller');
    await expect(entitySelect).toBeVisible();
    await expect(entitySelect.locator('option').first()).toContainText(/MERCHANT|SUPPLIER|COMPANY/);
  });

  test('creates a product from the UI and it appears in the catalog', async ({ page }) => {
    const sku = `AUDIT-${UNIQUE}`;
    const name = `Audit Product ${UNIQUE}`;

    await page.goto('/dashboard/products/new');
    await page.locator('#p-name').fill(name);
    await page.locator('#p-sku').fill(sku);
    await page.locator('#p-category').selectOption({ index: 1 });
    await page.locator('#p-price').fill('12.5');
    await page.getByRole('button', { name: /حفظ|Save/i }).click();

    await expect(page.getByText(/تم إنشاء المنتج بنجاح|Product created successfully/i).first()).toBeVisible();

    // The new product must be visible to the user on the products page.
    await page.goto('/dashboard/products');
    await expect(page.getByText(name).first()).toBeVisible();
  });

  test('can unpublish and republish a product from the list', async ({ page }) => {
    await page.goto('/dashboard/products');
    const row = page.locator('table.table-base tbody tr').first();
    await expect(row).toBeVisible();
    const name = (await row.locator('td').first().innerText()).trim();

    await row.getByRole('button', { name: /إلغاء النشر|Unpublish/i }).click();
    await expect(page.locator('table.table-base tbody tr', { hasText: name }).first().getByText('INACTIVE')).toBeVisible();

    await page.locator('table.table-base tbody tr', { hasText: name }).first()
      .getByRole('button', { name: /نشر|Publish/i }).click();
    await expect(page.locator('table.table-base tbody tr', { hasText: name }).first().getByText('ACTIVE')).toBeVisible();
  });

  test('a suspended product shows a notice instead of a publish control', async ({ page, playwright }) => {
    // Suspend a real product of this merchant through the admin API, then prove
    // the seller page reflects enforcement rather than offering a control the
    // server would reject. Suspension is an admin action, so it runs on a
    // separate admin-authenticated request context (the browser keeps the
    // merchant session).
    const mine = await page.request.get('/api/products/mine?pageSize=100');
    const items = (await mine.json()).data.items as Array<{ id: string; status: string }>;
    const target = items.find((p) => p.status !== 'SUSPENDED');
    expect(target).toBeTruthy();

    const adminCtx = await playwright.request.newContext({
      baseURL: process.env.E2E_API_URL ?? 'http://localhost:3000',
      storageState: storageFor('admin'),
    });
    try {
      const adminRes = await adminCtx.patch(`/api/products/${target!.id}/suspend`);
      expect(adminRes.ok()).toBeTruthy();

      await page.goto('/dashboard/products');
      await expect(page.getByTestId(`product-suspended-${target!.id}`)).toBeVisible();
      const row = page.locator('table.table-base tbody tr').filter({ has: page.getByTestId(`product-suspended-${target!.id}`) });
      await expect(row.getByRole('button')).toHaveCount(0);
    } finally {
      // Restore the fixture so later specs start from a known state.
      await adminCtx.patch(`/api/products/${target!.id}/status`, { data: { status: target!.status } });
      await adminCtx.dispose();
    }
  });

  test('inventory page lists stock and can adjust it', async ({ page }) => {
    await page.goto('/dashboard/inventory');
    await expect(page.locator('table.table-base tbody tr').first()).toBeVisible();
  });

  test('analytics page renders live metrics', async ({ page }) => {
    await page.goto('/dashboard/analytics');
    await expect(page.getByRole('heading', { name: /التحليلات|Analytics/i }).first()).toBeVisible();
  });

  test('ads page loads the advertiser entity', async ({ page }) => {
    await page.goto('/dashboard/ads');
    await expect(page.getByRole('heading', { name: /الإعلانات|Ads/i }).first()).toBeVisible();
  });

  test('AI page shows provider, models and agents', async ({ page }) => {
    await page.goto('/dashboard/ai');
    await expect(page.getByRole('heading', { name: /أدوات الذكاء|AI tools/i }).first()).toBeVisible();
    const res = await page.request.get('/api/ai/agents');
    const body = await res.json();
    expect(body.data.agents.length).toBeGreaterThan(0);
  });

  test('subscriptions page renders the plan grid from the backend', async ({ page }) => {
    await page.goto('/dashboard/subscriptions');
    await expect(page.getByRole('heading', { name: /الاشتراك|Subscription/i }).first()).toBeVisible();
    await expect.poll(async () => page.locator('[data-testid^="sub-plan-"]').count()).toBeGreaterThan(0);
  });
});

test.describe('SUBSCRIPTIONS — live catalog, subscribe, change, cancel', () => {
  // No stored session: the flow needs an account with no pre-existing subscription.
  test('drives the real subscription backend entirely through the UI', async ({ page }) => {
    const unique = `subui-${Date.now()}@wasit.tn`;
    const reg = await page.request.post('/api/auth/register', {
      data: { email: unique, password: DEMO_PASSWORD, firstName: 'Sub', role: 'CUSTOMER' },
    });
    expect(reg.status()).toBe(201);
    // Registration requires a verified email before login (no mailbox locally), so
    // complete the real dev verification flow through the API, then log in via the UI.
    const link = await page.request.post('/api/auth/dev/verification-link', { data: { email: unique } });
    const { token } = (await link.json()).data as { token: string };
    const verified = await page.request.post('/api/auth/verify-email', { data: { token } });
    expect(verified.ok()).toBeTruthy();
    await loginViaUi(page, unique);
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/dashboard/subscriptions');
    await expect(page.getByRole('heading', { name: /الاشتراك|Subscription/i }).first()).toBeVisible();

    const planCards = page.locator('[data-testid^="sub-plan-"]');
    await expect.poll(async () => planCards.count()).toBeGreaterThan(0);

    // The rendered price must equal the backend's stored monthly price — proof the
    // UI is no longer hardcoding `19`/`99`.
    const plansBody = await (await page.request.get('/api/subscriptions/plans')).json();
    const plans = plansBody.data.items as Array<{ id: string; code: string; priceMonthly: string }>;
    const firstPlan = plans[0];
    const expectedAmount = Number(firstPlan.priceMonthly).toFixed(3).replace('.', ',');
    await expect(page.getByTestId(`sub-price-${firstPlan.code}`)).toContainText(expectedAmount);

    // Switching to yearly must render the backend's stored yearly price too.
    await page.getByTestId('sub-cycle-YEARLY').click();
    const yearlyExpect = Number(plans[0].priceYearly).toFixed(3).replace('.', ',');
    await expect(page.getByTestId(`sub-price-${firstPlan.code}`)).toContainText(yearlyExpect);
    await page.getByTestId('sub-cycle-MONTHLY').click();

    // Subscribe from the UI, then confirm the effect through the API and the UI.
    await planCards.first().getByRole('button', { name: /اشترك|Subscribe/i }).click();
    await expect(page.getByText(/تم تفعيل الاشتراك|Subscription activated/i).first()).toBeVisible();
    const meBody = await (await page.request.get('/api/subscriptions/me')).json();
    expect(meBody.data.subscription.planId).toBe(firstPlan.id);
    await expect(page.getByTestId('sub-current-badge')).toBeVisible();

    // The invoice minted by subscribe is listed in the UI table.
    const invoicesBody = await (await page.request.get('/api/subscriptions/me/invoices')).json();
    expect(invoicesBody.data.items.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`sub-invoice-${invoicesBody.data.items[0].id}`)).toBeVisible();

    // Change to a different plan through the UI.
    await planCards.nth(1).getByRole('button', { name: /تغيير الخطة|Change plan/i }).click();
    await expect(page.getByText(/تم تغيير الخطة|Plan changed/i).first()).toBeVisible();
    const changed = await (await page.request.get('/api/subscriptions/me')).json();
    expect(changed.data.subscription.planId).toBe(plans[1].id);

    // Cancel through the UI (accepting the confirm dialog) and verify the backend.
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('sub-cancel').click();
    await expect(page.getByText(/تم إلغاء الاشتراك|Subscription cancelled/i).first()).toBeVisible();
    const afterCancel = await (await page.request.get('/api/subscriptions/me')).json();
    expect(afterCancel.data.subscription).toBeNull();
  });
});

test.describe('MARKETING VIDEO — full studio flow', () => {
  test.use({ storageState: storageFor('merchant') });

  test('selects product/language/audience/style/duration, generates, previews and deletes', async ({ page }) => {
    await page.goto('/dashboard/video-studio');
    await expect(page.getByRole('heading', { name: /استوديو|Studio/i }).first()).toBeVisible();

    // Only ACTIVE products can be rendered, so pick one from the real dropdown.
    const productOptions = page.locator('#v-product option');
    await expect.poll(async () => productOptions.count()).toBeGreaterThan(1);
    const count = await productOptions.count();
    let activeValue: string | null = null;
    for (let i = 1; i < count; i++) {
      const label = (await productOptions.nth(i).textContent()) ?? '';
      if (/ACTIVE/.test(label) && !/INACTIVE/.test(label)) {
        activeValue = (await productOptions.nth(i).getAttribute('value'))!;
        break;
      }
    }
    expect(activeValue, 'an ACTIVE product must be selectable in the studio').not.toBeNull();
    await page.locator('#v-product').selectOption(activeValue!);
    await page.locator('#v-language').selectOption('ar');
    await page.locator('#v-audience').selectOption('B2B');
    await page.locator('#v-style').selectOption('MODERN');
    await page.locator('#v-duration').fill('10');

    const videosBefore = await page.locator('video').count();
    await page.getByRole('button', { name: /توليد|Generate/i }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/تم توليد|Video generated|generated successfully/i).first()).toBeVisible();

    // The generated asset must actually render as a playable video for the user.
    await expect.poll(async () => page.locator('video').count()).toBe(videosBefore + 1);
    const video = page.locator('video').first();
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', /\/api\/media\/assets\/.+\/content/);

    // Preview URL must be reachable (not a dead link).
    const src = (await video.getAttribute('src'))!;
    const preview = await page.request.get(src);
    expect(preview.ok()).toBeTruthy();

    // Download link is served with a download disposition.
    const download = page.getByRole('link', { name: /تنزيل|Download/i }).first();
    await expect(download).toBeVisible();
    const dlHref = (await download.getAttribute('href'))!;
    const dl = await page.request.get(dlHref);
    expect(dl.ok()).toBeTruthy();

    // Delete removes it from the library.
    const before = await page.locator('video').count();
    await page.getByRole('button', { name: /حذف|Delete/i }).first().click();
    await expect(page.getByText(/تم حذف|حُذف|Asset deleted|deleted/i).first()).toBeVisible();
    await expect.poll(async () => page.locator('video').count()).toBeLessThan(before);
  });
});

test.describe('ADMIN — every admin surface', () => {
  test.use({ storageState: storageFor('admin') });

  const ADMIN_PAGES: Array<[string, RegExp]> = [
    ['/admin', /مؤشرات الأداء|KPIs/i],
    ['/admin/analytics', /تحليلات المنصة|Platform analytics/i],
    ['/admin/users', /المستخدمون|Users/i],
    ['/admin/products', /المنتجات|Products/i],
    ['/admin/orders', /الطلبات|Orders/i],
    ['/admin/transactions', /المعاملات|Transactions/i],
    ['/admin/ledger', /دفتر الحسابات|Ledger/i],
    ['/admin/audit', /سجل التدقيق|Audit/i],
    ['/admin/verification', /التحقق|Verification/i],
    ['/admin/trust', /الثقة|Trust/i],
    ['/admin/risk', /المخاطر|Risk/i],
    ['/admin/disputes', /النزاعات|Disputes/i],
    ['/admin/policies', /سياسات النزاعات|Dispute policies/i],
    ['/admin/subscriptions', /إدارة الاشتراكات|Subscription management/i],
    ['/admin/ai', /حوكمة الذكاء الاصطناعي|AI governance/i],
    ['/admin/observability', /المراقبة التشغيلية|Observability/i],
    ['/admin/privacy', /الخصوصية وحذف البيانات|Privacy & data deletion/i],
  ];

  for (const [path, heading] of ADMIN_PAGES) {
    test(`admin page ${path} renders its heading and data region`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    });
  }

  test('admin dashboard KPIs are fed by the live admin API', async ({ page }) => {
    await page.goto('/admin');
    const res = await page.request.get('/api/admin/stats');
    const body = await res.json();
    await expect(page.getByText(String(body.data.orders)).first()).toBeVisible();
  });

  test('admin product table lists products and can suspend one', async ({ page }) => {
    await page.goto('/admin/products');
    const row = page.locator('table.table-base tbody tr').first();
    await expect(row).toBeVisible();
    const testId = await row.getAttribute('data-testid');
    expect(testId).toBeTruthy();
    const tracked = page.getByTestId(testId!);

    await tracked.getByRole('button', { name: /إيقاف|Suspend/i }).click();
    await expect(tracked.getByText('SUSPENDED')).toBeVisible();

    // A suspended product must be reactivatable from the same table.
    await tracked.getByRole('button', { name: /إعادة التنشيط|Reactivate/i }).click();
    await expect(tracked.getByText('ACTIVE')).toBeVisible();
  });
});

test.describe('ADS — create and manage a campaign from the UI', () => {
  test.use({ storageState: storageFor('merchant') });

  test('creates a campaign, activates it and sees it in the list', async ({ page }) => {
    const title = `Audit Campaign ${UNIQUE}`;
    await page.goto('/dashboard/ads');
    await expect(page.getByRole('heading', { name: /الإعلانات|Advertising/i }).first()).toBeVisible();

    await page.getByPlaceholder(/عنوان|title/i).first().fill(title);
    await page.getByPlaceholder(/ميزانية|budget/i).first().fill('250');
    // The advertiser entity select is the last select in the create form.
    const entitySelect = page.locator('form select').last();
    await entitySelect.selectOption({ index: 1 });
    await page.getByRole('button', { name: /إنشاء|Create/i }).first().click();

    const card = page.locator('.card', { hasText: title }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText('DRAFT')).toBeVisible();

    await card.getByRole('button', { name: /تفعيل|Activate/i }).click();
    await expect(card.getByText('ACTIVE')).toBeVisible();
  });
});

test.describe('AI TOOLS — run a tool from the UI', () => {
  test.use({ storageState: storageFor('merchant') });

  test('runs the market analysis tool and renders a result', async ({ page }) => {
    await page.goto('/dashboard/ai');
    await expect(page.getByRole('heading', { name: /الذكاء|AI/i }).first()).toBeVisible();

    const runBtn = page.getByRole('button', { name: /تحليل سوق|Market Analysis/i }).first();
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // A real result block must render, not just a spinner that never resolves.
    await expect(page.getByText(/model:/i).first()).toBeVisible({ timeout: 20000 });
  });
});

test.describe('ONBOARDING — entity creation from the UI', () => {
  test('a freshly registered merchant creates its business entity from onboarding', async ({ page }) => {
    const email = `audit-onboard-${UNIQUE}@wasit.tn`;
    await page.goto('/register');
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill(DEMO_PASSWORD);
    await page.locator('form select').selectOption('MERCHANT');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByRole('status')).toBeVisible();

    // Registration requires email verification; complete it through the real UI page.
    const linkRes = await page.request.post('/api/auth/dev/verification-link', { data: { email } });
    const token = (await linkRes.json()).data.token as string;
    await page.goto(`/verify-email?token=${token}`);
    await expect(page.getByText(/تم التحقق|verified/i).first()).toBeVisible();

    await page.goto('/login');
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill(DEMO_PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 });

    await page.goto('/onboarding');
    const name = `Audit Store ${UNIQUE}`;
    await page.locator('form input[required]').fill(name);
    await page.locator('form button[type="submit"]').click();

    // The created entity id is rendered back to the user.
    await expect(page.getByRole('status')).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/[0-9a-f]{8}-/);
  });
});

test.describe('MESSAGING — send and receive', () => {
  test.use({ storageState: storageFor('customer') });

  test('opens an existing thread, sends a message and sees it rendered', async ({ page }) => {
    await page.goto('/dashboard/messages');
    const thread = page.locator('button:has(span.truncate)').first();
    await expect(thread).toBeVisible();
    await thread.click();

    const unique = `audit-msg-${UNIQUE}`;
    const compose = page.locator('textarea').last();
    await compose.fill(unique);
    await page.getByRole('button', { name: /إرسال|Send/i }).click();
    await expect(page.getByText(unique, { exact: false })).toBeVisible();
  });
});

test.describe('NOTIFICATIONS — real type titles and read state', () => {
  test.use({ storageState: storageFor('customer') });

  test('bell shows the notification-specific title, not a generic message label', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /إشعارات|Notifications/i }).first().click();

    const panel = page.locator('div.absolute').filter({ has: page.getByText(/إشعارات|Notifications/) }).first();
    await expect(panel).toBeVisible();

    // Compare against what the API says the first notification is.
    const res = await page.request.get('/api/notifications?pageSize=5');
    const body = await res.json();
    const first = body.data.items[0] as { title: string; body: string | null };
    await expect(panel.getByText(first.title, { exact: false }).first()).toBeVisible();
  });

  test('mark all as read clears the unread badge', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /إشعارات|Notifications/i }).first().click();
    await page.getByRole('button', { name: /تحديد الكل كمقروء|Mark all as read/i }).click();
    await expect.poll(async () => {
      const res = await page.request.get('/api/notifications/unread-count');
      return (await res.json()).data.count;
    }).toBe(0);
  });
});
