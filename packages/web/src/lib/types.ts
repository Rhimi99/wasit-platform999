// أنواع مشتركة للواجهة تعكس عقود الـ API الحقيقية للخادم

export type UserRole = 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY' | 'MARKETER' | 'SUPPORT' | 'RISK' | 'DISPUTE' | 'ADMIN' | 'SUPER_ADMIN';

export const USER_ROLES: UserRole[] = [
  'CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER',
  'SUPPORT', 'RISK', 'DISPUTE', 'ADMIN', 'SUPER_ADMIN',
];

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  isActive: boolean;
  roles: UserRole[];
}

/** Login either returns a User or, when MFA is enabled, a pending challenge. */
export type LoginResponse =
  | (User & { mfaRequired: false })
  | { mfaRequired: true; challengeToken: string; expiresAt: string };

export interface MfaStatus {
  mfaEnabled: boolean;
  pendingEnrollment: boolean;
}

export interface MfaEnrollment {
  secretBase32: string;
  qrUri: string;
  recoveryCodes: string[];
}

export interface FieldError {
  field: string;
  message: string;
  code: string;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  statusCode?: number;
  fieldErrors?: FieldError[];
  traceId?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorShape;
}

export interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
}

export type SellerType = 'MERCHANT' | 'SUPPLIER' | 'COMPANY';

export interface ProductSummary {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  slug: string;
  brand: string | null;
  sku: string;
  basePrice: string;
  currencyCode: string;
  moq: number | null;
  unit: string | null;
  sellerId: string;
  sellerType: SellerType;
  categoryId: string;
  countryId: string | null;
  purchaseIntent: 'B2B' | 'B2C' | null;
  status: string;
  createdAt: string;
  image: string | null;
}

export interface MediaAsset {
  id: string;
  kind: string;
  status: string;
  title: string;
  productId: string | null;
  campaignId: string | null;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  provider: string;
  language: string;
  previewable: boolean;
  downloadable: boolean;
  createdAt: string;
  updatedAt: string;
  previewUrl: string | null;
  downloadUrl: string | null;
}

export interface ProductDetail extends ProductSummary {
  description: string | null;
  barcode: string | null;
  specifications: Record<string, unknown> | null;
  isPublished: boolean;
  images: Array<{ id: string; url: string; altText: string | null; isPrimary: boolean; sortOrder: number }>;
  variants: Array<{ id: string; name: string; sku: string; price: string; attributes: Record<string, unknown> | null }>;
  category: { id: string; name: string; nameAr: string | null; slug: string } | null;
}

export interface Category {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  slug: string;
  parentId: string | null;
  description: string | null;
  icon: string | null;
  isActive: boolean | null;
  sortOrder: number | null;
}

export interface SupplierSummary {
  id: string;
  companyName: string;
  slug: string;
  verified: boolean | null;
  countryId: string | null;
  logoUrl: string | null;
}

export interface MerchantSummary {
  id: string;
  storeName: string;
  slug: string;
  verified: boolean | null;
  countryId: string | null;
  logoUrl: string | null;
}

export interface CompanySummary {
  id: string;
  legalName: string;
  slug: string;
  verified: boolean | null;
  countryId: string | null;
  logoUrl: string | null;
}

export interface SearchResultGroup {
  type: string;
  count: number;
  items: Array<Record<string, unknown>>;
}

export interface SearchResponse {
  query: string;
  page: number;
  pageSize: number;
  results: SearchResultGroup[];
}

export type AvailabilityBand = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

export interface ComparisonOffer {
  productId: string;
  productSlug: string;
  name: string;
  currencyCode: string;
  basePrice: string;
  moq: number;
  unit: string;
  availability: AvailabilityBand;
  seller: {
    id: string | null;
    type: SellerType;
    name: string | null;
    slug: string | null;
    verified: boolean;
    countryId: string | null;
    logoUrl: string | null;
  };
  isLowestPrice: boolean;
  priceDeltaFromLowest: string;
}

export interface ComparisonGroup {
  key: string;
  matchedBy: 'BARCODE' | 'NAME';
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  brand: string | null;
  barcode: string | null;
  categoryId: string;
  categoryName: string | null;
  categoryNameAr: string | null;
  currencyCode: string;
  offerCount: number;
  sellerCount: number;
  lowestPrice: string;
  highestPrice: string;
  priceSpread: string;
  offers: ComparisonOffer[];
}

export interface PriceComparisonResponse {
  items: ComparisonGroup[];
  pagination: PaginationInfo;
}

export type LibraryEntityType = 'PRODUCT' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY';

/** schema.org JSON-LD object returned by `/structured-data/:type/:id`. */
export type JsonLd = Record<string, unknown>;

export interface FavoriteRow {
  id: string;
  entityType: LibraryEntityType;
  entityId: string;
  createdAt: string;
  title: string | null;
  slug: string | null;
  subtitle: string | null;
  available: boolean;
}

export interface SavedItemRow {
  id: string;
  itemType: LibraryEntityType;
  itemId: string;
  notes: string | null;
  createdAt: string;
  title: string | null;
  slug: string | null;
  available: boolean;
}

export interface SearchHistoryRow {
  id: string;
  query: string;
  filters: Record<string, unknown> | null;
  resultsCount: string | null;
  createdAt: string;
}

export interface LibraryListResponse<T> {
  items: T[];
  pagination: PaginationInfo;
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'DISPUTED';

export type OrderPaymentStatus =
  | 'UNPAID'
  | 'PENDING'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

export type OrderRefundStatus =
  | 'NONE'
  | 'REQUESTED'
  | 'PROCESSING'
  | 'APPROVED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED';

export interface Order {
  id: string;
  orderNumber: string;
  buyerId: string;
  sellerId: string;
  currencyCode: string;
  itemsTotal: string;
  commission: string;
  buyerCommission: string;
  paymentFee: string;
  grandTotal: string;
  status: OrderStatus;
  paymentStatus?: OrderPaymentStatus;
  refundStatus?: OrderRefundStatus;
  createdAt: string;
  items?: OrderItem[];
  seller?: { id: string; name: string | null; type: SellerType };
  viewerRole?: 'SELLER' | 'BUYER' | 'NONE';
}

// ---- Inventory ----
export interface InventoryItem {
  id: string;
  productId: string;
  productVariantId: string | null;
  merchantId: string;
  quantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
  availableQuantity: number;
  lowStock: boolean;
  outOfStock: boolean;
  updatedAt: string;
  productName: string;
  productNameAr: string | null;
  productSku: string;
  productStatus: string;
  variantSku: string | null;
  variantName: string | null;
  currencyCode: string;
  basePrice: string;
}

export interface InventoryItemDetail extends InventoryItem {
  product: {
    id: string;
    name: string;
    nameAr: string | null;
    sku: string;
    basePrice: string;
    currencyCode: string;
    status: string;
  } | null;
  variant: { id: string; name: string; sku: string; price: string } | null;
}

export interface InventoryMovement {
  id: string;
  inventoryItemId: string;
  movementType: 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION' | 'RELEASE';
  quantityChange: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdById: string;
  createdAt: string;
}

export interface Transaction {
  id: string;
  transactionNumber: string;
  totalValue: string;
  commission: string;
  buyerCommission?: string;
  paymentFee: string;
  status: string;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  transactionId?: string;
  entryType: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  currencyCode: string;
  payerId?: string | null;
  beneficiaryId?: string | null;
  paymentProvider?: string | null;
  status: string;
  createdAt: string;
}

export interface AdminStats {
  users: number;
  products: number;
  orders: number;
  gmv: number;
}

export interface AdminAdSummary {
  campaigns: number;
  activeCampaigns: number;
  totalSpent: string;
  totalBudget: string;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  conversionRate: number;
}

export interface AdminCampaignRow extends CampaignSummary {
  advertiserName: string | null;
  ownerEmail: string | null;
}

// ---- Analytics Engine (Phase 16) ----

export interface PlatformOverview {
  users: number;
  activeUsers30d: number;
  productOwners: number;
  suppliers: number;
  merchants: number;
  companies: number;
  products: number;
  publishedProducts: number;
  orders: number;
  paidOrders: number;
  gmv: number;
  commission: number;
  paymentFees: number;
  avgOrderValue: number;
  inventoryItems: number;
  lowStock: number;
  outOfStock: number;
  activeCampaigns: number;
  subscriptionsActive: number;
  aiRequests: number;
  dailyKpiCount: number;
  currencyCode: string;
}

export interface RetentionSnapshot {
  totalUsers: number;
  usersCreated30d: number;
  activeUsers30d: number;
  activeUsers90d: number;
  retentionRate30d: number;
  newUserRetention: number;
  sessionsLast30d: number;
}

export interface ConversionSnapshot {
  orders: number;
  paidOrders: number;
  orders30d: number;
  paidOrders30d: number;
  conversionRate: number;
  conversionRate30d: number;
  avgOrderValue: number;
  abandonedOrders: number;
  users: number;
  ordersPerUser: number;
}

export interface RevenueBreakdown {
  transactionValue: number;
  commission: number;
  paymentFees: number;
  refunds: number;
  settlement: number;
  netRevenue: number;
  currencyCode: string;
}

export interface DailyKpiRow {
  id: string;
  date: string;
  metricName: string;
  metricValue: number;
  dimensions: Record<string, unknown> | null;
}

export interface DashboardReportRow {
  id: string;
  reportCode: string;
  title: string;
  reportData: Record<string, unknown> | null;
  generatedById: string | null;
  createdAt: string;
}

// B9 unit economics — every field is an aggregate of real orders/marketing cost.
export interface UnitEconomicsAssumptions {
  assumedRetentionMonths: number;
  assumedOrdersPerMonth: number;
}

export interface UnitEconomics {
  currencyCode: string;
  windowDays: number;
  newCustomers: number;
  marketingSpend: string;
  cac: string | null;
  customersWithOrders: number;
  paidOrders: number;
  grossMarginTotal: string;
  grossMarginPerOrder: string;
  arpu: string;
  ltvRealized: string;
  ltvProjected: string;
  ltvCacRatio: string | null;
  assumptions: UnitEconomicsAssumptions;
  contributionMarginPct: string;
  gmv: string;
  basedOn: string[];
}

export interface CohortRow {
  month: string;
  customers: number;
  gmv: string;
  grossMargin: string;
}

export interface MyAnalyticsOverview {
  hasBusinessEntity: boolean;
  sellerName: string | null;
  products: number;
  publishedProducts: number;
  inventoryItems: number;
  lowStock: number;
  outOfStock: number;
  ordersAsSeller: number;
  gmvAsSeller: number;
  commissionAsSeller: number;
  customers: number;
  disputesAsSeller: number;
  avgOrderValue: number;
  campaigns: number;
  activeCampaigns: number;
}

export interface CommissionPolicy {
  id: string;
  name: string;
  code: string;
  rate: string;
  isActive: boolean;
  currencyCode?: string;
  description?: string;
}

export type PlanTarget = 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY' | 'GLOBAL';

export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';

export type BillingCycle = 'MONTHLY' | 'YEARLY';

/** Mirrors the backend `SubscriptionPlanView` — the only source of plan prices. */
export interface SubscriptionPlan {
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

/** Mirrors the backend `MySubscriptionView`. */
export interface MySubscription {
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

/** Mirrors the backend `InvoiceView` for subscription invoices. */
export interface SubscriptionInvoice {
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

/** Mirrors the backend `AdminSubscriptionView` — one row per subscription. */
export interface AdminSubscription {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  billingCycle: string;
  autoRenew: boolean;
  startsAt: string | null;
  endsAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** Mirrors the backend `AdminInvoiceView` — includes the owning user for the admin desk. */
export interface AdminSubscriptionInvoice {
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

export interface RolloverResult {
  renewed: number;
  skipped: number;
  renewedIds: string[];
}

export interface ExpireLapsedResult {
  expired: number;
  expiredIds: string[];
}

export interface CollectResult {
  invoiceId: string;
  subscriptionId: string;
  amount: string;
  currencyCode: string;
  paidAt: string;
  subscriptionStatus: string;
  periodEnd: string;
}

// ---------------------------------------------------------------------------
// Admin AI governance — mirrors `modules/admin/ai-routes.ts`. Every field is a
// real column returned by the backend; nothing here is invented client-side.
// ---------------------------------------------------------------------------

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected';

export interface AiAdminBudget {
  id: string;
  userId: string | null;
  roleTarget: string | null;
  period: 'DAILY' | 'MONTHLY';
  maxRequests: number | null;
  maxTokensInput: number | null;
  maxTokensOutput: number | null;
  maxCost: string | null;
  currencyCode: string;
  isActive: boolean;
  updatedAt: string;
}

export interface AiAdminModel {
  id: string;
  key: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPer1k: string;
  outputPer1k: string;
  currencyCode: string;
  isActive: boolean;
  updatedAt: string;
}

/** Aggregated usage for the current monthly window + every configured budget. */
export interface AiAdminUsage {
  window: { start: string; end: string };
  totals: {
    requests: number;
    tokensInput: number;
    tokensOutput: number;
    cost: string;
    distinctUsers: number;
  };
  budgets: AiAdminBudget[];
}

export interface AiAdminRequestRow {
  id: string;
  userId: string;
  requestType: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  currencyCode: string;
  status: string;
  latencyMs: number;
  createdAt: string;
}

export interface AgentRegistryRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  requiresHumanApproval: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface AgentTaskRow {
  id: string;
  agentKey: string;
  requestedBy: string;
  input: Record<string, unknown>;
  status: AgentTaskStatus;
  result: unknown;
  error: { message?: string } | null;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  cost: string;
  model: string;
  latencyMs: number;
  createdAt: string;
}

export interface AgentTaskDecision {
  id: string;
  status: AgentTaskStatus;
}


export interface Country {
  id: string;
  isocode: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  isActive: boolean;
  flag: string | null;
  phoneCode: string | null;
}

export interface Currency {
  id: string;
  code: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
}

export interface Language {
  id: string;
  code: string;
  name: string;
  direction: 'rtl' | 'ltr';
  isActive: boolean;
}

// ---- Messaging ----
export interface ThreadParticipant {
  userId: string;
  displayName: string | null;
  email: string;
  roles: string[];
  joinedAt: string;
  lastReadAt: string | null;
}

export interface ThreadMessage {
  id: string;
  senderId: string;
  body: string;
  messageType: string;
  status: 'SENT' | 'DELIVERED' | 'READ';
  readAt: string | null;
  createdAt: string;
  isDeleted: boolean;
}

export interface ThreadSummary {
  id: string;
  subject: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  participantCount: number;
  unreadCount: number;
  participants: Array<{ userId: string; displayName: string | null; email: string }>;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    senderName: string;
    status: string;
    createdAt: string;
  } | null;
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  participants: ThreadParticipant[];
  messages: ThreadMessage[];
}

export interface MessagingSearchResponse {
  threads: ThreadSummary[];
  messages: Array<{
    id: string;
    threadId: string;
    senderId: string;
    body: string;
    createdAt: string;
    status: string;
  }>;
}

// ---- Notifications ----
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  items: NotificationItem[];
  page: number;
  pageSize: number;
  total: number;
  unreadCount: number;
}

// ---- Phase 9: Verification + Trust + Risk + Disputes ----

export type VerificationLevel = 'NONE' | 'BASIC' | 'VERIFIED' | 'BUSINESS_VERIFIED' | 'INTERNATIONAL_VERIFIED';

export interface VerificationRequestRow {
  id: string;
  targetLevel: Exclude<VerificationLevel, 'NONE'>;
  status: string;
  documentType: string | null;
  documentRef: string | null;
  isBusiness: boolean;
  businessId: string | null;
  reviewNotes: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface VerificationStatusOverview {
  currentLevel: VerificationLevel;
  emailVerified: boolean;
  phoneVerified: boolean;
  activeRequest: VerificationRequestRow | null;
  recentRequests: VerificationRequestRow[];
  nextStep: string | null;
}

export interface VerificationPolicy {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  isActive: boolean;
}

export interface TrustScoreRow {
  id: string;
  userId: string;
  score: number;
  level: string;
  factors: Record<string, unknown>;
  summary: string | null;
  effectiveAt: string;
}

export interface TrustOverview {
  latest: TrustScoreRow | null;
  explanation: string | null;
  historyCount: number;
}

export interface DisputeSummary {
  id: string;
  disputeNumber: string;
  orderId: string;
  openedById: string;
  openedByEmail: string | null;
  reasonCode: string;
  description: string;
  status: string;
  decision: string;
  decisionNote: string | null;
  assignedToId: string | null;
  assignedToEmail: string | null;
  appealAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeEventRow {
  id: string;
  disputeId: string;
  actorId: string | null;
  eventType: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DisputeMessageRow {
  id: string;
  senderId: string;
  senderEmail: string | null;
  body: string;
  isEvidence: boolean;
  createdAt: string;
}

export interface DisputeEvidenceRow {
  id: string;
  uploadedById: string;
  fileRef: string;
  description: string | null;
  contentType: string | null;
  createdAt: string;
}

export interface DisputeDetail extends DisputeSummary {
  countryId: string | null;
  countryCode: string | null;
  policySource: 'COUNTRY' | 'GLOBAL';
  events: DisputeEventRow[];
  messages: DisputeMessageRow[];
  evidence: DisputeEvidenceRow[];
  appeals: DisputeAppealRow[];
}

export interface AdminDisputePolicy {
  id: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  countryId: string | null;
  countryCode: string | null;
  version: number;
  isActive: boolean;
  updatedAt: string;
}

export interface AdminRetentionPolicy {
  id: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  countryId: string | null;
  countryCode: string | null;
  version: number;
  isActive: boolean;
  updatedAt: string;
}

export interface CountryPolicyGap {
  id: string;
  countryId: string;
  countryCode: string | null;
  status: 'DECISION_REQUIRED' | 'RESOLVED';
  reason: string | null;
  detectedAt: string;
}

export interface DisputeAppealRow {
  id: string;
  disputeId: string;
  appealedById: string;
  appealedByEmail: string | null;
  reason: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface RiskProfileRow {
  userId: string;
  email: string | null;
  currentScore: number;
  level: string;
  lastEvaluatedAt: string;
  flags: Record<string, unknown>;
}

export interface RiskEventRow {
  id: string;
  userId: string;
  eventType: string;
  severity: string;
  riskScore: number;
  reasonCode: string;
  recommendedAction: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// ---- Ads ----
export interface CampaignSummary {
  id: string;
  advertiserId: string;
  advertiserType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  title: string;
  objective: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  budget: string;
  spent: string;
  currencyCode: string;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdCreativeRow {
  id: string;
  campaignId: string;
  type: string;
  title: string;
  body: string | null;
  mediaUrl: string | null;
  targetUrl: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CampaignDetail extends CampaignSummary {
  creatives: AdCreativeRow[];
}

export interface CampaignStats {
  campaignId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: string;
  spent: string;
  budget: string;
}

export interface CampaignListResponse {
  items: CampaignSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ServedAdRow {
  campaignId: string;
  creativeId: string;
  title: string;
  body: string | null;
  mediaUrl: string | null;
  targetUrl: string | null;
  objective: string;
  advertiserType: string;
}

// ---- Admin observability (server enforces ADMIN_SYSTEM) ----

export interface ObservabilityMetricSeries {
  labels: Record<string, string>;
  count: number;
  sum: number;
  quantiles: Record<string, number>;
}

export interface ObservabilityMetricsSnapshot {
  counters: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
  gauges: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
  histograms: Record<string, ObservabilityMetricSeries[]>;
}

export interface ObservabilityFiringAlert {
  rule: string;
  firedAt: string | null;
}

export interface ObservabilityDashboard {
  metrics: ObservabilityMetricsSnapshot;
  alerts: {
    firing: ObservabilityFiringAlert[];
    lastEvaluatedAt: string | null;
    notifier: { notifier: string; available: boolean };
  };
  db: 'configured' | 'missing';
}

export interface ObservabilityLogRecord {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  traceId?: string;
}

export interface AlertEventRow {
  id: string;
  rule: string;
  severity: string;
  status: 'FIRING' | 'RESOLVED';
  summary: string;
  details: Record<string, unknown> | null;
  notifiedChannel: string | null;
  notifiedResult: string | null;
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertEvaluationResult {
  evaluated: number;
  fired: string[];
  resolved: string[];
}

// ---- Admin privacy / data-deletion desk (server enforces ADMIN/SUPER_ADMIN) ----

export type DeletionStage =
  | 'REQUESTED'
  | 'DEACTIVATED'
  | 'RETENTION'
  | 'REVIEW'
  | 'ELIGIBLE'
  | 'ANONYMIZED'
  | 'DELETED'
  | 'REJECTED';

/** Retention rules captured on the request at creation time (policy snapshot). */
export interface DeletionRetentionPolicy {
  defaultRetentionDays: number;
  legalHoldFinanciallyRequired: boolean;
  preserves: string[];
  policySource?: string;
  policyId?: string | null;
  policyVersion?: number;
  countryCode?: string | null;
}

export interface RetentionSweepResult {
  retained: number;
  eligible: number;
  requestIds: string[];
}

export interface DeletionRequestRow {
  requestId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  accountActive: boolean | null;
  stage: DeletionStage;
  reason: string | null;
  requestedBy: string;
  retentionUntil: string | null;
  retentionPolicy: DeletionRetentionPolicy | null;
  createdAt: string;
}

/** Role-scoped directory surfaces (merchant/supplier/company dashboards). */
export type DirectoryEntityType = 'MERCHANT' | 'SUPPLIER' | 'COMPANY';

export interface OwnedEntity {
  id: string;
  type: DirectoryEntityType;
  name: string;
  verified: boolean;
}

export interface BuyerRelation {
  userId: string;
  name: string;
  email: string | null;
  buyerType: string;
  orderCount: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

export interface PartnerRelation {
  sellerId: string;
  sellerType: string;
  name: string;
  orderCount: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

export interface DirectorySupplierRow {
  id: string;
  companyName: string;
  verified: boolean;
  countryId: string | null;
  cityId: string | null;
  logoUrl: string | null;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface DirectoryMerchantRow {
  id: string;
  storeName: string;
  verified: boolean;
  countryId: string | null;
  cityId: string | null;
  logoUrl: string | null;
  description: string | null;
}

export interface DirectoryListResponse<T> {
  items: T[];
  pagination: PaginationInfo;
}
