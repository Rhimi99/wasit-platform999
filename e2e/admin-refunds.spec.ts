import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, type Page, E2E_WEBHOOK_SECRET } from './helpers';

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;

/** Places an order through the UI, pays it via the signed webhook, returns the order id. */
async function paidOrder(page: Page): Promise<string> {
  const orderId = await placeOrderViaUi(page);
  const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  const intent = (await intentRes.json()).data;
  const payload = { eventId: `e2e-refund-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.intent.externalRef };
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const settled = await page.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  expect(settled.ok()).toBeTruthy();
  return orderId;
}

test.describe('ADMIN — refund an order from the real orders UI', () => {
  test.use({ storageState: storageFor('customer') });

  test('admin issues a full refund from /admin/orders and the UI reflects it', async ({ page, browser }) => {
    const orderId = await paidOrder(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/orders');

    // The refund action must be reachable from the paid order's row, not hidden.
    const refundBtn = adminPage.getByTestId(`admin-order-refund-${orderId}`);
    await expect(refundBtn).toBeVisible();
    await refundBtn.click();

    await expect(adminPage.getByTestId('admin-refund-panel')).toBeVisible();
    await adminPage.getByTestId('admin-refund-reason').fill('e2e full refund');
    await adminPage.getByTestId('admin-refund-submit').click();

    // The user sees a real confirmation, and the row now reports the refunded state.
    await expect(adminPage.getByTestId('admin-refund-notice')).toBeVisible();
    await expect(adminPage.getByTestId(`admin-order-${orderId}`)).toContainText('REFUNDED');

    // Independent verification through the live API (not just the rendered text).
    // `payments.status` records the original capture and stays PAID; the refund is
    // reflected on the order aggregate and in the ledger.
    const check = await adminPage.request.get(`/api/payments/orders/${orderId}`);
    const body = (await check.json()).data;
    expect(body.payment.status).toBe('PAID');
    const list = (await (await adminPage.request.get('/api/admin/orders')).json()).data.items as Array<{ id: string; paymentStatus: string; refundStatus: string }>;
    expect(list.find((o) => o.id === orderId)!.paymentStatus).toBe('REFUNDED');
    const ledger = (await (await adminPage.request.get('/api/admin/ledger')).json()).data.items as Array<{ entryType: string; direction: string }>;
    expect(ledger.some((e) => e.entryType === 'REFUND' && e.direction === 'DEBIT')).toBe(true);

    await adminCtx.close();
  });

  test('admin sees a real validation error when the refund exceeds the paid amount', async ({ page, browser }) => {
    const orderId = await paidOrder(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/orders');
    await adminPage.getByTestId(`admin-order-refund-${orderId}`).click();

    // Over-refund is refused by the service; the UI must surface that, not swallow it.
    await adminPage.getByTestId('admin-refund-amount').fill('99999.0000');
    await adminPage.getByTestId('admin-refund-submit').click();
    await expect(adminPage.getByRole('alert')).toContainText(/exceeds remaining refundable/i);

    // Nothing changed on the order.
    const check = await adminPage.request.get(`/api/payments/orders/${orderId}`);
    expect((await check.json()).data.payment.status).toBe('PAID');

    await adminCtx.close();
  });

  test('partial refund keeps the order refundable and shows the remaining state', async ({ page, browser }) => {
    const orderId = await paidOrder(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/orders');

    const refundRes = await adminPage.request.get(`/api/payments/orders/${orderId}`);
    const paid = (await refundRes.json()).data.payment.amount as string;
    const partial = (Number(paid) / 2).toFixed(4);

    await adminPage.getByTestId(`admin-order-refund-${orderId}`).click();
    await adminPage.getByTestId('admin-refund-amount').fill(partial);
    await adminPage.getByTestId('admin-refund-submit').click();

    await expect(adminPage.getByTestId('admin-refund-notice')).toBeVisible();
    // PARTIALLY_REFUNDED orders stay actionable so the rest can be returned.
    await expect(adminPage.getByTestId(`admin-order-${orderId}`)).toContainText('PARTIALLY_REFUNDED');
    await expect(adminPage.getByTestId(`admin-order-refund-${orderId}`)).toBeVisible();

    await adminCtx.close();
  });
});
