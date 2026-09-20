import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FlouciPaymentProvider } from '../src/lib/payments/flouci.js';
import { ClicToPayPaymentProvider } from '../src/lib/payments/clictopay.js';
import { toMinorUnits, fromMinorUnits } from '../src/lib/payments/providers.js';

/**
 * These tests exercise the REAL adapter code (fetch, headers, payload building,
 * response parsing, status mapping) against a local HTTP server that speaks the
 * documented Flouci / ClicToPay contracts. The server is a boundary double, not
 * a mock of WASIT logic: no WASIT function is stubbed, and no external network
 * or credential is used. This is the closest we can get to a sandbox without a
 * merchant account — the same code paths run against the real base URL in prod.
 */

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let baseUrl: string;
let lastRequest: CapturedRequest | null = null;
// Per-path response configuration for the fake provider.
let handlers: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastRequest = { method: req.method ?? 'GET', path: req.url ?? '', headers: req.headers, body: raw };
      const key = (req.url ?? '').split('?')[0];
      const handler = handlers[key];
      res.statusCode = handler?.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(handler?.body ?? { result: { success: false } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Flouci adapter (against documented API contract)', () => {
  const provider = () => new FlouciPaymentProvider(baseUrl, 'PUB_TEST', 'PRIV_TEST');

  it('reports methods unavailable without credentials, available with them', () => {
    const unconfigured = new FlouciPaymentProvider(baseUrl, '', '');
    expect(unconfigured.isAvailable()).toBe(false);
    expect(unconfigured.supportedMethods().every((m) => !m.available)).toBe(true);
    expect(unconfigured.supportedMethods()[0].reason).toBeTruthy();

    expect(provider().isAvailable()).toBe(true);
    expect(provider().requiresStatusRecheck).toBe(true);
  });

  it('createIntent posts millimes + tracking id with Bearer auth and returns the checkout link', async () => {
    lastRequest = null;
    handlers = {
      '/api/v2/generate_payment': {
        status: 200,
        body: { result: { success: true, payment_id: 'pay_123', link: 'https://checkout.flouci.com/co/pay_123' } },
      },
    };
    const result = await provider().createIntent({
      orderId: 'order-abc',
      amount: '40.3000',
      currencyCode: 'TND',
      idempotencyKey: 'idem-1',
      method: { type: 'CARD', scheme: 'VISA' },
    });
    expect(result.externalRef).toBe('pay_123');
    expect(result.status).toBe('PENDING');
    expect(result.checkoutUrl).toBe('https://checkout.flouci.com/co/pay_123');

    const sent = JSON.parse(lastRequest!.body);
    expect(sent.amount).toBe('40300'); // 40.300 TND → 40300 millimes
    expect(sent.developer_tracking_id).toBe('order-abc');
    expect(sent.accept_card).toBe(true);
    expect(lastRequest!.headers.authorization).toBe('Bearer PUB_TEST:PRIV_TEST');
  });

  it('createIntent sets accept_card=false for a wallet-only method', async () => {
    lastRequest = null;
    handlers = {
      '/api/v2/generate_payment': { status: 200, body: { result: { success: true, payment_id: 'pay_w', link: 'https://x' } } },
    };
    await provider().createIntent({
      orderId: 'o2',
      amount: '1.0000',
      currencyCode: 'TND',
      idempotencyKey: 'idem-2',
      method: { type: 'MOBILE_WALLET', scheme: 'FLOUCI_WALLET' },
    });
    expect(JSON.parse(lastRequest!.body).accept_card).toBe(false);
  });

  it('createIntent surfaces a provider error instead of inventing success', async () => {
    handlers = { '/api/v2/generate_payment': { status: 400, body: { result: { status: 400, message: 'Bad Request' } } } };
    await expect(
      provider().createIntent({ orderId: 'o3', amount: '1.0000', currencyCode: 'TND', idempotencyKey: 'k3' }),
    ).rejects.toThrow(/Flouci error/);
  });

  it('getStatus maps SUCCESS → SUCCEEDED and converts millimes back to money', async () => {
    handlers = {
      '/api/v2/verify_payment/pay_123': {
        status: 200,
        body: {
          success: true,
          result: { type: 'wallet', amount: 40300, status: 'SUCCESS', settlement_status: 'AVAILABLE' },
        },
      },
    };
    const status = await provider().getStatus('pay_123');
    expect(status.status).toBe('SUCCEEDED');
    expect(status.amount).toBe('40.3000');
    expect(status.settlementStatus).toBe('AVAILABLE');
  });

  it('getStatus maps FAILURE/EXPIRED to FAILED and PENDING stays pending', async () => {
    handlers = { '/api/v2/verify_payment/f1': { status: 200, body: { result: { status: 'FAILURE' } } } };
    expect((await provider().getStatus('f1')).status).toBe('FAILED');
    handlers = { '/api/v2/verify_payment/f2': { status: 200, body: { result: { status: 'EXPIRED' } } } };
    expect((await provider().getStatus('f2')).status).toBe('FAILED');
    handlers = { '/api/v2/verify_payment/f3': { status: 200, body: { result: { status: 'PENDING' } } } };
    expect((await provider().getStatus('f3')).status).toBe('PENDING');
  });

  it('refund posts the payment id and reports success', async () => {
    lastRequest = null;
    handlers = {
      '/api/v2/refund_payment': {
        status: 200,
        body: { result: { refund_id: 'ref_1', payment_id: 'pay_123', amount: '40300', status: 'success' }, status: 'success' },
      },
    };
    const result = await provider().refund({
      externalRef: 'pay_123',
      amount: '40.3000',
      currencyCode: 'TND',
      idempotencyKey: 'r1',
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.externalRef).toBe('ref_1');
    expect(JSON.parse(lastRequest!.body).payment_id).toBe('pay_123');
  });

  it('verifyAndNormalizeWebhook extracts the payment id and rejects payloads without one', () => {
    const evt = provider().verifyAndNormalizeWebhook(JSON.stringify({ result: { payment_id: 'pay_9' } }), undefined);
    expect(evt.externalRef).toBe('pay_9');
    expect(evt.eventType).toBe('UNKNOWN'); // decision comes from getStatus recheck

    expect(() => provider().verifyAndNormalizeWebhook(JSON.stringify({ hello: 'world' }), undefined)).toThrow();
    expect(() => provider().verifyAndNormalizeWebhook('not-json', undefined)).toThrow();
  });
});

describe('ClicToPay adapter (against documented API contract)', () => {
  const provider = () => new ClicToPayPaymentProvider(baseUrl, 'user1', 'pass1');

  it('is unavailable without credentials and requires a status recheck', () => {
    expect(new ClicToPayPaymentProvider(baseUrl, '', '').isAvailable()).toBe(false);
    expect(provider().requiresStatusRecheck).toBe(true);
    expect(provider().supportedMethods().map((m) => m.method.scheme)).toContain('CIB');
  });

  it('createIntent posts form-encoded millimes + ISO 4217 numeric currency', async () => {
    lastRequest = null;
    handlers = { '/register.do': { status: 200, body: { errorCode: 0, orderId: 'ctp_1', formUrl: 'https://test.clictopay.com/pay/ctp_1' } } };
    const result = await provider().createIntent({
      orderId: 'order-1',
      amount: '125.5000',
      currencyCode: 'TND',
      idempotencyKey: 'i1',
      method: { type: 'CARD' },
    });
    expect(result.externalRef).toBe('ctp_1');
    expect(result.checkoutUrl).toBe('https://test.clictopay.com/pay/ctp_1');

    const params = new URLSearchParams(lastRequest!.body);
    expect(params.get('amount')).toBe('125500');
    expect(params.get('currency')).toBe('788');
    expect(params.get('userName')).toBe('user1');
    expect(params.get('orderNumber')).toBe('order-1');
  });

  it('createIntent rejects a non-zero errorCode', async () => {
    handlers = { '/register.do': { status: 200, body: { errorCode: 5, errorMessage: 'Duplicate order' } } };
    await expect(
      provider().createIntent({ orderId: 'o', amount: '1.0000', currencyCode: 'TND', idempotencyKey: 'k' }),
    ).rejects.toThrow(/ClicToPay error/);
  });

  it('getStatus maps SPS order status codes', async () => {
    handlers = { '/getOrderStatus.do': { status: 200, body: { ErrorCode: '0', OrderStatus: 2, OrderNumber: 'ctp_1', Amount: 125500, currency: '788' } } };
    const ok = await provider().getStatus('ctp_1');
    expect(ok.status).toBe('SUCCEEDED');
    expect(ok.amount).toBe('125.5000');

    handlers = { '/getOrderStatus.do': { status: 200, body: { ErrorCode: '0', OrderStatus: 6 } } };
    expect((await provider().getStatus('ctp_2')).status).toBe('FAILED');

    handlers = { '/getOrderStatus.do': { status: 200, body: { ErrorCode: '0', OrderStatus: 0 } } };
    expect((await provider().getStatus('ctp_3')).status).toBe('PENDING');
  });

  it('refund is explicitly unavailable (not implemented via an invented endpoint)', async () => {
    await expect(
      provider().refund({ externalRef: 'x', amount: '1.0000', currencyCode: 'TND', idempotencyKey: 'r' }),
    ).rejects.toThrow(/not exposed/);
  });

  it('verifyAndNormalizeWebhook extracts the order id and rejects missing ids', () => {
    const evt = provider().verifyAndNormalizeWebhook(JSON.stringify({ orderId: 'ctp_9' }), undefined);
    expect(evt.externalRef).toBe('ctp_9');
    expect(() => provider().verifyAndNormalizeWebhook(JSON.stringify({}), undefined)).toThrow();
  });
});

describe('minor-unit conversion', () => {
  it('round-trips TND (3 decimals) and EUR (2 decimals)', () => {
    expect(toMinorUnits('12.3450', 3)).toBe('12345');
    expect(fromMinorUnits('12345', 3)).toBe('12.3450');
    expect(toMinorUnits('10.00', 2)).toBe('1000');
    expect(fromMinorUnits('1000', 2)).toBe('10.0000');
  });

  it('rejects amounts with more precision than the currency allows', () => {
    expect(() => toMinorUnits('1.0001', 2)).toThrow();
  });
});