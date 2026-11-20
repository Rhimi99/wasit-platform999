import { defineConfig, devices } from '@playwright/test';

/**
 * LC-02 browser verification — no database, no Docker, no demo stack.
 *
 * The main suite (`playwright.config.ts`) starts the real API against PostgreSQL
 * and seeds it in `globalSetup`. The cookie-consent behaviour under test is
 * entirely client-side (localStorage, the consent UI, and the marketing gate on
 * the advertising slot), so it needs only the built web app plus a mock of the
 * few API reads the public pages perform. Mocks are installed per test with
 * `page.route`, never here.
 *
 * Run: npx playwright test -c playwright.cookie.config.ts
 */

const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5174';
const WEB_PORT = new URL(WEB_URL).port || '80';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'cookie-consent.spec.ts',
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
