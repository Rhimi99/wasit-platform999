import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Test-database guard runner — database-free.
 *
 * These specs validate the pure guard in `tests/test-db-guard.ts` that pins the
 * DB-backed suite to the single authorized isolated target. No Postgres and no
 * `globalSetup` are needed, so the suite runs anywhere.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/test-db-guard.test.ts'],
    testTimeout: 15000,
    env: {
      DOTENV_CONFIG_PATH: path.resolve(__dirname, 'tests/.env.test-does-not-exist'),
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-for-integration-tests-0123456789-abcdefghij',
      OBS_LOG_LEVEL: 'error',
    },
  },
});
