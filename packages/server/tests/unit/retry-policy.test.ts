import { describe, it, expect } from 'vitest';
import { decideRetry, type RetryFacts } from '../../src/modules/ai/retry-policy.js';
import { DEFAULT_SUPERVISOR_LIMITS, type SupervisorLimits } from '../../src/modules/ai/supervisor-policy.js';

/**
 * Retry policy — pure, database-free.
 *
 * `retry-policy.ts` decides whether ONE failed step may be retried. It never
 * touches the DB, the clock or the provider, so the guardrails are reproducible.
 * `supervisor.ts` feeds it live facts; this file pins the fail-closed ordering
 * and the attempt ceiling so a change cannot silently open an unbounded loop.
 */

const LIMITS: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS; // maxAttempts = 3

function facts(partial: Partial<RetryFacts>): RetryFacts {
  return {
    stepStatus: 'FAILED',
    attemptCount: 1,
    maxAttempts: 1,
    runStatus: 'RUNNING',
    runCancelled: false,
    budgetExhausted: false,
    depsSucceeded: true,
    ...partial,
  };
}

describe('retry policy — eligible retry', () => {
  it('retries a failed step with attempts left and met dependencies', () => {
    const out = decideRetry(facts({}), LIMITS);
    expect(out.retry).toBe(true);
    expect(out.code).toBe('RETRY');
    expect(out.nextAttempt).toBe(2);
    // The ceiling is raised to the policy maximum so attemptCount+1 is allowed.
    expect(out.nextMaxAttempts).toBe(LIMITS.maxAttempts);
  });

  it('retries a step already scheduled (RETRYING)', () => {
    const out = decideRetry(facts({ stepStatus: 'RETRYING' }), LIMITS);
    expect(out.retry).toBe(true);
  });
});

describe('retry policy — fail-closed refusals', () => {
  it('refuses a non-failed step', () => {
    expect(decideRetry(facts({ stepStatus: 'SUCCEEDED' }), LIMITS).code).toBe('NOT_FAILED');
    expect(decideRetry(facts({ stepStatus: 'RUNNING' }), LIMITS).code).toBe('NOT_FAILED');
    expect(decideRetry(facts({ stepStatus: 'CANCELLED' }), LIMITS).code).toBe('NOT_FAILED');
    expect(decideRetry(facts({ stepStatus: 'SKIPPED' }), LIMITS).code).toBe('NOT_FAILED');
  });

  it('refuses when the run is cancelled', () => {
    expect(decideRetry(facts({ runCancelled: true, runStatus: 'CANCELLED' }), LIMITS).code).toBe('RUN_CANCELLED');
  });

  it('refuses when the run is terminal', () => {
    for (const runStatus of ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']) {
      expect(decideRetry(facts({ runStatus }), LIMITS).retry).toBe(false);
    }
  });

  it('refuses when the budget is exhausted', () => {
    expect(decideRetry(facts({ budgetExhausted: true }), LIMITS).code).toBe('BUDGET_EXHAUSTED');
  });

  it('refuses when a dependency has not succeeded (SKIPPED is not success)', () => {
    expect(decideRetry(facts({ depsSucceeded: false }), LIMITS).code).toBe('DEPS_UNMET');
  });

  it('refuses once the attempt ceiling is reached', () => {
    expect(decideRetry(facts({ attemptCount: LIMITS.maxAttempts }), LIMITS).code).toBe('ATTEMPTS_EXHAUSTED');
    expect(decideRetry(facts({ attemptCount: LIMITS.maxAttempts + 5 }), LIMITS).code).toBe('ATTEMPTS_EXHAUSTED');
  });
});

describe('retry policy — ordering and defaults', () => {
  it('prefers the most fundamental refusal first (cancelled beats budget)', () => {
    const out = decideRetry(facts({ runCancelled: true, runStatus: 'CANCELLED', budgetExhausted: true }), LIMITS);
    expect(out.code).toBe('RUN_CANCELLED');
  });

  it('the default policy allows a bounded number of retries (>1)', () => {
    expect(DEFAULT_SUPERVISOR_LIMITS.maxAttempts).toBeGreaterThan(1);
  });
});
