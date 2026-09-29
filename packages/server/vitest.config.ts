import { defineConfig } from 'vitest/config';
import path from 'node:path';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

/**
 * Demo/demo-stack flags the specs assert are *absent* by default.
 *
 * The local demo stack exports these from `packages/server/.env` (loaded by
 * `set -a; . ./.env`, or by the shell that started the demo server). Vitest
 * spawns workers that inherit the parent shell, so they would flip the suite into
 * demo mode and break the specs that pin production behaviour: mandatory email
 * verification, no auto-login, the metrics gate, and the auth throttle limits.
 *
 * Deleting them here — before workers spawn — keeps the suite independent of the
 * caller's shell, matching the intent of the `env` block below. Specs that need a
 * flag set it at runtime via `withEnv`.
 */
const CALLER_SHELL_LEAKS = [
  'DEMO_AUTO_LOGIN',
  'DEMO_SKIP_EMAIL_VERIFICATION',
  'DEMO_STAFF_PASSWORD',
  'DEMO_TEST_ACCOUNT_PASSWORD',
  'DEMO_PAYMENT_MODE',
  'ALLOW_DEV_TOOLING',
  'METRICS_ENABLED',
  'RATE_LIMIT_FORGOT_MAX',
  'RATE_LIMIT_DELETION_MAX',
  'RATE_LIMIT_LOGIN_MAX',
  'RATE_LIMIT_REGISTER_MAX',
] as const;
for (const key of CALLER_SHELL_LEAKS) delete process.env[key];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    globalSetup: './tests/setup.ts',
    env: {
      // `src/lib/env.ts` loads dotenv from the process cwd, so an untracked
      // `packages/server/.env` (used to run the local demo) would otherwise leak
      // its development flags — DEMO_SKIP_EMAIL_VERIFICATION, DEMO_AUTO_LOGIN,
      // RATE_LIMIT_* — into the suite and break the specs that assert those
      // features are OFF by default. Point dotenv at a path that does not exist
      // so the suite's own env below is the only source, keeping it hermetic.
      DOTENV_CONFIG_PATH: path.resolve(__dirname, 'tests/.env.test-does-not-exist'),
      DATABASE_URL: TEST_DB_URL,
      NODE_ENV: 'test',
      // The same hermeticity rule applies to the process environment: a shell
      // that has `ALLOW_DEV_TOOLING=true` exported (the demo/staging envs set
      // it) would otherwise make `devToolingActive()` true even under the
      // `NODE_ENV=production` the specs override, failing the assertion that
      // production never serves dev tooling. Pin it off so the suite does not
      // depend on the caller's shell; specs that need it flip `env` directly.
      ALLOW_DEV_TOOLING: 'false',
      JWT_SECRET: 'test-secret-for-integration-tests-0123456789-abcdefghij',
      // Raise auth rate limits in test so the integration suite (which registers
      // many users in one window) doesn't trip the anti-abuse limiter.
      RATE_LIMIT_REGISTER_MAX: '500',
      RATE_LIMIT_LOGIN_MAX: '500',
      // Payment tests exercise the full service against a real (offline) provider
      // and a real HMAC secret — no external network, no mocking of WASIT logic.
      PAYMENT_PROVIDER: 'manual',
      // The offline provider is a demonstration harness; the suite runs with no
      // real money, so it opts into demo payment mode explicitly.
      DEMO_PAYMENT_MODE: 'true',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
      // Keep the suite output readable: the observability middleware logs every
      // request, and tests make thousands of them.
      OBS_LOG_LEVEL: 'error',
    },
  },
});