import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { orders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { payouts } from '../src/db/schema/payouts.js';
import { suppliers } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';
import { createPayout } from '../src/modules/payouts/service.js';
import {
  dispatchPayoutToProvider,
  syncPayoutFromProvider,
  payoutEventFromProviderStatus,
} from '../src/modules/payouts/provider-service.js';
import { SandboxPayoutProvider } from '../src/lib/payments/sandbox-payout.js';
import {
  ManualPayoutProvider,
  NoopPayoutProvider,
  OpenCheckoutPayoutProvider,
} from '../src/lib/payments/payout-providers.js';
import { resolvePayoutProviderById } from '../src/lib/payments/payout-resolve.js';

/**
 * P2 — PayoutProvider abstraction.
 *
 * The point of these tests is the *boundary*: a provider transports, the engine
 * decides. So the critical assertions are that a rail claiming success cannot by
 * itself complete a payout, and that the pre-existing state-machine invariants
 * still hold through the new provider path.
 */

afterAll(async () => {
  await closeDb();
});

/** Builds a settled transaction + order so a payout can legitimately be created. */
async function settledOrder() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const buyerId = randomUUID();
  const sellerUserId = randomUUID();
  await db.insert(users).values([
    { id: buyerId, email: `it-po-b-${stamp}@wasit.tn`, passwordHash: 'x', firstName: 'B', isActive: true, emailVerified: true },
    { id: sellerUserId, email: `it-po-s-${stamp}@wasit.tn`, passwordHash: 'x', firstName: 'S', isActive: true, emailVerified: true },
  ]);
  const supplierId = `sup-po-${stamp}`;
  await db.insert(suppliers).values({
    id: supplierId,
    userId: sellerUserId,
    companyName: `Supplier ${stamp}`,
    slug: `sup-po-${stamp}`,
  });

  const orderId = `ord-po-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `ORDPO-${stamp}`,
    buyerId,
    buyerType: 'CUSTOMER',
    sellerId: supplierId,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal: '100.0000',
    commission: '4.0000',
    buyerCommission: '2.0000',
    paymentFee: '0',
    grandTotal: '100.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });

  const transactionId = `txn-po-${stamp}`;
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `TXPO-${stamp}`,
    orderId,
    buyerId,
    sellerId: supplierId,
    totalValue: '100.0000',
    currencyCode: 'TND',
    commission: '4.0000',
    buyerCommission: '2.0000',
    status: 'PAID',
  });

  // A SETTLED ledger entry is the precondition for a payout.
  await db.insert(transactionLedger).values({
    id: randomUUID(),
    transactionId,
    entryType: 'SETTLEMENT',
    direction: 'CREDIT',
    amount: '100.0000',
    currencyCode: 'TND',
    status: 'SETTLED',
  });

  return { orderId, transactionId, supplierId };
}

describe('P2 payout provider — adapters declare honest capabilities', () => {
  it('noop is not functional and cannot create a payout', async () => {
    const p = new NoopPayoutProvider();
    expect(p.isFunctional).toBe(false);
    expect(p.capabilities.createPayout).toBe(false);
    await expect(p.createPayout()).rejects.toThrow();
  });

  it('manual is a demo harness with no transfer reference capability', () => {
    const p = new ManualPayoutProvider();
    expect(p.capabilities.demo).toBe(true);
    expect(p.capabilities.transferReference).toBe(false);
  });

  it('open-checkout is generic and not a demo, but is unavailable without credentials', () => {
    const p = new OpenCheckoutPayoutProvider('', '');
    expect(p.capabilities.demo).toBe(false);
    expect(p.capabilities.transferReference).toBe(true);
    // No base URL/key configured → must not be usable.
    expect(p.isAvailable()).toBe(false);
  });

  it('sandbox is always marked demo so it can never run as a real rail', () => {
    const p = new SandboxPayoutProvider();
    expect(p.capabilities.demo).toBe(true);
    expect(p.id).toBe('sandbox');
  });

  it('resolvePayoutProviderById refuses an unknown rail', () => {
    expect(() => resolvePayoutProviderById('acme-bank')).toThrow();
  });

  it('resolves the known rails by id', () => {
    expect(resolvePayoutProviderById('noop').id).toBe('noop');
    expect(resolvePayoutProviderById('manual').id).toBe('manual');
    expect(resolvePayoutProviderById('sandbox').id).toBe('sandbox');
  });
});

describe('P2 payout provider — engine remains the source of truth', () => {
  it('dispatching to a provider produces PROCESSING, never COMPLETED', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    expect(payout.status).toBe('CREATED');

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'processing');
    const result = await dispatchPayoutToProvider(db, {
      payoutId: payout.id,
      beneficiaryRef: 'beneficiary-1',
      provider: sandbox,
    });

    expect(result.payout.status).toBe('PROCESSING');
    expect(result.payout.status).not.toBe('COMPLETED');
    expect(result.providerRef).toBeTruthy();
  });

  it('a provider reporting completion WITHOUT a transfer reference is refused', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'completed_without_reference');
    await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });

    await expect(syncPayoutFromProvider(db, { payoutId: payout.id, provider: sandbox })).rejects.toThrow(
      /transfer reference/i,
    );

    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('PROCESSING');
    expect(row.payoutRef).toBeNull();
  });

  it('a provider reporting a WRONG amount is refused and the payout stays PROCESSING', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'amount_mismatch');
    await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });

    await expect(syncPayoutFromProvider(db, { payoutId: payout.id, provider: sandbox })).rejects.toThrow();

    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('PROCESSING');
  });

  it('completes ONLY when the provider supplies matching reference, amount and currency', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    // Net payable = itemsTotal − (commission − buyerCommission) = 100 − 2 = 98.
    expect(payout.amount).toBe('98.0000');

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'completed');
    await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });

    // The sandbox reports completion without amount/currency on status, so the
    // engine must refuse until both are present.
    await expect(syncPayoutFromProvider(db, { payoutId: payout.id, provider: sandbox })).rejects.toThrow();

    // Now supply correct evidence through the engine's own event path.
    const { ingestPayoutProviderEvent } = await import('../src/modules/payouts/provider-service.js');
    const completed = await ingestPayoutProviderEvent(db, {
      payoutId: payout.id,
      event: {
        eventId: 'evt-1',
        type: 'payout.completed',
        payoutRef: `sandbox_tr_proof_${randomUUID().slice(0, 8)}`,
        amount: '98.0000',
        currencyCode: 'TND',
        providerRef: 'sandbox_po_x',
        raw: {},
      },
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.payoutRef).toMatch(/^sandbox_tr_proof_/);
  });

  it('a provider failure moves the payout to FAILED (terminal), not COMPLETED', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'failed');
    const result = await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });
    expect(result.payout.status).toBe('FAILED');
  });

  it('a provider error surfaces without corrupting payout state', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });

    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'provider_error');
    await expect(
      dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox }),
    ).rejects.toThrow();

    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('CREATED');
    expect(row.payoutRef).toBeNull();
  });

  it('re-dispatching an already-dispatched payout reuses the rail reference', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'processing');

    const first = await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });
    const second = await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });
    expect(second.providerRef).toBe(first.providerRef);
  });

  it('refuses a non-functional rail rather than pretending to pay', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    await expect(
      dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: new NoopPayoutProvider() }),
    ).rejects.toThrow();
  });

  it('cannot complete an already-completed payout again', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'processing');
    await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });

    const { ingestPayoutProviderEvent } = await import('../src/modules/payouts/provider-service.js');
    await ingestPayoutProviderEvent(db, {
      payoutId: payout.id,
      event: { eventId: 'e1', type: 'payout.completed', payoutRef: `ref-1-${randomUUID().slice(0, 8)}`, amount: '98.0000', currencyCode: 'TND', raw: {} },
    });
    // A second, different completion must be refused.
    await expect(
      ingestPayoutProviderEvent(db, {
        payoutId: payout.id,
        event: { eventId: 'e2', type: 'payout.completed', payoutRef: `ref-2-${randomUUID().slice(0, 8)}`, amount: '98.0000', currencyCode: 'TND', raw: {} },
      }),
    ).rejects.toThrow(/already completed/i);
  });

  it('a stale PROCESSING event cannot drag a COMPLETED payout backwards', async () => {
    const { transactionId } = await settledOrder();
    const payout = await createPayout(db, { transactionId, providerId: 'sandbox' });
    const sandbox = new SandboxPayoutProvider();
    sandbox.setScenario(payout.id, 'processing');
    await dispatchPayoutToProvider(db, { payoutId: payout.id, beneficiaryRef: 'b', provider: sandbox });

    const { ingestPayoutProviderEvent } = await import('../src/modules/payouts/provider-service.js');
    await ingestPayoutProviderEvent(db, {
      payoutId: payout.id,
      event: { eventId: 'e1', type: 'payout.completed', payoutRef: `ref-1-${randomUUID().slice(0, 8)}`, amount: '98.0000', currencyCode: 'TND', raw: {} },
    });

    await expect(
      ingestPayoutProviderEvent(db, {
        payoutId: payout.id,
        event: { eventId: 'e2', type: 'payout.processing', providerRef: 'x', raw: {} },
      }),
    ).rejects.toThrow();

    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id)).limit(1);
    expect(row.status).toBe('COMPLETED');
  });
});

describe('P2 payout provider — normalized status conversion', () => {
  it('rejects a completion with no reference', () => {
    expect(() =>
      payoutEventFromProviderStatus({ status: 'COMPLETED', payoutRef: null, amount: '1', currencyCode: 'TND', providerRef: 'r' }),
    ).toThrow(/transfer reference/i);
  });

  it('rejects a completion with no amount/currency', () => {
    expect(() =>
      payoutEventFromProviderStatus({ status: 'COMPLETED', payoutRef: 'ref', amount: null, currencyCode: null, providerRef: 'r' }),
    ).toThrow(/amount and currency/i);
  });

  it('maps a full completion to a completed event', () => {
    const e = payoutEventFromProviderStatus({
      status: 'COMPLETED',
      payoutRef: 'ref',
      amount: '98.0000',
      currencyCode: 'TND',
      providerRef: 'r',
    });
    expect(e.type).toBe('payout.completed');
  });

  it('maps UNKNOWN/PROCESSING to a processing event, never a completion', () => {
    const e = payoutEventFromProviderStatus({
      status: 'PROCESSING',
      payoutRef: null,
      amount: null,
      currencyCode: null,
      providerRef: 'r',
    });
    expect(e.type).toBe('payout.processing');
  });
});
