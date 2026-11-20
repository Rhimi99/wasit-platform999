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
  | { mfaRequired: true; challengeToken: string; expiresAt: string; mfaEnrollmentRequired?: boolean };

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
  /** Safe, error-specific context (e.g. the legal-acceptance `pending` list). */
  details?: unknown;
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

/**
 * M2.4-T2.4 — the per-seller refund attribution view for one order (admin desk).
 * Every amount is read from the server; nothing here is computed in the UI.
 */
export interface RefundAttributionRefund {
  refundId: string;
  status: OrderRefundStatus;
  amount: string;
  /** True only for a COMPLETED refund — a pending/failed refund is not money back. */
  counted: boolean;
  reason: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundAttributionSeller {
  sellerOrderId: string;
  sellerOrderNumber: string;
  sellerId: string;
  sellerType: string;
  status: OrderStatus;
  settlementStatus: string;
  refundableCap: string;
  refundedAmount: string;
  remainingAmount: string;
  sellerCommission: string;
  sellerCommissionReversed: string;
  fullyRefunded: boolean;
  lineItems: Array<{ orderItemId: string; refundedAmount: string }>;
  refunds: RefundAttributionRefund[];
}

export interface RefundAttributionOrderRefund {
  id: string;
  amount: string;
  currencyCode: string;
  status: OrderRefundStatus;
  reason: string | null;
  externalRef: string | null;
  requestedById: string | null;
  processedById: string | null;
  createdAt: string;
  updatedAt: string;
  allocatedTo: string[];
}

export interface OrderRefundAttribution {
  order: {
    id: string;
    orderNumber: string;
    currencyCode: string;
    status: OrderStatus;
    paymentStatus: OrderPaymentStatus;
    refundStatus: OrderRefundStatus;
    grandTotal: string;
    refundedTotal: string;
    remainingTotal: string;
    fullyRefunded: boolean;
  };
  refunds: RefundAttributionOrderRefund[];
  sellers: RefundAttributionSeller[];
  legacy: boolean;
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
  currencyCode: string;
  transactionsInCurrency: number;
  currencyScope: CurrencyScope;
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

/**
 * How a money KPI was scoped: which single currency it is in, and which
 * currencies were therefore excluded (never converted — no FX rate is assumed).
 */
export interface CurrencyScope {
  currencyCode: string;
  excludedCurrencies: string[];
  multiCurrency: boolean;
  fxApplied: false;
  note: string;
}

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
  ordersInCurrency: number;
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
  currencyScope: CurrencyScope;
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
  currencyCode: string;
  currencyScope: CurrencyScope;
}

export interface RevenueBreakdown {
  transactionValue: number;
  commission: number;
  paymentFees: number;
  refunds: number;
  settlement: number;
  netRevenue: number;
  currencyCode: string;
  currencyScope: CurrencyScope;
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
  currencyCode: string;
  currencyScope: CurrencyScope;
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

/** Central AI Kill Switch state (A1). `source` is where the state comes from. */
export interface AiKillSwitchState {
  enabled: boolean;
  source: 'runtime' | 'env';
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

// ----- A3: AI Company agent metrics ----------------------------------------
export type AgentHealth = 'healthy' | 'degraded' | 'failing' | 'idle' | 'no_data';

export interface AgentMetricsExecution {
  totalRuns: number;
  completed: number;
  failed: number;
  cancelledOrBlocked: number;
  pending: number;
  running: number;
  successRate: number | null;
}

export interface AgentMetricsPerformance {
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  slowRuns: number;
  measuredRuns: number;
  retriedSteps: number;
  failedSteps: number;
  recoveredRuns: number;
}

export interface AgentMetricsCost {
  available: boolean;
  actualProviderCostUsd: string;
  currencyCode: string;
  tokensInput: number;
  tokensOutput: number;
  requests: number;
  byModel: { model: string; provider: string | null; requests: number; costUsd: string }[];
}

export interface AgentMetricsOutcomes {
  tasksWithStoredResult: number;
  businessOutcomesAchieved: number;
  note: string;
}

export interface AgentMetricsRow {
  agentKey: string;
  name: string;
  requiresHumanApproval: boolean;
  active: boolean;
  execution: AgentMetricsExecution;
  performance: AgentMetricsPerformance;
  cost: AgentMetricsCost;
  outcomes: AgentMetricsOutcomes;
  lastActivityAt: string | null;
  health: AgentHealth;
  healthReason: string;
}

export interface CompanyMetrics {
  generatedAt: string;
  window: { since: string | null; until: string };
  overall: {
    execution: AgentMetricsExecution;
    performance: AgentMetricsPerformance;
    cost: AgentMetricsCost;
    outcomes: AgentMetricsOutcomes;
  };
  agents: AgentMetricsRow[];
  attention: { agentKey: string; name: string; health: AgentHealth; reason: string }[];
  dataFreshness: { latestActivityAt: string | null; latestMetricAt: string | null };
  notes: string[];
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
  deadlines: {
    openWindowClosesAt: string | null;
    responseDeadline: string | null;
    evidenceDeadline: string | null;
    decisionDeadline: string | null;
    autoEscalateAt: string | null;
  };
  deadlineStatus: {
    responseOpen: boolean;
    evidenceOpen: boolean;
    decisionOverdue: boolean;
    needsEscalation: boolean;
    daysToEvidence: number | null;
    daysToDecision: number | null;
  };
  events: DisputeEventRow[];
  messages: DisputeMessageRow[];
  evidence: DisputeEvidenceRow[];
  appeals: DisputeAppealRow[];
}

/** Public legal document as disclosed by GET /api/public/legal/documents (no session). */
export interface PublicLegalDocument {
  code: string;
  audience: string;
  title: { ar: string; en: string };
  summary: { ar: string; en: string };
  version: string;
  effectiveDate: string | null;
  acceptanceRequired: boolean;
}

/** One legal document currently in force and open for acceptance. */
export interface LegalDocumentInForce {
  code: string;
  title: { ar: string; en: string };
  version: string;
  effectiveDate: string | null;
}

/** A legal document this user must (re-)accept, from the code catalogue. */
export interface PendingLegalAcceptance {
  code: string;
  title: { ar: string; en: string };
  version: string;
}

/** The caller's own legal state (session-scoped; no other user's data). */
export interface LegalAcceptanceState {
  acceptedVersions: Record<string, string>;
  pendingAcceptances: PendingLegalAcceptance[];
  inForce: LegalDocumentInForce[];
}

/** One entry of the caller's own legal-acceptance history. */
export interface LegalAcceptanceHistoryEntry {
  documentCode: string;
  version: string;
  acceptedAt: string | null;
  locale: string | null;
}

/** Public, client-safe refund/dispute policy summary (no session required). */
export interface PublicRefundPolicy {
  countryCode: string | null;
  source: 'COUNTRY' | 'GLOBAL';
  version: number | null;
  windows: {
    openWindowDays: number | null;
    responseWindowDays: number | null;
    evidenceDeadlineDays: number | null;
    decisionDeadlineDays: number | null;
    appealWindowDays: number | null;
    maxAppeals: number | null;
  };
  refundsBuyerOnBuyerFavourableDecision: boolean;
  operationalSummaryOnly: true;
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

/**
 * One terminal (FAILED / DEAD_LETTERED) provider webhook event, as surfaced to
 * an operator. Deliberately carries no raw `payload`/signature — only what an
 * operator needs to identify the stuck event and decide to replay it.
 */
export interface WebhookFailureRow {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  status: 'FAILED' | 'DEAD_LETTERED';
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
}

export interface WebhookFailuresResponse {
  items: WebhookFailureRow[];
  meta: { total: number; limit: number; offset: number };
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
  /** Returned only when the caller may see supplier contact PII. */
  contactEmail?: string | null;
  contactPhone?: string | null;
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

// ---- PS-01: Admin Finance Desk (settlement / payout / reconciliation / receipts) ----

/** A payout rail as described by `GET /api/admin/finance/payout-providers`. */
export interface PayoutProviderInfo {
  id: string;
  functional: boolean;
  available: boolean;
  demo: boolean;
  transferReference: boolean;
}

export interface PayoutProvidersResponse {
  active: string;
  providers: PayoutProviderInfo[];
}

export type PayoutStatus = 'CREATED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'HELD';

export interface PayoutRecord {
  id: string;
  orderId: string;
  transactionId: string;
  sellerOrderId?: string | null;
  sellerId: string;
  amount: string;
  currencyCode: string;
  providerId: string;
  status: PayoutStatus;
  payoutRef: string | null;
  providerRef: string | null;
  failureReason: string | null;
}

export interface SettlementResult {
  applied: boolean;
  duplicate: boolean;
  settlementEntryId: string | null;
}

/** M2.3 — why a seller suborder could not be settled. */
export type SuborderSettlementReason =
  | 'SUBORDER_NOT_FOUND'
  | 'SUBORDER_NOT_DELIVERED'
  | 'ALREADY_SETTLED'
  | 'PARENT_TRANSACTION_NOT_SETTLED'
  | 'PARENT_ORDER_NOT_PAID'
  | 'REFUND_PRESENT'
  | 'DISPUTE_OPEN';

/** M2.3 — the outcome of re-processing one seller suborder's settlement. */
export interface SuborderSettlementResult {
  sellerOrderId: string;
  settled: boolean;
  duplicate: boolean;
  reason?: SuborderSettlementReason;
}

export interface PayoutDispatchResult {
  payout: PayoutRecord;
  providerRef: string;
}

export interface PayoutSyncResult {
  payout: PayoutRecord;
  providerStatus: string;
}

export type ReconciliationStatus = 'MATCHED' | 'MISMATCH';

export interface ReconciliationDecision {
  reference: string;
  status: ReconciliationStatus;
  mismatches: string[];
  provider: { reference: string } | null;
  bank: { reference: string } | null;
  ledger: { reference: string } | null;
}

export interface ReconciliationReport {
  currencyCode: string;
  decisions: ReconciliationDecision[];
  matched: number;
  mismatched: number;
}

export interface ReconciliationImportResult {
  importId: string;
  duplicate: boolean;
  insertedLines: number;
  report: ReconciliationReport;
}

export type ReceiptSource = 'BANK_STATEMENT' | 'ACQUIRER' | 'PROVIDER';

export interface ReceiptResult {
  id: string;
  status: 'RECEIVED';
  reference: string;
  amount: string;
  currencyCode: string;
  source: ReceiptSource;
  duplicate: boolean;
}

/** PS-02 — read-only view of an order's manual-payment eligibility. */
export interface ManualPaymentView {
  order: {
    id: string;
    orderNumber: string;
    paymentStatus: string;
    settlementStatus: string;
    grandTotal: string;
    currencyCode: string;
  };
  intent: { id: string; provider: string; status: string; externalRef: string | null } | null;
  payment: { id: string; provider: string; status: string } | null;
  demoMode: boolean;
  eligible: boolean;
}

/** PS-02 — the result of recording a manual (offline-desk) payment completion. */
export interface ManualCompletionResult {
  orderId: string;
  intentId: string;
  externalRef: string;
  paymentReference: string;
  amount: string;
  currencyCode: string;
  alreadyPaid: boolean;
}
