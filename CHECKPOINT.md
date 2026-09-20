# CHECKPOINT — WASIT BUSINESS GLOBAL

> **التاريخ**: 2026-09-19 — **PHASE 18 — UNIT TESTS DONE — 195/195 tests**
> **الفرع**: `feat/messaging-notifications`
> **HEAD**: `5ee9dbd` (Unit tests) — `9d89318` (docs) — `59ada52` (Inventory low-stock) — `75cd6bb` (docs)

---

## ✅ حالة معتمدة — C1: Distributed Rate-Limit Store (2026-09-20)

**الهدف**: إغلاق أول فجوة مفتوحة في `docs/PRODUCTION_GAP_LIST.md` (C1) — كان حدّ المعدل خريطةً في ذاكرة كل عملية، فبتشغيل أكثر من نسخة تتضاعف الحدود الفعلية.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 |
| **Full Test Suite** | ✅ **376/376 — 38 ملف** (364 سابقًا + 12 جديدة في `rate-limit.test.ts`) |
| **Production bundle** | ✅ `npm run build:prod` نظيف؛ E2E حقيقي عبر `dist-bundle/index.cjs` مع Postgres |
| **Migration** | `0016_breezy_lester.sql` — **إضافية فقط** (`rate_limit_counters` + فهرس)، لا drop ولا تغيير على أي جدول قائم |
| **الواجهة الأمامية** | لا تغيير |

### البنية
- `packages/server/src/lib/rate-limit/port.ts` — عقد `RateLimitStore` (`increment` / `reset` / `purgeExpired`).
- `memory.ts` — المخزن داخل العملية (تطوير/اختبارات/نسخة واحدة) بسلوك النافذة الثابتة السابق.
- `postgres.ts` — مخزن مشترك؛ `increment` عبارة upsert **واحدة ذرّية** تُنشئ الدلو أو تُصفّر النافذة المنتهية في نفس القيد (لا lost updates تحت التزامن).
- `resolve.ts` — `resolveRateLimitStore` حسب `RATE_LIMIT_STORE=memory|postgres` + `setRateLimitStore`/`rateLimitStoreStatus`.
- `middleware/rate-limit.ts` — يفوّض للمخزن؛ **الموضوع per-user** (`user:<id>`) للمصادَق و`ip:<ip>` للمجهول. `resetRateLimitStore()` صار async (واجهة الاختبارات فقط).

### الفروق
- جدول `rate_limit_counters` (مفتاح `bucket_key`, `count`, `expires_at`, `expires_at_ms`, timestamps) — لا PII، عدّادات فقط.
- purge: `scheduler` (`RATE_LIMIT_PURGE_INTERVAL_MINUTES`, افتراضي 15) + `POST /api/admin/rate-limits/purge` (`admin:system` + Audit `RATE_LIMIT.PURGE_RUN`).
- `GET /api/health/channels` يعرض `rateLimit: { store, durable }` بلا أسرار.
- env جديد: `RATE_LIMIT_STORE`، `RATE_LIMIT_PURGE_INTERVAL_MINUTES` في `env.ts` و`.env.example`.

### إثبات E2E حقيقي (bundle + Postgres)
- `RATE_LIMIT_STORE=postgres` → `/api/health/channels` = `rateLimit:{store:"postgres",durable:true}`.
- burst `forgot-password` (حدّ 5/300s): `200 200 200 200 200 429 429`، والصف في DB `auth-forgot:ip:203.0.113.240|7`.
- العدّاد **ثبت عبر إعادة تشغيل العملية** (قُرئ مباشرة من Postgres بعد الإيقاف) — هذا هو الفرق الجوهري عن المخزن السابق.
- `POST /api/admin/rate-limits/purge` بلا جلسة → 401 (محمي).
- تم حذف صف الاختبار ثم التأكد من عدم بقاء أي عملية/صفوف.

### الملفات
- جديدة: `src/db/schema/rate_limit.ts`, `src/lib/rate-limit/{port,memory,postgres,resolve}.ts`, `src/db/migrations/0016_breezy_lester.sql` (+snapshot), `tests/rate-limit.test.ts`.
- معدّلة: `middleware/rate-limit.ts`, `lib/rate-limit/resolve.ts`, `lib/scheduler.ts`, `lib/env.ts`, `index.ts`, `db/schema/index.ts`, `modules/health/routes.ts`, `modules/admin/engines-routes.ts`, `tests/security-privacy.test.ts`, `tests/sms.test.ts`, `.env.example`, docs.

### القرار المعماري
- **لا Redis**: Postgres كافٍ، وتفادى خدمة إضافية؛ العقد يسمح بإضافة Redis لاحقًا دون لمس الـrouter. سُجِّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-038).

---

## ✅ حالة معتمدة — PHASE 18: Unit Tests (2026-09-19)

**الهدف**: تنفيذ الجزء الأول المتبقي من PHASE 18 (طبقة Unit Tests) بدون لمس أي كود إنتاجي.

| البند | النتيجة |
| --- | --- |
| **Unit Tests جديدة** | ✅ **40 اختبارًا — 8 ملفات** تحت `packages/server/tests/unit/` |
| **المجموعة الكاملة** | ✅ **195/195 — 22 ملف** (155 تكامل + 40 وحدة) |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 — صفر أخطاء |
| **كود إنتاجي معدّل** | لا شيء — ملفات اختبار جديدة فقط |
| **Schema/Migrations** | لا تغيير |

### التغطية (pure functions معزولة، بلا DB وبلا mocks)
| الملف | الدوال |
| --- | --- |
| `unit/money.test.ts` | `toDecimal`, `fmt`, `isNegative`, `assertNonNegative`, `roundMoney` |
| `unit/commission.test.ts` | `commissionForAmount` + `commissionSplitForAmount` (النسب تُمرَّر — لا 3% ولا 4% Hardcoded) |
| `unit/slugify.test.ts` | `slugify` (ASCII + عربي + سقف 200 حرف) |
| `unit/revenue-scenario.test.ts` | `calculateScenario` (حساب المحاكاة + حرس الإيراد الصفري) |
| `unit/risk-actions.test.ts` | `recommendedActionFor` |
| `unit/trust-explain.test.ts` | `explainTrustScore` |
| `unit/security-token.test.ts` | `hashToken`, `parseBearerToken`, `signToken`, `verifyToken` (تلاعب + انتهاء) |
| `unit/mfa.test.ts` | `generateMfaSecret`, `generateMfaQrUri`, `generateTotp`, `verifyTotp`, `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode` |

### المتبقي لإغلاق PHASE 18
- **E2E حقيقي مع الواجهة (Playwright)** — الطبقة رقم 6 في `docs/TESTING_STRATEGY.md`، **لم تبدأ** بأمر صريح.
- تحديث `docs/TESTING_STRATEGY.md` ليعكس الطبقة المنفّذة (Unit) والعدد الفعلي.

---

## ✅ حالة معتمدة — Inventory Low-Stock Notifications (2026-09-19)

**الهدف**: إغلاق أول مهمة PENDING — إشعارات المخزون المنخفض. أقل تغيير معماري: استخدم نظام Notifications الموجود، بلا جدول جديد، بلا migration.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 — صفر أخطاء |
| **Full Test Suite** | ✅ **155/155 — 14 ملف** (149 سابقًا + 6 جديدة) |
| **Inventory Suite** | ✅ 17/17 (`tests/inventory.test.ts` — 11 قديمة + 6 جديدة) |
| **Migration** | لا شيء — لا تغيير schema |

### السلوك الجديد (transition-based)
- الإشعار يُصدر فقط عند **انتقال هبوطي** بين الحالات: `IN_STOCK→LOW_STOCK`، `IN_STOCK→OUT_OF_STOCK`، `LOW_STOCK→OUT_OF_STOCK`.
- البقاء في نفس الحالة (أو العودة إلى `IN_STOCK`) **صامت**، لكن العودة تُعيد تسليح العنصر فيُصدر إشعار جديد عند هبوط لاحق.
- الإشعار يُسلَّم الآن إلى **المستخدم المالك** عبر `resolveSellerUserId(db, sellerId)` (عكس `resolveOwnedSellerIds`) — سابقًا كان `notifications.user_id` يُكتب بـ seller entity id فلا يصل الإشعار للمستخدم.
- `applyStockMovement` أصبح **ذرّيًا** (guarded SQL increment + RETURNING) فلا يمكن لحركات متزامنة أن تُنزل المخزون تحت الصفر.
- `setMyStock` يُصدر إشعارًا عند تجاوز الحد يدويًا بنفس قواعد الانتقال.

### الملفات
- `packages/server/src/lib/inventory-engine.ts` — محرك الانتقالات + الذرّية
- `packages/server/src/lib/seller-ownership.ts` — `resolveSellerUserId` جديدة
- `packages/server/src/modules/inventory/service.ts` — إشعار عند `setMyStock`
- `packages/server/tests/inventory.test.ts` — 6 اختبارات تكامل جديدة

### القرار التالي
- **PENDING التالي**: Price Comparison Engine (Module مطلوب صراحةً §15) أو توسيع E2E (PHASE 18). لا Module جديد حتى أمر منفصل.

---

## ✅ حالة معتمدة — Geo + Subscription مكتملتان ومتحققتان (2026-09-17)

**الهدف**: إغلاق مرحلتي Geo وSubscription: ربط المسارات في `app.ts`، تشغيل الاختبارات فعليًا على PostgreSQL 17، إصلاح السبب الجذري لأي فشل، ثم commits منفصلة.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ PostgreSQL 17 مثبّت ومشغّل (`data_directory=/workspace/pgdata`، `wasit_dev` + `wasit_test`) |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = **exit 0 — صفر أخطاء** |
| **Full Test Suite** | ✅ **149/149 ناجحة — 14 ملف اختبار** |
| **Subscription** | ✅ 10/10 (`tests/subscriptions.test.ts`) |
| **Geo API** | ✅ 16 مسار GET عام (countries/regions/cities/currencies/languages/exchange-rates) + zod query validation |

### إصلاحان جذريان (Subscription)
1. **Audit actorId**: الـ routes كانت تمرّر `AppContext` إلى `writeAudit` بينما `AuditContext` يتطلب `actorId` → `audit_logs.actor_id` كان يصبح NULL. أُصلح بالتمرير الصحيح `{ actorId: ctx.user!.id, ipAddress, userAgent }` — بنفس النمط المعتمد في auth/orders/verification/suppliers.
2. **RBAC test setup**: `createUserWithRole` كان يسجّل المستخدم دائمًا كـ CUSTOMER ثم **يضيف** الدور المطلوب، فيحمل SUPPORT + CUSTOMER معًا ويمرّ `userHasAnyRole` بصلاحية CUSTOMER → 200 بدل 403. أُصلح بحذف الدور الافتراضي قبل إدراج الدور المقصود (دور واحد فقط). **RBAC الإنتاجي لم يُلمس.**

### الـ Commits
- `c446741` — `feat(geo): expose geo reference REST API and wire routes`
- `cb4c963` — `fix(subscriptions): record audit actor and correct test role setup`

### تنظيف
- حُذف `packages/web/vite.public.tmp.config.ts` (مؤقت، لا مراجع له).
- `packages/web/vite.config.ts` (host بيئي) و`WASIT_BUSINESS_GLOBAL_UI_REFERENCE_PHASE17.png` (مرجع UI) باقيان خارج commit البرمجي.

### القرار التالي
- إغلاق هذه المرحلة؛ لا Module جديد حتى أمر منفصل.

---

## ✅ حالة معتمدة — TypeScript Clean (2026-09-13)

**الهدف**: إغلاق أخطاء TypeScript في ثلاثة ملفات كانت تمنع جهة الخادم من `tsc --noEmit` النظيف: `tests/subscriptions.test.ts`، `tests/revenue.test.ts`، `src/modules/geo/service.ts` — بلا تغيير في منطق الإنتاج (Production behavior unchanged)، بلا `any`، بلا `sql.raw`.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` (في `packages/server`) = **exit 0 — صفر أخطاء** |
| **Subscriptions test** | ✅ أُصلحت 5 أخطاء TS2339 في `tests/subscriptions.test.ts` — توسعة أنواع `items`/`plans` لإضافة `isActive`/`planTarget`، وتعويض `auditLogs.userId` → `auditLogs.actorId` (عمود الـ audit الفعلي) |
| **Revenue test** | ✅ أُصلحت 3 أخطاء TS2345 في `tests/revenue.test.ts` — استدعاءات `calculateScenario` الثلاثة أكملت كل حقول `ScenarioInput` المطلوبة بقيم محايدة (`0`/`TND`) فلا تتغير النتائج المتوقعة |
| **Geo service** | ✅ أُصلحت 3 أخطاء TS2345 في `src/modules/geo/service.ts` — `conditions` أصبح `(SQL | undefined)[]` (نوع صريح) في `listCountries`/`listCurrencies`/`listLanguages` + استيراد type `SQL` — لا تغيير في منطق الاستعلامات |
| **لا `any`** | ✅ لا يوجد أي استخدام لـ `any` في التعديلات الثلاثة |
| **Scope discipline** | ✅ لم تُلمس `src/modules/revenue/*` Production logic، ولا `src/modules/subscriptions/*`، ولا Analytics، ولا أي Module جديد |

### الملفات
- `packages/server/tests/subscriptions.test.ts` (إصلاح سابق — خارج commit المرحلة الحالية، يعمل قائم في working tree)
- `packages/server/tests/revenue.test.ts`
- `packages/server/src/modules/geo/service.ts` (خطأ سابق: `geo/routes.ts` هو ملف سابق غير متتبع — لم يُلتزم في هذا الـ commit)
- `CHECKPOINT.md` / `AGENTS.md` (تحديث التوثيق)

### أخطاء TypeScript المتبقية
- **Geo**: 0 (كانت 3)
- **Revenue**: 0 (كانت 3)
- **Subscriptions (test)**: 0 (كانت 5)
- **الإجمالي**: 0/0

---

## ✅ حالة معتمدة — Subscriptions / Phase 14 (2026-09-13)

**الهدف**: إغلاق وحدة الاشتراكات: Plans + Subscription lifecycle + Invoices + Rollover + RBAC + Admin — بلا Wallet، بلا تغيير النموذج التجاري، الأسعار من DB (لا Hardcode).



| البند | النتيجة |
| --- | --- |
| **Implementation** | ✅ `src/modules/subscriptions/{types,service,routes}.ts` — plans/subscribe/me/change-plan/cancel/invoices/rollover/admin — audit على كل عملية |
| **RBAC** | ✅ `SUBSCRIPTION_READ_OWN` + `SUBSCRIPTION_CREATE` + `SUBSCRIPTION_UPDATE` + `SUBSCRIPTION_CANCEL` للأدوار التجارية الأربعة (CUSTOMER/MERCHANT/SUPPLIER/COMPANY)؛ `SUBSCRIPTION_MANAGE` للإدارة فقط — صحيح في `shared/rbac.ts` |
| **Permissions** | ✅ `SUBSCRIPTION_CREATE/UPDATE/CANCEL` أُضيفت إلى `shared/permissions.ts` + منحت في RBAC |
| **Integration** | ⚠️ `app.ts` فيه تسجيل `subscriptionRoutes` + `geoRoutes` معًا — لم يُلتزم ليفصل عن Geo (يبقى متاحًا في working tree) |
| **TypeScript / Builds** | ✅ Server typecheck للـ module نظيف؛ Web build ناجح؛ Server build فيه أخطاء `geo/service.ts` القديمة فقط (خارج النطاق) |
| **DB Tests** | ⛔ **لم تُنفذ** — الاختبارات مكتوبة (`tests/subscriptions.test.ts` — 282 سطرًا: plans/lifecycle/RBAC/admin/rollover) لكنها تتطلب PostgreSQL وغير متوفر في هذه البيئة؛ **لا تُسجَّل ناجحة** |
| **لا Wallet** | ✅ لا يوجد رصيد مستخدمين — طلب/تفعيل/ترقية/إلغاء/فوترة فقط |

---

## 1. النطاق المثبَّت في هذا الـ Checkpoint

| المجال | الحالة |
| --- | --- |
| **Subscription Plans** | ✅ `subscription_plans` مزروع: `CUSTOMER_FREE` (مجاني)، `SMALL_MERCHANT` (19)، `COMPANY` (99)، `GLOBAL` (299) — أسعار من DB |
| **Subscription Lifecycle** | ✅ subscribe (idempotent)، read `/me`،change plan (delta invoice عند الترقية)، cancel، invoices، rollover (auto-renew + فاتورة جديدة) |
| **Rollover Service** | ✅ `rolloverDueSubscriptions` — يُجدّد بسبب subscriptions ذات `autoRenew=true` و`status='ACTIVE'` و`endsAt < now()`؛ `startsAt` يرث `endsAt` السابق (مع fallback آمن `?? new Date()`)؛ فاتورة جديدة `INV-` |
| **RBAC** | ✅ 5 صلاحيات Subscription موصولة بدقة في routes (CREATE/UPDATE/CANCEL/READ_OWN/MANAGE) — الأدوار غير التجارية لا تملك CREATE/UPDATE/CANCEL |
| **Admin** | ✅ `SUBSCRIPTION_MANAGE` (ADMIN/SUPER_ADMIN): plan activate/deactivate، list plans/subscriptions/invoices |
| **Audit** | ✅ `SUBSCRIPTION.SUBSCRIBED` / `SUBSCRIPTION.CHANGED_PLAN` / `SUBSCRIPTION.CANCELLED` / `SUBSCRIPTION.INVOICE_ISSUED` — كل عملية تُسجَّل |
| **Tests (مكتوبة)** | ✅ `tests/subscriptions.test.ts` — 282 سطرًا — plans/lifecycle/RBAC/admin/rollover — **مكتوبة ولم تُشغَّل** (تتطلب PostgreSQL) |
| **TypeScript** | ✅ module معزول: نظيف — صفر أخطاء؛ Web build ناجح؛ Server build: أخطاء `geo/service.ts` القديمة فقط |
| **Git** | ✅ Commit انتقائي `feat: complete subscription module` — module+tests+permissions+rbac+docs؛ `app.ts` خارج الـ commit (اختلاط مع Geo) ويبقى working-tree |

---

## 2. الملفات

- `packages/server/src/modules/subscriptions/types.ts` (50 سطرًا)
- `packages/server/src/modules/subscriptions/service.ts` (362 سطرًا)
- `packages/server/src/modules/subscriptions/routes.ts` (172 سطرًا)
- `packages/server/tests/subscriptions.test.ts` (282 سطرًا)
- `packages/shared/src/constants/permissions.ts` (+`SUBSCRIPTION_CREATE/UPDATE/CANCEL`)
- `packages/shared/src/constants/rbac.ts` (+منح 4 للأدوار التجارية)
- `packages/server/src/app.ts` (⚠️ working-tree فقط — لم يُلتزم)

---

## 3. القرار / ملاحظات معلّقة

- **`app.ts`** يحمل تسجيل `geoRoutes` + `subscriptionRoutes` مختلطين في ملف واحد؛ لم يُلتزم في هذا الـ commit ليبقى الـ commit خاصًا بـ Subscription — سيلتزم في commit لاحق مع Geo أو منفصلًا بقرار.
- أي `DECISION REQUIRED` جديد يُسجَّل في `docs/ARCHITECTURE_DECISIONS.md`.

---

## 4. التالي

1. تشغيل PostgreSQL في البيئة ثم `npm test` — كاملاً (بما فيه `tests/subscriptions.test.ts`).
2. الالتزام اللاحق: `app.ts` (مع Geoأو منفصل) + أي إصلاحات ينتجها تشغيل الاختبارات.
3. تحديث هذا الـ Checkpoint بنتائج الاختبارات الفعلية عند توفر PostgreSQL.
4. **توقف** — لا نبدأ Phase جديدة حتى أمر منفصل.

---

## ✅ حالة معتمدة رسمياً — Revenue & Profitability (2026-09-17) — 139/139

**الهدف**: إغلاق وحدة Revenue & Profitability (migration 0007 + schema + module + RBAC + اختبارات) مع تسجيلها في التطبيق الرئيسي `createApp()` — بلا Wallet، بلا تغيير النموذج التجاري.



| البند | النتيجة |
| --- | --- |
| **Full Test Suite** | ✅ **13 Test Files · 139/139 Tests Passed · Exit 0** (138 سابقة + اختبار تكامل واحد جديد) |
| **Revenue Tests** | ✅ **16/16** (`tests/revenue.test.ts` — 15 سابقة + 1 تكامل عبر createApp الحقيقي) |
| **التسجيل في app.ts** | ✅ `import { revenueRoutes }` + `app.route('/api/revenue', revenueRoutes)` (بين analytics وprivacy) |
| **Migrations** | ✅ `0007_rainy_killraven` (revenue_accounts + scenario_reports + 3 enums) — `_journal.json` idx 7، snapshot `7080cac1…` (خلف ff43efb8…) |
| **Schema** | ✅ `src/db/schema/revenue.ts` (82 سطرًا) — مصدَّر عبر `schema/index.ts` → `export * from './revenue'` |
| **RBAC** | ✅ `REVENUE_READ`/`REVENUE_MANAGE`/`REVENUE_SIMULATE` — ممنوحة لـ SUPER_ADMIN فقط (كامل Object.values(P)) |
| **لا Wallet** | ✅ لا يُحفظ رصيد المستخدمين — الجداول P&L التشغيلية + scenario snapshots فقط |



### Revenue Module (الملفات)
- `packages/server/src/modules/revenue/routes.ts` (3 endpoints: `GET /report`,`POST /scenario`,`GET /scenarios)`) — requireAuth + requirePermission + validateBody + audit + owner-scope.

- `packages/server/src/modules/revenue/service.ts` (getRevenueProfitability + calculateScenario + listScenarioReports) — تجميعات من tables حقيقية (`transaction_ledger` CREDIT−DEBIT، `invoices` PAID فقط، `ai_usage` per-currency، `revenue_accounts`) بلا كتابة على البيانات الحية.

- `packages/server/src/modules/revenue/types.ts` + `src/db/schema/revenue.ts` + migration `0007_rainy_killraven`.
- `tests/revenue.test.ts` — **16/16**: pure calculation (3)، routes validation+RBAC (4)، aggregations من tables حقيقية(5)، scenario reports owner-isolation(2)، no-wallet(1)، **integration عبر createApp الحقيقي(1)**.





---



## ✅ حالة معتمدة رسمياً — Phase 17 (Security + Privacy + Audit) — 123/123 (2026-09-15)

**الهدف**: إغلاق متطلبات الأمن/الخصوصية/التدقيق (MFA، Privacy، Audit، Rate-Limit-ordering) مع الالتزام بكل قيود المستخدم (لا rate-limit في الإنتاج، لا تغيير deletion logic، لا bypass عبر DB inserts في اختبارات الخصوصية، عزل rate-limit store عبر test-only mechanism).

| البند | النتيجة |
| --- | --- |
| **Full Test Suite** | ✅ **12 Test Files · 123/123 Tests Passed · Exit 0** (106 سابقة + 17 جديدة لـ Phase 17) |
| **Server TypeScript** | ✅ `tsc --noEmit` exit 0 |
| **Server Build** | ✅ `tsc -p tsconfig.build.json` exit 0 |
| **Web TypeScript** | ✅ `tsc --noEmit` exit 0 |
| **Web Build** | ✅ `vite build` exit 0 (74 modules) |
| **Migrations** | ✅ `0005_privacy_module` + `0006_mfa_recovery_codes` (json) في `meta/_journal.json` — قابلة لإعادة التشغيل (idempotent) |
| **Dev DB** | ✅ داخِل `wasit_dev`: جداول `consent_events`/`data_export_requests`/`data_deletion_requests` موجودة، `enum deletion_stage` موجود، عمود `authenticator_apps.recovery_codes_hash` موجود |

### MFA (RFC 6238 TOTP) — hardened
- **Recovery Codes مخزّنة salted** بصيغة `salt:hash` (salt عشوائي 16 بايت بهرمٌ لكل وسم) — عبر `node:crypto` فقط (لا dependencies جديدة).
- **التحقق** يستخدم `crypto.timingSafeEqual` (constant-time) بعد تساوي الطول.
- **Single-use**: الكود المستعمَل يُحذف من المجموعة المخزنة؛ إعادة استخدامه تفشل (مُثبت باختبار API حقيقي).
- **Backward compatibility**: الهاش القديم غير المملّح (SHA-256 الخام) ما زال يتحقق ويعيد `legacy:true`، ويُرقّى تلقائياً إلى salted عند أول استخدام.
- **لا تسريب**: `enroll` يكشف `secretBase32`+`recoveryCodes` (مرة واحدة للعرض الوجيز كما صُمم)، لكنه **لا** يعيد `recoveryCodesHashed` أو الـ hash؛ `status`/`verify` لا يعيدان secret أو hashes (مُثبت باختبار HTTP Leakage).
- **Rate limiting**: كل MFA endpoints محمية بـ `rateLimit` (enroll 5/60s، confirm 10/60s، disable 10/60s، recovery 5/60s، verify 20/60s، dev-totp 30/60s).
- **`dev-totp`** معطّل في الإنتاج (`NODE_ENV=production` → 403).
- **Audit**: كل MFA transition (`ENROLL/CONFIRM/DISABLE/RECOVERY_REGEN/VERIFY_OK/VERIFY_FAILED`) يكتب في `audit_logs`.

### Privacy Engine
- `GET /api/privacy/me|consents` + `PUT /api/privacy/consents` (grant/revoke + history).
- `POST /api/privacy/export` → `buildUserExport` (بيانات مملوكة للمستخدم فقط، بلا secrets) + سطر `data_export_requests`.
- `POST /api/privacy/deletion` → deactivate فوري + مراحل `REQUESTED → DEACTIVATED → RETENTION/REVIEW → ELIGIBLE → ANONYMIZED/DELETED/REJECTED`.
- Admin: `GET /api/admin/privacy/deletions?stage=` + `PATCH .../:id` (ADMIN/SUPER_ADMIN).
- **ترتيب Middleware على الحساسة**: `rateLimit → requireAuth → validateBody → handler` (rate limit يعمل أيضاً على الـ unauthenticated).
- Privacy routes **لا** تستخدم blanket `use('*', requireAuth)` — auth صريح لكل مسار.

### Rate-limit (test-only mechanism)
- `resetRateLimitStore()` مصدَّر من `middleware/rate-limit.ts` **للاختبار فقط** — إنتاجية `rateLimit()` لم تتغير.
- اختبار burst: 5 POST deletion متتالي من IP ثابت `198.51.100.x` → `[200, 401, 429, 429, 429]` (rate limit قبل auth).

### اختبارات PHASE 17 (17 اختبار — `tests/security-privacy.test.ts`)
1. Security headers على كل استجابة.
2. TOTP deterministic unit.
3. Recovery codes salted + unique salt + round-trip.
4. Legacy unsalted digests verification (backward compat).
5. enroll → confirm → status enabled.
6. verify endpoint يعتمد TOTP صحيح ويرفض غير صحيح.
7. recovery codes عبر verify endpoint.
8. **HTTP responses لا تسرّب secret/hashes/raw**.
9. **Recovery codes single-use** (ثاني استخدام يفشل).
10. disable يتطلب TOTP صحيحاً ويُطفئ mfaEnabled.
11. consent grant + revocation history.
12. user export ownership-bound بلا secrets.
13. export request row + audit trail.
14. deletion request → deactivates (stage DEACTIVATED).
15. admin advance → ELIGIBLE + audit.
16. rate-limit burst (rate limit قبل auth).
17. admin deletion listing + stage filter.

**ملاحظات إغلاق**:
- لا تغيير في `isActive` semantics — عطّل الحساب فقط في deletion request.
- لا حاجة إلى migration جديدة للـ salted recovery (آلية التخزين في column موجود).
- `packages/server/.env` مستثنى من git (`.gitignore`) — لا secrets في الريبو.

---

## ✅ حالة معتمدة رسمياً — Backend Verified 106/106 (2026-09-15)

**الغرض**: تثبيت نقطة تحقق رسمية بعد توفير PostgreSQL 17 وتشغيل الاختبارات بالكامل على قاعدة البيانات الأصلية.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ شُغّل بنجاح: **PostgreSQL 17.11 (Debian 17.11-0+deb13u1)** على `localhost:5432` |
| **قاعدة البيانات** | ✅ شُغّلت قاعدة البيانات الأصلية `/workspace/pgdata` (بدون initdb، بدون migrations يدوية) |
| **الاتصال** | ✅ `pg_isready` = `accepting connections` · `SELECT 1` = `1` |
| **قواعد البيانات الموجودة** | `postgres`, `wasit_dev`, `wasit_test` |
| **`npm run typecheck` (server)** | ✅ نجح — `tsc --noEmit` بلا أخطاء (exit 0) |
| **`npm test` (server)** | ✅ نجح — **11/11 Test Files · 106/106 Tests Passed · 0 Failed · Exit Code 0** |
| **مدة الاختبارات** | 12.70s (transform 718ms, setup 0ms, collect 8.23s, tests 18.41s, env 2ms, prepare 788ms) |

**ملفات الاختبار الـ 11**: `vertical-slice`, `inventory`, `verification-trust`, `messaging`, `payment-fee-policy`, `ads`, `admin-access`, `ai-core`, `analytics`, `phase14-agents`, `phase15-ads-ai`.

**الطريقة**:
- التثبيت: `postgresql-17` + `postgresql-client-17` (رسمية من مستودعات Debian trixie) — الإصدار المطابق للنسخة المحفوظة.
- التشغيل: `sudo -u postgres pg_ctl -D /workspace/pgdata -o "-c config_file=/etc/postgresql/17/main/postgresql.conf -c data_directory=/workspace/pgdata" start` (استرداد تلقائي آمن لإغلاق سابق غير نظيف).
- الأذونات: `sudo chmod 0750 /workspace/pgdata` (كانت `drwxrws---` → أصبحت `drwxr-s---` = 2750، قبلها PostgreSQL بعد التعديل).
- نسخة إنقاذ إضافية (لا تُرفع): `/workspace/pgdata-rescue-COPY-20260915T134904Z`.
- الاختبارات: `cd packages/server && npm test` — تُعيد بناء `wasit_test` تلقائياً (migrations + seed) ثم تشغّل 106 اختباراً عبر API حقيقي.

**ملاحظة تشغيلية مهمة**: عند كل إعادة إنشاء Runtime/Container ستحتاج إلى إعادة تثبيت `postgresql-17` (لا يتضمّنه الجذر) ثم تشغيل القاعدة على `/workspace/pgdata` بالطريقة أعلاه — انظر `AGENTS.md`.

---

## ✅ حالة معتمدة رسمياً — Backend Verified 106/106 (2026-09-15)

**الغرض**: تثبيت نقطة تحقق رسمية بعد توفير PostgreSQL 17 وتشغيل الاختبارات بالكامل على قاعدة البيانات الأصلية.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ شُغّل بنجاح: **PostgreSQL 17.11 (Debian 17.11-0+deb13u1)** على `localhost:5432` |
| **قاعدة البيانات** | ✅ شُغّلت قاعدة البيانات الأصلية `/workspace/pgdata` (بدون initdb، بدون migrations يدوية) |
| **الاتصال** | ✅ `pg_isready` = `accepting connections` · `SELECT 1` = `1` |
| **قواعد البيانات الموجودة** | `postgres`, `wasit_dev`, `wasit_test` |
| **`npm run typecheck` (server)** | ✅ نجح — `tsc --noEmit` بلا أخطاء (exit 0) |
| **`npm test` (server)** | ✅ نجح — **11/11 Test Files · 106/106 Tests Passed · 0 Failed · Exit Code 0** |
| **مدة الاختبارات** | 12.70s (transform 718ms, setup 0ms, collect 8.23s, tests 18.41s, env 2ms, prepare 788ms) |

**ملفات الاختبار الـ 11**: `vertical-slice`, `inventory`, `verification-trust`, `messaging`, `payment-fee-policy`, `ads`, `admin-access`, `ai-core`, `analytics`, `phase14-agents`, `phase15-ads-ai`.

**الطريقة**: 
- التثبيت: `postgresql-17` + `postgresql-client-17` (رسمية من مستودعات Debian trixie) — الإصدار المطابق للنسخة المحفوظة.
- التشغيل: `sudo -u postgres pg_ctl -D /workspace/pgdata -o "-c config_file=/etc/postgresql/17/main/postgresql.conf -c data_directory=/workspace/pgdata" start` (استرداد تلقائي آمن لإغلاق سابق غير نظيف).
- الأذونات: `sudo chmod 0750 /workspace/pgdata` (كانت `drwxrws---` → أصبحت `drwxr-s---` = 2750، قبلها PostgreSQL بعد التعديل).
- نسخة إنقاذ إضافية (لا تُرفع): `/workspace/pgdata-rescue-COPY-20260915T134904Z`.
- الاختبارات: `cd packages/server && npm test` — تُعيد بناء `wasit_test` تلقائياً (migrations + seed) ثم تشغّل 106 اختباراً عبر API حقيقي.

**ملاحظة تشغيلية مهمة**: عند كل إعادة إنشاء Runtime/Container ستحتاج إلى إعادة تثبيت `postgresql-17` (لا يتضمّنه الجذر) ثم تشغيل القاعدة على `/workspace/pgdata` بالطريقة أعلاه — انظر `AGENTS.md`.

---

## ✅ تعديل جديد — Homepage Redesign (2026-09-15) — مُلتزم `15feaf3`

**الهدف**: إعادة تصميم الصفحة الرئيسية فقط وفق الهوية الجديدة **LE WASSIT**.

| البند | النتيجة |
| --- | --- |
| **الاسم الفرنسي الرسمي في الواجهة** | `LE WASSIT` + `BUSINESS GLOBAL` (أسفل الشعار) في ar/fr/en/zh (مفاتيح `brand.name`/`brand.sub`) |
| **حرف W كبير كعنصر هوية** | مكوّن `WMonogram` (SVG بتدرج أزرق-رمادي) مستخدم في: الهيدر، ووترمارك كبير في Hero، قسم À propos |
| **الألوان** | Blue-Gray كامل (`wasit-50..900`) في `tailwind.config.js` — حلّ محل teal؛ أبيض/رمادي فاتح للخلفيات؛ indigo كـ accent |
| **البنية** | Hero (split: نص + رسم SVG لشبكة عالمية `GlobalNetwork`)، شريط بحث (وظيفة حقيقية)، trust bar وصفي (بلا أرقام وهمية)، Solutions، Markets (رابط صفحات حقيقية)، Categories/Latest Products/Trusted Suppliers (بيانات حقيقية من DB)، À propos، Ressources، CTA + Contact |
| **PublicLayout** | هيدر/فوتر جديدان (nav فرنسي: Accueil/À propos/Solutions/Marchés/Ressources/Contact + قائمة موبايل ☰)؛ الفوتر يحافظ على كل الوظائف (suppliers/merchants/companies/categories) |
| **إزالة الـ stats الوهمي** | أُزيلت بطاقات الأرقام "—" التي كانت تقرأ `adminStats` (401 للزوار) — لا أرقام وهمية |
| **Teal leaks** | ProductCard/Spinner/Badge تحوّلت إلى `wasit` blue-gray |
| **index.html** | العنوان `LE WASSIT — Business Global` + meta description |
| **التحقق** | Web Typecheck ✅ · Web Build ✅ · FR ✅ · AR RTL ✅ · EN ✅ · ZH keys ✅ (45/45 في كل لغة) · Home Search E2E ✅ ("olive" → 6 منتجات/1 مورد/1 فئة) · Backend `ready+connected` ✅ |

**ملاحظة**: HomePage أصبحت ملفوفة بـ `PublicLayout` (كانت سابقاً بلا هيدر/فوتر). لا تغييرات Backend/DB في هذا التعديل.

---

# CHECKPOINT — WASIT BUSINESS GLOBAL

> **التاريخ**: 2026-09-14 (21:57 UTC) — **MASTER CHECKPOINT**
> **الفرع**: `feat/messaging-notifications`
> **مرجع الـ commit**: `checkpoint-master-2026-09-14` (tag) — `chore: create master project checkpoint`؛ أساسه `f520d2e9…` (Phase 14)
>
> **الغرض**: تثبيت الحالة الرسمية بعد إكمال **Phase 13 (AI Core + AI Agents + AI Dashboard Integration)** ثم **Phase 14 (Specialized AI Agents — executors متخصصة)** ثم تقدّم **Phase 15 (Advertising + AI Ads)**.

---

## 1. النطاق المثبَّت في هذا الـ Checkpoint

| المجال | الحالة |
| --- | --- |
| **حماية PostgreSQL (Persistence)** | ✅ PGDATA على Persistent Volume `/workspace/pgdata` (لا يضيع عند إعادة إنشاء Runtime/Container) |
| **Backup / Restore** | ✅ `scripts/backup-db.sh` + `scripts/restore-db.sh` + نسخ احتياطية في `backups/` |
| **AI Provider Abstraction** | ✅ `src/lib/ai/provider.ts` — `local-heuristic` (افتراضي) / `noop` / OpenAI-compatible / Anthropic — اختيار المزود من env فقط، نحن لا نجعل مزوداً Hardcoded |
| **Model Routing** | ✅ `src/lib/ai/routing.ts` — capability→model policy (قابل للتعديل من DB) + RBAC-aware (غير الإداريين ينزلون للـ default model) + fallback لـ local-heuristic |
| **AI Runtime** | ✅ `src/lib/ai/runtime.ts` — resolve→budget→call→cost→record→usage (end-to-end) |
| **Cost Control + Usage** | ✅ `src/lib/ai/cost-control.ts` — budgets per user, limits, token/cost usage + `ai_budgets/ai_usage` في DB |
| **Endpoints / Consumption** | ✅ `src/lib/ai/endpoints.ts` — `runMarketAnalysis`, `runRecommendations`, `runSupplierRecommendations`, `runPriceIntelligence` — حقيقية (DB-backed) |
| **Self Endpoints** | ✅ `src/lib/ai/self-endpoints.ts` — `runSmartSearch`, `runSalesIntelligence`, `myActivity` |
| **Product Agent** | ✅ `src/modules/ai/service.ts` — `analyzeProduct` (تحليل listing حقيقي) |
| **Specialized Agents (Phase 13 catalog)** | ✅ `src/modules/ai/agents.ts` — كتالوج 11 وكيلاً (`agent_registry` auto-seed) + تنفيذ tasks (gated بموافقة بشرية لـ 6) + audit + notifications |
| **Phase 14 — Specialized Executors** | ✅ **جديد** `src/modules/ai/executors.ts` — منفّذ DB-backed خاص لكل وكيل من الـ11 (بدلاً من executor عام واحد)؛ الـ `createAgentTask`/`decideAgentTask` يوجهان إليه |
| **AI Routes API** | ✅ `src/modules/ai/routes.ts` — 20+ endpoint محمية بـ `AI_USE` / `AI_MANAGE` / `ADMIN_AI` + validation + audit |
| **RBAC** | ✅ `AI_USE` ممنوح لـ CUSTOMER + `AI_MANAGE`/`ADMIN_AI` للإدارة فقط؛ الـ executors تُفرض capabilities لكل وكيل |
| **Public health** | ✅ `/api/health/ai` عام (لا يحمل بيانات حساسة) |
| **Web — API layer** | ✅ `packages/web/src/lib/api.ts` — دوال AI كاملة (status, models, budget, activity, run, smart features, agents, create task, my tasks) |
| **Web — DashboardAI (مرتبط)** | ✅ `DashboardAIPage` في `DashboardBusinessPages.tsx` — inputs حقيقية لكل وكيل + عرض structured results + marketingVideos (معاينة/تنزيل) |
| **i18n** | ✅ مفاتيح AI كاملة في ar/en/fr/zh + مفاتيح الفيديو (`ai.videos.*`) |
| **الفحوص** | ✅ Server Typecheck / **94/94 Tests** (منها Phase 14 20/20، Phase 15 5/5) / Web Typecheck / Web Build كلها PASS |

## 2. قاعدة البيانات

| القاعدة | migrations | جداول | seed | ملاحظات |
| --- | --- | --- | --- | --- |
| `wasit_dev` | 0000→0004 | **74** | (present؟ لا — schema مؤكد؛ seed Data غير ممتلئة حالياً ولا نعمل عليه الآن) | `ai_models` = 3 نماذج active؛ `agent_registry` = 11 (auto-seed) |
| `wasit_test` | 0000→0004 | **74** | — (يعيد بناءه vitest عند كل تشغيل) | اتصال وتطبيق migrations سليم |

**أدوار/وصول**: `wasit` (SUPERUSER+CREATEDB)؛ `DATABASE_URL` في `packages/server/.env` — **لا تُرفع أبداً**.

## 3. أدوات الاستعادة

- إعادة تشغيل PG بعد إعادة إنشاء الحاوية:
  ```bash
  sudo pg_ctlcluster 17 main start
  # إن لزم إعادة تعيين data_directory:
  sudo sed -i "s|data_directory = '.*'|data_directory = '/workspace/pgdata'|" /etc/postgresql/17/main/postgresql.conf
  ```
- نسخة كاملة: `./scripts/backup-db.sh`
- استعادة: `./scripts/restore-db.sh ./backups/<stamp>/ [--with-test]`

## 4. الحالة الوظيفية للمنصة

- ✅ Phases 0–12 مكتملة: Auth+RBAC، Categories/Products، Search، Orders+Commission 4% مُقسَّمة 2%+2% (Policy Engine)+Ledger، Inventory، Messaging/Notifications، Verification+Trust، Risk، Disputes، Advertising.
- ✅ **Phase 13 (AI Core + AI Agents + AI Dashboard Integration) مكتملة**: provider/routing/runtime/cost-control + consumption (market analysis, recommendations, smart search, supplier recs, price/sales intelligence, product analysis) + 11 agents + RBAC + واجهة Dashboard حقيقية.
- ✅ **Phase 14 (Specialized AI Agents — executors متخصصة)**: `src/modules/ai/executors.ts` يستبدل الـ `executeLocalAdvice` العام بمنفّذ DB-backed خاص لكل وكيل من الـ11:
  - `sales-agent` → KPI مبيعات/period + leads + recent orders
  - `marketing-agent` → نشر products + top categories/brands + **marketingVideos** (عقد معاينة/تنزيل) + campaign suggestion
  - `ads-agent` → campaigns/ad events (impressions/clicks/conversions/CTR) + recommendation
  - `product-agent` → تحليل منتج حقيقي (variants/images/inventory/completeness) عبر productId
  - `support-agent` → threads/unread messages + recommendation للرد
  - `analytics-agent` → snapshot كامل (users/products/orders/gmv/avg basket/topProducts/dailyKpis)
  - `market-research-agent` → avg price + categories + total order value
  - `b2b-agent` → matching suppliers↔merchants/companies (مع إشارة verified)
  - `risk-agent` → risk profiles/events + severe posture
  - `dispute-assistant` → open disputes + recent dispute messages + recommendation
  - `development-agent` → snapshot نمو (users/products/orders/campaigns/daily KPIs) + nextSteps
- ✅ **94/94 اختباراً ناجحاً** (10 files؛ منها Phase 14 20/20، AI Core 13/13، Phase 15 5/5).
- ✅ **E2E (curl)**: `/api/health/ai` عام يعمل؛ تسجيل/دخول CUSTOMER → agents (11)؛ marketing تعيد marketingVideos ببيانات حقيقية بعد إدراج منتجات؛ product-agent يعيد completeness لمنتج حقيقي؛ ads-agent يُرفض بـ 403 لغير المخوّل (RBAC)؛ sales-agent gated → ADMIN يوافق عبر HTTP → `approved` + result.

## 5. ملاحظات / قرارات معلّقة

- `wasit_dev` تحتوي الـ schema (74) وليس بيانات seed كاملة حالياً — عند الحاجة للتطوير الـlive نعيد تشغيل `db:seed` + `db:seed:demo` بعد إذن منفصل (لا نلمسه الآن).
- **Phase 14 — Video Generation Pipeline**: `marketingVideos` في وقتنا الحالي يمثل **عقداً** (contract) — كل فيديو يعيد `previewable: true` / `downloadable: true` / `mimeType: 'video/mp4'` مع `mediaUrl: null`. عند إدراج Media Generation/Storage فعلي لاحقاً يُملأ `mediaUrl` (بالضبط كأصل قابل للمعاينة والتنزيل داخل المنصة). لا ندّعي أن توليد الفيديو الفعلي اكتمل.
- Phase 14 تدفع `runAIFeature` لكل task لأغراض **usage/cost/audit**، بينما النتيجة structured DB-backed تعتمد على `local-heuristic` (إلا عند تفعيل مزود خارجي في env).
- الـ provider الافتراضي في البيئة هو `local-heuristic` (تحليلي حقيقي بلا LLM إلا عند ضبط `AI_PROVIDER`+`AI_API_KEY`). لا يوجد Fake: بدون مفتاح يعمل deterministic engine، ومع مفتاح يعمل LLM فعلي.
- أي `DECISION REQUIRED` جديد يُسجَّل في `docs/ARCHITECTURE_DECISIONS.md`.

## 6. التالي

1. **MASTER CHECKPOINT 2026-09-14**: تحديث CHECKPOINT.md + AGENTS.md (Phase 15 موثّقة).
2. Commit مرجعي: `chore: create master project checkpoint` (يشمل التغييرات غير الملتزمة لـ Phase 15 — لا حذف).
3. إنشاء `WASIT_BUSINESS_GLOBAL_MASTER_CHECKPOINT_2026-09-14.zip` (بدون `.env`/secrets؛ يتضمن `.env.example`).
4. إنشاء `WASIT_BUSINESS_GLOBAL_ADVANCED_STATUS_REPORT_2026-09-14.md`.
5. **توقف** — لا نبدأ Phase 16 حتى أمر منفصل.