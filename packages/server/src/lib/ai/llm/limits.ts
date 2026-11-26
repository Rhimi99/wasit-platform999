import type { LlmCapability } from './contract';

/**
 * Per-task bounds for one generation call.
 *
 * The cost cap is derived, not guessed: it is twice the worst-case cost of a
 * full-size call at the most expensive active catalogue model
 * (`anthropic-claude-sonnet-4`, 0.003 in / 0.015 out per 1k tokens), rounded up
 * to the next thousandth of a dollar. Twice the worst case leaves room for the
 * provider's own tokenisation differences while still refusing anything that
 * could only arise if the input or output bounds were bypassed.
 *
 * Recompute when `maxInputChars`/`maxOutputTokens` change or when a more
 * expensive model is added to the catalogue.
 */
export interface LlmTaskLimits {
  /** Facts (verified data points) a caller may supply. */
  maxFacts: number;
  /** Characters allowed in one fact value before it is truncated. */
  maxFactChars: number;
  /** Untrusted fields a caller may supply. */
  maxUntrustedFields: number;
  /** Characters allowed across all untrusted text. */
  maxUntrustedChars: number;
  /** Characters allowed across facts + untrusted text. */
  maxInputChars: number;
  /** Hard output ceiling passed to the provider. */
  maxOutputTokens: number;
  /** Ceiling for one call's estimated cost, in USD. */
  maxCostUsd: string;
  /** Wall-clock ceiling for one call, in milliseconds. */
  timeoutMs: number;
}

export const LLM_TASK_LIMITS: Readonly<Record<LlmCapability, LlmTaskLimits>> = {
  // 12,000 in ≈ 3,000 tok ($0.009) + 320 out ($0.0048) = $0.0138 → 2× = $0.028
  SUPPORT_REPLY: {
    maxFacts: 24,
    maxFactChars: 240,
    maxUntrustedFields: 8,
    maxUntrustedChars: 6000,
    maxInputChars: 12_000,
    maxOutputTokens: 320,
    maxCostUsd: '0.028',
    timeoutMs: 20_000,
  },
  // 10,000 in ≈ 2,500 tok ($0.0075) + 280 out ($0.0042) = $0.0117 → 2× = $0.024
  SALES_INSIGHT: {
    maxFacts: 24,
    maxFactChars: 240,
    maxUntrustedFields: 4,
    maxUntrustedChars: 3000,
    maxInputChars: 10_000,
    maxOutputTokens: 280,
    maxCostUsd: '0.024',
    timeoutMs: 15_000,
  },
  // 8,000 in ≈ 2,000 tok ($0.006) + 360 out ($0.0054) = $0.0114 → 2× = $0.023
  PRODUCT_ANALYSIS: {
    maxFacts: 24,
    maxFactChars: 240,
    maxUntrustedFields: 2,
    maxUntrustedChars: 4000,
    maxInputChars: 8_000,
    maxOutputTokens: 360,
    maxCostUsd: '0.023',
    timeoutMs: 20_000,
  },
};
