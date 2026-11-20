import { describe, it, expect } from 'vitest';
import { canProveRefund } from '../src/lib/payments/refund-integrity.js';
import {
  ManualPaymentProvider,
  NoopPaymentProvider,
  OpenCheckoutPaymentProvider,
} from '../src/lib/payments/providers.js';
import { SandboxPaymentProvider } from '../src/lib/payments/sandbox-payment.js';

/**
 * LC-04 — refund financial integrity (DB-free).
 *
 * The one rule that decides whether a provider may complete a refund is
 * `canProveRefund`. A refund is only money returned when a *real, configured*
 * acquirer proves the reversal; a demonstration harness, or a provider that is
 * not actually reachable, can never be that proof — however it reports success.
 *
 * These specs exercise the real provider classes, not mocks, so the predicate is
 * checked against the same `capabilities`/`isAvailable` the runtime sees.
 */
describe('LC-04 refund integrity — canProveRefund', () => {
  it('refuses the noop harness (not functional, not available)', () => {
    expect(canProveRefund(new NoopPaymentProvider())).toBe(false);
  });

  it('refuses the manual offline desk even though it reports functional', () => {
    // A signed `manual` payload proves only knowledge of a shared secret.
    const manual = new ManualPaymentProvider();
    expect(manual.isFunctional).toBe(true);
    expect(manual.capabilities.demo).toBe(true);
    expect(canProveRefund(manual)).toBe(false);
  });

  it('refuses the sandbox harness', () => {
    const sandbox = new SandboxPaymentProvider('secret');
    expect(sandbox.isFunctional).toBe(true);
    expect(sandbox.capabilities.demo).toBe(true);
    expect(canProveRefund(sandbox)).toBe(false);
  });

  it('refuses a real acquirer that is not configured (no credentials)', () => {
    const unconfigured = new OpenCheckoutPaymentProvider('', '');
    expect(unconfigured.isFunctional).toBe(true);
    expect(unconfigured.capabilities.demo).toBe(false);
    expect(unconfigured.isAvailable()).toBe(false);
    expect(canProveRefund(unconfigured)).toBe(false);
  });

  it('allows a real, configured acquirer', () => {
    const configured = new OpenCheckoutPaymentProvider('https://acquirer.example', 'sk_test_key');
    expect(configured.isAvailable()).toBe(true);
    expect(canProveRefund(configured)).toBe(true);
  });
});
