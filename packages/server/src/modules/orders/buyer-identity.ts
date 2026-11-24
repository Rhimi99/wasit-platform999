import { and, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { companies, merchants, suppliers } from '../../db/schema/trade.js';

/**
 * How the buyer acts in this order. It is an identity claim, not a free label:
 * the server proves it against the entities the caller really owns before the
 * value reaches the order row (see {@link resolveBuyerIdentity}).
 */
export type BuyerType = 'CUSTOMER' | 'MERCHANT' | 'COMPANY';

export interface BuyerIdentity {
  buyerType: BuyerType;
  /** The caller's own company, for a COMPANY order. Never another company. */
  company: { id: string; legalName: string } | null;
}

/**
 * Resolves the buyer identity of an order from the caller's own records.
 *
 * The client's `buyerType` is a *request*, not a fact: this function decides
 * whether the caller may act in that capacity. A company order can only be
 * placed for the company the caller owns, and naming any other company is
 * refused outright — so editing the payload cannot produce an order in someone
 * else's name. CUSTOMER needs no entity (an individual purchase), which keeps
 * the existing buyer flow untouched.
 *
 * `MERCHANT` covers the business buyer: a merchant or a supplier entity the
 * caller owns. Both are real organisations buying goods, and the directory
 * surfaces already treat them as business buyers.
 */
export async function resolveBuyerIdentity(
  db: DB,
  input: { userId: string; buyerType: BuyerType; companyId?: string },
): Promise<BuyerIdentity> {
  if (input.companyId && input.buyerType !== 'COMPANY') {
    throw ApiError.validation([{
      field: 'companyId',
      message: 'companyId is only valid for a COMPANY order',
      code: 'BUYER_TYPE_CONFLICT',
    }]);
  }

  if (input.buyerType === 'CUSTOMER') {
    return { buyerType: 'CUSTOMER', company: null };
  }

  if (input.buyerType === 'MERCHANT') {
    const [merchant] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(and(eq(merchants.userId, input.userId), eq(merchants.isActive, true)))
      .limit(1);
    if (merchant) return { buyerType: 'MERCHANT', company: null };

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.userId, input.userId), eq(suppliers.isActive, true)))
      .limit(1);
    if (supplier) return { buyerType: 'MERCHANT', company: null };

    throw ApiError.forbidden('Your account has no active business profile to order as a business buyer');
  }

  const [company] = await db
    .select({ id: companies.id, legalName: companies.legalName, isActive: companies.isActive })
    .from(companies)
    .where(eq(companies.userId, input.userId))
    .limit(1);

  // One company per user (`companies_user_idx`), so owning none means the caller
  // cannot act as a company at all. Both refusals are deliberately the same
  // shape: they never confirm whether some other company id exists.
  if (!company) throw ApiError.forbidden('Your account is not linked to a company');
  if (!company.isActive) throw ApiError.forbidden('Your company profile is not active');

  if (input.companyId && input.companyId !== company.id) {
    throw ApiError.forbidden('You can only order for your own company');
  }

  return {
    buyerType: 'COMPANY',
    company: { id: company.id, legalName: company.legalName },
  };
}
