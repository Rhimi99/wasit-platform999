/**
 * AI-02.S1 — pure retry policy.
 *
 * The decision to retry a failed step is separated from its execution so it is
 * deterministic, has no database or clock, and can be unit-tested exhaustively.
 * `supervisor.ts` gathers live facts and feeds them here; both the guardrail and
 * its tests use exactly this logic.
 *
 * Only a FAILED step (or one already RETRYING, i.e. scheduled) is ever eligible.
 * Every other condition is fail-closed: a terminal run, an exhausted budget,
 * unmet dependencies, or an attempt ceiling all refuse the retry. There is no
 * unbounded loop: the attempt ceiling is the hard stop.
 */

import type { SupervisorLimits } from './supervisor-policy.js';

export interface RetryFacts {
  /** Current step status. Only FAILED or RETRYING may be retried. */
  stepStatus: string;
  /** Attempts already spent on this step. */
  attemptCount: number;
  /** Current per-step ceiling (may have been raised by a previous retry). */
  maxAttempts: number;
  /** Run status; a terminal run can never retry a step. */
  runStatus: string;
  /** True when the run is CANCELLED (kept explicit for a clear reason code). */
  runCancelled: boolean;
  /** True when the requester's AI budget is already exhausted. */
  budgetExhausted: boolean;
  /** True when every dependency of the step has SUCCEEDED (SKIPPED is not success). */
  depsSucceeded: boolean;
}

export interface RetryDecision {
  retry: boolean;
  /** Machine-stable reason code (safe to log/audit). */
  code: string;
  /** Human-readable reason. */
  reason: string;
  /** The attempt number this retry would consume (attemptCount + 1). */
  nextAttempt: number;
  /** The ceiling to persist so `nextAttempt` is allowed (<= limits.maxAttempts). */
  nextMaxAttempts: number;
}

const RETRYABLE_STEP_STATUSES = new Set(['FAILED', 'RETRYING']);

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Decides whether one step may be retried. Order matters: the cheapest, most
 * fundamental refusals are checked first so the reason code is precise.
 */
export function decideRetry(facts: RetryFacts, limits: SupervisorLimits): RetryDecision {
  const nextAttempt = facts.attemptCount + 1;

  const refuse = (code: string, reason: string): RetryDecision => ({
    retry: false,
    code,
    reason,
    nextAttempt,
    nextMaxAttempts: facts.maxAttempts,
  });

  if (!RETRYABLE_STEP_STATUSES.has(facts.stepStatus)) {
    return refuse('NOT_FAILED', `step status ${facts.stepStatus} is not retryable`);
  }
  if (facts.runCancelled) {
    return refuse('RUN_CANCELLED', 'the run is cancelled');
  }
  if (TERMINAL_RUN_STATUSES.has(facts.runStatus)) {
    return refuse('RUN_TERMINAL', `the run is in a terminal status (${facts.runStatus})`);
  }
  if (facts.budgetExhausted) {
    return refuse('BUDGET_EXHAUSTED', 'the AI budget is exhausted');
  }
  if (!facts.depsSucceeded) {
    return refuse('DEPS_UNMET', 'a dependency has not succeeded');
  }
  if (facts.attemptCount >= limits.maxAttempts) {
    return refuse('ATTEMPTS_EXHAUSTED', `attempts ${facts.attemptCount} reached ceiling ${limits.maxAttempts}`);
  }

  // Allowed. The ceiling is raised to the policy maximum so `attemptCount + 1`
  // is representable within the existing CHECK (attemptCount <= maxAttempts);
  // no schema change is involved.
  return {
    retry: true,
    code: 'RETRY',
    reason: `retry ${nextAttempt}/${limits.maxAttempts}`,
    nextAttempt,
    nextMaxAttempts: limits.maxAttempts,
  };
}
