import { defineConfig, devices } from '@playwright/test';

/**
 * PR-05 browser verification — no database, no Docker, no demo stack.
 *
 * The main suite (`playwright.config.ts`) starts the real API against PostgreSQL
 * and seeds it in `globalSetup`. The business calculator is entirely client-side
 * (inputs, the fee-model math, the footer link), so it needs only the built web
 * app. No API is called, so no route interception is required.
 *
 * Run: npx playwright test -c playwright.tools.config.ts
 */

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5175';
const WEB_PORT = new URL(WEB_URL).port || '80';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'business-calculator.spec.ts',
  // No globalSetup: it seeds the DB, which this run must not touch.
  globalSetup: undefined,
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
    launchOptions: {
      // The environment ships a system Chromium and no Playwright browser bundle.
      executablePath: process.env.E2E_CHROMIUM_PATH ?? '/usr/bin/chromium',
      args: ['--no-sandbox'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${WEB_PORT} --strictPort`,
    cwd: 'packages/web',
    url: WEB_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
