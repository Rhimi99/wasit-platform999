import { Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { MarketplacePage } from './pages/MarketplacePage';
import { CategoriesPage } from './pages/CategoriesPage';
import { CategoryPage, MarketPage } from './pages/MarketPages';
import { SearchPage } from './pages/SearchPage';
import { PriceComparisonPage } from './pages/PriceComparisonPage';
import { ProductDetailsPage } from './pages/ProductDetailsPage';
import { SuppliersPage, SuppliersDetailPage } from './pages/SuppliersPage';
import { MerchantsPage, MerchantsDetailPage } from './pages/MerchantsPage';
import { CompaniesPage, CompaniesDetailPage } from './pages/CompaniesPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages';
import { CheckoutPage } from './pages/CheckoutPage';
import { RequireAuth } from './components/layouts/AppLayout';
import { DashboardOverviewPage } from './pages/DashboardOverviewPage';
import { DashboardOrdersPage, DashboardOrderDetailPage } from './pages/DashboardOrdersPage';
import { DashboardProductsPage, DashboardCreateProductPage } from './pages/DashboardProductsPage';
import { DashboardProfilePage, DashboardSecurityPage, DashboardSettingsPage } from './pages/DashboardSimplePages';
import { DashboardMessagesPage } from './pages/DashboardMessagesPage';
import { DashboardTrustPage, DashboardVerificationPage, DashboardDisputesPage } from './pages/DashboardEnginesPages';
import { DashboardAdsPage, DashboardAnalyticsPage, DashboardAIPage, DashboardSubscriptionsPage } from './pages/DashboardBusinessPages';
import { DashboardInventoryPage, DashboardComparisonPage, DashboardSalesPage } from './pages/DashboardInventoryPages';
import { DashboardListPage, DashboardFinancePage, DashboardReportsPage, DashboardCustomersPage, DashboardBuyersPage, DashboardSuppliersPage, DashboardMerchantsListPage, DashboardMySuppliersPage, DashboardMyMerchantsPage } from './pages/DashboardListPages';
import { DashboardLibraryPage } from './pages/DashboardLibraryPage';
import { DashboardVideoStudioPage } from './pages/DashboardVideoStudioPage';
import { AdminOnly, StaffOnly, AdminAnalyticsPage, AdminDashboardPage, AdminUsersPage, AdminOrdersPage, AdminTransactionsPage, AdminLedgerPage, AdminAuditPage, AdminProductsPage } from './pages/AdminPages';
import { AdminVerificationPage, AdminTrustPage, AdminRiskPage, AdminDisputesPage } from './pages/AdminEnginesPages';
import { AdminPoliciesPage } from './pages/AdminPolicyPages';
import { AdminSubscriptionsPage } from './pages/AdminSubscriptionPages';
import { AdminAiPage } from './pages/AdminAiPage';
import { AdminObservabilityPage } from './pages/AdminObservabilityPage';
import { AdminPrivacyPage } from './pages/AdminPrivacyPage';
import { AdminAdsPage } from './pages/AdminAdsPage';
import { AdminTradePage } from './pages/AdminTradePage';
import { AdminReportsPage } from './pages/AdminReportsPage';
import { AdminFinancePage } from './pages/AdminFinancePage';
import { NotFoundPage, DashboardOnboardingPage } from './pages/OnboardingPage';
import { DemoBanner } from './components/DemoBanner';
import { CookieConsentBanner } from './components/CookieConsent';
import { DemoCustomerEntryPage } from './pages/DemoCustomerEntryPage';
import { DemoOwnerAuditPage } from './pages/DemoOwnerAuditPage';

/** Enabled only on the public demo build; production builds leave it unset. */
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

export default function App() {
  return (
    <>
      {DEMO_MODE && <DemoBanner />}
      <Routes>
      {/* Public */}
      <Route path="/" element={<HomePage />} />
      <Route path="/marketplace" element={<MarketplacePage />} />
      <Route path="/categories" element={<CategoriesPage />} />
      <Route path="/categories/:slug" element={<CategoryPage />} />
      <Route path="/markets/:code" element={<MarketPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/price-comparison" element={<PriceComparisonPage />} />
      <Route path="/products/:id" element={<ProductDetailsPage />} />
      <Route path="/suppliers" element={<SuppliersPage />} />
      <Route path="/suppliers/:id" element={<SuppliersDetailPage />} />
      <Route path="/merchants" element={<MerchantsPage />} />
      <Route path="/merchants/:id" element={<MerchantsDetailPage />} />
      <Route path="/companies" element={<CompaniesPage />} />
      <Route path="/companies/:id" element={<CompaniesDetailPage />} />

      {/* Auth */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      {/* Public-demo entry: opens a session for the seeded demo customer. The
          route is always registered; the backend decides whether auto-login is
          allowed (demo only, never production) and answers 404 everywhere else,
          which the page renders as "not available". Gating the route on a
          separate build flag only risked the two flags drifting apart and
          breaking the link. */}
      <Route path="/demo/customer" element={<DemoCustomerEntryPage />} />
      {/* Owner Audit Center: opens a real session for a whitelisted demo fixture
          and indexes every role desk + module. Same backend gate as the customer
          entry (demo only, 404 in production); no identity or credential ever
          travels in the URL. */}
      <Route path="/demo/owner" element={<DemoOwnerAuditPage />} />

      {/* Protected */}
      <Route path="/checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
      <Route path="/onboarding" element={<RequireAuth><DashboardOnboardingPage /></RequireAuth>} />
      <Route path="/dashboard" element={<RequireAuth><DashboardOverviewPage /></RequireAuth>} />
      <Route path="/dashboard/profile" element={<RequireAuth><DashboardProfilePage /></RequireAuth>} />
      <Route path="/dashboard/settings" element={<RequireAuth><DashboardSettingsPage /></RequireAuth>} />
      <Route path="/dashboard/security" element={<RequireAuth><DashboardSecurityPage /></RequireAuth>} />
      <Route path="/dashboard/messages" element={<RequireAuth><DashboardMessagesPage /></RequireAuth>} />
      <Route path="/dashboard/orders" element={<RequireAuth><DashboardOrdersPage /></RequireAuth>} />
      <Route path="/dashboard/library" element={<RequireAuth><DashboardLibraryPage /></RequireAuth>} />
      <Route path="/dashboard/orders/:id" element={<RequireAuth><DashboardOrderDetailPage /></RequireAuth>} />
      <Route path="/dashboard/products" element={<RequireAuth><DashboardProductsPage /></RequireAuth>} />
      <Route path="/dashboard/products/new" element={<RequireAuth><DashboardCreateProductPage /></RequireAuth>} />
      <Route path="/dashboard/inventory" element={<RequireAuth><DashboardInventoryPage /></RequireAuth>} />
      <Route path="/dashboard/comparison" element={<RequireAuth><DashboardComparisonPage /></RequireAuth>} />
      <Route path="/dashboard/sales" element={<RequireAuth><DashboardSalesPage /></RequireAuth>} />
      <Route path="/dashboard/finance" element={<RequireAuth><DashboardFinancePage /></RequireAuth>} />
      <Route path="/dashboard/reports" element={<RequireAuth><DashboardReportsPage /></RequireAuth>} />
      <Route path="/dashboard/suppliers" element={<RequireAuth><DashboardSuppliersPage /></RequireAuth>} />
      <Route path="/dashboard/customers" element={<RequireAuth><DashboardCustomersPage /></RequireAuth>} />
      <Route path="/dashboard/buyers" element={<RequireAuth><DashboardBuyersPage /></RequireAuth>} />
      <Route path="/dashboard/my-suppliers" element={<RequireAuth><DashboardMySuppliersPage /></RequireAuth>} />
      <Route path="/dashboard/my-merchants" element={<RequireAuth><DashboardMyMerchantsPage /></RequireAuth>} />
      <Route path="/dashboard/merchants-list" element={<RequireAuth><DashboardMerchantsListPage /></RequireAuth>} />
      <Route path="/dashboard/branches" element={<RequireAuth><DashboardListPage kind="branches" /></RequireAuth>} />
      <Route path="/dashboard/employees" element={<RequireAuth><DashboardListPage kind="employees" /></RequireAuth>} />
      <Route path="/dashboard/trust" element={<RequireAuth><DashboardTrustPage /></RequireAuth>} />
      <Route path="/dashboard/verification" element={<RequireAuth><DashboardVerificationPage /></RequireAuth>} />
      <Route path="/dashboard/disputes" element={<RequireAuth><DashboardDisputesPage /></RequireAuth>} />
      <Route path="/dashboard/ads" element={<RequireAuth><DashboardAdsPage /></RequireAuth>} />
      <Route path="/dashboard/analytics" element={<RequireAuth><DashboardAnalyticsPage /></RequireAuth>} />
      <Route path="/dashboard/ai" element={<RequireAuth><DashboardAIPage /></RequireAuth>} />
      <Route path="/dashboard/video-studio" element={<RequireAuth><DashboardVideoStudioPage /></RequireAuth>} />
      <Route path="/dashboard/subscriptions" element={<RequireAuth><DashboardSubscriptionsPage /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin" element={<RequireAuth><AdminOnly><AdminDashboardPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/analytics" element={<RequireAuth><AdminOnly><AdminAnalyticsPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/reports" element={<RequireAuth><AdminOnly><AdminReportsPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/users" element={<RequireAuth><AdminOnly><AdminUsersPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/products" element={<RequireAuth><AdminOnly><AdminProductsPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/trade" element={<RequireAuth><AdminOnly><AdminTradePage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/orders" element={<RequireAuth><AdminOnly><AdminOrdersPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/transactions" element={<RequireAuth><AdminOnly><AdminTransactionsPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/ledger" element={<RequireAuth><AdminOnly><AdminLedgerPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/finance" element={<RequireAuth><AdminOnly><AdminFinancePage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/audit" element={<RequireAuth><AdminOnly><AdminAuditPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/verification" element={<RequireAuth><StaffOnly><AdminVerificationPage /></StaffOnly></RequireAuth>} />
      <Route path="/admin/trust" element={<RequireAuth><StaffOnly><AdminTrustPage /></StaffOnly></RequireAuth>} />
      <Route path="/admin/risk" element={<RequireAuth><StaffOnly><AdminRiskPage /></StaffOnly></RequireAuth>} />
      <Route path="/admin/disputes" element={<RequireAuth><StaffOnly><AdminDisputesPage /></StaffOnly></RequireAuth>} />
      <Route path="/admin/policies" element={<RequireAuth><AdminOnly><AdminPoliciesPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/subscriptions" element={<RequireAuth><AdminOnly><AdminSubscriptionsPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/ai" element={<RequireAuth><AdminOnly><AdminAiPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/observability" element={<RequireAuth><AdminOnly><AdminObservabilityPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/privacy" element={<RequireAuth><AdminOnly><AdminPrivacyPage /></AdminOnly></RequireAuth>} />
      <Route path="/admin/ads" element={<RequireAuth><AdminOnly><AdminAdsPage /></AdminOnly></RequireAuth>} />

      <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <CookieConsentBanner />
    </>
  );
}