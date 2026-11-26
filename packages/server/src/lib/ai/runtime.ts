import Decimal from 'decimal.js';
import type { UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { aiModels } from '../../db/schema/ai';
import { eq } from 'drizzle-orm';
import { env } from '../env';
import { assertAiExecutionEnabled } from './kill-switch';
import { ApiError } from '@wasit/shared';
import type { AIFeatureResult, AIProvider } from './types';
import { estimateTokens, LocalHeuristicProvider, VENDOR_MODEL_NAMES } from './provider';
import { configEnvironment, isPaidProvider, primaryProvider } from './provider-config';
import { isFreeProvider, releaseSpend, reserveSpend, settleSpend, type SpendReservation } from './spend-limits';
import { assertSpendGuard } from './spend-guard';
import { logger } from '../observability/logger';
import {
  getAgentRunBudget,
  getAgentRunContext,
  mergeAgentTaskMetadata,
  AgentRunBudgetExceededError,
  AgentCostRecordingError,
  AGENT_TASK_LEDGER_KEY,
} from './agent-run-context';
import {
  assertWithinBudget,
  recordAiRequest,
  upsertAiUsage,
  currentPeriodWindow,
  type BudgetSnapshot,
  type CostSource,
  findRequestByKey,
} from './cost-control';

export interface ModelPrice {
  key: string;
  provider: string;
  displayName: string;
  currencyCode: string;
  inputPer1k: Decimal;
  outputPer1k: Decimal;
  /** False when no catalogue row exists — the price is unknown, not zero. */
  registered: boolean;
}

/**
 * Parses a configured per-1k price into an exact, non-negative Decimal.
 *
 * Fail-closed: a negative, non-numeric, NaN or infinite catalogue value is a
 * misconfiguration that could otherwise yield a NEGATIVE cost estimate and so
 * widen (or invert) the budget instead of bounding it. Such a value is refused
 * (503) rather than silently coerced to zero. A zero price is valid (free/local
 * models) and returned as-is. No non-numeric or infinite Decimal ever escapes.
 */
function parsePricePer1k(raw: unknown): Decimal {
  let value: Decimal;
  try {
    value = new Decimal((raw ?? '0') as Decimal.Value);
  } catch {
    throw ApiError.serviceUnavailable('AI model pricing is misconfigured (non-numeric price)');
  }
  if (!value.isFinite() || value.lt(0)) {
    throw ApiError.serviceUnavailable('AI model pricing is misconfigured (invalid price)');
  }
  return value;
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
      registered: false,
    };
  }
  const m = rows[0];
  return {
    key: m.key,
    provider: m.provider,
    displayName: m.displayName,
    currencyCode: m.currencyCode,
    inputPer1k: parsePricePer1k(m.inputPer1k),
    outputPer1k: parsePricePer1k(m.outputPer1k),
    registered: true,
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
  /**
   * Idempotency key for this logical call. A retry or a replayed event with the
   * same key is recorded once; the second attempt returns the first row.
   */
  requestKey?: string;
  /**
   * When an external provider is out of spend budget, run on the local engine
   * instead of failing the caller. Defaults to true: the local engine is free and
   * must not be disabled by a vendor cap. Set false where a degraded answer is
   * not acceptable.
   */
  allowLocalFallback?: boolean;
  /**
   * Deadline for the provider call, forwarded to the adapter. An abort is a
   * failed attempt: it is recorded as FAILED and any spend reservation released.
   */
  signal?: AbortSignal;
}

export interface RunFeatureOutput {
  content: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  currencyCode: string;
  requestId: string;
  providerKey: string;
  costSource: CostSource;
  /** True when the idempotency key was already recorded; nothing new was spent. */
  duplicate?: boolean;
}

/**
 * Strips the server-owned reconciliation key from caller-supplied metadata.
 *
 * Used on the no-run-context path so a direct caller (`/api/ai/run`) can never
 * plant `metadata[AGENT_TASK_LEDGER_KEY]` and have `reconcileTaskCostFromLedger`
 * treat it as trusted evidence for a task it does not own (AI-INTEG-P3-G2). Every
 * other key is preserved untouched, so master paths keep their exact behaviour.
 */
function stripReservedAgentMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...(metadata ?? {}) };
  delete merged[AGENT_TASK_LEDGER_KEY];
  return merged;
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
  // Central AI Kill Switch (A1): the innermost safety net. Every provider call
  // in the platform flows through here, so a global disable stops ALL AI work —
  // agent executors, smart features and one-off `/api/ai/run` alike — before any
  // budget reservation or provider call. Fail-closed and LLM-independent.
  await assertAiExecutionEnabled(db);
  // Idempotency: a key that is already on the ledger means this logical call
  // completed before (a retried request or a replayed event). Returning the
  // recorded outcome — with no second provider call — is the only way to keep
  // both the ledger AND the spend counter exact. The content is not stored, so
  // `duplicate: true` tells the caller the result was already delivered.
  if (input.requestKey) {
    const existing = await findRequestByKey(db, input.requestKey);
    if (existing) {
      return {
        content: '',
        model: existing.model,
        tokensInput: existing.tokensInput,
        tokensOutput: existing.tokensOutput,
        cost: existing.cost,
        currencyCode: existing.currencyCode,
        requestId: existing.id,
        providerKey: existing.providerKey ?? 'unknown',
        costSource: (existing.costSource as CostSource) ?? 'UNKNOWN',
        duplicate: true,
      };
    }
  }
  // A caller that did not route (feature endpoints, structured runs) gets the
  // admin-configured chain: default → fallback → local. It never throws, so a
  // deployment with no vendor key keeps working on the local engine.
  let chainedModel: string | null = null;
  let provider = input.provider;
  if (!provider) {
    const entry = await primaryProvider(db);
    provider = entry.provider;
    if (entry.key !== 'local-heuristic' && entry.key !== 'noop') chainedModel = entry.model;
  }
  // Precedence: explicit caller model → routed/configured model → deployment
  // AI_MODEL → AI_DEFAULT_MODEL.
  const requestedModelKey =
    input.modelKey?.trim() || chainedModel || env.AI_MODEL?.trim() || env.AI_DEFAULT_MODEL;
  // Price follows the provider that actually runs the call. A free local engine
  // must not be billed at a paid model's catalogue rate just because a paid
  // model was requested and then degraded away for lack of credentials.
  let isFree = isFreeProvider(provider.id);
  let modelKey = isFree ? 'local-heuristic' : requestedModelKey;
  let price = await resolveModelPrice(db, modelKey);
  let vendorModel = isFree
    ? 'local-heuristic'
    : (input.vendorModel?.trim() || VENDOR_MODEL_NAMES[modelKey] || modelKey);

  // A paid call with no catalogue price cannot be measured, so it cannot be
  // bounded. Refusing is the only honest option: treating an unregistered model
  // as free would spend real money while recording zero.
  if (!isFree && !price.registered) {
    throw ApiError.serviceUnavailable(
      `AI model pricing is not configured for "${modelKey}" — refusing an unmeasurable paid call`,
    );
  }

  // Environment scopes usage and limits, so a demo run can never consume or be
  // charged against a production budget in the same database.
  const environment = configEnvironment();
  const runCtxForAttribution = getAgentRunContext();
  const agentKey = runCtxForAttribution?.agentKey ?? null;

  // AI-SPEND-GUARD-01. Missing caps are a misconfiguration, not a reached limit,
  // so they are refused instead of silently falling back: the deployment must not
  // look like it is running paid AI while nothing bounds the bill. Free providers
  // never reach the table and keep working.
  if (isPaidProvider(provider.id)) await assertSpendGuard(db, provider.id, environment);

  const period = 'MONTHLY';
  const estimated = estimateBudget({ system: input.system, user: input.user, maxTokens: input.maxTokens }, price);
  const snapshot: BudgetSnapshot = {
    requestsDelta: estimated.requests,
    tokensInputDelta: estimated.tokensInput,
    tokensOutputDelta: estimated.tokensOutput,
    costDelta: estimated.cost,
  };
  await assertWithinBudget(db, input.userId, input.roles, period, snapshot, env.AI_BUDGET_MONTHLY_USD);

  // Per-run ceiling (agent tasks only, AI-INTEG-P3-T1). An ADDITIONAL guard on
  // top of the monthly budget above — it does NOT replace it. When a run budget
  // is bound to this async execution, the call's conservative estimate is
  // reserved atomically BEFORE the provider call, so two concurrent calls in one
  // run cannot both slip under the same remaining headroom: the second is refused
  // up front. Outside an agent run there is no budget, so every guard below is
  // skipped and behaviour is byte-for-byte unchanged.
  const runBudget = getAgentRunBudget();
  if (runBudget && !runBudget.reserve(estimated.cost)) {
    throw new AgentRunBudgetExceededError(runBudget.maxCostUsd!.toFixed(10), runBudget.spentUsd.toFixed(10));
  }

  // Outbound spend limits (AI-05). The reservation is atomic per limit, so
  // concurrent calls cannot both spend the same remaining headroom. A refusal is
  // NOT a platform failure: the free local engine answers instead, because a
  // vendor cap must never take the platform's safe fallback offline.
  let spendCtx = { environment, providerKey: provider.id, agentKey };
  let reservations: SpendReservation[] = [];
  let spendLimitBlocked: { scope: string; targetKey: string; period: string; reason: string } | null = null;
  if (!isFree) {
    const decision = await reserveSpend(db, spendCtx, estimated.cost);
    if (!decision.allowed) {
      if (input.allowLocalFallback === false) {
        throw ApiError.tooManyRequests(
          `AI spend limit reached for ${decision.blockedBy?.scope.toLowerCase()} ${decision.blockedBy?.targetKey || ''}`.trim(),
        );
      }
      spendLimitBlocked = decision.blockedBy ?? { scope: 'GLOBAL', targetKey: '', period: 'MONTHLY', reason: 'cost' };
      provider = new LocalHeuristicProvider();
      isFree = true;
      modelKey = 'local-heuristic';
      vendorModel = 'local-heuristic';
      price = await resolveModelPrice(db, modelKey);
      spendCtx = { environment, providerKey: provider.id, agentKey };
    } else {
      reservations = decision.reservations;
    }
  }

  // Attribute this request to the running agent task, if any. With a trusted run
  // context, `taskId`/`agentKey` come from it (never `input`), so a forged value
  // cannot attribute a request to another task/agent. With no context the
  // caller's metadata is kept as-is — EXCEPT the server-owned reconciliation key,
  // which is always stripped so a direct caller (e.g. `/api/ai/run`) can never
  // plant trusted-looking evidence for `reconcileTaskCostFromLedger`
  // (AI-INTEG-P3-G2). Every other key is preserved, so master behaviour is intact.
  const runCtx = getAgentRunContext();
  const requestMetadata = runCtx
    ? mergeAgentTaskMetadata(input.metadata, runCtx)
    : stripReservedAgentMetadata(input.metadata);

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
      signal: input.signal,
    });
  } catch (err) {
    // The call never produced a billable result, so release the reservation: the
    // run must not be charged for a call that did not complete.
    runBudget?.release(estimated.cost);
    await releaseSpend(db, reservations).catch((releaseErr) => {
      logger.error('Failed to release an AI spend reservation', { error: (releaseErr as Error).message });
    });
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
      providerKey: provider.id,
      vendorModel,
      agentKey,
      environment,
      // A failure bills nothing measurable: recorded as unknown, never as free.
      costSource: 'UNKNOWN',
      requestKey: input.requestKey ? `${input.requestKey}:failed` : null,
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

  // Settle the reservation to the measured cost (exactly once — the estimate is
  // REPLACED, never added on top). The provider call already happened, so the
  // money is spent whether or not the run stays within its ceiling: the cost is
  // always recorded, and the accumulator always moves to the true spend so a
  // later call can never be allowed on the strength of an unrecorded overshoot.
  const overBudget = runBudget ? !runBudget.settle(estimated.cost, actualCost) : false;

  // Record the measured cost. A failure here must NOT be swallowed: the provider
  // was already paid, so reporting success would leave the run accounted as
  // complete while its cost is missing from the ledger. The original database
  // error is preserved as the `cause` (never hidden behind a secondary error) and
  // surfaced as `AgentCostRecordingError`, which is retryable so a later attempt
  // re-enters this path with the correct spend.
  // A vendor that reports its own invoice is recorded as such; otherwise the
  // catalogue price times measured tokens is an ESTIMATE and says so.
  const costSource: CostSource = isFree ? 'FREE' : result.costSource === 'VENDOR' ? 'VENDOR' : 'ESTIMATED';

  // Move the reservation to the measured cost before recording it, so a later
  // call in the same period sees the true spend rather than the estimate.
  await settleSpend(db, spendCtx, reservations, actualCost).catch((settleErr) => {
    logger.error('Failed to settle an AI spend reservation', { error: (settleErr as Error).message });
  });

  let requestId: string;
  let duplicate = false;
  try {
    const recorded = await recordAiRequest(db, {
      userId: input.userId,
      requestType: input.requestType,
      model: result.model,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      cost: actualCost.toFixed(10),
      currencyCode: price.currencyCode,
      status: overBudget ? 'OVER_BUDGET' : 'SUCCESS',
      latencyMs,
      providerKey: provider.id,
      vendorModel: result.model || vendorModel,
      agentKey,
      environment,
      costSource,
      requestKey: input.requestKey ?? null,
      metadata: {
        ...requestMetadata,
        provider: provider.id,
        ...(spendLimitBlocked ? { spendLimitBlocked } : {}),
        ...(overBudget ? { runBudgetExceeded: true } : {}),
      },
    });
    requestId = recorded.id;
    duplicate = recorded.duplicate;
  } catch (err) {
    throw new AgentCostRecordingError(actualCost.toFixed(10), err instanceof Error ? err.message : String(err));
  }

  // A duplicate key means this exact call is already on the ledger: adding its
  // tokens and cost again would double-count a single request.
  if (!duplicate) {
    const window = currentPeriodWindow(period);
    await upsertAiUsage(db, input.userId, period, window, {
      requests: 1,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      cost: actualCost.toFixed(10),
      currencyCode: price.currencyCode,
    });
  }

  if (overBudget) {
    // Refuse the run only AFTER the full cost is on the ledger. The accumulator
    // was settled to the true (over-cap) spend, so any subsequent call is refused
    // up front too — the ceiling cannot be evaded by a retry. The measured call
    // cost rides on the error so the task's termination path can persist it to
    // `agent_tasks.cost` without re-deriving (or double-counting) the spend.
    throw new AgentRunBudgetExceededError(
      runBudget!.maxCostUsd!.toFixed(10),
      runBudget!.spentUsd.toFixed(10),
      actualCost.toFixed(10),
    );
  }

  return {
    content: result.content,
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cost: actualCost.toFixed(10),
    currencyCode: price.currencyCode,
    requestId,
    providerKey: provider.id,
    costSource,
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