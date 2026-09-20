# UI SCREEN MAP — WASIT BUSINESS GLOBAL

خريطة الشاشات العامة المطلوبة في المنصة. ملاحظة: **الأولوية حالياً للـ Core (Backend كامل)**؛ الواجهة (React/Vite/Tailwind/Shadcn) قيد التخطيط وفق هذه الخريطة.

## العامة (Marketplace)

| الشاشة | Route مقترح | الوظيفة |
| --- | --- | --- |
| Home | `/` | ترحيب + فئات + مميزون |
| Marketplace | `/marketplace` | منتجات/فئات |
| Categories | `/categories` | شجرة الفئات |
| Category Landing | `/categories/:slug` | صفحة تصنيف (canonical + CollectionPage JSON-LD + منتجات حقيقية) |
| Market Landing | `/markets/:code` | صفحة سوق بلد (canonical + Place JSON-LD + منتجات البلد) |
| Product Search | `/search?q=` | WASIT SEARCH ENGINE |
| Product Details | `/products/:slug` | تفاصيل + صور + SKU + سعر + MOQ |
| Supplier Directory | `/suppliers` | دليل موردين |
| Supplier Profile | `/suppliers/:id` | ملف مورد + Trust |
| Merchant Directory | `/merchants` | تجار |
| Company Profile | `/companies/:id` | ملف شركة |
| Price Comparison | `/price-comparison?query=` | مقارنة أسعار/موردين |
| Business Calculator | `/tools/calculator` | حاسبة هامش/عمولة |
| Business/Market Map | `/map` | خريطة أعمال/أسواق |

## حسابات حسب الدور

### CUSTOMER (Dashboard)
Dashboard, Profile, Orders, Favorites, Saved Products, Saved Suppliers, Messages, Notifications, Recommendations, Search History, Verification, Disputes, Security, Settings.

### MERCHANT (Dashboard)
Overview, Products, Inventory, Orders, Customers, Suppliers, Price Comparison, Sales, Expenses, Profit, Analytics, Messages, Advertising, AI Tools, Trust Score, Verification, Disputes, Settings.

### SUPPLIER (Dashboard)
Overview, Company Profile, Products, Catalog, Inventory, Orders, Buyers, Merchants, Offers, Price Management, Messages, Advertising, Analytics, AI Tools, Trust Score, Verification, Disputes, Settings.

### COMPANY (Dashboard)
Company Overview, Branches, Products, Suppliers, Buyers, Employees, Orders, Finance, Analytics, Advertising, AI, Reports, Verification, Trust, Security.

## Admin (Dashboard)
Users, Merchants, Suppliers, Companies, Products, Categories, Orders, Transactions, Payments, Refunds, Commissions, Subscriptions, Ads, AI, Trust, Risk, Verification, Disputes, Countries, Currencies, Languages, Policies, Reports, Audit Logs, KPIs, System Health.

### محركات الحماية (PHASE 9 — مكتملة)

- `/dashboard/verification` — `DashboardVerificationPage.tsx`: حالة التحقق الحالية + المستويات الأربعة القابلة للتقديم + نموذج تقديم طلب (level/documentType/ref) + قائمة الطلبات الأخيرة (live مع `/api/verification`)
- `/dashboard/trust` — `DashboardTrustPage.tsx`: بطاقة الدرجة (score 0-100 + level LOW/MEDIUM/HIGH + summary قابل للتفسير عبر عوامل موثقة) + زر "إعادة احتساب الدرجة" + جدول السجل (live مع `/api/trust`)
- `/dashboard/disputes` — `DashboardDisputesPage.tsx`: قائمة نزاعاتي + فتح نزاع على طلب + تفاصيل (أحداث/رسائل/أدلة) (live مع `/api/disputes`)
- Admin (staff roles ADMIN/SUPER_ADMIN/SUPPORT/RISK/DISPUTE عبر `StaffOnly`):
  - `/admin/verification` — `AdminVerificationPage.tsx`: قائمة الطلبات + مراجعة (APPROVED/REJECTED + ملاحظات)
  - `/admin/trust` — `AdminTrustPage.tsx`: كل الدرجات + إعادة احتساب
  - `/admin/risk` — `AdminRiskPage.tsx`: ملفات المخاطر + الأحداث + إعادة التقييم
  - `/admin/disputes` — `AdminDisputesPage.tsx`: كل النزاعات + إسناد + تغيير حالة + قرار
- `StaffOnly` guard في `App.tsx` + روابط الشريط الجانبي في `AppSidebar.tsx`
- ترجمات كاملة ar/en (fr/zh عبر fallback)

### الرسائل والإشعارات (مكتملة — كل الأدوار)

- `/dashboard/messages` — `DashboardMessagesPage.tsx`: رفان (قائمة محادثات + محادثة مفتوحة) مع بحث مباشر، شارات غير مقروء، إيصال قراءة (SENT/DELIVERED/READ)، صندوق إرسال، نافذة "محادثة جديدة"
- `NotificationsBell` في `TopHeader` (كل أدوار اللوحة): جرس + عداد غير مقروء + قائمة منسدلة + "تحديد الكل كمقروء" + رابط مباشر للرسائل
- Backend: `/api/messages` + `/api/notifications` (تفاصيل في `API_SPECIFICATION.md`)

### مكتبة العميل (مكتملة — B6)

- `/dashboard/library` — `DashboardLibraryPage.tsx`: ثلاث تبويبات (المفضلة / المحفوظات / سجل البحث)، إزالة عنصر، مسح السجل، روابط مباشرة للكيان، شارة "لم يعد متاحًا" عند حذف الكيان
- صفحة المنتج `/products/:id`: زرّا ⭐ المفضلة و + الحفظ للمستخدم المسجَّل (لا يظهران للزائر)
- الشريط الجانبي: عنصر ⭐ المفضلة لأصحاب الميزة `library` (CUSTOMER/MERCHANT/SUPPLIER/COMPANY/MARKETER)
- Backend: `/api/library` (تفاصيل في `API_SPECIFICATION.md`)

### المصادقة الثنائية وخطوة الدخول الثانية (مكتملة — C4)

- `/login` — `LoginPage.tsx`: عند حساب مُفعَّل عليه MFA تُعرض خطوة ثانية لرمز تطبيق المصادقة (`autocomplete="one-time-code"`)؛ لا تُنشأ جلسة من خطوة كلمة المرور وحدها.
- `/dashboard/security` — `DashboardSecurityPage.tsx` + بطاقة `MfaCard`: حالة MFA، تفعيل (enroll) مع عرض السر وأكواد الاسترداد مرة واحدة، تأكيد (confirm)، إعادة توليد أكواد الاسترداد (regenerate)، وتعطيل (disable) — كلها live مع `/api/auth/mfa/*`.
- Backend: `/api/auth/login` + `/api/auth/mfa/challenge` (تفاصيل في `API_SPECIFICATION.md`).

## اتجاهات التنفيذ

- React + TypeScript + Vite + Tailwind + shadcn/ui.
- **RTL/LTR**: إعداد dir ديناميكي حسب locale.
- **التوطين**: i18n keys (ar/fr/en).
- **Responsive**: أولاً Desktop لكن Mobile-ready (PWA لاحقاً).
- **SEO Architecture (منفَّذ — B1)**: مكوّن `SeoHead` (title/description/OG/canonical/robots/JSON-LD) مربوط بصفحات Home/Marketplace/Search/Product/Suppliers/Merchants/Companies/Categories/Market؛ `/sitemap.xml` ديناميكي و`/robots.txt` من الخادم؛ `GET /api/seo/structured-data/:type/:id` لـ PRODUCT/SUPPLIER/COMPANY/MERCHANT/CATEGORY/COUNTRY. Marketplace/Search → `noindex`. تفاصيل في `API_SPECIFICATION.md`.
- ربط كل شاشة بـ Backend حقيقي (نفس الـ API في API_SPECIFICATION).