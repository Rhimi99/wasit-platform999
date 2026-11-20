# WASIT BUSINESS GLOBAL — FULL PROJECT COVERAGE AUDIT

**نوع التقرير:** PARTIAL AUDIT (جرد ثابت / Static audit — read-only)
**تاريخ الإعداد:** 2026-11-04
**المسار:** `/workspace/project`
**الفرع / HEAD:** `master` @ `e43dee4017d2848e37d03d13025a33890adb483f`
**المنهجية:** فحص ثابت للكود والمخطّط والاختبارات وملفات CI/الإعداد. لم تُشغَّل قاعدة بيانات ولم تُنفَّذ اختبارات في هذه الجولة.
**حدود المهمة:** لم يُعدَّل أي كود، ولم يُنفَّذ commit/push/migration، ولم تُلمس الحسابات أو الإعدادات. الملف الوحيد المنشأ هو هذا التقرير.

> **تحديث DOC-ALIGN-01 (2026-11-04):** أُعيدت مواءمة هذا التقرير مع الكود الفعلي بعد إنجاز **SEC-03** و**PERM-01A/B/C**. التعديل **توثيقي بحت** (لا كود ولا اختبارات). ما تغيّر: حالة SEC-03 وPERM-01، أعداد الاختبارات، تصحيح عدد صلاحيات ADMIN (`81` لا `79`؛ الناقص `30` لا `31`)، وبصمة `GAP_REGISTER.md`. الأقسام غير المفحوصة بقيت موسومة `NOT_VERIFIED`. التفاصيل في **القسم 16**.

> **قاعدة الدليل في هذا التقرير:** كل استنتاج مهم مرتبط بمسار ملف واسم دالة/مسار/اختبار. ما لم يُفحَص مباشرة يُوسَم `NOT_VERIFIED` صراحةً. وجود API أو صفحة **لا** يُعدّ دليلاً على أن الوظيفة تعمل.

---

## 1. الملخّص التنفيذي

WASIT BUSINESS GLOBAL مستودع monorepo ناضج وظيفياً: ثلاث حزم (`@wasit/server`, `@wasit/web`, `@wasit/shared`)، ~54 ألف سطر كود، ~271 تسجيل مسار Backend، 94 جدولاً، 27 migration، و73 ملف اختبار خلفي + 33 ملف E2E (كان 69 قبل إضافة ملفات SEC-03/PERM-01A/B/C).

**ما يعمل وموثَّق بأدلة قوية:** المصادقة والجلسات (session cookie + revoke)، RBAC المصفوفي (10 أدوار)، دورة حياة الطلب، محرّك العمولة/الرسوم، طبقة التسوية (Settlement) والمستحقات (Payout) والمطابقة (Reconciliation)، محرّك الضرائب، Webhook الدفع مع تحقّق HMAC وIdempotency، سجلات التدقيق، الخصوصية (consent/export/deletion/retention)، ومحرّك اشتراكات مع مجدول (scheduler) للتدوير/الانتهاء.

**ما هو ناقص أو جزئي بشكل مؤكَّد:**

- **AI ليس تشغيلياً حقيقياً**: 11 وكيلاً موجودون بمنطق `executors.ts` يقرأ بيانات حقيقية، لكن **لا** يوجد Supervisor ولا Tool Gateway ولا ذاكرة/سياق ولا Kill Switch ولا تنفيذ مجدول. المزوّد الافتراضي هو منطق محلي (`LocalHeuristicProvider`) لا LLM.
- **71 مسار Backend بلا أي مستدعٍ من الواجهة**، منها كل مسارات المال في `admin/finance/*` (تسويات/مستحقات/إيصالات/مطابقة) وكل `admin/tax/*` و`admin/privacy/*` و`revenue/*` و`risk/*`.
- **لا اختبارات لواجهة الويب** ولا للحزمة المشتركة (0 ملف).
- **نواقص أمنية/تشغيلية**: لا CSRF صريح، لا Error tracking، النسخ الاحتياطي محلي فقط، مفاتيح AI/الدفع الإنتاجية غائبة.
- **عوائق خارجية (قانونية/تجارية)**: ToS/Privacy/DPA/KYC/AML وعقود مزوّدي الدفع غير متوفّرة.

**الحكم على الاكتمال:** **PARTIAL AUDIT** — لم تُشغَّل الاختبارات ولا E2E في هذه الجولة، وعدد من المجالات مصنّف `NOT_VERIFIED` (انظر القسم 14).

---

## 2. الحالة الفعلية للمستودع

| البند | القيمة | الدليل |
|---|---|---|
| المسار | `/workspace/project` | `git status` |
| الفرع | `master` | `git status -sb` → `## master...origin/master` |
| HEAD | `e43dee4` | `git log -1` |
| المزامنة | 0 خلف / 0 أمام | `git status -sb` |
| Stashes | لا يوجد | `git stash list` |
| عمليات Git مغيّرة | لا شيء | لم يُنفَّذ أي commit/push/reset/checkout |

**شجرة العمل (كما هي، محفوظة دون تعديل):** 22 ملفاً معدّلاً + ملفات جديدة (غير متتبَّعة) — **لم يُودَع منها شيء**.

```
 M e2e/order-lifecycle.spec.ts                        (SEC-03)
 M packages/server/src/middleware/auth.ts             (PERM-01C)
 M packages/server/src/modules/admin/analytics-routes.ts (PERM-01C)
 M packages/server/src/modules/admin/engines-routes.ts   (PERM-01A)
 M packages/server/src/modules/admin/routes.ts           (PERM-01A)
 M packages/server/src/modules/companies/routes.ts       (PERM-01C)
 M packages/server/src/modules/inventory/routes.ts       (PERM-01B)
 M packages/server/src/modules/inventory/service.ts      (PERM-01B)
 M packages/server/src/modules/merchants/routes.ts       (PERM-01C)
 M packages/server/src/modules/orders/service.ts         (SEC-03)
 M packages/server/src/modules/products/routes.ts        (SEC-01/02)
 M packages/server/src/modules/suppliers/routes.ts       (PERM-01C)
 M packages/server/src/modules/tax/routes.ts             (PERM-01C)
 M packages/server/tests/inventory.test.ts               (SEC-03)
 M packages/server/tests/product-suspension.test.ts      (SEC-01/02)
 M packages/shared/src/constants/permissions.ts          (PERM-01B)
 M packages/shared/src/constants/rbac.ts                 (PERM-01B)
 M packages/web/src/App.tsx                              (PERM-01A)
 M packages/web/src/lib/demo-owner-catalog.ts            (PERM-01A/C)
 M packages/web/src/lib/rbac.ts                          (PERM-01B/C)
 M packages/web/src/pages/AdminPages.tsx                 (PERM-01A)
 M packages/web/src/pages/DashboardInventoryPages.tsx    (PERM-01B)
?? docs/FULL_PROJECT_COVERAGE_AUDIT.md
?? docs/GAP_REGISTER.md
?? docs/PERM-01C_RBAC_CLEANUP.md
?? docs/management/
?? packages/server/tests/order-confirmation-payment-guard.test.ts (SEC-03)
?? packages/server/tests/perm01a-staff-desk-access.test.ts        (PERM-01A)
?? packages/server/tests/perm01b-inventory-product-permissions.test.ts (PERM-01B)
?? packages/server/tests/perm01c-rbac-cleanup.test.ts             (PERM-01C)
```

**تحقّق سلامة الأعمال السابقة (sha256):**

| الملف | البصمة | الحالة |
|---|---|---|
| `docs/GAP_REGISTER.md` | `a28163a7f8a8572673a04b26f7793db1081a35b3c640b5be58fdeae59d30ce97` | ⚠️ تغيّرت بعد إضافة توثيق PERM-01C (كانت `193f53ac…` وقت الإعداد) — متّسقة داخلياً مع الكود الحالي |
| `docs/management/WASIT-Admin-Permissions-Guide-AR.pdf` | `a32516fa74645cacfcd925d0e5080632559d29dc554774ae7578c2afb2fafe11` | ✅ لم تتغيّر (الـPDF لم يُعَد توليده) |

> **ملاحظة DOC-ALIGN-01:** مرجع البصمة القديم (`/tmp/audit-baseline/protected.sha`) لم يعد موجوداً في هذه البيئة، فتعذّر إعادة التحقق الآلي منه؛ استُعيض بالبصمة الفعلية الحالية أعلاه. لم يُعَد توليد أي أصل إداري.

**إصلاحات الكود غير المُودَعة (SEC/PERM) — ملخّص بالأدلة:**

```ts
// SEC-01/02 — products/routes.ts:77
function hasProductManageAuthority(roles: UserRole[]): boolean {
  return userHasAnyRole(roles, PERM_PRODUCT_MANAGE);
}
// مُطبَّقة في 3 مواضع: POST / (سطر 128)، PATCH /:id/status (144)، PATCH /:id (166)
// + PATCH /:id/suspend محروس بـ requirePermission(PRODUCT_MANAGE) (سطر 180)

// SEC-03 — orders/service.ts:68
async function assertPaymentConfirmedForOrder(db, order) { … }
// يُستدعى في updateOrderStatus (سطر 461-462) قبل أي أثر مخزون؛
// انتقال ذرّي داخل db.transaction + UPDATE مشروط بـfromStatus (منع الخصم المزدوج)

// PERM-01B — inventory/routes.ts:53
const inventoryRead  = requirePermission(INVENTORY_READ, INVENTORY_READ_ALL);
const inventoryWrite = requirePermission(INVENTORY_UPDATE, INVENTORY_MOVEMENT_CREATE);

// PERM-01C — middleware/auth.ts
export function requireRoleOrPermission(role: UserRole, permission: Permission) { … }
```

---

## 3. خريطة بنية المشروع

### 3.1 الحزم والأحجام

| الحزمة | الملفات | الأسطر (تقريبية) | الدليل |
|---|---|---|---|
| `packages/server` (src) | 205 | 33,961 | `find packages/server/src -name '*.ts'` |
| `packages/web` (src) | 67 | 20,292 | `find packages/web/src -name '*.ts*'` |
| `packages/shared` (src) | 8 | — | `find packages/shared/src -name '*.ts'` |

### 3.2 نقاط الدخول والبنية

- **Backend:** `packages/server/src/index.ts` → `app.ts`. Hono app يربط 43 وحدة عبر `app.route('<prefix>', <module>)`. المسارات المُثبَّتة تشمل: `auth, health, products, orders, suppliers, merchants, companies, search, price-comparison, directory, library, categories, inventory, ads, ai, media, messages, notifications, verification, trust, risk, disputes, analytics, revenue, geo, subscriptions, privacy, payments, payment-webhooks, admin, admin/ai, admin/analytics, admin/observability, admin/tax, admin/finance, admin/policies, admin/countries, admin/privacy, seo` + جذور `'/'`.
- **Frontend:** `packages/web/src/App.tsx` — **74** `<Route>`، و**37** ملف صفحة في `packages/web/src/pages/*.tsx`. عميل الـAPI: `packages/web/src/lib/api.ts` (**195** دالة، **178** مساراً فريداً).
- **Shared:** `packages/shared/src/constants/{permissions,roles,rbac}.ts` (مصدر الحقيقة للـRBAC)، `types/models.ts`، `errors/api-error.ts`.
- **Middleware:** `packages/server/src/middleware/` — `auth.ts` (`optionalAuth`/`requireAuth`/`requirePermission`/`requireRole`)، `validate.ts` (`validateBody`/`validateQuery`)، `security-headers`، `errors`، `observability`، `core`.
- **Jobs/Background:** `packages/server/src/lib/scheduler.ts` (`startScheduler`) — وظائف دورية: `rolloverDueSubscriptions`، `expireLapsedSubscriptions`، `advanceDueDeletionRetentions` (privacy retention sweep)، `resolveRateLimitStore(db).purgeExpired`، `evaluateAlerts`. لا يوجد طابور خارجي (لا Redis/BullMQ/RabbitMQ/Kafka).
- **الخدمات المشتركة:** `lib/audit.ts` (writeAudit)، `lib/notifications-service.ts`، `lib/security.ts` (hashToken)، `lib/ids.ts` (newId)، `lib/rate-limit/` (memory + postgres)، `lib/mail/resolve.ts`، `lib/sms/resolve.ts`، `lib/cache/resolve.ts`، `lib/media/resolve.ts`، `lib/currency-scope.ts`، `lib/payments/` (clictopay، resolve).

### 3.3 التكامل بين الطبقات

تدفّق قياسي: `App.tsx` → `lib/api.ts` → `/api/*` (Hono route) → `modules/<x>/routes.ts` → `modules/<x>/service.ts` → `db/schema/*` (Drizzle) → PostgreSQL. يُضاف Middleware (`requireAuth`/`requirePermission`) + `validateBody` + `writeAudit` في المسارات الحسّاسة.

### 3.4 أجزاء معزولة أو غير مستخدمة

- **جداول معرّفة بلا استخدام** خارج `db/schema/` (تحقّق مباشر عبر `grep`):
  - `reviews` (`db/schema/trust.ts:94`) — **لا استخدام إطلاقاً** (لا route، لا service).
  - `commissions` — لا استخدام خارج المخطّط.
  - `company_branches` — لا استخدام خارج المخطّط.
  - `notification_preferences` — لا استخدام خارج المخطّط.
  - `rate_limit_counters` — **مُستخدَم** عبر SQL خام في `lib/rate-limit/postgres.ts:24` (ليس جدولاً ميتاً).

---

## 4. جرد الوظائف التجارية

> التصنيف حصري من: `COMPLETE_AND_TESTED` / `IMPLEMENTED_BUT_INSUFFICIENT_TESTS` / `PARTIALLY_IMPLEMENTED` / `BACKEND_ONLY` / `FRONTEND_ONLY` / `PRESENT_BUT_NOT_FUNCTIONAL` / `MISSING` / `SECURITY_OR_PERMISSION_GAP` / `EXTERNAL_DEPENDENCY` / `NOT_VERIFIED`.

| المجال | الوظيفة | Frontend | Backend/API | Database | Tests | الحالة | الأدلة | النواقص |
|---|---|---|---|---|---|---|---|---|
| الحسابات | تسجيل/دخول/خروج | ✅ | `auth/routes.ts` `/register`,`/login`,`/logout` | `users`,`sessions` | `auth.spec.ts`, `security-sessions.spec.ts` | COMPLETE_AND_TESTED | — | — |
| الحسابات | MFA (TOTP + recovery) | ✅ | `/mfa/enroll`,`/mfa/confirm`,`/mfa/verify`,`/mfa/recovery-codes` | `sessions` | `mfa.spec.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | لا إلزام MFA للموظفين |
| الحسابات | استعادة كلمة المرور | ✅ | `/forgot-password`,`/reset-password` | — | — | NOT_VERIFIED | — | لم يُعثر على اختبار مباشر |
| الحسابات | تحقّق بريد/هاتف | ✅ | `/verify-email`,`/phone/send`,`/phone/verify` | — | — | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | `dev/*` endpoints مفتوحة في التطوير |
| الأدوار | RBAC مصفوفي | ✅ | `shared/constants/rbac.ts` | `roles`,`user_roles` | `rbac.spec.ts` | COMPLETE_AND_TESTED | — | — |
| المنتجات | CRUD + نشر/إيقاف | ✅ | `products/routes.ts` | `products` | `product-suspension.test.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | SEC-01/02 | تعديلات SEC غير مُودَعة |
| المنتجات | بحث/تصفية | ✅ | `search/routes.ts` | — | `marketplace.spec.ts` | COMPLETE_AND_TESTED | — | — |
| الطلبات | دورة الحياة | ✅ | `orders/routes.ts` `/`,`/:id/status` | `orders`,`order_items` | `order-lifecycle.spec.ts` | COMPLETE_AND_TESTED | — | — |
| الطلبات | تأكيد بلا دفع | ✅ | `orders/service.ts:68` (`assertPaymentConfirmedForOrder`) | `orders`,`payment_intents`,`payments` | `order-confirmation-payment-guard.test.ts` | COMPLETE_AND_TESTED | SEC-03 (مُصلَح غير مُودَع) | الحارس مفروض قبل التنفيذ؛ نتائج الاختبار تاريخية (لم تُعَد في هذه الجولة) |
| المدفوعات | intent + webhook + refunds | ✅ | `payments/routes.ts` | `transactions`,`refunds` | `payments.spec.ts`, `admin-refunds.spec.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | HMAC + idempotency | المزوّد الحقيقي = EXTERNAL_DEPENDENCY |
| العمولات | محرّك الرسوم | ✅ | `orders/service.ts:133` (Policy Engine) | `payment_fee_policies` | `money-path-invariants.test.ts` | COMPLETE_AND_TESTED | — | جدول `commissions` مهجور |
| Ledger | قيود مزدوجة | ✅ | `lib/…` + `settlements` | `transaction_ledger` | `settlement-ledger.test.ts` | COMPLETE_AND_TESTED | — | — |
| Settlements | تأكيد التسوية | ❌ | `settlements/service.ts:77-198` | `settlements` | `settlement-ledger.test.ts` | BACKEND_ONLY | — | لا واجهة (SEC مُصنَّف BACKEND_ONLY) |
| Payouts | إنشاء/إرسال/مزامنة | ❌ | `payouts/service.ts` | `payouts` | `payout-engine.test.ts`, `payout-provider.test.ts` | BACKEND_ONLY | — | لا واجهة |
| Reconciliation | مطابقة + إيصالات | ❌ | `reconciliation/*` | `reconciliation` | `reconciliation-engine.test.ts` | BACKEND_ONLY | — | لا واجهة |
| Refunds | استرداد | ✅ | `payments/routes.ts` | `refunds` | `admin-refunds.spec.ts` | COMPLETE_AND_TESTED | — | — |
| النزاعات | دورة كاملة + استئناف | ✅ | `disputes/routes.ts`, `admin/engines-routes.ts` | `disputes`,`appeals` | `disputes.spec.ts`, `dispute-refund.spec.ts` | COMPLETE_AND_TESTED | — | — |
| التقييمات | reviews | ❌ | ❌ | `reviews` (معرّف) | — | MISSING | `db/schema/trust.ts:94` | جدول بلا أي كود |
| الإعلانات | حملات/إبداعات/إحصاء | ✅ | `ads/routes.ts` | `campaigns`,`ad_events` | `ads.spec.ts`, `admin-ads.spec.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | — |
| الإشعارات | قائمة/قراءة/عدّاد | ✅ | `notifications/routes.ts` | `notifications` | — | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | `notification_preferences` مهجور |
| التحليلات | KPI/cohorts/unit-economics | ✅ | `admin/analytics-routes.ts` | — | `admin-unit-economics.spec.ts`, `unit-economics.test.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | — |
| الجغرافيا | دول/مدن/عملات/لغات/أسعار صرف | جزئي | `geo/routes.ts` | `countries`,`cities`,`currencies` | — | PARTIALLY_IMPLEMENTED | — | معظم مسارات geo بلا مستدعٍ (القسم 5) |
| الاشتراكات | خطط/فواتير/تدوير/انتهاء | ✅ | `subscriptions/routes.ts` + scheduler | `subscription_*` | `admin-subscriptions.spec.ts` | IMPLEMENTED_BUT_INSUFFICIENT_TESTS | — | `collect` يحتاج مزوّد دفع |
| الضرائب | jurisdictions/resolve | ❌ | `tax/routes.ts` | `tax_*` | `tax-engine.test.ts` | BACKEND_ONLY | — | لا واجهة |
| الإيرادات | تقرير/محاكاة | ❌ | `revenue/routes.ts` | — | `revenue.test.ts` | BACKEND_ONLY | — | لا واجهة |
| الدعم | tickets/support desk | ❌ | جزئي (رسائل) | — | — | MISSING | — | لا وحدة تذاكر |

---

## 5. جرد لوحة الإدارة (Admin Dashboard)

### 5.1 الصفحات مقابل الـAPI

مسارات الإدارة في `App.tsx` (19): `/admin`, `/admin/ads`, `/admin/ai`, `/admin/analytics`, `/admin/audit`, `/admin/disputes`, `/admin/ledger`, `/admin/observability`, `/admin/orders`, `/admin/policies`, `/admin/privacy`, `/admin/products`, `/admin/reports`, `/admin/risk`, `/admin/subscriptions`, `/admin/transactions`, `/admin/trust`, `/admin/users`, `/admin/verification`.

من أصل **37** ملف صفحة في `packages/web/src/pages/*.tsx`، تستدعي جميعها API فعلياً عدا `DemoCustomerEntryPage.tsx` (بلا API — صفحة دخول تجريبية).

### 5.2 وظائف Backend غير متاحة من الواجهة (Backend-Only)

**71 مسار Backend بلا أي مستدعٍ من كود الويب** (مطابقة مُطبَّعة بين 271 مسار Backend ومسارات `packages/web/src`). أبرزها حسب الأهمية:

| المجال | المسارات (Backend-Only) | الملف |
|---|---|---|
| **المال — تسويات** | `POST /api/admin/finance/settlements/confirm` | `finance/routes.ts` |
| **المال — مستحقات** | `GET /api/admin/finance/payouts/:id`, `POST .../payouts`, `POST .../payouts/:id/dispatch`, `POST .../payouts/:id/sync`, `GET .../payout-providers` | `finance/routes.ts` |
| **المال — إيصالات/مطابقة** | `POST /api/admin/finance/receipts`, `POST .../reconciliation/import` | `finance/routes.ts` |
| **الضرائب** | `GET/PUT /api/admin/tax/jurisdictions`, `GET .../countries/:countryId/rules`, `POST .../resolve`, `POST .../decision-required` | `tax/routes.ts` |
| **الخصوصية (مشغّل)** | `GET /api/privacy/me`, `GET /api/privacy/consents`, `POST /api/privacy/deletion`, `POST /api/privacy/export`, `PUT /api/privacy/consents` | `privacy/routes.ts` |
| **الخصوصية (إدارة)** | `GET /api/admin/privacy/deletions`, `POST /api/admin/privacy/deletion`, `POST /api/admin/privacy/export`, `PUT /api/admin/privacy/consents` | `privacy/routes.ts` |
| **الإيرادات** | `GET /api/revenue/report`, `GET /api/revenue/scenarios`, `POST /api/revenue/scenario` | `revenue/routes.ts` |
| **المخاطر** | `GET /api/risk/profiles`, `GET /api/risk/profiles/:userId`, `GET /api/risk/events`, `POST /api/risk/profiles/:userId/reassess` | `risk/routes.ts` |
| **AI (موافقات)** | `POST /api/ai/tasks/:taskId/approve`, `POST /api/ai/tasks/:taskId/reject`, `POST /api/ai/analyze/product`, `GET /api/ai/tasks/:taskId` | `ai/routes.ts` |
| **الجغرافيا** | 14 مساراً: `GET /api/geo/{currencies,languages,regions,cities,exchange-rates,…}` | `geo/routes.ts` |
| **أدوات تشغيل** | `GET /metrics`, `GET /api/health/live`, `GET /api/health/channels`, `GET /robots.txt`, `GET /sitemap.xml` | `observability/routes.ts`, `health/routes.ts`, `seo/routes.ts` |
| **الأدوار/المصادقة** | `POST /api/admin/users/:id/status`, `PATCH /api/admin/users/:id/status` | `admin/routes.ts` |
| **webhooks/إدارة فشل** | `POST /api/payment-webhooks/`, `GET /api/payments/webhook-failures`, `POST .../replay` | `payments/routes.ts` |
| **مصادقة تشغيلية** | `POST /api/auth/phone/send|verify`, `POST /api/auth/mfa/verify`, `POST /api/auth/dev/*`, `POST /api/auth/mfa/dev-totp` | `auth/routes.ts` |

> **ملاحظة تحليلية:** وجود هذه المسارات دليل على أنها **مُنفَّذة في الخلفية** فقط؛ لا يعني أنها تعمل تجارياً. غالبية `admin/finance/*` و`admin/tax/*` و`admin/privacy/*` مصنّفة `BACKEND_ONLY` وتحتاج واجهة وتشغيلاً حياً للتحقّق.

### 5.3 أزرار/واجهات بلا إجراء فعلي

- `packages/web/src/pages/AdminReportsPage.tsx` — واجهة تقارير محفوظة موصولة بـ`GET/POST /api/admin/analytics/reports` (تعمل).
- صفحات الإدارة تتضمّن عناصر `placeholder` في الحقول (ليست أزراراً وهمية)، لكن لم يُثبَت بعدُ وجود أي زر واجهة **يستدعي API غير موجود** — هذا يحتاج تشغيل E2E للتحقّق (`NOT_VERIFIED`).

---

## 6. جرد الصلاحيات والأدوار

**مصدر الحقيقة:** `packages/shared/src/constants/{permissions,roles,rbac}.ts`. الأدوار (10): `CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER, SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN`. التسجيل الذاتي محصور في `SELF_SELECTABLE_ROLES` (5 أدوار؛ الأدوار الموظفية مستثناة بالتصميم).

**آلية الحماية:** `requirePermission(...)` و`requireRole(...)` في `middleware/auth.ts`. `loadAuthUser` يرفض المستخدم إن كان `!isActive || isLocked`.

### 6.1 مصفوفة فعلية (مختصرة — الأدلة من `rbac.ts`)

| القدرة | CUSTOMER | MERCHANT | SUPPLIER | COMPANY | MARKETER | SUPPORT | RISK | DISPUTE | ADMIN | SUPER_ADMIN |
|---|---|---|---|---|---|---|---|---|---|---|
| إنشاء منتج | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `product:manage` (تعديل/إيقاف للغير) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| إنشاء طلب | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| قراءة كل الطلبات | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `refund:manage` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `commission:manage` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| قرار النزاع (`dispute:decide`) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `admin:*` (users/ads/ai/policies/…) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | جزئي (risk) | ❌ | ✅ | ✅ |
| `audit:log:export` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| كل الصلاحيات | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### 6.2 الفرق بين ADMIN وSUPER_ADMIN

**حساب فعلي** (Python على `permissions.ts` + `rbac.ts`):

- **SUPER_ADMIN** = `new Set(Object.values(P))` → **كل** الصلاحيات: **111** قيمة صلاحية.
- **ADMIN** = مجموعة صريحة = **81** صلاحية.
- إذن **ADMIN يفتقد 30 صلاحية** يملكها SUPER_ADMIN. أهمها وظيفياً:

| الصلاحية الناقصة عند ADMIN | الأثر |
|---|---|
| `revenue:read`, `revenue:manage`, `revenue:simulate` | ADMIN **لا يستطيع** قراءة/إدارة/محاكاة الإيرادات (`revenue/routes.ts` يتطلّب `REVENUE_READ`/`REVENUE_SIMULATE`) |
| `report:read` | ADMIN لا يملك قراءة التقارير العامة (يملكها RISK) |
| `subscription:create/update/cancel/read:own` | ADMIN لا يملكها (يملك `SUBSCRIPTION_MANAGE` فقط) |
| `product:create`, `supplier:create`, `merchant:create`, `company:create` (+`*:delete`) | ADMIN لا يُنشئ/يحذف كيانات تجارية (يملك read/update/list) |
| `order:create`, `order:read:own`, `order:delete` | ADMIN ليس مشترياً |
| `payment:create`, `inventory:update`, `inventory:movement:create`, `message:read:own`, `dispute:create`, `verification:submit`, `search:public`, `ad:create`, `campaign:create`, `trust:read:own`, `user:read:own`, `analytics:read:own` | صلاحيات "الذات/المشتري" غير ممنوحة للموظف الإداري |

> **تصحيح DOC-ALIGN-01:** الأعداد الصحيحة هي SUPER_ADMIN = **111**، ADMIN = **81**، الناقص = **30** (كان التقرير يذكر 110/79/31 — خطأ عدّ؛ صُحّح بتحقّق عدّ مباشر على `permissions.ts`+`rbac.ts`).
>
> **تحديث PERM-01B:** أُضيفت لـADMIN صلاحيتا **قراءة** فقط: `inventory:read` و`inventory:read:all` (بلا أي صلاحية كتابة مخزون)، فأصبح عدد صلاحياته 81 بدل 79.
>
> **تحديث PERM-01C (توثيقي، بلا تغيير صلاحيات):** صُنّفت **50 صلاحية غير مستخدمة** و**مصفوفة الأدوار المتخصصة** في `docs/PERM-01C_RBAC_CLEANUP.md`؛ ولم تُمنح أو تُسحب أي صلاحية في هذه المهمة. صلاحيات «بلا مسار» لـSUPPORT/RISK/DISPUTE موثّقة هناك (مُضلِّلة لا ثغرة: الحارس العام `/api/admin/*` يرفضها).

> **استنتاج (SECURITY_OR_PERMISSION_GAP — P2، لا يزال مفتوحاً):** هناك **عدم تناسق** — ADMIN يملك صلاحيات إدارة واسعة (`admin:*`, `refund:manage`, `commission:manage`, `audit:log:export`) لكنه **يفتقد** `revenue:read` و`report:read`، وهما وظيفتان إداريتان متوقّعتان. الأرجح أن هذا سهو في مصفوفة `rbac.ts` لا تصميم مقصود (لأن واجهة الإيرادات إدارية). يحتاج قراراً: هل يُمنح ADMIN `revenue:read`/`report:read`، أم تبقى حصرية لـSUPER_ADMIN (وهذا لم يُوثَّق)؟ لا يوجد اختبار يفرض أياً من السلوكين.

> **حُسمت (PERM-01 — WASIT-EXECUTION-006، 2026-11-07):** `revenue:read` **لا تُمنح لـADMIN** — منع مقصود مُوثَّق ومُتحقَّق حياً (`docs/management/guide.html` §8؛ الفرق ADMIN↔SUPER_ADMIN هو بالضبط `/api/revenue/*`). و`report:read` **ليست فجوة** (لا مسار يستهلكها؛ مكتب التقارير محروس بـ`admin:reports` الذي يملكه ADMIN). الأدلة: `docs/GAP_REGISTER.md` (§2/§6/§9) + `docs/SECURITY_MODEL.md` §2 + `packages/server/tests/perm01-admin-revenue-report.test.ts` (17/17). لا تغيير صلاحيات.

### 6.3 عزل البيانات

- `orders/service.ts:listMyOrders` يقيّد النتائج بـ`buyer_id = user OR seller_id IN (ownedSellerIds)`.
- `disputes/service.ts:requireDisputeAccessOrThrow` (سطر 385) يُستخدم في عدة نقاط (440, 447, 754, 865).
- عزل المنتجات عبر `assertSellerOwnership`.
- **NOT_VERIFIED:** عزل بيانات بقية الوحدات (finance/tax/analytics) لم يُفحَص سطراً بسطر.

---

## 7. جرد AI والوكلاء

**الملفات:** `modules/ai/{routes,service,agents,executors}.ts`، `lib/ai/{provider,routing,runtime,cost-control,endpoints,types,self-endpoints}.ts`، `db/schema/ai.ts`، `db/schema/agents.ts`، `admin/ai-routes.ts`.

**11 وكيلاً** في `AGENT_CATALOGUE` (`modules/ai/agents.ts`): `sales-agent, marketing-agent, ads-agent, product-agent, support-agent, analytics-agent, market-research-agent, b2b-agent, risk-agent, dispute-assistant, development-agent`.

**بوابة الموافقة البشرية:** موجودة — `requiresHumanApproval` (7 وكلاء = true). الحالة الأولية `awaiting_approval` أو `queued` (`agents.ts:181-182`)، مع `approveAgentTask`/`rejectAgentTask` (`ai/routes.ts:261,275`).

**جدول تقييم الوكلاء:**

| الوكيل | واجهة؟ | Executor؟ | LLM حقيقي؟ | يقرأ بيانات حقيقية؟ | أدوات فعلية؟ | قراءة/كتابة؟ | اختبار؟ | ينقصه |
|---|---|---|---|---|---|---|---|---|
| sales-agent | ✅ `/api/ai/agents/:key/tasks` | ✅ `execSalesAgent` | ❌ (محلي افتراضياً) | ✅ (orders/trust/products) | ❌ | قراءة | — | LLM + أدوات |
| marketing-agent | ✅ | ✅ | ❌ | جزئي | ❌ | قراءة | — | LLM |
| ads-agent | ✅ | ✅ | ❌ | جزئي | ❌ | قراءة | — | LLM |
| product-agent | ✅ | ✅ | ❌ | ✅ (products) | ❌ | قراءة | — | LLM |
| support-agent | ✅ | ✅ | ❌ | ✅ (messages) | ❌ | قراءة | — | LLM |
| analytics-agent | ✅ | ✅ | ❌ | ✅ | ❌ | قراءة | — | LLM |
| market-research-agent | ✅ | ✅ | ❌ | جزئي | ❌ | قراءة | — | LLM |
| b2b-agent | ✅ | ✅ | ❌ | جزئي | ❌ | قراءة | — | LLM |
| risk-agent | ✅ | ✅ | ❌ | ✅ (risk) | ❌ | قراءة | — | LLM |
| dispute-assistant | ✅ | ✅ | ❌ | ✅ (disputes) | ❌ | قراءة | — | LLM |
| development-agent | ✅ | ✅ | ❌ | جزئي | ❌ | قراءة | — | LLM |

**الأدلة:**
- `executors.ts` (884 سطراً): 11 دالة `exec*Agent`، وكلها تنتهي بـ`readOnly: true` (12 مطابقة `readOnly: true`). **لا استدعاء `insert/update/delete/.set` داخل `executors.ts`** → كل الوكلاء **قراءة فقط**.
- **المزوّد:** `lib/ai/provider.ts` → `resolveProvider()` يعيد `LocalHeuristicProvider` (منطق محلي) أو `NoopProvider`؛ `OpenAIChatCompletionsProvider` و`AnthropicProvider` معرّفان لكن يحتاجان `AI_API_KEY`/`AI_PROVIDER`.
- **Cost Control:** `lib/ai/cost-control.ts` (`assertWithinBudget`, `recordAiRequest`, `upsertAiUsage`)، وإدارة ميزانيات/موديلات عبر `admin/ai-routes.ts` (`/budgets`,`/models`).

**ما هو غير موجود (تحقّق `grep` مباشر أُعيد صفره):** لا `Supervisor`، لا `Tool Gateway`، لا ذاكرة/سياق للوكلاء، لا `Kill Switch`، لا تنفيذ مجدول للوكلاء (الـscheduler لا يجدول مهام وكلاء)، لا عزل مهام متقدّم. تُصنَّف فجوات **P1**.

**ملاحظة:** `GET /api/ai/tasks/:taskId`, `POST /api/ai/tasks/:taskId/approve|reject`, `POST /api/ai/analyze/product` **بلا مستدعٍ من الواجهة** → الموافقة البشرية متاحة برمجياً لكن **غير مربوطة بواجهة إدارية**.

---

## 8. جرد الأمن والخصوصية

| المحور | الحالة | الدليل |
|---|---|---|
| Security headers + CSP | ✅ | `middleware/security-headers` (HSTS على HTTPS فقط) |
| Rate limiting | ✅ | `lib/rate-limit/{memory,postgres}.ts` + purge في scheduler |
| Session cookies | ✅ httpOnly, sameSite=Lax, secure, 30d | `lib/security.ts` + `SESSION_TTL_DAYS` |
| Session revocation | ✅ | `auth/routes.ts` `/sessions/revoke` |
| قفل الحساب | جزئي | `loadAuthUser` يرفض `isLocked`، لكن **لا كاتب آلي واضح لـ`isLocked`** (رغم وجود `MAX_LOGIN_ATTEMPTS`/`LOCKOUT_MINUTES` في `env.ts`) |
| MFA | ✅ TOTP + recovery | `auth/routes.ts` `/mfa/*` |
| التحقق من المدخلات | ✅ | `validateBody`/`validateQuery` + Zod |
| SQL injection | ✅ منخفض | Drizzle + SQL مُعامَل؛ **138** موضع `sql\`` خام (لم تُراجَع يدوياً) |
| CSRF | ❌ | لا حماية CSRF صريحة (SameSite=Lax يخفّف جزئياً) |
| Webhook HMAC | ✅ timing-safe | `PAYMENT_WEBHOOK_SECRET` |
| Idempotency | ✅ | webhook/intent/refund (مفاتيح idempotency) |
| Audit logs | ✅ | `lib/audit.ts` `writeAudit` + `audit_logs` |
| Privacy (consent/export/deletion/retention) | ✅ backend | `privacy/routes.ts` + retention sweep في scheduler |
| Upload/Media | ✅ | `media/routes.ts`، `MEDIA_MAX_VIDEO_BYTES`, TTL للتنزيل |
| Error tracking | ❌ | لا Sentry/بديل |
| Backup/Recovery | جزئي | `scripts/backup-restore.test.sh` + CI drill؛ **محلي فقط** (PI-03/PI-09 مفتوحتان) |

---

## 9. جرد قاعدة البيانات

- **94** تعريف `pgTable` في **28** ملف مخطّط (`db/schema/*.ts`)، و**27** migration (`db/migrations/0000…0026`).
- محاور: `auth`, `commerce`, `products`, `trade`, `trust`, `engine`, `agents`, `ai`, `audit`, `ads`, `messaging`, `notifications`, `inventory`, `subscriptions`, `disputes`, `risk`, `tax`, `payments`, `privacy`, …
- **جداول معرّفة بلا استخدام فعلي** (تحقّق `grep` مباشر): `reviews`, `commissions`, `company_branches`, `notification_preferences`.
- **جداول تعتمد عليها وظائف ناقصة:** `reviews` (التقييمات = MISSING)، `company_branches` (فروع الشركات غير مربوطة بواجهة).
- **NOT_VERIFIED:** الفهارس والقيود وتوافق المخطّط↔الكود لم تُراجَع سطراً بسطر؛ لم تُشغَّل أي migration في هذه الجولة.

---

## 10. جرد الاختبارات

| النوع | العدد | الأدلة |
|---|---|---|
| ملفات اختبار الخادم | **73** (62 في `tests/` + 11 في `tests/unit/`) | `find packages/server/tests -name '*.test.ts'` |
| حالات `it()/test()` خلفية | **843** | `grep -rhoE "\b(it|test)\(" packages/server/tests` |
| ملفات E2E (Playwright) | **33** | `ls e2e/*.spec.ts` |
| حالات `test()` في E2E | **207** | `grep -rhoE "\btest\(" e2e/*.spec.ts` |
| اختبارات الويب | **0** | `find packages/web -name '*.test.*'` |
| اختبارات `shared` | **0** | `find packages/shared -name '*.test.*'` |

> **تحديث DOC-ALIGN-01:** كان التقرير يذكر **69** ملفاً و**776** حالة (وقت الإعداد). بعد إضافة ملفات SEC-03/PERM-01A/B/C الأربعة (`order-confirmation-payment-guard`, `perm01a-…`, `perm01b-…`, `perm01c-…`) صار الفعلي **73** ملفاً و**843** حالة عدّ نصّي (يشمل `describe` الداخلية عبر نمط `\b(it|test)\(`).

**اختبارات المال الأساسية:** `money-path-invariants.test.ts`, `settlement-ledger.test.ts`, `payout-engine.test.ts`, `payout-provider.test.ts`, `reconciliation-engine.test.ts`, `tax-engine.test.ts`, `unit-economics.test.ts`, `revenue.test.ts`, `finance-routes.test.ts`.

**اختبارات أمنية/E2E:** `security-sessions.spec.ts`, `mfa.spec.ts`, `rbac.spec.ts`, `navigation-audit.spec.ts`, `functional-audit.spec.ts`, `admin-refunds.spec.ts`, `admin-unit-economics.spec.ts`, `settlement-integrity.spec.ts`, `admin-observability.spec.ts`, `admin-webhook-failures.spec.ts` (OBS-01)، `admin-privacy.spec.ts`, `admin-ai.spec.ts`, `admin-subscriptions.spec.ts`, `admin-reports.spec.ts`, `policies.spec.ts`, `seo.spec.ts`, `video-studio.spec.ts`, `library.spec.ts`, `directory.spec.ts`, `price-comparison.spec.ts`, `demo-*.spec.ts`.

**نتائج تاريخية (وليست متحقَّقاً منها الآن):** في جولة سابقة بتاريخ **2026-11-04 ~13:26** ذُكر نجاح «69 ملف / 784 اختباراً» وحزمة `product-suspension.test.ts` 8/8. **هذه نتائج تاريخية لم تُعَد في هذه الجولة** (Postgres غير مشغّل). لا يُدَّعى نجاحها الآن.

**فجوات في التغطية:** لا اختبارات للواجهة (UI)، ولا لـ`shared`، ولا اختبارات تكامل لمعظم مسارات `admin/finance/*` و`admin/tax/*` و`geo/*`، ولا اختبارات AI للوكلاء، ولا اختبارات تزامن/تكرار (race conditions) عدا ما تغطّيه اختبارات المال.

---

## 11. الوضع القانوني والتجاري

**موجود تقنياً:** مسارات الخصوصية (`privacy/routes.ts`) تدعم consent/export/deletion/retention؛ مسارات الضرائب (`tax/routes.ts`)؛ سجلات تدقيق.

**ناقص (تقني):** لا صفحات ToS/Privacy Policy/Cookies في الواجهة (تحقّق `grep` في `App.tsx` = صفر)؛ لا قائمة سلع محظورة كواجهة؛ لا وحدة KYC/KYB.

**EXTERNAL BLOCKERS (من `docs/GAP_REGISTER.md` القسم 8):**

| المعرّف | الوصف |
|---|---|
| PS-03 | تأكيد/عقد مزوّد دفع على قدرة **Split / Sub-merchant** (iPay/ClicToPay/Flouci) |
| PS-06 | توثيق/عقد استرداد ClicToPay (SPS reversals) |
| LC-01/LC-03/LC-04 | صياغة قانونية معتمدة (ToS/Privacy/DPA) |
| LC-05 | عقد مزوّد KYC/KYB |
| PI-03/PI-09 | وجهة نسخ خارجية + مفاتيح إنتاجية |

> **تحديث DOC-PS03-ALIGN (2026-11-06):** كان هذا الجدول يسجّل `PS-03` = «ClicToPay reversals» (وهو في الحقيقة `PS-06`). صُحّح `PS-03` إلى **Split / Sub-merchant** وأُضيف `PS-06` = استرداد ClicToPay. توثيقي بحت؛ لا تغيير في أي تقييم أو حالة. التفاصيل: `docs/GAP_REGISTER.md` §10.5.

AML/PEP/Sanctions، Refund Policy، Seller Agreement، **نصّ** سياسة الكوكيز — **غير موجودة** (تصنيف `MISSING` / `EXTERNAL_DEPENDENCY`).

> **إغلاق LC-02 (WASIT-EXECUTION-007 → 007.3 — 2026-11-07):** ضابط موافقة الكوكيز **مُغلق تقنياً**: واجهة موافقة كاملة + **بوّابة فعلية** على التتبّع التسويقي (`AdSlot`)، بتخزين على العميل بإصدار سياسة وانتهاء وسحب يوقف التتبّع. البند **`COMPLETE_VERIFIED`** (34/34 اختبار وحدة معزول + Typecheck + Build؛ **E2E متصفّح حقيقي بلا DB 8/8** عبر `playwright.cookie.config.ts`؛ أُصلح عيب سحب الموافقة وأُثبتت ضرورة الإصلاح بإعادة الحالة). يبقى **نصّ السياسة القانونية** اعتماداً خارجياً تحت LC-01. يبقى **نصّ السياسة القانونية** (`Cookies Policy`) اعتماداً خارجياً تحت LC-01، ولا يُدَّعى امتثال قانوني كامل. التفاصيل: `docs/LC-02_COOKIE_CONSENT.md`.

> **إغلاق LC-03 (WASIT-EXECUTION-008.1 — 2026-11-07):** ضابط **السلع المحظورة/المقيّدة** **`COMPLETE_VERIFIED`**: مصنّف مركزي + نقطة إنفاذ واحدة في خدمة المنتجات (رفض المحظور 422 بلا كتابة، والمقيّد مسودّة غير منشورة لا تُنشر إلا بمراجعة بشرية `catalog:compliance:review` غير ممنوحة لأي وكيل AI)، **بلا Migration**. **الأدلة:** **26/26** اختبار معزول بلا DB + **4/4** اختبار HTTP على **PostgreSQL 16 مؤقتة معزولة** (`wasit-lc03-pg`، `127.0.0.1:55433`، قاعدة `wasit_test`، بلا اتصال بـ DEMO/production) + Typecheck (server+web) نظيف. الموارد المؤقتة حُذفت بالكامل. **يبقى** الجزء القانوني (نصّ السياسة/قائمة العقوبات الرسمية) اعتماداً خارجياً تحت LC-01/LC-05. التفاصيل: `docs/LC-03_PROHIBITED_GOODS.md`.

---

## 12. الجاهزية الإنتاجية

| المحور | الحالة | الدليل |
|---|---|---|
| Production config | ✅ | `lib/env.ts` (~90 مفتاحاً) + Dockerfile + Dockerfile.web |
| Orchestration | ✅ | `docker-compose.yml` (api/web/db/backup) + nginx |
| CI/CD | ✅ | `.github/workflows/ci.yml` — 4 وظائف: `static` (typecheck+build)، `test` (Postgres حقيقي)، `backup-drill`، `e2e` (Playwright) |
| Logging | ✅ | `OBS_LOG_LEVEL`/`OBS_LOG_FORMAT` + `observability/routes.ts` |
| Monitoring/Metrics | ✅ | `GET /metrics` (يحتاج `METRICS_TOKEN`) |
| Alerting | ✅ | `OBS_ALERTS_ENABLED` + `evaluateAlerts` في scheduler + `OBS_ALERT_WEBHOOK_URL` |
| Error tracking | ❌ | لا تكامل Sentry/بديل |
| Backup/Restore | جزئي | سكربت + CI drill، لكن محلي فقط |
| Secrets | جزئي | إدارة عبر env؛ لا vault |
| Scheduler | ✅ (اختياري) | `SCHEDULER_ENABLED`؛ بلا طابور خارجي (لا تعدد نسخ آمن) |

**Typecheck في جولة الإعداد:** `npm run typecheck` → **EXIT 0** (server + web). متحقَّق منه فعلياً في جولة التقرير (2026-11-04)، **ولم يُعَد** في جولة DOC-ALIGN-01 (توثيقية بحتة، لم تُشغِّل أي أمر بناء).

**ما يمنع الإطلاق فعلياً:** مزوّد الدفع الإنتاجي + مفاتيحه، KYC/AML، صياغة قانونية، نسخ احتياطي خارجي، مزوّد AI إنتاجي، Error tracking، وربط واجهات المال (finance/tax/privacy).

---

## 13. خريطة الفجوات والأولويات

> مأخوذة جزئياً من `docs/GAP_REGISTER.md` (لم يُعدَّل)، ومكمَّلة بمعطيات هذه الجولة. لم يُنفَّذ أي إصلاح.

### P0 — أمن/مال/صلاحيات

| المعرّف | الوصف | الأثر | الدليل | الاختبار المطلوب | الحالة |
|---|---|---|---|---|---|
| SEC-01/02 | تجاوز SUPPORT لصلاحيات المنتجات | تصعيد صلاحيات | `products/routes.ts:77` (`hasProductManageAuthority`) | `product-suspension.test.ts` | ✅ **مُصلَح** (غير مُودَع) |
| SEC-03 | تأكيد الطلب بلا تحقّق دفع | خسارة مالية | `orders/service.ts:68` (`assertPaymentConfirmedForOrder`) | `order-confirmation-payment-guard.test.ts` | ✅ **مُصلَح** (غير مُودَع) |
| PERM-01A/B/C | عدم تناسق مصفوفة RBAC: مكاتب موظفية محجوبة، مخزون بلا قراءة إدارية، مسارات كيانات محروسة باسم الدور لا الصلاحية | وظائف إدارية/موظفية معطّلة | `admin/{routes,engines-routes}.ts`, `inventory/*`, `{suppliers,merchants,companies}/routes.ts`, `tax/routes.ts` | `perm01a/01b/01c-*.test.ts` | ✅ **مُصلَح** (غير مُودَع) |
| PERM-01 (متبقٍّ) | ADMIN يفتقد `revenue:read`/`report:read` (قرار صلاحيات) | وظائف إدارية معطّلة/قرار غير موثّق | `shared/constants/rbac.ts` (§6.2) | اختبار مصفوفة تفاضلي ADMIN↔SUPER_ADMIN | ⏳ **مفتوح** (P2) |
| (من السجل) | بنود P0 أمنية/مالية أخرى | — | `GAP_REGISTER.md` §2 | — | — |

> **تحديث DOC-ALIGN-01:** SEC-01/02 وSEC-03 وPERM-01A/B/C منجزة على مستوى الكود (غير مُودَعة). أدلّة نجاح اختباراتها **تاريخية** (لم تُعَد في هذه الجولة). البند المتبقّي الوحيد من عائلة PERM-01 هو تناسق `revenue:read`/`report:read` لـADMIN.

### P1 — وظائف أساسية تمنع التشغيل

| المعرّف | الوصف | الدليل |
|---|---|---|
| AI-01…AI-05 | منظومة AI غير تشغيلية (لا Supervisor/Tool Gateway/ذاكرة/Kill Switch/جدولة) | `GAP_REGISTER.md` §3 + غياب الأدلة في `lib/ai` |
| FIN-UI | مسارات المال (settlements/payouts/reconciliation) بلا واجهة | القسم 5.2 |

### P2 / P3 — (تفصيل كامل في `GAP_REGISTER.md` §4/§5)

تشمل: `PR-01/02/03/05/06/10/11` (وظائف تجارية)، `LC-01…LC-07` (قانوني)، `PI-03/PI-05/PI-09` (إنتاجي)، وفجوات geo/reviews.

---

## 14. ما لم يُتحقَّق منه في هذه الجولة (NOT VERIFIED)

- **تشغيل الاختبارات** (843 حالة عدّ نصّي) و**E2E** (207 حالات) — Postgres/Docker غير مشغّلين. النتائج السابقة **تاريخية فقط**.
  - استثناء موثّق: في جولة PERM-01C **شُغِّل فعلاً** `perm01c-rbac-cleanup.test.ts` (23/23) + الحزمة الكاملة **852/852 (73 ملف)** + Typecheck نظيف (server+web) — لكن **لم يُعَد** ذلك في جولة DOC-ALIGN-01 (وهي توثيقية بحتة).
- **أي وظيفة مالية حيّة** (تسوية/مستحق/مطابقة/دفع حقيقي).
- **عزل البيانات** لكل الوحدات (فُحصت orders/disputes/products فقط).
- **مراجعة الفهارس والقيود** ومخطط↔كود سطراً بسطر.
- **مزوّدات الدفع/AI الحقيقية** (تحتاج مفاتيح).
- **معظم مسارات `geo/*`** و`admin/finance/*` و`admin/tax/*` (Backend-Only، بلا اختبار).
- **وجود أزرار واجهة تستدعي API غير موجود** (يحتاج E2E).

---

## 15. الخلاصة

**ماذا يملك WASIT اليوم؟** منصة Backend ناضجة وظيفياً: مصادقة/RBAC، دورة طلب، محرّك مالي (عمولات/ledger/تسويات/مستحقات/مطابقة/ضرائب)، نزاعات، اشتراكات، خصوصية، تدقيق، مراقبة، CI/CD، Docker. الواجهة تغطّي معظم التجربة (74 مساراً، 37 صفحة) لكنها **لا تغطّي المال الإداري والضرائب والخصوصية التشغيلية** (71 مساراً بلا واجهة).

**ماذا ينقصه ليصبح منصة تشغيلية متكاملة؟**
1. ربط واجهات المال (finance/tax/privacy) — P1.
2. منظومة AI تشغيلية حقيقية (LLM + أدوات + Supervisor + Kill Switch) — P1.
3. مزوّد دفع إنتاجي + مفاتيح AI + نسخ خارجي — EXTERNAL.
4. صياغة قانونية (ToS/Privacy/DPA) + KYC/AML — EXTERNAL.
5. ~~سدّ ثغرة SEC-03 وتسوية مصفوفة صلاحيات ADMIN (PERM-01) — P0.~~ **أُنجز** (SEC-03 + PERM-01A/B/C — غير مُودَع). المتبقّي: قرار `revenue:read`/`report:read` لـADMIN.
6. اختبارات واجهة + توسيع تغطية الاختبارات للوحدات الخلفية.

**الحكم النهائي: PARTIAL AUDIT** — المجالات المفحوصة (البنية، الأدوار، الوحدات التجارية، لوحة الإدارة، AI، الأمن، قاعدة البيانات، الاختبارات، القانوني، الإنتاجية) موثّقة بأدلة مسارات؛ والمجالات غير المفحوصة مذكورة صراحةً في القسم 14.

---

### ملحق: منهجية الفحص والحدود

- **أدوات:** `find`, `grep`, `sed`, `cat`, `git status/diff/log`, `sha256sum`, وسكربتات Python للتحليل المُطبَّع (مطابقة المسارات، عدّ الجداول/الاختبارات).
- **لم يُستخدَم:** أي تعديل ملف، أي migration/seed، أي تشغيل قاعدة بيانات، أي commit/push.
- **حدود الدقة:** أعداد المسارات مبنية على مطابقة regex لتسجيلات `Routes.<verb>('<path>')` في الوحدات المربوطة في `app.ts` (قد تختلف ±قليل عن العدد الفعلي بسبب المسارات الديناميكية). أعداد `it()/test()` عدّ نصّي.

---

## 16. سجل تحديث DOC-ALIGN-01

**النوع:** Documentation-only. **لم يُعدَّل أي كود تطبيق أو اختبار، ولم يُشغَّل Docker/PostgreSQL، ولم يُنفَّذ أي commit/push/reset/checkout/merge.**

**ما صُحِّح/حُدِّث في هذا التقرير:**

| البند | قبل | بعد | المصدر |
|---|---|---|---|
| حالة SEC-03 | `SECURITY_OR_PERMISSION_GAP` (مؤجّل) | `COMPLETE_AND_TESTED` (مُصلَح غير مُودَع) | `orders/service.ts:68,461` |
| حالة PERM-01 (A/B/C) | بند P0 مفتوح | مُنجَز (غير مُودَع) | `perm01a/01b/01c-*.test.ts` + الكود |
| صلاحيات SUPER_ADMIN | 110 | **111** | عدّ `permissions.ts` |
| صلاحيات ADMIN | 79 | **81** | عدّ `rbac.ts` (بعد PERM-01B) |
| الناقص لـADMIN | 31 | **30** | فرق العدّ |
| ملفات اختبار الخادم | 69 | **73** | `find tests -name '*.test.ts'` |
| حالات الاختبار | 776 | **843** | `grep -c '\b(it\|test)\('` |
| بصمة `GAP_REGISTER.md` | `193f53ac…` | `a28163a7…` (حالية) | `sha256sum` |
| مرجع البصمة `/tmp/audit-baseline/protected.sha` | مُشار إليه | غير موجود في هذه البيئة | `ls` |
| شجرة العمل في §2 | ملفان | 22 معدّلاً + الجديد | `git status --short` |
| الاختبار المطلوب لـSEC-03 | «مؤجّل» | `order-confirmation-payment-guard.test.ts` (موجود) | `ls tests/` |

**ما بقي عالقاً (لم يُحسم، ولم يُخمَّن):**
1. **PERM-01 (متبقٍّ):** قرار `revenue:read`/`report:read` لـADMIN — مفتوح (P2).
2. **أدلّة الاختبارات تاريخية:** لم تُعَد حِزم SEC-01/02/03 وPERM-01A/B وE2E في هذه الجولة (Postgres/Docker ممنوعان).
3. **`docs/management/`:** الدليل مبنيّ صراحةً من `e43dee4` (الأساس) **قبل** إصلاحات PERM-01B/C، فصفوفه عن المخزون/المنتجات/المكاتب **لم تُحدَّث** لتعكس: قراءة ADMIN لكل المخزون، وحراسة مسارات الكيانات بالصلاحية، وربط التقارير. لم يُعَد توليده (Chromium متاح، لكن `pypdf` غير مثبَّت، ولن أُثبّت حزم نظام) — التحديث موصى به لكنه خارج ما أُنجز آلياً.
4. **`docs/FULL_PROJECT_COVERAGE_AUDIT.md` نفسه** كان يُدرج SEC-03/PERM-01 مفتوحين — صُحّح الآن (هذا القسم).

**ما لم يُلمَس (بقصد):** `docs/GAP_REGISTER.md` و`docs/PERM-01C_RBAC_CLEANUP.md` (متّسقان مع الكود)؛ لم يُحذف أو يُستبدل أي عمل سابق.
