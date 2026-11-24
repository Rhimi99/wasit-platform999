import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { companies } from '../../db/schema/trade';
import { consents } from '../../db/schema/auth';
import { rfqRecipients, rfqs, type rfqQuotes } from '../../db/schema/rfq';
import { resolveOwnedSellerIds } from '../../lib/seller-ownership';
import { RFQ_PARTICIPATION_CONSENT } from '../../lib/consent-types';

export type RfqRow = typeof rfqs.$inferSelect;
export type RfqRecipientRow = typeof rfqRecipients.$inferSelect;
export type RfqQuoteRow = typeof rfqQuotes.$inferSelect;

/** Which side of the negotiation the caller is on. There is no third side. */
export type RfqActorRole = 'BUYER' | 'SELLER';

export interface RfqAccess {
  rfq: RfqRow;
  role: RfqActorRole;
  /** Set only for a seller: the invitation that proves the participation. */
  recipient: RfqRecipientRow | null;
  /** Set only for a seller: the entity id the caller is acting as. */
  sellerId: string | null;
  /** Every seller entity the caller owns (used to scope seller-side lists). */
  ownedSellerIds: string[];
}

export interface OwnedCompany {
  id: string;
  legalName: string;
  slug: string;
  verified: boolean;
}

export interface SellerEntity {
  id: string;
  sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  name: string;
  userId: string;
  isActive: boolean;
}

/**
 * The single place that decides whether a user may touch an RFQ.
 *
 * Rules, in order:
 *  - a buyer is the owning company's user (`buyer_user_id`), nothing else;
 *  - a seller must own the invited entity *and* still hold the RFQ participation
 *    consent — revoking the consent withdraws the access, it does not just hide
 *    the record from a list;
 *  - everyone else gets 404, not 403: a non-participant must not learn that the
 *    RFQ exists.
 *
 * Staff have no path here on purpose. RFQ content is commercial, and the only
 * read permission (`rfq:read:own`) is a participant permission.
 */
export async function assertRfqAccess(db: DB, rfqId: string, userId: string): Promise<RfqAccess> {
  const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId)).limit(1);
  if (!rfq) throw ApiError.notFound('RFQ');

  if (rfq.buyerUserId === userId) {
    return { rfq, role: 'BUYER', recipient: null, sellerId: null, ownedSellerIds: [] };
  }

  const ownedSellerIds = await resolveOwnedSellerIds(db, userId);
  if (ownedSellerIds.length > 0) {
    const [recipient] = await db
      .select()
      .from(rfqRecipients)
      .where(and(eq(rfqRecipients.rfqId, rfqId), inArray(rfqRecipients.sellerId, ownedSellerIds)))
      .limit(1);
    if (recipient) {
      // Consent is re-checked on every access, and against the caller — consent
      // belongs to the person acting, not to the entity row, so a change of
      // ownership can never hand an unconsenting owner the previous owner's access.
      if (!(await hasRfqParticipation(db, userId))) {
        throw ApiError.notFound('RFQ');
      }
      return {
        rfq,
        role: 'SELLER',
        recipient,
        sellerId: recipient.sellerId,
        ownedSellerIds,
      };
    }
  }

  throw ApiError.notFound('RFQ');
}

/** Buyer-only actions: send, cancel, and (phase 2) accept or reject a quote. */
export function requireBuyer(access: RfqAccess): RfqAccess {
  if (access.role !== 'BUYER') {
    throw ApiError.forbidden('Only the requesting company may perform this action');
  }
  return access;
}

/** Seller-only actions: submit a quote, revise it, decline or withdraw. */
export function requireSeller(access: RfqAccess): RfqAccess {
  if (access.role !== 'SELLER') {
    throw ApiError.forbidden('Only an invited seller may perform this action');
  }
  return access;
}

/** The company the caller acts for. One user owns at most one company. */
export async function resolveOwnedCompany(db: DB, userId: string): Promise<OwnedCompany | null> {
  const [row] = await db
    .select({
      id: companies.id,
      legalName: companies.legalName,
      slug: companies.slug,
      verified: companies.verified,
    })
    .from(companies)
    .where(and(eq(companies.userId, userId), eq(companies.isActive, true)))
    .limit(1);
  return row ?? null;
}

export async function requireOwnedCompany(db: DB, userId: string): Promise<OwnedCompany> {
  const company = await resolveOwnedCompany(db, userId);
  if (!company) {
    throw ApiError.forbidden('An active company profile is required to request quotations');
  }
  return company;
}

/**
 * Resolves seller entities by id, with the owning user and display name, in one
 * query. Used when sending (to verify each invitee and its consent) and when
 * projecting names into the buyer's view — never to expose a user id.
 */
export async function resolveSellerEntities(db: DB, sellerIds: string[]): Promise<SellerEntity[]> {
  if (sellerIds.length === 0) return [];
  const rows = await db.execute<{
    id: string;
    seller_type: string;
    name: string;
    user_id: string;
    is_active: boolean;
  }>(sql`
    select id, seller_type, name, user_id, is_active from (
      select id, 'SUPPLIER' as seller_type, company_name as name, user_id, is_active from suppliers
      union all
      select id, 'MERCHANT' as seller_type, store_name as name, user_id, is_active from merchants
      union all
      select id, 'COMPANY' as seller_type, legal_name as name, user_id, is_active from companies
    ) owned where id in (${sql.join(sellerIds.map((id) => sql`${id}`), sql`, `)})
  `);
  return (rows as unknown as {
    rows: { id: string; seller_type: string; name: string; user_id: string; is_active: boolean }[];
  }).rows.map((r) => ({
    id: r.id,
    sellerType: r.seller_type as SellerEntity['sellerType'],
    name: r.name,
    userId: r.user_id,
    isActive: r.is_active,
  }));
}

/** True when the user currently holds the RFQ participation consent. */
export async function hasRfqParticipation(db: DB, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ granted: consents.granted })
    .from(consents)
    .where(and(eq(consents.userId, userId), eq(consents.consentType, RFQ_PARTICIPATION_CONSENT)))
    .limit(1);
  return row?.granted === true;
}

