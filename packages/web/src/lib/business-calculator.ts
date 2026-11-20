/**
 * PR-05 — business margin/commission calculator (pure, framework-free).
 *
 * Mirrors the platform's order money model so the numbers a seller sees here
 * match what an order actually produces:
 *   - seller commission is charged on the seller's items subtotal,
 *   - the buyer pays the items subtotal plus their own commission share,
 *   - the payment-processing fee is charged to the seller on top of the
 *     commission (it is never part of the buyer's total),
 *   - `sellerNet` = subtotal − seller commission − payment fee,
 *   - `buyerTotal` = subtotal + buyer commission.
 *
 * The default rates are the platform's documented BASE policy (4% total
 * commission split 2% seller / 2% buyer, 2% payment fee). They are surfaced as
 * editable inputs and labelled as defaults — the calculator never claims to be
 * the live policy, which lives in `commission_policies`/`payment_fee_policies`.
 */

export interface CalculatorRates {
  /** Seller-side commission, in percent of the items subtotal. */
  sellerCommissionRate: number;
  /** Buyer-side commission, in percent of the items subtotal. */
  buyerCommissionRate: number;
  /** Payment-processing fee, in percent of the items subtotal. */
  paymentFeeRate: number;
  /** Payment-processing flat fee, in the order currency. */
  paymentFeeFlat: number;
}

/** Platform BASE defaults (see `AGENTS.md` §رسوم مالية). */
export const DEFAULT_RATES: CalculatorRates = {
  sellerCommissionRate: 2,
  buyerCommissionRate: 2,
  paymentFeeRate: 2,
  paymentFeeFlat: 0,
};

export interface CalculatorResult {
  /** Unit price × quantity. */
  itemsTotal: number;
  sellerCommission: number;
  buyerCommission: number;
  paymentFee: number;
  /** What the buyer pays: itemsTotal + buyerCommission. */
  buyerTotal: number;
  /** What the seller receives: itemsTotal − sellerCommission − paymentFee. */
  sellerNet: number;
  /** WASIT's gross take: both commission sides + payment fee. */
  wasitGross: number;
  /** wasitGross as a share of buyerTotal, in percent. */
  effectiveRate: number;
}

/** Rounds to 4 decimal places, half-up — the platform's money precision. */
export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Computes the breakdown for a single line. Returns `null` for input that cannot
 * describe a real order (non-positive price/quantity, non-integer quantity, a
 * negative rate, or a fee that would drive the seller's net below zero).
 */
export function computeBusiness(
  pricePerUnit: number,
  quantity: number,
  rates: CalculatorRates = DEFAULT_RATES,
): CalculatorResult | null {
  if (!isPositiveFinite(pricePerUnit) || !Number.isInteger(quantity) || quantity <= 0) return null;
  if (
    rates.sellerCommissionRate < 0 ||
    rates.buyerCommissionRate < 0 ||
    rates.paymentFeeRate < 0 ||
    rates.paymentFeeFlat < 0 ||
    !Number.isFinite(rates.sellerCommissionRate) ||
    !Number.isFinite(rates.buyerCommissionRate) ||
    !Number.isFinite(rates.paymentFeeRate) ||
    !Number.isFinite(rates.paymentFeeFlat)
  ) {
    return null;
  }

  const itemsTotal = round4(pricePerUnit * quantity);
  const sellerCommission = round4((itemsTotal * rates.sellerCommissionRate) / 100);
  const buyerCommission = round4((itemsTotal * rates.buyerCommissionRate) / 100);
  const paymentFee = round4((itemsTotal * rates.paymentFeeRate) / 100 + rates.paymentFeeFlat);
  const buyerTotal = round4(itemsTotal + buyerCommission);
  const sellerNet = round4(itemsTotal - sellerCommission - paymentFee);
  const wasitGross = round4(sellerCommission + buyerCommission + paymentFee);

  // A fee/commission set that leaves the seller with nothing is not a usable
  // quote — reject it rather than print a negative payout.
  if (sellerNet < 0) return null;

  const effectiveRate = buyerTotal > 0 ? round4((wasitGross / buyerTotal) * 100) : 0;

  return { itemsTotal, sellerCommission, buyerCommission, paymentFee, buyerTotal, sellerNet, wasitGross, effectiveRate };
}
