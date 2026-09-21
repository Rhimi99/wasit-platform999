/**
 * Load smoke test against a running WASIT API.
 *
 *   npx tsx src/scripts/load-smoke.ts [baseUrl]
 *
 * Defaults to http://localhost:3000. It drives the real HTTP server (not the
 * in-process app), so it exercises middleware, serialisation and the database
 * exactly as a client would. Exits non-zero when any scenario breaches its
 * budget, which is what makes it usable as a CI gate.
 */
import {
  assertBudget,
  formatResults,
  runLoad,
  type LoadResult,
  type PerformanceBudget,
} from '../lib/perf/load-runner.js';

const baseUrl = (process.argv[2] ?? process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface Scenario {
  name: string;
  path: string;
  concurrency: number;
  durationMs: number;
  budget: PerformanceBudget;
}

// Budgets are deliberately generous: they are a regression tripwire for the
// platform's own hot reads on a developer machine / CI runner, not a
// benchmark. A healthy instance sits well under these; a broken cache, a
// missing index or a leaked connection pool shows up immediately.
const SCENARIOS: Scenario[] = [
  { name: 'geo.countries', path: '/api/geo/countries?pageSize=50', concurrency: 20, durationMs: 3000, budget: { p95Ms: 250 } },
  { name: 'geo.languages', path: '/api/geo/languages', concurrency: 20, durationMs: 2000, budget: { p95Ms: 250 } },
  { name: 'categories.list', path: '/api/categories', concurrency: 20, durationMs: 2000, budget: { p95Ms: 250 } },
  { name: 'products.list', path: '/api/products?pageSize=20', concurrency: 20, durationMs: 3000, budget: { p95Ms: 400 } },
  { name: 'search.all', path: '/api/search?q=a&type=all', concurrency: 10, durationMs: 3000, budget: { p95Ms: 600 } },
  { name: 'seo.sitemap', path: '/sitemap.xml', concurrency: 10, durationMs: 2000, budget: { p95Ms: 500 } },
  { name: 'health.ready', path: '/api/health/ready', concurrency: 20, durationMs: 2000, budget: { p95Ms: 250 } },
];

async function main(): Promise<void> {
  // Fail fast and clearly if the server is not up.
  try {
    const probe = await fetch(`${baseUrl}/api/health/live`);
    if (!probe.ok) throw new Error(`status ${probe.status}`);
  } catch (err) {
    console.error(`load-smoke: cannot reach ${baseUrl} — is the API running? (${(err as Error).message})`);
    process.exit(2);
  }

  const results: LoadResult[] = [];
  const breaches: string[] = [];

  for (const scenario of SCENARIOS) {
    const result = await runLoad({
      name: scenario.name,
      concurrency: scenario.concurrency,
      durationMs: scenario.durationMs,
      request: async () => (await fetch(`${baseUrl}${scenario.path}`)).status,
    });
    results.push(result);
    const verdict = assertBudget(result, scenario.budget);
    if (!verdict.withinBudget) {
      for (const b of verdict.breaches) breaches.push(`${scenario.name}: ${b}`);
    }
  }

  console.log(`load-smoke against ${baseUrl}`);
  console.log(formatResults(results));

  if (breaches.length > 0) {
    console.error('\nBudget breaches:');
    for (const b of breaches) console.error(`  - ${b}`);
    process.exit(1);
  }
  console.log('\nAll scenarios within budget.');
}

await main();
