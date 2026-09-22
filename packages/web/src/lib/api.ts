// عميل الـ API الموحّد — يستخدم fetch مع إرسال الجلسة كـ cookie (same-origin عبر Vite proxy).
// يعالج استجابة {success,data,error} الموحّدة من الـ Backend.

import type {
  AdminStats, ApiResponse, CampaignDetail, CampaignListResponse, CampaignStats,
  AdminDisputePolicy, AdminRetentionPolicy, CountryPolicyGap,
  Category, CompanySummary, ConversionSnapshot, Country, Currency, MediaAsset,
  DailyKpiRow, DashboardReportRow, DisputeAppealRow, DisputeDetail, DisputeSummary, InventoryItem, InventoryItemDetail, InventoryMovement, Language, LedgerEntry,
  MerchantSummary, MessagingSearchResponse, MyAnalyticsOverview, NotificationListResponse, Order, PaginationInfo,
  FavoriteRow, LibraryEntityType, LibraryListResponse, SavedItemRow, SearchHistoryRow,
  JsonLd, LoginResponse, MfaEnrollment, MfaStatus,
  PlatformOverview, ProductDetail, ProductSummary, RetentionSnapshot, RevenueBreakdown, RiskEventRow, RiskProfileRow, SearchResponse, ServedAdRow, SupplierSummary, ThreadDetail,
  ThreadSummary, Transaction, TrustOverview, TrustScoreRow, User, VerificationPolicy, VerificationRequestRow,
  VerificationStatusOverview,
  PlanTarget, BillingCycle, SubscriptionPlan, MySubscription, SubscriptionInvoice,
  AdminSubscription, AdminSubscriptionInvoice, CollectResult, RolloverResult, ExpireLapsedResult,
  AiAdminUsage, AiAdminModel, AiAdminBudget, AiAdminRequestRow, AgentRegistryRow, AgentTaskRow, AgentTaskDecision,
  ObservabilityDashboard, ObservabilityLogRecord, ObservabilityFiringAlert, AlertEventRow, AlertEvaluationResult,
  DeletionRequestRow, DeletionStage, RetentionSweepResult,
} from './types';

export class ApiClientError extends Error {
  code: string;
  statusCode?: number;
  fieldErrors?: Record<string, string[]>;
  traceId?: string;

  constructor(message: string, code: string, statusCode?: number, fieldErrors?: Record<string, string[]>, traceId?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.fieldErrors = fieldErrors;
    this.traceId = traceId;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
    ...options,
  });

  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    // لا يوجد JSON
  }

  if (!res.ok || !body?.success) {
    const err = body?.error;
    throw new ApiClientError(
      err?.message ?? 'Request failed',
      err?.code ?? 'UNKNOWN',
      err?.statusCode ?? res.status,
      err?.fieldErrors,
      err?.traceId,
    );
  }

  return body.data as T;
}

export const api = {
  // ---- Auth ----
  async login(email: string, password: string) {
    return request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },
  async mfaChallenge(challengeToken: string, code: string) {
    return request<User>('/api/auth/mfa/challenge', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, code }),
    });
  },
  async mfaStatus() {
    return request<MfaStatus>('/api/auth/mfa/status');
  },
  async mfaEnroll() {
    return request<MfaEnrollment>('/api/auth/mfa/enroll', { method: 'POST', body: JSON.stringify({}) });
  },
  async mfaConfirm(code: string) {
    return request('/api/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  },
  async mfaDisable(code: string) {
    return request('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) });
  },
  async mfaRecoveryCodes(code: string) {
    return request<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
  async register(data: { email: string; password: string; firstName?: string; lastName?: string; locale?: string; role?: string }) {
    return request<{ userId: string; requiresEmailVerification: boolean }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async logout() {
    return request<{ success: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  async me() {
    return request<User>('/api/auth/me');
  },
  async sessions() {
    return request<Array<{ id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; isCurrent: boolean }>>('/api/auth/sessions');
  },
  async revokeSession(sessionId: string) {
    return request('/api/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId }) });
  },
  async forgotPassword(email: string) {
    return request<{ devResetToken?: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
  },
  async resetPassword(token: string, newPassword: string) {
    return request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
  },
  async verifyEmail(token: string) {
    return request('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
  },

  // ---- Health ----
  async healthReady() {
    return request<{ status: string; db: string }>('/api/health/ready');
  },

  // ---- Marketplace / Products ----
  async listProducts(params: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const data = await request<{ items: ProductSummary[]; pagination: PaginationInfo }>(`/api/products?${qs.toString()}`);
    return data;
  },
  async getProduct(id: string) {
    return request<ProductDetail>(`/api/products/${id}`);
  },
  async listMyProducts(params?: { page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: ProductSummary[]; pagination: PaginationInfo }>(`/api/products/mine${suffix}`);
  },
  async listMySellerEntities() {
    return request<{ items: Array<{ id: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; name: string }> }>('/api/products/mine/entities');
  },
  async updateProductStatus(id: string, status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'SUSPENDED') {
    return request<{ success: boolean }>(`/api/products/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  },

  // ---- Media (marketing videos) ----
  async generateMarketingVideo(data: {
    productId: string;
    title?: string;
    language?: 'ar' | 'fr' | 'en' | 'zh';
    audience?: 'B2B' | 'B2C';
    style?: 'MODERN' | 'MINIMAL' | 'BOLD' | 'ELEGANT';
    durationSeconds?: number;
    campaignId?: string | null;
  }) {
    return request<MediaAsset>(`/api/media/marketing-videos`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async listMyMedia(params?: { kind?: 'MARKETING_VIDEO' | 'IMAGE' | 'OTHER'; productId?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.productId) qs.set('productId', params.productId);
    if (params?.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: MediaAsset[] }>(`/api/media/assets${suffix}`);
  },
  async deleteMediaAsset(id: string) {
    return request<{ id: string }>(`/api/media/assets/${id}`, { method: 'DELETE' });
  },
  async getStructuredData(type: LibraryEntityType | 'CATEGORY' | 'COUNTRY', id: string) {
    return request<JsonLd>(`/api/seo/structured-data/${type}/${id}`);
  },

  // ---- Geo (public) ----
  async listCountries() {
    return request<{ items: Country[] }>('/api/geo/countries');
  },
  async getCountryByCode(code: string) {
    return request<Country>(`/api/geo/countries/by-code/${code}`);
  },
  async createProduct(data: {
    sellerId: string;
    sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
    categoryId: string;
    name: string;
    nameAr?: string;
    description?: string;
    sku: string;
    currencyCode: string;
    basePrice: string;
    moq?: number;
    unit?: string;
    purchaseIntent?: 'B2B' | 'B2C';
  }) {
    return request<{ id: string }>('/api/products', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Categories ----
  async listCategories() {
    return request<Category[]>('/api/categories');
  },

  // ---- Search ----
  async search(params: { q: string; type?: string; page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    if (params.type) qs.set('type', params.type);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    return request<SearchResponse>(`/api/search?${qs.toString()}`);
  },

  // ---- Suppliers ----
  async listSuppliers() {
    return request<{ items: SupplierSummary[] }>('/api/suppliers');
  },
  async getSupplier(id: string) {
    return request<Record<string, unknown>>(`/api/suppliers/${id}`);
  },
  async createSupplier(data: { companyName: string; countryId?: string; cityId?: string; description?: string; logoUrl?: string }) {
    return request<{ id: string }>('/api/suppliers', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Merchants ----
  async listMerchants() {
    return request<{ items: MerchantSummary[] }>('/api/merchants');
  },
  async getMerchant(id: string) {
    return request<Record<string, unknown>>(`/api/merchants/${id}`);
  },
  async createMerchant(data: { storeName: string; countryId?: string; cityId?: string; description?: string; logoUrl?: string }) {
    return request<{ id: string }>('/api/merchants', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Companies ----
  async listCompanies() {
    return request<{ items: CompanySummary[] }>('/api/companies');
  },
  async getCompany(id: string) {
    return request<Record<string, unknown>>(`/api/companies/${id}`);
  },
  async createCompany(data: { legalName: string; registrationNumber?: string; taxId?: string; countryId?: string; cityId?: string; industry?: string; description?: string; logoUrl?: string }) {
    return request<{ id: string }>('/api/companies', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Orders ----
  async createOrder(data: { buyerId: string; items: { productId: string; quantity: number }[]; currencyCode?: string; notes?: string }) {
    return request<{ orderId: string; orderNumber: string; itemsTotal: string; commission: string; commissionSeller: string; commissionBuyer: string; paymentFee: string; grandTotal: string; currencyCode: string; transactionId: string }>('/api/orders', { method: 'POST', body: JSON.stringify(data) });
  },
  // ---- Payments ----
  async getPaymentMethods() {
    return request<{
      active: string;
      providers: {
        id: string;
        functional: boolean;
        available: boolean;
        methods: { method: { type: 'CARD' | 'MOBILE_WALLET'; scheme?: string }; available: boolean; reason?: string }[];
      }[];
    }>('/api/payments/methods');
  },
  async createPaymentIntent(orderId: string, idempotencyKey?: string, method?: { type: 'CARD' | 'MOBILE_WALLET'; scheme?: string }) {
    return request<{
      intent: { id: string; orderId: string; amount: string; currencyCode: string; provider: string; externalRef: string | null; status: string; method: string | null; scheme: string | null };
      checkoutUrl: string | null;
      reused: boolean;
    }>(`/api/payments/orders/${orderId}/intent`, {
      method: 'POST',
      body: JSON.stringify({ ...(idempotencyKey ? { idempotencyKey } : {}), ...(method ? { method } : {}) }),
    });
  },
  async getOrderPayment(orderId: string) {
    return request<{
      intent: { id: string; status: string; provider: string; amount: string; currencyCode: string; externalRef: string | null; method: string | null; scheme: string | null } | null;
      payment: { id: string; status: string; provider: string; amount: string; currencyCode: string } | null;
    }>(`/api/payments/orders/${orderId}`);
  },
  async createRefund(orderId: string, data: { amount?: string; reason?: string; idempotencyKey?: string } = {}) {
    return request<{ refund: { id: string; status: string; amount: string; currencyCode: string }; reused: boolean }>(
      `/api/payments/orders/${orderId}/refunds`,
      { method: 'POST', body: JSON.stringify(data) },
    );
  },
  async listMyOrders() {
    return request<Order[]>('/api/orders');
  },
  async getOrder(id: string) {
    return request<Order>(`/api/orders/${id}`);
  },

  // ---- Inventory ----
  async listMyInventory(params: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return request<{ items: InventoryItem[]; total: number; page: number; pageSize: number }>(`/api/inventory?${qs.toString()}`);
  },
  async getInventoryItem(id: string) {
    return request<InventoryItemDetail>(`/api/inventory/${id}`);
  },
  async adjustInventory(id: string, data: { quantityChange: number; movementType?: string; reason?: string }) {
    return request<{ itemId: string; newQuantity: number }>(`/api/inventory/${id}/adjust`, { method: 'POST', body: JSON.stringify(data) });
  },
  async updateInventory(id: string, data: { quantity?: number; reservedQuantity?: number; lowStockThreshold?: number }) {
    return request<{ itemId: string; quantity: number; reservedQuantity: number; lowStockThreshold: number }>(`/api/inventory/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  async inventoryMovements(id: string, params: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return request<{ items: InventoryMovement[]; total: number; page: number; pageSize: number }>(`/api/inventory/${id}/movements?${qs.toString()}`);
  },

  // ---- Admin ----
  async adminStats() {
    return request<AdminStats>('/api/admin/stats');
  },
  async adminUsers() {
    return request<{ items: Array<{ id: string; email: string; isActive: boolean; emailVerified: boolean; createdAt: string }> }>('/api/admin/users');
  },
  async adminOrders() {
    return request<{ items: Order[] }>('/api/admin/orders');
  },
  async adminTransactions() {
    return request<{ items: Transaction[] }>('/api/admin/transactions');
  },
  async adminLedger() {
    return request<{ items: LedgerEntry[] }>('/api/admin/ledger');
  },
  async adminAuditLogs() {
    return request<{ items: Array<Record<string, unknown>> }>('/api/admin/audit-logs');
  },
  async adminProducts() {
    return request<{ items: Array<{ id: string; name: string; sku: string; status: string; sellerId: string; basePrice: string }> }>('/api/admin/products');
  },
  async adminSuspendProduct(id: string) {
    return request<{ success: boolean }>(`/api/products/${id}/suspend`, { method: 'PATCH' });
  },
  async adminSetUserStatus(id: string, isActive: boolean) {
    return request('/api/admin/users/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ isActive }) });
  },

  // ---- Phase 9: Verification ----
  async verificationStatus() {
    return request<VerificationStatusOverview>('/api/verification/me');
  },
  async verificationPolicies() {
    return request<VerificationPolicy[]>('/api/verification/policies');
  },
  async listVerificationRequests() {
    return request<{ items: VerificationRequestRow[] }>('/api/verification/requests');
  },
  async submitVerificationRequest(data: { targetLevel: string; documentType?: string; documentRef?: string; isBusiness?: boolean; businessId?: string }) {
    return request<{ id: string }>('/api/verification/requests', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Phase 9: Trust ----
  async trustOverview() {
    return request<TrustOverview>('/api/trust/me');
  },
  async trustHistory() {
    return request<{ items: TrustScoreRow[] }>('/api/trust/me/history');
  },
  async recomputeTrust() {
    return request<{ score: TrustScoreRow; history: TrustScoreRow[] }>('/api/trust/me/recompute', { method: 'POST' });
  },

  // ---- Phase 9: Disputes (user side) ----
  async listMyDisputes() {
    return request<{ items: DisputeSummary[] }>('/api/disputes');
  },
  async createDispute(data: { orderId: string; reasonCode: string; description: string }) {
    return request<{ id: string }>('/api/disputes', { method: 'POST', body: JSON.stringify(data) });
  },
  async disputeDetail(id: string) {
    return request<DisputeDetail>(`/api/disputes/${id}`);
  },
  async addDisputeMessage(id: string, bodyText: string) {
    return request<{ id: string }>(`/api/disputes/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: bodyText }) });
  },
  async addDisputeEvidence(id: string, data: { fileRef: string; description?: string; contentType?: string }) {
    return request<{ id: string }>(`/api/disputes/${id}/evidence`, { method: 'POST', body: JSON.stringify(data) });
  },
  async disputePolicies(orderId?: string) {
    const qs = orderId ? `?orderId=${encodeURIComponent(orderId)}` : '';
    return request<{ rules: Record<string, unknown> }>(`/api/disputes/policies${qs}`);
  },
  async adminDisputePolicies() {
    return request<{
      items: AdminDisputePolicy[];
      gaps: CountryPolicyGap[];
      countries: { id: string; code: string; name: string; nameAr: string | null; isActive: boolean }[];
    }>('/api/admin/policies/dispute');
  },
  async saveAdminDisputePolicy(data: {
    countryId: string | null;
    name: string;
    description?: string | null;
    rules: Record<string, number>;
    reason: string;
  }) {
    return request<{ id: string | null; countryId: string | null; created: boolean }>('/api/admin/policies/dispute', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async adminRetentionPolicies() {
    return request<{
      items: AdminRetentionPolicy[];
      gaps: CountryPolicyGap[];
      countries: { id: string; code: string; name: string; nameAr: string | null; isActive: boolean }[];
    }>('/api/admin/policies/retention');
  },
  async saveAdminRetentionPolicy(data: {
    countryId: string | null;
    name: string;
    description?: string | null;
    rules: {
      defaultRetentionDays?: number;
      legalHoldFinanciallyRequired?: boolean;
      preserves?: string[];
    };
    reason: string;
  }) {
    return request<{ id: string | null; countryId: string | null; created: boolean }>('/api/admin/policies/retention', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async listAdminCountries() {
    return request<{
      items: {
        id: string; code: string; iso3: string | null; name: string; nameAr: string | null;
        nameFr: string | null; currencyCode: string; defaultLanguage: string; isActive: boolean; activatedAt: string | null;
      }[];
    }>('/api/admin/countries');
  },
  async setCountryActivation(id: string, data: { isActive: boolean; reason: string }) {
    return request<{ id: string; code: string; isActive: boolean }>(`/api/admin/countries/${id}/activation`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async listDisputeAppeals(id: string) {
    return request<{ items: DisputeAppealRow[] }>(`/api/disputes/${id}/appeals`);
  },
  async createDisputeAppeal(id: string, reason: string) {
    return request<{ id: string }>(`/api/disputes/${id}/appeals`, { method: 'POST', body: JSON.stringify({ reason }) });
  },

  // ---- Phase 9: Admin engines ----
  async adminVerificationRequests(params: { status?: string; level?: string; q?: string; page?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.level) qs.set('level', params.level);
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    return request<{ items: Array<VerificationRequestRow & { userId: string; email: string | null }>; total: number; page: number; pageSize: number }>(`/api/admin/verification/requests?${qs.toString()}`);
  },
  async adminReviewVerification(id: string, decision: 'APPROVED' | 'REJECTED', notes?: string) {
    return request<{ id: string }>(`/api/admin/verification/requests/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, notes }) });
  },
  async adminTrust() {
    return request<{ items: Array<TrustScoreRow & { email: string | null }> }>('/api/admin/trust');
  },
  async adminTrustRecompute(userId: string) {
    return request<{ latest: TrustScoreRow }>(`/api/admin/trust/${userId}/recompute`, { method: 'POST' });
  },
  async adminRiskProfiles() {
    return request<{ items: RiskProfileRow[] }>('/api/admin/risk/profiles');
  },
  async adminRiskProfile(userId: string) {
    return request<RiskProfileRow & { events: RiskEventRow[] }>(`/api/admin/risk/profiles/${userId}`);
  },
  async adminRiskReassess(userId: string) {
    return request<RiskProfileRow & { events: RiskEventRow[] }>(`/api/admin/risk/profiles/${userId}/reassess`, { method: 'POST' });
  },
  async adminRiskEvents(params: { userId?: string; level?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.userId) qs.set('userId', params.userId);
    if (params.level) qs.set('level', params.level);
    return request<{ items: RiskEventRow[]; total: number }>(`/api/admin/risk/events?${qs.toString()}`);
  },
  async adminDisputes(params: { status?: string; q?: string; page?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    return request<{ items: DisputeSummary[]; total: number; page: number; pageSize: number }>(`/api/admin/disputes?${qs.toString()}`);
  },
  async adminDispute(id: string) {
    return request<DisputeDetail>(`/api/admin/disputes/${id}`);
  },
  async adminAssignDispute(id: string, reviewerUserId: string) {
    return request<{ id: string }>(`/api/admin/disputes/${id}/assign`, { method: 'POST', body: JSON.stringify({ reviewerUserId }) });
  },
  async adminUpdateDisputeStatus(id: string, status: string, note?: string) {
    return request<{ id: string }>(`/api/admin/disputes/${id}/status`, { method: 'POST', body: JSON.stringify({ status, note }) });
  },
  async adminDecideDispute(id: string, decision: string, note?: string) {
    return request<{ id: string }>(`/api/admin/disputes/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) });
  },
  async adminDisputeAppeals(id: string) {
    return request<{ items: DisputeAppealRow[] }>(`/api/admin/disputes/${id}/appeals`);
  },
  async adminReviewDisputeAppeal(id: string, appealId: string, status: 'ACCEPTED' | 'REJECTED', note?: string) {
    return request<{ id: string }>(`/api/admin/disputes/${id}/appeals/${appealId}/review`, { method: 'POST', body: JSON.stringify({ status, note }) });
  },

  // ---- Analytics (Phase 16) ----
  async myAnalyticsOverview() {
    return request<MyAnalyticsOverview>('/api/analytics/my-overview');
  },
  async myAnalyticsEvents(params: { limit?: number; eventName?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.eventName) qs.set('eventName', params.eventName);
    return request<{ items: Array<{ id: string; eventName: string; properties: Record<string, unknown> | null; createdAt: string }> }>(`/api/analytics/events?${qs.toString()}`);
  },
  async captureAnalyticsEvent(data: { eventName: string; properties?: Record<string, unknown> }) {
    return request<{ id: string }>('/api/analytics/events', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Admin Analytics ----
  async adminAnalyticsOverview() {
    return request<PlatformOverview>('/api/admin/analytics/overview');
  },
  async adminAnalyticsRetention() {
    return request<RetentionSnapshot>('/api/admin/analytics/retention');
  },
  async adminAnalyticsConversion() {
    return request<ConversionSnapshot>('/api/admin/analytics/conversion');
  },
  async adminAnalyticsRevenue() {
    return request<RevenueBreakdown>('/api/admin/analytics/revenue-breakdown');
  },
  async adminAnalyticsDailyKpis(days?: number) {
    const qs = new URLSearchParams();
    if (days) qs.set('days', String(days));
    return request<{ items: DailyKpiRow[] }>(`/api/admin/analytics/daily-kpis?${qs.toString()}`);
  },
  async adminAnalyticsRollup() {
    return request<{ inserted: number; items: DailyKpiRow[] }>('/api/admin/analytics/daily-kpis/rollup', { method: 'POST' });
  },
  async adminAnalyticsReports() {
    return request<{ items: DashboardReportRow[] }>('/api/admin/analytics/reports');
  },
  async adminCreateAnalyticsReport(data: { reportCode: string; title: string; reportData?: Record<string, unknown> }) {
    return request<{ id: string }>('/api/admin/analytics/reports', { method: 'POST', body: JSON.stringify(data) });
  },

  // ---- Messaging ----
  async listThreads(params: { q?: string; page?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    return request<{ items: ThreadSummary[]; page: number; pageSize: number; total: number }>(`/api/messages?${qs.toString()}`);
  },
  async openThread(data: { participantUserId: string; subject?: string; body: string }) {
    return request<{ threadId: string; messageId: string }>('/api/messages', { method: 'POST', body: JSON.stringify(data) });
  },
  async getThread(id: string) {
    return request<ThreadDetail>(`/api/messages/${id}`);
  },
  async sendMessage(threadId: string, body: string) {
    return request<{ id: string; createdAt: string; status: string }>(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },
  async markThreadRead(threadId: string) {
    return request<{ threadId: string }>(`/api/messages/${threadId}/read`, { method: 'POST' });
  },
  async searchMessages(q: string) {
    return request<MessagingSearchResponse>(`/api/messages/search?q=${encodeURIComponent(q)}`);
  },

  // ---- Notifications ----
  async listNotifications(params: { page?: number; pageSize?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    return request<NotificationListResponse>(`/api/notifications?${qs.toString()}`);
  },
  async unreadNotificationCount() {
    return request<{ count: number }>('/api/notifications/unread-count');
  },
  async markNotificationRead(id: string) {
    return request<{ id: string }>(`/api/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({ id }) });
  },
  async markAllNotificationsRead() {
    return request<{ count: number }>('/api/notifications/read-all', { method: 'POST' });
  },

  // ---- Ads ----
  async listCampaigns(params: { status?: string; page?: number; pageSize?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    return request<CampaignListResponse>(`/api/ads/campaigns?${qs.toString()}`);
  },
  async getCampaign(id: string) {
    return request<CampaignDetail>(`/api/ads/campaigns/${id}`);
  },
  async createCampaign(data: {
    advertiserId: string;
    advertiserType: string;
    title: string;
    objective: string;
    budget: string;
    currencyCode?: string;
    startsAt: string;
    endsAt?: string | null;
  }) {
    return request<CampaignDetail>(`/api/ads/campaigns`, { method: 'POST', body: JSON.stringify(data) });
  },
  async updateCampaign(id: string, data: Record<string, unknown>) {
    return request<CampaignDetail>(`/api/ads/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  async addCreative(campaignId: string, data: { type: string; title: string; body?: string | null; mediaUrl?: string | null; targetUrl?: string | null }) {
    return request<{ id: string }>(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async campaignStats(id: string) {
    return request<CampaignStats>(`/api/ads/campaigns/${id}/stats`);
  },
  async servedAds() {
    return request<{ items: ServedAdRow[] }>('/api/ads/served');
  },
  async myAdvertisers() {
    return request<{ items: Array<{ id: string; type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY'; name: string }> }>('/api/ads/my-advertisers');
  },
  async adsRecommendations() {
    return request<{
      kind: string;
      model: string;
      confidence: number;
      data: {
        totalCampaigns: number;
        activeCampaigns: number;
        totalSpent: string;
        totalBudget: string;
        averageCtr: number;
        averageConversionRate: number;
        bestObjective: string;
        note: string;
      };
      estimate: string;
    }>('/api/ai/ads-recommendations', { method: 'POST' });
  },
  async adminAdsSummary() {
    return request<{
      campaigns: number;
      activeCampaigns: number;
      totalSpent: string;
      totalBudget: string;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      conversionRate: number;
    }>('/api/admin/ads/summary');
  },

  // ---- AI Core ----
  async aiStatus() {
    return request<{ provider: string; providerAvailable: boolean; defaultModel: string; monthlyBudgetUsd: string; period: string; usageCurrent: number }>('/api/ai/status');
  },
  async aiModels() {
    return request<{ items: Array<{ key: string; displayName: string; provider: string; isActive: boolean }> }>('/api/ai/models');
  },
  async aiMyBudget() {
    return request<{ period: string; window: { start: string; end: string }; usage: { requests: number; tokensInput: number; tokensOutput: number; cost: string } }>('/api/ai/budgets/me');
  },
  async aiActivity() {
    return request<{ items: Array<{ id: string; requestType: string; model: string; tokensInput: number; tokensOutput: number; cost: string; createdAt: string }> }>('/api/ai/activity');
  },
  async aiRun(data: { requestType: string; system?: string; user: string; maxTokens?: number; model?: string }) {
    return request<{ requestId: string; kind: string; model: string; content: string; tokensInput: number; tokensOutput: number; cost: string }>('/api/ai/run', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async aiAgents() {
    return request<{ agents: Array<{ key: string; name: string; description: string; requiresHumanApproval: boolean }> }>('/api/ai/agents');
  },
  async aiCreateAgentTask(agentKey: string, input: Record<string, unknown>, requestedModel?: string) {
    return request<{
      id: string;
      agentKey: string;
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'awaiting_approval' | 'approved' | 'rejected';
      result?: unknown;
      error?: { message: string } | null;
    }>(`/api/ai/agents/${agentKey}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ input, requestedModel: requestedModel ?? undefined }),
    });
  },
  async aiMyTasks(agentKey?: string) {
    const path = agentKey ? `/api/ai/agents/${agentKey}/tasks` : '/api/ai/tasks';
    return request<{
      items: Array<{
        id: string;
        agentKey: string;
        status: string;
        result?: unknown;
        error?: { message?: string } | null;
        requiresApproval: boolean;
        createdAt: string;
      }>;
    }>(path);
  },
  async aiSmartFeatures(path: 'smart-search' | 'recommendations' | 'supplier-recommendations', body: Record<string, unknown>) {
    return request<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }>(`/api/ai/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async aiMarketAnalysis() {
    return request<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }>('/api/ai/market-analysis', { method: 'POST' });
  },
  async aiPriceIntelligence() {
    return request<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }>('/api/ai/price-intelligence', { method: 'POST' });
  },
  async aiSalesIntelligence() {
    return request<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }>('/api/ai/sales-intelligence', { method: 'POST' });
  },

  // ------------------------------------------------------------ library (customer)
  async listFavorites(params?: { entityType?: LibraryEntityType; page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.entityType) qs.set('entityType', params.entityType);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<LibraryListResponse<FavoriteRow>>(`/api/library/favorites${suffix}`);
  },
  async addFavorite(entityType: LibraryEntityType, entityId: string) {
    return request<{ id: string; created: boolean }>('/api/library/favorites', {
      method: 'POST',
      body: JSON.stringify({ entityType, entityId }),
    });
  },
  async removeFavorite(entityType: LibraryEntityType, entityId: string) {
    return request<{ id: string }>(`/api/library/favorites/${entityType}/${entityId}`, { method: 'DELETE' });
  },
  async listSavedItems(params?: { itemType?: LibraryEntityType; page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.itemType) qs.set('itemType', params.itemType);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<LibraryListResponse<SavedItemRow>>(`/api/library/saved${suffix}`);
  },
  async saveItem(itemType: LibraryEntityType, itemId: string, notes?: string | null) {
    return request<{ id: string; created: boolean }>('/api/library/saved', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemId, notes: notes ?? null }),
    });
  },
  async removeSavedItem(itemType: LibraryEntityType, itemId: string) {
    return request<{ id: string }>(`/api/library/saved/${itemType}/${itemId}`, { method: 'DELETE' });
  },
  async listSearchHistory(params?: { page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<LibraryListResponse<SearchHistoryRow>>(`/api/library/search-history${suffix}`);
  },
  async clearSearchHistory() {
    return request<{ removed: number }>('/api/library/search-history', { method: 'DELETE' });
  },
  async deleteSearchHistoryEntry(id: string) {
    return request<{ id: string }>(`/api/library/search-history/${id}`, { method: 'DELETE' });
  },

  // ---- Subscriptions (plans + own subscription are owned by the backend) ----
  async listSubscriptionPlans(target?: PlanTarget) {
    const suffix = target ? `?target=${target}` : '';
    return request<{ items: SubscriptionPlan[] }>(`/api/subscriptions/plans${suffix}`);
  },
  async mySubscription() {
    return request<{ subscription: MySubscription | null }>('/api/subscriptions/me');
  },
  async mySubscriptionInvoices() {
    return request<{ items: SubscriptionInvoice[] }>('/api/subscriptions/me/invoices');
  },
  async subscribeToPlan(planId: string, billingCycle: BillingCycle = 'MONTHLY') {
    return request<{ subscription: MySubscription }>('/api/subscriptions/subscribe', {
      method: 'POST',
      body: JSON.stringify({ planId, billingCycle }),
    });
  },
  async changeSubscriptionPlan(planId: string, billingCycle: BillingCycle = 'MONTHLY') {
    return request<{ subscription: MySubscription }>('/api/subscriptions/me/plan', {
      method: 'PATCH',
      body: JSON.stringify({ planId, billingCycle }),
    });
  },
  async cancelSubscription() {
    return request<{ cancelled: boolean }>('/api/subscriptions/me/cancel', { method: 'POST' });
  },
  async paySubscriptionInvoice(invoiceId: string, idempotencyKey?: string) {
    return request<{ checkoutUrl: string | null }>(`/api/subscriptions/me/invoices/${invoiceId}/pay`, {
      method: 'POST',
      body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
    });
  },

  // ---- Admin subscriptions (server enforces SUBSCRIPTION_MANAGE) ----
  async adminSubscriptionPlans() {
    return request<{ items: SubscriptionPlan[] }>('/api/subscriptions/admin/plans');
  },
  async adminSetPlanActive(planId: string, isActive: boolean) {
    return request<{ plan: SubscriptionPlan }>(`/api/subscriptions/admin/plans/${planId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  },
  async adminSubscriptions() {
    return request<{ items: AdminSubscription[] }>('/api/subscriptions/admin/subscriptions');
  },
  async adminSubscriptionInvoices() {
    return request<{ items: AdminSubscriptionInvoice[] }>('/api/subscriptions/admin/invoices');
  },
  async adminPendingSubscriptionInvoices() {
    return request<{ items: SubscriptionInvoice[] }>('/api/subscriptions/admin/invoices/pending');
  },
  async adminCollectSubscriptionInvoice(invoiceId: string, idempotencyKey?: string) {
    return request<CollectResult>(`/api/subscriptions/admin/invoices/${invoiceId}/collect`, {
      method: 'POST',
      body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
    });
  },
  async adminRunSubscriptionRollover() {
    return request<RolloverResult>('/api/subscriptions/admin/rollover', { method: 'POST' });
  },
  async adminExpireLapsedSubscriptions() {
    return request<ExpireLapsedResult>('/api/subscriptions/admin/expire-lapsed', { method: 'POST' });
  },

  // ---- Admin AI governance (server enforces AI_MANAGE / ADMIN_AI) ----
  async adminAiUsage() {
    return request<AiAdminUsage>('/api/admin/ai/usage');
  },
  async adminAiRequests(limit = 50) {
    return request<{ items: AiAdminRequestRow[] }>(`/api/admin/ai/requests?limit=${limit}`);
  },
  async adminAiBudgets() {
    return request<{ items: AiAdminBudget[] }>('/api/admin/ai/budgets');
  },
  async adminUpsertAiBudget(data: {
    userId?: string | null;
    roleTarget?: string | null;
    period: 'DAILY' | 'MONTHLY';
    maxRequests?: number | null;
    maxCost?: string | null;
    currencyCode?: string;
    isActive?: boolean;
  }) {
    return request<AiAdminBudget>('/api/admin/ai/budgets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async adminAiModels() {
    return request<{ items: AiAdminModel[] }>('/api/admin/ai/models');
  },
  async adminUpsertAiModel(data: {
    key: string;
    displayName: string;
    provider: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputPer1k?: string;
    outputPer1k?: string;
    currencyCode?: string;
    isActive?: boolean;
  }) {
    return request<AiAdminModel>('/api/admin/ai/models', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async adminAiAgents() {
    return request<{ items: AgentRegistryRow[] }>('/api/admin/ai/agents');
  },
  async adminAiTasks(params: { status?: string; agentKey?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.agentKey) qs.set('agentKey', params.agentKey);
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ items: AgentTaskRow[] }>(`/api/admin/ai/tasks${suffix}`);
  },
  async decideAgentTask(taskId: string, decision: 'APPROVE' | 'REJECT', reason?: string) {
    return request<AgentTaskDecision>(`/api/ai/tasks/${taskId}/${decision === 'APPROVE' ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: reason ?? null }),
    });
  },

  // ---- Admin observability (server enforces ADMIN_SYSTEM) ----
  async adminObservabilityMetrics() {
    return request<ObservabilityDashboard>('/api/admin/observability/metrics');
  },
  async adminObservabilityLogs(params: { level?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.level) qs.set('level', params.level);
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<ObservabilityLogRecord[]>(`/api/admin/observability/logs${suffix}`);
  },
  async adminObservabilityAlerts(params: { status?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ items: AlertEventRow[]; meta: { firing: ObservabilityFiringAlert[]; lastEvaluatedAt: string | null } }>(
      `/api/admin/observability/alerts${suffix}`,
    );
  },
  async adminEvaluateAlerts() {
    return request<AlertEvaluationResult>('/api/admin/observability/alerts/evaluate', { method: 'POST' });
  },

  // ---- Admin privacy / data-deletion desk (server enforces ADMIN/SUPER_ADMIN) ----
  async adminDeletionRequests(params: { stage?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.stage) qs.set('stage', params.stage);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<DeletionRequestRow[]>(`/api/admin/privacy/deletions${suffix}`);
  },
  async adminAdvanceDeletion(
    requestId: string,
    stage: DeletionStage,
    opts: { legalHoldOverride?: boolean } = {},
  ) {
    return request<{ success: boolean }>(`/api/admin/privacy/deletions/${requestId}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage, legalHoldOverride: opts.legalHoldOverride ?? false }),
    });
  },
  async adminRunRetentionSweep() {
    return request<RetentionSweepResult>('/api/admin/privacy/deletions/retention-sweep', {
      method: 'POST',
    });
  },
};

export function formatMoney(value: string | number | undefined | null, currencyCode = 'TND'): string {
  if (value === undefined || value === null || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat('fr-TN', { style: 'currency', currency: currencyCode }).format(num);
}

export function formatDate(value: string | Date | undefined | null): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('fr-TN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function apiCall<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (e) {
    if (e instanceof ApiClientError) {
      return { data: null, error: e.message };
    }
    return { data: null, error: e instanceof Error ? e.message : 'unknown error' };
  }
}