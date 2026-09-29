import { eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { payouts } from '../../db/schema/payouts';
import { resolvePayoutProvider, resolvePayoutProviderById } from '../../lib/payments/payout-resolve';
import { applyPayoutEventToDb, type PayoutEventInput } from './service';
import type { PayoutEvent, PayoutRecord, PayoutStatus } from './engine';
import type { PayoutProvider, PayoutProviderEvent } from '../../lib/payments/payout-port';
import { writeAudit } from '../../lib/audit';

/**
 * PS-02 bridge — dispatches a payout to an external rail and feeds the rail's
 * events back through the engine.
 *
 * The division of authority is the whole point of this module:
 *
 *   - The ENGINE decides status. `COMPLETED` requires a transfer reference and
 *     an exact amount/currency match, exactly as before.
 *   - The PROVIDER only transports. `createPayout` on the rail produces a
 *     `PROCESSING` payout at most; it can never set `COMPLETED`.
 *
 * So a provider claiming success is not sufficient — it must supply evidence the
 * engine accepts. This keeps the state machine's invariants intact while making
 * the rail swappable.
 */

function toRecord(row: typeof payouts.$inferSelect): PayoutRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    transactionId: row.transactionId,
    sellerId: row.sellerId,
    amount: row.amount,
    currencyCode: row.currencyCode,
    providerId: row.provider,
    status: row.status as PayoutStatus,
    payoutRef: row.payoutRef,
    providerRef: row.providerRef,
    failureReason: row.failureReason,
  };
}

/** Refuses a rail that cannot actually move money (structural/general-purpose only). */
function assertFunctional(provider: PayoutProvider): void {
  if (!provider.isFunctional) {
    throw ApiError.validation([
      {
        field: 'provider',
        message: `Payout provider '${provider.id}' cannot execute a payout: it is not a functional rail`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
  if (!provider.capabilities.createPayout) {
    throw ApiError.validation([
      {
        field: 'provider',
        message: `Payout provider '${provider.id}' exposes no createPayout capability`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
}

/**
 * Dispatches an existing CREATED payout to the configured rail. Idempotent at
 * the rail via `idempotencyKey` (the payout id): replaying the request re-uses
 * the same rail-side payout rather than paying twice.
 *
 * The result is at most PROCESSING. Completion still requires the rail's
 * transfer evidence to arrive and pass the engine.
 */
export async function dispatchPayoutToProvider(
  db: DB,
  input: {
    payoutId: string;
    /** Beneficiary identifier as known to the rail (opaque to WASIT). */
    beneficiaryRef: string;
    actorId?: string | null;
    ipAddress?: string | null;
    provider?: PayoutProvider;
  },
): Promise<{ payout: PayoutRecord; providerRef: string }> {
  const rows = await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Payout');
  const current = toRecord(rows[0]);

  if (current.status === 'COMPLETED') throw ApiError.conflict('Payout is already completed');
  if (current.status === 'FAILED') throw ApiError.conflict('Payout has failed and cannot be re-dispatched');
  if (current.status === 'PROCESSING' && current.providerRef) {
    // Already dispatched — return the existing rail reference rather than
    // creating a second payout on the rail.
    return { payout: current, providerRef: current.providerRef };
  }

  const provider = input.provider ?? resolvePayoutProviderById(current.providerId);
  assertFunctional(provider);
  if (!provider.isAvailable()) {
    throw ApiError.serviceUnavailable(`Payout provider '${provider.id}' is not configured`);
  }

  const created = await provider.createPayout({
    payoutId: current.id,
    orderId: current.orderId,
    amount: current.amount,
    currencyCode: current.currencyCode,
    beneficiaryRef: input.beneficiaryRef,
    idempotencyKey: current.id,
    description: `Seller payout for order ${current.orderId}`,
  });

  if (created.status === 'FAILED') {
    const failed = await applyPayoutEventToDb(db, {
      payoutId: current.id,
      event: { type: 'payout.failed', reason: created.failureReason ?? 'Provider rejected the payout' },
      actorId: input.actorId ?? null,
      ipAddress: input.ipAddress ?? null,
    });
    return { payout: failed, providerRef: created.providerRef };
  }

  // A successful create request is NOT a completed payout: it only moves the
  // payout into PROCESSING with the rail's reference recorded.
  const processing = await applyPayoutEventToDb(db, {
    payoutId: current.id,
    event: { type: 'payout.processing', providerRef: created.providerRef },
    actorId: input.actorId ?? null,
    ipAddress: input.ipAddress ?? null,
  });

  await writeAudit(db, { actorId: input.actorId ?? null, ipAddress: input.ipAddress ?? null }, {
    action: 'PAYOUT.DISPATCHED',
    entityType: 'TRANSACTION',
    entityId: current.transactionId,
    after: {
      payoutId: current.id,
      provider: provider.id,
      providerRef: created.providerRef,
      status: processing.status,
    },
  });

  return { payout: processing, providerRef: created.providerRef };
}

/**
 * Re-checks a payout's status directly with the rail and, when the rail reports
 * completion, feeds the evidence through the engine.
 *
 * This is the *only* way a provider can influence `COMPLETED`, and it still
 * cannot force it: `getPayoutStatus` returns a transfer reference plus amount and
 * currency, and `applyPayoutEvent` rejects the completion if any of them does not
 * match what WASIT owes. A rail that says "completed" with no reference, or with
 * a different amount, is refused.
 */
export async function syncPayoutFromProvider(
  db: DB,
  input: {
    payoutId: string;
    actorId?: string | null;
    ipAddress?: string | null;
    provider?: PayoutProvider;
  },
): Promise<{ payout: PayoutRecord; providerStatus: string }> {
  const rows = await db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Payout');
  const current = toRecord(rows[0]);
  if (!current.providerRef) throw ApiError.conflict('Payout has not been dispatched to a provider yet');

  const provider = input.provider ?? resolvePayoutProviderById(current.providerId);
  assertFunctional(provider);
  if (!provider.capabilities.statusQuery) {
    throw ApiError.validation([
      {
        field: 'provider',
        message: `Payout provider '${provider.id}' exposes no statusQuery capability`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  const status = await provider.getPayoutStatus(current.providerRef);
  if (status.status === 'UNKNOWN' || status.status === 'PROCESSING') {
    return { payout: current, providerStatus: status.status };
  }

  const event = payoutEventFromProviderStatus(status);
  const next = await applyPayoutEventToDb(db, {
    payoutId: current.id,
    event,
    actorId: input.actorId ?? null,
    ipAddress: input.ipAddress ?? null,
  });
  return { payout: next, providerStatus: status.status };
}

/**
 * Converts a rail status into an engine event. A completion is only formed when
 * the rail supplied a transfer reference; without one the rail's claim cannot
 * satisfy the engine and is reported as a conflict instead of being silently
 * downgraded.
 */
export function payoutEventFromProviderStatus(status: {
  status: string;
  payoutRef: string | null;
  amount: string | null;
  currencyCode: string | null;
  providerRef: string;
}): PayoutEvent {
  switch (status.status) {
    case 'COMPLETED': {
      if (!status.payoutRef) {
        throw ApiError.conflict('Provider reports completion without a transfer reference');
      }
      if (status.amount == null || status.currencyCode == null) {
        throw ApiError.conflict('Provider reports completion without amount and currency evidence');
      }
      return {
        type: 'payout.completed',
        payoutRef: status.payoutRef,
        amount: status.amount,
        currencyCode: status.currencyCode,
        providerRef: status.providerRef,
      };
    }
    case 'FAILED':
      return { type: 'payout.failed', reason: 'Provider reported the payout as failed' };
    case 'HELD':
      return { type: 'payout.held', reason: 'Provider reported the payout as held' };
    default:
      return { type: 'payout.processing', providerRef: status.providerRef };
  }
}

/** Ingests a normalized rail event into the engine, keyed by the payout's provider ref. */
export async function ingestPayoutProviderEvent(
  db: DB,
  input: { payoutId: string; event: PayoutProviderEvent; actorId?: string | null; ipAddress?: string | null },
): Promise<PayoutRecord> {
  const event: PayoutEvent = (() => {
    switch (input.event.type) {
      case 'payout.completed': {
        if (!input.event.payoutRef) {
          throw ApiError.validation([
            {
              field: 'payoutRef',
              message: 'Payout completion evidence must carry a transfer reference',
              code: 'VALIDATION_FAILED',
            },
          ]);
        }
        if (input.event.amount == null || input.event.currencyCode == null) {
          throw ApiError.validation([
            {
              field: 'amount',
              message: 'Payout completion evidence must include amount and currencyCode',
              code: 'VALIDATION_FAILED',
            },
          ]);
        }
        return {
          type: 'payout.completed',
          payoutRef: input.event.payoutRef,
          amount: input.event.amount,
          currencyCode: input.event.currencyCode,
          providerRef: input.event.providerRef ?? null,
          occurredAt: input.event.occurredAt ?? null,
        };
      }
      case 'payout.failed':
        return { type: 'payout.failed', reason: input.event.reason ?? 'Provider reported a failure' };
      case 'payout.held':
        return { type: 'payout.held', reason: input.event.reason ?? 'Provider reported a hold' };
      default:
        return { type: 'payout.processing', providerRef: input.event.providerRef ?? null };
    }
  })();

  const eventInput: PayoutEventInput = {
    payoutId: input.payoutId,
    event,
    actorId: input.actorId ?? null,
    ipAddress: input.ipAddress ?? null,
  };
  return applyPayoutEventToDb(db, eventInput);
}

export { resolvePayoutProvider };
