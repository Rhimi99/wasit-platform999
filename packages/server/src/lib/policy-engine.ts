import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/client';
import { policies } from '../db/schema/engine';
import { newId } from './ids';

/**
 * Resolves a scoped policy with the most-specific-wins layering:
 *
 *   country row (code + countryId)  →  global row (code, countryId null)
 *
 * The spec requires country rules to live in the Policy Engine and be read from
 * the database, never branched on a hardcoded country code. A missing country
 * row is therefore a *configuration gap*, not a reason to invent a rule: the
 * caller receives the global fallback plus `source: 'GLOBAL'` so it can record
 * a DECISION_REQUIRED entry.
 */
export interface PolicyScope {
  scope: (typeof policies.$inferSelect)['scope'];
  code: string;
  countryId?: string | null;
}

export type PolicySource = 'COUNTRY' | 'GLOBAL';

export interface ResolvedPolicy {
  rules: Record<string, unknown>;
  policyId: string | null;
  policyName: string | null;
  version: number | null;
  /** Which layer supplied the rules. */
  source: PolicySource;
  /** True when a country was requested but only the global row existed. */
  countryOverrideMissing: boolean;
}

/** Rows are picked deterministically: newest active version wins. */
function rowOrder() {
  return [desc(policies.version), desc(policies.createdAt)] as const;
}

export async function resolvePolicy(db: DB, input: PolicyScope): Promise<ResolvedPolicy> {
  const { scope, code, countryId } = input;
  const base = and(eq(policies.scope, scope), eq(policies.code, code), eq(policies.isActive, true));

  if (countryId) {
    const [countryRow] = await db
      .select()
      .from(policies)
      .where(and(base, eq(policies.countryId, countryId)))
      .orderBy(...rowOrder())
      .limit(1);
    if (countryRow) {
      return {
        rules: (countryRow.rules ?? {}) as Record<string, unknown>,
        policyId: countryRow.id,
        policyName: countryRow.name,
        version: countryRow.version,
        source: 'COUNTRY',
        countryOverrideMissing: false,
      };
    }
  }

  const [globalRow] = await db
    .select()
    .from(policies)
    .where(and(base, isNull(policies.countryId)))
    .orderBy(...rowOrder())
    .limit(1);

  return {
    rules: (globalRow?.rules ?? {}) as Record<string, unknown>,
    policyId: globalRow?.id ?? null,
    policyName: globalRow?.name ?? null,
    version: globalRow?.version ?? null,
    source: 'GLOBAL',
    countryOverrideMissing: Boolean(countryId),
  };
}

/**
 * Merges a country override on top of the global rules, so a country may tune
 * only the fields it needs while inheriting everything else. Undefined/null
 * country values never wipe a global value.
 */
export async function resolveMergedPolicy(
  db: DB,
  input: PolicyScope,
): Promise<ResolvedPolicy & { globalRules: Record<string, unknown> }> {
  const global = await resolvePolicy(db, { ...input, countryId: null });
  if (!input.countryId) return { ...global, globalRules: global.rules };

  const scoped = await resolvePolicy(db, input);
  if (scoped.source !== 'COUNTRY') {
    // A country was requested but no override exists — keep the flag true so the
    // caller can register the configuration gap while using the global rules.
    return { ...global, countryOverrideMissing: true, globalRules: global.rules };
  }

  const merged: Record<string, unknown> = { ...global.rules };
  for (const [k, v] of Object.entries(scoped.rules)) {
    if (v !== undefined && v !== null) merged[k] = v;
  }
  return { ...scoped, rules: merged, globalRules: global.rules };
}

/** Creates or updates the country-scoped override for a policy code. */
export async function upsertCountryPolicy(
  db: DB,
  input: {
    scope: (typeof policies.$inferSelect)['scope'];
    code: string;
    countryId: string;
    name: string;
    description?: string | null;
    rules: Record<string, unknown>;
    actorId: string;
  },
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.scope, input.scope), eq(policies.code, input.code), eq(policies.countryId, input.countryId)))
    .limit(1);

  if (existing) {
    await db
      .update(policies)
      .set({
        rules: input.rules,
        name: input.name,
        description: input.description ?? existing.description,
        version: existing.version + 1,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(policies.id, existing.id));
    return { id: existing.id, created: false };
  }

  const id = newId();
  await db
    .insert(policies)
    .values({
      id,
      scope: input.scope,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      rules: input.rules,
      countryId: input.countryId,
      createdById: input.actorId,
      isActive: true,
      version: 1,
    });
  return { id, created: true };
}