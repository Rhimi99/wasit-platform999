/**
 * A tiny closed-loop load driver.
 *
 * Why hand-rolled instead of k6/artillery? The platform ships as one Node
 * process and one database, and the question we actually need answered is
 * "does a hot read hold its latency budget under N concurrent clients, and does
 * the cache change that?" That is a few dozen lines against the global `fetch`
 * the runtime already provides — no new toolchain in CI, no shelling out.
 * The same runner drives the in-process app in tests and a real server from the
 * `load-smoke` script, so a budget breach is reproducible in both.
 */

export interface LoadSample {
  /** HTTP status observed; 0 when the request threw. */
  status: number;
  /** Wall-clock duration of the request, in milliseconds. */
  durationMs: number;
}

export interface LatencyStats {
  count: number;
  /** Requests that returned 2xx. */
  ok: number;
  /** Requests that returned non-2xx or threw. */
  failed: number;
  errorRate: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  /** Requests per second across the whole run. */
  throughputRps: number;
}

export interface LoadResult {
  name: string;
  concurrency: number;
  durationMs: number;
  stats: LatencyStats;
}

/** Nearest-rank percentile over a sorted ascending array (p in 0..100). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export function summarise(samples: LoadSample[], wallMs: number): LatencyStats {
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300).length;
  const failed = samples.length - ok;
  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    ok,
    failed,
    errorRate: samples.length === 0 ? 0 : failed / samples.length,
    minMs: durations[0] ?? 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations[durations.length - 1] ?? 0,
    meanMs: samples.length === 0 ? 0 : sum / samples.length,
    throughputRps: wallMs === 0 ? 0 : (samples.length / wallMs) * 1000,
  };
}

export interface RunLoadOptions {
  name: string;
  /** One request. Must not throw for non-2xx; return the status. */
  request: () => Promise<number>;
  concurrency?: number;
  /** Run for this long, or until `iterations` requests have completed. */
  durationMs?: number;
  iterations?: number;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
}

/**
 * Closed-loop driver: `concurrency` workers each issue one request at a time
 * until the deadline or iteration budget is reached, so in-flight work never
 * exceeds the configured concurrency.
 */
export async function runLoad(options: RunLoadOptions): Promise<LoadResult> {
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const now = options.now ?? Date.now;
  const deadline = options.durationMs !== undefined ? now() + options.durationMs : Infinity;
  let remaining = options.iterations ?? Infinity;

  const samples: LoadSample[] = [];
  const start = now();

  const worker = async (): Promise<void> => {
    while (now() < deadline && remaining > 0) {
      remaining -= 1;
      const t0 = now();
      let status = 0;
      try {
        status = await options.request();
      } catch {
        status = 0;
      }
      samples.push({ status, durationMs: now() - t0 });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = Math.max(1, now() - start);
  return {
    name: options.name,
    concurrency,
    durationMs: wallMs,
    stats: summarise(samples, wallMs),
  };
}

export interface PerformanceBudget {
  /** Maximum tolerated p95 latency, in milliseconds. */
  p95Ms: number;
  /** Maximum tolerated fraction of non-2xx/errored requests (0..1). */
  maxErrorRate?: number;
}

export interface BudgetVerdict {
  withinBudget: boolean;
  breaches: string[];
}

/** Evaluates one result against a budget, naming every breach rather than the first. */
export function assertBudget(result: LoadResult, budget: PerformanceBudget): BudgetVerdict {
  const breaches: string[] = [];
  if (result.stats.p95Ms > budget.p95Ms) {
    breaches.push(`p95 ${result.stats.p95Ms.toFixed(1)}ms > budget ${budget.p95Ms}ms`);
  }
  const maxErrorRate = budget.maxErrorRate ?? 0;
  if (result.stats.errorRate > maxErrorRate) {
    breaches.push(`error rate ${(result.stats.errorRate * 100).toFixed(2)}% > ${(maxErrorRate * 100).toFixed(2)}%`);
  }
  return { withinBudget: breaches.length === 0, breaches };
}

/** Renders a fixed-width report; used by the script and readable in CI logs. */
export function formatResults(results: LoadResult[]): string {
  const header = ['scenario', 'conc', 'reqs', 'err%', 'p50', 'p95', 'p99', 'max', 'rps'];
  const lines = results.map((r) => [
    r.name,
    String(r.concurrency),
    String(r.stats.count),
    (r.stats.errorRate * 100).toFixed(2),
    r.stats.p50Ms.toFixed(1),
    r.stats.p95Ms.toFixed(1),
    r.stats.p99Ms.toFixed(1),
    r.stats.maxMs.toFixed(1),
    r.stats.throughputRps.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const render = (row: string[]) => row.map((v, i) => v.padEnd(widths[i])).join('  ');
  return [render(header), ...lines.map(render)].join('\n');
}