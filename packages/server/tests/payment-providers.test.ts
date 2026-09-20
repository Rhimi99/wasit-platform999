import { describe, it, expect } from 'vitest';
import {
  ManualPaymentProvider,
  NoopPaymentProvider,
  OpenCheckoutPaymentProvider,
  computeWebhookSignature,
  verifyHmacSignature,
} from '../src/lib/payments/providers.js';

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

describe('PHASE A — Payment provider port (unit)', () => {
  it('noop provider refuses to take money and is not functional', async () => {
    const p = new NoopPaymentProvider();
    expect(p.isFunctional).toBe(false);
    expect(p.isAvailable()).toBe(false);
    await expect(p.createIntent({ orderId: 'o', amount: '1.0000', currencyCode: 'TND', idempotencyKey: 'k' })).rejects.toThrow();
    await expect(p.refund({ externalRef: 'r', amount: '1.0000', currencyCode: 'TND', idempotencyKey: 'k' })).rejects.toThrow();
  });

  it('manual provider is functional and offline', async () => {
    const p = new ManualPaymentProvider();
    expect(p.isFunctional).toBe(true);
    expect(p.isAvailable()).toBe(true);
    const intent = await p.createIntent({ orderId: 'order-1', amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'abc123def456' });
    expect(intent.status).toBe('PENDING');
    expect(intent.externalRef).toContain('order-1');
    const refund = await p.refund({ externalRef: intent.externalRef, amount: '10.0000', currencyCode: 'TND', idempotencyKey: 'rfkey' });
    expect(refund.status).toBe('SUCCEEDED');
  });

  it('verifies HMAC signatures in constant time and rejects tampering', () => {
    const body = JSON.stringify({ eventId: 'e1', type: 'payment.succeeded', externalRef: 'x' });
    const good = computeWebhookSignature(body, SECRET);

    expect(() => verifyHmacSignature(body, good, SECRET)).not.toThrow();
    // Accepts the `sha256=` prefix form used by several providers.
    expect(() => verifyHmacSignature(body, `sha256=${good}`, SECRET)).not.toThrow();
    // Wrong signature, wrong secret, and a tampered body all fail.
    expect(() => verifyHmacSignature(body, 'deadbeef', SECRET)).toThrow();
    expect(() => verifyHmacSignature(body, good, 'other-secret')).toThrow();
    expect(() => verifyHmacSignature(`${body} `, good, SECRET)).toThrow();
    expect(() => verifyHmacSignature(body, undefined, SECRET)).toThrow();
    // Unconfigured secret is a hard failure, not an open door.
    expect(() => verifyHmacSignature(body, good, '')).toThrow();
  });

  it('normalizes provider webhook payloads into a stable event shape', () => {
    const p = new ManualPaymentProvider();
    const raw = JSON.stringify({ eventId: 'evt_1', type: 'payment.succeeded', externalRef: 'ref_1', amount: '25.0000', currencyCode: 'TND' });
    const evt = p.verifyAndNormalizeWebhook(raw, computeWebhookSignature(raw, SECRET));
    expect(evt).toMatchObject({ eventId: 'evt_1', eventType: 'PAYMENT_SUCCEEDED', externalRef: 'ref_1', amount: '25.0000', currencyCode: 'TND' });

    const refundRaw = JSON.stringify({ eventId: 'evt_2', type: 'refund.succeeded', externalRef: 'rf_1' });
    expect(p.verifyAndNormalizeWebhook(refundRaw, computeWebhookSignature(refundRaw, SECRET)).eventType).toBe('REFUND_SUCCEEDED');

    const unknownRaw = JSON.stringify({ eventId: 'evt_3', type: 'something.else' });
    expect(p.verifyAndNormalizeWebhook(unknownRaw, computeWebhookSignature(unknownRaw, SECRET)).eventType).toBe('UNKNOWN');
  });

  it('open-checkout adapter reports itself unavailable until configured', () => {
    expect(new OpenCheckoutPaymentProvider('', '').isAvailable()).toBe(false);
    expect(new OpenCheckoutPaymentProvider('https://api.example.com', '').isAvailable()).toBe(false);
    const configured = new OpenCheckoutPaymentProvider('https://api.example.com', 'key');
    expect(configured.isAvailable()).toBe(true);
    expect(configured.id).toBe('open-checkout');
  });
});