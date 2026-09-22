import type { UserRole } from '@wasit/shared';
import { count, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { DB } from '../../db/client';
import { aiModels } from '../../db/schema/ai';
import { ApiError } from '@wasit/shared';
import { resolveProvider, LocalHeuristicProvider } from './provider';
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
  /**
   * The model the vendor adapter must actually call. For catalogue keys such as
   * `openai-gpt-4o-mini` this is the vendor-facing name (`gpt-4o-mini`), so a
   * routed capability reaches the chosen model instead of the adapter default.
   */
  vendorModel: string;
}

/** Catalogue key → vendor-facing model name. Unknown keys pass through unchanged. */
const VENDOR_MODEL_NAMES: Record<string, string> = {
  'openai-gpt-4o-mini': 'gpt-4o-mini',
  'anthropic-claude-sonnet-4': 'claude-sonnet-4-20250514',
};

/**
 * Resolves a routable provider+model for a capability (task type).
 *
 * Precedence for the model key, highest first:
 *   1. an explicit caller request (`requestedModel`)
 *   2. the capability policy for `requestType`
 *   3. the deployment default (`AI_DEFAULT_MODEL`)
 *   4. the free local engine
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
    : (CAPABILITY_MODEL_POLICY[requestType] ?? env.AI_MODEL ?? env.AI_DEFAULT_MODEL ?? 'openai-gpt-4o-mini');

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
    return {
      modelKey: targetKey,
      providerId: targetProviderId,
      provider,
      price,
      vendorModel: VENDOR_MODEL_NAMES[targetKey] ?? targetKey,
    };
  }

  // Degrade to the deterministic local engine (free, real WASIT analytics).
  // Constructed directly so this branch is correct regardless of what
  // AI_PROVIDER points at when the configured vendor has no credentials.
  const local = new LocalHeuristicProvider();
  const price = await resolveModelPrice(db, 'local-heuristic');
  return {
    modelKey: 'local-heuristic',
    providerId: local.id,
    provider: local,
    price,
    vendorModel: 'local-heuristic',
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