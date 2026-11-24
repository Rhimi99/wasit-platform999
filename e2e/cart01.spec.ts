import { test, expect, DEMO_USERS, DEMO_PASSWORD, CONSENT_STORAGE_KEY, consentRecord } from './helpers';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * CART-01 — a real multi-product, multi-seller cart, driven through the UI.
 *
 * Every price, stock figure and total asserted here comes from the server; the
 * browser only holds product ids and quantities. Products are created through the
 * real API by the real demo seller accounts, and orders are read back from the
 * API — nothing is mocked or written behind the product's own paths.
 */

type OwnedEntity = { id: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; name: string };

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/**
 * The suite's own contexts are created here, so the consent decision the `page`
 * fixture seeds elsewhere has to be seeded explicitly: the banner is fixed at the
 * bottom of the viewport and would intercept clicks on the cart summary.
 */
async function newContext(
  browser: import('@playwright/test').Browser,
  options: { viewport: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean } = { viewport: DESKTOP },
): Promise<BrowserContext> {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch {
        /* about:blank */
      }
    },
    [CONSENT_STORAGE_KEY, JSON.stringify(consentRecord())] as const,
  );
  return ctx;
}

async function signIn(ctx: BrowserContext, email: string): Promise<void> {
  const res = await ctx.request.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } });
  expect(res.ok(), `login failed for ${email}: HTTP ${res.status()}`).toBeTruthy();
}

async function sellerContext(browser: import('@playwright/test').Browser, email: string): Promise<BrowserContext> {
  const ctx = await newContext(browser, { viewport: DESKTOP });
  await signIn(ctx, email);
  return ctx;
}

/** A published product owned by the signed-in seller, with real stock. */
async function seedProduct(
  ctx: BrowserContext,
  opts: { price?: string; stock?: number; name?: string } = {},
): Promise<{ productId: string; name: string; price: string }> {
  const entities = await ctx.request.get('/api/directory/my-entities');
  expect(entities.ok()).toBeTruthy();
  const seller = ((await entities.json()).data.items as OwnedEntity[])[0];
  expect(seller, 'the demo seller owns no seller entity').toBeTruthy();

  const cats = await ctx.request.get('/api/categories');
  const categoryId = ((await cats.json()).data as { id: string }[])[0].id;
  const sku = `E2E-CART-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const name = opts.name ?? `Cart ${sku}`;
  const price = opts.price ?? '10.0000';

  const created = await ctx.request.post('/api/products', {
    data: {
      sellerId: seller.id,
      sellerType: seller.sellerType,
      categoryId,
      name,
      sku,
      basePrice: price,
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: opts.stock ?? 25,
      lowStockThreshold: 2,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const productId = (await created.json()).data.id as string;

  const published = await ctx.request.patch(`/api/products/${productId}/status`, { data: { status: 'ACTIVE' } });
  expect(published.ok()).toBeTruthy();
  return { productId, name, price };
}

/** Adds the product to the cart from its own detail page (the real button). */
async function addToCart(page: Page, productId: string, quantity?: number): Promise<void> {
  await page.goto(`/products/${productId}`);
  if (quantity !== undefined) {
    await page.locator('input[type="number"]').first().fill(String(quantity));
  }
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('cart-added')).toBeVisible();
}

async function cartBadgeCount(page: Page): Promise<number> {
  const badge = page.getByTestId('cart-badge');
  if (await badge.count() === 0) return 0;
  return Number((await badge.first().innerText()).trim());
}

async function placeOrderFromCart(page: Page): Promise<{ orderId: string; body: Record<string, unknown> }> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST'),
    page.getByTestId('place-order').click(),
  ]);
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()).data as { orderId: string } & Record<string, unknown>;
  return { orderId: body.orderId, body };
}

async function readOrder(api: APIRequestContext, orderId: string) {
  const res = await api.get(`/api/orders/${orderId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data as {
    buyerType: string;
    itemsTotal: string;
    grandTotal: string;
    currencyCode: string;
    items: Array<{ productId: string; quantity: number; unitPrice: string }>;
    sellerOrders: Array<{ sellerId: string; itemsTotal: string; status: string }>;
  };
}

async function countMyOrders(api: APIRequestContext): Promise<number> {
  const res = await api.get('/api/orders');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()).data as unknown[]).length;
}

test.describe('CART-01 — multi-product cart', () => {
  test('two sellers, three lines: one order, two suborders, server totals', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const supplier = await sellerContext(browser, DEMO_USERS.supplier);
    const a = await seedProduct(merchant, { price: '10.0000' });
    const b = await seedProduct(merchant, { price: '4.5000' });
    const c = await seedProduct(supplier, { price: '20.0000' });

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();

    await addToCart(page, a.productId);
    await addToCart(page, b.productId);
    await addToCart(page, c.productId);
    await expect.poll(() => cartBadgeCount(page)).toBe(3);

    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(3);
    // Two sellers, priced by the server: 10 + 4.5 + 20.
    await expect(page.getByTestId('cart-seller-count')).toHaveText('2');
    await expect(page.getByTestId('cart-items-total')).toHaveAttribute('data-value', '34.5000');
    const grand = await page.getByTestId('cart-grand-total').getAttribute('data-value');

    await page.getByTestId('cart-checkout').click();
    await expect(page).toHaveURL(/checkout\?cart=1/);
    await expect(page.getByTestId('checkout-seller-group')).toHaveCount(2);
    await expect(page.getByTestId('checkout-quote-totals')).toHaveAttribute('data-items-total', '34.5000');

    const { orderId } = await placeOrderFromCart(page);
    const order = await readOrder(buyer.request, orderId);
    expect(order.sellerOrders).toHaveLength(2);
    expect(new Set(order.sellerOrders.map((s) => s.sellerId)).size).toBe(2);
    expect(order.items).toHaveLength(3);
    expect(order.itemsTotal).toBe('34.5000');
    expect(grand).toBe(order.grandTotal);

    // The cart is emptied by a successful order.
    await page.goto('/cart');
    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect.poll(() => cartBadgeCount(page)).toBe(0);

    await buyer.close();
    await merchant.close();
    await supplier.close();
  });

  test('quantities and removal update the server total', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant, { price: '8.0000', stock: 40 });

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();
    await addToCart(page, product.productId);

    await page.goto('/cart');
    await expect(page.getByTestId('cart-items-total')).toHaveAttribute('data-value', '8.0000');
    await page.getByTestId('cart-line-qty').fill('3');
    await expect(page.getByTestId('cart-items-total')).toHaveAttribute('data-value', '24.0000');
    // The grand total is the items total plus the buyer's commission share, and
    // it is the server's number, not a multiplication done in the browser.
    const grand = await page.getByTestId('cart-grand-total').getAttribute('data-value');
    expect(Number(grand)).toBeGreaterThanOrEqual(24);

    await page.getByTestId('cart-line-remove').click();
    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect.poll(() => cartBadgeCount(page)).toBe(0);

    await buyer.close();
    await merchant.close();
  });

  test('the cart survives a reload and a navigation', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant);

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();
    await addToCart(page, product.productId);
    await expect.poll(() => cartBadgeCount(page)).toBe(1);

    await page.goto('/marketplace');
    await page.reload();
    await expect.poll(() => cartBadgeCount(page)).toBe(1);

    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByTestId('cart-line')).toContainText(product.name);

    await buyer.close();
    await merchant.close();
  });

  test('a product taken off sale is flagged and blocks checkout', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant);

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();
    await addToCart(page, product.productId);

    // The seller withdraws the product while it sits in the buyer's cart.
    const off = await merchant.request.patch(`/api/products/${product.productId}/status`, { data: { status: 'INACTIVE' } });
    expect(off.ok()).toBeTruthy();

    await page.goto('/cart');
    await expect(page.getByTestId('cart-line-issue')).toBeVisible();
    await expect(page.getByTestId('cart-line-issue')).toHaveAttribute('data-code', 'PRODUCT_UNAVAILABLE');
    await expect(page.getByTestId('cart-issues')).toBeVisible();
    await expect(page.getByTestId('cart-checkout')).toHaveAttribute('aria-disabled', 'true');

    await buyer.close();
    await merchant.close();
  });

  test('an out-of-stock line is reported with the free quantity', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant, { stock: 2 });

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();
    await addToCart(page, product.productId, 5);

    await page.goto('/cart');
    const issue = page.getByTestId('cart-line-issue');
    await expect(issue).toBeVisible();
    await expect(issue).toHaveAttribute('data-code', 'INSUFFICIENT_STOCK');
    await expect(issue).toContainText('2');
    await expect(page.getByTestId('cart-checkout')).toHaveAttribute('aria-disabled', 'true');

    await buyer.close();
    await merchant.close();
  });

  test('a repeated click places exactly one order', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant, { stock: 20 });

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const before = await countMyOrders(buyer.request);
    const page = await buyer.newPage();
    await addToCart(page, product.productId);

    let posts = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/orders') && req.method() === 'POST') posts += 1;
    });

    await page.goto('/checkout?cart=1');
    const button = page.getByTestId('place-order');
    await expect(button).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST'),
      // Two clicks in the same tick: the button disables itself after the first,
      // and the idempotency key covers any request that still gets through.
      button.click().then(() => button.click({ force: true, timeout: 500 }).catch(() => undefined)),
    ]);
    expect(response.status()).toBe(201);

    await expect(page.getByRole('status').first()).toBeVisible();
    expect(posts).toBe(1);
    expect(await countMyOrders(buyer.request)).toBe(before + 1);

    await buyer.close();
    await merchant.close();
  });

  test('an individual and a company buyer both check out from the same cart', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant, { price: '15.0000' });

    // Individual
    const customer = await newContext(browser, { viewport: DESKTOP });
    await signIn(customer, DEMO_USERS.customer);
    const customerPage = await customer.newPage();
    await addToCart(customerPage, product.productId);
    await customerPage.goto('/checkout?cart=1');
    await expect(customerPage.getByTestId('buyer-identity')).toHaveCount(0);
    const individual = await placeOrderFromCart(customerPage);
    expect((await readOrder(customer.request, individual.orderId)).buyerType).toBe('CUSTOMER');

    // Company
    const company = await newContext(browser, { viewport: DESKTOP });
    await signIn(company, DEMO_USERS.company);
    const companyPage = await company.newPage();
    await addToCart(companyPage, product.productId);
    await companyPage.goto('/checkout?cart=1');
    await expect(companyPage.getByTestId('buyer-type-company')).toBeChecked();
    const corporate = await placeOrderFromCart(companyPage);
    expect((await readOrder(company.request, corporate.orderId)).buyerType).toBe('COMPANY');

    await customer.close();
    await company.close();
    await merchant.close();
  });

  test('a guest can build a cart, and it is kept through sign-in', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant);

    const guest = await newContext(browser, { viewport: DESKTOP });
    const page = await guest.newPage();
    await addToCart(page, product.productId);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-guest-note')).toBeVisible();
    await expect(page.getByTestId('cart-checkout')).toHaveAttribute('aria-disabled', 'true');

    await signIn(guest, DEMO_USERS.customer);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByTestId('cart-items-total')).toHaveAttribute('data-value', '10.0000');

    await guest.close();
    await merchant.close();
  });

  test('the cart works on a phone viewport without horizontal overflow', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const a = await seedProduct(merchant, { price: '6.0000' });
    const b = await seedProduct(merchant, { price: '9.0000' });

    const buyer = await newContext(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();

    await addToCart(page, a.productId);
    await addToCart(page, b.productId);
    await page.goto('/cart');

    await expect(page.getByTestId('cart-line')).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'the cart page must not scroll horizontally on a phone').toBeLessThanOrEqual(1);

    await page.getByTestId('cart-line-qty').first().fill('2');
    await expect(page.getByTestId('cart-items-total')).toHaveAttribute('data-value', '21.0000');

    await page.getByTestId('cart-checkout').click();
    await expect(page.getByTestId('checkout-seller-group')).toHaveCount(1);
    const { orderId } = await placeOrderFromCart(page);
    const order = await readOrder(buyer.request, orderId);
    expect(order.items).toHaveLength(2);

    await buyer.close();
    await merchant.close();
  });

  test('the single-product checkout still works and the cart link does not disturb it', async ({ browser }) => {
    const merchant = await sellerContext(browser, DEMO_USERS.merchant);
    const product = await seedProduct(merchant, { price: '11.0000' });

    const buyer = await newContext(browser, { viewport: DESKTOP });
    await signIn(buyer, DEMO_USERS.customer);
    const page = await buyer.newPage();

    await page.goto(`/checkout?productId=${product.productId}`);
    await expect(page.getByTestId('commission-pending')).toBeVisible();
    await expect(page.getByTestId('checkout-cart')).toHaveCount(0);

    const { orderId } = await placeOrderFromCart(page);
    const order = await readOrder(buyer.request, orderId);
    expect(order.items).toHaveLength(1);
    expect(order.itemsTotal).toBe('11.0000');

    await buyer.close();
    await merchant.close();
  });
});
