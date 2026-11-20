import type { OrderRefundAttribution, RefundAttributionSeller } from './types';

/**
 * M2.4-T2.4 — pure view helpers for the per-seller refund attribution panel.
 *
 * These only *classify and label* what the server already sent; they never
 * compute or re-derive an accounting amount. Every money value shown comes
 * straight from the API response.
 */

export type RefundOutcome = 'NONE' | 'PARTIAL' | 'FULL';

/**
 * Classifies a seller's refund outcome from the server's own fields:
 *  - no refund rows            → NONE
 *  - `fullyRefunded` is true   → FULL (its attributed COMPLETED refunds reached the cap)
 *  - otherwise                 → PARTIAL
 */
export function sellerRefundOutcome(seller: RefundAttributionSeller): RefundOutcome {
  if (seller.refunds.length === 0) return 'NONE';
  if (seller.fullyRefunded) return 'FULL';
  return 'PARTIAL';
}

/** The i18n key describing a seller's outcome. */
export function refundOutcomeLabelKey(outcome: RefundOutcome): string {
  switch (outcome) {
    case 'FULL':
      return 'admin.refundAttr.seller.fullyRefunded';
    case 'PARTIAL':
      return 'admin.refundAttr.seller.partial';
    default:
      return 'admin.refundAttr.seller.none';
  }
}

/** Badge colour tone for a refund/suborder status. */
export function refundStatusTone(status: string): 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo' {
  switch (status) {
    case 'COMPLETED':
    case 'REFUNDED':
    case 'SETTLED':
      return 'green';
    case 'FAILED':
    case 'REJECTED':
      return 'red';
    case 'REQUESTED':
    case 'PROCESSING':
    case 'APPROVED':
    case 'PENDING':
    case 'HELD':
      return 'amber';
    default:
      return 'slate';
  }
}

/**
 * True when the order carries at least one refund that has NOT completed, so the
 * panel can flag that not every refund on the order is money actually returned.
 */
export function hasUncountedRefund(data: OrderRefundAttribution): boolean {
  return data.refunds.some((r) => r.status !== 'COMPLETED');
}

/** True when a seller has no refund rows at all. */
export function sellerHasNoRefunds(seller: RefundAttributionSeller): boolean {
  return seller.refunds.length === 0;
}
