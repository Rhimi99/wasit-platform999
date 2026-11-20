import type { PaymentProvider } from './port';

/**
 * Refund financial integrity — the single rule that decides when a refund may be
 * treated as money actually returned.
 *
 * A refund is a request first and a fact only later. Nothing in the platform —
 * not a dispute decision, not an administrator's approval, not a stored refund
 * row — is proof that funds moved. The one thing that counts is *trusted
 * external evidence*: a real acquirer reporting the reversal, correlated to the
 * exact refund by amount, currency and order.
 *
 * This module holds the trust predicate. The completion routine that consumes it
 * lives in the payments service, next to the ledger it writes.
 */

/** Where the proof that a refund happened came from. */
export type RefundEvidenceSource =
  /** The acquirer's own refund API returned success for this reversal. */
  | 'PROVIDER_API'
  /** A signature-verified acquirer webhook reported the refund succeeded. */
  | 'PROVIDER_WEBHOOK';

/** The only evidence sources that can ever stand for a real reversal. */
export const TRUSTED_EVIDENCE_SOURCES: readonly RefundEvidenceSource[] = ['PROVIDER_API', 'PROVIDER_WEBHOOK'];

export interface RefundEvidence {
  source: RefundEvidenceSource;
  /** Provider/acquirer that produced the evidence. */
  providerId: string;
  /** The acquirer's refund/transfer reference — the machine-readable proof. */
  externalRef: string;
  /** Amount the acquirer reports as reversed; must equal the refund's amount. */
  amount: string;
  /** Currency of the reversed amount; must equal the refund's currency. */
  currencyCode: string;
}

/**
 * Whether a provider's "refund succeeded" answer can be trusted as proof that
 * money actually moved. It cannot when the provider is:
 *  - a demonstration/offline harness (`demo`) — its success is a local marker,
 *    never a bank movement (`noop`, `manual`, `sandbox`);
 *  - not functional, or functional but not configured/available (no credentials),
 *    so it was never actually asked to move money.
 *
 * Only a real, configured acquirer that can execute a reversal may complete a
 * refund — and even then the caller must still supply evidence that matches the
 * refund exactly.
 */
export function canProveRefund(provider: PaymentProvider): boolean {
  if (provider.capabilities?.demo) return false;
  return provider.isFunctional && provider.isAvailable();
}

/**
 * Whether an evidence object names a source that can prove a reversal at all.
 * A malformed or invented source is not proof, however it is presented.
 */
export function isTrustedEvidenceSource(source: unknown): source is RefundEvidenceSource {
  return typeof source === 'string' && (TRUSTED_EVIDENCE_SOURCES as readonly string[]).includes(source);
}

/**
 * Whether a provider named *in evidence* is a real acquirer whose report can be
 * proof — i.e. a functional implementation that is not a demonstration harness.
 *
 * This is deliberately weaker than {@link canProveRefund}: it does not require
 * the provider to be *currently configured* (`isAvailable`). Configuration gates
 * whether we may *start* a reversal; it says nothing about whether a report that
 * already exists is trustworthy. A webhook from a real acquirer can arrive in a
 * process where that acquirer's outbound credentials are not wired, and it is
 * still evidence. What can never be evidence is a demo harness's local marker.
 */
export function isTrustedEvidenceProvider(provider: PaymentProvider): boolean {
  return provider.isFunctional && !provider.capabilities?.demo;
}

/**
 * Whether trusted evidence actually proves *this* refund. A reversal of a
 * different amount or currency — or one carrying no provider reference — is not
 * evidence for this refund, however genuine it is on its own. Kept as a pure
 * predicate so the matching rule is testable without a database.
 */
export function evidenceMatchesRefund(
  refund: { amount: string; currencyCode: string },
  evidence: RefundEvidence,
): { ok: true } | { ok: false; reason: string } {
  if (!evidence.externalRef || evidence.externalRef.trim().length === 0) {
    return { ok: false, reason: 'evidence carries no provider reference' };
  }
  // Compare as fixed-scale money strings so '100' and '100.0000' are equal but a
  // different magnitude never is. Trailing-zero-normalised numeric compare.
  if (Number(evidence.amount) !== Number(refund.amount)) {
    return { ok: false, reason: 'evidence amount does not match the refund' };
  }
  if (evidence.currencyCode !== refund.currencyCode) {
    return { ok: false, reason: 'evidence currency does not match the refund' };
  }
  return { ok: true };
}
