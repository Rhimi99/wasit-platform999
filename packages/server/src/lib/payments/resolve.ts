import { env, demoPaymentMode } from '../env';
import { ApiError } from '@wasit/shared';
import type { PaymentProvider, ProviderCapability } from './port';
import {
  ManualPaymentProvider,
  NoopPaymentProvider,
  OpenCheckoutPaymentProvider,
} from './providers';
import { resolveFlouci } from './flouci';
import { resolveClicToPay } from './clictopay';

/**
 * Resolves the configured payment provider. `PAYMENT_PROVIDER` selects the
 * vendor; unknown values fall back to the noop harness so the platform never
 * silently takes money through an unconfigured channel.
 *
 * A provider that declares itself a demo harness (the offline `manual` desk) is
 * refused unless this deployment is explicitly a demo. A signed payload from
 * such a provider proves only knowledge of a shared secret, so on real money it
 * would be an unverifiable claim that payment (and, worse, settlement) happened.
 * Failing closed here means a stray `PAYMENT_PROVIDER=manual` cannot turn a live
 * stack into one that accepts self-attested "payments".
 */
export function resolvePaymentProvider(): PaymentProvider {
  const provider = selectProvider();
  if (provider.capabilities?.demo && !demoPaymentMode()) {
    throw ApiError.serviceUnavailable(
      `Payment provider '${provider.id}' is a demonstration harness and is refused because this ` +
        'deployment is not in demo payment mode (set DEMO_PAYMENT_MODE=true only for a public demo).',
    );
  }
  return provider;
}

function selectProvider(): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'manual':
      return new ManualPaymentProvider();
    case 'open-checkout':
      return new OpenCheckoutPaymentProvider(
        env.PAYMENT_BASE_URL?.trim() ?? '',
        env.PAYMENT_API_KEY?.trim() ?? '',
      );
    case 'flouci':
      return resolveFlouci();
    case 'clictopay':
      return resolveClicToPay();
    default:
      return new NoopPaymentProvider();
  }
}

/**
 * Describes every known provider and whether it is configured right now, so the
 * checkout UI can offer only the rails that can actually be used and explain the
 * rest. Never exposes credentials — only availability and a human reason.
 */
export function describePaymentProviders(): {
  active: string;
  providers: {
    id: string;
    functional: boolean;
    available: boolean;
    methods: ProviderCapability[];
    settlementEvidence: boolean;
    payout: boolean;
    demo: boolean;
  }[];
} {
  return {
    active: env.PAYMENT_PROVIDER,
    providers: [
      new NoopPaymentProvider(),
      new ManualPaymentProvider(),
      new OpenCheckoutPaymentProvider(env.PAYMENT_BASE_URL?.trim() ?? '', env.PAYMENT_API_KEY?.trim() ?? ''),
      resolveFlouci(),
      resolveClicToPay(),
    ].map(describeProvider),
  };
}

function describeProvider(p: PaymentProvider) {
  return {
    id: p.id,
    functional: p.isFunctional,
    available: p.isFunctional && p.isAvailable(),
    methods: p.supportedMethods(),
    // What this provider can *prove*, so an operator can see why a rail cannot
    // settle funds even though it can take a payment.
    settlementEvidence: p.capabilities?.settlementEvidence ?? false,
    payout: p.capabilities?.payout ?? false,
    demo: p.capabilities?.demo ?? false,
  };
}