import { ApiError } from '@wasit/shared';

/**
 * B2B-01 — the RFQ state machines, written once and enforced everywhere.
 *
 * Three lifecycles run side by side and must not be conflated:
 *
 *   RFQ        DRAFT ─▶ OPEN ─▶ {CANCELLED | EXPIRED | AWARDED}
 *              AWARDED ─▶ CLOSED
 *   RECIPIENT  INVITED ─▶ {VIEWED, QUOTED, DECLINED}
 *              VIEWED  ─▶ {QUOTED, DECLINED}
 *              QUOTED  ─▶ {QUOTED (new revision), WITHDRAWN}
 *              WITHDRAWN ─▶ QUOTED (the seller may re-enter)
 *   QUOTE      SUBMITTED ─▶ {SUPERSEDED, WITHDRAWN, REJECTED, ACCEPTED, EXPIRED}
 *
 * Every status outside `SUBMITTED` on a quote is terminal. That is what makes
 * "an old revision can never be edited" a property of the model: a superseded
 * revision has nowhere to go, and its rows are frozen by a database trigger
 * (migration 0046) on top of this table.
 *
 * `AWARDED`/`CLOSED` and `ACCEPTED` are declared here because phase 3 will need
 * them, but no code path in this phase can reach them: accepting a quote and
 * converting it into an order is a separate, separately reviewed change.
 */

export type RfqStatus = 'DRAFT' | 'OPEN' | 'AWARDED' | 'CANCELLED' | 'EXPIRED' | 'CLOSED';
export type RecipientStatus = 'INVITED' | 'VIEWED' | 'QUOTED' | 'DECLINED' | 'WITHDRAWN';
export type QuoteStatus = 'SUBMITTED' | 'SUPERSEDED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';

export const RFQ_TRANSITIONS: Readonly<Record<RfqStatus, readonly RfqStatus[]>> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['CANCELLED', 'EXPIRED', 'AWARDED'],
  AWARDED: ['CLOSED'],
  CANCELLED: [],
  EXPIRED: [],
  CLOSED: [],
};

export const RECIPIENT_TRANSITIONS: Readonly<Record<RecipientStatus, readonly RecipientStatus[]>> = {
  INVITED: ['VIEWED', 'QUOTED', 'DECLINED'],
  VIEWED: ['QUOTED', 'DECLINED'],
  QUOTED: ['QUOTED', 'WITHDRAWN'],
  DECLINED: [],
  WITHDRAWN: ['QUOTED'],
};

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  SUBMITTED: ['SUPERSEDED', 'WITHDRAWN', 'REJECTED', 'ACCEPTED', 'EXPIRED'],
  SUPERSEDED: [],
  ACCEPTED: [],
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export function canRfqTransition(from: RfqStatus, to: RfqStatus): boolean {
  return RFQ_TRANSITIONS[from].includes(to);
}

export function canRecipientTransition(from: RecipientStatus, to: RecipientStatus): boolean {
  return RECIPIENT_TRANSITIONS[from].includes(to);
}

export function canQuoteTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return QUOTE_TRANSITIONS[from].includes(to);
}

export function isTerminalQuoteStatus(status: QuoteStatus): boolean {
  return status !== 'SUBMITTED';
}

export function assertRfqTransition(from: RfqStatus, to: RfqStatus): void {
  if (!canRfqTransition(from, to)) {
    throw ApiError.conflict(`An RFQ in ${from} state cannot move to ${to}`);
  }
}

export function assertRecipientTransition(from: RecipientStatus, to: RecipientStatus): void {
  if (!canRecipientTransition(from, to)) {
    throw ApiError.conflict(`An invitation in ${from} state cannot move to ${to}`);
  }
}

export function assertQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canQuoteTransition(from, to)) {
    throw ApiError.conflict(`A quote in ${from} state cannot move to ${to}`);
  }
}

/**
 * Whether a seller may still act on this RFQ. Expiry is a property of the row
 * (the lazy expiry in `service.ts` persists it), so this stays a pure check of
 * the two facts that matter: the status is OPEN and the window has not lapsed.
 */
export function rfqAcceptsQuotes(
  rfq: { status: string; expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (rfq.status !== 'OPEN') return false;
  if (rfq.expiresAt && rfq.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/** A submitted quote whose validity window has lapsed is no longer negotiable. */
export function quoteIsLive(
  quote: { quoteStatus: string; validUntil: Date },
  now: Date = new Date(),
): boolean {
  return quote.quoteStatus === 'SUBMITTED' && quote.validUntil.getTime() > now.getTime();
}
