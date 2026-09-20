export const ORDER_STATUS = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const PAYMENT_STATUS = [
  'UNPAID',
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const REFUND_STATUS = [
  'NONE',
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PROCESSING',
  'COMPLETED',
] as const;
export type RefundStatus = (typeof REFUND_STATUS)[number];

export const SETTLEMENT_STATUS = [
  'PENDING',
  'PROCESSING',
  'SETTLED',
  'HELD',
  'FAILED',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[number];

export const SUBSCRIPTION_STATUS = [
  'ACTIVE',
  'TRIAL',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export const PRODUCT_STATUS = [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
  'SUSPENDED',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[number];

export const VERIFICATION_LEVEL = [
  'NONE',
  'BASIC',
  'VERIFIED',
  'BUSINESS_VERIFIED',
  'INTERNATIONAL_VERIFIED',
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVEL)[number];

export const VERIFICATION_STATUS = [
  'PENDING',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
] as const;
export type VerificationRequestStatus = (typeof VERIFICATION_STATUS)[number];

export const DISPUTE_STATUS = [
  'OPEN',
  'UNDER_REVIEW',
  'REQUESTED_FURTHER_EVIDENCE',
  'ESCALATED',
  'DECIDED',
  'CLOSED',
  'ARCHIVED',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUS)[number];

export const DISPUTE_DECISION = ['NONE', 'IN_FAVOR_OF_BUYER', 'IN_FAVOR_OF_SELLER', 'SPLIT', 'REJECTED'] as const;
export type DisputeDecision = (typeof DISPUTE_DECISION)[number];

export const CAMPAIGN_STATUS = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

export const RFC_STATUS = [
  'ACTIVE',
  'ON_HOLD',
  'CLOSED',
  'SUSPENDED',
] as const;
export type RfcStatus = (typeof RFC_STATUS)[number];

export const TRUST_LEVEL = ['LOW', 'BASIC', 'GOOD', 'EXCELLENT'] as const;
export type TrustLevel = (typeof TRUST_LEVEL)[number];

export const RISK_LEVEL = ['LOW', 'MEDIUM', 'HIGH', 'SEVERE'] as const;
export type RiskLevel = (typeof RISK_LEVEL)[number];

export const ROLES = [
  'CUSTOMER',
  'MERCHANT',
  'SUPPLIER',
  'COMPANY',
  'MARKETER',
] as const;
export type CommerceRole = (typeof ROLES)[number];