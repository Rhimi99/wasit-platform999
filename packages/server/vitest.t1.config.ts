import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * AI-INTEG-P3-T1 runner — database-free.
 *
 * These specs exercise the REAL `runtime.ts` and `agents.ts` (and the P2
 * security-foundation modules) against in-memory fake `DB` objects and a fake
 * provider. No Postgres and no `globalSetup` are required, so the suite runs
 * anywhere — including CI images without a database. The DB-backed HTTP
 * integration suite keeps its own config (`vitest.config.ts`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/agent-run-context.test.ts',
      'tests/unit/agent-scope-isolation.test.ts',
      'tests/unit/supervisor-policy.test.ts',
      'tests/unit/agent-run-budget-runtime.test.ts',
      'tests/unit/agent-run-context-wiring.test.ts',
      'tests/unit/executor-action-gate.test.ts',
      'tests/unit/order-mixed-seller-guard.test.ts',
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
