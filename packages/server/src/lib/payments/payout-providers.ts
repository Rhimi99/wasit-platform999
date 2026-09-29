import { ApiError } from '@wasit/shared';
import { verifyHmacSignature } from './providers';
import type {
  CancelPayoutResult,
  CreatePayoutRequest,
  CreatePayoutResult,
  PayoutProvider,
  PayoutProviderEvent,
  PayoutProviderStatus,
} from './payout-port';

/**
 * Payout provider adapters.
 *
 * Each adapter is a *transport* to an external rail. None of them decides a
 * payout's status: they open a payout, report what the rail says, and return
 * evidence. `applyPayoutEvent` (the engine) is what turns that evidence into a
 * `COMPLETED` payout — and it refuses to do so without a transfer reference and
 * an exact amount/currency match.
 *
 * There is deliberately NO adapter here for a real bank or licensed payout
 * institution: wiring one requires a real commercial integration against this
 * interface. `open-checkout` is a generic HTTP contract, not an institution.
 */

/**
 * Noop payout provider — a wiring-only harness. It never moves money and reports
 * that it is NOT functional, so the service refuses to treat a payout as
 * dispatched through it.
 */
export class NoopPayoutProvider implements PayoutProvider {
  readonly id = 'noop';
  readonly isFunctional = false;
  readonly capabilities = {
    createPayout: false,
    transferReference: false,
    cancel: false,
    statusQuery: false,
    demo: false,
  } as const;
  isAvailable(): boolean {
    return false;
  }
  async createPayout(): Promise<CreatePayoutResult> {
    throw ApiError.serviceUnavailable('Payout provider is not configured');
  }
  async getPayoutStatus(): Promise<PayoutProviderStatus> {
    throw ApiError.serviceUnavailable('Payout provider is not configured');
  }
}

/**
 * Manual payout desk — the offline rail used when payouts are executed by hand
 * (bank transfer arranged out of band). It is a demonstration harness: it can
 * acknowledge a request but can never produce a transfer reference proving the
 * funds moved, so it cannot complete a payout by itself.
 */
export class ManualPayoutProvider implements PayoutProvider {
  readonly id = 'manual';
  readonly isFunctional = true;
  readonly capabilities = {
    createPayout: true,
    transferReference: false,
    cancel: true,
    statusQuery: false,
    demo: true,
  } as const;
  isAvailable(): boolean {
    return true;
  }
  async createPayout(input: CreatePayoutRequest): Promise<CreatePayoutResult> {
    // A local marker, never a bank/transfer reference. Status stays PROCESSING
    // because the offline desk has not proven anything yet.
    return {
      providerRef: `manualpo_${input.payoutId.slice(0, 12)}`,
      status: 'PROCESSING',
    };
  }
  async getPayoutStatus(providerRef: string): Promise<PayoutProviderStatus> {
    return { providerRef, status: 'UNKNOWN', payoutRef: null, amount: null, currencyCode: null };
  }
  async cancelPayout(providerRef: string): Promise<CancelPayoutResult> {
    return { providerRef, cancelled: true, reason: 'Offline desk cancellation' };
  }
}

/**
 * Generic hosted payout adapter. Speaks a minimal JSON contract (`POST /payouts`,
 * `GET /payouts/:ref`, `POST /payouts/:ref/cancel`) authenticated with a bearer
 * secret and made idempotent via `Idempotency-Key`.
 *
 * This is a transport, not a financial institution: it becomes usable only when
 * an operator points it at a real rail that implements the contract. It never
 * fabricates a transfer reference — it only forwards what the rail returns.
 */
export class OpenCheckoutPayoutProvider implements PayoutProvider {
  readonly id = 'open-checkout';
  readonly isFunctional = true;
  readonly capabilities = {
    createPayout: true,
    transferReference: true,
    cancel: true,
    statusQuery: true,
    demo: false,
  } as const;
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}
  isAvailable(): boolean {
    return this.baseUrl.length > 0 && this.apiKey.length > 0;
  }
  private assertAvailable(): void {
    if (!this.isAvailable()) throw ApiError.serviceUnavailable('Payout provider is not configured');
  }
  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;
    return h;
  }
  async createPayout(input: CreatePayoutRequest): Promise<CreatePayoutResult> {
    this.assertAvailable();
    const res = await fetch(`${this.baseUrl}/payouts`, {
      method: 'POST',
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currencyCode,
        reference: input.payoutId,
        order: input.orderId,
        beneficiary: input.beneficiaryRef,
        description: input.description ?? null,
      }),
    });
    if (!res.ok) throw ApiError.serviceUnavailable(`Payout provider error (${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    const status = String(body.status ?? 'processing').toLowerCase();
    return {
      providerRef: String(body.id ?? body.payoutId ?? ''),
      // Creation is a request, not a transfer: anything that is not an explicit
      // failure is PROCESSING until the rail proves otherwise.
      status: status === 'failed' ? 'FAILED' : 'PROCESSING',
      failureReason: status === 'failed' ? String(body.reason ?? 'Provider rejected the payout') : null,
      raw: body,
    };
  }
  async getPayoutStatus(providerRef: string): Promise<PayoutProviderStatus> {
    this.assertAvailable();
    const res = await fetch(`${this.baseUrl}/payouts/${encodeURIComponent(providerRef)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw ApiError.serviceUnavailable(`Payout provider error (${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    const raw = String(body.status ?? '').toLowerCase();
    const status: PayoutProviderStatus['status'] =
      raw === 'completed'
        ? 'COMPLETED'
        : raw === 'failed'
          ? 'FAILED'
          : raw === 'held'
            ? 'HELD'
            : raw === 'processing'
              ? 'PROCESSING'
              : 'UNKNOWN';
    return {
      providerRef,
      status,
      // The rail's transfer reference, present only once funds actually moved.
      payoutRef: body.transferId ? String(body.transferId) : body.payoutRef ? String(body.payoutRef) : null,
      amount: body.amount != null ? String(body.amount) : null,
      currencyCode: body.currency ? String(body.currency) : body.currencyCode ? String(body.currencyCode) : null,
      raw: body,
    };
  }
  async cancelPayout(providerRef: string): Promise<CancelPayoutResult> {
    this.assertAvailable();
    const res = await fetch(`${this.baseUrl}/payouts/${encodeURIComponent(providerRef)}/cancel`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw ApiError.serviceUnavailable(`Payout provider error (${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      providerRef,
      cancelled: body.cancelled === true || String(body.status ?? '').toLowerCase() === 'cancelled',
      reason: body.reason ? String(body.reason) : null,
      raw: body,
    };
  }
  verifyAndNormalizeEvent(rawBody: string, signature: string | undefined): PayoutProviderEvent {
    verifyHmacSignature(rawBody, signature, this.webhookSecret());
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return normalizePayoutEvent(parsed);
  }
  private webhookSecret(): string {
    // The payout rail signs with the same webhook secret as the payment rail;
    // an unset secret means every signature check fails closed.
    return process.env.PAYMENT_WEBHOOK_SECRET ?? '';
  }
}

/** Maps a rail payload onto the normalized payout event shape. */
export function normalizePayoutEvent(parsed: Record<string, unknown>): PayoutProviderEvent {
  const rawType = String(parsed.type ?? '').toLowerCase();
  const type: PayoutProviderEvent['type'] =
    rawType.includes('complet') || rawType.includes('paid')
      ? 'payout.completed'
      : rawType.includes('fail')
        ? 'payout.failed'
        : rawType.includes('hold')
          ? 'payout.held'
          : 'payout.processing';
  return {
    eventId: String(parsed.id ?? parsed.eventId ?? ''),
    type,
    providerRef: parsed.providerRef ? String(parsed.providerRef) : parsed.payoutId ? String(parsed.payoutId) : null,
    payoutRef: parsed.transferId ? String(parsed.transferId) : parsed.payoutRef ? String(parsed.payoutRef) : null,
    amount: parsed.amount != null ? String(parsed.amount) : null,
    currencyCode: parsed.currencyCode ? String(parsed.currencyCode) : parsed.currency ? String(parsed.currency) : null,
    reason: parsed.reason ? String(parsed.reason) : null,
    occurredAt: parsed.occurredAt ? String(parsed.occurredAt) : null,
    raw: parsed,
  };
}
