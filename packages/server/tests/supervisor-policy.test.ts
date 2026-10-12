import { describe, it, expect } from 'vitest';
import { recommendIntervention, DEFAULT_SUPERVISOR_LIMITS as L } from '../src/modules/ai/supervisor-policy.js';

/**
 * Pure supervisor policy tests — no database. These assert the deterministic
 * containment rules the runner and the supervisor both rely on.
 */

const now = Date.now();
const base = {
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  cost: 0,
  startedAtMs: null as number | null,
  createdAtMs: now,
};

describe('supervisor policy', () => {
  it('leaves a healthy task untouched', () => {
    expect(recommendIntervention(base, L, now).contain).toBe(false);
  });

  it('fails a running task past the stuck ceiling', () => {
    const a = recommendIntervention(
      { ...base, status: 'running', startedAtMs: now - (L.stuckRuntimeSeconds + 1) * 1000 },
      L,
      now,
    );
    expect(a.contain).toBe(true);
    expect(a.status).toBe('failed');
    expect(a.action).toBe('fail-stuck-task');
  });

  it('fails a queued task past the stale ceiling', () => {
    const a = recommendIntervention(
      { ...base, status: 'queued', createdAtMs: now - (L.staleQueueSeconds + 1) * 1000 },
      L,
      now,
    );
    expect(a.contain).toBe(true);
    expect(a.action).toBe('fail-stale-task');
  });

  it('halts a retry loop at the attempt ceiling', () => {
    const a = recommendIntervention({ ...base, attempts: L.maxAttempts }, L, now);
    expect(a.contain).toBe(true);
    expect(a.action).toBe('halt-loop');
    expect(a.severity).toBe('CRITICAL');
  });

  it('blocks a task over the per-run budget', () => {
    const a = recommendIntervention({ ...base, cost: L.maxRunCostUsd + 0.01 }, L, now);
    expect(a.contain).toBe(true);
    expect(a.status).toBe('blocked');
    expect(a.action).toBe('block-budget');
  });

  it('is deterministic: same facts, same verdict', () => {
    const facts = { ...base, attempts: L.maxAttempts };
    expect(recommendIntervention(facts, L, now)).toEqual(recommendIntervention(facts, L, now));
  });
});
