import { describe, it, expect } from 'vitest';
import {
  QUOTE_TRANSITIONS,
  RECIPIENT_TRANSITIONS,
  RFQ_TRANSITIONS,
  assertQuoteTransition,
  assertRecipientTransition,
  assertRfqTransition,
  canQuoteTransition,
  canRecipientTransition,
  canRfqTransition,
  isTerminalQuoteStatus,
  quoteIsLive,
  rfqAcceptsQuotes,
  type QuoteStatus,
  type RecipientStatus,
  type RfqStatus,
} from '../src/modules/rfq/lifecycle.js';

/**
 * Pure state-machine tests: no database, no HTTP. They pin the shape of the
 * three lifecycles so a later refactor cannot quietly widen a transition (for
 * example by letting a superseded revision become the live one again).
 */

const RFQ_STATUSES: RfqStatus[] = ['DRAFT', 'OPEN', 'AWARDED', 'CANCELLED', 'EXPIRED', 'CLOSED'];
const RECIPIENT_STATUSES: RecipientStatus[] = ['INVITED', 'VIEWED', 'QUOTED', 'DECLINED', 'WITHDRAWN'];
const QUOTE_STATUSES: QuoteStatus[] = ['SUBMITTED', 'SUPERSEDED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];

describe('B2B-01 phase 2 — state machine (unit)', () => {
  it('declares a transition entry for every status', () => {
    for (const s of RFQ_STATUSES) expect(RFQ_TRANSITIONS[s]).toBeDefined();
    for (const s of RECIPIENT_STATUSES) expect(RECIPIENT_TRANSITIONS[s]).toBeDefined();
    for (const s of QUOTE_STATUSES) expect(QUOTE_TRANSITIONS[s]).toBeDefined();
  });

  it('allows exactly the RFQ transitions the service performs', () => {
    expect(canRfqTransition('DRAFT', 'OPEN')).toBe(true);
    expect(canRfqTransition('DRAFT', 'CANCELLED')).toBe(true);
    expect(canRfqTransition('OPEN', 'CANCELLED')).toBe(true);
    expect(canRfqTransition('OPEN', 'EXPIRED')).toBe(true);
    // Not reachable in this phase: awarding is a separate change.
    expect(canRfqTransition('OPEN', 'AWARDED')).toBe(true);
    expect(canRfqTransition('DRAFT', 'EXPIRED')).toBe(false);
    expect(canRfqTransition('DRAFT', 'AWARDED')).toBe(false);
  });

  it('treats CANCELLED / EXPIRED / CLOSED as terminal for the RFQ', () => {
    for (const s of ['CANCELLED', 'EXPIRED', 'CLOSED'] as RfqStatus[]) {
      for (const to of RFQ_STATUSES) expect(canRfqTransition(s, to), `${s} -> ${to}`).toBe(false);
    }
  });

  it('walks the recipient lifecycle without ever reopening a declined invitation', () => {
    expect(canRecipientTransition('INVITED', 'VIEWED')).toBe(true);
    expect(canRecipientTransition('INVITED', 'QUOTED')).toBe(true);
    expect(canRecipientTransition('VIEWED', 'QUOTED')).toBe(true);
    expect(canRecipientTransition('QUOTED', 'WITHDRAWN')).toBe(true);
    expect(canRecipientTransition('QUOTED', 'QUOTED')).toBe(true); // a new revision
    expect(canRecipientTransition('WITHDRAWN', 'QUOTED')).toBe(true); // re-enters
    expect(canRecipientTransition('DECLINED', 'QUOTED')).toBe(false);
    expect(canRecipientTransition('DECLINED', 'VIEWED')).toBe(false);
  });

  it('makes every non-SUBMITTED quote status terminal', () => {
    for (const s of QUOTE_STATUSES) {
      expect(isTerminalQuoteStatus(s)).toBe(s !== 'SUBMITTED');
      if (s !== 'SUBMITTED') {
        for (const to of QUOTE_STATUSES) {
          expect(canQuoteTransition(s, to), `${s} -> ${to}`).toBe(false);
        }
      }
    }
    expect(canQuoteTransition('SUBMITTED', 'SUPERSEDED')).toBe(true);
    expect(canQuoteTransition('SUBMITTED', 'WITHDRAWN')).toBe(true);
    expect(canQuoteTransition('SUBMITTED', 'REJECTED')).toBe(true);
    expect(canQuoteTransition('SUBMITTED', 'EXPIRED')).toBe(true);
    // Acceptance exists in the table for phase 3 but is unreachable today.
    expect(canQuoteTransition('SUBMITTED', 'ACCEPTED')).toBe(true);
  });

  it('refuses invalid transitions with a 409 that names both states', () => {
    const expect409 = (fn: () => void) => {
      try {
        fn();
        throw new Error('expected a refusal');
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        expect(e.statusCode).toBe(409);
        return e.message ?? '';
      }
    };
    expect(expect409(() => assertRfqTransition('CANCELLED', 'OPEN'))).toContain('CANCELLED');
    expect(expect409(() => assertRecipientTransition('DECLINED', 'QUOTED'))).toContain('DECLINED');
    expect(expect409(() => assertQuoteTransition('SUPERSEDED', 'WITHDRAWN'))).toContain('SUPERSEDED');
    // Valid transitions do not throw.
    expect(() => assertRfqTransition('DRAFT', 'OPEN')).not.toThrow();
  });

  it('accepts quotes only while OPEN and before the window closes (ms boundary)', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    expect(rfqAcceptsQuotes({ status: 'OPEN', expiresAt: null }, now)).toBe(true);
    expect(rfqAcceptsQuotes({ status: 'OPEN', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(rfqAcceptsQuotes({ status: 'OPEN', expiresAt: now }, now)).toBe(false);
    expect(rfqAcceptsQuotes({ status: 'OPEN', expiresAt: new Date(now.getTime() - 1) }, now)).toBe(false);
    for (const status of ['DRAFT', 'CANCELLED', 'EXPIRED', 'AWARDED', 'CLOSED']) {
      expect(rfqAcceptsQuotes({ status, expiresAt: null }, now), status).toBe(false);
    }
  });

  it('keeps a quote live only while SUBMITTED and inside its validity', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    expect(quoteIsLive({ quoteStatus: 'SUBMITTED', validUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(quoteIsLive({ quoteStatus: 'SUBMITTED', validUntil: now }, now)).toBe(false);
    for (const status of ['SUPERSEDED', 'WITHDRAWN', 'REJECTED', 'EXPIRED', 'ACCEPTED']) {
      expect(
        quoteIsLive({ quoteStatus: status, validUntil: new Date(now.getTime() + 1e9) }, now),
        status,
      ).toBe(false);
    }
  });
});
