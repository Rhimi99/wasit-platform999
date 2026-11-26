import type { LlmFailureReason } from '../../../lib/ai/llm/contract';

/**
 * WASIT-COPILOT-01 — the coordinator's own contract.
 *
 * The Copilot is a coordination layer, not a 21st agent: it owns no data, runs
 * no executor and can be dispatched as a step by nobody (`agentRunRefusal`
 * refuses it). What it does is turn one General Manager request into a plan over
 * the 20 existing agents, delegate through the existing planning/dispatch
 * services, and report what actually happened.
 */

export type CopilotLocale = 'ar' | 'fr' | 'en';

/** What the coordinator understood from the request. Deterministic unless noted. */
export interface CopilotIntent {
  /** One-line statement of the objective. */
  goal: string;
  constraints: string[];
  expectedOutputs: string[];
  locale: CopilotLocale;
  /** True only when the missing information would change what gets planned. */
  needsClarification: boolean;
  clarificationQuestion: string | null;
  /** Recognised domain signals, e.g. `sales`, `support`. Never model text. */
  signals: string[];
}

/** A step the coordinator wants to run, before server validation. */
export interface CopilotProposedStep {
  stepKey: string;
  agentKey: string;
  reason: string;
  dependsOn: string[];
  /** Built by server code from the agent's own contract — never by the model. */
  input: Record<string, unknown>;
}

/** The plan, with the provenance of how it was produced. */
export interface CopilotPlan {
  goal: string;
  constraints: string[];
  expectedOutputs: string[];
  steps: CopilotProposedStep[];
  source: 'llm' | 'heuristic';
  /** Why the model plan was not used, when it was not. */
  fallbackReason: LlmFailureReason | null;
  promptVersion: string | null;
  injectionSuspected: boolean;
  meta: {
    model: string;
    providerKey: string;
    cost: string;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
  } | null;
}

/** One row of the report. Everything here comes from the database. */
export interface CopilotReportStep {
  stepKey: string;
  agentKey: string;
  agentName: string;
  reason: string;
  status: string;
  requiresApproval: boolean;
  approvedBy: string | null;
  taskId: string | null;
  taskStatus: string | null;
  attempts: number;
  /** Short, non-sensitive digest of what the agent returned. */
  outcome: string | null;
  /** The agent itself refused or reported an error inside a "successful" task. */
  refused: boolean;
  costUsd: string | null;
  error: string | null;
}

export interface CopilotEscalation {
  kind: 'approval' | 'failure' | 'stalled';
  stepKey: string;
  agentKey: string;
  message: string;
}

export interface CopilotReport {
  runId: string;
  goal: string;
  request: string | null;
  status: string;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  plan: {
    source: 'llm' | 'heuristic';
    fallbackReason: string | null;
    promptVersion: string | null;
    injectionSuspected: boolean;
    constraints: string[];
    expectedOutputs: string[];
    model: string | null;
    costUsd: string;
  };
  steps: CopilotReportStep[];
  progress: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    awaitingApproval: number;
    pending: number;
    running: number;
  };
  /** Completed, partial and stalled are kept apart on purpose. */
  outcomes: {
    completed: string[];
    partial: string[];
    stalled: string[];
  };
  escalations: CopilotEscalation[];
  cost: {
    totalUsd: string;
    planningUsd: string;
    executionUsd: string;
    /** False when a task ran without a recorded cost — never reported as zero. */
    complete: boolean;
  };
  /** Copilot is never allowed to self-approve; stated in the payload. */
  governance: {
    approvalsRequired: number;
    selfApproval: false;
    dispatchable: boolean;
  };
}

export interface CopilotRequestView {
  needsClarification: boolean;
  clarificationQuestion: string | null;
  intent: CopilotIntent;
  report: CopilotReport | null;
}
