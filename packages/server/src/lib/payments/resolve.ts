import { env, demoPaymentMode } from '../env';
import { ApiError } from '@wasit/shared';
import type { PaymentProvider, ProviderCapability } from './port';
import {
  ManualPaymentProvider,
  NoopPaymentProvider,
  OpenCheckoutPaymentProvider,
} from './providers';
import { resolveFlouci } from './flouci';
import { SandboxPaymentProvider } from './sandbox-payment';
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
    case 'sandbox':
      return new SandboxPaymentProvider();
    default:
      return new NoopPaymentProvider();
  }
}

/**
 * Resolves a specific provider by its id, for flows that name the rail
 * explicitly (e.g. payout). Mirrors `selectProvider`'s mapping; unknown ids are
 * refused rather than silently falling back, so a payout can never be routed to
 * an unconfigured channel.
 */
export function resolvePaymentProviderById(id: string): PaymentProvider {
  switch (id) {
    case 'manual':
      return new ManualPaymentProvider();
    case 'noop':
      return new NoopPaymentProvider();
    case 'open-checkout':
      return new OpenCheckoutPaymentProvider(
        env.PAYMENT_BASE_URL?.trim() ?? '',
        env.PAYMENT_API_KEY?.trim() ?? '',
      );
    case 'flouci':
      return resolveFlouci();
    case 'clictopay':
      return resolveClicToPay();
    case 'sandbox':
      return new SandboxPaymentProvider();
    default:
      throw ApiError.validation([
        { field: 'provider', message: `Unknown payment provider '${id}'`, code: 'VALIDATION_FAILED' },
      ]);
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
      new SandboxPaymentProvider(),
    ].map(describeProvider),
  };
}

function describeProvider(p: PaymentProvider) {
  // A demo harness is refused by `resolvePaymentProvider` outside demo mode, so
  // describing it as usable would hand the checkout a rail the intent endpoint
  // then rejects with 503. Report it as unavailable and say why, so the UI offers
  // only rails that can actually complete — mirroring the resolver, not diverging
  // from it.
  const refusedAsDemo = (p.capabilities?.demo ?? false) && !demoPaymentMode();
  return {
    id: p.id,
    functional: p.isFunctional,
    available: p.isFunctional && p.isAvailable() && !refusedAsDemo,
    methods: refusedAsDemo
      ? p.supportedMethods().map((m) => ({
          ...m,
          available: false,
          reason: m.reason ?? 'Demonstration harness — refused outside demo payment mode',
        }))
      : p.supportedMethods(),
    // What this provider can *prove*, so an operator can see why a rail cannot
    // settle funds even though it can take a payment.
    settlementEvidence: p.capabilities?.settlementEvidence ?? false,
    payout: p.capabilities?.payout ?? false,
    demo: p.capabilities?.demo ?? false,
  };
}