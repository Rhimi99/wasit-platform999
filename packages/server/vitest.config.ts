import { defineConfig } from 'vitest/config';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    globalSetup: './tests/setup.ts',
    env: {
      DATABASE_URL: TEST_DB_URL,
      NODE_ENV: 'test',
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