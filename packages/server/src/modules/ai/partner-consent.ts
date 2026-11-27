/**
 * B2B partner discovery consent (AI-FIRST-COMPLETION-04).
 *
 * Partner matching names other tenants, so it cannot be row-filtered without
 * disclosing them. The only lawful basis is the other tenant's own opt-in: a
 * tenant appears as a candidate only while it holds an active
 * `B2B_PARTNER_DISCOVERY` consent. The requester needs the same consent to ask.
 *
 * The `consents` table is hard-denied to every agent, so this snapshot is
 * resolved by the service layer (trusted, unscoped) at task creation and handed
 * to the executor as immutable input. An executor can therefore narrow the list
 * but can never widen it, and a caller cannot forge it: `createAgentTask` strips
 * any caller-supplied `__partnerConsent` before injecting this one.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { consents } from '../../db/schema/auth';
import { suppliers, merchants, companies } from '../../db/schema/trade';

export const B2B_PARTNER_CONSENT = 'B2B_PARTNER_DISCOVERY';

export interface PartnerConsentSnapshot {
  /** The consent type this snapshot was built from. */
  consentType: string;
  /** Whether the requester may receive partner suggestions. */
  requesterGranted: boolean;
  /** Seller entity ids whose owner opted in and may be suggested. */
  discoverableSellerIds: string[];
  /** How many distinct owners opted in (aggregate, no identities). */
  discoverableOwners: number;
}

export async function resolvePartnerConsent(db: DB, requesterId: string | null): Promise<PartnerConsentSnapshot> {
  const granted = await db
    .select({ userId: consents.userId })
    .from(consents)
    .where(and(eq(consents.consentType, B2B_PARTNER_CONSENT), eq(consents.granted, true)));

  const optedIn = granted.map((row) => row.userId);
  if (optedIn.length === 0) {
    return {
      consentType: B2B_PARTNER_CONSENT,
      requesterGranted: false,
      discoverableSellerIds: [],
      discoverableOwners: 0,
    };
  }

  const [supplierRows, merchantRows, companyRows] = await Promise.all([
    db.select({ id: suppliers.id, userId: suppliers.userId }).from(suppliers),
    db.select({ id: merchants.id, userId: merchants.userId }).from(merchants),
    db.select({ id: companies.id, userId: companies.userId }).from(companies),
  ]);
  const optedInSet = new Set(optedIn);
  const discoverableSellerIds = [...supplierRows, ...merchantRows, ...companyRows]
    .filter((row) => optedInSet.has(row.userId))
    .map((row) => row.id);

  return {
    consentType: B2B_PARTNER_CONSENT,
    requesterGranted: requesterId ? optedInSet.has(requesterId) : false,
    discoverableSellerIds,
    discoverableOwners: optedIn.length,
  };
}
