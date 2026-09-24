import { describe, it, expect } from 'vitest';
import {
  applyPayoutEvent,
  assertPayoutCapable,
  computeSellerPayable,
  type PayoutRecord,
} from '../src/modules/payouts/engine.js';
import { ManualPaymentProvider, OpenCheckoutPaymentProvider } from '../src/lib/payments/providers.js';

/**
 * PS-02 — Seller Payout lifecycle.
 *
 * The payout is an independent state machine. These tests prove that
 * `CREATED ≠ COMPLETED`, that completion needs a real transfer reference with a
 * matching amount/currency, that replays are idempotent, and that a provider
 * without the payout capability can never complete one.
 */

function baseRecord(overrides: Partial<PayoutRecord> = {}): PayoutRecord {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    transactionId: 'tx_1',
    sellerId: 'sup_1',
    amount: '980.0000',
    currencyCode: 'TND',
    providerId: 'open-checkout',
    status: 'CREATED',
    payoutRef: null,
    providerRef: null,
    failureReason: null,
    ...overrides,
  };
}

describe('PS-02 — seller payable is the net of the seller commission only', () => {
  it('computes 1000 − 2% seller share = 980 for a 1020 order', () => {
    // 4% total = 2% seller + 2% buyer; the buyer share is NOT deducted again.
    expect(computeSellerPayable({ itemsTotal: '1000.0000', commission: '40.0000', buyerCommission: '20.0000' })).toBe(
      '980.0000',
    );
  });
});

describe('PS-02 — payout cannot complete without evidence', () => {
  it('stays CREATED (not COMPLETED) until a provider event arrives', () => {
    const record = baseRecord();
    expect(record.status).toBe('CREATED');
    expect(record.payoutRef).toBeNull();
  });

  it('rejects completion without a payoutRef', () => {
    const err = (() => {
      try {
        applyPayoutEvent(baseRecord({ status: 'PROCESSING' }), {
          type: 'payout.completed',
          payoutRef: '  ',
          amount: '980.0000',
          currencyCode: 'TND',
        });
        return null;
      } catch (e) {
        return e as { fieldErrors?: { message: string }[] };
      }
    })();
    expect(err).not.toBeNull();
    expect(JSON.stringify(err?.fieldErrors)).toContain('transfer reference');
  });

  it('rejects completion when amount or currency does not match the payable', () => {
    expect(() =>
      applyPayoutEvent(baseRecord({ status: 'PROCESSING' }), {
        type: 'payout.completed',
        payoutRef: 'trf-p',
        amount: '1.0000',
        currencyCode: 'TND',
      }),
    ).toThrow(/amount/);

    expect(() =>
      applyPayoutEvent(baseRecord({ status: 'PROCESSING' }), {
        type: 'payout.completed',
        payoutRef: 'trf-p',
        amount: '980.0000',
        currencyCode: 'EUR',
      }),
    ).toThrow(/currency/);
  });

  it('cannot jump straight from CREATED to COMPLETED', () => {
    expect(() =>
      applyPayoutEvent(baseRecord(), {
        type: 'payout.completed',
        payoutRef: 'trf-p',
        amount: '980.0000',
        currencyCode: 'TND',
      }),
    ).toThrow(/cannot move from CREATED to COMPLETED/);
  });
});

describe('PS-02 — payout lifecycle with valid evidence', () => {
  it('CREATED → PROCESSING → COMPLETED with a matching payoutRef', () => {
    const processing = applyPayoutEvent(baseRecord(), { type: 'payout.processing', providerRef: 'acq-p1' });
    expect(processing.record.status).toBe('PROCESSING');
    expect(processing.record.payoutRef).toBeNull();

    const completed = applyPayoutEvent(processing.record, {
      type: 'payout.completed',
      payoutRef: 'trf-p1',
      amount: '980.0000',
      currencyCode: 'TND',
      providerRef: 'acq-p1',
    });
    expect(completed.record.status).toBe('COMPLETED');
    expect(completed.record.payoutRef).toBe('trf-p1');
    expect(completed.applied).toBe(true);
  });

  it('is idempotent: replaying the same completion is a no-op', () => {
    const record = baseRecord({ status: 'PROCESSING' });
    const first = applyPayoutEvent(record, {
      type: 'payout.completed',
      payoutRef: 'trf-p1',
      amount: '980.0000',
      currencyCode: 'TND',
    });
    const replay = applyPayoutEvent(first.record, {
      type: 'payout.completed',
      payoutRef: 'trf-p1',
      amount: '980.0000',
      currencyCode: 'TND',
    });
    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.record.payoutRef).toBe('trf-p1');
  });

  it('a different completion reference against a COMPLETED payout is a conflict', () => {
    const completed = applyPayoutEvent(baseRecord({ status: 'PROCESSING' }), {
      type: 'payout.completed',
      payoutRef: 'trf-p1',
      amount: '980.0000',
      currencyCode: 'TND',
    });
    expect(() =>
      applyPayoutEvent(completed.record, {
        type: 'payout.completed',
        payoutRef: 'trf-other',
        amount: '980.0000',
        currencyCode: 'TND',
      }),
    ).toThrow(/already completed/);
  });

  it('supports HELD and FAILED as declared, non-success states', () => {
    const held = applyPayoutEvent(baseRecord(), { type: 'payout.held', reason: 'risk review' });
    expect(held.record.status).toBe('HELD');
    expect(held.record.payoutRef).toBeNull();

    const failed = applyPayoutEvent(baseRecord(), { type: 'payout.failed', reason: 'bank rejected' });
    expect(failed.record.status).toBe('FAILED');
    expect(failed.record.failureReason).toBe('bank rejected');
  });
});

describe('PS-02 — a provider must declare the payout capability', () => {
  it('refuses the offline demo provider', () => {
    const manual = new ManualPaymentProvider();
    const err = (() => {
      try {
        assertPayoutCapable(manual.id, manual.capabilities);
        return null;
      } catch (e) {
        return e as { fieldErrors?: { message: string }[] };
      }
    })();
    expect(err).not.toBeNull();
    expect(JSON.stringify(err?.fieldErrors)).toContain('no payout capability');
  });

  it('accepts an acquirer that declares payout', () => {
    const acquirer = new OpenCheckoutPaymentProvider('https://acquirer.example', 'k');
    expect(() => assertPayoutCapable(acquirer.id, acquirer.capabilities)).not.toThrow();
  });
});
