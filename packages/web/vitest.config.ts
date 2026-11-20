import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * LC-02 test runner for the web package.
 *
 * These are the isolated, framework-free halves of the cookie-consent work:
 * the decision logic in `src/lib/cookie-consent.ts`, the translation contract in
 * `src/lib/i18n.ts`, and the enforcement wiring in the tracking components. No
 * DOM and no database are needed, so the suite runs anywhere. The end-to-end
 * banner flow (real browser + servers) lives in `e2e/`.
 *
 * The `@` alias mirrors `vite.config.ts` so a test can render a real component
 * that imports through it (e.g. the M2.4-T2.4 refund-attribution panel).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
