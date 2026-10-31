import Decimal from 'decimal.js';
import type { UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { aiModels } from '../../db/schema/ai';
import { eq } from 'drizzle-orm';
import { env } from '../env';
import type { AIFeatureResult, AIProvider } from './types';
import { resolveProvider, estimateTokens } from './provider';
import { logger } from '../observability/logger';
import { getAgentRunBudget, getAgentRunContext, mergeAgentTaskMetadata, AgentRunBudgetExceededError, AgentCostRecordingError } from './agent-run-context';
import {
  assertWithinBudget,
  recordAiRequest,
  upsertAiUsage,
  currentPeriodWindow,
  type BudgetSnapshot,
} from './cost-control';

export interface ModelPrice {
  key: string;
  provider: string;
  displayName: string;
  currencyCode: string;
  inputPer1k: Decimal;
  outputPer1k: Decimal;
}

/**
 * Reads the model pricing from the DB catalogue (admin-configurable).
 * Falls back to a free local model only when nothing is registered.
 */
export async function resolveModelPrice(db: DB, modelKey: string): Promise<ModelPrice> {
  const rows = await db
    .select()
    .from(aiModels)
    .where(eq(aiModels.key, modelKey))
    .limit(1);
  if (rows.length === 0) {
    return {
      key: modelKey,
      provider: 'local',
      displayName: modelKey,
      currencyCode: 'USD',
      inputPer1k: new Decimal(0),
      outputPer1k: new Decimal(0),
    };
  }
  const m = rows[0];
  return {
    key: m.key,
    provider: m.provider,
    displayName: m.displayName,
    currencyCode: m.currencyCode,
    inputPer1k: new Decimal(m.inputPer1k || '0'),
    outputPer1k: new Decimal(m.outputPer1k || '0'),
  };
}

export interface AICallBudget {
  requests: number;
  tokensInput: number;
  tokensOutput: number;
  cost: Decimal;
}

/** Conservative up-front cost estimate used to gate the request pre-call. */
export function estimateBudget(
  opts: { system?: string; user: string; maxTokens?: number },
  price: ModelPrice,
): AICallBudget {
  const tokensIn = estimateTokens((opts.system ?? '') + opts.user);
  const tokensOut = Math.min(opts.maxTokens ?? 256, 4096);
  const cost = price.inputPer1k.mul(tokensIn / 1000).plus(price.outputPer1k.mul(tokensOut / 1000));
  return { requests: 1, tokensInput: tokensIn, tokensOutput: tokensOut, cost };
}

export interface RunFeatureInput {
  userId: string;
  roles: UserRole[];
  requestType: string;
  system?: string;
  user: string;
  maxTokens?: number;
  /**
   * Catalogue model key. When absent, the deployment default (`AI_MODEL`, then
   * `AI_DEFAULT_MODEL`) applies. Never silently ignored.
   */
  modelKey?: string;
  /**
   * Vendor-facing model the adapter must call. Supplied by the router for a
   * catalogue key like `openai-gpt-4o-mini` → `gpt-4o-mini`. Defaults to
   * `modelKey` when the caller already passes a vendor name.
   */
  vendorModel?: string;
  /**
   * Provider instance chosen by the router. When supplied it is used directly so
   * a routed provider is never replaced by an independently resolved one.
   */
  provider?: AIProvider;
  metadata?: Record<string, unknown>;
}

export interface RunFeatureOutput {
  content: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  currencyCode: string;
  requestId: string;
}

/**
 * Executes an AI feature end-to-end:
 * resolve provider → pre-budget check → provider call → cost calc → record → usage.
 *
 * A failure is recorded as a failed `ai_requests` row so the usage/cost ledger
 * stays consistent with reality, then re-thrown unchanged for the caller.
 */
export async function runAIFeature(
  db: DB,
  input: RunFeatureInput,
): Promise<RunFeatureOutput> {
  // Precedence: explicit caller model → deployment AI_MODEL → AI_DEFAULT_MODEL.
  const requestedModelKey = input.modelKey?.trim() || env.AI_MODEL?.trim() || env.AI_DEFAULT_MODEL;
  // The router may have chosen a provider; otherwise resolve from configuration.
  const provider = input.provider ?? resolveProvider();
  // Price follows the provider that actually runs the call. A free local engine
  // must not be billed at a paid model's catalogue rate just because a paid
  // model was requested and then degraded away for lack of credentials.
  const isFree = provider.id === 'local-heuristic' || provider.id === 'noop';
  const modelKey = isFree ? 'local-heuristic' : requestedModelKey;
  const price = await resolveModelPrice(db, modelKey);
  const vendorModel = isFree ? 'local-heuristic' : (input.vendorModel?.trim() || modelKey);

  const period = 'MONTHLY';
  const estimated = estimateBudget({ system: input.system, user: input.user, maxTokens: input.maxTokens }, price);
  const snapshot: BudgetSnapshot = {
    requestsDelta: estimated.requests,
    tokensInputDelta: estimated.tokensInput,
    tokensOutputDelta: estimated.tokensOutput,
    costDelta: estimated.cost,
  };
  await assertWithinBudget(db, input.userId, input.roles, period, snapshot, env.AI_BUDGET_MONTHLY_USD);

  // Per-run ceiling (agent tasks only). This is an ADDITIONAL guard on top of the
  // monthly budget above. The call's conservative estimate is reserved atomically
  // BEFORE the provider call, so two concurrent calls in one run cannot both slip
  // under the same remaining headroom — the second is refused up front. The
  // reservation is settled to the measured cost after the call (see below).
  const runBudget = getAgentRunBudget();
  if (runBudget && !runBudget.reserve(estimated.cost)) {
    throw new AgentRunBudgetExceededError(runBudget.maxCostUsd!.toFixed(10), runBudget.spentUsd.toFixed(10));
  }

  // Attribute this request to the running agent task, if any. `taskId` comes
  // from the trusted run context (never `input`), so the AI ledger can be joined
  // back to `agent_tasks` for per-agent cost/token/fallback metrics (AI-06.0).
  const requestMetadata = mergeAgentTaskMetadata(input.metadata, getAgentRunContext());

  const started = Date.now();
  let result;
  try {
    result = await provider.call({
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens ?? 256,
      temperature: 0.2,
      budgetPeriod: period,
      model: vendorModel,
    });
  } catch (err) {
    // The call never produced a billable result, so release the reservation: the
    // run must not be charged for a call that did not complete.
    runBudget?.release(estimated.cost);
    const latencyMs = Date.now() - started;
    // Persist the failed attempt (no tokens billed) so the ledger and the audit
    // trail reflect that a provider call was made and did not succeed.
    await recordAiRequest(db, {
      userId: input.userId,
      requestType: input.requestType,
      model: modelKey,
      tokensInput: 0,
      tokensOutput: 0,
      cost: '0',
      currencyCode: price.currencyCode,
      status: (err as { statusCode?: number }).statusCode === 503 ? 'UNAVAILABLE' : 'FAILED',
      latencyMs,
      metadata: {
        ...requestMetadata,
        provider: provider.id,
        errorName: (err as Error).name,
        providerStatus: (err as { statusCode?: number }).statusCode ?? null,
      },
    }).catch((recordErr) => {
      // Never mask the provider failure with a bookkeeping failure.
      logger.error('Failed to record a failed AI request', { error: (recordErr as Error).message });
    });
    throw err;
  }
  const latencyMs = Date.now() - started;

  // Exact cost from the measured tokens.
  const actualCost = price.inputPer1k.mul(result.tokensInput / 1000).plus(price.outputPer1k.mul(result.tokensOutput / 1000));

  // Settle the reservation to the measured cost. The provider call has already
  // happened, so the money is spent whether or not the run stays within its
  // ceiling — the cost is ALWAYS recorded (never dropped) and the accumulator is
  // always moved to the true spend, so a later call can never be allowed on the
  // strength of an unrecorded overshoot. `overBudget` is true only when the
  // settled total exceeds the ceiling; the request is then recorded in full with
  // an over-budget marker and the run is refused after the ledger is written.
  const overBudget = runBudget ? !runBudget.settle(estimated.cost, actualCost) : false;
  const costRecord = {
    userId: input.userId,
    requestType: input.requestType,
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cost: actualCost.toFixed(10),
    currencyCode: price.currencyCode,
    status: overBudget ? 'OVER_BUDGET' : 'SUCCESS',
    latencyMs,
    metadata: overBudget
      ? { ...requestMetadata, provider: provider.id, runBudgetExceeded: true }
      : { ...requestMetadata, provider: provider.id },
  };

  let requestId: string;
  try {
    requestId = await recordAiRequest(db, costRecord);
  } catch (recordErr) {
    // The measured cost could not be persisted. The money was still spent, so we
    // must not claim it was recorded and must not let the run continue on an
    // under-counted ledger — fail the run closed with a distinct, retryable
    // error (the caller's retry re-enters the ledger path).
    logger.error('Failed to record the measured AI cost; refusing to continue', {
      error: (recordErr as Error).message,
      requestType: input.requestType,
      cost: costRecord.cost,
    });
    throw new AgentCostRecordingError(costRecord.cost, (recordErr as Error).message);
  }

  // Monthly usage aggregation is a derived rollup for dashboards. The
  // authoritative ledger row above is what the monthly budget re-sums
  // (`usageSum` reads `ai_requests`), so a rollup failure cannot lose cost or
  // weaken enforcement — it is logged, not fatal, to avoid a needless retry that
  // would itself spend more.
  try {
    const window = currentPeriodWindow(period);
    await upsertAiUsage(db, input.userId, period, window, {
      requests: 1,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      cost: actualCost.toFixed(10),
      currencyCode: price.currencyCode,
    });
  } catch (usageErr) {
    logger.error('Failed to aggregate AI usage after a measured call', {
      error: (usageErr as Error).message,
      requestType: input.requestType,
      cost: costRecord.cost,
    });
  }

  if (overBudget) {
    // Refuse the run only AFTER the full cost is on the ledger. The accumulator
    // was settled to the true (over-cap) spend, so any subsequent call is refused
    // up front too.
    throw new AgentRunBudgetExceededError(runBudget!.maxCostUsd!.toFixed(10), runBudget!.spentUsd.toFixed(10));
  }

  return {
    content: result.content,
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cost: actualCost.toFixed(10),
    currencyCode: price.currencyCode,
    requestId,
  };
}

/**
 * Convenience wrapper for AI features that want to also produce a structured
 * result alongside the raw provider output.
 */
export async function runAIFeatureStructured(
  db: DB,
  input: RunFeatureInput,
  mapper: (content: string) => Record<string, unknown>,
): Promise<AIFeatureResult & { requestId: string }> {
  const out = await runAIFeature(db, input);
  let data: Record<string, unknown>;
  try {
    data = mapper(out.content);
  } catch {
    data = { error: 'unparseable_al', content: out.content };
  }
  return {
    kind: input.requestType,
    model: out.model,
    recommendation: data,
    confidence: 1,
    reasoning: [],
    estimatedCost: out.cost,
    requestId: out.requestId,
  };
}