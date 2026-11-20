/**
 * Dispute deadline policy — pure, database-free.
 *
 * Every window a dispute runs on is a policy value (days), never a constant in
 * the code. This module turns the stored rules into concrete instants and
 * answers the two questions the service needs: "is this action still inside its
 * window?" and "which operational deadlines have passed?". Keeping it pure makes
 * the boundaries testable without a database and keeps the service from
 * inventing a legal duration of its own.
 *
 * The durations themselves are the platform's operational windows. The *legal*
 * wording of a refund/dispute policy is a separate, human-owned artefact (see
 * the public policy surface) and is deliberately not encoded here.
 */

/** The numeric windows a dispute policy may declare. All are whole days. */
export interface DisputeDeadlineRules {
  /** How long after the order a dispute may still be opened. */
  openWindowDays: number | null;
  /** How long the respondent has to answer once a dispute is open. */
  responseWindowDays: number | null;
  /** How long parties have to submit evidence. */
  evidenceDeadlineDays: number | null;
  /** Staff target for reaching a decision. */
  decisionDeadlineDays: number | null;
  /** How long an untouched dispute may sit before it should be escalated. */
  autoEscalateDays: number | null;
  /** How long after a decision an appeal may be filed. */
  appealWindowDays: number | null;
  /** Maximum number of appeals per dispute. */
  maxAppeals: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A positive whole number of days, or null when the rule is absent/invalid. */
function positiveDays(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Reads the deadline rules out of a raw policy `rules` object. Missing or
 * malformed values become `null` (no window), never a silent default — an
 * unconfigured window must not behave like an arbitrary one.
 */
export function parseDeadlineRules(rules: Record<string, unknown> | null | undefined): DisputeDeadlineRules {
  const r = rules ?? {};
  return {
    openWindowDays: positiveDays(r.openWindowDays),
    responseWindowDays: positiveDays(r.responseWindowDays),
    evidenceDeadlineDays: positiveDays(r.evidenceDeadlineDays),
    decisionDeadlineDays: positiveDays(r.decisionDeadlineDays),
    autoEscalateDays: positiveDays(r.autoEscalateDays),
    appealWindowDays: positiveDays(r.appealWindowDays),
    maxAppeals: positiveDays(r.maxAppeals),
  };
}

function addDays(from: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(from.getTime() + days * DAY_MS);
}

/** The concrete instants a dispute runs against, or null when a window is unset. */
export interface DisputeDeadlines {
  openWindowClosesAt: Date | null;
  responseDeadline: Date | null;
  evidenceDeadline: Date | null;
  decisionDeadline: Date | null;
  autoEscalateAt: Date | null;
}

/** Deadlines anchored on the dispute's own creation, plus the order's open window. */
export function computeDisputeDeadlines(
  input: { disputeCreatedAt: Date; orderCreatedAt: Date },
  rules: DisputeDeadlineRules,
): DisputeDeadlines {
  return {
    openWindowClosesAt: addDays(input.orderCreatedAt, rules.openWindowDays),
    responseDeadline: addDays(input.disputeCreatedAt, rules.responseWindowDays),
    evidenceDeadline: addDays(input.disputeCreatedAt, rules.evidenceDeadlineDays),
    decisionDeadline: addDays(input.disputeCreatedAt, rules.decisionDeadlineDays),
    autoEscalateAt: addDays(input.disputeCreatedAt, rules.autoEscalateDays),
  };
}

/** The instant an appeal window closes, measured from the decision. */
export function appealDeadline(decidedAt: Date, rules: DisputeDeadlineRules): Date | null {
  return addDays(decidedAt, rules.appealWindowDays);
}

/** The instant the window to open a dispute closes, measured from the order. */
export function computeOpenWindowClosesAt(orderCreatedAt: Date, rules: DisputeDeadlineRules): Date | null {
  return addDays(orderCreatedAt, rules.openWindowDays);
}

/** Whether `now` is at or before a deadline. A null deadline is open-ended. */
export function isWithinWindow(now: Date, deadline: Date | null): boolean {
  if (deadline == null) return true;
  return now.getTime() <= deadline.getTime();
}

/** Whether a deadline exists and `now` is past it. */
export function isOverdue(now: Date, deadline: Date | null): boolean {
  if (deadline == null) return false;
  return now.getTime() > deadline.getTime();
}

/** The remaining whole days until a deadline, or null when unset. Never negative. */
export function daysRemaining(now: Date, deadline: Date | null): number | null {
  if (deadline == null) return null;
  const diff = deadline.getTime() - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / DAY_MS);
}

/** The operational state of a dispute's deadlines at a moment in time. */
export interface DisputeDeadlineStatus {
  deadlines: DisputeDeadlines;
  /** The response window (respondent's turn) is still open. */
  responseOpen: boolean;
  /** Evidence may still be submitted. */
  evidenceOpen: boolean;
  /** Staff are past their decision target (informational, never a hard block). */
  decisionOverdue: boolean;
  /** The dispute has sat untouched past `autoEscalateDays` and should be escalated. */
  needsEscalation: boolean;
  daysToEvidence: number | null;
  daysToDecision: number | null;
}

/**
 * Evaluates every deadline for a dispute. `decided` suppresses the escalation
 * flag: a dispute that already has an outcome is not "untouched".
 */
export function evaluateDeadlines(
  input: { disputeCreatedAt: Date; orderCreatedAt: Date; decided: boolean; now?: Date },
  rules: DisputeDeadlineRules,
): DisputeDeadlineStatus {
  const now = input.now ?? new Date();
  const deadlines = computeDisputeDeadlines(input, rules);
  return {
    deadlines,
    responseOpen: isWithinWindow(now, deadlines.responseDeadline),
    evidenceOpen: isWithinWindow(now, deadlines.evidenceDeadline),
    decisionOverdue: isOverdue(now, deadlines.decisionDeadline),
    needsEscalation: !input.decided && isOverdue(now, deadlines.autoEscalateAt),
    daysToEvidence: daysRemaining(now, deadlines.evidenceDeadline),
    daysToDecision: daysRemaining(now, deadlines.decisionDeadline),
  };
}
