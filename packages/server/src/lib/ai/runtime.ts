import Decimal from 'decimal.js';
import type { UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { aiModels } from '../../db/schema/ai';
import { eq } from 'drizzle-orm';
import { env } from '../env';
import type { AIFeatureResult } from './types';
import { resolveProvider, estimateTokens } from './provider';
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
  modelKey?: string;
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
 */
export async function runAIFeature(
  db: DB,
  input: RunFeatureInput,
): Promise<RunFeatureOutput> {
  const provider = resolveProvider();
  const modelKey = input.modelKey ?? env.AI_MODEL?.length ? env.AI_MODEL : 'local-heuristic';
  const price = await resolveModelPrice(db, modelKey);

  const period = 'MONTHLY';
  const estimated = estimateBudget({ system: input.system, user: input.user, maxTokens: input.maxTokens }, price);
  const snapshot: BudgetSnapshot = {
    requestsDelta: estimated.requests,
    tokensInputDelta: estimated.tokensInput,
    tokensOutputDelta: estimated.tokensOutput,
    costDelta: estimated.cost,
  };
  await assertWithinBudget(db, input.userId, input.roles, period, snapshot, env.AI_BUDGET_MONTHLY_USD);

  const started = Date.now();
  const result = await provider.call({
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens ?? 256,
    temperature: 0.2,
    budgetPeriod: period,
  });
  const latencyMs = Date.now() - started;

  // Exact cost from the measured tokens.
  const actualCost = price.inputPer1k.mul(result.tokensInput / 1000).plus(price.outputPer1k.mul(result.tokensOutput / 1000));

  const requestId = await recordAiRequest(db, {
    userId: input.userId,
    requestType: input.requestType,
    model: result.model,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cost: actualCost.toFixed(10),
    currencyCode: price.currencyCode,
    status: 'SUCCESS',
    latencyMs,
    metadata: input.metadata ?? undefined,
  });

  const window = currentPeriodWindow(period);
  await upsertAiUsage(db, input.userId, period, window, {
    requests: 1,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    cost: actualCost.toFixed(10),
    currencyCode: price.currencyCode,
  });

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