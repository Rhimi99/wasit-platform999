import { env } from '../env';
import { rateLimitConfigViolations } from './policy';

/**
 * AI-RATE-LIMIT-HARDENING-01 — the API server's boot gate.
 *
 * Kept out of `env.ts` on purpose: every operator CLI and migration script also
 * imports the environment, and a password-reset CLI has no rate-limit counters to
 * share. Only the process that serves traffic (`src/index.ts`) must satisfy this
 * rule, and it does so before `serve()` — never after.
 */
export function rateLimitConfigViolationsNow(): string[] {
  return rateLimitConfigViolations({
    nodeEnv: env.NODE_ENV,
    store: env.RATE_LIMIT_STORE,
    allowMemoryStore: env.AI_RATE_LIMIT_ALLOW_MEMORY_STORE,
    requireDurable: env.AI_RATE_LIMIT_REQUIRE_DURABLE,
  });
}

/** Exits the process when the deployment would run on per-process counters. */
export function assertRateLimitConfigOrExit(): void {
  const violations = rateLimitConfigViolationsNow();
  if (violations.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(`Refusing to start: ${violations.join(' | ')}`);
  process.exit(1);
}
