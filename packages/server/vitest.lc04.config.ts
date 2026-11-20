import { defineConfig } from 'vitest/config';
import path from 'node:path';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

/**
 * LC-04 test runner (refund financial integrity).
 *
 * Two isolated layers:
 *  - a database-free policy layer that exercises the real provider classes and
 *    the pure evidence-matching predicate — no Postgres, no globalSetup;
 *  - a DB-backed integration layer over the real HTTP stack that proves the
 *    refund rail fails closed under the offline provider and completes only on
 *    trusted external evidence.
 *
 * The DB layer points at a disposable `_test` database (the shared `globalSetup`
 * recreates it), never at a demo or dev database.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/lc04-refund-integrity-policy.test.ts',
      'tests/lc04-refund-external-proof.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    globalSetup: './tests/setup.ts',
    env: {
      DOTENV_CONFIG_PATH: path.resolve(__dirname, 'tests/.env.test-does-not-exist'),
      DATABASE_URL: TEST_DB_URL,
      NODE_ENV: 'test',
      ALLOW_DEV_TOOLING: 'false',
      JWT_SECRET: 'test-secret-for-integration-tests-0123456789-abcdefghij',
      RATE_LIMIT_REGISTER_MAX: '500',
      RATE_LIMIT_LOGIN_MAX: '500',
      PAYMENT_PROVIDER: 'manual',
      DEMO_PAYMENT_MODE: 'true',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
      OBS_LOG_LEVEL: 'error',
    },
  },
});
