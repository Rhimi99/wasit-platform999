import type { planTargetEnum, subscriptionStatusEnum } from '../../db/schema/subscriptions.js';

export type PlanTarget = (typeof planTargetEnum.enumValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];

export interface SubscriptionPlanView {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  planTarget: PlanTarget;
  priceMonthly: string;
  priceYearly: string;
  currencyCode: string;
  features: Record<string, unknown> | null;
  limits: Record<string, unknown> | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export interface MySubscriptionView {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  planNameAr: string | null;
  planNameFr: string | null;
  status: SubscriptionStatus;
  billingCycle: string;
  autoRenew: boolean;
  startsAt: string | null;
  endsAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSubscriptionView {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  planCode: string;
  planName: string;
  status: string;
  billingCycle: string;
  autoRenew: boolean;
  startsAt: string | null;
  endsAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface AdminInvoiceView {
  id: string;
  subscriptionId: string;
  userId: string | null;
  userEmail: string | null;
  invoiceNumber: string;
  amount: string;
  currencyCode: string;
  status: string;
  externalRef: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InvoiceView {
  id: string;
  subscriptionId: string;
  invoiceNumber: string;
  amount: string;
  currencyCode: string;
  status: string;
  externalRef: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
}