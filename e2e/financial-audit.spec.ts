import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * Financial chain audit — Order → Commission → Ledger → Payment → Refund,
 * driven through the real UI against the real backend and PostgreSQL.
 *
 * The frozen commission model is 4% = 2% seller + 2% buyer. These tests assert
 * the real numbers (never HTTP 200): every monetary figure is recomputed from
 * the order's own itemsTotal and compared against the API, the ledger and the UI.
 */

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;

interface LedgerRow {
  transactionId: string;
  entryType: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  payerId?: string | null;
  beneficiaryId?: string | null;
  metadata?: { share?: string; rate?: string; policyId?: string | null } | null;
}

interface OrderRow {
  itemsTotal: string;
  commission: string;
  buyerCommission: string;
  grandTotal: string;
  currencyCode: string;
}

interface TransactionRow {
  id: string;
  totalValue: string;
  commission: string;
  buyerCommission?: string;
  paymentFee: string;
  status: string;
}

/**
 * The newest transaction whose figures match a just-placed order.
 * `transactions.total_value` stores the order's grand total (items + buyer
 * commission), so that is what we match on.
 */
async function findTransactionFor(
  adminPage: import('@playwright/test').Page,
  order: OrderRow,
): Promise<TransactionRow> {
  const items = ((await (await adminPage.request.get('/api/admin/transactions')).json()).data as { items: TransactionRow[] }).items;
  const match = items.find(
    (t) => Number(t.totalValue) === Number(order.grandTotal) && Number(t.buyerCommission) === Number(order.buyerCommission),
  );
  expect(match, 'transaction row for the placed order').toBeTruthy();
  return match!;
}

test.describe('Financial chain — order, commission, ledger, payment, refund', () => {
  test.use({ storageState: storageFor('customer') });

  test('reconciles to the frozen 4% policy (2% seller + 2% buyer) end to end', async ({ page, browser }) => {
    const orderId = await placeOrderViaUi(page);

    const order = (await (await page.request.get(`/api/orders/${orderId}`)).json()).data as OrderRow;
    const itemsTotal = Number(order.itemsTotal);
    expect(itemsTotal).toBeGreaterThan(0);

    // 1) Commission numbers: total 4%, buyer 2%, grand total = items + buyer 2%.
    expect(Number(order.commission)).toBeCloseTo(itemsTotal * 0.04, 4);
    expect(Number(order.buyerCommission)).toBeCloseTo(itemsTotal * 0.02, 4);
    expect(Number(order.grandTotal)).toBeCloseTo(itemsTotal * 1.02, 4);

    // 2) The order-detail UI renders the server's commission figure.
    await page.goto(`/dashboard/orders/${orderId}`);
    await expect(page.getByText(/عمولة وسيط|WASIT commission/i).first()).toBeVisible();
    const commissionText = order.commission.replace(/\.?0+$/, '');
    await expect(page.getByTestId('order-status')).toBeVisible();
    await expect(page.getByText(new RegExp(commissionText.replace('.', '[.,]'))).first()).toBeVisible();

    // A customer must not read the staff ledger (real RBAC, not a hidden button).
    expect((await page.request.get('/api/admin/ledger')).status()).toBe(403);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    try {
      // The order detail response deliberately exposes no transaction id (no
      // internal id leakage on a buyer-scoped read); resolve it from the staff
      // transactions list by matching the order's own figures.
      const txn = await findTransactionFor(adminPage, order);
      const transactionId = txn.id;

      // 3) Ledger rows for this transaction reconcile exactly.
      const rows = ((await (await adminPage.request.get('/api/admin/ledger')).json()).data as { items: LedgerRow[] }).items
        .filter((e) => e.transactionId === transactionId);

      const sellerShare = rows.find((e) => e.entryType === 'COMMISSION' && e.metadata?.share === 'SELLER');
      const buyerShare = rows.find((e) => e.entryType === 'COMMISSION' && e.metadata?.share === 'BUYER');
      const tradeCredit = rows.find((e) => e.entryType === 'TRANSACTION_VALUE');
      expect(sellerShare, 'seller commission ledger entry').toBeTruthy();
      expect(buyerShare, 'buyer commission ledger entry').toBeTruthy();
      expect(tradeCredit, 'trade value credit').toBeTruthy();

      expect(tradeCredit!.direction).toBe('CREDIT');
      expect(Number(tradeCredit!.amount)).toBeCloseTo(itemsTotal, 4);
      expect(sellerShare!.direction).toBe('DEBIT');
      expect(buyerShare!.direction).toBe('DEBIT');
      expect(Number(sellerShare!.amount)).toBeCloseTo(itemsTotal * 0.02, 4);
      expect(Number(buyerShare!.amount)).toBeCloseTo(itemsTotal * 0.02, 4);
      // Both shares must add back up to the order's total commission (the 4%).
      expect(Number(sellerShare!.amount) + Number(buyerShare!.amount)).toBeCloseTo(Number(order.commission), 4);
      // Each share carries the frozen 2% rate from the stored policy.
      expect(Number(sellerShare!.metadata!.rate)).toBeCloseTo(0.02, 6);
      expect(Number(buyerShare!.metadata!.rate)).toBeCloseTo(0.02, 6);
      expect(sellerShare!.metadata!.policyId).toBeTruthy();

      // 4) Payment: settle the intent through the signed webhook, then confirm PAID.
      const intent = (await (await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} })).json()).data as {
        intent: { externalRef: string };
      };
      const payload = { eventId: `e2e-fin-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.intent.externalRef };
      const rawPayload = JSON.stringify(payload);
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawPayload, 'utf8').digest('hex');
      const webhook = await page.request.post('/api/payment-webhooks', {
        headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
        data: rawPayload,
      });
      expect(webhook.ok()).toBeTruthy();
      const paidOrder = (await (await page.request.get(`/api/orders/${orderId}`)).json()).data as { paymentStatus: string };
      expect(paidOrder.paymentStatus).toBe('PAID');

      // 5) Refund as admin → a REFUND DEBIT is appended for the same transaction.
      const refund = await adminPage.request.post(`/api/payments/orders/${orderId}/refunds`, {
        data: { reason: 'financial audit e2e', idempotencyKey: `e2e-fin-rf-${orderId}` },
      });
      expect(refund.ok()).toBeTruthy();
      expect((await refund.json()).data.refund.status).toBe('COMPLETED');

      const afterRows = ((await (await adminPage.request.get('/api/admin/ledger')).json()).data as { items: LedgerRow[] }).items;
      const refundRow = afterRows.find((e) => e.transactionId === transactionId && e.entryType === 'REFUND');
      expect(refundRow, 'refund ledger entry').toBeTruthy();
      expect(refundRow!.direction).toBe('DEBIT');

      // 6) The admin ledger UI renders this transaction's rows, count-consistent with the API.
      await adminPage.goto('/admin/ledger');
      await expect(adminPage.getByTestId('admin-ledger-COMMISSION-DEBIT').first()).toBeVisible();
      const uiCommission = await adminPage.locator('[data-testid="admin-ledger-COMMISSION-DEBIT"]').count();
      const apiCommission = afterRows.filter((e) => e.entryType === 'COMMISSION' && e.direction === 'DEBIT').length;
      expect(uiCommission).toBe(apiCommission);
      await expect(adminPage.getByTestId('admin-ledger-REFUND-DEBIT').first()).toBeVisible();
    } finally {
      await adminCtx.close();
    }
  });

  test('admin transactions view reports the same 4% split the order was written with', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const customerPage = await customerCtx.newPage();
    let order: OrderRow;
    try {
      const orderId = await placeOrderViaUi(customerPage);
      order = (await (await customerPage.request.get(`/api/orders/${orderId}`)).json()).data as OrderRow;
    } finally {
      await customerCtx.close();
    }

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    try {
      const txn = await findTransactionFor(adminPage, order);
      expect(Number(txn.commission)).toBeCloseTo(Number(order.itemsTotal) * 0.04, 4);
      expect(Number(txn.buyerCommission)).toBeCloseTo(Number(order.itemsTotal) * 0.02, 4);
    } finally {
      await adminCtx.close();
    }
  });
});
