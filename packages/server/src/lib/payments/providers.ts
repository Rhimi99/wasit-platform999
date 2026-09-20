import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@wasit/shared';
import { env } from '../env';
import { Decimal } from 'decimal.js';
import { toDecimal } from '../money';
import { currencyDecimals } from './currencies';
import type {
  CreateIntentInput,
  CreateIntentResult,
  NormalizedWebhookEvent,
  PaymentProvider,
  ProviderCapability,
  ProviderStatus,
  RefundInput,
  RefundResult,
} from './port';

/**
 * Noop provider — a wiring-only harness used by tests and by environments with
 * no provider configured. It never touches money and explicitly reports that it
 * is NOT functional so callers can refuse to treat an intent as really charged.
 */
export class NoopPaymentProvider implements PaymentProvider {
  readonly id = 'noop';
  readonly isFunctional = false;
  isAvailable(): boolean {
    return false;
  }
  supportedMethods(): ProviderCapability[] {
    return [];
  }
  async createIntent(_input: CreateIntentInput): Promise<CreateIntentResult> {
    throw ApiError.serviceUnavailable('Payment provider is not configured');
  }
  async refund(_input: RefundInput): Promise<RefundResult> {
    throw ApiError.serviceUnavailable('Payment provider is not configured');
  }
  verifyAndNormalizeWebhook(): NormalizedWebhookEvent {
    throw ApiError.unauthorized('Webhook verification is not available');
  }
}

/**
 * Manual / offline provider: no external network. A payment intent is recorded
 * and the operator (or a signed webhook emitted by the settlement desk) moves it
 * to SUCCEEDED/FAILED. This is a real, deployable mode used before an online
 * acquirer is contracted, not a placeholder.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly id = 'manual';
  readonly isFunctional = true;
  isAvailable(): boolean {
    return true;
  }
  /**
   * The offline desk settles any rail out of band, so it advertises both method
   * families. This is what keeps checkout testable before an online acquirer is
   * contracted — it is a real deployable mode, not a placeholder.
   */
  supportedMethods(): ProviderCapability[] {
    return [
      { method: { type: 'CARD' }, available: true },
      { method: { type: 'CARD', scheme: 'VISA' }, available: true },
      { method: { type: 'CARD', scheme: 'MASTERCARD' }, available: true },
      { method: { type: 'CARD', scheme: 'CIB' }, available: true },
      { method: { type: 'MOBILE_WALLET' }, available: true },
      { method: { type: 'MOBILE_WALLET', scheme: 'D17' }, available: true, reason: 'Settled manually via the offline desk' },
      { method: { type: 'MOBILE_WALLET', scheme: 'FLOUCI_WALLET' }, available: true, reason: 'Settled manually via the offline desk' },
    ];
  }
  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    return {
      externalRef: `manual_${input.orderId}_${input.idempotencyKey.slice(0, 12)}`,
      status: 'PENDING',
      checkoutUrl: null,
    };
  }
  async refund(input: RefundInput): Promise<RefundResult> {
    return { externalRef: `manualrf_${input.idempotencyKey.slice(0, 12)}`, status: 'SUCCEEDED' };
  }
  verifyAndNormalizeWebhook(rawBody: string, signature: string | undefined): NormalizedWebhookEvent {
    verifyHmacSignature(rawBody, signature, env.PAYMENT_WEBHOOK_SECRET);
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      eventId: String(parsed.eventId ?? ''),
      eventType: mapEventType(String(parsed.type ?? '')),
      externalRef: parsed.externalRef ? String(parsed.externalRef) : null,
      amount: parsed.amount != null ? String(parsed.amount) : null,
      currencyCode: parsed.currencyCode ? String(parsed.currencyCode) : null,
      raw: parsed,
    };
  }
}

/**
 * Open (OpenAI-style) hosted-checkout adapter. Kept deliberately generic: it
 * speaks a minimal JSON contract (`/payment_intents`, `/refunds`) so any
 * acquirer or aggregator that follows it can be plugged in without core
 * changes. Requests are authenticated with a bearer secret and are idempotent
 * via the `Idempotency-Key` header.
 */
export class OpenCheckoutPaymentProvider implements PaymentProvider {
  readonly id = 'open-checkout';
  readonly isFunctional = true;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}
  isAvailable(): boolean {
    return this.baseUrl.length > 0 && this.apiKey.length > 0;
  }
  supportedMethods(): ProviderCapability[] {
    const available = this.isAvailable();
    return [
      { method: { type: 'CARD' }, available },
      { method: { type: 'MOBILE_WALLET' }, available },
    ];
  }
  private assertAvailable(): void {
    if (!this.isAvailable()) throw ApiError.serviceUnavailable('Payment provider is not configured');
  }
  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    this.assertAvailable();
    const res = await fetch(`${this.baseUrl}/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currencyCode,
        reference: input.orderId,
        description: input.description ?? null,
      }),
    });
    if (!res.ok) throw ApiError.serviceUnavailable(`Payment provider error (${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      externalRef: String(body.id ?? body.intentId ?? ''),
      status: normalizeStatus(String(body.status ?? 'PENDING')),
      checkoutUrl: body.checkoutUrl ? String(body.checkoutUrl) : body.url ? String(body.url) : null,
      raw: body,
    };
  }
  async refund(input: RefundInput): Promise<RefundResult> {
    this.assertAvailable();
    const res = await fetch(`${this.baseUrl}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        paymentIntent: input.externalRef,
        amount: input.amount,
        currency: input.currencyCode,
        reason: input.reason ?? null,
      }),
    });
    if (!res.ok) throw ApiError.serviceUnavailable(`Payment provider error (${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      externalRef: String(body.id ?? body.refundId ?? input.externalRef),
      status: String(body.status ?? '').toLowerCase() === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      raw: body,
    };
  }
  verifyAndNormalizeWebhook(rawBody: string, signature: string | undefined): NormalizedWebhookEvent {
    verifyHmacSignature(rawBody, signature, env.PAYMENT_WEBHOOK_SECRET);
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      eventId: String(parsed.id ?? parsed.eventId ?? ''),
      eventType: mapEventType(String(parsed.type ?? '')),
      externalRef: parsed.paymentIntent ? String(parsed.paymentIntent) : parsed.externalRef ? String(parsed.externalRef) : null,
      amount: parsed.amount != null ? String(parsed.amount) : null,
      currencyCode: parsed.currency ? String(parsed.currency) : null,
      raw: parsed,
    };
  }
}

/** HMAC-SHA256 webhook verification with a constant-time compare. */
export function verifyHmacSignature(rawBody: string, signature: string | undefined, secret: string): void {
  if (!secret || secret.length === 0) {
    throw ApiError.serviceUnavailable('Webhook secret is not configured');
  }
  if (!signature) throw ApiError.unauthorized('Missing webhook signature');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = signature.trim().replace(/^sha256=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('Invalid webhook signature');
  }
}

export function computeWebhookSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function normalizeStatus(s: string): 'PENDING' | 'SUCCEEDED' | 'FAILED' {
  const v = s.toLowerCase();
  if (v === 'succeeded' || v === 'paid' || v === 'completed') return 'SUCCEEDED';
  if (v === 'failed' || v === 'canceled' || v === 'cancelled') return 'FAILED';
  return 'PENDING';
}

/**
 * Converts WASIT's 4-decimal money string into the integer minor-unit string a
 * provider expects (Flouci/ClicToPay take the smallest currency unit, e.g.
 * millimes for TND). `decimals` is the currency exponent; TND is 3.
 */
export function toMinorUnits(amount: string | number, decimals: number): string {
  const scaled = toDecimal(amount).times(new Decimal(10).pow(decimals));
  if (!scaled.isInteger()) {
    throw ApiError.validation([{ field: 'amount', message: 'Amount has more precision than the currency allows', code: 'VALIDATION_FAILED' }]);
  }
  return scaled.toFixed(0);
}

/** Inverse of {@link toMinorUnits}: integer minor units → 4-decimal money string. */
export function fromMinorUnits(minor: string | number, decimals: number): string {
  return toDecimal(minor).div(new Decimal(10).pow(decimals)).toFixed(4);
}

function mapEventType(t: string): NormalizedWebhookEvent['eventType'] {
  const v = t.toLowerCase();
  // Refund must be matched before the generic "succeed" test, since
  // `refund.succeeded` also contains "succeed".
  if (v.includes('refund')) return v.includes('fail') ? 'UNKNOWN' : 'REFUND_SUCCEEDED';
  if (v.includes('succeed') || v === 'payment.paid') return 'PAYMENT_SUCCEEDED';
  if (v.includes('fail')) return 'PAYMENT_FAILED';
  return 'UNKNOWN';
}

