import { request, type APIRequestContext } from '@playwright/test';
import { test, expect, storageFor, DEMO_PASSWORD, completeEmailVerification } from './helpers';

/**
 * PS-02 — Manual payment completion desk (DEMO only).
 *
 * Drives the real UI: an admin records an offline payment and the order reaches
 * PAID. Every assertion reads the backend state back through the API — a rendered
 * page is never taken as proof. The fixture builds an order with an *unpaid*
 * `manual` intent through the real API, so nothing is mocked.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

interface ManualOrder {
  orderId: string;
  transactionId: string;
  externalRef: string;
  amount: string;
  currencyCode: string;
}

async function registerAndLogin(
  ctx: APIRequestContext,
  role: 'SUPPLIER' | 'CUSTOMER',
  tag: string,
): Promise<{ email: string; id: string }> {
  const email = `ps02-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await ctx.post('/api/auth/register', {
    data: { email, password: DEMO_PASSWORD, firstName: 'PS02', role },
  });
  expect(reg.status()).toBe(201);
  await completeEmailVerification(ctx, email);
  const login = await ctx.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const id = ((await login.json()) as { data: { id: string } }).data.id;
  return { email, id };
}

/** Builds an order with an *unpaid* offline `manual` intent, through the real API. */
async function createUnpaidManualOrder(): Promise<ManualOrder> {
  const supplier = await request.newContext({ baseURL: API_URL });
  const buyer = await request.newContext({ baseURL: API_URL });
  try {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await registerAndLogin(supplier, 'SUPPLIER', `sup-${stamp}`);
    const buyerUser = await registerAndLogin(buyer, 'CUSTOMER', `buy-${stamp}`);

    const supplierProfile = await supplier.post('/api/suppliers', { data: { companyName: `PS02 Co ${stamp}` } });
    expect(supplierProfile.status()).toBe(201);
    const supplierId = ((await supplierProfile.json()) as { data: { id: string } }).data.id;

    const cats = await supplier.get('/api/categories');
    const categoryId = ((await cats.json()) as { data: Array<{ id: string }> }).data[0].id;

    const product = await supplier.post('/api/products', {
      data: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `PS02SKU-${stamp}`,
        categoryId,
        name: `PS02 Product ${stamp}`,
        basePrice: '15.5000',
        currencyCode: 'TND',
        moq: 1,
        initialQuantity: 100,
        lowStockThreshold: 5,
        quantity: 100,
      },
    });
    expect(product.status()).toBe(201);
    const productId = ((await product.json()) as { data: { id: string } }).data.id;

    const order = await buyer.post('/api/orders', {
      data: { buyerId: buyerUser.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
    });
    expect(order.status()).toBe(201);
    const orderData = (await order.json()).data as {
      orderId: string;
      transactionId: string;
      currencyCode: string;
    };

    const intentRes = await buyer.post(`/api/payments/orders/${orderData.orderId}/intent`, { data: {} });
    expect(intentRes.status()).toBe(201);
    const intent = ((await intentRes.json()) as {
      data: { intent: { externalRef: string; amount: string; provider: string } };
    }).data.intent;
    expect(intent.provider).toBe('manual');

    return {
      orderId: orderData.orderId,
      transactionId: orderData.transactionId,
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: orderData.currencyCode,
    };
  } finally {
    await supplier.dispose();
    await buyer.dispose();
  }
}

test.describe('Manual payment completion — access control', () => {
  test('a visitor is refused with 401 and a customer with 403', async () => {
    const anon = await request.newContext({ baseURL: API_URL });
    try {
      const res = await anon.post('/api/admin/finance/manual-completions', {
        data: { orderId: 'x', paymentReference: 'r' },
      });
      expect(res.status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    const customer = await request.newContext({ baseURL: API_URL, storageState: storageFor('customer') });
    try {
      const post = await customer.post('/api/admin/finance/manual-completions', {
        data: { orderId: 'x', paymentReference: 'r' },
      });
      expect(post.status()).toBe(403);
      const view = await customer.get('/api/admin/finance/manual-completions/x');
      expect(view.status()).toBe(403);
    } finally {
      await customer.dispose();
    }
  });
});

test.describe('Manual payment completion — admin completes a demo payment', () => {
  test.use({ storageState: storageFor('admin') });

  test('records an offline payment from the UI and the order reaches PAID', async ({ page }) => {
    const order = await createUnpaidManualOrder();
    // The completion is confirmed by a dialog; accept it so the action proceeds.
    page.on('dialog', (d) => void d.accept());

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-manual').click();

    // Look the order up first: it must read as eligible before the action is offered.
    await page.getByTestId('admin-fin-manual-orderId').fill(order.orderId);
    await page.getByTestId('admin-fin-manual-lookup').click();
    const view = page.getByTestId('admin-fin-manual-view');
    await expect(view).toBeVisible();
    // Creating the intent already moved the order to PENDING (unpaid).
    await expect(page.getByTestId('admin-fin-manual-paymentStatus')).toHaveText('PENDING');

    await page.getByTestId('admin-fin-manual-paymentReference').fill('offline-ref-e2e-1');
    await page.getByTestId('admin-fin-manual-submit').click();

    await expect(page.getByTestId('admin-fin-notice')).toBeVisible();
    await expect(page.getByTestId('admin-fin-manual-result')).toBeVisible();
    // The panel re-reads the server, so PAID is the server's answer, not the client's.
    await expect(page.getByTestId('admin-fin-manual-paymentStatus')).toHaveText('PAID');

    // Cross-check the real backend state.
    const intent = await page.request.get(`/api/payments/orders/${order.orderId}`);
    const intentData = (await intent.json()).data as { intent: { status: string } | null };
    expect(intentData.intent?.status).toBe('SUCCEEDED');

    // Completion is payment, not settlement: the ledger must not be SETTLED.
    const ledger = await page.request.get('/api/admin/ledger');
    const rows = ((await ledger.json()) as {
      data: { items: Array<{ transactionId: string; entryType: string; status: string }> };
    }).data.items;
    expect(
      rows.some((r) => r.transactionId === order.transactionId && r.entryType === 'SETTLEMENT'),
    ).toBe(false);
    expect(
      rows.some((r) => r.transactionId === order.transactionId && r.status === 'SETTLED'),
    ).toBe(false);
  });

  test('refuses a completion without a payment reference (422) and surfaces the error', async ({ page }) => {
    const order = await createUnpaidManualOrder();

    // The server refuses a blank reference even though the order exists.
    const res = await page.request.post('/api/admin/finance/manual-completions', {
      data: { orderId: order.orderId, paymentReference: '   ' },
    });
    expect(res.status()).toBe(422);

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-manual').click();
    await page.getByTestId('admin-fin-manual-orderId').fill(order.orderId);
    // The action is offered only for an eligible manual order, so look it up first.
    await page.getByTestId('admin-fin-manual-lookup').click();
    await page.getByTestId('admin-fin-manual-paymentReference').fill('   ');
    await page.getByTestId('admin-fin-manual-submit').click();
    await expect(page.getByTestId('admin-fin-error')).toBeVisible();
    await expect(page.getByTestId('admin-fin-manual-result')).toHaveCount(0);
  });

  test('reports availability for this deployment', async ({ page }) => {
    await page.goto('/admin/finance');
    const res = await page.request.get('/api/admin/finance/manual-payment-availability');
    expect(res.ok()).toBeTruthy();
    const data = (await res.json()).data as { demoMode: boolean; provider: string };
    expect(data.provider).toBe('manual');
    expect(data.demoMode).toBe(true);
  });

  test('dismissing the confirmation records nothing and leaves the order unpaid', async ({ page }) => {
    const order = await createUnpaidManualOrder();
    // Reject the dialog: the money-state change must not happen.
    page.on('dialog', (d) => void d.dismiss());

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-manual').click();
    await page.getByTestId('admin-fin-manual-orderId').fill(order.orderId);
    await page.getByTestId('admin-fin-manual-lookup').click();
    // The order is unpaid but present; the intent exists (PENDING).
    await expect(page.getByTestId('admin-fin-manual-paymentStatus')).toHaveText('PENDING');
    await page.getByTestId('admin-fin-manual-paymentReference').fill('ref-should-not-apply');
    await page.getByTestId('admin-fin-manual-submit').click();

    // No success surface, and the server still reports the order unpaid.
    await expect(page.getByTestId('admin-fin-manual-result')).toHaveCount(0);
    await expect(page.getByTestId('admin-fin-manual-paymentStatus')).toHaveText('PENDING');
    const intent = await page.request.get(`/api/payments/orders/${order.orderId}`);
    const intentData = (await intent.json()).data as { intent: { status: string } | null };
    expect(intentData.intent?.status).not.toBe('SUCCEEDED');
  });
});
