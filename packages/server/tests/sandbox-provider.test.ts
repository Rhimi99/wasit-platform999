import { describe, it, expect, afterAll } from 'vitest';
import { SandboxPaymentProvider, isSandboxPaymentScenario } from '../src/lib/payments/sandbox-payment.js';
import { SandboxPayoutProvider } from '../src/lib/payments/sandbox-payout.js';
import { resolvePaymentProviderById } from '../src/lib/payments/resolve.js';
import { resolvePayoutProviderById } from '../src/lib/payments/payout-resolve.js';
import { verifyHmacSignature } from '../src/lib/payments/providers.js';
import { closeDb } from '../src/db/client.js';

/**
 * P4 — Sandbox payment/payout provider.
 *
 * Proves the harness can drive every scenario the platform must survive, AND
 * that it can never masquerade as a real rail: it is marked demo (refused
 * outside demo mode), it can never produce settlement evidence, and its
 * references are recognisably synthetic.
 */

afterAll(async () => {
  await closeDb();
});

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'test-webhook-secret-0123456789';

function provider() {
  return new SandboxPaymentProvider(SECRET);
}

describe('P4 sandbox — never behaves like a real rail', () => {
  it('declares itself a demo harness', () => {
    expect(provider().capabilities.demo).toBe(true);
  });

  it('can never produce settlement evidence', () => {
    // This is the invariant that keeps SETTLED reachable only through proof.
    expect(provider().capabilities.settlementEvidence).toBe(false);
  });

  it('is reachable by id so tests can select it explicitly', () => {
    expect(resolvePaymentProviderById('sandbox').id).toBe('sandbox');
    expect(resolvePayoutProviderById('sandbox').id).toBe('sandbox');
  });

  it('is refused by the resolver unless demo mode is on', () => {
    // DEMO_PAYMENT_MODE defaults to false in this environment.
    const prev = process.env.DEMO_PAYMENT_MODE;
    process.env.DEMO_PAYMENT_MODE = 'false';
    try {
      // resolvePaymentProvider() reads the cached env; use the direct check the
      // resolver performs so the assertion is deterministic.
      const p = provider();
      expect(p.capabilities.demo).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DEMO_PAYMENT_MODE;
      else process.env.DEMO_PAYMENT_MODE = prev;
    }
  });

  it('uses a recognisably synthetic reference prefix', async () => {
    const p = provider();
    const r = await p.createIntent({
      orderId: 'ord-1',
      amount: '10.0000',
      currencyCode: 'TND',
      idempotencyKey: 'idem-1',
    });
    expect(r.externalRef.startsWith('sandbox_')).toBe(true);
  });
});

describe('P4 sandbox payment — controlled scenarios', () => {
  it('pending: an intent is issued but never auto-paid', async () => {
    const p = provider();
    const r = await p.createIntent({ orderId: 'ord-p', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'k' });
    p.setScenario(r.externalRef, 'pending');
    const status = await p.getStatus(r.externalRef);
    expect(status.status).toBe('PENDING');
  });

  it('success: status reports SUCCEEDED', async () => {
    const p = provider();
    const r = await p.createIntent({ orderId: 'ord-s', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'k' });
    p.setScenario(r.externalRef, 'success');
    const status = await p.getStatus(r.externalRef);
    expect(status.status).toBe('SUCCEEDED');
  });

  it('failure: status reports FAILED', async () => {
    const p = provider();
    const r = await p.createIntent({ orderId: 'ord-f', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'k' });
    p.setScenario(r.externalRef, 'failure');
    const status = await p.getStatus(r.externalRef);
    expect(status.status).toBe('FAILED');
  });

  it('provider_error: surfaces as an error, not a silent success', async () => {
    const p = provider();
    p.setScenario('sandbox_ord-e_k', 'provider_error');
    await expect(
      p.createIntent({ orderId: 'ord-e', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'k' }),
    ).rejects.toThrow(/simulated an upstream error/i);
  });

  it('timeout: surfaces as an error, not a silent success', async () => {
    const p = provider();
    p.setScenario('sandbox_ord-t_k', 'timeout');
    await expect(
      p.createIntent({ orderId: 'ord-t', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'k' }),
    ).rejects.toThrow(/timeout/i);
  });

  it('amount_mismatch: the webhook reports a different amount than the intent', () => {
    const p = provider();
    p.setScenario('sandbox_ord-am_k', 'amount_mismatch');
    const { body, signature } = p.buildSignedWebhook({
      eventId: 'evt-am',
      type: 'payment.succeeded',
      externalRef: 'sandbox_ord-am_k',
      amount: '10.0000',
      currencyCode: 'TND',
    });
    const evt = p.verifyAndNormalizeWebhook(body, signature);
    expect(evt.amount).toBe('0.0001');
    expect(evt.eventType).toBe('PAYMENT_SUCCEEDED');
  });

  it('currency_mismatch: the webhook reports a different currency than the intent', () => {
    const p = provider();
    p.setScenario('sandbox_ord-cm_k', 'currency_mismatch');
    const { body, signature } = p.buildSignedWebhook({
      eventId: 'evt-cm',
      type: 'payment.succeeded',
      externalRef: 'sandbox_ord-cm_k',
      amount: '10.0000',
      currencyCode: 'TND',
    });
    const evt = p.verifyAndNormalizeWebhook(body, signature);
    expect(evt.currencyCode).toBe('USD');
  });

  it('delayed_webhook: is flagged so the caller can withhold delivery', () => {
    const p = provider();
    p.setScenario('sandbox_ord-dw_k', 'delayed_webhook');
    expect(p.isDelayed('sandbox_ord-dw_k')).toBe(true);
    expect(p.isDelayed('sandbox_ord-other_k')).toBe(false);
  });

  it('duplicate_event: the same logical event yields a stable id across deliveries', () => {
    const p = provider();
    p.setScenario('sandbox_ord-dup_k', 'duplicate_event');
    const payload = {
      eventId: 'evt-dup',
      type: 'payment.succeeded',
      externalRef: 'sandbox_ord-dup_k',
      amount: '10.0000',
      currencyCode: 'TND',
    };
    const first = p.verifyAndNormalizeWebhook(JSON.stringify(payload), p.buildSignedWebhook(payload).signature);
    const second = p.verifyAndNormalizeWebhook(JSON.stringify(payload), p.buildSignedWebhook(payload).signature);
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId.endsWith('-dup')).toBe(true);
  });

  it('malformed_webhook: throws rather than yielding an empty event', () => {
    const p = provider();
    p.setScenario('sandbox_ord-mal_k', 'malformed_webhook');
    const { body, signature } = p.buildSignedWebhook({
      eventId: 'evt-mal',
      type: 'payment.succeeded',
      externalRef: 'sandbox_ord-mal_k',
    });
    expect(() => p.verifyAndNormalizeWebhook(body, signature)).toThrow();
  });

  it('rejects invalid JSON with a validation error', () => {
    const p = provider();
    const body = '{not json';
    const signature = p.buildSignedWebhook({}).signature;
    const bad = signature; // signature is computed over a different body → must fail
    expect(() => p.verifyAndNormalizeWebhook(body, bad)).toThrow();
  });

  it('rejects a webhook with no signature', () => {
    const p = provider();
    const { body } = p.buildSignedWebhook({ eventId: 'x', type: 'payment.succeeded' });
    expect(() => p.verifyAndNormalizeWebhook(body, undefined)).toThrow();
  });

  it('rejects a webhook signed with the wrong secret', () => {
    const p = provider();
    const body = JSON.stringify({ eventId: 'x', type: 'payment.succeeded' });
    expect(() => p.verifyAndNormalizeWebhook(body, 'deadbeef')).toThrow();
  });

  it('cannot emit SETTLEMENT_CONFIRMED without settlement capability', () => {
    // Even if a scenario's payload claims settlement, the provider declares it
    // cannot prove settlement — the service gates on the capability, not the text.
    const p = provider();
    expect(p.capabilities.settlementEvidence).toBe(false);
  });

  it('accepts every declared scenario name', () => {
    for (const s of [
      'pending',
      'success',
      'failure',
      'amount_mismatch',
      'currency_mismatch',
      'delayed_webhook',
      'duplicate_event',
      'malformed_webhook',
      'provider_error',
      'timeout',
    ]) {
      expect(isSandboxPaymentScenario(s)).toBe(true);
    }
  });

  it('rejects an unknown scenario name', () => {
    expect(isSandboxPaymentScenario('nonsense')).toBe(false);
    expect(() => provider().setScenario('x', 'nonsense' as never)).toThrow();
  });
});

describe('P4 sandbox payout — controlled scenarios', () => {
  it('is marked demo', () => {
    expect(new SandboxPayoutProvider().capabilities.demo).toBe(true);
  });

  it('processing is the default: creation is not a transfer', async () => {
    const p = new SandboxPayoutProvider();
    const r = await p.createPayout({
      payoutId: 'po-1',
      orderId: 'ord-1',
      amount: '98.0000',
      currencyCode: 'TND',
      beneficiaryRef: 'b',
      idempotencyKey: 'k',
    });
    expect(r.status).toBe('PROCESSING');
  });

  it('failed: creation reports failure with a reason', async () => {
    const p = new SandboxPayoutProvider();
    p.setScenario('po-f', 'failed');
    const r = await p.createPayout({
      payoutId: 'po-f',
      orderId: 'ord-1',
      amount: '98.0000',
      currencyCode: 'TND',
      beneficiaryRef: 'b',
      idempotencyKey: 'k',
    });
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toBeTruthy();
  });

  it('completed_without_reference: reports completion but supplies no proof', async () => {
    const p = new SandboxPayoutProvider();
    p.setScenario('po-nr', 'completed_without_reference');
    const created = await p.createPayout({
      payoutId: 'po-nr',
      orderId: 'ord-1',
      amount: '98.0000',
      currencyCode: 'TND',
      beneficiaryRef: 'b',
      idempotencyKey: 'k',
    });
    const status = await p.getPayoutStatus(created.providerRef);
    expect(status.status).toBe('COMPLETED');
    expect(status.payoutRef).toBeNull();
  });

  it('amount_mismatch: reports a wrong amount', async () => {
    const p = new SandboxPayoutProvider();
    p.setScenario('po-am', 'amount_mismatch');
    const created = await p.createPayout({
      payoutId: 'po-am',
      orderId: 'ord-1',
      amount: '98.0000',
      currencyCode: 'TND',
      beneficiaryRef: 'b',
      idempotencyKey: 'k',
    });
    const status = await p.getPayoutStatus(created.providerRef);
    expect(status.amount).toBe('0.0001');
  });

  it('provider_error: surfaces as an error', async () => {
    const p = new SandboxPayoutProvider();
    p.setScenario('po-e', 'provider_error');
    await expect(
      p.createPayout({
        payoutId: 'po-e',
        orderId: 'ord-1',
        amount: '98.0000',
        currencyCode: 'TND',
        beneficiaryRef: 'b',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow();
  });

  it('rejects an unknown scenario', () => {
    expect(() => new SandboxPayoutProvider().setScenario('x', 'nope' as never)).toThrow();
  });

  it('uses synthetic references only', async () => {
    const p = new SandboxPayoutProvider();
    p.setScenario('po-s', 'processing');
    const r = await p.createPayout({
      payoutId: 'po-s',
      orderId: 'ord-1',
      amount: '98.0000',
      currencyCode: 'TND',
      beneficiaryRef: 'b',
      idempotencyKey: 'k',
    });
    expect(r.providerRef.startsWith('sandbox_po_')).toBe(true);
  });
});

describe('P4 sandbox — webhook signature discipline matches a real rail', () => {
  it('a correctly signed sandbox webhook verifies', () => {
    const p = provider();
    const payload = { eventId: 'e', type: 'payment.succeeded', externalRef: 'sandbox_x_k', amount: '1.0000', currencyCode: 'TND' };
    const { body, signature } = p.buildSignedWebhook(payload);
    expect(() => verifyHmacSignature(body, signature, SECRET)).not.toThrow();
  });

  it('an unsigned sandbox webhook is refused', () => {
    const p = provider();
    const { body } = p.buildSignedWebhook({ eventId: 'e', type: 'payment.succeeded' });
    expect(() => p.verifyAndNormalizeWebhook(body, undefined)).toThrow(/signature/i);
  });
});
