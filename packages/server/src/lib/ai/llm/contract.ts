import { z } from 'zod';

/**
 * The contract of the unified generation path (AI-LLM-01).
 *
 * Everything an agent may send to a language model is described here: a closed
 * capability list, a closed fact shape, and the exact JSON the model must return.
 * A caller cannot add fields, change the schema or supply its own instructions —
 * `runLlmDraft` reads the schema from this module and the system prompt from
 * `prompts.ts`, both server-owned.
 */

export const LLM_CAPABILITIES = [
  'SUPPORT_REPLY',
  'SALES_INSIGHT',
  'PRODUCT_ANALYSIS',
  /**
   * The coordinator capability (WASIT-COPILOT-01). Its facts are the server-owned
   * agent catalogue — never a tenant's rows — and its output is a PLAN, which is
   * validated against that same catalogue and then against the live registry
   * before anything is dispatched.
   */
  'COPILOT_PLAN',
] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

export function isLlmCapability(value: unknown): value is LlmCapability {
  return typeof value === 'string' && (LLM_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * A single verified data point. `source` is the table (or platform source) the
 * value came from, and it must be inside the agent's scope contract — this is
 * what stops one agent's rows being laundered into another agent's prompt.
 */
export interface LlmFact {
  key: string;
  value: string | number | boolean | null;
  source: string;
}

/** Text written by a user (a message body, a seller's description) — never trusted. */
export interface LlmUntrustedField {
  field: string;
  text: string;
}

export interface LlmDraftRequest {
  /** Must equal the running agent's key; a mismatch is refused. */
  agentKey: string;
  capability: LlmCapability;
  facts: LlmFact[];
  untrusted?: LlmUntrustedField[];
  /** Who the generated text is written for. Defaults to `staff`. */
  audience?: 'user' | 'staff';
  locale?: 'ar' | 'fr' | 'en';
}

/**
 * The only accepted model output. `evidence` is not decoration: every entry must
 * name a fact that was actually supplied, with that fact's value, or it is
 * dropped (see `grounding.ts`).
 */
export const llmDraftOutputSchema = z.object({
  text: z.string().min(1).max(3000),
  classification: z.string().min(1).max(64),
  summary: z.string().max(1500),
  evidence: z
    .array(z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(240) }))
    .min(1)
    .max(12),
  insufficientInfo: z.boolean(),
  injectionSuspected: z.boolean().optional(),
});

export type LlmDraftOutput = z.infer<typeof llmDraftOutputSchema>;

/**
 * The only accepted plan output. A step names an agent key and a reason — never
 * an input payload: what a delegated agent receives is built by server code, so
 * model text cannot craft another agent's task input.
 */
export const copilotPlanOutputSchema = z.object({
  goal: z.string().min(1).max(300),
  constraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  expectedOutputs: z.array(z.string().min(1).max(200)).max(10).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().max(400).nullish(),
  steps: z
    .array(
      z.object({
        stepKey: z.string().min(1).max(64),
        agentKey: z.string().min(1).max(64),
        reason: z.string().max(300).default(''),
        dependsOn: z.array(z.string().min(1).max(64)).max(10).optional(),
      }),
    )
    .min(1)
    .max(10),
  injectionSuspected: z.boolean().optional(),
});

export type CopilotPlanOutput = z.infer<typeof copilotPlanOutputSchema>;

/** Why a draft could not be produced. Every value degrades to the deterministic engine. */
export type LlmFailureReason =
  | 'no_generative_provider'
  | 'provider_unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'ungrounded_output'
  | 'spend_guard'
  | 'spend_limit'
  | 'cost_cap'
  | 'input_rejected'
  | 'agent_mismatch'
  | 'scope_violation';

/** Bookkeeping for one attempt — carries no prompt text and no fact values. */
export interface LlmCallMeta {
  capability: LlmCapability;
  agentKey: string;
  providerKey: string;
  model: string;
  cost: string;
  currencyCode: string;
  tokensInput: number;
  tokensOutput: number;
  requestId: string | null;
  latencyMs: number;
  factCount: number;
  untrustedFieldCount: number;
  /** Evidence entries the model produced that no supplied fact supports. */
  ungrounded: string[];
  /** Instruction-shaped patterns found in the untrusted input, by kind. */
  injectionSignals: string[];
  /** True when a supplied value was shortened to fit the limits. */
  truncated: boolean;
}

export interface LlmDraftSuccess {
  status: 'draft';
  /** Text written for a human, always a draft that needs review. */
  text: string;
  /** Staff-facing analysis, kept separate from the user-facing text. */
  analysis: { summary: string; classification: string };
  evidence: { key: string; value: string; source: string }[];
  insufficientInfo: boolean;
  injectionSuspected: boolean;
  requiresReview: true;
  audience: 'user' | 'staff';
  meta: LlmCallMeta;
}

export interface LlmDraftFallback {
  status: 'fallback';
  reason: LlmFailureReason;
  /** Short, non-sensitive explanation (never a prompt or a model answer). */
  detail: string;
  meta: LlmCallMeta;
}

/**
 * A coordinator plan. It is a PROPOSAL: `requiresReview` is always true and the
 * caller must validate and persist it through the planning service before any
 * step can run.
 */
export interface LlmPlanSuccess {
  status: 'plan';
  goal: string;
  constraints: string[];
  expectedOutputs: string[];
  needsClarification: boolean;
  clarificationQuestion: string | null;
  steps: { stepKey: string; agentKey: string; reason: string; dependsOn: string[] }[];
  injectionSuspected: boolean;
  requiresReview: true;
  meta: LlmCallMeta;
}

export type LlmDraftResult = LlmDraftSuccess | LlmPlanSuccess | LlmDraftFallback;
