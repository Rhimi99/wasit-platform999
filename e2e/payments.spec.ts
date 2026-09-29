import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;

test.describe('Payment kernel (real API, offline provider)', () => {
  test.use({ storageState: storageFor('customer') });

  test('exposes provider/method capabilities and records the chosen method', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);

    // The methods endpoint describes every provider and what is usable now.
    const methodsRes = await page.request.get('/api/payments/methods');
    expect(methodsRes.ok()).toBeTruthy();
    const caps = (await methodsRes.json()).data as {
      active: string;
      providers: { id: string; available: boolean; methods: { method: { type: string }; available: boolean }[] }[];
    };
    expect(caps.active).toBe('manual');
    const manual = caps.providers.find((p) => p.id === 'manual')!;
    expect(manual.available).toBe(true);
    expect(manual.methods.some((m) => m.method.type === 'CARD')).toBe(true);
    expect(manual.methods.some((m) => m.method.type === 'MOBILE_WALLET')).toBe(true);
    // Online acquirers are listed but unavailable without credentials — never faked.
    expect(caps.providers.find((p) => p.id === 'flouci')).toBeTruthy();
    expect(caps.providers.find((p) => p.id === 'flouci')!.available).toBe(false);

    // Starting a payment with an explicit method persists it on the intent.
    const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, {
      data: { method: { type: 'MOBILE_WALLET', scheme: 'FLOUCI_WALLET' }, idempotencyKey: `e2e-method-${orderId}` },
    });
    expect(intentRes.ok()).toBeTruthy();
    const intent = (await intentRes.json()).data;
    expect(intent.intent.provider).toBe('manual');

    const read = await page.request.get(`/api/payments/orders/${orderId}`);
    const readBody = await read.json();
    expect(readBody.data.intent.method).toBe('MOBILE_WALLET');
    expect(readBody.data.intent.scheme).toBe('FLOUCI_WALLET');
  });

  test('rejects an unsupported method with a validation error', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);
    // CARD+JCB is not a valid scheme; zod rejects it before any provider call.
    const bad = await page.request.post(`/api/payments/orders/${orderId}/intent`, {
      data: { method: { type: 'CARD', scheme: 'JCB' } },
    });
    expect(bad.status()).toBe(422);
  });

  test('customer starts a payment intent from checkout and the server records it', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);

    await page.getByTestId('start-payment').click();
    // Manual/offline provider returns no hosted redirect; the UI shows the awaiting state.
    await expect(page.getByText(/في انتظار تأكيد الدفع|Awaiting payment confirmation/i).first()).toBeVisible();

    const intentRes = await page.request.get(`/api/payments/orders/${orderId}`);
    expect(intentRes.ok()).toBeTruthy();
    const intentBody = await intentRes.json();
    expect(intentBody.data.intent.provider).toBe('manual');
    expect(intentBody.data.intent.status).toBe('PENDING');
    expect(intentBody.data.payment.status).toBe('PENDING');
  });

  test('starting payment twice with the same key never creates a second intent', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);

    const first = await page.request.post(`/api/payments/orders/${orderId}/intent`, {
      data: { idempotencyKey: `e2e-${orderId}` },
    });
    const second = await page.request.post(`/api/payments/orders/${orderId}/intent`, {
      data: { idempotencyKey: `e2e-${orderId}` },
    });
    expect(first.ok()).toBeTruthy();
    expect(second.ok()).toBeTruthy();
    const a = await first.json();
    const b = await second.json();
    expect(b.data.reused).toBe(true);
    expect(b.data.intent.id).toBe(a.data.intent.id);
  });

  test('a signed webhook settles the payment and an unsigned one is rejected', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);
    const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
    const intent = (await intentRes.json()).data;
    const externalRef = intent.intent.externalRef as string;

    // Forged signature is refused before any side effect.
    const forgedBody = JSON.stringify({ eventId: `e2e-forged-${Date.now()}`, type: 'payment.succeeded', externalRef });
    const forged = await page.request.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': 'deadbeef' },
      data: forgedBody,
    });
    expect(forged.status()).toBe(401);

    const payload = { eventId: `e2e-${Date.now()}`, type: 'payment.succeeded', externalRef, amount: intent.intent.amount, currencyCode: 'TND' };
    const raw = JSON.stringify(payload);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
    const ok = await page.request.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
      data: raw,
    });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).data.applied).toBe(true);

    const after = await page.request.get(`/api/payments/orders/${orderId}`);
    const afterBody = await after.json();
    expect(afterBody.data.intent.status).toBe('SUCCEEDED');
    expect(afterBody.data.payment.status).toBe('PAID');

    // Replaying the same event id is an idempotent no-op.
    const replay = await page.request.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
      data: raw,
    });
    expect((await replay.json()).data.duplicate).toBe(true);
  });

  test('a customer cannot refund; an admin refunds and the ledger records the DEBIT', async ({ page }) => {
    // Order + payment as the customer.
    const orderId = await placeOrderViaUi(page);
    const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
    const intent = (await intentRes.json()).data;
    const payload = { eventId: `e2e-pay-${Date.now()}`, type: 'payment.succeeded', externalRef: intent.intent.externalRef };
    const raw = JSON.stringify(payload);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
    await page.request.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
      data: raw,
    });

    // RBAC: the customer has no refund:manage permission.
    const forbidden = await page.request.post(`/api/payments/orders/${orderId}/refunds`, { data: {} });
    expect(forbidden.status()).toBe(403);

    // Operator (admin) logs in and refunds the order.
    const adminCtx = await page.context().browser()!.newContext({ storageState: storageFor('admin') });
    const adminPage = await adminCtx.newPage();
    const refund = await adminPage.request.post(`/api/payments/orders/${orderId}/refunds`, {
      data: { reason: 'e2e refund', idempotencyKey: `e2e-rf-${orderId}` },
    });
    expect(refund.ok()).toBeTruthy();
    expect((await refund.json()).data.refund.status).toBe('COMPLETED');

    // The ledger now carries a REFUND DEBIT for the transaction.
    const ledgerRes = await adminPage.request.get('/api/admin/ledger');
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = (await ledgerRes.json()).data.items as Array<{ entryType: string; direction: string }>;
    expect(ledger.some((e) => e.entryType === 'REFUND' && e.direction === 'DEBIT')).toBe(true);
    await adminCtx.close();
  });
});