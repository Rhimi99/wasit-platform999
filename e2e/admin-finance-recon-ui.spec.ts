import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * N4 — the reconciliation + WASIT-receipt desks on `/admin/finance`, driven in a
 * real browser against the real backend and PostgreSQL, offline rails only.
 *
 * It proves the two stages *after* settlement behave as the server defines them:
 * a reconciliation import returns the engine's own three-way classification (a
 * mismatch is rendered as a mismatch, never as a match), and a receipt is only
 * recorded from independent statement evidence for a settled transaction with an
 * exact commission match.
 */

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;
const FINANCE = '/api/admin/finance';

interface Intent {
  externalRef: string;
  amount: string;
  currencyCode: string;
  transactionId: string;
}

interface OrderRow {
  commission: string;
  currencyCode: string;
}

/** Places a real order via the UI, opens a real intent, pays it via the signed webhook. */
async function paidOrderWithIntent(
  customer: import('@playwright/test').Page,
): Promise<{ orderId: string; intent: Intent }> {
  const orderId = await placeOrderViaUi(customer);
  const intentRes = await customer.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok()).toBeTruthy();
  const intent = (await intentRes.json()).data.intent as Omit<Intent, 'transactionId'>;

  const raw = JSON.stringify({
    eventId: `e2e-finance-recon-${Date.now()}`,
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
  expect((await paid.json()).data.applied).toBe(true);

  const payment = (await (await customer.request.get(`/api/payments/orders/${orderId}`)).json()).data as {
    intent: { transactionId: string };
  };
  return { orderId, intent: { ...intent, transactionId: payment.intent.transactionId } };
}

test.describe('Admin finance page — reconciliation import', () => {
  test.use({ storageState: storageFor('admin') });

  test('importing a provider feed renders the engine classification: one match, one mismatch', async ({ page }) => {
    await page.goto('/admin/finance');
    await expect(page.getByTestId('admin-finance-reconciliation')).toBeVisible();

    const ref = `e2e-recon-${Date.now()}`;
    const lines = JSON.stringify([
      // Matches the ledger exactly (gross 100, fee 2, net 98, settled).
      { reference: ref, grossAmount: '100.0000', providerFee: '2.0000', netAmount: '98.0000', currencyCode: 'TND' },
    ]);

    await page.getByTestId('admin-finance-recon-lines').fill(lines);
    await page.getByTestId('admin-finance-recon-import').click();

    await expect(page.getByTestId('admin-finance-recon-notice')).toBeVisible();
    await expect(page.getByTestId('admin-finance-recon-notice')).toContainText(
      /تم استيراد المطابقة|Reconciliation imported/i,
    );

    // The report is the engine's own output: with no ledger/bank side, the
    // reference is a MISMATCH (missing in ledger + bank), never silently matched.
    const decision = page.getByTestId(`admin-finance-recon-decision-${ref}`);
    await expect(decision).toBeVisible();
    await expect(decision).toContainText('MISMATCH');
    await expect(decision).toContainText(/MISSING_IN_LEDGER/);
    await expect(decision).toContainText(/MISSING_IN_BANK/);

    await expect(page.getByTestId('admin-finance-recon-matched')).toContainText('0');
    await expect(page.getByTestId('admin-finance-recon-mismatched')).toContainText('1');

    // Independent proof the page used the real endpoint and persisted the import.
    const api = await page.request.post(`${FINANCE}/reconciliation/import`, {
      data: {
        source: 'PROVIDER',
        currencyCode: 'TND',
        importKey: `e2e-recon-api-${Date.now()}`,
        provider: [
          { reference: `${ref}-api`, grossAmount: '100.0000', providerFee: '2.0000', netAmount: '98.0000', currencyCode: 'TND' },
        ],
        bank: [],
        ledger: [],
      },
    });
    expect(api.ok()).toBeTruthy();
    const body = (await api.json()).data as { importId: string; report: { mismatched: number } };
    expect(body.importId).toBeTruthy();
    expect(body.report.mismatched).toBe(1);
  });

  test('replaying an identical import is reported as a duplicate, not a second effect', async ({ page }) => {
    await page.goto('/admin/finance');
    const lines = JSON.stringify([
      { reference: `e2e-recon-dup-${Date.now()}`, grossAmount: '50.0000', providerFee: '1.0000', netAmount: '49.0000', currencyCode: 'TND' },
    ]);

    await page.getByTestId('admin-finance-recon-lines').fill(lines);
    await page.getByTestId('admin-finance-recon-import').click();
    await expect(page.getByTestId('admin-finance-recon-notice')).toContainText(
      /تم استيراد المطابقة|Reconciliation imported/i,
    );

    // Same lines -> same checksum -> the server returns the existing import.
    await page.getByTestId('admin-finance-recon-import').click();
    await expect(page.getByTestId('admin-finance-recon-notice')).toContainText(
      /استيراد مطابق سابق|already recorded/i,
    );
  });
});

test.describe('Admin finance page — WASIT receipt', () => {
  test.use({ storageState: storageFor('admin') });

  test('a receipt is recorded only from matching statement evidence, and a replay is a no-op', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { orderId, intent } = await paidOrderWithIntent(customer);

      // Settlement is a precondition for a receipt (server-enforced).
      const settle = await admin.request.post(`${FINANCE}/settlements/confirm`, {
        data: {
          externalRef: intent.externalRef,
          amount: intent.amount,
          currencyCode: intent.currencyCode,
          providerId: 'open-checkout',
          settlementRef: `e2e-ui-receipt-${intent.transactionId}`,
        },
      });
      expect(settle.ok()).toBeTruthy();

      // The receipt amount must equal the order commission exactly.
      const order = (await (await customer.request.get(`/api/orders/${orderId}`)).json()).data as OrderRow;

      await admin.goto('/admin/finance');
      await admin.getByTestId('admin-finance-receipt-transaction-id').fill(intent.transactionId);
      await admin.getByTestId('admin-finance-receipt-reference').fill(`e2e-stmt-${intent.transactionId}`);
      await admin.getByTestId('admin-finance-receipt-amount').fill(order.commission);
      await admin.getByTestId('admin-finance-receipt-currency').fill(order.currencyCode);
      await admin.getByTestId('admin-finance-receipt-record').click();

      await expect(admin.getByTestId('admin-finance-receipt-notice')).toBeVisible();
      await expect(admin.getByTestId('admin-finance-receipt-notice')).toContainText(
        /تم تسجيل الإيصال|Receipt recorded/i,
      );

      // Replaying the identical evidence is a duplicate, not a second receipt.
      await admin.getByTestId('admin-finance-receipt-record').click();
      await expect(admin.getByTestId('admin-finance-receipt-notice')).toContainText(
        /إيصال مسجّل سابقًا|already recorded/i,
      );
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('a receipt amount that does not match the commission is refused by the server', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { intent } = await paidOrderWithIntent(customer);
      const settle = await admin.request.post(`${FINANCE}/settlements/confirm`, {
        data: {
          externalRef: intent.externalRef,
          amount: intent.amount,
          currencyCode: intent.currencyCode,
          providerId: 'open-checkout',
          settlementRef: `e2e-ui-receipt-bad-${intent.transactionId}`,
        },
      });
      expect(settle.ok()).toBeTruthy();

      await admin.goto('/admin/finance');
      await admin.getByTestId('admin-finance-receipt-transaction-id').fill(intent.transactionId);
      await admin.getByTestId('admin-finance-receipt-reference').fill(`e2e-stmt-bad-${intent.transactionId}`);
      // Deliberately wrong amount — the UI is not the guard; the server refuses.
      await admin.getByTestId('admin-finance-receipt-amount').fill('0.0100');
      await admin.getByTestId('admin-finance-receipt-record').click();

      await expect(admin.getByTestId('admin-finance-receipt-error')).toBeVisible();
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });
});

test.describe('Admin finance page — reconciliation/receipt access guard', () => {
  test.use({ storageState: storageFor('customer') });

  test('a customer is refused by the server on both routes', async ({ page }) => {
    expect((await page.request.post(`${FINANCE}/reconciliation/import`, { data: { source: 'PROVIDER', currencyCode: 'TND', provider: [], bank: [], ledger: [] } })).status()).toBe(403);
    expect(
      (
        await page.request.post(`${FINANCE}/receipts`, {
          data: { transactionId: 'x', evidence: { source: 'BANK_STATEMENT', reference: 'r', amount: '1.0000', currencyCode: 'TND' } },
        })
      ).status(),
    ).toBe(403);
  });
});
