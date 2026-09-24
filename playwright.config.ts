import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

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
      env: {
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
        PAYMENT_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
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
      },
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