/**
 * Boot probe for AI-RATE-LIMIT-HARDENING-01: calls the exact gate `src/index.ts`
 * runs before `serve()`. Running it in a child process proves the real boot
 * behaviour — including `process.exit(1)` and its stderr — instead of simulating
 * it inside the test runner.
 */
import { assertRateLimitConfigOrExit } from '../../src/lib/rate-limit/boot.js';

assertRateLimitConfigOrExit();

// eslint-disable-next-line no-console
console.log('BOOTED');
