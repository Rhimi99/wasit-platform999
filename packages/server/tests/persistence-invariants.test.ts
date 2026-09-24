import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { orders, transactionLedger } from '../src/db/schema/commerce.js';
import { payouts } from '../src/db/schema/payouts.js';
import { wasitReceipts } from '../src/db/schema/receipts.js';
import { handlePaymentWebhook } from '../src/modules/payments/service.js';
import { confirmSettlement } from '../src/modules/settlements/service.js';
import {
  applyPayoutEventToDb,
  createPayout,
} from '../src/modules/payouts/service.js';
import { recordReceipt, reverseReceiptInDb } from '../src/modules/reconciliation/receipt-service.js';
import { importReconciliationFeed } from '../src/modules/reconciliation/service.js';
import { reconcile } from '../src/modules/reconciliation/engine.js';
import {
  computeWebhookSignature,
  ManualPaymentProvider,
  OpenCheckoutPaymentProvider,
} from '../src/lib/payments/providers.js';

/**
 * Persistence invariants for the additive money layers (PS-01/PS-02/PS-04 +
 * WASIT Receipt). These exercise the REAL service + DB path (no mocks) and prove
 * that each transition needs its own evidence: PAID never writes SETTLED,
 * SETTLED never means RECEIVED, SETTLED alone never completes a Payout, and a
 * COMPLETED payout is impossible without a transfer reference.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;
const ACQUIRER = 'open-checkout';

function makeClient() {
  let cookie = '';
  return {
    async req(url: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function registerUser(c: ReturnType<typeof makeClient>, email: string, role: string) {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Persist', role },
  });
  expect(r.status).toBe(201);
}

/** Supplier + customer + a real order (20 × 15.50 = 310.00 TND). */
async function setupOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `pi-sup-${stamp}@wasit.tn`;
  const buyerEmail = `pi-buy-${stamp}@wasit.tn`;

  await registerUser(supplier, supplierEmail, 'SUPPLIER');
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  const supplierLogin = await supplier.req('/api/auth/login', {
    method: 'POST',
    body: { email: supplierEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  const buyerLogin = await buyer.req('/api/auth/login', {
    method: 'POST',
    body: { email: buyerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  const buyerUserId = (buyerLogin.data.data as { id: string }).id;
  void supplierLogin;

  const supplierProfile = await supplier.req('/api/suppliers', {
    method: 'POST',
    body: { companyName: 'Persist Test Co' },
  });
  const supplierId = supplierProfile.data.data.id;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `PISKU-${stamp}`,
      categoryId,
      name: `Persist Product ${stamp}`,
      basePrice: '15.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  const productId = product.data.data.id;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  // The order's own figures, so the tests use the real policy output.
  const orderRow = (await db.select().from(orders).where(eq(orders.id, orderData.orderId)).limit(1))[0];
  return { buyer, orderId: orderData.orderId, grandTotal: orderData.grandTotal, transactionId: orderData.transactionId, orderRow };
}

async function payAndSettle(s: Awaited<ReturnType<typeof setupOrder>>) {
  const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
  const intent = intentRes.data.data.intent as { externalRef: string; amount: string };

  const rawBody = JSON.stringify({
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'payment.succeeded',
    externalRef: intent.externalRef,
    amount: s.grandTotal,
    currencyCode: 'TND',
  });
  await handlePaymentWebhook(
    db,
    { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
    new ManualPaymentProvider(),
  );

  await confirmSettlement(db, {
    externalRef: intent.externalRef,
    amount: s.grandTotal,
    currencyCode: 'TND',
    providerId: ACQUIRER,
    settlementRef: `trf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    providerRef: `acq-${Date.now()}`,
  });
}

afterAll(async () => {
  await closeDb();
});

describe('Persistence invariants — evidence per transition', () => {
  it('PAID alone never writes a SETTLED ledger entry, and a payout cannot precede settlement', async () => {
    const s = await setupOrder();
    const intentRes = await s.buyer.req(`/api/payments/orders/${s.orderId}/intent`, { method: 'POST', body: {} });
    const intent = intentRes.data.data.intent as { externalRef: string };

    const rawBody = JSON.stringify({
      eventId: `evt-${Date.now()}-p`,
      type: 'payment.succeeded',
      externalRef: intent.externalRef,
      amount: s.grandTotal,
      currencyCode: 'TND',
    });
    await handlePaymentWebhook(
      db,
      { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
      new ManualPaymentProvider(),
    );

    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, s.transactionId));
    expect(ledger.some((l) => l.status === 'SETTLED')).toBe(false);

    // No settlement ⇒ no payout.
    await expect(
      createPayout(db, { transactionId: s.transactionId, providerId: ACQUIRER }),
    ).rejects.toThrow(/not settled/);
  });

  it('SETTLED does not equal RECEIVED and never completes a Payout by itself', async () => {
    const s = await setupOrder();
    await payAndSettle(s);

    // Settlement happened, but WASIT has recorded no receipt.
    const receipts = await db.select().from(wasitReceipts).where(eq(wasitReceipts.transactionId, s.transactionId));
    expect(receipts.length).toBe(0);

    // A payout is created but is NOT completed by settlement alone.
    const payout = await createPayout(db, { transactionId: s.transactionId, providerId: ACQUIRER });
    expect(payout.status).toBe('CREATED');
    expect(payout.payoutRef).toBeNull();

    const rows = await db.select().from(payouts).where(eq(payouts.id, payout.id));
    expect(rows[0].status).toBe('CREATED');
    expect(rows[0].completedAt).toBeNull();
  });

  it('refuses a payout through a provider without payout capability', async () => {
    const s = await setupOrder();
    await payAndSettle(s);
    const err = await createPayout(db, { transactionId: s.transactionId, providerId: 'manual' }).then(
      () => null,
      (e) => e as { fieldErrors?: { message: string }[] },
    );
    expect(err).not.toBeNull();
    expect(JSON.stringify(err?.fieldErrors)).toContain('no payout capability');
  });

  it('rejects COMPLETED without a payout_ref at the engine AND the database', async () => {
    const s = await setupOrder();
    await payAndSettle(s);
    const payout = await createPayout(db, { transactionId: s.transactionId, providerId: ACQUIRER });

    // Move to PROCESSING legitimately; completion is still gated on a reference.
    await applyPayoutEventToDb(db, { payoutId: payout.id, event: { type: 'payout.processing', providerRef: `acq-core-${Math.random().toString(36).slice(2, 8)}` } });

    // Engine guard.
    await expect(
      applyPayoutEventToDb(db, {
        payoutId: payout.id,
        event: { type: 'payout.completed', payoutRef: '  ', amount: payout.amount, currencyCode: 'TND' },
      }),
    ).rejects.toThrow();
    let rows = await db.select().from(payouts).where(eq(payouts.id, payout.id));
    expect(rows[0].status).toBe('PROCESSING');

    // Database CHECK guard: a direct write that skips the engine is refused.
    await expect(
      db
        .update(payouts)
        .set({ status: 'COMPLETED', payoutRef: null })
        .where(eq(payouts.id, payout.id)),
    ).rejects.toThrow();
    rows = await db.select().from(payouts).where(eq(payouts.id, payout.id));
    expect(rows[0].status).toBe('PROCESSING');
  });

  it('completes a payout only with a real transfer reference and matching amount', async () => {
    const s = await setupOrder();
    await payAndSettle(s);
    const payout = await createPayout(db, { transactionId: s.transactionId, providerId: ACQUIRER });
    await applyPayoutEventToDb(db, { payoutId: payout.id, event: { type: 'payout.processing', providerRef: `acq-core-${Math.random().toString(36).slice(2, 8)}` } });

    const wrongAmount = (Number(payout.amount) + 1).toFixed(4);
    await expect(
      applyPayoutEventToDb(db, {
        payoutId: payout.id,
        event: { type: 'payout.completed', payoutRef: 'trf-core-x', amount: wrongAmount, currencyCode: 'TND' },
      }),
    ).rejects.toThrow(/amount/);

    const completed = await applyPayoutEventToDb(db, {
      payoutId: payout.id,
      event: { type: 'payout.completed', payoutRef: 'trf-core-ok-1', amount: payout.amount, currencyCode: 'TND' },
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.payoutRef).toBe('trf-core-ok-1');
  });

  it('records RECEIVED only from independent statement evidence, idempotently', async () => {
    const s = await setupOrder();
    await payAndSettle(s);
    const commission = s.orderRow.commission;

    // Wrong amount is refused before anything is written.
    await expect(
      recordReceipt(db, {
        transactionId: s.transactionId,
        evidence: { reference: 'stmt-bad', amount: '1.0000', currencyCode: 'TND', source: 'BANK_STATEMENT' },
      }),
    ).rejects.toThrow(/amount/);
    expect((await db.select().from(wasitReceipts)).filter((r) => r.reference === 'stmt-bad').length).toBe(0);

    const first = await recordReceipt(db, {
      transactionId: s.transactionId,
      evidence: { reference: 'stmt-1', amount: commission, currencyCode: 'TND', source: 'BANK_STATEMENT' },
    });
    expect(first.status).toBe('RECEIVED');
    expect(first.duplicate).toBe(false);

    const replay = await recordReceipt(db, {
      transactionId: s.transactionId,
      evidence: { reference: 'stmt-1', amount: commission, currencyCode: 'TND', source: 'BANK_STATEMENT' },
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);

    const count = (await db.select().from(wasitReceipts)).filter((r) => r.reference === 'stmt-1').length;
    expect(count).toBe(1);

    // A reversal keeps the evidence and ends at REVERSED.
    await reverseReceiptInDb(db, { receiptId: first.id, reason: 'bank reversal' });
    const rows = await db.select().from(wasitReceipts).where(eq(wasitReceipts.id, first.id));
    expect(rows[0].status).toBe('REVERSED');
    expect(rows[0].reversedAt).not.toBeNull();
  });

  it('cannot record a receipt for a transaction that is not settled', async () => {
    const s = await setupOrder();
    await expect(
      recordReceipt(db, {
        transactionId: s.transactionId,
        evidence: { reference: 'stmt-x', amount: s.orderRow.commission, currencyCode: 'TND', source: 'BANK_STATEMENT' },
      }),
    ).rejects.toThrow(/settled/);
  });

  it('persists reconciliation decisions, keeping mismatches as MISMATCH, and is idempotent', async () => {
    const provider = [
      { reference: 'r-ext-1', grossAmount: '1020.0000', providerFee: '4.2000', netAmount: '1015.8000', currencyCode: 'TND' },
    ];
    const bank = [{ reference: 'r-ext-1', amount: '1015.8000', currencyCode: 'TND' }];
    const ledger = [
      { reference: 'r-ext-1', grossAmount: '1020.0000', providerFee: '4.2000', netAmount: '1015.8000', currencyCode: 'TND', settled: true },
      { reference: 'r-only-ledger', grossAmount: '50.0000', providerFee: '0.0000', netAmount: '50.0000', currencyCode: 'TND', settled: true },
    ];
    const report = reconcile('TND', provider, bank, ledger);
    expect(report.decisions.find((d) => d.reference === 'r-only-ledger')?.status).toBe('MISMATCH');

    const first = await importReconciliationFeed(db, {
      source: 'PROVIDER',
      currencyCode: 'TND',
      providerId: ACQUIRER,
      provider,
      bank,
      ledger,
    });
    expect(first.duplicate).toBe(false);
    expect(first.insertedLines).toBe(1);

    const replay = await importReconciliationFeed(db, {
      source: 'PROVIDER',
      currencyCode: 'TND',
      providerId: ACQUIRER,
      provider,
      bank,
      ledger,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.importId).toBe(first.importId);
  });
});

describe('PS-05 stays outside the money path', () => {
  const SRC = path.resolve(process.cwd(), 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('has zero PS-05 references in source', () => {
    const hits = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes('PS-05'));
    expect(hits).toEqual([]);
  });

  it('exposes exactly one writer per money-path transition', () => {
    const files = walk(SRC);
    const writers = {
      settled: files.filter((f) => /status:\s*'SETTLED'/.test(readFileSync(f, 'utf8'))),
      receiptInsert: files.filter((f) => /\.insert\(wasitReceipts\)/.test(readFileSync(f, 'utf8'))),
      payoutInsert: files.filter((f) => /\.insert\(payouts\)/.test(readFileSync(f, 'utf8'))),
    };
    // Each transition has a single, dedicated writer module — no emergency/PS-05
    // path can write SETTLED, a receipt, or a payout.
    expect(writers.settled.map((f) => path.relative(SRC, f))).toEqual(['modules/settlements/service.ts']);
    expect(writers.receiptInsert.map((f) => path.relative(SRC, f))).toEqual([
      'modules/reconciliation/receipt-service.ts',
    ]);
    expect(writers.payoutInsert.map((f) => path.relative(SRC, f))).toEqual(['modules/payouts/service.ts']);
  });
});

void randomUUID;
void OpenCheckoutPaymentProvider;
