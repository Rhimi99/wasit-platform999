import type { ReconciliationDecision } from './engine';

/**
 * PS-04 — Reconciliation provenance.
 *
 * A `MATCHED` decision is only trustworthy if it can be walked back, through
 * real database rows, to the operation it describes:
 *
 *   provider/bank reference → transaction → ledger entry → audit log
 *
 * This resolver does that walk using ids that already exist in the database.
 * It never invents or guesses an id: if a reference does not resolve to exactly
 * one transaction, one SETTLEMENT ledger entry, and one settlement audit record,
 * the decision is left WITHOUT provenance. Reconciliation is evidence-gathering,
 * so an ambiguous reference is a dead end, not a licence to pick a likely row.
 *
 * The resolver is pure: the service fetches the candidate rows (real ids) and
 * passes them in, so the linkage rules are provable without a database.
 */

/** A SETTLEMENT ledger entry, reduced to what provenance needs. */
export interface LedgerEntryRow {
  id: string;
  transactionId: string;
  entryType: string;
  status: string;
  currencyCode: string;
  /** `metadata.settlementRef` — the acquirer transfer reference. */
  settlementRef: string | null;
  /** `metadata.providerRef` — the provider-side movement reference. */
  providerRef: string | null;
}

export interface TransactionRow {
  id: string;
  orderId: string | null;
}

export interface IntentRow {
  externalRef: string | null;
  orderId: string | null;
  transactionId: string | null;
}

export interface OrderRow {
  id: string;
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
}

export interface ProvenanceContext {
  intents: IntentRow[];
  transactions: TransactionRow[];
  ledgerEntries: LedgerEntryRow[];
  orders: OrderRow[];
  audits: AuditRow[];
}

export interface ResolvedProvenance {
  transactionId: string;
  ledgerEntryId: string;
  auditLogId: string;
}

const SETTLEMENT_AUDIT_ACTION = 'SETTLEMENT.CONFIRMED';

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The references a decision can be identified by, across its three feeds. */
export function candidateReferences(decision: ReconciliationDecision): string[] {
  return unique(
    [
      decision.reference,
      decision.provider?.reference,
      decision.bank?.reference,
      decision.ledger?.reference,
      // The acquirer transfer reference travels on the provider/bank lines and
      // is what the SETTLEMENT ledger entry stores in its metadata.
      decision.provider?.settlementRef,
      decision.bank?.settlementRef,
      decision.provider?.payoutRef,
      decision.bank?.payoutRef,
    ].filter((r): r is string => typeof r === 'string' && r.length > 0),
  );
}

function one<T>(rows: T[]): T | null {
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Resolves the real transaction / ledger entry / audit record for a decision.
 *
 * Returns `null` unless every hop is unambiguous:
 *  - exactly one transaction and one order for the reference;
 *  - exactly one SETTLED `SETTLEMENT` ledger entry for that transaction whose
 *    metadata carries the decision's reference;
 *  - exactly one `SETTLEMENT.CONFIRMED` audit record for that order.
 */
export function resolveDecisionProvenance(
  decision: ReconciliationDecision,
  ctx: ProvenanceContext,
): ResolvedProvenance | null {
  const refs = candidateReferences(decision);
  if (refs.length === 0) return null;

  // reference → intent → transaction. Only intents tied to a real order count.
  const intents = ctx.intents.filter(
    (i) => i.externalRef !== null && refs.includes(i.externalRef) && i.orderId !== null,
  );
  const transactionId = one(unique(intents.map((i) => i.transactionId)));
  if (transactionId === null) return null;

  const transaction = one(ctx.transactions.filter((t) => t.id === transactionId && t.orderId !== null));
  if (transaction === null || transaction.orderId === null) return null;

  // transaction → the exact SETTLEMENT entry this reference moved.
  const entry = one(
    ctx.ledgerEntries.filter(
      (e) =>
        e.transactionId === transactionId &&
        e.entryType === 'SETTLEMENT' &&
        e.status === 'SETTLED' &&
        ((e.settlementRef !== null && refs.includes(e.settlementRef)) ||
          (e.providerRef !== null && refs.includes(e.providerRef))),
    ),
  );
  if (entry === null) return null;

  // order → the audit record that proves the settlement transition.
  const audit = one(
    ctx.audits.filter(
      (a) => a.action === SETTLEMENT_AUDIT_ACTION && a.entityType === 'ORDER' && a.entityId === transaction.orderId,
    ),
  );
  if (audit === null) return null;

  return { transactionId, ledgerEntryId: entry.id, auditLogId: audit.id };
}

/**
 * Full provenance pass over a report's decisions. MISMATCH decisions are never
 * given a linkage — a mismatch has nothing proven to link to.
 */
export function resolveReportProvenance(
  decisions: ReconciliationDecision[],
  ctx: ProvenanceContext,
): Map<string, ResolvedProvenance> {
  const resolved = new Map<string, ResolvedProvenance>();
  for (const decision of decisions) {
    if (decision.status !== 'MATCHED') continue;
    const linkage = resolveDecisionProvenance(decision, ctx);
    if (linkage) resolved.set(decision.reference, linkage);
  }
  return resolved;
}
