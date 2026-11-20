import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../packages/server/src/db/schema/index.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * E2E refund-evidence harness (test-only).
 *
 * The platform rule (LC-04) is that a refund is a *request* first and a fact
 * only on trusted external evidence. The offline `manual` provider used by the
 * E2E stack can never prove money moved, so a refund created through the API or
 * the admin UI legitimately stays `REQUESTED` and no money moves.
 *
 * To exercise the *completion* half of the real lifecycle, the suite plays the
 * part of a configured acquirer reporting the reversal, and hands that evidence
 * to the **real** `completeRefundWithEvidence` — the single production writer of
 * a completed refund, the `REFUND` ledger entry, the commission/fee reversal and
 * the order's refund state. Nothing in that path is mocked or re-implemented
 * here: only the external proof source is simulated, exactly as the server-side
 * refund specs do. The provider named in the evidence (`open-checkout`) is a
 * real, non-demo acquirer, which is what `canProveRefund` requires.
 *
 * It opens its own short-lived connection so it never shares (or closes) the
 * E2E server's pool, and it targets the same database the suite runs against.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev';

/** The acquirer reference the simulated report carries for a refund. */
export function acquirerRefFor(refundId: string): string {
  return `e2e-acquirer-${refundId}`;
}

/**
 * Completes `refundId` through the real service, on simulated acquirer evidence
 * that matches the refund's own amount and currency.
 */
export async function completeRefundViaEvidence(
  refundId: string,
  refund: { amount: string; currencyCode: string },
): Promise<{ completed: boolean; reused: boolean; refundId: string }> {
  const { completeRefundWithEvidence } = await import('../packages/server/src/modules/payments/service.js');
  const pool = new pg.Pool({ connectionString: CONNECTION_STRING });
  const db = drizzle(pool, { schema });
  try {
    return await completeRefundWithEvidence(
      db as never,
      refundId,
      {
        source: 'PROVIDER_WEBHOOK',
        providerId: 'open-checkout',
        externalRef: acquirerRefFor(refundId),
        amount: refund.amount,
        currencyCode: refund.currencyCode,
      },
      { actorId: null },
    );
  } finally {
    await pool.end();
  }
}

/** The most recent refund row for an order, read through the live API. */
export async function latestRefundForOrder(
  request: APIRequestContext,
  orderId: string,
): Promise<{ id: string; amount: string; currencyCode: string; status: string }> {
  const res = await request.get(`/api/payments/orders/${orderId}/refunds`);
  if (!res.ok()) throw new Error(`reading refunds for ${orderId} failed (${res.status()})`);
  const body = (await res.json()) as { data: Array<{ id: string; amount: string; currencyCode: string; status: string }> };
  const rows = body.data ?? [];
  if (rows.length === 0) throw new Error(`order ${orderId} has no refund to complete`);
  return rows[rows.length - 1];
}
