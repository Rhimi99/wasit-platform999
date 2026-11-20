import { describe, it, expect } from 'vitest';
import { db } from '../src/db/client.js';
import { env } from '../src/lib/env.js';
import { completeManualPayment, manualCompletionAvailability } from '../src/modules/payments/service.js';

/**
 * PS-02 — guards that must hold *before* any database work.
 *
 * These are the fail-closed checks that protect a live deployment: the demo-mode
 * gate and the mandatory-reference check both run before the service reads the
 * order, so they can be asserted without a live database.
 */

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

const base = { orderId: 'order-does-not-matter', paymentReference: 'ref', actorId: 'actor' };

describe('PS-02 — manual completion fail-closed guards (no database access)', () => {
  it('refuses with 503 outside demo payment mode, before touching the database', async () => {
    await withEnv({ DEMO_PAYMENT_MODE: false }, async () => {
      await expect(completeManualPayment(db, base)).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  it('refuses in production even when the flag is set (demoPaymentMode excludes production)', async () => {
    await withEnv({ DEMO_PAYMENT_MODE: true, NODE_ENV: 'production' }, async () => {
      await expect(completeManualPayment(db, base)).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  it('requires a non-blank payment reference before any database access', async () => {
    await withEnv({ DEMO_PAYMENT_MODE: true }, async () => {
      await expect(
        completeManualPayment(db, { ...base, paymentReference: '   ' }),
      ).rejects.toMatchObject({ statusCode: 422 });
    });
  });

  it('reports availability from the demo flag and the offline provider id', async () => {
    await withEnv({ DEMO_PAYMENT_MODE: true }, async () => {
      expect(manualCompletionAvailability()).toEqual({ demoMode: true, provider: 'manual' });
    });
    await withEnv({ DEMO_PAYMENT_MODE: false }, async () => {
      expect(manualCompletionAvailability()).toEqual({ demoMode: false, provider: 'manual' });
    });
  });
});
