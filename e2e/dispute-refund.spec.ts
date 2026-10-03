import { createHmac } from 'node:crypto';
import { test, expect, storageFor, placeOrderViaUi, type Page, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * P6 — a dispute decided in the buyer's favour must move real money.
 *
 * The assertion is deliberately end-to-end: an order is placed and paid through
 * the UI, the dispute is raised from the buyer's UI and decided from the admin
 * UI, and then the order and the admin ledger are read back. A handler that only
 * flipped `status = DECIDED` would pass a status check but fail every money
 * assertion below.
 */

async function paidOrder(page: Page): Promise<string> {
  const orderId = await placeOrderViaUi(page);
  const intentRes = await page.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(intentRes.ok()).toBeTruthy();
  const intent = (await intentRes.json()).data;
  const raw = JSON.stringify({
    eventId: `e2e-dispute-refund-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef: intent.intent.externalRef,
  });
  const signature = createHmac('sha256', E2E_WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const settled = await page.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  expect(settled.ok()).toBeTruthy();
  return orderId;
}

async function openDispute(buyerPage: Page, orderId: string, note: string): Promise<string> {
  await buyerPage.goto('/dashboard/disputes');
  await buyerPage.getByTestId('dispute-order').selectOption(orderId);
  await buyerPage.getByTestId('dispute-reason').selectOption('NOT_AS_DESCRIBED');
  await buyerPage.getByTestId('dispute-description').fill(note);
  // Capture the creation response rather than polling the list afterwards: the
  // submit handler is async, and the note text is not unique across runs (the
  // list already holds earlier disputes with the same wording), so neither an
  // immediate read nor a text wait reliably identifies *this* dispute.
  const [createRes] = await Promise.all([
    buyerPage.waitForResponse(
      (r) => r.url().includes('/api/disputes') && r.request().method() === 'POST',
    ),
    buyerPage.getByTestId('dispute-create-submit').click(),
  ]);
  expect(createRes.ok(), 'creating the dispute must succeed').toBeTruthy();
  const created = ((await createRes.json()) as { data: { id: string } }).data;
  // The create response carries only the id; read the dispute back to prove it is
  // the one opened for this order.
  const detail = (await (await buyerPage.request.get(`/api/disputes/${created.id}`)).json()) as {
    data: { orderId: string };
  };
  expect(detail.data.orderId).toBe(orderId);
  return created.id;
}

async function decide(adminPage: Page, disputeId: string, decision: string, note: string): Promise<void> {
  await adminPage.goto('/admin/disputes');
  await adminPage.getByTestId(`admin-dispute-${disputeId}`).click();
  // The detail panel is fetched on selection; the decision controls only exist
  // once it has rendered, so selecting a value before that silently no-ops.
  const select = adminPage.getByTestId('admin-dispute-decision-select');
  await expect(select).toBeVisible({ timeout: 15_000 });
  await select.selectOption(decision);
  await adminPage.getByTestId('admin-dispute-decision-note').fill(note);
  await adminPage.getByTestId('admin-dispute-decide-submit').click();
  // The decide POST is async; wait for the panel to reflect the decision rather
  // than assuming a fixed delay is enough.
  await expect
    .poll(async () => {
      const res = await adminPage.request.get(`/api/admin/disputes/${disputeId}`);
      return ((await res.json()).data as { decision: string }).decision;
    }, { timeout: 15_000 })
    .toBe(decision);
}

test.describe('P6 — dispute decided for the buyer refunds through the real rail', () => {
  test('IN_FAVOR_OF_BUYER returns the money and records it in the ledger', async ({ browser }) => {
    const buyer = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyer.newPage();
    const orderId = await paidOrder(buyerPage);
    const disputeId = await openDispute(buyerPage, orderId, 'E2E: product does not match the description.');

    const admin = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await admin.newPage();
    await decide(adminPage, disputeId, 'IN_FAVOR_OF_BUYER', 'E2E: buyer-favourable decision.');

    // The decision reached the backend and drove the refund rail.
    const dispute = await (await adminPage.request.get(`/api/admin/disputes/${disputeId}`)).json();
    expect((dispute.data as { decision: string }).decision).toBe('IN_FAVOR_OF_BUYER');

    // Read the order back as the buyer — a party, so the detail is theirs to see.
    const order = await (await buyerPage.request.get(`/api/orders/${orderId}`)).json();
    const refunded = order.data as { refundStatus: string; paymentStatus: string; buyerId: string };
    expect(refunded.refundStatus, 'a buyer-favourable decision must drive the refund rail').toBe('COMPLETED');
    expect(refunded.paymentStatus).toBe('REFUNDED');

    // The ledger carries a REFUND DEBIT back to the buyer, proving the
    // compensating entries were written rather than just the order status flipped.
    const ledger = await (await adminPage.request.get('/api/admin/ledger')).json();
    const entries = (ledger.data?.items ?? ledger.data ?? []) as {
      entryType: string;
      direction: string;
      beneficiaryId: string | null;
    }[];
    expect(
      entries.some((e) => e.entryType === 'REFUND' && e.direction === 'DEBIT' && e.beneficiaryId === refunded.buyerId),
      'the buyer must have a REFUND DEBIT ledger entry',
    ).toBe(true);

    await buyer.close();
    await admin.close();
  });

  test('a second decision on the same dispute is refused, so the buyer cannot be refunded twice', async ({ browser }) => {
    const buyer = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyer.newPage();
    const orderId = await paidOrder(buyerPage);
    const disputeId = await openDispute(buyerPage, orderId, 'E2E: idempotency check.');

    const admin = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await admin.newPage();
    await decide(adminPage, disputeId, 'IN_FAVOR_OF_BUYER', 'E2E: first decision.');

    const replay = await adminPage.request.post(`/api/admin/disputes/${disputeId}/decide`, {
      data: { decision: 'IN_FAVOR_OF_BUYER', note: 'E2E: replay.' },
    });
    expect(replay.status(), 'deciding an already-decided dispute must conflict').toBe(409);

    const order = await (await buyerPage.request.get(`/api/orders/${orderId}`)).json();
    expect((order.data as { refundStatus: string }).refundStatus).toBe('COMPLETED');

    await buyer.close();
    await admin.close();
  });
});

test.describe('P6 — a seller-favourable decision moves no money', () => {
  test('IN_FAVOR_OF_SELLER leaves the order paid and the buyer unrefunded', async ({ browser }) => {
    const buyer = await browser.newContext({ storageState: storageFor('customer') });
    const buyerPage = await buyer.newPage();
    const orderId = await paidOrder(buyerPage);
    const disputeId = await openDispute(buyerPage, orderId, 'E2E: seller-favourable decision.');

    const admin = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await admin.newPage();
    await decide(adminPage, disputeId, 'IN_FAVOR_OF_SELLER', 'E2E: seller-favourable decision.');

    const order = await (await buyerPage.request.get(`/api/orders/${orderId}`)).json();
    const data = order.data as { paymentStatus: string; refundStatus: string };
    expect(data.paymentStatus).toBe('PAID');
    expect(data.refundStatus).toBe('NONE');

    await buyer.close();
    await admin.close();
  });
});
