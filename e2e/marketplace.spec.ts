import { test, expect, loginViaUi, storageFor, DEMO_USERS, placeOrderViaUi } from './helpers';

/**
 * Core marketplace slice against the REAL backend + PostgreSQL:
 * Home → Marketplace → Search → Product Details → Checkout → Order → Commission.
 * No route interception, no fixtures — every assertion reads live API data.
 */

test.describe('Public discovery (no auth)', () => {
  test('home renders and exposes the marketplace entry point', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /السوق|Marketplace/i }).first()).toBeVisible();
  });

  test('marketplace lists real seeded products', async ({ page }) => {
    await page.goto('/marketplace');
    await expect(page.getByRole('heading', { name: /السوق|Marketplace/i }).first()).toBeVisible();
    await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();
  });

  test('search finds a seeded product and opens its live detail page', async ({ page }) => {
    await page.goto('/search?q=olive&type=products');
    const productLink = page.locator('a[href^="/products/"]').first();
    await expect(productLink).toBeVisible();
    const href = (await productLink.getAttribute('href'))!;

    await productLink.click();
    await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(page.getByText(/رمز المنتج \(SKU\)|SKU/i).first()).toBeVisible();
  });

  test('supplier directory lists real suppliers', async ({ page }) => {
    await page.goto('/suppliers');
    await expect(page.locator('a[href^="/suppliers/"]').first()).toBeVisible();
  });
});

test.describe('Registration', () => {
  test('a new account is created through the real API', async ({ page }) => {
    const email = `e2e-reg-${Date.now()}@wasit.tn`;
    await page.goto('/register');
    await page.locator('form input[type="email"]').fill(email);
    await page.locator('form input[type="password"]').fill('Passw0rd!2026');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText(/تم إنشاء الحساب|Account created/i)).toBeVisible();
  });
});

test.describe('Guest access control', () => {
  test('checkout requires authentication', async ({ page }) => {
    await page.goto('/checkout?productId=none');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Auth-gated commerce (customer session)', () => {
  test.use({ storageState: storageFor('customer') });

  test('customer orders a real product and sees the server-side commission', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);

    // The order detail page renders the server-computed commission split (base
    // 4% = 2% seller + 2% buyer) from the Commission Engine, never a client number.
    await page.goto(`/dashboard/orders/${orderId}`);
    await expect(page.getByText(/عمولة وسيط|WASIT commission/i).first()).toBeVisible();

    const ordersRes = await page.request.get(`/api/orders/${orderId}`);
    expect(ordersRes.ok()).toBeTruthy();
    const order = (await ordersRes.json()).data as {
      itemsTotal: string;
      commission: string;
      buyerCommission: string;
    };
    // Total commission is 4% of the ordered value, split evenly.
    const expectedTotal = (Number(order.itemsTotal) * 0.04).toFixed(4);
    expect(Number(order.commission)).toBeCloseTo(Number(expectedTotal), 4);
    const expectedBuyer = (Number(order.itemsTotal) * 0.02).toFixed(4);
    expect(Number(order.buyerCommission)).toBeCloseTo(Number(expectedBuyer), 4);
  });

  test('an order below MOQ is refused by the backend and surfaced in the UI', async ({ page }) => {
    await page.goto('/marketplace');
    const links = page.locator('a[href^="/products/"]');
    await links.first().waitFor();
    const count = await links.count();

    let moqProduct = '';
    for (let i = 0; i < count; i++) {
      const href = (await links.nth(i).getAttribute('href'))!;
      const res = await page.request.get(`/api/products/${href.split('/').pop()}`);
      const body = await res.json();
      if (body?.data?.moq && body.data.moq > 1) {
        moqProduct = href;
        break;
      }
    }
    expect(moqProduct).not.toBe('');

    await page.goto(moqProduct);
    await page.getByRole('link', { name: /اطلب|Order/i }).first().click();
    await page.locator('input[type="number"]').first().fill('1');
    await page.getByRole('button', { name: /إتمام الطلب|Place order/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});

test.describe('Logout', () => {
  test('customer signs out via the form and the session is invalidated', async ({ page }) => {
    await loginViaUi(page, DEMO_USERS.customer);
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole('button', { name: /تسجيل الخروج|Sign out/i }).click();
    await expect(page).toHaveURL('/');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});