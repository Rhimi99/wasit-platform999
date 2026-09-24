import { ApiError } from '@wasit/shared';
import { roundMoney, toDecimal } from '../../lib/money';

/**
 * PS-04 — Reconciliation / Treasury matching (pure engine).
 *
 * Reconciliation is an independent layer. It never infers a result from
 * `Payment = PAID` or `Ledger = SETTLED`: it compares three independent sources
 * and reports agreement or a classified difference.
 *
 *   Provider evidence  ↔  transaction ledger  ↔  bank/acquirer statement
 *
 * A mismatched line is surfaced as a classified exception — it is never
 * silently turned into a success. The engine is pure and deterministic so the
 * matching rules can be proven without persistence; ingestion/storage of feeds
 * and audit persist are layered on top (see the PS-04 design note).
 */

/** One line as reported by the payment provider. */
export interface ProviderFeedLine {
  /** Provider/acquirer reference for the transaction (e.g. intent externalRef). */
  reference: string;
  settlementRef?: string | null;
  payoutRef?: string | null;
  grossAmount: string;
  providerFee: string;
  netAmount: string;
  currencyCode: string;
  occurredAt?: string | null;
}

/** One line as reported by the bank/acquirer statement. */
export interface BankFeedLine {
  reference: string;
  settlementRef?: string | null;
  payoutRef?: string | null;
  amount: string;
  currencyCode: string;
  occurredAt?: string | null;
}

/** The ledger side, reduced to what reconciliation actually compares. */
export interface LedgerFeedLine {
  reference: string;
  /** Sum of value/commission/fee entries, i.e. what the order was worth. */
  grossAmount: string;
  providerFee: string;
  /** Settlement movement recorded in the ledger, if any. */
  netAmount: string;
  currencyCode: string;
  settled: boolean;
}

export type ReconciliationStatus = 'MATCHED' | 'MISMATCH';

export type MismatchKind =
  | 'MISSING_IN_LEDGER'
  | 'MISSING_IN_PROVIDER'
  | 'MISSING_IN_BANK'
  | 'AMOUNT_MISMATCH'
  | 'FEE_MISMATCH'
  | 'NET_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'NOT_SETTLED_IN_LEDGER'
  | 'DUPLICATE_REFERENCE';

export type FeedSource = 'PROVIDER' | 'BANK' | 'LEDGER';

export interface ReconciliationDecision {
  reference: string;
  status: ReconciliationStatus;
  mismatches: MismatchKind[];
  /** Per-source figures kept for the audit trail. */
  provider: ProviderFeedLine | null;
  bank: BankFeedLine | null;
  ledger: LedgerFeedLine | null;
}

export interface ReconciliationReport {
  currencyCode: string;
  decisions: ReconciliationDecision[];
  matched: number;
  mismatched: number;
}

function money(v: string): string {
  return roundMoney(toDecimal(v)).toFixed(4);
}

function indexByReference<T extends { reference: string }>(lines: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const line of lines) {
    if (map.has(line.reference)) {
      throw ApiError.conflict(`Duplicate feed reference '${line.reference}' in source`);
    }
    map.set(line.reference, line);
  }
  return map;
}

/**
 * Reconciles the three feeds for one currency. Idempotent and pure: the same
 * feeds always yield the same decisions, so replaying an import cannot create a
 * second set of effects (persistence only records these decisions once).
 */
export function reconcile(
  currencyCode: string,
  provider: ProviderFeedLine[],
  bank: BankFeedLine[],
  ledger: LedgerFeedLine[],
): ReconciliationReport {
  const providerIdx = indexByReference(provider);
  const bankIdx = indexByReference(bank);
  const ledgerIdx = indexByReference(ledger);

  const references = new Set<string>([...providerIdx.keys(), ...bankIdx.keys(), ...ledgerIdx.keys()]);
  const decisions: ReconciliationDecision[] = [];

  for (const reference of [...references].sort()) {
    const p = providerIdx.get(reference) ?? null;
    const b = bankIdx.get(reference) ?? null;
    const l = ledgerIdx.get(reference) ?? null;
    const mismatches: MismatchKind[] = [];

    if (!l) mismatches.push('MISSING_IN_LEDGER');
    if (!p) mismatches.push('MISSING_IN_PROVIDER');
    if (!b) mismatches.push('MISSING_IN_BANK');

    if (p && l) {
      if (p.currencyCode !== l.currencyCode) mismatches.push('CURRENCY_MISMATCH');
      if (money(p.grossAmount) !== money(l.grossAmount)) mismatches.push('AMOUNT_MISMATCH');
      if (money(p.providerFee) !== money(l.providerFee)) mismatches.push('FEE_MISMATCH');
      if (money(p.netAmount) !== money(l.netAmount)) mismatches.push('NET_MISMATCH');
    }
    if (p && b) {
      if (p.currencyCode !== b.currencyCode) mismatches.push('CURRENCY_MISMATCH');
      if (money(p.netAmount) !== money(b.amount)) mismatches.push('NET_MISMATCH');
    }
    if (b && l && money(b.amount) !== money(l.netAmount)) mismatches.push('NET_MISMATCH');

    // A reference the provider/bank both moved but the ledger never marked
    // settled is a real discrepancy, not a success — surface it.
    if (p && b && l && !l.settled) mismatches.push('NOT_SETTLED_IN_LEDGER');

    const unique = [...new Set(mismatches)];
    decisions.push({
      reference,
      status: unique.length === 0 ? 'MATCHED' : 'MISMATCH',
      mismatches: unique,
      provider: p,
      bank: b,
      ledger: l,
    });
  }

  return {
    currencyCode,
    decisions,
    matched: decisions.filter((d) => d.status === 'MATCHED').length,
    mismatched: decisions.filter((d) => d.status === 'MISMATCH').length,
  };
}
