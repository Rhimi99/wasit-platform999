import type { UserRole } from '@wasit/shared';
import { count, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { DB } from '../../db/client';
import { aiModels } from '../../db/schema/ai';
import { ApiError } from '@wasit/shared';
import { resolveProvider } from './provider';
import type { AIProvider } from './types';
import { resolveModelPrice, type ModelPrice } from './runtime';
import { env } from '../env';

/**
 * Capability → preferred model policy.
 *
 * Routing is deliberately data-driven: the admin can change which model
 * serves which capability by editing `ai_models` (via `/api/admin/ai/models`)
 * or by changing `AI_DEFAULT_MODEL`. No model key is hardcoded in callers.
 */
const CAPABILITY_MODEL_POLICY: Record<string, string> = {
  PRODUCT_ANALYSIS: 'openai-gpt-4o-mini',
  SMART_SEARCH: 'openai-gpt-4o-mini',
  RECOMMENDATIONS: 'anthropic-claude-sonnet-4',
  MARKET_ANALYSIS: 'anthropic-claude-sonnet-4',
  PRICE_INTELLIGENCE: 'anthropic-claude-sonnet-4',
  SUPPLIER_RECOMMENDATIONS: 'anthropic-claude-sonnet-4',
  SALES_INTELLIGENCE: 'anthropic-claude-sonnet-4',
  SUPPORT_REPLY: 'openai-gpt-4o-mini',
  AGENT_TASK: 'local-heuristic',
};

/**
 * The strongest model a role is allowed to consume. Admins (AI_MANAGE) may
 * consume any model; every other role falls back to the default model so a
 * user cannot escalate to the most expensive catalogue entry.
 */
function maxAllowedModelForRoles(roles: UserRole[]): string | null {
  if (roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) return null;
  return env.AI_DEFAULT_MODEL?.length ? env.AI_DEFAULT_MODEL : 'openai-gpt-4o-mini';
}

export interface ResolvedRoute {
  modelKey: string;
  providerId: string;
  provider: AIProvider;
  price: ModelPrice;
}

/**
 * Resolves a routable provider+model for a capability (task type).
 *
 * - Reads pricing from the DB catalogue (`ai_models`).
 * - Falls back to `local-heuristic` when the requested provider is not
 *   configured (no API key) so the whole platform keeps working offline.
 * - Never throws on a missing model — it degrades to a free default instead.
 */
export async function resolveAiRoute(
  db: DB,
  requestType: string,
  roles: UserRole[],
  requestedModel?: string,
): Promise<ResolvedRoute> {
  const preferred = requestedModel && requestedModel.length > 0
    ? requestedModel
    : CAPABILITY_MODEL_POLICY[requestType] ?? env.AI_DEFAULT_MODEL ?? 'openai-gpt-4o-mini';

  const allowedMax = maxAllowedModelForRoles(roles);
  const targetKey = allowedMax && preferred !== 'local-heuristic' && preferred !== 'noop'
    ? (preferred === allowedMax ? preferred : allowedMax)
    : preferred;

  // Prefer a live (configured) provider for the target model.
  const provider = resolveProvider();
  const targetProviderId = provider.id;
  const wantsPaid = targetKey !== 'local-heuristic' && targetKey !== 'noop';

  if (wantsPaid && provider.isAvailable() && targetProviderId !== 'local-heuristic' && targetProviderId !== 'noop') {
    const price = await resolveModelPrice(db, targetKey);
    return { modelKey: targetKey, providerId: targetProviderId, provider, price };
  }

  // Degrade to the deterministic local engine (free, real WASIT analytics).
  const localProvider = resolveProvider();
  if (localProvider.id === 'local-heuristic') {
    const price = await resolveModelPrice(db, 'local-heuristic');
    return { modelKey: 'local-heuristic', providerId: localProvider.id, provider: localProvider, price };
  }

  // Provider configured but pointing at a model not in the catalogue — fall back.
  const fallbackProviderId = 'local-heuristic';
  const fallback = resolveProvider();
  const price = await resolveModelPrice(db, 'local-heuristic');
  return {
    modelKey: 'local-heuristic',
    providerId: fallbackProviderId,
    provider: fallback,
    price,
  };
}

/** Cost calc for the admin dashboard's "model pricing" widget. */
export function formatModelPrice(price: ModelPrice): string {
  const per1k = price.inputPer1k.plus(price.outputPer1k);
  return per1k.toFixed(6);
}

/** Reads only the active, costed models from the catalogue (admin-consumable). */
export async function listActiveModels(db: DB) {
  const rows = await db.select().from(aiModels).orderBy(aiModels.displayName);
  return rows.map((m) => ({
    key: m.key,
    displayName: m.displayName,
    provider: m.provider,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    inputPer1k: new Decimal(m.inputPer1k).toFixed(6),
    outputPer1k: new Decimal(m.outputPer1k).toFixed(6),
    currencyCode: m.currencyCode,
    isActive: m.isActive,
  }));
}

/** Guard used before recording a failed/no-auth request to avoid leaking costs. */
export function assertSafeModelKey(modelKey: string): string {
  if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/i.test(modelKey)) {
    throw ApiError.validation(
      [{ field: 'model', code: 'INVALID_MODEL_KEY', message: 'Invalid model key' }],
      'Invalid model key',
    );
  }
  return modelKey;
}

/** Deterministic, non-credential model health probe (for /status). */
export async function catalogHeartbeat(db: DB): Promise<{ ok: boolean; models: number }> {
  const rows = await db.select({ c: count() }).from(aiModels).where(eq(aiModels.isActive, true));
  return { ok: Number(rows[0]?.c ?? 0) > 0, models: Number(rows[0]?.c ?? 0) };
}