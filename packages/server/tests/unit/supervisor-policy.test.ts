import { describe, it, expect } from 'vitest';
import {
  recommendIntervention,
  DEFAULT_SUPERVISOR_LIMITS,
  type SupervisorLimits,
  type TaskFacts,
} from '../../src/modules/ai/supervisor-policy.js';

/**
 * Supervisor policy — pure, database-free.
 *
 * `supervisor-policy.ts` is a deterministic decision over one task's facts: it
 * never touches the DB, the clock or the provider, so containment decisions are
 * reproducible. `supervisor.ts` (a later stage) feeds it live rows; this file
 * pins the ordering and the fail-safe defaults so a guardrail change cannot
 * silently weaken containment.
 */

const LIMITS: SupervisorLimits = DEFAULT_SUPERVISOR_LIMITS;
const NOW = 1_000_000_000_000; // fixed clock in ms

function facts(partial: Partial<TaskFacts>): TaskFacts {
  return {
    status: 'queued',
    attempts: 0,
    maxAttempts: 3,
    cost: 0,
    startedAtMs: null,
    createdAtMs: NOW,
    ...partial,
  };
}

describe('supervisor policy — healthy tasks', () => {
  it('does not contain a fresh queued task', () => {
    const out = recommendIntervention(facts({}), LIMITS, NOW);
    expect(out.contain).toBe(false);
    expect(out.action).toBe('none');
  });

  it('does not contain a running task within the stuck ceiling', () => {
    const out = recommendIntervention(
      facts({ status: 'running', startedAtMs: NOW - 10_000 }),
      LIMITS,
      NOW,
    );
    expect(out.contain).toBe(false);
  });
});

describe('supervisor policy — containment decisions', () => {
  it('fails a running task that outlived the stuck ceiling (CRITICAL)', () => {
    const out = recommendIntervention(
      facts({ status: 'running', startedAtMs: NOW - (LIMITS.stuckRuntimeSeconds * 1000 + 1) }),
      LIMITS,
      NOW,
    );
    expect(out.contain).toBe(true);
    expect(out.action).toBe('fail-stuck-task');
    expect(out.status).toBe('failed');
    expect(out.severity).toBe('CRITICAL');
  });

  it('fails a queued task that waited past the stale ceiling (WARNING)', () => {
    const out = recommendIntervention(
      facts({ status: 'queued', createdAtMs: NOW - (LIMITS.staleQueueSeconds * 1000 + 1) }),
      LIMITS,
      NOW,
    );
    expect(out.contain).toBe(true);
    expect(out.action).toBe('fail-stale-task');
    expect(out.status).toBe('failed');
    expect(out.severity).toBe('WARNING');
  });

  it('halts a retry loop at the effective attempt ceiling (CRITICAL)', () => {
    const out = recommendIntervention(facts({ attempts: 3, maxAttempts: 3 }), LIMITS, NOW);
    expect(out.contain).toBe(true);
    expect(out.action).toBe('halt-loop');
    expect(out.severity).toBe('CRITICAL');
  });

  it('never lets a task raise its own ceiling above the policy maximum', () => {
    // maxAttempts=99 must be clamped to limits.maxAttempts (3).
    const out = recommendIntervention(facts({ attempts: 3, maxAttempts: 99 }), LIMITS, NOW);
    expect(out.action).toBe('halt-loop');
  });

  it('blocks a run that exceeded the cost ceiling (CRITICAL)', () => {
    const out = recommendIntervention(facts({ cost: LIMITS.maxRunCostUsd + 1 }), LIMITS, NOW);
    expect(out.contain).toBe(true);
    expect(out.action).toBe('block-budget');
    expect(out.status).toBe('blocked');
    expect(out.severity).toBe('CRITICAL');
  });

  it('does not block a run exactly at the cost ceiling', () => {
    const out = recommendIntervention(facts({ cost: LIMITS.maxRunCostUsd }), LIMITS, NOW);
    expect(out.contain).toBe(false);
  });
});

describe('supervisor policy — ordering and determinism', () => {
  it('reports the most severe condition first (stuck beats loop)', () => {
    const out = recommendIntervention(
      facts({
        status: 'running',
        startedAtMs: NOW - (LIMITS.stuckRuntimeSeconds * 1000 + 1),
        attempts: 99,
      }),
      LIMITS,
      NOW,
    );
    expect(out.action).toBe('fail-stuck-task');
  });

  it('is deterministic for identical facts', () => {
    const f = facts({ status: 'running', startedAtMs: NOW - 5000 });
    expect(recommendIntervention(f, LIMITS, NOW)).toEqual(recommendIntervention(f, LIMITS, NOW));
  });

  it('ships conservative, finite defaults', () => {
    expect(DEFAULT_SUPERVISOR_LIMITS.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_SUPERVISOR_LIMITS.stuckRuntimeSeconds).toBeGreaterThan(0);
    expect(DEFAULT_SUPERVISOR_LIMITS.maxRunCostUsd).toBeGreaterThan(0);
    expect(DEFAULT_SUPERVISOR_LIMITS.failureRateThreshold).toBeLessThanOrEqual(1);
  });
});
