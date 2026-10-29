import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * N5 — the read-only payout list on `/admin/finance`, driven in a real browser
 * against the real backend and PostgreSQL, offline rails only.
 *
 * It proves the desk lists *stored* payouts (no lookup by id required) and that
 * the list is a pure read: rendering it never advances a payout's status, so a
 * CREATED payout stays CREATED and PROCESSING can never become COMPLETED here.
 */

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;
const FINANCE = '/api/admin/finance';

interface Intent {
  externalRef: string;
  amount: string;
  currencyCode: string;
  transactionId: string;
}

/** Places a real order via the UI, pays it via the signed webhook, settles it, then creates its payout. */
async function settledPayout(
  customer: import('@playwright/test').Page,
  admin: import('@playwright/test').Page,
): Promise<{ payoutId: string; transactionId: string }> {
  const orderId = await placeOrderViaUi(customer);
  const intentRes = await customer.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok()).toBeTruthy();
  const intent = (await intentRes.json()).data.intent as Omit<Intent, 'transactionId'>;

  const raw = JSON.stringify({
    eventId: `e2e-payout-list-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef: intent.externalRef,
    amount: intent.amount,
    currencyCode: intent.currencyCode,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const paid = await customer.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  expect(paid.ok()).toBeTruthy();

  const payment = (await (await customer.request.get(`/api/payments/orders/${orderId}`)).json()).data as {
    intent: { transactionId: string };
  };
  const transactionId = payment.intent.transactionId;

  const settle = await admin.request.post(`${FINANCE}/settlements/confirm`, {
    data: {
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: intent.currencyCode,
      providerId: 'open-checkout',
      settlementRef: `e2e-list-settle-${transactionId}`,
    },
  });
  expect(settle.ok()).toBeTruthy();

  const created = await admin.request.post(`${FINANCE}/payouts`, {
    data: { transactionId, providerId: 'sandbox' },
  });
  expect(created.ok()).toBeTruthy();
  const payout = (await created.json()).data as { id: string; status: string };
  expect(payout.status).toBe('CREATED');
  return { payoutId: payout.id, transactionId };
}

test.describe('Admin finance page — payout list', () => {
  test.use({ storageState: storageFor('admin') });

  test('lists a stored payout without a by-id lookup, and the list is read-only', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();
      const { payoutId } = await settledPayout(customer, admin);

      // The whole point of N5: the payout is found in the list, never typed in.
      await admin.goto('/admin/finance');
      const row = admin.getByTestId(`admin-finance-payout-row-${payoutId}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId('admin-finance-payout-row-status')).toContainText('CREATED');

      // The rendered amount is the stored amount, formatted by the app's own
      // money formatter — read it from the API rather than assuming the demo
      // order's total.
      const detail = (await (await admin.request.get(`${FINANCE}/payouts/${payoutId}`)).json()).data as { amount: string; currencyCode: string };
      const expectedAmount = new Intl.NumberFormat('fr-TN', { style: 'currency', currency: detail.currencyCode }).format(Number(detail.amount));
      await expect(row.getByTestId('admin-finance-payout-row-amount')).toContainText(expectedAmount);

      // The list reports a real total from the server.
      const api = await admin.request.get(`${FINANCE}/payouts?page=1&pageSize=10`);
      expect(api.ok()).toBeTruthy();
      const total = ((await api.json()).data as { pagination: { total: number } }).pagination.total;
      await expect(admin.getByTestId('admin-finance-payout-list-total')).toContainText(String(total));

      // Reloading the page (a fresh list read) must not advance the status.
      await admin.reload();
      await expect(admin.getByTestId(`admin-finance-payout-row-${payoutId}`).getByTestId('admin-finance-payout-row-status')).toContainText('CREATED');

      const after = await admin.request.get(`${FINANCE}/payouts/${payoutId}`);
      expect((await after.json()).data.status).toBe('CREATED');
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('filters by status and shows an empty state when nothing matches', async ({ page }) => {
    await page.goto('/admin/finance');
    await expect(page.getByTestId('admin-finance-payout-list')).toBeVisible();

    await page.getByTestId('admin-finance-payout-list-status').selectOption('COMPLETED');
    // Either real COMPLETED rows or the empty state — never a CREATED row mislabelled.
    const empty = page.getByTestId('admin-finance-payout-list').getByText(/لا توجد مدفوعات|No payouts yet/i);
    const rows = page.locator('[data-testid^="admin-finance-payout-row-"]');
    await expect
      .poll(async () => (await empty.isVisible()) || (await rows.count()) > 0)
      .toBeTruthy();

    if ((await rows.count()) > 0) {
      for (const badge of await page.getByTestId('admin-finance-payout-row-status').all()) {
        await expect(badge).toContainText('COMPLETED');
      }
    }

    // A valid-but-empty filter falls back to the empty state, not an error.
    await page.getByTestId('admin-finance-payout-list-status').selectOption('HELD');
    await expect(page.getByTestId('admin-finance-payout-error')).toHaveCount(0);
  });

  test('renders pagination controls that reflect the server page size', async ({ page }) => {
    await page.goto('/admin/finance');
    const api = await page.request.get(`${FINANCE}/payouts?page=1&pageSize=10`);
    expect(api.ok()).toBeTruthy();
    const { total } = ((await api.json()).data as { pagination: { total: number } }).pagination;

    await expect(page.getByTestId('admin-finance-payout-list-page')).toContainText(
      `1 / ${Math.max(1, Math.ceil(total / 10))}`,
    );
    // On page 1 the previous control is always disabled.
    await expect(page.getByTestId('admin-finance-payout-list-prev')).toBeDisabled();
  });
});

test.describe('Admin finance page — payout list access guard', () => {
  test.use({ storageState: storageFor('customer') });

  test('a customer is refused by the server on the list route', async ({ page }) => {
    expect((await page.request.get(`${FINANCE}/payouts`)).status()).toBe(403);
    expect((await page.request.get(`${FINANCE}/payouts?status=CREATED&page=1&pageSize=10`)).status()).toBe(403);
  });
});
