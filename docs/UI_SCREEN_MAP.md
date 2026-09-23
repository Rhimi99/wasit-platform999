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

### إدارة الجلسات (مكتملة — B12)

- `/dashboard/security` — `DashboardSecurityPage.tsx`: جدول الجلسات + عمود «إجراءات» بزر **إنهاء الجلسة** (`session-revoke-<id>`) مربوط بـ`POST /api/auth/sessions/revoke`، وسم `(الجهاز الحالي)` من `isCurrent`، رسالة نجاح. القائمة تُخفي الجلسات المُلغاة/المنتهية.
- ترجمات كاملة ar/fr/en/zh.

### إدارة المنتجات الإدارية (مكتملة — B13)

- `/admin/products` — `AdminProductsPage.tsx`: جدول المنتجات + عمود «إجراءات» بزر **إيقاف** (`admin-product-suspend-<id>`) أو **إعادة تنشيط** (`admin-product-reactivate-<id>`) حسب الحالة، مربوط بـ`PATCH /api/products/:id/suspend` و`PATCH /api/products/:id/status`.
- الصفوف موسومة `data-testid="admin-product-<id>"`؛ يستعمل مفتاح i18n الموجود `admin.users.activate`.

### دوائر التحقق الثقة المخاطر (تحقق من الواجهة — M1)

- `/dashboard/verification` — `DashboardVerificationPage.tsx`: badges للمستويات + نموذج «طلب جديد» بزر `verification-submit` مربوط بـ`POST /api/verification/requests`؛ بعد الإرسال تظهر رسالة `verification.submitted` ويُعاد تحميل الحالة.
- `/admin/verification` — `AdminVerificationPage.tsx`: كل صف `admin-verification-<id>` بزرّي `admin-verification-approve-<id>` / `admin-verification-reject-<id>` مربوطين بـ`POST /api/admin/verification/requests/:id/review`؛ القرار يظهر فورًا في الحالة وبعدها في صفحة المستخدم.
- `/admin/trust` و`/admin/risk` — جداول حيّة من `GET /api/admin/trust` و`/api/admin/risk/profiles|events` مع إعادة الحساب.

### مكتب إعلانات الأدمن (مكتمل — B15)

- `/admin/ads` — `AdminAdsPage.tsx` (محروس بـ`AdminOnly`، مدخل تنقّل «الإعلانات» في `AppSidebar`): KPIs (`admin-ads-kpi-campaigns/active/spent/ctr`) من `GET /api/admin/ads/summary`، جدول `admin-ads-table` لكل حملات المعلنين مع اسم المعلن وبريد المالك من `GET /api/admin/ads/campaigns`، وأزرار إشراف (`admin-ads-active|paused|completed-<id>`) مبنية من آلة الحالة الفعلية.
- الخادم: `updateCampaign`/`addCreative` تُعفى من حرس الملكية من يملك `CAMPAIGN_MANAGE` — الكتابة تطابق نطاق مسارات القراءة؛ غيرهما يبقى 403.
- ترجمات كاملة ar/fr/en/zh.

### آلة حالة الحملات الإعلانية + حرس إيقاف المنتج (مكتملة — B14)

- `/dashboard/ads` — `DashboardAdsPage.tsx`: بطاقة الحملة (`ads-campaign-<id>`) تعرض الأزرار وفق آلة الحالة الحقيقية فقط: `DRAFT` → تفعيل (`ads-activate-<id>`) + إلغاء (`ads-cancel-<id>`)؛ `ACTIVE` → إيقاف مؤقت (`ads-pause-<id>`) + إنهاء (`ads-end-<id>`)؛ `PAUSED` → استئناف (`ads-resume-<id>`) + إلغاء + إنهاء؛ `COMPLETED`/`CANCELLED` بلا أي انتقال (كان زر الاستئناف يظهر خطأً فيُرفض بـ409).
- `/dashboard/products` — `DashboardProductsPage.tsx`: صف المنتج الموقوف إداريًا يعرض إشعارًا (`product-suspended-<id>`, مفتاح `product.suspendedNotice` في ar/fr/en/zh) **بدل** زر النشر؛ زر الحالة `product-status-<id>` لباقي الحالات. **زر «تعديل» (`product-edit-<id>`)** يفتح `EditProductModal` (`product-edit-form`: name/nameAr/category/price/moq/unit/intent/description) مُعبّأ من `GET /api/products/:id` ويحفظ عبر `PATCH /api/products/:id` ثم يُعيد تحميل القائمة ويرى المستخدم القيم الجديدة؛ الزر مخفي للمنتج الموقوف إداريًا.
- الخادم: `PATCH /api/products/:id/status` يرفض (403) محاولة أي غير أدمن رفع `SUSPENDED` — إجراء الإنفاذ الإداري غير قابل للعكس من الطرف المعني.
- ترجمات كاملة ar/fr/en/zh.


### إدارة المستخدمين (مكتملة — B11)

- `/admin/users` — `AdminUsersPage.tsx`: جدول بحالة التفعيل + عمود «إجراءات» بزر **إيقاف الحساب / إعادة التنشيط** مربوط بـ`PATCH /api/admin/users/:id/status` (Audit `ADMIN.USER_STATUS`)، مع حالة انتظار ورسالة نجاح.
- ترجمات كاملة ar/fr/en/zh.

### اقتصاديات الوحدة (مكتملة — B9)

- `/admin/analytics` — `AdminAnalyticsPage.tsx`: بطاقة «اقتصاديات الوحدة» (`admin-unit-economics`): CAC، LTV المحقق، LTV المتوقع (موسوم صراحةً بأنه ليس حقيقة)، نسبة LTV/CAC، هامش المساهمة، الافتراضات، والمصادر — من `GET /api/admin/analytics/unit-economics`. وبطاقة «أفواج الاكتساب» (`admin-cohorts`): جدول شهري (عملاء جدد/GMV/الهامش) من `GET /api/admin/analytics/cohorts`. صلاحية `ADMIN_ANALYTICS` + Audit `ANALYTICS.UNIT_ECONOMICS_READ`.
- `/admin/reports` — `AdminReportsPage.tsx` (محروس بـ`AdminOnly`، مدخل تنقّل «التقارير» في `AppSidebar`): نموذج إنشاء تقرير (`admin-reports-form`: `admin-report-code/title/data` + `admin-report-submit` يرفض JSON غير صالح في الواجهة) وجدول `admin-reports-table` لكل التقارير المحفوظة من `GET /api/admin/analytics/reports`، وزر `admin-report-view-<id>` يبدّل عرض المحتوى المخزّن في `admin-report-detail`. صلاحية `admin:analytics` على الخادم.
- ترجمات كاملة ar/fr/en/zh.

### مكتب حوكمة الذكاء الاصطناعي (مكتمل — B17)

- `/admin/ai` — `AdminAiPage.tsx`: تبويب **النماذج** فيه نموذج إنشاء/تحديث (`admin-ai-model-form`: key/name/provider/context/maxout/currency/input/output + مفتاح التفعيل) مربوط بـ`POST /api/admin/ai/models` (upsert بـ`key`)، وكل صف (`admin-ai-model-<key>`) فيه زر **تعديل** (`admin-ai-model-edit-<key>` يملأ النموذج ويبدّله إلى تحديث) وزر **تفعيل/إيقاف** (`admin-ai-model-toggle-<key>`).
- تبويب **الميزانيات**: نموذج (`admin-ai-budget-form`: الهدف حسب الدور أو المستخدم + الدورة + حد الطلبات/الكلفة + العملة) مربوط بـ`POST /api/admin/ai/budgets` (upsert لهدف+دورة، يرفض الخادم إرسال `userId` و`roleTarget` معًا)، وكل صف (`admin-ai-budget-<id>`) فيه زر تفعيل/إيقاف (`admin-ai-budget-toggle-<id>`).
- Audit على الخادم: `AI.MODEL_UPSERTED` و`AI.BUDGET_UPSERTED`؛ الصلاحية `AI_MANAGE`/`ADMIN_AI` بلا تغيير.
- ترجمات كاملة ar/fr/en/zh.

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