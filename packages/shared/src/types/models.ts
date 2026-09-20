import type { UserRole } from '../constants/roles';
import type {
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  SettlementStatus,
  SubscriptionStatus,
  ProductStatus,
  VerificationLevel,
  VerificationRequestStatus,
  DisputeStatus,
  DisputeDecision,
  CampaignStatus,
  TrustLevel,
  RiskLevel,
} from '../constants/statuses';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  phone?: string | null;
  phoneVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
  passwordHash: string;
  isActive: boolean;
  isLocked: boolean;
  locale: string;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
}

export interface UserWithRoles extends User {
  roles: UserRole[];
}

export interface Profile {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  countryId?: string | null;
  cityId?: string | null;
  defaultCurrencyId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Country {
  id: string;
  code: string;
  name: string;
  iso3?: string | null;
  phonePrefix: string;
  currencyCode: string;
  defaultLanguage: string;
  isActive: boolean;
  activateAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Region {
  id: string;
  countryId: string;
  name: string;
  code?: string | null;
  isActive: boolean;
}

export interface City {
  id: string;
  regionId: string;
  name: string;
  isActive: boolean;
}

export interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  isActive: boolean;
}

export interface Category {
  id: string;
  parentId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  icon?: string | null;
  isActive: boolean;
  sortOrder: number;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  sellerId: string;
  sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  categoryId: string;
  name: string;
  slug: string;
  description?: string | null;
  brand?: string | null;
  sku: string;
  barcode?: string | null;
  countryId?: string | null;
  currencyCode: string;
  basePrice: string;
  moq: number;
  unit: string;
  status: ProductStatus;
  isPublished: boolean;
  tags?: string[] | null;
  specifications?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductVariant {
  id: string;
  productId: string;
  name: string;
  sku: string;
  price: string;
  attributes: Record<string, unknown>;
  isActive: boolean;
}

export interface ProductImage {
  id: string;
  productId: string;
  url: string;
  altText?: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

export interface Supplier {
  id: string;
  userId: string;
  companyName: string;
  slug: string;
  countryId?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Merchant {
  id: string;
  userId: string;
  storeName: string;
  slug: string;
  countryId?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyProfile {
  id: string;
  userId: string;
  legalName: string;
  slug: string;
  registrationNumber?: string | null;
  countryId?: string | null;
  industry?: string | null;
  verified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: string;
  orderNumber: string;
  buyerId: string;
  buyerType: 'CUSTOMER' | 'MERCHANT' | 'COMPANY';
  sellerId: string;
  sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  currencyCode: string;
  itemsTotal: string;
  commission: string;
  paymentFee: string;
  grandTotal: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  refundStatus: RefundStatus;
  settlementStatus: SettlementStatus;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productVariantId?: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

export interface Transaction {
  id: string;
  transactionNumber: string;
  orderId?: string | null;
  buyerId: string;
  sellerId: string;
  productId?: string | null;
  quantity?: number | null;
  unitPrice?: string | null;
  totalValue: string;
  currencyCode: string;
  commission: string;
  paymentFee: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  entryType: 'TRANSACTION_VALUE' | 'COMMISSION' | 'PAYMENT_FEE' | 'REFUND' | 'SETTLEMENT';
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  currencyCode: string;
  payerId?: string | null;
  beneficiaryId?: string | null;
  paymentProvider?: string | null;
  status: SettlementStatus;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface InventoryItem {
  id: string;
  productId: string;
  productVariantId?: string | null;
  merchantId: string;
  quantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryMovement {
  id: string;
  inventoryItemId: string;
  movementType: 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION' | 'RELEASE';
  quantityChange: number;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  createdById: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  body: string;
  readAt?: Date | null;
  createdAt: Date;
}

export interface Thread {
  id: string;
  participantIds: string[];
  subject?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  readAt?: Date | null;
  createdAt: Date;
}

export interface VerificationRequest {
  id: string;
  userId: string;
  targetLevel: VerificationLevel;
  status: VerificationRequestStatus;
  documentType?: string | null;
  documentRef?: string | null;
  reviewedById?: string | null;
  reviewNotes?: string | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrustScore {
  id: string;
  userId: string;
  score: number;
  level: TrustLevel;
  factors: Record<string, unknown>;
  summary: string;
  effectiveAt: Date;
  createdAt: Date;
}

export interface RiskEvent {
  id: string;
  userId: string;
  eventType: string;
  severity: RiskLevel;
  riskScore: number;
  reasonCode: string;
  recommendedAction?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface Dispute {
  id: string;
  disputeNumber: string;
  orderId: string;
  openedById: string;
  reasonCode: string;
  description: string;
  status: DisputeStatus;
  decision?: DisputeDecision | null;
  decisionNote?: string | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DisputeMessage {
  id: string;
  disputeId: string;
  senderId: string;
  body: string;
  isEvidence: boolean;
  createdAt: Date;
}

export interface Campaign {
  id: string;
  advertiserId: string;
  advertiserType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  title: string;
  objective: 'PRODUCT_ADS' | 'STORE_ADS' | 'SUPPLIER_ADS' | 'COMPANY_ADS' | 'B2B_ADS' | 'B2C_ADS' | 'TOP_ADS' | 'SPONSORED_SEARCH';
  status: CampaignStatus;
  budget: string;
  currencyCode: string;
  startsAt: Date;
  endsAt: Date;
  targeting?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdEvent {
  id: string;
  campaignId: string;
  eventType: 'IMPRESSION' | 'CLICK' | 'CONVERSION';
  adType: string;
  userId?: string | null;
  createdAt: Date;
}

export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}