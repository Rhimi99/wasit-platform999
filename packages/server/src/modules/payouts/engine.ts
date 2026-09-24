import { ApiError } from '@wasit/shared';
import { roundMoney, toDecimal } from '../../lib/money';

/**
 * PS-02 — Seller Payout Engine (provider-agnostic).
 *
 * Payout is an INDEPENDENT lifecycle. It is never inferred from, and never
 * aliased to, payment or settlement status:
 *   - `Payment = PAID`      → the buyer's money reached the provider.
 *   - `Ledger = SETTLED`    → funds moved at provider/bank level.
 *   - `Payout = COMPLETED`  → the SELLER's net amount was actually transferred,
 *                             proven by a provider transfer reference.
 * Settlement alone never completes a payout, and `CREATED` never means
 * `COMPLETED`.
 *
 * The engine is deliberately pure so the state machine can be proven without a
 * database, and so different provider adapters can drive it without hardcoding
 * any single vendor: providers announce the `payout` capability and supply
 * evidence through the same event shape.
 */

export type PayoutStatus = 'CREATED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'HELD';

export interface PayoutRecord {
  id: string;
  orderId: string;
  transactionId: string;
  sellerId: string;
  /** Net amount payable to the seller (items total minus seller commission). */
  amount: string;
  currencyCode: string;
  providerId: string;
  status: PayoutStatus;
  /** Provider transfer reference; set only when the transfer is proven. */
  payoutRef: string | null;
  providerRef: string | null;
  failureReason: string | null;
}

/** Events a provider/bank can assert about a payout. */
export type PayoutEvent =
  | { type: 'payout.processing'; providerRef?: string | null }
  | {
      type: 'payout.completed';
      payoutRef: string;
      amount: string;
      currencyCode: string;
      providerRef?: string | null;
      occurredAt?: string | null;
    }
  | { type: 'payout.failed'; reason: string }
  | { type: 'payout.held'; reason: string };

export interface PayoutTransition {
  record: PayoutRecord;
  applied: boolean;
  duplicate: boolean;
}

/**
 * Allowed state transitions. `COMPLETED` and `FAILED` are terminal: a retry is a
 * new payout record, never a resurrection of a finished one.
 */
const ALLOWED: Record<PayoutStatus, PayoutStatus[]> = {
  CREATED: ['PROCESSING', 'FAILED', 'HELD'],
  PROCESSING: ['COMPLETED', 'FAILED', 'HELD'],
  HELD: ['PROCESSING', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

/**
 * Net amount payable to the seller for an order: the items total minus the
 * seller-side commission. `order.commission` already holds the TOTAL Wasit
 * commission, so the seller share is `commission - buyerCommission` — the two
 * columns must never be summed.
 */
export function computeSellerPayable(order: {
  itemsTotal: string;
  commission: string;
  buyerCommission: string;
}): string {
  const sellerCommission = toDecimal(order.commission).minus(toDecimal(order.buyerCommission));
  const payable = toDecimal(order.itemsTotal).minus(sellerCommission);
  return roundMoney(payable).toFixed(4);
}

/** A payout may only be announced by a provider that declares the capability. */
export function assertPayoutCapable(providerId: string, capabilities?: { payout?: boolean }): void {
  if (!capabilities?.payout) {
    throw ApiError.validation([
      {
        field: 'provider',
        message: `Provider '${providerId}' cannot execute a seller payout: it exposes no payout capability`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
}

/**
 * Applies a payout event to a record and returns the next state. Pure and
 * idempotent: replaying an already-applied completion (same `payoutRef`) is a
 * no-op rather than a second effect or an error.
 */
export function applyPayoutEvent(record: PayoutRecord, event: PayoutEvent): PayoutTransition {
  if (record.status === 'COMPLETED') {
    if (event.type === 'payout.completed' && event.payoutRef.trim() === record.payoutRef) {
      return { record, applied: false, duplicate: true };
    }
    throw ApiError.conflict('Payout is already completed');
  }

  switch (event.type) {
    case 'payout.processing':
      assertTransition(record.status, 'PROCESSING');
      return {
        record: { ...record, status: 'PROCESSING', providerRef: event.providerRef ?? record.providerRef },
        applied: true,
        duplicate: false,
      };

    case 'payout.held':
      assertTransition(record.status, 'HELD');
      return {
        record: { ...record, status: 'HELD', failureReason: event.reason },
        applied: true,
        duplicate: false,
      };

    case 'payout.failed':
      assertTransition(record.status, 'FAILED');
      return {
        record: { ...record, status: 'FAILED', failureReason: event.reason },
        applied: true,
        duplicate: false,
      };

    case 'payout.completed': {
      // Completion is the strongest claim: it requires a transfer reference and
      // an exact match of amount and currency against what we owe the seller.
      const payoutRef = event.payoutRef?.trim();
      if (!payoutRef) {
        throw ApiError.validation([
          {
            field: 'payoutRef',
            message: 'Payout completion evidence must carry a transfer reference',
            code: 'VALIDATION_FAILED',
          },
        ]);
      }
      if (!toDecimal(event.amount).equals(toDecimal(record.amount))) {
        throw ApiError.conflict('Payout amount does not match the payable amount');
      }
      if (event.currencyCode !== record.currencyCode) {
        throw ApiError.conflict('Payout currency does not match the payable currency');
      }
      if (!ALLOWED[record.status].includes('COMPLETED')) {
        throw ApiError.conflict(`Payout cannot move from ${record.status} to COMPLETED`);
      }
      return {
        record: {
          ...record,
          status: 'COMPLETED',
          payoutRef,
          providerRef: event.providerRef ?? record.providerRef,
        },
        applied: true,
        duplicate: false,
      };
    }
  }
}

function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw ApiError.conflict(`Payout cannot move from ${from} to ${to}`);
  }
}
