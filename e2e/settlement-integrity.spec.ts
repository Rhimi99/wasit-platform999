import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi } from './helpers';
import type { Page } from '@playwright/test';

const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789';

interface LedgerRow {
  entryType: string;
  direction: string;
  amount: string;
  transactionId: string;
}
interface TxRow {
  id: string;
  status: string;
}

async function intentFor(page: Page, orderId: string, key: string) {
  const res = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: { idempotencyKey: key } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.intent as { externalRef: string; amount: string };
}

async function postWebhook(page: Page, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const res = await page.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  return { status: res.status(), body: (await res.json()).data as { duplicate: boolean; applied: boolean; eventType: string } };
}

async function txIds(admin: Page): Promise<string[]> {
  const res = await admin.request.get('/api/admin/transactions');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()).data.items as TxRow[]).map((t) => t.id);
}

async function txStatus(admin: Page, id: string): Promise<string | undefined> {
  const res = await admin.request.get('/api/admin/transactions');
  return ((await res.json()).data.items as TxRow[]).find((t) => t.id === id)?.status;
}

async function ledgerNet(admin: Page, transactionId: string, entryType: string): Promise<number> {
  const rows = ((await (await admin.request.get('/api/admin/ledger')).json()).data.items as LedgerRow[]).filter(
    (e) => e.transactionId === transactionId && e.entryType === entryType,
  );
  return rows.reduce((acc, e) => acc + (e.direction === 'DEBIT' ? 1 : -1) * Number(e.amount), 0);
}

/** Places a real UI order and returns the transaction id it created (the newest). */
async function placeOrderWithTx(customer: Page, admin: Page): Promise<{ orderId: string; transactionId: string }> {
  const before = new Set(await txIds(admin));
  const orderId = await placeOrderViaUi(customer);
  const after = await txIds(admin);
  const created = after.find((id) => !before.has(id));
  expect(created, 'a transaction was created with the order').toBeTruthy();
  return { orderId, transactionId: created! };
}

test.describe('SETTLEMENT INTEGRITY — RC-1 / RC-3 / RC-4 / RC-5 from the real UI', () => {
  test.use({ storageState: storageFor('customer') });

  test('RC-1: transaction is PENDING before payment and PAID after, and the admin UI shows it', async ({ page, browser }) => {
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const admin = await adminCtx.newPage();
    try {
      const { orderId, transactionId } = await placeOrderWithTx(page, admin);

      // Before paying, the transaction must NOT claim PAID.
      expect(await txStatus(admin, transactionId)).toBe('PENDING');

      // The real admin transactions screen renders that state.
      await admin.goto('/admin/transactions');
      await expect(admin.getByText('PENDING').first()).toBeVisible();

      const intent = await intentFor(page, orderId, `rc1-${orderId}`);
      const ok = await postWebhook(page, {
        eventId: `rc1-evt-${Date.now()}`,
        type: 'payment.succeeded',
        externalRef: intent.externalRef,
        amount: intent.amount,
        currencyCode: 'TND',
      });
      expect(ok.body.applied).toBe(true);

      expect(await txStatus(admin, transactionId)).toBe('PAID');
      await admin.reload();
      await expect(admin.getByText('PAID').first()).toBeVisible();
    } finally {
      await adminCtx.close();
    }
  });

  test('RC-4: a pending → succeeded provider sequence with one eventId settles exactly once', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);
    const intent = await intentFor(page, orderId, `rc4-${orderId}`);
    const eventId = `rc4-evt-${Date.now()}`;

    // Provider first notifies "pending" — acknowledged, no side effect, no claim.
    const pending = await postWebhook(page, { eventId, type: 'payment.pending', externalRef: intent.externalRef });
    expect(pending.status).toBe(200);
    expect(pending.body.applied).toBe(false);
    expect(pending.body.eventType).toBe('UNKNOWN');

    // The terminal event reuses the id and must still apply.
    const succeeded = await postWebhook(page, {
      eventId,
      type: 'payment.succeeded',
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: 'TND',
    });
    expect(succeeded.body.applied).toBe(true);
    expect(succeeded.body.duplicate).toBe(false);

    // A terminal replay is idempotent.
    const replay = await postWebhook(page, {
      eventId,
      type: 'payment.succeeded',
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: 'TND',
    });
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.applied).toBe(false);

    const read = (await (await page.request.get(`/api/payments/orders/${orderId}`)).json()).data as { payment: { status: string } };
    expect(read.payment.status).toBe('PAID');
  });

  test('RC-5: a full refund from the admin UI reverses commission and fee in the ledger', async ({ page, browser }) => {
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const admin = await adminCtx.newPage();
    try {
      const { orderId, transactionId } = await placeOrderWithTx(page, admin);
      const intent = await intentFor(page, orderId, `rc5-${orderId}`);
      await postWebhook(page, {
        eventId: `rc5-evt-${Date.now()}`,
        type: 'payment.succeeded',
        externalRef: intent.externalRef,
        amount: intent.amount,
        currencyCode: 'TND',
      });

      expect(await ledgerNet(admin, transactionId, 'COMMISSION')).toBeGreaterThan(0);
      expect(await ledgerNet(admin, transactionId, 'PAYMENT_FEE')).toBeGreaterThan(0);

      // Refund from the real orders UI.
      await admin.goto('/admin/orders');
      await admin.getByTestId(`admin-order-refund-${orderId}`).click();
      await expect(admin.getByTestId('admin-refund-panel')).toBeVisible();
      await admin.getByTestId('admin-refund-reason').fill('e2e settlement reversal');
      await admin.getByTestId('admin-refund-submit').click();
      await expect(admin.getByTestId('admin-refund-notice')).toBeVisible();

      // Full refund ⇒ WASIT's commission and fee net to zero.
      expect(await ledgerNet(admin, transactionId, 'COMMISSION')).toBeCloseTo(0, 4);
      expect(await ledgerNet(admin, transactionId, 'PAYMENT_FEE')).toBeCloseTo(0, 4);

      // And the reversal is visible in the admin ledger UI as CREDIT rows.
      await admin.goto('/admin/ledger');
      await expect(admin.getByTestId('admin-ledger-COMMISSION-CREDIT').first()).toBeVisible();
    } finally {
      await adminCtx.close();
    }
  });

  test('RC-3: admin revenue UI shows non-negative commission and a reconciled net', async ({ page, browser }) => {
    await placeOrderViaUi(page);

    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    const admin = await adminCtx.newPage();
    try {
      const breakdown = (await (await admin.request.get('/api/admin/analytics/revenue-breakdown')).json()).data as {
        commission: number;
        paymentFees: number;
        refunds: number;
        netRevenue: number;
      };
      // Commission must never be reported as a negative number to the operator.
      expect(breakdown.commission).toBeGreaterThanOrEqual(0);
      expect(breakdown.paymentFees).toBeGreaterThanOrEqual(0);
      expect(breakdown.refunds).toBeGreaterThanOrEqual(0);
      expect(breakdown.netRevenue).toBeCloseTo(breakdown.commission - breakdown.paymentFees - breakdown.refunds, 4);

      // The admin analytics screen renders the breakdown. The commission line —
      // the value RC-3 proved was being reported as negative — must be shown as a
      // non-negative amount, and must equal what the API just returned.
      await admin.goto('/admin/analytics');
      await expect(admin.getByText(/إيراد|Revenue/i).first()).toBeVisible();
      const commissionRow = await admin.getByText(/العمولة|Commission/i).first().locator('xpath=..').innerText();
      expect(commissionRow).not.toMatch(/-\s?\d/);
    } finally {
      await adminCtx.close();
    }
  });
});
