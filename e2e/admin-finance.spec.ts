import { createHmac } from 'node:crypto';
import { request, type APIRequestContext } from '@playwright/test';
import { test, expect, storageFor, DEMO_PASSWORD, completeEmailVerification, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * Admin Finance Desk (PS-01) — functional audit driven from the real UI.
 *
 * Every money-movement action is performed from the browser, and each assertion
 * reads the real backend state back through the API — a rendered page is never
 * taken as proof. The fixtures (a paid + settled order) are built through the
 * real API, exactly as `admin-subscriptions.spec.ts` mints its own subscription.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

interface PaidOrder {
  orderId: string;
  transactionId: string;
  sellerOrderId: string;
  externalRef: string;
  amount: string;
  currencyCode: string;
  commission: string;
  sellerEmail: string;
}

async function registerAndLogin(
  ctx: APIRequestContext,
  role: 'SUPPLIER' | 'CUSTOMER',
  tag: string,
): Promise<{ email: string; id: string }> {
  const email = `ps01-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await ctx.post('/api/auth/register', {
    data: { email, password: DEMO_PASSWORD, firstName: 'PS01', role },
  });
  expect(reg.status()).toBe(201);
  await completeEmailVerification(ctx, email);
  const login = await ctx.post('/api/auth/login', { data: { email, password: DEMO_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const id = ((await login.json()) as { data: { id: string } }).data.id;
  return { email, id };
}

/** Builds a paid (provider-confirmed) order through the real API. */
async function createPaidOrder(): Promise<PaidOrder> {
  const supplier = await request.newContext({ baseURL: API_URL });
  const buyer = await request.newContext({ baseURL: API_URL });
  try {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const supplierUser = await registerAndLogin(supplier, 'SUPPLIER', `sup-${stamp}`);
    const buyerUser = await registerAndLogin(buyer, 'CUSTOMER', `buy-${stamp}`);

    const supplierProfile = await supplier.post('/api/suppliers', { data: { companyName: `PS01 Co ${stamp}` } });
    expect(supplierProfile.status()).toBe(201);
    const supplierId = ((await supplierProfile.json()) as { data: { id: string } }).data.id;

    const cats = await supplier.get('/api/categories');
    const categoryId = ((await cats.json()) as { data: Array<{ id: string }> }).data[0].id;

    const product = await supplier.post('/api/products', {
      data: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `PS01SKU-${stamp}`,
        categoryId,
        name: `PS01 Product ${stamp}`,
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
      commission: string;
      currencyCode: string;
      sellerOrderIds: string[];
    };

    const intentRes = await buyer.post(`/api/payments/orders/${orderData.orderId}/intent`, { data: {} });
    expect(intentRes.status()).toBe(201);
    const intent = ((await intentRes.json()) as { data: { intent: { externalRef: string; amount: string } } }).data.intent;

    const raw = JSON.stringify({
      eventId: `ps01-evt-${stamp}`,
      type: 'payment.succeeded',
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: orderData.currencyCode,
    });
    const signature = createHmac('sha256', E2E_WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
    const paid = await buyer.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
      data: raw,
    });
    expect(paid.ok()).toBeTruthy();
    expect(((await paid.json()) as { data: { applied: boolean } }).data.applied).toBe(true);

    return {
      orderId: orderData.orderId,
      transactionId: orderData.transactionId,
      sellerOrderId: orderData.sellerOrderIds[0],
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: orderData.currencyCode,
      commission: orderData.commission,
      sellerEmail: supplierUser.email,
    };
  } finally {
    await supplier.dispose();
    await buyer.dispose();
  }
}

/** Confirms settlement through the API, using the admin page's own session. */
async function settleViaApi(admin: import('@playwright/test').Page, order: PaidOrder, settlementRef: string): Promise<void> {
  const res = await admin.request.post('/api/admin/finance/settlements/confirm', {
    data: {
      externalRef: order.externalRef,
      amount: order.amount,
      currencyCode: order.currencyCode,
      providerId: 'open-checkout',
      settlementRef,
    },
  });
  expect(res.ok()).toBeTruthy();
  expect(((await res.json()) as { data: { applied: boolean } }).data.applied).toBe(true);
}

/**
 * Attributes the confirmed parent settlement to the order's seller suborders
 * (M2.3). A payout is issued per seller line, and the line's own
 * `settlement_status` must be SETTLED — confirming the transaction settles the
 * parent, this official re-processing step settles the line. Idempotent.
 */
async function reconcileSuborders(admin: import('@playwright/test').Page, order: PaidOrder): Promise<void> {
  const res = await admin.request.post('/api/admin/finance/settlements/suborders/reconcile', {
    data: { orderId: order.orderId },
  });
  expect(res.ok(), `suborder reconcile failed: HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
  const results = ((await res.json()) as { data: Array<{ sellerOrderId: string; settled: boolean; duplicate: boolean }> }).data;
  const line = results.find((r) => r.sellerOrderId === order.sellerOrderId);
  expect(line && (line.settled || line.duplicate), 'the seller line must be settled before a payout').toBeTruthy();
}

/**
 * Fulfils the order as its own seller through the OFFICIAL status endpoint, so a
 * payout has a DELIVERED seller suborder to pay. The seller line is the payout
 * unit (M2.2) and only a fulfilled line is payable (M2.3) — a payout for a
 * still-pending line must be refused, so the fixture has to deliver first, the
 * same way the seller's own order page would. The seller walks the real
 * lifecycle (CONFIRMED → PROCESSING → SHIPPED → DELIVERED), never jumping.
 */
async function deliverOrderAsSeller(order: PaidOrder): Promise<void> {
  const seller = await request.newContext({ baseURL: API_URL });
  try {
    const login = await seller.post('/api/auth/login', { data: { email: order.sellerEmail, password: DEMO_PASSWORD } });
    expect(login.ok(), `seller login failed: HTTP ${login.status()}`).toBeTruthy();
    for (const status of ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const res = await seller.patch(`/api/orders/${order.orderId}/status`, {
        data: { status, sellerOrderId: order.sellerOrderId },
      });
      expect(res.ok(), `seller transition to ${status} failed: HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
    }
  } finally {
    await seller.dispose();
  }
}

test.describe('Admin finance desk — access control', () => {
  test('a visitor is refused with 401 and a customer with 403', async () => {
    const anon = await request.newContext({ baseURL: API_URL });
    try {
      const res = await anon.get('/api/admin/finance/payout-providers');
      expect(res.status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    const customer = await request.newContext({ baseURL: API_URL, storageState: storageFor('customer') });
    try {
      const res = await customer.get('/api/admin/finance/payout-providers');
      expect(res.status()).toBe(403);
      const post = await customer.post('/api/admin/finance/settlements/confirm', {
        data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout', settlementRef: 'r' },
      });
      expect(post.status()).toBe(403);
    } finally {
      await customer.dispose();
    }
  });

  test('a customer opening /admin/finance in the UI sees the forbidden state', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageFor('customer') });
    const page = await ctx.newPage();
    try {
      await page.goto('/admin/finance');
      await expect(page.getByText(/Forbidden|محظور|غير مصرّح/i).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Admin finance desk — settlement', () => {
  test.use({ storageState: storageFor('admin') });

  test('confirms a settlement with a valid reference and shows the server result', async ({ page }) => {
    const order = await createPaidOrder();
    const settlementRef = `settle-${Date.now()}`;

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-settlement').click();
    await page.getByTestId('admin-fin-settlement-externalRef').fill(order.externalRef);
    await page.getByTestId('admin-fin-settlement-amount').fill(order.amount);
    await page.getByTestId('admin-fin-settlement-currency').fill(order.currencyCode);
    await page.getByTestId('admin-fin-settlement-providerId').fill('open-checkout');
    await page.getByTestId('admin-fin-settlement-settlementRef').fill(settlementRef);
    await page.getByTestId('admin-fin-settlement-submit').click();

    await expect(page.getByTestId('admin-fin-notice')).toBeVisible();
    const result = page.getByTestId('admin-fin-settlement-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('true');

    // The ledger really carries a SETTLED entry for this transaction.
    const ledger = await page.request.get('/api/admin/ledger');
    const rows = ((await ledger.json()) as { data: { items: Array<{ transactionId: string; entryType: string; status: string }> } }).data.items;
    expect(rows.some((r) => r.transactionId === order.transactionId && r.entryType === 'SETTLEMENT' && r.status === 'SETTLED')).toBe(true);
  });

  test('refuses a settlement without a transfer reference (422) and surfaces the error', async ({ page }) => {
    // The UI pre-checks only what it can; the mandatory reference is the server's.
    const res = await page.request.post('/api/admin/finance/settlements/confirm', {
      data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout' },
    });
    expect(res.status()).toBe(422);

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-settlement').click();
    await page.getByTestId('admin-fin-settlement-externalRef').fill('x');
    await page.getByTestId('admin-fin-settlement-amount').fill('1.0000');
    await page.getByTestId('admin-fin-settlement-currency').fill('TND');
    await page.getByTestId('admin-fin-settlement-providerId').fill('open-checkout');
    await page.getByTestId('admin-fin-settlement-submit').click();
    await expect(page.getByTestId('admin-fin-error')).toBeVisible();
    await expect(page.getByTestId('admin-fin-settlement-result')).toHaveCount(0);
  });
});

test.describe('Admin finance desk — payout providers', () => {
  test.use({ storageState: storageFor('admin') });

  test('lists payout providers and their states', async ({ page }) => {
    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-providers').click();
    const table = page.getByTestId('admin-fin-providers-table');
    await expect(table).toBeVisible();
    await expect(page.getByTestId('admin-fin-provider-sandbox')).toBeVisible();
    await expect(page.getByTestId('admin-fin-provider-noop')).toBeVisible();

    // Cross-check against the API so the table is not a literal.
    const api = await page.request.get('/api/admin/finance/payout-providers');
    const body = (await api.json()).data as { providers: Array<{ id: string }> };
    for (const p of body.providers) {
      await expect(page.getByTestId(`admin-fin-provider-${p.id}`)).toBeVisible();
    }
  });
});

test.describe('Admin finance desk — payouts', () => {
  test.use({ storageState: storageFor('admin') });

  test('creates a payout (CREATED), dispatches to PROCESSING, and sync never forces COMPLETED', async ({ page }) => {
    const order = await createPaidOrder();
    // A seller line is payable only once fulfilled (M2.3): deliver it, then settle
    // its share — the same order the real seller and finance desks would follow.
    await deliverOrderAsSeller(order);
    await settleViaApi(page, order, `settle-${Date.now()}`);
    await reconcileSuborders(page, order);

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-payouts').click();
    await page.getByTestId('admin-fin-payout-transactionId').fill(order.transactionId);
    await page.getByTestId('admin-fin-payout-sellerOrderId').fill(order.sellerOrderId);
    await page.getByTestId('admin-fin-payout-providerId').fill('sandbox');
    await page.getByTestId('admin-fin-payout-create-submit').click();

    const status = page.getByTestId('admin-fin-payout-status');
    await expect(status).toBeVisible();
    await expect(status).toHaveText('CREATED');

    // Dispatch reaches PROCESSING, never COMPLETED.
    await page.getByTestId('admin-fin-payout-beneficiaryRef').fill('beneficiary-e2e-1');
    await page.getByTestId('admin-fin-payout-dispatch').click();
    await expect(page.getByTestId('admin-fin-notice')).toBeVisible();
    await expect(status).toHaveText('PROCESSING');
    await expect(status).not.toHaveText('COMPLETED');

    // Sync re-checks with the rail; the sandbox stays PROCESSING, so no completion.
    await page.getByTestId('admin-fin-payout-sync').click();
    await expect(status).not.toHaveText('COMPLETED');
    await expect(status).toHaveText('PROCESSING');
  });

  test('a second payout for the same seller line is refused (no double payout)', async ({ page }) => {
    const order = await createPaidOrder();
    await deliverOrderAsSeller(order);
    await settleViaApi(page, order, `settle-${Date.now()}`);
    await reconcileSuborders(page, order);

    // First payout for the delivered, settled line is created.
    const first = await page.request.post('/api/admin/finance/payouts', {
      data: { transactionId: order.transactionId, sellerOrderId: order.sellerOrderId, providerId: 'sandbox' },
    });
    expect(first.ok(), `first payout failed: HTTP ${first.status()}`).toBeTruthy();
    expect((await first.json()).data.status).toBe('CREATED');

    // The same unit cannot be paid twice: the settlement gate holds and the unique
    // live-payout index refuses the duplicate.
    const second = await page.request.post('/api/admin/finance/payouts', {
      data: { transactionId: order.transactionId, sellerOrderId: order.sellerOrderId, providerId: 'sandbox' },
    });
    expect(second.status()).toBe(409);
  });

  test('a payout is refused for a delivered line whose transaction is not settled', async ({ page }) => {
    // Delivered (so the per-seller gate is not the reason) but never settled: the
    // parent SETTLEMENT gate must be what refuses it.
    const order = await createPaidOrder();
    await deliverOrderAsSeller(order);

    const res = await page.request.post('/api/admin/finance/payouts', {
      data: { transactionId: order.transactionId, sellerOrderId: order.sellerOrderId, providerId: 'sandbox' },
    });
    expect(res.status()).toBe(409);
  });

  test('rejects a payout for an unsettled transaction', async ({ page }) => {
    const order = await createPaidOrder(); // paid but NOT settled
    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-payouts').click();
    await page.getByTestId('admin-fin-payout-transactionId').fill(order.transactionId);
    await page.getByTestId('admin-fin-payout-providerId').fill('sandbox');
    await page.getByTestId('admin-fin-payout-create-submit').click();
    await expect(page.getByTestId('admin-fin-error')).toBeVisible();
    await expect(page.getByTestId('admin-fin-payout-result')).toHaveCount(0);
  });
});

test.describe('Admin finance desk — reconciliation & receipts', () => {
  test.use({ storageState: storageFor('admin') });

  test('imports a reconciliation feed and shows the match report', async ({ page }) => {
    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-reconciliation').click();
    await page.getByTestId('admin-fin-recon-source').selectOption('PROVIDER');
    await page.getByTestId('admin-fin-recon-currency').fill('TND');
    await page.getByTestId('admin-fin-recon-provider').fill(JSON.stringify([
      { reference: `ps01-ref-${Date.now()}`, settlementRef: 'set-1', grossAmount: '100.0000', providerFee: '2.0000', netAmount: '98.0000', currencyCode: 'TND' },
    ]));
    await page.getByTestId('admin-fin-recon-submit').click();

    const result = page.getByTestId('admin-fin-recon-result');
    await expect(result).toBeVisible();
    await expect(page.getByTestId('admin-fin-recon-matched')).toBeVisible();
    await expect(page.getByTestId('admin-fin-recon-mismatched')).toBeVisible();
  });

  test('rejects a malformed reconciliation feed (invalid JSON) in the UI', async ({ page }) => {
    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-reconciliation').click();
    await page.getByTestId('admin-fin-recon-provider').fill('{ not json');
    await page.getByTestId('admin-fin-recon-submit').click();
    await expect(page.getByTestId('admin-fin-error')).toBeVisible();
    await expect(page.getByTestId('admin-fin-recon-result')).toHaveCount(0);
  });

  test('accepts a receipt with a known source and the server refuses an unknown one', async ({ page }) => {
    const order = await createPaidOrder();
    await settleViaApi(page, order, `settle-${Date.now()}`);

    // The UI only offers the three real sources, so the unknown-source refusal is
    // asserted at the API (a UI could not even construct it).
    const bad = await page.request.post('/api/admin/finance/receipts', {
      data: { transactionId: order.transactionId, evidence: { source: 'MADE_UP', reference: 'r', amount: '1.0000', currencyCode: 'TND' } },
    });
    expect(bad.status()).toBe(422);

    await page.goto('/admin/finance');
    await page.getByTestId('admin-fin-tab-receipts').click();
    await page.getByTestId('admin-fin-receipt-transactionId').fill(order.transactionId);
    await page.getByTestId('admin-fin-receipt-source').selectOption('BANK_STATEMENT');
    await page.getByTestId('admin-fin-receipt-reference').fill(`stmt-${Date.now()}`);
    await page.getByTestId('admin-fin-receipt-amount').fill(order.commission);
    await page.getByTestId('admin-fin-receipt-currency').fill(order.currencyCode);
    await page.getByTestId('admin-fin-receipt-submit').click();

    const result = page.getByTestId('admin-fin-receipt-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('RECEIVED');
  });
});
