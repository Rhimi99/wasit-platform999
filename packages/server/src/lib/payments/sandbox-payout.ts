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
 * SANDBOX payout provider — a controllable test harness, NOT a financial rail.
 *
 * It exists so the payout lifecycle (dispatch → PROCESSING → evidence →
 * COMPLETED/FAILED/HELD) can be exercised end-to-end, including the failure and
 * mismatch paths, without any external service. It moves no money and can never
 * prove a transfer: the only "transfer reference" it can emit is a clearly
 * synthetic `sandbox_*` marker.
 *
 * It declares `demo: true`, so `resolvePayoutProvider()` refuses it on any
 * deployment that is not explicitly in demo payment mode. That is deliberate:
 * a live stack must never treat this harness as a payout rail.
 *
 * The scenario is selected per payout so a test can drive a specific path; the
 * default is `processing`, because a create request is not a transfer.
 */

export type SandboxPayoutScenario =
  | 'processing'
  | 'completed'
  | 'failed'
  | 'held'
  | 'completed_without_reference'
  | 'amount_mismatch'
  | 'provider_error';

const SCENARIOS: readonly SandboxPayoutScenario[] = [
  'processing',
  'completed',
  'failed',
  'held',
  'completed_without_reference',
  'amount_mismatch',
  'provider_error',
];

export function isSandboxPayoutScenario(value: string): value is SandboxPayoutScenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

export class SandboxPayoutProvider implements PayoutProvider {
  readonly id = 'sandbox';
  readonly isFunctional = true;
  readonly capabilities = {
    createPayout: true,
    transferReference: true,
    cancel: true,
    statusQuery: true,
    demo: true,
  } as const;

  /**
   * Per-payout scenario map. Keyed by payout id so concurrent tests do not
   * interfere. Deliberately in-memory: this is a test harness, not state.
   */
  private readonly scenarios = new Map<string, SandboxPayoutScenario>();

  /** Selects the scenario a specific payout will follow. */
  setScenario(payoutId: string, scenario: SandboxPayoutScenario): void {
    if (!isSandboxPayoutScenario(scenario)) {
      throw ApiError.validation([
        { field: 'scenario', message: `Unknown sandbox scenario '${scenario}'`, code: 'VALIDATION_FAILED' },
      ]);
    }
    this.scenarios.set(payoutId, scenario);
  }

  scenarioFor(payoutId: string): SandboxPayoutScenario {
    return this.scenarios.get(payoutId) ?? 'processing';
  }

  isAvailable(): boolean {
    // Always constructible; whether it may RUN is decided by demo mode in the
    // resolver, so availability here only means "not misconfigured".
    return true;
  }

  async createPayout(input: CreatePayoutRequest): Promise<CreatePayoutResult> {
    const scenario = this.scenarioFor(input.payoutId);
    if (scenario === 'provider_error') {
      throw ApiError.serviceUnavailable('Sandbox payout provider simulated an upstream error');
    }
    if (scenario === 'failed') {
      return {
        providerRef: `sandbox_po_${input.payoutId.slice(0, 12)}`,
        status: 'FAILED',
        failureReason: 'Sandbox scenario: provider rejected the payout',
      };
    }
    // Every non-failure scenario returns a synthetic reference and stays
    // PROCESSING at creation — even 'completed', which only completes when the
    // status is re-checked, so tests exercise the evidence path.
    return { providerRef: `sandbox_po_${input.payoutId.slice(0, 12)}`, status: 'PROCESSING' };
  }

  async getPayoutStatus(providerRef: string): Promise<PayoutProviderStatus> {
    // The scenario was keyed by payout id; the synthetic ref embeds a prefix of
    // it, so resolve the scenario from the ref's suffix when possible.
    const scenario = this.scenarioFromRef(providerRef);
    const base = { providerRef, currencyCode: null, amount: null } as PayoutProviderStatus;

    switch (scenario) {
      case 'completed':
        return { ...base, status: 'COMPLETED', payoutRef: `sandbox_tr_${providerRef.slice(-12)}` };
      case 'completed_without_reference':
        // The rail claims success but supplies no proof. The engine must refuse.
        return { ...base, status: 'COMPLETED', payoutRef: null };
      case 'amount_mismatch':
        return {
          ...base,
          status: 'COMPLETED',
          payoutRef: `sandbox_tr_${providerRef.slice(-12)}`,
          amount: '0.0001',
          currencyCode: 'TND',
        };
      case 'failed':
        return { ...base, status: 'FAILED', payoutRef: null };
      case 'held':
        return { ...base, status: 'HELD', payoutRef: null };
      case 'provider_error':
        throw ApiError.serviceUnavailable('Sandbox payout provider simulated an upstream error');
      default:
        return { ...base, status: 'PROCESSING', payoutRef: null };
    }
  }

  async cancelPayout(providerRef: string): Promise<CancelPayoutResult> {
    return { providerRef, cancelled: true, reason: 'Sandbox cancellation' };
  }

  verifyAndNormalizeEvent(rawBody: string, signature: string | undefined): PayoutProviderEvent {
    // A sandbox event is only accepted when it is explicitly signed with the
    // configured webhook secret — the same fail-closed rule as a real rail.
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
    verifyHmacSignature(rawBody, signature, secret);
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const rawType = String(parsed.type ?? '').toLowerCase();
    return {
      eventId: String(parsed.id ?? parsed.eventId ?? ''),
      type: rawType.includes('complet')
        ? 'payout.completed'
        : rawType.includes('fail')
          ? 'payout.failed'
          : rawType.includes('hold')
            ? 'payout.held'
            : 'payout.processing',
      providerRef: parsed.providerRef ? String(parsed.providerRef) : null,
      payoutRef: parsed.payoutRef ? String(parsed.payoutRef) : null,
      amount: parsed.amount != null ? String(parsed.amount) : null,
      currencyCode: parsed.currencyCode ? String(parsed.currencyCode) : null,
      reason: parsed.reason ? String(parsed.reason) : null,
      occurredAt: parsed.occurredAt ? String(parsed.occurredAt) : null,
      raw: parsed,
    };
  }

  private scenarioFromRef(providerRef: string): SandboxPayoutScenario {
    for (const [payoutId, scenario] of this.scenarios) {
      if (providerRef.includes(payoutId.slice(0, 12))) return scenario;
    }
    return 'processing';
  }
}

/** Process-wide sandbox payout provider so a test can set a scenario and have it observed. */
export const sandboxPayoutProvider = new SandboxPayoutProvider();
