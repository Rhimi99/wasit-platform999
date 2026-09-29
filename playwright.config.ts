import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_WEBHOOK_SECRET } from './e2e/helpers';

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

/**
 * Environment the suite requires of the backend it talks to. Declared once here so
 * the `webServer` below and the reuse guard can never drift apart.
 */
const SERVER_ENV = {
  // Every spec performs a UI login; the production-default rate limiter (15/min/IP)
  // would 429 mid-suite. Raise it for the E2E process only.
  RATE_LIMIT_LOGIN_MAX: '500',
  RATE_LIMIT_REGISTER_MAX: '500',
  // The privacy-deletion limiter keys on IP before auth (production default
  // 2/5min); the privacy desk spec files several real deletion requests.
  RATE_LIMIT_DELETION_MAX: '500',
  // The password-recovery spec and global-setup repair both call
  // POST /forgot-password; the production default (5/5min) is exhausted
  // across repeated local runs, which would leave a demo account on a
  // temporary password. Raise it for the E2E process only.
  RATE_LIMIT_FORGOT_MAX: '500',
  // Exercise the real payment kernel offline (no external acquirer calls).
  PAYMENT_PROVIDER: 'manual',
  // The offline provider is a demo harness; the E2E stack runs no real
  // money, so it opts into demo payment mode explicitly.
  DEMO_PAYMENT_MODE: 'true',
  PAYMENT_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
  // Point the backup-freshness alert at a scratch heartbeat so the
  // observability spec can age it on disk and prove the alert fires.
  BACKUP_HEARTBEAT_FILE: path.resolve('.e2e/backup-heartbeat.json'),
  // Default: verification is mandatory, as in every non-demo environment.
  // Run the suite with DEMO_SKIP_EMAIL_VERIFICATION=true to exercise the
  // public-demo contract (register then sign in with no mailbox).
  DEMO_SKIP_EMAIL_VERIFICATION: process.env.DEMO_SKIP_EMAIL_VERIFICATION ?? 'false',
  // The public-demo auto-login endpoint is off unless the demo run opts in,
  // so the default suite proves it is refused rather than merely untested.
  DEMO_AUTO_LOGIN: process.env.DEMO_AUTO_LOGIN ?? 'false',
} as const;

/** The vars above whose value a reused server must match for the suite to be valid. */
const ENV_KEYS_REQUIRED_OF_REUSED_SERVER = Object.keys(SERVER_ENV) as (keyof typeof SERVER_ENV)[];

/**
 * `reuseExistingServer` adopts whatever already answers on the port. That is fine
 * when it is the E2E server from a previous run, but any other server — a dev
 * server, a release bundle, a demo stack — answers the health probe just as
 * happily while running different code, a different database, and a different
 * webhook secret. The suite then fails on scenarios that pass in isolation, and
 * the failures look like product bugs. That phantom cost is far higher than
 * checking, so we check.
 *
 * The listener's own environment is the discriminator: `/proc/<pid>/environ`.
 * A mismatch is a hard stop with the remedy in the message; if the environment
 * cannot be read (no `/proc`, foreign user) we warn rather than block, since the
 * inability to verify is not itself evidence of a bad server.
 */
function assertReusableApiServerMatchesSuite(apiUrl: string): void {
  if (process.env.CI || process.env.E2E_ALLOW_FOREIGN_SERVER === 'true') return;

  const { hostname, port } = new URL(apiUrl);
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return;

  const pid = findListenerPid(Number(port));
  if (!pid) return; // Nothing to adopt — Playwright starts its own server.

  let environ: string | null;
  try {
    environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    console.warn(
      `[e2e] A server is already listening on ${apiUrl} (pid ${pid}) but its environment is not readable, ` +
        'so the suite cannot confirm it is the E2E server. Proceeding, but a mismatched server would cause ' +
        'phantom failures.',
    );
    return;
  }

  const actual = new Map<string, string>();
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) actual.set(entry.slice(0, eq), entry.slice(eq + 1));
  }

  const mismatches = ENV_KEYS_REQUIRED_OF_REUSED_SERVER.filter((key) => actual.get(key) !== SERVER_ENV[key]);
  if (mismatches.length === 0) return;

  const detail = mismatches
    .map((key) => `  ${key}\n    suite requires: ${SERVER_ENV[key]}\n    listener has  : ${actual.get(key) ?? '(unset)'}`)
    .join('\n');

  throw new Error(
    [
      `A server already listening on ${apiUrl} (pid ${pid}) was NOT started by this E2E suite:`,
      detail,
      '',
      'Playwright would silently reuse it (reuseExistingServer) and the suite would run against',
      'different code, database and payment secret — producing failures that look like product bugs.',
      '',
      `Fix: stop that server (kill ${pid}), or run with E2E_ALLOW_FOREIGN_SERVER=true to reuse it anyway.`,
    ].join('\n'),
  );
}

/** Resolves the PID listening on `port` from `/proc`, without `lsof`/`ss`. */
function findListenerPid(port: number): number | null {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content: string;
    try {
      content = fs.readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue; // 0A = LISTEN
      if (Number.parseInt(cols[1].split(':')[1], 16) === port) inodes.add(cols[9]);
    }
  }
  if (inodes.size === 0) return null;

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) return Number(entry);
      } catch {
        // fd closed between listing and reading — keep scanning.
      }
    }
  }
  return null;
}

assertReusableApiServerMatchesSuite(API_URL);

/**
 * Phase 18 E2E — real backend + real PostgreSQL, no mocks.
 *
 * The web app proxies `/api` to the backend (see packages/web/vite.config.ts),
 * so the browser only ever talks to the web origin and the session cookie stays
 * same-origin. Both servers are started here against `wasit_dev`.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npm run dev -w @wasit/server',
      url: `${API_URL}/api/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...SERVER_ENV },
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      cwd: 'packages/web',
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});