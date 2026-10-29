import { test, expect, storageFor } from './helpers';

/**
 * Seller/buyer order lifecycle driven entirely from the UI (real backend, no mocks).
 *
 * Before this spec the seller surface had no way to move an order past PENDING:
 * `PATCH /api/orders/:id/status` existed and was covered by server tests, but no
 * web control ever called it, so a placed order stayed PENDING forever and could
 * never be confirmed, shipped, or settled. These tests click the real buttons in
 * the order detail page and then confirm the persisted status through the API.
 *
 * The product used here is created by the test itself (through the merchant's own
 * product form) so the flow never depends on whatever stock a previous run left
 * behind, and always belongs to a seller entity the merchant can manage.
 */

const UNIQUE = Date.now();
let productSeq = 0;

async function createSellerProductWithStock(
  page: import('@playwright/test').Page,
  stock: number,
): Promise<string> {
  const sku = `LIFECYCLE-${UNIQUE}-${++productSeq}`;
  await page.goto('/dashboard/products/new');
  await page.locator('#p-name').fill(`Lifecycle Product ${UNIQUE}`);
  await page.locator('#p-sku').fill(sku);
  await page.locator('#p-category').selectOption({ index: 1 });
  await page.locator('#p-price').fill('10');
  await page.getByRole('button', { name: /حفظ|Save/i }).click();
  await expect(page.getByText(/تم إنشاء المنتج بنجاح|Product created successfully/i).first()).toBeVisible();

  const mine = await page.request.get('/api/products/mine?pageSize=100');
  const items = (await mine.json()).data.items as Array<{ id: string; sku: string }>;
  const product = items.find((p) => p.sku === sku);
  expect(product, 'created product must be in the seller catalog').toBeTruthy();

  // The product form creates its inventory row at quantity 0; top it up so orders
  // can be reserved without hitting INSUFFICIENT_STOCK.
  const invList = await page.request.get('/api/inventory?pageSize=100');
  const invItems = (await invList.json()).data.items as Array<{ id: string; productId: string }>;
  const invItem = invItems.find((i) => i.productId === product!.id);
  expect(invItem, 'created product must have an inventory row').toBeTruthy();
  const upd = await page.request.patch(`/api/inventory/${invItem!.id}`, {
    data: { quantity: stock, lowStockThreshold: 1 },
  });
  expect(upd.ok(), `inventory update failed: HTTP ${upd.status()} ${await upd.text()}`).toBeTruthy();

  return product!.id;
}

/** Archives a product created by this spec so it stops appearing in the shared marketplace. */
async function archiveProduct(
  page: import('@playwright/test').Page,
  productId: string,
): Promise<void> {
  await page.request.patch(`/api/products/${productId}/status`, { data: { status: 'ARCHIVED' } });
}

async function placeOrderViaApi(
  page: import('@playwright/test').Page,
  productId: string,
  qty: number,
): Promise<string> {
  const me = await page.request.get('/api/auth/me');
  const buyerId = (await me.json()).data.id as string;
  const res = await page.request.post('/api/orders', {
    data: { buyerId, buyerType: 'CUSTOMER', items: [{ productId, quantity: qty }] },
  });
  expect(res.ok(), `order create failed: HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).data.orderId as string;
}

/**
 * Confirms an order's payment through the real offline rail so it can be
 * CONFIRMED. Confirmation is money-gated (PS-08A): the seller's "Confirmed"
 * button is refused until `paymentStatus = 'PAID'`. The suite runs
 * `PAYMENT_PROVIDER=manual` with `DEMO_PAYMENT_MODE=true`, so an operator
 * completing the real intent is the documented way the money is proven.
 */
async function payOrderViaApi(
  buyerPage: import('@playwright/test').Page,
  adminPage: import('@playwright/test').Page,
  orderId: string,
): Promise<void> {
  const intentRes = await buyerPage.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok(), `intent failed: HTTP ${intentRes.status()} ${await intentRes.text()}`).toBeTruthy();
  const done = await adminPage.request.post(`/api/payments/orders/${orderId}/complete-manual`, { data: {} });
  expect(done.ok(), `manual completion failed: HTTP ${done.status()} ${await done.text()}`).toBeTruthy();
}

test.describe('ORDER LIFECYCLE — seller fulfils and buyer cancels from the UI', () => {
  test('seller advances a real order PENDING → COMPLETED through the order page buttons', async ({ browser }) => {
    const merchantCtx = await browser.newContext({ storageState: storageFor('merchant') });
    const merchantPage = await merchantCtx.newPage();
    const productId = await createSellerProductWithStock(merchantPage, 100);

    const buyerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyerCtx.newPage();
    const orderId = await placeOrderViaApi(buyerPage, productId, 2);

    // Confirmation is money-gated: prove the payment first through the offline
    // rail (intent as the buyer, completion as the operator), then close the
    // buyer context — the seller must be able to drive the rest of the lifecycle.
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await payOrderViaApi(buyerPage, adminPage, orderId);
    await adminCtx.close();
    await buyerCtx.close();

    await merchantPage.goto(`/dashboard/orders/${orderId}`);
    await expect(merchantPage.getByTestId('order-status')).toHaveText(/قيد الانتظار|Pending/i);

    const forward: Array<{ action: RegExp; status: RegExp }> = [
      { action: /^مؤكد$|^Confirmed$/i, status: /مؤكد|Confirmed/i },
      { action: /^قيد التنفيذ$|^Processing$/i, status: /قيد التنفيذ|Processing/i },
      { action: /^تم الشحن$|^Shipped$/i, status: /تم الشحن|Shipped/i },
      { action: /^تم التسليم$|^Delivered$/i, status: /تم التسليم|Delivered/i },
      { action: /^مكتمل$|^Completed$/i, status: /مكتمل|Completed/i },
    ];

    for (const step of forward) {
      await merchantPage.getByTestId('order-actions').getByRole('button', { name: step.action }).click();
      await expect(merchantPage.getByTestId('order-action-success')).toBeVisible();
      await expect(merchantPage.getByTestId('order-status')).toHaveText(step.status);
    }

    // Persistence is checked server-side; UI text alone is not treated as success.
    const finalRes = await merchantPage.request.get(`/api/orders/${orderId}`);
    expect((await finalRes.json()).data.status).toBe('COMPLETED');

    // A COMPLETED order offers no further transition.
    await expect(merchantPage.getByTestId('order-no-actions')).toBeVisible();
    await archiveProduct(merchantPage, productId);
    await merchantCtx.close();
  });

  test('buyer cancels a pending order from the order page', async ({ browser }) => {
    const merchantCtx = await browser.newContext({ storageState: storageFor('merchant') });
    const merchantPage = await merchantCtx.newPage();
    const productId = await createSellerProductWithStock(merchantPage, 100);

    const buyerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyerCtx.newPage();
    const orderId = await placeOrderViaApi(buyerPage, productId, 1);

    await buyerPage.goto(`/dashboard/orders/${orderId}`);
    await expect(buyerPage.getByTestId('order-status')).toHaveText(/قيد الانتظار|Pending/i);
    await buyerPage.getByTestId('order-action-CANCELLED').click();
    await expect(buyerPage.getByTestId('order-action-success')).toBeVisible();
    await expect(buyerPage.getByTestId('order-status')).toHaveText(/ملغى|Cancelled/i);

    const res = await buyerPage.request.get(`/api/orders/${orderId}`);
    expect((await res.json()).data.status).toBe('CANCELLED');
    await archiveProduct(merchantPage, productId);
    await buyerCtx.close();
    await merchantCtx.close();
  });

  test('a seller cannot confirm an unpaid order — the money gate refuses it (409)', async ({ browser }) => {
    const merchantCtx = await browser.newContext({ storageState: storageFor('merchant') });
    const merchantPage = await merchantCtx.newPage();
    const productId = await createSellerProductWithStock(merchantPage, 100);

    const buyerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyerCtx.newPage();
    const orderId = await placeOrderViaApi(buyerPage, productId, 1);

    // The order is UNPAID. Confirmation is money-gated (PS-08A): the seller's
    // direct request is refused, and the order stays PENDING rather than being
    // committed to a sale for money that never arrived.
    const refused = await merchantPage.request.patch(`/api/orders/${orderId}/status`, {
      data: { status: 'CONFIRMED' },
    });
    expect(refused.status()).toBe(409);

    const order = (await (await merchantPage.request.get(`/api/orders/${orderId}`)).json()).data as {
      status: string;
      paymentStatus: string;
    };
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('UNPAID');

    await archiveProduct(merchantPage, productId);
    await buyerCtx.close();
    await merchantCtx.close();
  });
});
