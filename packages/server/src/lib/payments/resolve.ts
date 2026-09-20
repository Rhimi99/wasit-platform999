import { env } from '../env';
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
 */
export function resolvePaymentProvider(): PaymentProvider {
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
  };
}