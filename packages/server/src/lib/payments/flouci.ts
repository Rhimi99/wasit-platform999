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
 * Flouci Payment Gateway adapter.
 *
 * Implemented strictly against Flouci's public documentation (https://docs.flouci.com):
 *   - POST /api/v2/generate_payment                     -> { result: { payment_id, link } }
 *   - GET  /api/v2/verify_payment/{payment_id}          -> { result: { status, amount, settlement_status } }
 *   - POST /api/v2/refund_payment  { payment_id }       -> { result: { refund_id, status } }
 *   - Authorization: Bearer <PUBLIC_KEY>:<PRIVATE_KEY>
 *   - Amounts are integer minor units (millimes for TND); TND has 3 decimals.
 *
 * Sandbox and production share the same base URL; only the keys differ. Flouci
 * does NOT document a webhook signature, so this adapter sets
 * `requiresStatusRecheck = true`: the service must confirm each event via
 * `verify_payment` instead of trusting the callback body.
 *
 * No credential is ever hardcoded — keys come from the environment. When they
 * are absent, `isAvailable()` is false and the service refuses to create an
 * intent rather than silently falling back to another rail.
 */
export class FlouciPaymentProvider implements PaymentProvider {
  readonly id = 'flouci';
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
    private readonly publicKey: string,
    private readonly privateKey: string,
  ) {}

  isAvailable(): boolean {
    return this.baseUrl.trim().length > 0 && this.publicKey.trim().length > 0 && this.privateKey.trim().length > 0;
  }

  supportedMethods(): ProviderCapability[] {
    const available = this.isAvailable();
    const reason = available ? undefined : 'Flouci credentials are not configured';
    return [
      // Flouci accepts Tunisian + international bank cards (Visa/Mastercard) and
      // the Flouci wallet on the same hosted page.
      { method: { type: 'CARD' }, available, reason },
      { method: { type: 'CARD', scheme: 'VISA' }, available, reason },
      { method: { type: 'CARD', scheme: 'MASTERCARD' }, available, reason },
      { method: { type: 'MOBILE_WALLET', scheme: 'FLOUCI_WALLET' }, available, reason },
    ];
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) throw ApiError.serviceUnavailable('Flouci is not configured');
  }

  private authHeader(): string {
    return `Bearer ${this.publicKey}:${this.privateKey}`;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = (body.result as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      throw ApiError.serviceUnavailable(`Flouci error: ${message}`);
    }
    return body;
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    this.assertAvailable();
    const decimals = currencyDecimals(input.currencyCode);
    const acceptCard = input.method?.type !== 'MOBILE_WALLET';
    const body = await this.request('/api/v2/generate_payment', {
      method: 'POST',
      body: JSON.stringify({
        amount: toMinorUnits(input.amount, decimals),
        developer_tracking_id: input.orderId,
        accept_card: acceptCard,
        success_link: input.successUrl ?? `${env.APP_URL}/checkout?payment=success`,
        fail_link: input.failUrl ?? `${env.APP_URL}/checkout?payment=failed`,
        webhook: input.webhookUrl ?? `${env.API_URL}/api/payment-webhooks`,
      }),
    });
    const result = (body.result ?? {}) as { success?: boolean; payment_id?: string; link?: string };
    if (!result.success || !result.payment_id) {
      throw ApiError.serviceUnavailable('Flouci did not return a payment id');
    }
    return {
      externalRef: String(result.payment_id),
      status: 'PENDING',
      checkoutUrl: result.link ? String(result.link) : null,
      raw: body,
    };
  }

  async getStatus(externalRef: string): Promise<ProviderStatus> {
    this.assertAvailable();
    const body = await this.request(`/api/v2/verify_payment/${encodeURIComponent(externalRef)}`, { method: 'GET' });
    const result = (body.result ?? {}) as {
      status?: string;
      amount?: number | string;
      settlement_status?: string;
    };
    const rawStatus = String(result.status ?? '').toUpperCase();
    return {
      status: mapFlouciStatus(rawStatus),
      externalRef,
      amount: result.amount != null ? fromMinorUnits(result.amount, 3) : null,
      currencyCode: result.amount != null ? 'TND' : null,
      settlementStatus: result.settlement_status ?? null,
      raw: body,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.assertAvailable();
    const body = await this.request('/api/v2/refund_payment', {
      method: 'POST',
      body: JSON.stringify({ payment_id: input.externalRef }),
    });
    const result = (body.result ?? {}) as { status?: string; refund_id?: string };
    const ok = String(result.status ?? body.status ?? '').toLowerCase() === 'success';
    return {
      externalRef: result.refund_id ? String(result.refund_id) : input.externalRef,
      status: ok ? 'SUCCEEDED' : 'FAILED',
      raw: body,
    };
  }

  /**
   * Flouci documents a configurable webhook URL but NOT the payload schema nor a
   * signature. We therefore normalise defensively: any `payment_id` we can find
   * becomes the external reference, and the service then re-checks the true
   * status via `getStatus`. A payload without a payment id is rejected.
   */
  verifyAndNormalizeWebhook(rawBody: string, _signature: string | undefined): NormalizedWebhookEvent {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw ApiError.validation([{ field: 'body', message: 'Invalid JSON payload', code: 'VALIDATION_FAILED' }]);
    }
    const result = (parsed.result ?? {}) as Record<string, unknown>;
    const paymentId =
      parsed.payment_id ?? result.payment_id ?? parsed.paymentId ?? null;
    if (!paymentId) {
      throw ApiError.validation([{ field: 'payment_id', message: 'Webhook payload has no payment id', code: 'VALIDATION_FAILED' }]);
    }
    const ref = String(paymentId);
    return {
      // Flouci provides no event id; the payment id identifies the occurrence,
      // and `requiresStatusRecheck` makes the confirmed provider status decisive.
      eventId: `flouci_${ref}`,
      eventType: 'UNKNOWN',
      externalRef: ref,
      amount: null,
      currencyCode: null,
      raw: parsed,
    };
  }
}

function mapFlouciStatus(status: string): ProviderStatus['status'] {
  if (status === 'SUCCESS') return 'SUCCEEDED';
  if (status === 'FAILURE' || status === 'EXPIRED' || status === 'SYSTEM_FAILURE') return 'FAILED';
  return 'PENDING';
}

export function resolveFlouci(): FlouciPaymentProvider {
  return new FlouciPaymentProvider(
    env.FLOUCI_BASE_URL?.trim() ?? 'https://developers.flouci.com',
    env.FLOUCI_PUBLIC_KEY?.trim() ?? '',
    env.FLOUCI_PRIVATE_KEY?.trim() ?? '',
  );
}