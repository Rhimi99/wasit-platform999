import { describe, it, expect } from 'vitest';
import {
  computeDisputeDeadlines,
  daysRemaining,
  evaluateDeadlines,
  isOverdue,
  isWithinWindow,
  parseDeadlineRules,
} from '../src/lib/disputes/deadlines.js';

/**
 * LC-04 — dispute deadline arithmetic (pure, DB-free).
 *
 * Every window is a policy value, so the two properties that matter are:
 * an unset window is *open-ended* (never silently shortened), and the boundary
 * is inclusive ("still inside the window" at the exact deadline instant).
 */
const DAY = 24 * 60 * 60 * 1000;
const base = new Date('2026-01-01T00:00:00.000Z');

describe('LC-04 parseDeadlineRules', () => {
  it('turns missing or malformed windows into null, never a silent default', () => {
    const rules = parseDeadlineRules({ openWindowDays: 0, evidenceDeadlineDays: -3, appealWindowDays: 'x' });
    expect(rules.openWindowDays).toBeNull();
    expect(rules.evidenceDeadlineDays).toBeNull();
    expect(rules.appealWindowDays).toBeNull();
  });

  it('floors fractional days to whole days', () => {
    expect(parseDeadlineRules({ openWindowDays: 7.9 }).openWindowDays).toBe(7);
  });

  it('tolerates a null rules object', () => {
    const rules = parseDeadlineRules(null);
    expect(rules.openWindowDays).toBeNull();
    expect(rules.maxAppeals).toBeNull();
  });
});

describe('LC-04 window arithmetic', () => {
  it('anchors the open window on the order and the rest on the dispute', () => {
    const rules = parseDeadlineRules({ openWindowDays: 30, evidenceDeadlineDays: 14, decisionDeadlineDays: 3, autoEscalateDays: 7, responseWindowDays: 2 });
    const d = computeDisputeDeadlines({ disputeCreatedAt: base, orderCreatedAt: new Date(base.getTime() - 5 * DAY) }, rules);
    expect(d.openWindowClosesAt!.getTime()).toBe(base.getTime() - 5 * DAY + 30 * DAY);
    expect(d.evidenceDeadline!.getTime()).toBe(base.getTime() + 14 * DAY);
    expect(d.decisionDeadline!.getTime()).toBe(base.getTime() + 3 * DAY);
    expect(d.autoEscalateAt!.getTime()).toBe(base.getTime() + 7 * DAY);
  });

  it('treats a null deadline as open-ended, not expired', () => {
    expect(isWithinWindow(base, null)).toBe(true);
    expect(isOverdue(base, null)).toBe(false);
  });

  it('is inclusive at the deadline instant and exclusive one millisecond after', () => {
    const deadline = new Date(base.getTime() + DAY);
    expect(isWithinWindow(deadline, deadline)).toBe(true);
    expect(isOverdue(deadline, deadline)).toBe(false);
    expect(isOverdue(new Date(deadline.getTime() + 1), deadline)).toBe(true);
  });

  it('never reports negative days remaining', () => {
    expect(daysRemaining(base, new Date(base.getTime() - 5 * DAY))).toBe(0);
    expect(daysRemaining(base, null)).toBeNull();
    expect(daysRemaining(base, new Date(base.getTime() + 2 * DAY))).toBe(2);
  });
});

describe('LC-04 evaluateDeadlines', () => {
  const rules = parseDeadlineRules({ evidenceDeadlineDays: 14, decisionDeadlineDays: 3, autoEscalateDays: 7 });

  it('flags escalation only while the dispute is undecided', () => {
    const now = new Date(base.getTime() + 10 * DAY);
    const live = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now }, rules);
    expect(live.needsEscalation).toBe(true);
    expect(live.decisionOverdue).toBe(true);

    const decided = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: true, now }, rules);
    expect(decided.needsEscalation).toBe(false);
  });

  it('closes the evidence window once the deadline passes', () => {
    const inside = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now: new Date(base.getTime() + 5 * DAY) }, rules);
    expect(inside.evidenceOpen).toBe(true);
    const outside = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now: new Date(base.getTime() + 20 * DAY) }, rules);
    expect(outside.evidenceOpen).toBe(false);
    expect(outside.daysToEvidence).toBe(0);
  });

  it('keeps the response window open-ended when the policy sets no responseWindowDays', () => {
    const noResponse = parseDeadlineRules({ evidenceDeadlineDays: 14 });
    const status = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now: new Date(base.getTime() + 999 * DAY) }, noResponse);
    expect(status.responseOpen).toBe(true);
  });

  it('flags escalation only past autoEscalateDays, not merely at it', () => {
    const atDeadline = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now: new Date(base.getTime() + 7 * DAY) }, rules);
    expect(atDeadline.needsEscalation).toBe(false);
    const past = evaluateDeadlines({ disputeCreatedAt: base, orderCreatedAt: base, decided: false, now: new Date(base.getTime() + 7 * DAY + 1) }, rules);
    expect(past.needsEscalation).toBe(true);
  });
});
