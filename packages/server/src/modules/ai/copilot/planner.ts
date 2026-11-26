import type { UserRole } from '@wasit/shared';
import type { DB } from '../../../db/client';
import { withAgentRunContext } from '../../../lib/ai/agent-run-context';
import { runLlmDraft } from '../../../lib/ai/llm/service';
import { LLM_PROMPT_VERSION } from '../../../lib/ai/llm/prompts';
import { CATALOGUE_SOURCE, COORDINATOR_AGENT_KEY } from '../../../lib/ai/llm/coordinator';
import type { LlmFact } from '../../../lib/ai/llm/contract';
import { findAgentSpec } from '../catalogue';
import { plannableRules, ruleFor } from './domains';
import type { CopilotIntent, CopilotPlan, CopilotProposedStep } from './types';

/**
 * The planning half of the coordinator.
 *
 * Two producers, one contract:
 *  - the model, when a generative provider is configured, proposes WHICH agents
 *    and WHY (never inputs, never payloads);
 *  - the local heuristic does the same from a fixed keyword table, so the
 *    coordinator keeps working with no provider at all.
 *
 * Whatever the producer, the result is a proposal: it is validated against the
 * live registry, the requester's permissions and the dependency graph by the
 * existing planning service before a single row is written.
 */

/** Ordering rules that are true in the domain, not invented by a model. */
const DEPENDENCY_RULES: ReadonlyArray<{ dependsOn: string; signal: string }> = [
  // A campaign plan must exist before a campaign video is produced from it.
  { dependsOn: 'marketing', signal: 'video' },
  // Outreach follows market research; the research defines the target market.
  { dependsOn: 'market', signal: 'growth' },
  // Compliance reviews the settlement findings, so it runs after them.
  { dependsOn: 'payments', signal: 'compliance' },
];

/** One request fans out to at most this many agents (the catalogue's own cap). */
export const MAX_COPILOT_STEPS = 6;

/** The catalogue as generation facts — only agents the coordinator may plan. */
export function catalogueFacts(): LlmFact[] {
  return plannableRules().map((rule) => {
    const spec = findAgentSpec(rule.agentKey);
    const approval = spec?.requiresHumanApproval ? 'requires human approval' : 'no approval needed';
    return {
      // Fact keys allow only [a-zA-Z0-9_.] (sanitize.ts), so the agent key is
      // carried in the value and normalised for the key.
      key: `agent.${rule.agentKey.replace(/-/g, '_')}`,
      value: `${rule.agentKey} — ${spec?.name ?? rule.agentKey}; ${rule.signal}; ${approval}`,
      source: CATALOGUE_SOURCE,
    };
  });
}

function stepKeyFor(signal: string): string {
  return signal.replace(/[^a-z0-9_-]/gi, '-').slice(0, 64) || 'step';
}

/** Deterministic plan from the recognised signals. */
export function heuristicPlan(intent: CopilotIntent): CopilotProposedStep[] {
  const chosen: { signal: string; agentKey: string }[] = [];
  for (const signal of intent.signals) {
    const rule = plannableRules().find((r) => r.signal === signal);
    if (!rule) continue;
    if (chosen.some((c) => c.agentKey === rule.agentKey)) continue;
    chosen.push({ signal: rule.signal, agentKey: rule.agentKey });
    if (chosen.length >= MAX_COPILOT_STEPS) break;
  }
  return chosen.map((c) => {
    const rule = ruleFor(c.agentKey)!;
    const dependsOn = DEPENDENCY_RULES.filter(
      (d) => d.signal === c.signal && chosen.some((x) => x.signal === d.dependsOn),
    ).map((d) => stepKeyFor(d.dependsOn));
    return {
      stepKey: stepKeyFor(c.signal),
      agentKey: c.agentKey,
      reason: `The request names ${c.signal}, which this agent owns.`,
      dependsOn,
      input: { ...rule.defaultInput },
    };
  });
}

export interface ProposePlanInput {
  requesterId: string;
  roles: UserRole[];
  intent: CopilotIntent;
  /** The General Manager's original text; treated as untrusted content. */
  request: string;
}

/**
 * Asks the model for a plan, then refuses anything the catalogue does not
 * contain. Returns `null` when the model could not produce a usable plan.
 */
async function modelPlan(
  db: DB,
  input: ProposePlanInput,
): Promise<{ plan: CopilotPlan } | { refusal: string }> {
  const facts = catalogueFacts();
  const context = {
    taskId: `copilot-plan:${input.requesterId}`,
    agentKey: COORDINATOR_AGENT_KEY,
    requestedBy: input.requesterId,
    requesterRoles: input.roles,
    allowedTables: [CATALOGUE_SOURCE],
    authorizedActions: ['delegate', 'summarize'],
  };

  const result = await withAgentRunContext(context, () =>
    runLlmDraft(db, {
      agentKey: COORDINATOR_AGENT_KEY,
      capability: 'COPILOT_PLAN',
      facts,
      untrusted: [{ field: 'general_manager_request', text: input.request }],
      audience: 'staff',
      locale: input.intent.locale,
    }),
  );

  if (result.status === 'fallback') return { refusal: result.reason };
  if (result.status !== 'plan') return { refusal: 'invalid_output' };

  // The model may only choose agents this coordinator is allowed to plan, with
  // inputs built by server code. Anything else discards the whole plan.
  const steps: CopilotProposedStep[] = [];
  for (const step of result.steps) {
    const rule = ruleFor(step.agentKey);
    if (!rule || !plannableRules().some((r) => r.agentKey === step.agentKey)) {
      return { refusal: 'ungrounded_output' };
    }
    steps.push({
      stepKey: stepKeyFor(step.stepKey),
      agentKey: step.agentKey,
      reason: step.reason.slice(0, 300),
      dependsOn: step.dependsOn.map(stepKeyFor),
      input: { ...rule.defaultInput },
    });
  }
  if (steps.length === 0) return { refusal: 'invalid_output' };
  if (steps.length > MAX_COPILOT_STEPS) return { refusal: 'invalid_output' };

  return {
    plan: {
      goal: result.goal.slice(0, 300) || input.intent.goal,
      constraints: result.constraints.slice(0, 10),
      expectedOutputs: result.expectedOutputs.slice(0, 10),
      steps,
      source: 'llm',
      fallbackReason: null,
      promptVersion: LLM_PROMPT_VERSION,
      injectionSuspected: result.injectionSuspected,
      meta: {
        model: result.meta.model,
        providerKey: result.meta.providerKey,
        cost: result.meta.cost,
        tokensInput: result.meta.tokensInput,
        tokensOutput: result.meta.tokensOutput,
        latencyMs: result.meta.latencyMs,
      },
    },
  };
}

/**
 * Produces the plan the coordinator will propose.
 *
 * The model is tried first; any refusal (no provider, cost cap, bad schema,
 * invented agent) degrades to the deterministic plan and the reason is recorded
 * in the report. A model's "I need clarification" is honoured only when the
 * deterministic analyser also found nothing to act on — a provider outage or a
 * cautious model must never block a request the platform can plan itself.
 */
export async function proposePlan(db: DB, input: ProposePlanInput): Promise<CopilotPlan> {
  const heuristic = heuristicPlan(input.intent);
  const heuristicPlanResult: CopilotPlan = {
    goal: input.intent.goal,
    constraints: input.intent.constraints,
    expectedOutputs: input.intent.expectedOutputs,
    steps: heuristic,
    source: 'heuristic',
    fallbackReason: null,
    promptVersion: null,
    injectionSuspected: false,
    meta: null,
  };

  if (input.intent.needsClarification) return heuristicPlanResult;

  const model = await modelPlan(db, input);
  if ('refusal' in model) {
    return { ...heuristicPlanResult, fallbackReason: model.refusal as CopilotPlan['fallbackReason'] };
  }
  return model.plan;
}
