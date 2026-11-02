import { createHmac, randomUUID } from 'node:crypto';
import { request, type Page } from '@playwright/test';
import { test, expect, storageFor, placeOrderViaUi, E2E_WEBHOOK_SECRET } from './helpers';

/**
 * N2 — the admin money-movement HTTP surface: `/api/admin/finance/settlements/confirm`
 * and `/api/admin/finance/payouts*`, exercised over the real backend and PostgreSQL
 * with the offline rails only (no external acquirer, no real money).
 *
 * The server integration suite (`tests/finance-routes.test.ts`) drives these routes
 * through `app.request`. This spec proves the same guarantees hold for a real HTTP
 * client with real sessions: the mount guard (`/api/admin` ⇒ ADMIN/SUPER_ADMIN)
 * refuses everyone else, settlement is evidence-gated and idempotent, and a payout
 * cannot be forced to COMPLETED without the rail's transfer evidence.
 */

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const FINANCE = '/api/admin/finance';
const EMPTY_STATE = { cookies: [], origins: [] };

interface LedgerRow {
  transactionId: string;
  entryType: string;
  direction: string;
  amount: string;
  status: string;
  metadata: { settlementRef?: string } | null;
}

interface OrderRow {
  itemsTotal: string;
  commission: string;
  buyerCommission: string;
  currencyCode: string;
}

/** Places a real order through the UI and opens a real payment intent on it. */
async function placedOrderWithIntent(customer: Page) {
  const orderId = await placeOrderViaUi(customer);
  const res = await customer.request.post(`/api/payments/orders/${orderId}/intent`, { data: {} });
  expect(res.ok()).toBeTruthy();
  const intent = (await res.json()).data.intent as {
    externalRef: string;
    amount: string;
    currencyCode: string;
    provider: string;
  };
  return { orderId, intent };
}

/** Confirms a payment through the signed webhook — the real (offline) payment rail. */
async function payViaWebhook(
  customer: Page,
  intent: { externalRef: string; amount: string; currencyCode: string },
  tag: string,
): Promise<void> {
  const raw = JSON.stringify({
    eventId: `e2e-finance-${tag}-${Date.now()}`,
    type: 'payment.succeeded',
    externalRef: intent.externalRef,
    amount: intent.amount,
    currencyCode: intent.currencyCode,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const res = await customer.request.post('/api/payment-webhooks', {
    headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
    data: raw,
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).data.applied).toBe(true);
}

async function ledgerRows(admin: Page): Promise<LedgerRow[]> {
  const res = await admin.request.get('/api/admin/ledger');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.items as LedgerRow[];
}

/** A paid order plus a confirmed settlement, with the transaction located from the ledger. */
async function settledOrder(customer: Page, admin: Page, tag: string) {
  const { orderId, intent } = await placedOrderWithIntent(customer);
  await payViaWebhook(customer, intent, tag);

  const settlementRef = `e2e-settle-${tag}-${orderId}`;
  const res = await admin.request.post(`${FINANCE}/settlements/confirm`, {
    data: {
      externalRef: intent.externalRef,
      amount: intent.amount,
      currencyCode: intent.currencyCode,
      providerId: 'open-checkout',
      settlementRef,
    },
  });
  expect(res.ok()).toBeTruthy();
  const result = (await res.json()).data as { applied: boolean; duplicate: boolean; settlementEntryId: string | null };
  expect(result.applied).toBe(true);
  expect(result.duplicate).toBe(false);

  const entry = (await ledgerRows(admin)).find(
    (e) => e.entryType === 'SETTLEMENT' && e.metadata?.settlementRef === settlementRef,
  );
  expect(entry, 'SETTLEMENT ledger entry for the confirmed reference').toBeTruthy();

  const order = (await (await customer.request.get(`/api/orders/${orderId}`)).json()).data as OrderRow;
  return { orderId, intent, settlementRef, transactionId: entry!.transactionId, order };
}

test.describe('Admin finance — authentication and authorization', () => {
  test.use({ storageState: storageFor('admin') });

  test('an unauthenticated caller is refused on every money-movement route', async () => {
    const anon = await request.newContext({ baseURL: API_URL, storageState: EMPTY_STATE });
    try {
      expect((await anon.get(`${FINANCE}/payout-providers`)).status()).toBe(401);
      expect(
        (
          await anon.post(`${FINANCE}/settlements/confirm`, {
            data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout', settlementRef: 'r' },
          })
        ).status(),
      ).toBe(401);
      expect((await anon.post(`${FINANCE}/payouts`, { data: { transactionId: 'x', providerId: 'sandbox' } })).status()).toBe(401);
      expect((await anon.get(`${FINANCE}/payouts/${randomUUID()}`)).status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test('a CUSTOMER is refused with 403 (role guard, not a hidden button)', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageFor('customer') });
    try {
      const page = await ctx.newPage();

      expect((await page.request.get(`${FINANCE}/payout-providers`)).status()).toBe(403);
      expect(
        (
          await page.request.post(`${FINANCE}/settlements/confirm`, {
            data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout', settlementRef: 'r' },
          })
        ).status(),
      ).toBe(403);
      expect((await page.request.post(`${FINANCE}/payouts`, { data: { transactionId: 'x', providerId: 'sandbox' } })).status()).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  test('a MERCHANT is refused with 403 even though it holds payment:read', async ({ browser }) => {
    // The `/api/admin` mount guard requires the ADMIN/SUPER_ADMIN *role*. A merchant
    // carries `payment:read`, so a permission-only guard would let it through — this
    // asserts the role gate is what actually protects the money-movement routes.
    const ctx = await browser.newContext({ storageState: storageFor('merchant') });
    try {
      const page = await ctx.newPage();

      expect((await page.request.get(`${FINANCE}/payout-providers`)).status()).toBe(403);
      expect((await page.request.post(`${FINANCE}/payouts`, { data: { transactionId: 'x', providerId: 'sandbox' } })).status()).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  test('an ADMIN and a SUPER_ADMIN are both accepted, and the rail list is real', async ({ browser }) => {
    const adminCtx = await browser.newContext({ storageState: storageFor('admin2') }); // ADMIN
    const superCtx = await browser.newContext({ storageState: storageFor('admin') }); // SUPER_ADMIN
    try {
      for (const page of [await adminCtx.newPage(), await superCtx.newPage()]) {
        const res = await page.request.get(`${FINANCE}/payout-providers`);
        expect(res.status()).toBe(200);
        const providers = (await res.json()).data.providers as Array<{ id: string; available: boolean }>;
        expect(Array.isArray(providers)).toBe(true);
        expect(providers.some((p) => p.id === 'sandbox')).toBe(true);
      }
    } finally {
      await adminCtx.close();
      await superCtx.close();
    }
  });
});

test.describe('Admin finance — settlement confirmation', () => {
  test.use({ storageState: storageFor('admin') });

  test('rejects evidence without a transfer reference (422)', async ({ page }) => {
    const res = await page.request.post(`${FINANCE}/settlements/confirm`, {
      data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout' },
    });
    expect(res.status()).toBe(422);
  });

  test('rejects a malformed currency code (422)', async ({ page }) => {
    const res = await page.request.post(`${FINANCE}/settlements/confirm`, {
      data: { externalRef: 'x', amount: '1.0000', currencyCode: 'TNDX', providerId: 'open-checkout', settlementRef: 'r' },
    });
    expect(res.status()).toBe(422);
  });

  test('refuses evidence for an unknown payment intent (404)', async ({ page }) => {
    const res = await page.request.post(`${FINANCE}/settlements/confirm`, {
      data: {
        externalRef: `unknown-${Date.now()}`,
        amount: '1.0000',
        currencyCode: 'TND',
        providerId: 'open-checkout',
        settlementRef: `e2e-unknown-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(404);
  });

  test('refuses to settle an intent whose payment is not confirmed (409)', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { intent } = await placedOrderWithIntent(customer); // intent created, never paid
      const res = await admin.request.post(`${FINANCE}/settlements/confirm`, {
        data: {
          externalRef: intent.externalRef,
          amount: intent.amount,
          currencyCode: intent.currencyCode,
          providerId: 'open-checkout',
          settlementRef: `e2e-unpaid-${Date.now()}`,
        },
      });
      expect(res.status()).toBe(409);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('confirms a settlement once, replays idempotently, and refuses a different reference', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { orderId, intent } = await placedOrderWithIntent(customer);
      await payViaWebhook(customer, intent, 'settle-once');
      const settlementRef = `e2e-once-${orderId}`;
      const evidence = {
        externalRef: intent.externalRef,
        amount: intent.amount,
        currencyCode: intent.currencyCode,
        providerId: 'open-checkout',
        settlementRef,
      };

      const first = await admin.request.post(`${FINANCE}/settlements/confirm`, { data: evidence });
      expect(first.ok()).toBeTruthy();
      expect((await first.json()).data).toMatchObject({ applied: true, duplicate: false });

      // A provider retry with the same reference is a no-op, not a second settlement.
      const replay = await admin.request.post(`${FINANCE}/settlements/confirm`, { data: evidence });
      expect(replay.ok()).toBeTruthy();
      expect((await replay.json()).data).toMatchObject({ applied: false, duplicate: true });

      // Exactly one SETTLEMENT entry exists, and it is SETTLED with the right amount.
      const rows = (await ledgerRows(admin)).filter((e) => e.entryType === 'SETTLEMENT' && e.metadata?.settlementRef === settlementRef);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('SETTLED');
      expect(rows[0].direction).toBe('CREDIT');
      expect(Number(rows[0].amount)).toBeCloseTo(Number(intent.amount), 4);

      // The order is promoted to SETTLED — observable through the real read path.
      const order = (await (await customer.request.get(`/api/orders/${orderId}`)).json()).data as { settlementStatus: string };
      expect(order.settlementStatus).toBe('SETTLED');

      // A *different* reference against an already-settled transaction is a conflict.
      const different = await admin.request.post(`${FINANCE}/settlements/confirm`, {
        data: { ...evidence, settlementRef: `e2e-once-alt-${orderId}` },
      });
      expect(different.status()).toBe(409);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });
});

test.describe('Admin finance — seller payouts', () => {
  test.use({ storageState: storageFor('admin') });

  test('rejects a payout for an unsettled transaction (settlement is a precondition)', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      // Paid but NOT settled ⇒ no SETTLEMENT ledger entry ⇒ not payable.
      const { orderId, intent } = await placedOrderWithIntent(customer);
      await payViaWebhook(customer, intent, 'unsettled');

      // The transaction id is read from this order's own payment intent — exact and
      // unambiguous, unlike matching an amount that many orders can share.
      const payment = (await (await customer.request.get(`/api/payments/orders/${orderId}`)).json()).data as {
        intent: { transactionId: string };
      };
      const transactionId = payment.intent.transactionId;
      expect(transactionId, 'transaction id for the paid order').toBeTruthy();

      const res = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'sandbox' } });
      expect(res.status()).toBe(409);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('creates a payout whose amount is derived (never supplied) from the frozen 4% policy', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { transactionId, order } = await settledOrder(customer, admin, 'payout-amount');

      const res = await admin.request.post(`${FINANCE}/payouts`, {
        data: { transactionId, providerId: 'sandbox', idempotencyKey: `e2e-payout-${transactionId}` },
      });
      expect(res.ok()).toBeTruthy();
      const payout = (await res.json()).data as { id: string; status: string; amount: string; currencyCode: string };

      expect(payout.status).toBe('CREATED');
      // Seller net = items total − seller share of the 4% (2%). The caller never
      // sends an amount, so this cannot be inflated.
      const itemsTotal = Number(order.itemsTotal);
      const sellerShare = Number(order.commission) - Number(order.buyerCommission);
      expect(Number(payout.amount)).toBeCloseTo(itemsTotal - sellerShare, 4);
      expect(Number(payout.amount)).toBeLessThan(itemsTotal);

      // Replaying the same idempotency key returns the same payout, not a second one.
      const replay = await admin.request.post(`${FINANCE}/payouts`, {
        data: { transactionId, providerId: 'sandbox', idempotencyKey: `e2e-payout-${transactionId}` },
      });
      expect(replay.ok()).toBeTruthy();
      expect((await replay.json()).data.id).toBe(payout.id);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('refuses a provider that cannot execute a payout (422) and an unknown provider (422)', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { transactionId } = await settledOrder(customer, admin, 'payout-provider');

      // `manual` is a payment desk with payout:false — it must not be usable as a rail.
      const incapable = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'manual' } });
      expect(incapable.status()).toBe(422);

      const unknown = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'not-a-rail' } });
      expect(unknown.status()).toBe(422);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('reads a payout by id and returns 404 for an unknown one', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { transactionId } = await settledOrder(customer, admin, 'payout-read');
      const created = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'sandbox' } });
      const payoutId = (await created.json()).data.id as string;

      const read = await admin.request.get(`${FINANCE}/payouts/${payoutId}`);
      expect(read.status()).toBe(200);
      expect((await read.json()).data.id).toBe(payoutId);

      const missing = await admin.request.get(`${FINANCE}/payouts/${randomUUID()}`);
      expect(missing.status()).toBe(404);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('dispatch reaches PROCESSING and never COMPLETED, and sync cannot force completion', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { transactionId } = await settledOrder(customer, admin, 'payout-dispatch');
      const created = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'sandbox' } });
      const payoutId = (await created.json()).data.id as string;
      expect((await created.json()).data.status).toBe('CREATED');

      // Missing beneficiary reference is a validation error.
      const invalid = await admin.request.post(`${FINANCE}/payouts/${payoutId}/dispatch`, { data: {} });
      expect(invalid.status()).toBe(422);

      const dispatched = await admin.request.post(`${FINANCE}/payouts/${payoutId}/dispatch`, {
        data: { beneficiaryRef: 'e2e-beneficiary-1' },
      });
      expect(dispatched.ok()).toBeTruthy();
      const dispatchedPayout = (await dispatched.json()).data.payout as { status: string };
      expect(dispatchedPayout.status).toBe('PROCESSING');
      expect(dispatchedPayout.status).not.toBe('COMPLETED');

      // Re-dispatching is idempotent at the rail: still PROCESSING, same payout.
      const again = await admin.request.post(`${FINANCE}/payouts/${payoutId}/dispatch`, {
        data: { beneficiaryRef: 'e2e-beneficiary-1' },
      });
      expect(again.ok()).toBeTruthy();
      expect((await again.json()).data.payout.status).toBe('PROCESSING');

      // Sync asks the rail; with no transfer evidence the payout must NOT complete.
      const synced = await admin.request.post(`${FINANCE}/payouts/${payoutId}/sync`, { data: {} });
      expect(synced.ok()).toBeTruthy();
      const syncedPayout = (await synced.json()).data.payout as { status: string };
      expect(syncedPayout.status).toBe('PROCESSING');

      // The persisted state agrees: never COMPLETED without proof.
      const persisted = await admin.request.get(`${FINANCE}/payouts/${payoutId}`);
      expect((await persisted.json()).data.status).toBe('PROCESSING');
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });

  test('a second active payout for the same transaction is refused (409)', async ({ browser }) => {
    const customerCtx = await browser.newContext({ storageState: storageFor('customer') });
    const adminCtx = await browser.newContext({ storageState: storageFor('admin') });
    try {
      const customer = await customerCtx.newPage();
      const admin = await adminCtx.newPage();

      const { transactionId } = await settledOrder(customer, admin, 'payout-dupe');
      const first = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'sandbox' } });
      expect(first.ok()).toBeTruthy();

      // No idempotency key ⇒ the unique "one active payout per transaction" index
      // rejects the duplicate rather than silently paying twice.
      const second = await admin.request.post(`${FINANCE}/payouts`, { data: { transactionId, providerId: 'sandbox' } });
      expect(second.status()).toBe(409);
    } finally {
      await customerCtx.close();
      await adminCtx.close();
    }
  });
});
