import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * N3 — the `/admin/finance` operator page, driven in a real browser against the
 * real backend and PostgreSQL, with the offline rails only (no acquirer, no real
 * money).
 *
 * It proves three things the N2 HTTP spec cannot: the page renders the real rail
 * data, its actions actually call `/api/admin/finance/*` and reflect the server's
 * response, and the frontend guard is not the only protection (the server refuses
 * a non-admin session outright).
 */

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;
const FINANCE = '/api/admin/finance';

interface Intent {
  externalRef: string;
  amount: string;
  currencyCode: string;
  provider: string;
  transactionId: string;
}

/** Places a real order through the UI, opens a real intent, and pays it via the signed webhook. */
async function paidOrderWithIntent(customerPage: import('@playwright/test').Page): Promise<{ orderId: string; intent: Intent }> {
  const orderId = await placeOrderViaUi(customerPage);
  const intentRes = await customerPage.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok()).toBeTruthy();
  const intent = (await intentRes.json()).data.intent as Intent;

  const raw = JSON.stringify({
    eventId: `e2e-finance-ui-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef: intent.externalRef,
    amount: intent.amount,
    currencyCode: intent.currencyCode,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const paid = await customerPage.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  expect(paid.ok()).toBeTruthy();
  expect((await paid.json()).data.applied).toBe(true);

  // The transaction id is read back from the order's own payment — exact, not a
  // guess from a shared amount.
  const payment = (await (await customerPage.request.get(`/api/payments/orders/${orderId}`)).json()).data as {
    intent: { transactionId: string };
  };
  return { orderId, intent: { ...intent, transactionId: payment.intent.transactionId } };
}

test.describe('Admin finance page — access and rendering', () => {
  test.use({ storageState: storageFor('admin') });

  test('an admin opens /admin/finance, sees it in the sidebar, and the real rail list', async ({ page }) => {
    await page.goto('/admin/finance');

    // Reachable from the admin sidebar (the navigation-audit spec also proves the
    // link does not dead-end; here we assert the entry exists at all).
    await expect(page.locator('aside nav a[href="/admin/finance"]')).toBeVisible();

    await expect(page.getByTestId('admin-finance-rails')).toBeVisible();
    // The rail list is real data from `/api/admin/finance/payout-providers`; the
    // sandbox harness is always described (it is the E2E payout rail).
    await expect(page.getByTestId('admin-finance-rail-sandbox')).toBeVisible();

    // The settlement desk and the payout desk are both present.
    await expect(page.getByTestId('admin-finance-settlement')).toBeVisible();
    await expect(page.getByTestId('admin-finance-payouts')).toBeVisible();

    // Independent proof the page used the live endpoint, not a hardcoded render.
    const rails = await page.request.get(`${FINANCE}/payout-providers`);
    expect(rails.status()).toBe(200);
    const ids = ((await rails.json()).data.providers as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain('sandbox');
  });
});

test.describe('Admin finance page — the guard is the server, not the UI', () => {
  test.use({ storageState: storageFor('customer') });

  test('a customer is blocked by the page guard and refused by the finance API', async ({ page }) => {
    await page.goto('/admin/finance');
    await expect(page.getByText(/Forbidden: Admin area/i)).toBeVisible();

    // Hiding the page is not the protection: the money-movement route itself
    // refuses the same session with 403.
    expect((await page.request.get(`${FINANCE}/payout-providers`)).status()).toBe(403);
  });
});

test.describe('Admin finance page — settlement confirmation', () => {
  test.use({ storageState: storageFor('admin') });

  test('confirming a settlement from the UI writes a real ledger entry, and a replay is a no-op', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { orderId, intent } = await paidOrderWithIntent(customer);
      const settlementRef = `e2e-ui-settle-${orderId}`;

      await admin.goto('/admin/finance');
      await admin.getByTestId('admin-finance-external-ref').fill(intent.externalRef);
      await admin.getByTestId('admin-finance-amount').fill(intent.amount);
      await admin.getByTestId('admin-finance-currency').fill(intent.currencyCode);
      await admin.getByTestId('admin-finance-settlement-ref').fill(settlementRef);
      await admin.getByTestId('admin-finance-confirm-settlement').click();

      await expect(admin.getByTestId('admin-finance-settlement-notice')).toBeVisible();
      await expect(admin.getByTestId('admin-finance-settlement-notice')).toContainText(/تم تطبيق التسوية|Settlement applied/i);

      // The settlement is a real ledger movement — read it back through the admin
      // ledger (the order read route is owner-scoped, so an admin is not a valid
      // caller there; the ledger and admin order list are the admin's own views).
      const rows = await admin.request.get('/api/admin/ledger');
      const entries = (await rows.json()).data.items as Array<{
        entryType: string;
        status: string;
        metadata: { settlementRef?: string } | null;
      }>;
      const matching = entries.filter((e) => e.entryType === 'SETTLEMENT' && e.metadata?.settlementRef === settlementRef);
      expect(matching).toHaveLength(1);
      expect(matching[0].status).toBe('SETTLED');

      // Replaying the identical reference is reported as a duplicate, not a second effect.
      await admin.getByTestId('admin-finance-settlement-ref').fill(settlementRef);
      await admin.getByTestId('admin-finance-confirm-settlement').click();
      await expect(admin.getByTestId('admin-finance-settlement-notice')).toContainText(/idempotent|مكرر|مطابقة سابقة/i);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });
});

test.describe('Admin finance page — seller payout lifecycle', () => {
  test.use({ storageState: storageFor('admin') });

  test('creating, dispatching and syncing a payout from the UI never reaches COMPLETED without evidence', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { intent } = await paidOrderWithIntent(customer);

      // Settle first — a payout requires a settled transaction (server-enforced).
      const settle = await admin.request.post(`${FINANCE}/settlements/confirm`, {
        data: {
          externalRef: intent.externalRef,
          amount: intent.amount,
          currencyCode: intent.currencyCode,
          providerId: 'open-checkout',
          settlementRef: `e2e-ui-payout-${intent.transactionId}`,
        },
      });
      expect(settle.ok()).toBeTruthy();

      await admin.goto('/admin/finance');
      await admin.getByTestId('admin-finance-transaction-id').fill(intent.transactionId);

      // The rail select is populated from the live provider list (only rails that
      // declare the payout capability and are available).
      const railSelect = admin.getByTestId('admin-finance-payout-provider');
      await expect(railSelect.locator('option[value="sandbox"]')).toHaveCount(1);
      await railSelect.selectOption('sandbox');

      await admin.getByTestId('admin-finance-create-payout').click();

      const detail = admin.getByTestId('admin-finance-payout-detail');
      await expect(detail).toBeVisible();
      await expect(admin.getByTestId('admin-finance-payout-status')).toHaveText('CREATED');

      // The amount is server-derived and shown; the UI never sent one.
      const payoutId = (await admin.getByTestId('admin-finance-payout-id').innerText()).trim();
      const created = (await (await admin.request.get(`${FINANCE}/payouts/${payoutId}`)).json()).data as { amount: string; status: string };
      expect(Number(created.amount)).toBeGreaterThan(0);
      expect(created.status).toBe('CREATED');

      // Dispatch reaches PROCESSING at most.
      await admin.getByTestId('admin-finance-beneficiary-ref').fill('e2e-ui-beneficiary');
      await admin.getByTestId('admin-finance-dispatch').click();
      await expect(admin.getByTestId('admin-finance-payout-status')).toHaveText('PROCESSING');

      // Sync asks the rail; without a transfer reference it cannot complete.
      await admin.getByTestId('admin-finance-sync').click();
      await expect(admin.getByTestId('admin-finance-payout-status')).toHaveText('PROCESSING');

      // Persisted state agrees: never COMPLETED without proof.
      const persisted = (await (await admin.request.get(`${FINANCE}/payouts/${payoutId}`)).json()).data as { status: string };
      expect(persisted.status).toBe('PROCESSING');
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });
});
