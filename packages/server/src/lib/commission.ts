import { desc, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../db/client';
import { commissionPolicies } from '../db/schema/engine';
import { toDecimal, roundMoney } from './money';

export interface CommissionContext {
  accountType: 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY' | 'seller';
  b2bB2c: 'B2B' | 'B2C';
  transactionValue: string;
  currencyCode: string;
  countryCode?: string;
  sector?: string;
  productId?: string;
  subscriptionCode?: string;
  verificationLevel?: string;
  volume?: number;
}

/**
 * Commission amounts for a transaction, split between the parties.
 *
 * `totalAmount === sellerAmount + buyerAmount`, and each part is `itemsTotal x rate`
 * so the split always reconciles to the configured total. There is no fallback rate
 * anywhere in this file: every percentage comes from a stored policy.
 */
export interface CommissionBreakdown {
  policyId: string | null;
  policyName: string;
  totalRate: string;
  sellerRate: string;
  buyerRate: string;
  totalAmount: string;
  sellerAmount: string;
  buyerAmount: string;
  currencyCode: string;
}

function matchPolicy(
  policy: typeof commissionPolicies.$inferSelect,
  ctx: CommissionContext,
  value: ReturnType<typeof toDecimal>,
): boolean {
  const cond = (policy.conditions ?? {}) as Record<string, unknown> & {
    accountType?: string;
    b2bB2c?: string;
    minTransactionValue?: string;
    maxTransactionValue?: string;
    countryCode?: string;
    currency?: string;
    sector?: string;
    productId?: string;
    subscriptionCode?: string;
    verificationLevel?: string;
    minVolume?: number;
  };
  if (cond.accountType && cond.accountType !== ctx.accountType) return false;
  if (cond.b2bB2c && cond.b2bB2c !== ctx.b2bB2c) return false;
  if (cond.countryCode && cond.countryCode !== ctx.countryCode) return false;
  if (cond.currency && cond.currency !== ctx.currencyCode) return false;
  if (cond.sector && cond.sector !== ctx.sector) return false;
  if (cond.productId && cond.productId !== ctx.productId) return false;
  if (cond.subscriptionCode && cond.subscriptionCode !== ctx.subscriptionCode) return false;
  if (cond.verificationLevel && cond.verificationLevel !== ctx.verificationLevel) return false;
  if (cond.minTransactionValue && value.lt(cond.minTransactionValue)) return false;
  if (cond.maxTransactionValue && value.gt(cond.maxTransactionValue)) return false;
  if (cond.minVolume !== undefined && (ctx.volume ?? 0) < cond.minVolume) return false;
  const now = new Date();
  if (policy.startsAt && policy.startsAt > now) return false;
  if (policy.endsAt && policy.endsAt < now) return false;
  return true;
}

/**
 * The Commission Engine resolves the effective commission for a transaction by
 * evaluating configured policies in priority order (lowest number first) and
 * applying the first match.
 *
 * When no active policy matches, the engine fails closed with
 * COMMISSION_POLICY_MISSING (422). It never invents a rate: the only place a
 * percentage exists is the database policy an Admin configures.
 *
 * WASIT's base model is 4% of the transaction value (2% seller + 2% buyer);
 * payment-provider fees live in a separate policy (`payment_fee_policies`) and are
 * never mixed into commission.
 */
export async function resolveCommission(
  db: DB,
  ctx: CommissionContext,
): Promise<CommissionBreakdown> {
  const value = toDecimal(ctx.transactionValue);

  const allPolicies = await db
    .select()
    .from(commissionPolicies)
    .where(eq(commissionPolicies.isActive, true))
    .orderBy(desc(commissionPolicies.priority));

  const selected = allPolicies.find((p) => matchPolicy(p, ctx, value)) ?? null;
  if (!selected) {
    throw ApiError.commissionPolicyMissing(
      `No active commission policy matches accountType=${ctx.accountType} b2bB2c=${ctx.b2bB2c} currency=${ctx.currencyCode}`,
    );
  }

  const totalRate = toDecimal(selected.rate);
  const sellerRate = toDecimal(selected.sellerRate ?? '0');
  const buyerRate = selected.buyerRate !== null
    ? toDecimal(selected.buyerRate)
    : totalRate.minus(sellerRate);
  const effectiveBuyerRate = buyerRate.isNegative() ? toDecimal(0) : buyerRate;

  return {
    policyId: selected.id,
    policyName: selected.name,
    totalRate: totalRate.toString(),
    sellerRate: sellerRate.toString(),
    buyerRate: effectiveBuyerRate.toString(),
    totalAmount: roundMoney(value.mul(totalRate)).toFixed(4),
    sellerAmount: roundMoney(value.mul(sellerRate)).toFixed(4),
    buyerAmount: roundMoney(value.mul(effectiveBuyerRate)).toFixed(4),
    currencyCode: ctx.currencyCode,
  };
}

/**
 * Pure helper: compute the commission split for a given amount and explicit rates.
 * No rate is ever defaulted here — the caller supplies every percentage, so this
 * module carries no hidden financial constant.
 */
export function commissionSplitForAmount(
  amount: string,
  rates: { total: string; seller: string; buyer: string },
  currencyCode: string,
): { totalAmount: string; sellerAmount: string; buyerAmount: string; currencyCode: string } {
  const value = toDecimal(amount);
  return {
    totalAmount: roundMoney(value.mul(rates.total)).toFixed(4),
    sellerAmount: roundMoney(value.mul(rates.seller)).toFixed(4),
    buyerAmount: roundMoney(value.mul(rates.buyer)).toFixed(4),
    currencyCode,
  };
}

/**
 * Pure single-rate helper retained for callers that only need a total amount.
 * The rate is always passed in by the caller.
 */
export function commissionForAmount(
  amount: string,
  rate: string,
  currencyCode: string,
): { amount: string; rate: string; currencyCode: string } {
  const value = toDecimal(amount);
  const commission = roundMoney(value.mul(rate)).toFixed(4);
  return { amount: commission, rate, currencyCode };
}