import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * LC-03 test runner (prohibited & restricted goods policy).
 *
 * These specs are deliberately database-free: they exercise the pure classifier
 * plus the enforcement decisions in the products service against an in-memory
 * fake `DB`. No Postgres and no `globalSetup` are needed, so the suite runs
 * anywhere — including CI images that do not spin up a database. The DB-backed
 * HTTP integration suite keeps its own config (`vitest.config.ts`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/lc03-prohibited-goods-policy.test.ts',
      'tests/lc03-enforcement.test.ts',
      'tests/lc03-review-authorization.test.ts',
    ],
    testTimeout: 15000,
    env: {
      DOTENV_CONFIG_PATH: path.resolve(__dirname, 'tests/.env.test-does-not-exist'),
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-for-integration-tests-0123456789-abcdefghij',
      OBS_LOG_LEVEL: 'error',
    },
  },
});
