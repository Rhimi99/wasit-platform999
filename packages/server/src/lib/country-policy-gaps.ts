import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { countryPolicyGaps } from '../db/schema/engine';
import { newId } from './ids';

/**
 * Records a country-level business rule that is still unconfigured.
 *
 * The engine must never invent country-specific law, durations or procedures.
 * When a country is active but only the global policy applies, we register the
 * gap as DECISION_REQUIRED so Admin/legal can supply the real value; the dispute
 * itself continues under the global fallback. Idempotent per (country, scope, code).
 */
export async function recordCountryPolicyGap(
  db: DB,
  input: {
    countryId: string;
    scope: 'DISPUTE' | 'COMMISSION' | 'VERIFICATION' | 'RISK' | 'ADVERTISING' | 'SUBSCRIPTION' | 'COUNTRY' | 'CATEGORY' | 'LIMITS' | 'TRADE' | 'PRIVACY' | 'TAX';
    code: string;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select()
    .from(countryPolicyGaps)
    .where(
      and(
        eq(countryPolicyGaps.countryId, input.countryId),
        eq(countryPolicyGaps.scope, input.scope),
        eq(countryPolicyGaps.code, input.code),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.status === 'DECISION_REQUIRED') return { id: existing.id, created: false };
    // A rule was configured and later removed — reopen the gap.
    await db
      .update(countryPolicyGaps)
      .set({ status: 'DECISION_REQUIRED', resolvedAt: null, reason: input.reason, detectedAt: new Date() })
      .where(eq(countryPolicyGaps.id, existing.id));
    return { id: existing.id, created: false };
  }

  const id = newId();
  await db.insert(countryPolicyGaps).values({
    id,
    countryId: input.countryId,
    scope: input.scope,
    code: input.code,
    status: 'DECISION_REQUIRED',
    reason: input.reason,
    metadata: input.metadata ?? null,
  });
  return { id, created: true };
}

/** Marks a previously recorded gap as resolved once a country rule exists. */
export async function resolveCountryPolicyGap(
  db: DB,
  input: { countryId: string; scope: 'DISPUTE' | 'COMMISSION' | 'VERIFICATION' | 'RISK' | 'ADVERTISING' | 'SUBSCRIPTION' | 'COUNTRY' | 'CATEGORY' | 'LIMITS' | 'TRADE' | 'PRIVACY' | 'TAX'; code: string },
): Promise<void> {
  await db
    .update(countryPolicyGaps)
    .set({ status: 'RESOLVED', resolvedAt: new Date() })
    .where(
      and(
        eq(countryPolicyGaps.countryId, input.countryId),
        eq(countryPolicyGaps.scope, input.scope),
        eq(countryPolicyGaps.code, input.code),
        eq(countryPolicyGaps.status, 'DECISION_REQUIRED'),
      ),
    );
}