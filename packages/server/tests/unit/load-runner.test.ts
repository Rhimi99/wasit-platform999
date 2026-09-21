import { describe, it, expect } from 'vitest';
import {
  assertBudget,
  formatResults,
  percentile,
  runLoad,
  summarise,
  type LoadResult,
} from '../../src/lib/perf/load-runner.js';

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe('summarise', () => {
  it('separates ok from failed and computes the error rate', () => {
    const stats = summarise(
      [
        { status: 200, durationMs: 10 },
        { status: 200, durationMs: 20 },
        { status: 500, durationMs: 30 },
        { status: 0, durationMs: 40 },
      ],
      1000,
    );
    expect(stats.count).toBe(4);
    expect(stats.ok).toBe(2);
    expect(stats.failed).toBe(2);
    expect(stats.errorRate).toBeCloseTo(0.5, 5);
    expect(stats.p50Ms).toBe(20);
    expect(stats.maxMs).toBe(40);
    expect(stats.throughputRps).toBeCloseTo(4, 5);
  });
});

describe('runLoad', () => {
  it('runs a fixed number of iterations across the workers', async () => {
    let calls = 0;
    const result = await runLoad({
      name: 'fixed',
      iterations: 20,
      concurrency: 4,
      request: async () => {
        calls += 1;
        return 200;
      },
    });
    expect(calls).toBe(20);
    expect(result.stats.count).toBe(20);
    expect(result.stats.ok).toBe(20);
  });

  it('records a thrown request as status 0 rather than aborting the run', async () => {
    let n = 0;
    const result = await runLoad({
      name: 'errors',
      iterations: 6,
      concurrency: 2,
      request: async () => {
        n += 1;
        if (n % 2 === 0) throw new Error('boom');
        return 200;
      },
    });
    expect(result.stats.count).toBe(6);
    expect(result.stats.ok).toBe(3);
    expect(result.stats.failed).toBe(3);
  });
});

describe('assertBudget', () => {
  const base: LoadResult = {
    name: 'x',
    concurrency: 1,
    durationMs: 100,
    stats: {
      count: 10,
      ok: 10,
      failed: 0,
      errorRate: 0,
      minMs: 1,
      p50Ms: 5,
      p95Ms: 100,
      p99Ms: 120,
      maxMs: 130,
      meanMs: 20,
      throughputRps: 100,
    },
  };

  it('passes within budget and names every breach otherwise', () => {
    expect(assertBudget(base, { p95Ms: 150 }).withinBudget).toBe(true);

    const verdict = assertBudget(
      { ...base, stats: { ...base.stats, p95Ms: 300, errorRate: 0.1 } },
      { p95Ms: 150, maxErrorRate: 0.01 },
    );
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.breaches).toHaveLength(2);
    expect(verdict.breaches[0]).toContain('p95');
    expect(verdict.breaches[1]).toContain('error rate');
  });
});

describe('formatResults', () => {
  it('renders one row per scenario with a header', () => {
    const out = formatResults([
      {
        name: 'geo.countries',
        concurrency: 20,
        durationMs: 1000,
        stats: {
          count: 100,
          ok: 100,
          failed: 0,
          errorRate: 0,
          minMs: 1,
          p50Ms: 5,
          p95Ms: 100,
          p99Ms: 120,
          maxMs: 130,
          meanMs: 20,
          throughputRps: 100,
        },
      },
    ]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('p95');
    expect(lines[1]).toContain('geo.countries');
  });
});
