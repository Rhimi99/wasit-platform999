import { test, expect, DEMO_USERS, DEMO_PASSWORD } from './helpers';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

/**
 * ORDER-01 — the buyer identity chosen in checkout must reach the order row.
 *
 * Driven through the real UI and the real backend: a company buyer places an
 * order from `/checkout`, then the order is read back from the API and must
 * carry `buyerType: 'COMPANY'` with the buyer's own company attached. An
 * individual order must stay `CUSTOMER`. Nothing is mocked and no order row is
 * written outside the product's own path.
 */

type OwnedEntity = { id: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; name: string };

async function signIn(ctx: BrowserContext, email: string): Promise<void> {
  const res = await ctx.request.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } });
  expect(res.ok(), `login failed for ${email}: HTTP ${res.status()}`).toBeTruthy();
}

/** A merchant-owned, published product with stock, created through the real API. */
async function seedPurchasableProduct(ctx: BrowserContext): Promise<string> {
  const entities = await ctx.request.get('/api/directory/my-entities');
  expect(entities.ok()).toBeTruthy();
  const merchant = ((await entities.json()).data.items as OwnedEntity[])
    .find((e) => e.sellerType === 'MERCHANT');
  expect(merchant, 'the demo merchant owns no merchant entity').toBeTruthy();

  const cats = await ctx.request.get('/api/categories');
  const categoryId = ((await cats.json()).data as { id: string }[])[0].id;
  const sku = `E2E-BI-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const created = await ctx.request.post('/api/products', {
    data: {
      sellerId: merchant!.id,
      sellerType: 'MERCHANT',
      categoryId,
      name: `Buyer Identity ${sku}`,
      sku,
      basePrice: '12.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 20,
      lowStockThreshold: 2,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const productId = (await created.json()).data.id as string;

  const published = await ctx.request.patch(`/api/products/${productId}/status`, { data: { status: 'ACTIVE' } });
  expect(published.ok()).toBeTruthy();
  return productId;
}

/** Places the order on the checkout page the test already opened. */
async function placeOrderFromCheckout(
  page: import('@playwright/test').Page,
): Promise<{ orderId: string; body: Record<string, unknown> }> {
  const placeBtn = page.getByRole('button', { name: /إتمام الطلب|Place order|Passer la commande/i }).first();
  await expect(placeBtn).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST'),
    placeBtn.click(),
  ]);
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()).data as { orderId: string };
  return { orderId: body.orderId, body: body as unknown as Record<string, unknown> };
}

async function readOrder(api: APIRequestContext, orderId: string) {
  const res = await api.get(`/api/orders/${orderId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data as {
    buyerType: string;
    buyerId: string;
    metadata: { buyer?: { type?: string; companyId?: string; companyName?: string } };
  };
}

test.describe('ORDER-01 — checkout records the buyer identity it shows', () => {
  test('a company buyer orders in the company\'s name and the order is stored as COMPANY', async ({ browser }) => {
    const merchantCtx = await browser.newContext();
    await signIn(merchantCtx, DEMO_USERS.merchant);
    const productId = await seedPurchasableProduct(merchantCtx);

    const companyCtx = await browser.newContext();
    await signIn(companyCtx, DEMO_USERS.company);
    const mine = await companyCtx.request.get('/api/companies/mine');
    expect(mine.ok()).toBeTruthy();
    const ownCompany = (await mine.json()).data.company as { id: string; legalName: string; isActive: boolean };
    expect(ownCompany.isActive).toBe(true);

    const page = await companyCtx.newPage();
    await page.goto(`/checkout?productId=${productId}`);

    // The company context is offered and selected by default — the buyer sees
    // exactly the identity that will be recorded.
    await expect(page.getByTestId('buyer-identity')).toBeVisible();
    await expect(page.getByTestId('buyer-type-company')).toBeChecked();
    await expect(page.getByTestId('buyer-identity')).toContainText(ownCompany.legalName);

    const { orderId } = await placeOrderFromCheckout(page);
    const order = await readOrder(companyCtx.request, orderId);
    expect(order.buyerType).toBe('COMPANY');
    expect(order.metadata.buyer?.type).toBe('COMPANY');
    expect(order.metadata.buyer?.companyId).toBe(ownCompany.id);
    expect(order.metadata.buyer?.companyName).toBe(ownCompany.legalName);

    await companyCtx.close();
    await merchantCtx.close();
  });

  test('the same company buyer can switch to an individual order and it stays CUSTOMER', async ({ browser }) => {
    const merchantCtx = await browser.newContext();
    await signIn(merchantCtx, DEMO_USERS.merchant);
    const productId = await seedPurchasableProduct(merchantCtx);

    const companyCtx = await browser.newContext();
    await signIn(companyCtx, DEMO_USERS.company);
    const page = await companyCtx.newPage();
    await page.goto(`/checkout?productId=${productId}`);
    await page.getByTestId('buyer-type-customer').check();
    await expect(page.getByTestId('buyer-type-customer')).toBeChecked();

    const { orderId } = await placeOrderFromCheckout(page);
    const order = await readOrder(companyCtx.request, orderId);
    expect(order.buyerType).toBe('CUSTOMER');
    expect(order.metadata.buyer).toEqual({ type: 'CUSTOMER' });

    await companyCtx.close();
    await merchantCtx.close();
  });

  test('an individual buyer is never offered a company identity', async ({ browser }) => {
    const merchantCtx = await browser.newContext();
    await signIn(merchantCtx, DEMO_USERS.merchant);
    const productId = await seedPurchasableProduct(merchantCtx);

    const customerCtx = await browser.newContext();
    await signIn(customerCtx, DEMO_USERS.customer);
    const page = await customerCtx.newPage();
    await page.goto(`/checkout?productId=${productId}`);
    await expect(page.getByTestId('buyer-identity')).toHaveCount(0);

    const { orderId } = await placeOrderFromCheckout(page);
    const order = await readOrder(customerCtx.request, orderId);
    expect(order.buyerType).toBe('CUSTOMER');

    await customerCtx.close();
    await merchantCtx.close();
  });
});
