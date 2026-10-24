import { test, expect, storageFor, placeOrderViaUi, type Page } from './helpers';

/**
 * PS-05 — the operator completes an offline/`manual` payment from /admin/orders.
 *
 * The suite runs with PAYMENT_PROVIDER=manual and DEMO_PAYMENT_MODE=true, so the
 * offline rail is the active one and the completion control must be reachable.
 */

/** Places an order via the UI and starts a real `manual` intent, returning the order id. */
async function pendingOrder(page: Page): Promise<string> {
  const orderId = await placeOrderViaUi(page);
  const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok()).toBeTruthy();
  const intent = (await intentRes.json()).data;
  expect(intent.intent.provider).toBe('manual');
  expect(intent.intent.status).toBe('PENDING');
  return orderId;
}

test.describe('ADMIN — complete an offline payment from the orders UI', () => {
  test.use({ storageState: storageFor('customer') });

  test('admin completes a pending manual payment and the UI reflects PAID', async ({ page, browser }) => {
    const orderId = await pendingOrder(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/orders');

    const completeBtn = adminPage.getByTestId(`admin-order-complete-manual-${orderId}`);
    await expect(completeBtn).toBeVisible();
    await completeBtn.click();

    await expect(adminPage.getByTestId('admin-refund-notice')).toBeVisible();
    await expect(adminPage.getByTestId(`admin-order-${orderId}`)).toContainText('PAID');

    // Independent verification through the live API: the payment is confirmed, but
    // the ledger must NOT be settled — a manual confirmation is a payment, not a
    // settlement, and the two must never be conflated.
    const check = await adminPage.request.get(`/api/payments/orders/${orderId}`);
    const body = (await check.json()).data;
    expect(body.intent.status).toBe('SUCCEEDED');
    expect(body.payment.status).toBe('PAID');

    const ledger = (await (await adminPage.request.get('/api/admin/ledger')).json()).data.items as Array<{ status: string }>;
    expect(ledger.every((e) => e.status !== 'SETTLED')).toBe(true);

    await adminCtx.close();
  });

  test('a second completion attempt is refused and the UI surfaces it', async ({ page, browser }) => {
    const orderId = await pendingOrder(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/orders');

    await adminPage.getByTestId(`admin-order-complete-manual-${orderId}`).click();
    await expect(adminPage.getByTestId('admin-refund-notice')).toBeVisible();

    // Once PAID the control is gone (the row is no longer completable)…
    await expect(adminPage.getByTestId(`admin-order-complete-manual-${orderId}`)).toHaveCount(0);
    // …and a direct API call is refused server-side.
    const again = await adminPage.request.post(`/api/payments/orders/${orderId}/complete-manual`, { data: {} });
    expect(again.status()).toBe(409);

    await adminCtx.close();
  });
});
