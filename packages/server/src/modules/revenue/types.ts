// Revenue & Profitability — API response types.
// All monetary values are returned as strings (decimal), matching the project's
// convention for numeric(..) columns transported over JSON.

export interface RevenueSourceBreakdown {
  commission: string;
  subscriptionRevenue: string;
  advertisingRevenue: string;
  otherRevenue: string;
}

export interface RevenueCostBreakdown {
  paymentFees: string;
  aiModelCosts: string;
  refunds: string;
  operationalExpenses: string;
  otherCosts: string;
}

export interface RevenueProfitabilityReport {
  currencyCode: string;
  // --- Revenue ---
  grossRevenue: string;
  commission: string;
  subscriptionRevenue: string;
  advertisingRevenue: string;
  otherRevenue: string;
  // --- Costs ---
  totalCosts: string;
  paymentFees: string;
  aiModelCosts: string;
  refunds: string;
  operationalExpenses: string;
  otherCosts: string;
  // --- Net ---
  netRevenue: string;
  contributionMargin: string;
  // --- Context / auditability ---
  basedOn: string[]; // real tables that were aggregated from
}

export interface ScenarioInput {
  // All inputs are explicit (no invented data). Values are checked against real
  // aggregates when available, otherwise they describe a user-supplied plan.
  transactionVolume: string; // total GMV in currency
  commissionRate: string; // decimal percent, e.g. '4' = 4% (current BASE total)
  paymentFeeRate: string; // decimal, e.g. '1.25' = 1.25%
  expectedOrders: string;
  avgOrderValue: string;
  subscriptionRevenue: string;
  advertisingRevenue: string;
  aiCosts: string;
  operationalExpenses: string;
  refundRate: string; // decimal, e.g. '0.5' = 0.5%
  currencyCode: string;
}

export interface ScenarioResult {
  outputId: string;
  grossRevenue: string;
  totalCosts: string;
  netRevenue: string;
  contributionMargin: string;
  comment: string;
}