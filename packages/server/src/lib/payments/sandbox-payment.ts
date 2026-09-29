import { ApiError } from '@wasit/shared';
import { computeWebhookSignature, verifyHmacSignature } from './providers';
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
 * SANDBOX payment provider — a controllable test/demo harness, NOT an acquirer.
 *
 * It exists so every branch of the payment lifecycle can be driven from a test
 * or a demo without an external service: success, failure, pending, amount
 * mismatch, currency mismatch, delayed webhook, duplicate event, malformed
 * webhook, provider error and timeout.
 *
 * Three things keep it from ever behaving like a real rail:
 *   1. It declares `demo: true`, so `resolvePaymentProvider()` refuses it unless
 *      the deployment is explicitly in demo payment mode.
 *   2. It declares `settlementEvidence: false`, so it can NEVER lift a ledger
 *      entry to `SETTLED` — only a provider that can prove funds moved may.
 *   3. Its references are prefixed `sandbox_`, so a sandbox artefact is
 *      identifiable on sight and can never be mistaken for a bank reference.
 *
 * A scenario is chosen per intent; the default is `pending`, because issuing an
 * intent is a request, not a payment.
 */

export type SandboxPaymentScenario =
  | 'pending'
  | 'success'
  | 'failure'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'delayed_webhook'
  | 'duplicate_event'
  | 'malformed_webhook'
  | 'provider_error'
  | 'timeout';

const SCENARIOS: readonly SandboxPaymentScenario[] = [
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
];

export function isSandboxPaymentScenario(value: string): value is SandboxPaymentScenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** Marks a webhook event that must be delivered twice to prove idempotency. */
const DUPLICATE_EVENT_SUFFIX = '-dup';

export class SandboxPaymentProvider implements PaymentProvider {
  readonly id = 'sandbox';
  readonly isFunctional = true;
  /**
   * `demo: true` → refused outside demo mode. `settlementEvidence: false` → this
   * harness can never be the proof behind a `SETTLED` ledger entry.
   * `payout: true` is truthful here: the sandbox ships a matching payout harness,
   * so the payout path can be exercised end-to-end without a real rail.
   */
  readonly capabilities = { settlementEvidence: false, payout: true, demo: true };
  readonly requiresStatusRecheck = false;

  private readonly scenarios = new Map<string, SandboxPaymentScenario>();

  constructor(private readonly webhookSecret: string = process.env.PAYMENT_WEBHOOK_SECRET ?? '') {}

  /** Selects the scenario an intent will follow. */
  setScenario(externalRef: string, scenario: SandboxPaymentScenario): void {
    if (!isSandboxPaymentScenario(scenario)) {
      throw ApiError.validation([
        { field: 'scenario', message: `Unknown sandbox scenario '${scenario}'`, code: 'VALIDATION_FAILED' },
      ]);
    }
    this.scenarios.set(externalRef, scenario);
  }

  scenarioFor(externalRef: string): SandboxPaymentScenario {
    return this.scenarios.get(externalRef) ?? 'pending';
  }

  isAvailable(): boolean {
    return true;
  }

  supportedMethods(): ProviderCapability[] {
    return [
      { method: { type: 'CARD' }, available: true, reason: 'Sandbox scenario harness' },
      { method: { type: 'MOBILE_WALLET' }, available: true, reason: 'Sandbox scenario harness' },
    ];
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    const externalRef = `sandbox_${input.orderId}_${input.idempotencyKey.slice(0, 12)}`;
    const scenario = this.scenarioFor(externalRef);

    if (scenario === 'provider_error') {
      throw ApiError.serviceUnavailable('Sandbox payment provider simulated an upstream error');
    }
    if (scenario === 'timeout') {
      throw ApiError.serviceUnavailable('Sandbox payment provider simulated a timeout');
    }
    // Issuing an intent never marks it paid: even the success scenario returns
    // PENDING and completes only via its webhook, so the real evidence path runs.
    return {
      externalRef,
      status: 'PENDING',
      checkoutUrl: `https://sandbox.invalid/checkout/${externalRef}`,
      raw: { sandbox: true, scenario },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { externalRef: `sandboxrf_${input.idempotencyKey.slice(0, 12)}`, status: 'SUCCEEDED', raw: { sandbox: true } };
  }

  async getStatus(externalRef: string): Promise<ProviderStatus> {
    const scenario = this.scenarioFor(externalRef);
    if (scenario === 'provider_error') {
      throw ApiError.serviceUnavailable('Sandbox payment provider simulated an upstream error');
    }
    if (scenario === 'timeout') {
      throw ApiError.serviceUnavailable('Sandbox payment provider simulated a timeout');
    }
    const status: ProviderStatus['status'] =
      scenario === 'success' || scenario === 'amount_mismatch' || scenario === 'currency_mismatch' || scenario === 'duplicate_event'
        ? 'SUCCEEDED'
        : scenario === 'failure'
          ? 'FAILED'
          : 'PENDING';
    return { status, externalRef, amount: null, currencyCode: null, raw: { sandbox: true, scenario } };
  }

  /**
   * Verifies the HMAC signature and normalizes a sandbox webhook. A malformed
   * payload throws (fail closed) rather than being treated as an empty event.
   */
  verifyAndNormalizeWebhook(rawBody: string, signature: string | undefined): NormalizedWebhookEvent {
    verifyHmacSignature(rawBody, signature, this.webhookSecret);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw ApiError.validation([
        { field: 'body', message: 'Sandbox webhook payload is not valid JSON', code: 'VALIDATION_FAILED' },
      ]);
    }

    const externalRef = parsed.externalRef ? String(parsed.externalRef) : null;
    const scenario = externalRef ? this.scenarioFor(externalRef) : 'pending';

    if (scenario === 'malformed_webhook') {
      // Structurally valid JSON, but not a usable event.
      throw ApiError.validation([
        { field: 'body', message: 'Sandbox webhook payload is missing required fields', code: 'VALIDATION_FAILED' },
      ]);
    }

    const baseEventId = String(parsed.eventId ?? parsed.id ?? '');
    // The duplicate scenario appends a suffix so the SAME logical event arrives
    // with a stable id twice — exactly what the idempotency guard must absorb.
    const eventId = scenario === 'duplicate_event' ? `${baseEventId}${DUPLICATE_EVENT_SUFFIX}` : baseEventId;

    // Amount/currency mismatch scenarios deliberately report figures that do not
    // match the intent, so the service's evidence check must reject them.
    let amount = parsed.amount != null ? String(parsed.amount) : null;
    let currencyCode = parsed.currencyCode ? String(parsed.currencyCode) : null;
    if (scenario === 'amount_mismatch') amount = '0.0001';
    if (scenario === 'currency_mismatch') currencyCode = 'USD';

    return {
      eventId,
      eventType: mapSandboxEventType(String(parsed.type ?? '')),
      externalRef,
      amount,
      currencyCode,
      raw: { ...parsed, sandbox: true, scenario },
    };
  }

  /** Emits a signed sandbox webhook body. Test/demo helper only. */
  buildSignedWebhook(payload: Record<string, unknown>): { body: string; signature: string } {
    const body = JSON.stringify(payload);
    return { body, signature: computeWebhookSignature(body, this.webhookSecret) };
  }

  /** Whether a webhook for this intent should be withheld until re-checked (delayed delivery). */
  isDelayed(externalRef: string): boolean {
    return this.scenarioFor(externalRef) === 'delayed_webhook';
  }
}

function mapSandboxEventType(t: string): NormalizedWebhookEvent['eventType'] {
  const v = t.toLowerCase();
  if (v.includes('settl')) return 'SETTLEMENT_CONFIRMED';
  if (v.includes('refund')) return v.includes('fail') ? 'UNKNOWN' : 'REFUND_SUCCEEDED';
  if (v.includes('succeed') || v === 'payment.paid') return 'PAYMENT_SUCCEEDED';
  if (v.includes('fail')) return 'PAYMENT_FAILED';
  return 'UNKNOWN';
}
