/**
 * AI-RATE-LIMIT-HARDENING-01 — where a rate-limit counter may live.
 *
 * A counter kept in process memory is a counter per process: with N replicas the
 * effective ceiling is N × max, and a restart forgets the window. That is fine
 * for a laptop and unacceptable for a deployment that can spend money on AI
 * providers, so `production` and `staging` may only run on a shared store.
 *
 * This file is deliberately free of imports: `env.ts` uses it to refuse to boot,
 * and `resolve.ts` uses it to refuse to build a memory store at runtime. Two
 * independent gates, one rule.
 */

export type DeploymentTier = 'production' | 'staging' | 'local';

export type RateLimitStoreId = 'memory' | 'postgres';

export interface RateLimitConfig {
  nodeEnv: string;
  store: RateLimitStoreId;
  /** `AI_RATE_LIMIT_ALLOW_MEMORY_STORE` — escape hatch, local tiers only. */
  allowMemoryStore: boolean;
  /** `AI_RATE_LIMIT_REQUIRE_DURABLE` — explicit setting, honoured locally only. */
  requireDurable: boolean | undefined;
}

/** Deployed tiers are reachable over the network; `test`/`development` are not. */
export function deploymentTier(nodeEnv: string): DeploymentTier {
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'staging') return 'staging';
  return 'local';
}

/**
 * Whether counters must be shared across instances. Deployed tiers cannot opt
 * out — not with `AI_RATE_LIMIT_REQUIRE_DURABLE=false`, not with
 * `AI_RATE_LIMIT_ALLOW_MEMORY_STORE=true`.
 */
export function durableStoreRequired(config: RateLimitConfig): boolean {
  if (deploymentTier(config.nodeEnv) !== 'local') return true;
  if (config.allowMemoryStore) return false;
  return config.requireDurable ?? false;
}

/**
 * Configuration problems that must stop the process before it serves a single
 * request. Empty means the configuration is acceptable for its tier.
 */
export function rateLimitConfigViolations(config: RateLimitConfig): string[] {
  const tier = deploymentTier(config.nodeEnv);
  if (tier === 'local') return [];

  const violations: string[] = [];
  if (config.store !== 'postgres') {
    violations.push(
      `RATE_LIMIT_STORE must be postgres in ${tier} (got ${config.store}); ` +
        'an in-process store gives every replica its own counter, so the limit is N × max',
    );
  }
  if (config.allowMemoryStore) {
    violations.push(`AI_RATE_LIMIT_ALLOW_MEMORY_STORE cannot be enabled in ${tier}`);
  }
  if (config.requireDurable === false) {
    violations.push(`AI_RATE_LIMIT_REQUIRE_DURABLE cannot be disabled in ${tier}`);
  }
  return violations;
}
