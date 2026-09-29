import { ApiError } from '@wasit/shared';
import { env, demoPaymentMode } from '../env';
import { ManualPayoutProvider, NoopPayoutProvider, OpenCheckoutPayoutProvider } from './payout-providers';
import { SandboxPayoutProvider } from './sandbox-payout';
import type { PayoutProvider } from './payout-port';

/**
 * Resolves the payout rail. Mirrors `resolvePaymentProvider`: the configured
 * `PAYOUT_PROVIDER` selects the rail, and a rail that declares itself a demo
 * harness is refused unless this deployment is explicitly a demo.
 *
 * Failing closed here is what stops a stray configuration from making the
 * platform believe a seller was paid through a harness that cannot move money.
 */
export function resolvePayoutProvider(): PayoutProvider {
  const provider = selectPayoutProvider();
  if (provider.capabilities.demo && !demoPaymentMode()) {
    throw ApiError.serviceUnavailable(
      `Payout provider '${provider.id}' is a demonstration harness and is refused because this ` +
        'deployment is not in demo payment mode (set DEMO_PAYMENT_MODE=true only for a public demo).',
    );
  }
  return provider;
}

function selectPayoutProvider(): PayoutProvider {
  switch (env.PAYOUT_PROVIDER) {
    case 'manual':
      return new ManualPayoutProvider();
    case 'open-checkout':
      return new OpenCheckoutPayoutProvider(env.PAYOUT_BASE_URL?.trim() ?? '', env.PAYOUT_API_KEY?.trim() ?? '');
    case 'sandbox':
      return new SandboxPayoutProvider();
    default:
      return new NoopPayoutProvider();
  }
}

/**
 * Resolves a payout rail by id, for flows that name it explicitly. Unknown ids
 * are refused rather than silently falling back, so a payout can never be routed
 * to an unconfigured channel.
 */
export function resolvePayoutProviderById(id: string): PayoutProvider {
  switch (id) {
    case 'noop':
      return new NoopPayoutProvider();
    case 'manual':
      return new ManualPayoutProvider();
    case 'open-checkout':
      return new OpenCheckoutPayoutProvider(env.PAYOUT_BASE_URL?.trim() ?? '', env.PAYOUT_API_KEY?.trim() ?? '');
    case 'sandbox':
      return new SandboxPayoutProvider();
    default:
      throw ApiError.validation([
        { field: 'provider', message: `Unknown payout provider '${id}'`, code: 'VALIDATION_FAILED' },
      ]);
  }
}

/** Describes every known payout rail for an operator view. Never exposes secrets. */
export function describePayoutProviders(): {
  active: string;
  providers: { id: string; functional: boolean; available: boolean; demo: boolean; transferReference: boolean }[];
} {
  return {
    active: env.PAYOUT_PROVIDER,
    providers: [
      new NoopPayoutProvider(),
      new ManualPayoutProvider(),
      new OpenCheckoutPayoutProvider(env.PAYOUT_BASE_URL?.trim() ?? '', env.PAYOUT_API_KEY?.trim() ?? ''),
      new SandboxPayoutProvider(),
    ].map((p) => ({
      id: p.id,
      functional: p.isFunctional,
      available: p.isFunctional && p.isAvailable(),
      demo: p.capabilities.demo,
      transferReference: p.capabilities.transferReference,
    })),
  };
}
