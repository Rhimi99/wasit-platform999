import { ApiError } from '@wasit/shared';
import { roundMoney, toDecimal } from '../../lib/money';

/**
 * WASIT Receipt — `Funds Received = RECEIVED`.
 *
 * Settlement (`SETTLED`) proves money moved at the provider/bank; it does NOT
 * prove WASIT's own commission landed on WASIT's account. Receipt is a separate,
 * later stage and its transition requires its own evidence: a bank/acquirer
 * statement, an auditable reference, an amount and a currency.
 *
 * This is the semantic guardrail "WASIT Receipt ≠ Settlement": nothing here may
 * ever be derived from settlement or payment state.
 */

export interface ReceiptEvidence {
  /** Statement/acquirer reference for WASIT's incoming funds. */
  reference: string;
  amount: string;
  currencyCode: string;
  /** Source of the proof. */
  source: 'BANK_STATEMENT' | 'ACQUIRER' | 'PROVIDER';
}

export type WasitReceiptStatus = 'PENDING' | 'RECEIVED' | 'REVERSED';

export interface ReceiptDecision {
  status: WasitReceiptStatus;
  reference: string;
  amount: string;
  currencyCode: string;
  source: ReceiptEvidence['source'];
}

function money(v: string): string {
  return roundMoney(toDecimal(v)).toFixed(4);
}

/**
 * Promotes WASIT's receivable to RECEIVED, strictly on evidence. Amount,
 * currency and reference are all mandatory: nothing here is derived from
 * settlement or payment state.
 */
export function applyReceiptEvidence(
  evidence: ReceiptEvidence,
  expected: { amount: string; currencyCode: string },
): ReceiptDecision {
  const reference = evidence.reference?.trim();
  if (!reference) {
    throw ApiError.validation([
      { field: 'reference', message: 'Receipt evidence must carry an auditable reference', code: 'VALIDATION_FAILED' },
    ]);
  }
  if (!evidence.amount || toDecimal(evidence.amount).lte(0)) {
    throw ApiError.validation([
      { field: 'amount', message: 'Receipt evidence must carry a positive amount', code: 'VALIDATION_FAILED' },
    ]);
  }
  if (!evidence.currencyCode) {
    throw ApiError.validation([
      { field: 'currencyCode', message: 'Receipt evidence must carry a currency', code: 'VALIDATION_FAILED' },
    ]);
  }
  if (money(evidence.amount) !== money(expected.amount)) {
    throw ApiError.conflict('Receipt amount does not match WASIT commission receivable');
  }
  if (evidence.currencyCode !== expected.currencyCode) {
    throw ApiError.conflict('Receipt currency does not match WASIT commission receivable');
  }
  return {
    status: 'RECEIVED',
    reference,
    amount: money(evidence.amount),
    currencyCode: evidence.currencyCode,
    source: evidence.source,
  };
}

/**
 * Reverses a previously RECEIVED amount (bank reversal/chargeback). Funds that
 * arrived can un-arrive, so RECEIVED is not treated as an immutable terminal
 * state — it ends at REVERSED, never by deleting the original evidence.
 */
export function reverseReceipt(reason: string): { status: WasitReceiptStatus; reason: string } {
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw ApiError.validation([
      { field: 'reason', message: 'A receipt reversal must carry a reason', code: 'VALIDATION_FAILED' },
    ]);
  }
  return { status: 'REVERSED', reason: trimmed };
}
