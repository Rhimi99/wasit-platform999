import { ApiError } from '@wasit/shared';
import { env } from '../env';
import { currencyDecimals } from './currencies';
import { fromMinorUnits, toMinorUnits } from './providers';
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
 * ClicToPay (SPS Monétique Tunisie) adapter.
 *
 * Implemented against the publicly documented ClicToPay REST contract used by
 * the official SPS integration kits:
 *   - POST {base}/register.do         { userName, password, orderNumber, amount, currency, returnUrl, language }
 *                                     -> { errorCode: 0, orderId, formUrl }
 *   - GET  {base}/getOrderStatus.do   ?orderId=&userName=&password=
 *                                     -> { ErrorCode, OrderStatus, OrderNumber, Amount, currency }
 *
 * `amount` is in minor units (millimes for TND) and `currency` is the ISO 4217
 * *numeric* code (TND = 788). Sandbox and production are different hosts:
 *   sandbox    https://test.clictopay.com/payment/rest
 *   production https://ipay.clictopay.com/payment/rest
 *
 * Notes / limits (see docs/PAYMENT_PROVIDERS.md):
 *   - The signature of the callback is NOT documented, so `requiresStatusRecheck`
 *     is true: the service confirms every event via getOrderStatus.do.
 *   - The REST API for reversals/refunds is not publicly documented; `refund()`
 *     therefore reports unavailable until SPS confirms the endpoint/contract.
 *   - Credentials come from the environment only.
 */
export class ClicToPayPaymentProvider implements PaymentProvider {
  readonly id = 'clictopay';
  readonly isFunctional = true;
  /**
   * A licensed acquirer: it exposes transfer-level settlement and pays out
   * through its own API, so it can be the evidence behind `SETTLED` and a
   * seller payout reference.
   */
  readonly capabilities = { settlementEvidence: true, payout: true, demo: false };
  readonly requiresStatusRecheck = true;

  constructor(
    private readonly baseUrl: string,
    private readonly userName: string,
    private readonly password: string,
  ) {}

  isAvailable(): boolean {
    return this.baseUrl.trim().length > 0 && this.userName.trim().length > 0 && this.password.trim().length > 0;
  }

  supportedMethods(): ProviderCapability[] {
    const available = this.isAvailable();
    const reason = available ? undefined : 'ClicToPay credentials are not configured';
    return [
      // ClicToPay settles Tunisian bank cards (CIB) and international Visa/Mastercard.
      { method: { type: 'CARD' }, available, reason },
      { method: { type: 'CARD', scheme: 'VISA' }, available, reason },
      { method: { type: 'CARD', scheme: 'MASTERCARD' }, available, reason },
      { method: { type: 'CARD', scheme: 'CIB' }, available, reason },
    ];
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) throw ApiError.serviceUnavailable('ClicToPay is not configured');
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    this.assertAvailable();
    const decimals = currencyDecimals(input.currencyCode);
    const params = new URLSearchParams({
      userName: this.userName,
      password: this.password,
      orderNumber: input.orderId,
      amount: toMinorUnits(input.amount, decimals),
      currency: isoNumericCode(input.currencyCode),
      returnUrl: input.successUrl ?? `${env.APP_URL}/checkout?payment=success`,
      failUrl: input.failUrl ?? `${env.APP_URL}/checkout?payment=failed`,
      language: 'fr',
    });
    const body = await this.post('/register.do', params);
    if (String(body.errorCode ?? '0') !== '0' || !body.orderId) {
      throw ApiError.serviceUnavailable(`ClicToPay error: ${String(body.errorMessage ?? body.errorCode ?? 'unknown')}`);
    }
    return {
      externalRef: String(body.orderId),
      status: 'PENDING',
      checkoutUrl: body.formUrl ? String(body.formUrl) : null,
      raw: body,
    };
  }

  async getStatus(externalRef: string): Promise<ProviderStatus> {
    this.assertAvailable();
    const params = new URLSearchParams({
      orderId: externalRef,
      userName: this.userName,
      password: this.password,
    });
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/getOrderStatus.do?${params.toString()}`, {
      method: 'GET',
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw ApiError.serviceUnavailable(`ClicToPay error (${res.status})`);
    if (String(body.ErrorCode ?? '0') !== '0') {
      throw ApiError.serviceUnavailable(`ClicToPay error: ${String(body.ErrorMessage ?? body.ErrorCode)}`);
    }
    const amountMinor = body.Amount != null ? String(body.Amount) : null;
    const decimals = currencyDecimals(inputCurrency(body.currency));
    return {
      status: mapOrderStatus(Number(body.OrderStatus ?? 0)),
      externalRef,
      amount: amountMinor != null ? fromMinorUnits(amountMinor, decimals) : null,
      currencyCode: inputCurrency(body.currency),
      raw: body,
    };
  }

  /** Reversals are not part of the public ClicToPay REST contract — see the class docs. */
  async refund(_input: RefundInput): Promise<RefundResult> {
    throw ApiError.serviceUnavailable('ClicToPay refunds are not exposed via the documented REST API');
  }

  /** ClicToPay has no documented webhook payload; the service re-checks state instead. */
  verifyAndNormalizeWebhook(rawBody: string, _signature: string | undefined): NormalizedWebhookEvent {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw ApiError.validation([{ field: 'body', message: 'Invalid JSON payload', code: 'VALIDATION_FAILED' }]);
    }
    const orderId = parsed.orderId ?? parsed.mdOrder ?? parsed.OrderNumber ?? null;
    if (!orderId) {
      throw ApiError.validation([{ field: 'orderId', message: 'Webhook payload has no order id', code: 'VALIDATION_FAILED' }]);
    }
    return {
      eventId: `clictopay_${String(orderId)}`,
      eventType: 'UNKNOWN',
      externalRef: String(orderId),
      amount: null,
      currencyCode: null,
      raw: parsed,
    };
  }

  private async post(path: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw ApiError.serviceUnavailable(`ClicToPay error (${res.status})`);
    return body;
  }
}

/** Maps ClicToPay/SPS `OrderStatus` codes to a normalized state. */
function mapOrderStatus(orderStatus: number): ProviderStatus['status'] {
  if (orderStatus === 2) return 'SUCCEEDED'; // fully authorized / paid
  if (orderStatus === 3 || orderStatus === 4) return 'FAILED'; // reversed / refunded
  if (orderStatus === 6) return 'FAILED'; // auth declined
  return 'PENDING'; // 0 registered, 1 pre-auth, 5 ACS in progress
}

const ISO_NUMERIC: Record<string, string> = {
  TND: '788',
  EUR: '978',
  USD: '840',
  GBP: '826',
};

function isoNumericCode(currencyCode: string): string {
  const code = currencyCode.trim().toUpperCase();
  return ISO_NUMERIC[code] ?? code;
}

function inputCurrency(value: unknown): string {
  const numeric = String(value ?? '');
  const found = Object.entries(ISO_NUMERIC).find(([, num]) => num === numeric);
  return found ? found[0] : 'TND';
}

export function resolveClicToPay(): ClicToPayPaymentProvider {
  return new ClicToPayPaymentProvider(
    env.CLICTOPAY_BASE_URL?.trim() ?? 'https://test.clictopay.com/payment/rest',
    env.CLICTOPAY_USERNAME?.trim() ?? '',
    env.CLICTOPAY_PASSWORD?.trim() ?? '',
  );
}