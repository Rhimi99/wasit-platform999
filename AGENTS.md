# AGENTS.md — WASIT BUSINESS GLOBAL

ذاكرة الوكيل لحالة المشروع وإرشادات البناء.

## المشروع

منصة وساطة تجارية B2B/B2C عالمية: Marketplace + Commerce + Trust + AI + Advertising + Analytics.
تبدأ من تونس لكن البنية Global-first (لا تونس Hardcoded في الـ Core).

## Stack

- **Monorepo** (npm workspaces): `packages/server`, `packages/shared`, `packages/web`
- **Backend**: TypeScript + Hono + Drizzle ORM + PostgreSQL + zod + argon2 + decimal.js
- **Shared**: أدوار/صلاحيات (USER_ROLES, PERMISSIONS, ROLE_PERMISSIONS) + ApiError + RBAC helpers
- **Tests**: Vitest (تكامل ضد قاعدة `wasit_test`)

## أوامر شائعة (من packages/server)

| الأمر | الغرض |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `tsc -p tsconfig.build.json` (emit فقط من src) |
| `npm test` | `vitest run` (يعيد بناء wasit_test تلقائياً) |
| `npm run db:generate` / `db:migrate` | Drizzle migrations |
| `npm run dev` | tsx watch |

## E2E Testing (Playwright — 2026-09-19، Phase 18)

```bash
npm run test:e2e     # من الجذر — يشغّل server + web تلقائياً ضد wasit_dev
```

- `e2e/{auth,marketplace,rbac,ads}.spec.ts` — 28 اختباراً، لا Mocks ولا route interception.
- `e2e/global-setup.ts` يشغّل `db:seed:demo` (idempotent، لا drop/drop schema) ثم يبني `storageState` لكل دور عبر `POST /api/auth/login` الحقيقي (يتفادى login rate-limit). الجلسات في `e2e/.auth/` وهي git-ignored.
- **Self-healing**: إذا رجع login دور 401 (مثلاً بعد اختبار استعادة كلمة المرور)، يصلح كلمة المرور تلقائياً عبر مسار forgot/reset الحقيقي.
- `auth.spec.ts` يمارس نموذج الدخول نفسه؛ بقية الـ specs تستخدم `storageFor(role)` من `e2e/helpers.ts`.
- عقد `POST /api/orders` يعيد `{ orderId, orderNumber, itemsTotal, commission, paymentFee, grandTotal, currencyCode, transactionId }` — **ليس** `{ id }` (كان bug في `api.createOrder`/`CheckoutPage` وصُحّح).
- عند إضافة E2E: استخدم `storageState` للأدوار الجاهزة بدل الدخول عبر الواجهة لكل اختبار؛ وثّق أي استدعاء يغيّر حالة مشتركة (كلمة مرور/مخزون) وأعدها.

## بنى مهمة

- **Multi-module**: `src/modules/<name>/{routes.ts,service.ts}` — routes تعرّف middleware (auth/role/validation)، service يعالج DB + Audit.
- **استجابة موحدة**: `{success:true,data}` / `{success:false,error:{code,message,fieldErrors?,traceId?}}`.
- **أخطاء**: `ApiError` (من shared)؛ `app.onError` يترجم لـ HTTP صحيح (403/409/422...). لا رسائل عامة.
- **RBAC**: `requireAuth`, `requireRole('X')`, `requirePermission(PERMISSIONS.X)` في backend حصراً. إخفاء واجهة ≠ صلاحية.
- **Audit**: `writeAudit(db, ctx, {action, entityType, entityId, before?, after?, metadata?})` لكل تغيير مهم.
- **Commission**: أي مسار يستخدم سياسة من DB — لا Hardcode 3%/4% في الكود.

## قواعد ذهبية

1. لا Wallet. WASIT لا يحتفظ برصيد عملاء.
2. لا تغيّر النموذج التجاري (العمولة 4% قاعدة = 2% بائع + 2% مشتري) من نفسك.
3. لا تستخدم Mock Data كوظيفة؛ Seed فقط للتطوير/الاختبار.
4. كل وظيفة HTML/API يجب تمريرها عبر Service → DB + Validation + Auth + Audit + اختبار.
5. شغّل `npm test` بعد أي مرحلة وأصلح قبل الانتقال.
6. `hono` param('id') قد يعيد `string | undefined` — استخدم `!` بعد التأكد من وجود المسار.
7. `tsconfig.json` noEmit شامل (src+tests)؛ `tsconfig.build.json` يبني src فقط.
8. لا Secrets في الريبو — كل شيء عبر Env.
9. RTL/LTR تدعمه الواجهة المستقبلية; النصوص عبر Translation Keys (ar/fr/en) وليست ضمن components.
10. أي قرار تجاري/قانوني غير محدد → سجّله `DECISION REQUIRED` في docs/ARCHITECTURE_DECISIONS.md بدل افتراضه.

## PostgreSQL Persistence (2026-09-14) — مهم جداً

- **PGDATA على Persistent Volume**: `/workspace/pgdata` (وليس `/var/lib/postgresql/17/main` المؤقت). بعد كل إعادة إنشاء Runtime/Container، لا تفقد قاعدة البيانات.
- **`data_directory = '/workspace/pgdata'`** في `/etc/postgresql/17/main/postgresql.conf` (عبر `sudo sed -i ...` ثم `sudo pg_ctlcluster 17 main start`).
- أدوات postgres ليست في PATH افتراضياً: `export PATH="/usr/lib/postgresql/17/bin:$PATH"`.
- **Backups**: `scripts/backup-db.sh` (pg_dump لـ wasit_dev + wasit_test + globals نحو `backups/<stamp>/`) و `scripts/restore-db.sh`. الاحتياطيات الحالية في `backups/`.
- `backups/pg_globals.sql` يحتوي password hashes (SCRAM) — **مستبعد من git**. النسخ الاحتياطية `*.dump` مستثناة من ZIP (لأنها قد تكبر) لكنها مرجع الاستعادة.
- إعادة التشغيل من صفر: `sudo pg_ctlcluster 17 main start` → migrations 0000→0004 (drizzle) → seed.

## TypeScript Clean (2026-09-13) — Server tsc = 0 أخطاء

- **`tests/subscriptions.test.ts`**: أُصلحت 5 أخطاء (`isActive`/`planTarget` types + `auditLogs.actorId` بدل `userId`).
- **`tests/revenue.test.ts`**: أُصلحت 3 أخطاء — استدعاءات `calculateScenario` أكملت كل `ScenarioInput` (`expectedOrders/avgOrderValue/subscriptionRevenue/advertisingRevenue/aiCosts/operationalExpenses/currencyCode` بقيم محايدة) — النتائج المتوقعة لم تتغير.
- **`src/modules/geo/service.ts`**: أُصلحت 3 أخطاء — `conditions: (SQL | undefined)[]` صريحة في `listCountries/listCurrencies/listLanguages` + `import type { SQL }` — سلوك الاستعلامات لم يتغير.
- **أمر التحقق**: `cd packages/server && npx tsc --noEmit` → **exit 0**. لا توجد أخطاء متبقية في Geo/Revenue/Subscriptions.

## الحالة الحالية(2026-09-17) — Revenue & Profitability — 139/139 Tests

- ✅ **Revenue module مكتمل ومدمج في createApp() الحقيقي**: `app.route('/api/revenue', revenueRoutes)` في `packages/server/src/app.ts` (بين analytics وprivacy.



- ✅ **اختبارات Revenue**: **16/16** (`tests/revenue.test.ts` — منها اختبار تكامل عبر createApp الحقيقي مع SUPER_ADMIN:register مباشر + login + POST /api/revenue/scenario →  ‏200 + حساب 30/15/15/50%.



- ✅ **المجموعة الكاملة**: **13 Test Files · 139/139 Tests · Exit 0** — بعد دمج Revenue لا كسر في أي module سابقا.



- **Migrations**: `0007_rainy_killraven` (revenue_accounts + scenario_reports + 3 enums) في `_journal.json` (idx  ‏7) + snapshot في `meta/0007_snapshot.json`.



- **RBAC**: `REVENUE_READ`/`REVENUE_MANAGE`/`REVENUE_SIMULATE` في permissions(ممنوحة لـ SUPER_ADMIN فقط. لا `PLATFORM_OWNER` — أعلى دور = `SUPER_ADMIN`.



- **لا Wallet**: module يقرأ فقط من `transaction_ledger`/`invoices`/`ai_usage` ويخزنP&L + scenario snapshots(لا رصيد مستخدمين، لا holds).



- **لم يُعتمد** — لا commit، لا ZIP (بانتظار إذن منفصل.



## الحالة الحالية (2026-09-15) — Backend Verified 106/106 Tests

- **PostgreSQL 17.11 (Debian 17.11-0+deb13u1)** شُغّل بنجاح على `localhost:5432` من قاعدة البيانات الأصلية `/workspace/pgdata` (بدون initdb، بدون migrations يدوية). `pg_isready`=accepting · `SELECT 1`=1.
- **تشغيل Postgres من الجذر** (الـ binaries لا تتضمنها صورة الحاوية):
  ```bash
  sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-client-17
  # الأذونات (تتطلب 0700 أو 0750):
  sudo chmod 0750 /workspace/pgdata
  # التشغيل على القاعدة الأصلية:
  sudo -u postgres /usr/lib/postgresql/17/bin/pg_ctl -D /workspace/pgdata -o "-c config_file=/etc/postgresql/17/main/postgresql.conf -c data_directory=/workspace/pgdata" -l /tmp/pg-wasit-conf/pg-debian.log start
  ```
- **الفحص الشامل (2026-09-15)**: `npm run typecheck` ✅ (0 أخطاء) · `npm test` ✅ **11/11 files · 106/106 tests · 0 failed · exit 0** (مدة ~12.7s).
- **نسخة إنقاذ** إضافية للقاعدة (لا تُرفع): `/workspace/pgdata-rescue-COPY-20260915T134904Z`.

## الحالة الحالية (2026-09-14) — Checkpoint AI Foundation + Phase 14 Specialized Agents

- ✅ **AI Core Foundation (جداول + migration 0004)**: `ai_models` (3 نماذج active: anthropic-claude-sonnet-4, openai-gpt-4o-mini, local-heuristic) + `agent_registry` (11 وكيلاً auto-seed عبر `ensureAgentRegistrySeeded` عند أول `listAgents`) + `agent_tasks`. الجداول القديمة `ai_requests/ai_usage/ai_budgets` من 0000.
- ✅ **AI modules**: `src/lib/ai/` (`types.ts`, `provider.ts`, `runtime.ts`, `cost-control.ts`) + `src/modules/ai/` (agents/routes/service) + Admin `src/modules/admin/ai-routes.ts` على `/api/admin/ai`.
- ✅ **AI Cost Control**: budgets/limits/routing — لا يوضع `serviceUnavailable` إلا بعد إضافة `ApiError.serviceUnavailable` (503 + ErrorCode `SERVICE_UNAVAILABLE`) في `@wasit/shared`.
- ✅ **إصلاحات TypeScript تم اختبارها**: cost-control SQL (varchar→numeric→text)، writeAudit signature `(db, ctx, entry)`، agents types (AgentCapability import، description `?? ''`، executeLocalAdvice 3 args، error unknown)، routes `ApiError.forbidden` بدون `new`.
- ✅ **التحقق الكامل**: Server Typecheck PASS / **56/56 tests PASS** / Web Typecheck PASS / Web Build PASS.

## Phase 13 — AI Core + AI Agents (مكتملة — 2026-09-14)

- ✅ **AI Provider Abstraction** (`src/lib/ai/provider.ts`): `local-heuristic` (افتراضي)، `noop`، OpenAI-compatible، Anthropic — الاختيار من env فقط (لا مزود Hardcoded). بدون مفتاح يعمل deterministic engine (حقيقي، ليس Mock)؛ مع مفتاح يعمل LLM الفعلي.
- ✅ **Model Routing** (`src/lib/ai/routing.ts`): capability→model policy من DB (`ai_models`) + RBAC-aware (غير الإداريين ينزلون للـ default model) + fallback. `assertSafeModelKey` للتحقق.
- ✅ **AI Runtime** (`src/lib/ai/runtime.ts`): `runAIFeature` — resolve provider → budget pre-check → call → exact cost → `recordAiRequest` + `upsertAiUsage`; `runAIFeatureStructured` للنتائج المهيكلة.
- ✅ **Cost Control** (`src/lib/ai/cost-control.ts`): `assertWithinBudget`, budgets per user/period, `recordAiRequest`, `upsertAiUsage`, `currentPeriodWindow`, `aiUsageForPeriod`. إصلاح `cost` (numeric/text) لتجنب خطأ النوع.
- ✅ **AI Consumption (DB-backed)** — `endpoints.ts`: `runMarketAnalysis`, `runRecommendations`, `runSupplierRecommendations`, `runPriceIntelligence`؛ `self-endpoints.ts`: `runSmartSearch`, `runSalesIntelligence`, `myActivity`؛ `service.ts`: `analyzeProduct` (تحليل listing حقيقي)، `getAiStatus`, `listMyAiActivity`, `adminUsageSummary`.
- ✅ **Specialized Agents (11)**: كتالوج كامل (sales, marketing, ads, product, support, analytics, market-research, b2b, risk, dispute-assistant, development). Non-gated يعمل فوراً؛ 6 gated بموافقة بشرية. تنفيذ `executeLocalAdvice` (deterministic DB-backed). `createAgentTask`/`decideAgentTask`/`listMyTasks`/`getTask` مع Audit + Notifications.
- ✅ **RBAC**: `AI_USE` ممنوح لـ CUSTOMER (وللأدوار السابقة) في `shared/rbac.ts`. `AI_MANAGE`/`ADMIN_AI` للإدارة فقط. كل مسارات AI محمية.
- ✅ **AI API Routes** (`modules/ai/routes.ts`): status/activity/models/budgets/me/run/smart-search/recommendations/market-analysis/supplier-recommendations/price-intelligence/sales-intelligence/recent(staff)/analyze/product/agents/tasks (+approve/reject) + `/api/health/ai` عام. كلها auth+RBAC+validation+audit.
- ✅ **Web — API layer** (`web/src/lib/api.ts`): `aiStatus/aiModels/aiMyBudget/aiActivity/aiRun/aiAgents/aiCreateAgentTask/aiSmartFeatures/aiMarketAnalysis/aiPriceIntelligence/aiSalesIntelligence`.
- ✅ **Web — DashboardAIPage** (`web/src/pages/DashboardBusinessPages.tsx`): لوحة حقيقية مرتبطة بالـBackend — status/budget، models، agents (تشغيل tasks)، activity، تشغيل الأدوات (recommendations/smart-search/market/price/supplier/sales) — مع حالات Loading/Empty/Error/Success.
- ✅ **i18n** (`web/src/lib/i18n.ts`): مفاتيح AI كاملة في ar/en/fr/zh (مع fallback).
- ✅ **اختبارات AI Core** (`tests/ai-core.test.ts` — **13/13**): غير-مصادق 401، catalogue models، budget صفري، run+persist+audit، smart features، RBAC (CUSTOMER لا يرى `/recent`)، tenant isolation، تكلفة متعددة، agents auto-seed، non-gated success، gated approval (403→approve)، budget exhaustion 429، `/api/health/ai` public.
- ✅ **الفحص الشامل**: **69/69 Tests (8 files)**، Server Typecheck PASS، Web Typecheck PASS، Web Build PASS، E2E curl (health/status/agents/recommendations/market) 200.

## Phase 14 — Specialized AI Agents (executors متخصصة — 2026-09-14)

- ✅ **`src/modules/ai/executors.ts`** (جديد): منفّذ DB-backed خاص لكل وكيل من الـ11 — لا حاجة بعد الآن لـ `executeLocalAdvice`/`buildAdviceText` العام (حُذفا). `createAgentTask`/`decideAgentTask` يتوجهان إليهما.
- ✅ قدرة كل وكيل (استعلامات PostgreSQL حقيقية من جداول Wasit — ليست نصوصاً مختلفة فوق counts):
  - `sales-agent` (gated) → orders/items_total/commission/trust عبر periodDays؛ ينتج kpi + leadsPotential + recentOrders.
  - `marketing-agent` → published products/categories/brands (من products)؛ **marketingVideos** (عقد previewable/downloadable، mimeType video/mp4، mediaUrl nullable) + campaignSuggestion.
  - `ads-agent` (gated) → campaigns + adEvents (impressions/clicks/conversions/CTR)؛ recommendation + budgetVsSpend.
  - `product-agent` → منتج حقيقي (productId) مع variants/images/inventory؛ completeness score + issues فعلية.
  - `support-agent` → threads/messages unread؛ recommendation للرد ضمن 24h.
  - `analytics-agent` → snapshot كامل (users/products/suppliers/merchants/companies/orders/gmv/avgBasket/topProducts/dailyKpis).
  - `market-research-agent` → avg price/categories/total order value.
  - `b2b-agent` (gated) → suppliers↔merchants/companies matching مع إشارة verified + matches.
  - `risk-agent` (gated) → riskProfiles/riskEvents + riskPosture (severeEvents).
  - `dispute-assistant` (gated) → disputes open + disputeMessages + recommendation.
  - `development-agent` (gated) → snapshot نمو (users/products/orders/campaigns/dailyKpis) + nextSteps.
- ✅ **RBAC**: capabilities تُفرض في `createAgentTask` (غير المخوّل 403 "Agent capability not allowed for your role")؛ gated agents تبقى `awaiting_approval` حتى يوافق `AI_MANAGE` (ADMIN). كل executor يدفع عبر `runAIFeature` لأغراض **usage/cost/audit** (لا runtime موازٍ).
- ✅ **Web**: `api.ts` أضيفت `aiMyTasks`؛ `DashboardAIPage` ترسل inputs حقيقية لكل وكيل، تعرض structured results (parsing لـ advice JSON)، وmarketingVideos قابلة للمعاينة/التنزيل في الواجهة.
- ✅ **i18n**: مفاتيح `ai.videos.*` (title/download/generating) في ar/en/fr/zh.
- ✅ **اختبارات** (`tests/phase14-agents.test.ts` — **20/20**): الكتالوج 11، كل وكيل ينتج حقله المتخصص، marketingVideos عقد (previewable/downloadable/mimeType/mediaUrl)، product-agent بمنتج حقيقي + error لغير موجود، RBAC (CUSTOMER لا يقدر ads)، gated awaiting_approval + autorisation ADMIN (HTTP 403→approve), list/get, reject unknown, non-gated succeeded.
- ✅ **الفحص الشامل**: **89/89 Tests (9 files)**، Server Typecheck PASS، Web Typecheck PASS، **Web Build PASS**، E2E curl live: register/login→11 agents→marketing (marketingVideos ببيانات حقيقية بعد إدراج منتجات)→product (completeness)→ads 403→sales gated approve→approved.

## Phase 15 — Advertising + AI Ads (مكتملة التنفيذ — غير ملتزمة حتى MASTER CHECKPOINT 2026-09-14)

- ✅ **`runAdsRecommendations(db, userId, roles)`** — `src/lib/ai/endpoints.ts` — توصيات إعلانات محسوبة من حملات وأحداث حقيقية (campaigns + adEvents): totalSpent/totalBudget (decimal.js)، متوسط CTR، متوسط Conversion Rate، أفضل هدف (`bestObjective`)، وكلها عبر `runAIFeatureStructured` لأغراض usage/cost/audit. لا Mock.
- ✅ **`POST /api/ai/ads-recommendations`** — `src/modules/ai/routes.ts` — محمي بـ `PERMISSIONS.AI_USE`.
- ✅ **`GET /api/admin/ads/summary`** — `src/modules/admin/routes.ts` — عبر `requireRole('ADMIN','SUPER_ADMIN')` (كل `/api/admin`). يعيد campaigns/active/spent/budget/impressions/clicks/conversions/ctr/conversionRate من جداول حقيقية.
- ✅ **Web** (`packages/web/src/lib/api.ts`): `adsRecommendations()` + `adminAdsSummary()` مرتبطتا بالـ API الحقيقي.
- ✅ **Web UI** (`DashboardAdvertisementPage` قسم AI Ads Recommendations): يعرض عدد الحملات/المنصرف-الميزانية/CTR/أفضل هدف/التوصية حالات Loading/Empty/Error.
- ✅ **i18n**: مفاتيح `ads.aiRecommendations.*` في ar/en/fr (zh fallback).
- ✅ **اختبارات** (`tests/phase15-ads-ai.test.ts` — **5/5**): empty-safe، CTR/CR/bestObjective من أحداث حقيقية و spent مضمن في الإجمالي، 403 لـ CUSTOMER على `/api/admin/ads/summary`، 200 لـ ADMIN مع قيم مجمعة، 403 لـ SUPPORT. معزول عن نظافة DB (DB مشترك بين ملفات الاختبار).
- ✅ **الفحص الشامل (MASTER CHECKPOINT)**: **94/94 Tests (10 files)** — Server Typecheck 0 أخطاء — Web Typecheck 0 أخطاء — Web Build PASS (71 modules).
- ⚠️ **E2E مخصص Phase 15**: لم يُنفَّذ بعد (وضع حفظ فقط) — الوظيفة أثبتت بالـ اختبارات التكاملية + التحقق الفعلي سابقاً لمنظومة الإعلانات (Phase 12 E2E live via curl+browser).

## حالة حالية (2026-09-13)

- ✅ Auth + Session + تسجيل (CUSTOMER/SUPPLIER/MERCHANT/COMPANY) — `registerUser` يحل الدور قبل الإدراج (لا مستخدم يتيم)
- ✅ RBAC على مسارات الكيانات (403 للأدوار الخاطئة)
- ✅ Categories / Products CRUD
- ✅ Search موحّد
- ✅ Orders + Commission (4% = 2% بائع + 2% مشتري) + Transaction Ledger + Audit
- ✅ **Inventory كاملة**: `modules/inventory` + `lib/inventory-engine.ts` (reservation/release/sale/purchase/adjustment), حركات مع reason, `GET/POST/PATCH /api/inventory`, `GET /:id/movements`, RBAC `INVENTORY_*`, ملكية عبر `resolveOwnedSellerId`, UI عربي/ RTL في `DashboardInventoryPages.tsx`, migration 0001 (فهارس فريدة جزئية)
- ✅ إصلاحات Orders المكشوفة باختبارات Inventory: `ownedSellerIds()` للملكية؛ إلغاء PENDING → `releaseReservation` (لا استعادة مزدوجة)
- ✅ Admin module (`/api/admin`): stats/users/users/:id/status/orders/products/ledger/audit-logs (ADMIN/SUPER_ADMIN) — تم التحقق live بالكامل
- ✅ Web (React) Admin صفحات: KPIs/Users/Transactions/Ledger/Audit مربوطة بـ real API
- ✅ اختبارات تكامل 23/23 (12 سابقة + 11 الجديدة لـ Inventory: قائمة/بحث/pagination/adjust/set/variants/وصول/سجل حركات)
- ⚠️ Modules بهيكل فارغ تباعاً (risk, trust, disputes, ads, ai, analytics, messaging, notifications, verification, transactions, users, geo) — تحتاج services/routes فعليين.
- ⚠️ Web: صفحات أخرى غير Admin تعرض بيانات من واجهات حقيقية حيثما وُجدت; بعض reserved routes لا زالت placeholder.

## Inventory — ملاحظات بنّاء

- `ensureInventoryItem(db, productId, sellerId, variantId, threshold)` — يضمن وجود سطر مخزون (يُستدعى من `createProduct` للكمية 0)
- `applyStockMovement(db, productId, sellerId, {...})` — الحركة الوحيدة الآمنة (reservation/sale/release...)؛ **لا** تعدّل `quantity` مباشرة خارجها من services. أصبح **ذرّيًا**: guarded SQL increment + `RETURNING`، ويرمي 409 `INSUFFICIENT_STOCK` عند تجاوز سالب.
- `resolveOwnedSellerId(db, userId)` — يعيد entity المورد/التاجر/الشركة المملوكة للمستخدم (union على `suppliers/merchants/companies`)
- `resolveSellerUserId(db, sellerId)` (في `lib/seller-ownership.ts`) — العكس: من seller entity id إلى user id المالك. يُستخدم لتسليم الإشعارات.
- **Low-Stock Notifications (2026-09-19)**: `emitStockNotifications(db, itemId, previousQty, newQty, previousThreshold?)` — transition-based: إشعار فقط عند انتقال هبوطي (`IN_STOCK→LOW_STOCK` / `IN_STOCK→OUT_OF_STOCK` / `LOW_STOCK→OUT_OF_STOCK`). البقاء في نفس الحالة أو العودة إلى `IN_STOCK` صامت، والعودة تُعيد تسليح العنصر. يُستدعى من `applyStockMovement` و`commitReservationToSale` و`restoreStockForCancelledOrder` و`setMyStock`.
- `normalizePage` في inventory/service يفرض `pageSize: 50` دائماً — راجع إن أردت pageSize ديناميكياً
- الفهرسة الفريدة الجزئية (migration 0001): `inventory_product_variant_merchant_idx` (حيث المنتج+variant غير null) + فهرس مستوى المنتج — يمنع التكرار
- Movement types: `RESERVATION`, `RELEASE`, `SALE`, `PURCHASE`, `ADJUSTMENT`, `RETURN` — `quantityChange` سالب للخصم/البيع

## PHASE 9 — Verification + Trust (مكتملة)

- ✅ **Verification Engine** `modules/verification`: `GET /api/verification/me|policies|requests` + `POST /requests` (مستويات 4) + Admin `GET /api/admin/verification/requests` + `POST .../:id/review` (APPROVED/REJECTED + Audit + إشعار). الشروط تُقرأ من Policy Engine (`VERIFICATION_*` policies) — ليست Hardcoded.
- ✅ **Trust Engine** `modules/trust`: `GET /api/trust/me|me/history` + `POST /me/recompute` + Admin `/api/admin/trust`. العوامل موثقة: accountAge, email/phone, verificationLevel, transactions, disputes, complaints, profileCompleteness → score 0..100 + level + summary قابل للتفسير. منفصل عن Risk.
- ✅ **Risk Engine** `modules/risk` (Staff): `/api/admin/risk/profiles|events` + reassess — إدارة فقط في هذا الـ Phase.
- ✅ **Dispute Center** `modules/disputes`: فتح/قائمة/تفاصيل/رسائل/أدلة + Admin assign/status/decide + `disputeEvents` (أحداث) + إشعارات. قواعد من Policy (`DISPUTE_RESOLUTION`).
- ✅ Permissions جديدة: `VERIFICATION_REVIEW`, `TRUST_RECOMPUTE`, `RISK_READ/REASSESS`, `DISPUTE_OPEN/READ/MESSAGE/DECIDE/ASSIGN` (+ منح الأدوار في shared).
- ✅ Migration `0003`: `dispute_events` + `disputes.assigned_to_id/assigned_at`.
- ✅ Web: `DashboardVerificationPage`, `DashboardTrustPage`, `DashboardDisputesPage` + Admin الأربعة (`AdminEnginesPages.tsx`) + `StaffOnly` guard في admin nav.
- ✅ اختبارات: `tests/verification-trust.test.ts` (10) — المجموعة **43/43** — TSC سليم (server+web) — build ناجح — Live E2E عبر curl+متصفح.
- 🛠 حيل مهمة: `isOrderParticipant` في `lib/seller-ownership.ts` يعيد false عند `owned.length===0` (لا SQL فارغ) وله fallback `seller_id=userId`؛ `listMyDisputes` تستخدم `or()`.

## Dev/Web تشغيل

- `packages/server`: `npm run dev` على 3000
- `packages/web`: `npx vite --port 5173` (proxy /api → 3000)، ويجب أن يكون `packages/shared` مبني أو workspace-link
- واجهة Admin: `http://localhost:5173/admin` (تسجيل دخول بـ admin@wasit.tn)

## مستخدمو اختبار Dev (Demo Seed في wasit_dev — كلمة السر: Passw0rd!2026)

| الدور | البريد | ملاحظة |
| --- | --- | --- |
| CUSTOMER | `customer1@wasit.tn` | |
| SUPPLIER | `suppliera@wasit.tn` | |
| MERCHANT | `merchanta@wasit.tn` | |
| COMPANY | `companya@wasit.tn` | |
| ADMIN/SUPER_ADMIN | `admin@wasit.tn` | في dev/test فقط؛ على الـDemo العام يستخدم `DEMO_STAFF_PASSWORD` لا الكلمة المنشورة |

> ملاحظة: مستخدمو Dev/seed أُنشئوا في `wasit_dev` (ليست من الاختبار). حسابات الـstaff (`admin@`/`admin2@`) تأخذ كلمة مرورها من `DEMO_STAFF_PASSWORD`: على الـDemo العام (`NODE_ENV=staging`) تُولَّد عشوائيًا إن لم تُضبط، فلا تُفتح أبدًا بكلمة المرور المنشورة حتى بعد إعادة بناء قاعدة الـDemo (انظر `lib/demo-account.ts: resolveStaffPassword`).

## قاعدة الاختبار

`wasit_test` يُعاد إنشاؤه في `tests/setup.ts` (drop/create + migrate + seed) عند كل `vitest run`.
الاختبارات تستدعي `app.fetch` مباشرة (بدون منفذ HTTP).

### تشغيل قاعدة البيانات (بيئة Dev)

- PostgreSQL في حاوية التطوير **لا يعمل تلقائياً**؛ العارض `ECONNREFUSED 127.0.0.1:5432` = DB متوقفة لا خطأ في الكود.
- التشغيل: `sudo pg_ctlcluster 17 main start` (الأوامر الكاملة في `docs/DEPLOYMENT.md`).
- المستخدم `wasit` يحتاج `CREATEDB` وإلا يفشل globalSetup بـ `42501`.
- عند إعادة إنشاء القاعدة من صفر: `npm run db:migrate` ← `npx tsx src/scripts/seed.ts` ← `seed-demo.ts` (اختياري).
- **حساب اختبار Demo الرسمي** `rhimiimed18@gmail.com`: يُنشَأ من `seed-demo.ts` (CUSTOMER عادي، verified في Demo). كلمة مروره من `DEMO_TEST_ACCOUNT_PASSWORD` في `.env.demo` (git-ignored)، لا plaintext في الكود. عند rebuild لقاعدة الـDemo يعود تلقائيًا بعد الـbootstrap.
- **مركز تدقيق المالك** `/demo/owner` (`DemoOwnerAuditPage` + `lib/demo-owner-catalog.ts`): يفتح جلسات Demo حقيقية لكل دور عبر `POST /api/auth/demo-audit-session` بمعرّف دور فقط (`{persona}`) ضد قائمة مُصرَّحة في `lib/demo-account.ts`. الخادم يتحقق أن الحساب يحمل الدور المُعلن (وإلا 409)، والجلسة تحمل صلاحيات الحساب المخزَّنة فقط — لا توسيع من الواجهة. اختباره `e2e/demo-owner.spec.ts`.
- **فخ تشغيل الـDemo** (مُعالَج في الكود): `.env.demo` يضبط `API_URL` على الرابط العام للـAPI، فإذا خُدِمت الواجهة على نفس الأصل صار proxy الويب يشير إلى نفسه ⇒ حلقة proxy و`431 Request Header Fields Too Large` على كل `/api/*` بينما تظهر الواجهة سليمة. `packages/web/vite.config.ts` يكتشف الآن الأصل الذاتي (`API_URL` == `APP_URL`، أو منفذ `WEB_PORT` نفسه) ويسقط إلى `http://localhost:3000`؛ وللتجاوز الصريح استخدم `WEB_PROXY_TARGET`. لا حاجة بعد الآن لتصدير `API_URL=http://localhost:3000` يدويًا. ولبناء الـDemo استخدم `VITE_DEMO_MODE=true npm run build -w @wasit/web` كي يظهر البانر.
- **فخ اختبارات الخادم** (مُعالَج في الكود): `packages/server/.env` غير المتعقّب (يُستخدم لتشغيل الـDemo محليًا) كان يتسرّب إلى `vitest` عبر `dotenv`، فتُفشل مواصفات تؤكد أن `DEMO_SKIP_EMAIL_VERIFICATION`/`DEMO_AUTO_LOGIN` **مطفأتان** افتراضيًا. `vitest.config.ts` يضبط الآن `DOTENV_CONFIG_PATH` على مسار غير موجود، فبيئة الاختبار معزولة عن `.env` المحلي.
- **فخ تشغيل E2E على الرابط العام**: `globalSetup` يسجّل الدخول عبر `E2E_API_URL` (localhost) ويخزّن الكوكي لـ`localhost`، ثم المتصفح يتنقّل إلى `E2E_WEB_URL` العام ⇒ الكوكي لا يُرسل فتظهر بعض الاختبارات كأنها فاشلة. شغّل E2E على `E2E_WEB_URL=http://localhost:12000` لتطابق الأصل. و`DEMO_AUTO_LOGIN`/`DEMO_SKIP_EMAIL_VERIFICATION` يجب أن تطابق إعداد الخادم، وإلا تُخطّى/تفشل مواصفات الـDemo.
- **14 فشل E2E متوقّع في وضع Demo**: مواصفات تعتمد `dev/verification-link` (404 في staging) أو locators `getByRole('status')` التي يزاحمها بانر DEMO. تُمرَّر في إعداد dev الأصلي (منافذ معزولة، بلا بانر) — ليست regressions.
- **فخ خادم يدوي على `:3000` أثناء E2E**: `playwright.config.ts` يضبط `reuseExistingServer: !CI`، فإن كان خادم `npm run dev -w @wasit/server` يعمل فسيُعاد استخدامه **بلا** تجاوزات الـrate-limit الخاصة بالـE2E (`RATE_LIMIT_LOGIN_MAX=500` ...). النتيجة 13 إخفاقة كاذبة سريعة في مكاتب admin (`admin-user-status`/`admin-privacy`/`admin-subscriptions`: `Cannot read properties of undefined (reading 'userId')` من تسجيل 429). أوقف الخادم اليدوي قبل تشغيل `npm run test:e2e` (المنفذ يجب أن يكون حرًّا).
- **منطق كشف التهريب مشترك**: أي مسار يكتب رسالة (لا الردود فقط) يجب أن يستدعي `scanMessageForFeeEvasion` في `modules/messaging/service.ts`. `openDirectThread` كان يتجاوز الكشف على الرسالة الأولى في الخيط الجديد (ثغرة C5 حقيقية أُصلحت 2026-09-24)؛ اختبار الانحدار في `tests/fee-evasion.test.ts`.

## PHASE 17 — Security + Privacy + Audit (مكتملة — 123/123)

- ✅ **MFA (TOTP RFC 6238)** `modules/auth` + `lib/mfa.ts`: enroll/confirm/disable/status/verify/recovery-codes/dev-totp. كل endpoint: `requireAuth` + `rateLimit` + Audit (`AUTH.MFA_*`). `dev-totp` محجوب في `NODE_ENV=production` (403).
- ✅ **تحدي MFA عند الدخول (C4)**: `loginUser` يعيد `mfa_required` + `challengeToken` بلا جلسة عند `mfaEnabled`؛ جدول `mfa_challenges` (migration `0019`، `tokenHash` فقط، أحادي الاستخدام، TTL/عدّاد محاولات) و`completeMfaLogin` يصدر الجلسة عبر `issueSession` بعد TOTP أو رمز استرداد. الواجهة: خطوة ثانية في `LoginPage` + بطاقة MFA في `DashboardSecurityPage`. اختبارات: `tests/mfa-login-challenge.test.ts` (10) + `e2e/mfa.spec.ts` (2) — لا mocks.
- ✅ **Recovery codes مخزّنة salted** بصيغة `salt:hash` — `hashRecoveryCode()` يولد salt عشوائي 16 بايت لكل وسم، SHA-256 لـ `salt+code`. التحقق عبر `verifyRecoveryCode()` يعيد `{valid, legacy}` ويستخدم `timingSafeEqual` (constant-time). **Single-use**: الكود المحظوظ يُحذف من `recoveryCodesHash`، إعادة الاستخدام تفشل.
- ✅ **Backward compat**: الهاش القديم غير المملّح (64-hex بلا `:`) يتحقق ويعيد `legacy:true`، ويُرقّى تلقائياً عند أول استخدام ناجح. لا حاجة إلى migration جديدة.
- ✅ **Privacy Engine** `modules/privacy`: `/api/privacy/me|consents|export|deletion` (auth صريح لكل route، rate limit قبل auth على الحساسة) + `/api/admin/privacy/deletions` (ADMIN/SUPER_ADMIN).
- ✅ **لا تسريب**: لا يعيد أي endpoint `recoveryCodesHashed`/hash/secret (سوى `secretBase32`+`recoveryCodes` مرة واحدة في enroll للعرض). مُثبت في `tests/security-privacy.test.ts`.
- ✅ **Rate-limit store معزول للاختبار فقط**: `resetRateLimitStore()` من `middleware/rate-limit.ts` (إنتاجية unchanged). لا تغيير في deletion logic أو isActive.
- 🛠 **إشارة**: أي اختبار جديد يلمس `rate-limit` في privacy يجب أن يستدعي `resetRateLimitStore()` في `beforeEach` ويستخدم IPs فريدة عبر `makeClient(ip)`.

## C3 — Privacy/Consent موسّع + سياسات البلد (مكتملة ومتحققة — لم تُعمَّد بعد)

- ✅ **قواعد الاحتفاظ من Policy Engine لا من الكود**: `modules/privacy/service.ts` تحلّ `PRIVACY/DATA_RETENTION` عبر `resolveMergedPolicy` (دولة المستخدم من `profiles.countryId` → العالمي). لا `90` ولا `preserves` ثابتة في منطق الحذف. `defaultRetentionDays: 90` قيمة seed فقط (`scripts/seed.ts`).
- ✅ **`DECISION_REQUIRED` لا اختراع قانون**: غياب صف الدولة يُسجَّل في `country_policy_gaps` (scope `PRIVACY`, code `DATA_RETENTION`) ويُغلق تلقائيًا عند إضافة تجاوز الدولة (القاعدة #29).
- ✅ **تخزين الحلّ وقت الطلب**: `data_deletion_requests.retention_policy` يحمل `defaultRetentionDays`, `legalHoldFinanciallyRequired`, `preserves`, `policySource`, `policyId`, `policyVersion`, `countryCode` + `retentionUntil` — قابل للتدقيق لاحقًا رغم تغيّر السياسة.
- ✅ **ثوابت مقصودة**: السجلات المالية/التدقيقية (`transaction_ledger`, `audit_logs`, `disputes`, `orders`, `invoices`) محفوظة إلزاميًا — التزام بنيوي؛ الدولة تضيف عبر `preserves`.
- ✅ **مسارات Admin** (`admin:policies` + Audit who/what/old/new/when/reason + bump `version`): `GET/PUT /api/admin/policies/retention`، `GET .../retention/resolved`. الواجهة: بطاقة الاحتفاظ في `pages/AdminPolicyPages.tsx` + i18n (ar/en/fr).
- ✅ **Migration**: `0018_wise_typhoid_mary.sql` (`ALTER TYPE policy_scope ADD VALUE 'PRIVACY'`).
- ✅ **إثبات**: tsc=0 (server+web)، `privacy-retention-policy.test.ts` 9 حالات، **408/408** (40 ملف).

## C2 — Observability / Tracing (مكتملة ومتحققة — لم تُعمَّد بعد)

- ✅ **Trace موزّع** `src/lib/observability/trace.ts`: تحليل/تبنّي `traceparent` (W3C) + رفض الإصدار `ff`/المعرّفات الصفرية/الشكل الخاطئ، ودعم `x-trace-id` المجرّد (32 hex)، وإلا توليد `randomUUID` بلا شرطات؛ `spanId` جديد لكل قفزة. `middleware/core.ts` يحمل `TraceInfo` ويعيد `X-Trace-Id`؛ `errors.ts` يضع `traceId` ويُلجّم الخطأ غير المعالج عبر الـlogger.
- ✅ **Metrics** `src/lib/observability/metrics.ts` + `GET /metrics` (جذر، Prometheus؛ `METRICS_ENABLED`، توكن Bearer اختياري): `wasit_http_requests_total`/`_duration_seconds`/`_errors_total` (وسم route **مطبَّع** لتجنّب كاردينالية عالية)، `wasit_rate_limit_rejections_total`، `wasit_audit_writes_total`، `wasit_alerts_fired_total`، `wasit_alert_notifications_total`، `wasit_db_up`، `wasit_uptime_seconds`، `wasit_build_info`.
- ✅ **Logging مركزي** `src/lib/observability/logger.ts`: سطر JSON لكل سجل على stdout + تنقيح مفاتيح الأسرار + حلقة 200 + فلترة بالمستوى. `middleware/observability.ts` بديل `hono/logger` (سطر واحد/طلب). مسار admin `GET /api/admin/observability/logs`.
- ✅ **Alerting** `src/lib/observability/alerts.ts`: محرك قواعد بانتقالات FIRING/RESOLVED فقط، تُحفظ في `alert_events` (`schema/observability.ts`, migration `0017_unusual_mephistopheles.sql` إضافية)، تُدقَّق (`OBSERVABILITY.ALERT_FIRED/RESOLVED`) وتُرسل عبر `AlertNotifier` (`OBS_ALERT_NOTIFY=log|webhook`). تقييم دوري من الـscheduler (`OBS_ALERTS_ENABLED`) أو `POST /api/admin/observability/alerts/evaluate`.
- ✅ **RBAC/Audit**: كل مسارات `admin/observability/*` بـ`admin:system` + Audit. `/api/health/channels` يعرض `observability.alerts.notifier`.
- ✅ **إثبات**: tsc=0، **399/399** (39 ملف، `observability.test.ts` 23 حالة)، `build:prod` نظيف، وE2E bundle حقيقي على Postgres (trace propagation ⇒ نفس `X-Trace-Id`، `/metrics` 200، `db_up=1`، admin 401/200 + Audit). القرار في AD-039.
- 🛠 **إشارة للاختبارات**: `vitest.config.ts` يضبط `OBS_LOG_LEVEL=error` كي لا تُغرق سجلات كل طلب output الاختبارات؛ اختبارات الـlogger تعتمد على ذلك.

## C1 — Distributed Rate-Limit Store (مكتملة ومتحققة — committed `18f3a38`)

- ✅ **طبقة مخزن** `src/lib/rate-limit/{port,memory,postgres,resolve}.ts`: العقد `RateLimitStore` (`increment`/`reset`/`purgeExpired`)، يُختار بـ`RATE_LIMIT_STORE=memory|postgres` (افتراضي `memory`).
- ✅ **جدول `rate_limit_counters`** (`schema/rate_limit.ts`, migration `0016_breezy_lester.sql` **إضافية**: create table + فهرس). `increment` عبارة upsert **واحدة** (`ON CONFLICT DO UPDATE` مع CASE على `expires_at_ms`) → ذرّية، لا lost updates تحت 50 طلبًا متزامنًا.
- ✅ **الموضوع per-user**: `user:<id>` للمصادَق و`ip:<ip>` للمجهول في `middleware/rate-limit.ts`. `resetRateLimitStore()` صار **async** (seam اختبار فقط) ويستعمل `peekRateLimitStore()` بدل إنشاء مخزن.
- ✅ **purge**: `lib/scheduler.ts` كل `RATE_LIMIT_PURGE_INTERVAL_MINUTES` (15) + `POST /api/admin/rate-limits/purge` (`admin:system`، Audit `RATE_LIMIT.PURGE_RUN`).
- ✅ **health**: `GET /api/health/channels` يعرض `rateLimit.{store,durable}`.
- ✅ **إثبات**: tsc=0، **376/376** (38 ملف)، `build:prod` نظيف، وE2E bundle حقيقي: `200×5 ثم 429×2` + `durable:true` + العدّاد يثبت عبر إعادة تشغيل العملية. القرار (لا Redis) في AD-038.
- 🛠 **إشارة مهمة للاختبارات**: `setRateLimitStore(store)` يثبّت المخزن عبر استدعاءات متعددة غير متسلسلة (forced flag)؛ بدونها كان `resolveRateLimitStore(db)` يعيد بناء المخزن كل طلب فيُفقد العدّ (كشفه اختبار privacy deletion burst).

## PHASE 14 — Subscriptions Module (مكتملة ومتحققة — 10/10 + committed)

- ✅ **Subscription Module** `modules/subscriptions/{types,service,routes}.ts`: خطط (`CUSTOMER_FREE`/`SMALL_MERCHANT`/`COMPANY`/`GLOBAL` من seed — أسعار من DB لا Hardcode)، subscribe (idempotent)، `/me`، change plan (delta invoice عند الترقية)، cancel، invoices، rollover (auto-renew)، admin (plan active + lists).
- ✅ **RBAC**: `SUBSCRIPTION_READ_OWN/CREATE/UPDATE/CANCEL` للأدوار التجارية الأربعة (CUSTOMER/MERCHANT/SUPPLIER/COMPANY) في `shared/rbac.ts` — `SUBSCRIPTION_MANAGE` للإدارة فقط. الـ routes تستخدم `requirePermission(PERMISSIONS.SUBSCRIPTION_*)` بدقة. **SUPPORT لا يملك SUBSCRIPTION_CREATE — الرفض 403 مؤكد بالاختبار.**
- ✅ **Audit**: `SUBSCRIPTION.SUBSCRIBED` / `SUBSCRIPTION.PLAN_CHANGED` / `SUBSCRIPTION.CANCELLED` / `SUBSCRIPTION.PLAN_ACTIVE_TOGGLED`. يتم تمرير `AuditContext` صحيح `{ actorId, ipAddress, userAgent }` (وليس `AppContext`) — `audit_logs.actor_id` لا يبقى NULL.
- ✅ **Tests مشغّلة وناجحة**: `tests/subscriptions.test.ts` — **10/10** مقابل PostgreSQL 17 (plans/lifecycle/RBAC/admin/rollover). Commit `cb4c963`.
- ✅ **`app.ts`**: يسجّل `geoRoutes` (`/api/geo`) و`subscriptionRoutes` (`/api/subscriptions`) — Geo في commit `c446741`، Subscription في commit `cb4c963` (بلا تكرار).

## Geo Module (مكتملة ومتحققة — committed `c446741`)

- ✅ **Geo API** `modules/geo/routes.ts` مبني على `geo/service.ts`: countries / regions / cities / currencies / languages / exchange-rates — كلها GET عامة (بيانات مرجعية) مع zod query validation وpagination.
- ✅ **`geo/service.ts`** (304 سطرًا) في commit `01b1959`؛ 16 استيرادًا في الـ routes كلها مصدَّرة — تطابق 1:1، tsc=0.

## الحالة الحالية للاختبارات

- **TypeScript (Server)**: `npx tsc --noEmit` = **exit 0 — صفر أخطاء** (بعد إصلاحات Geo/Revenue/Subscriptions — انظر قسم TypeScript Clean أعلاه).
- آخر تشغيل كامل (2026-09-20): **408/408 ناجحة — 40 ملف** (C3 Privacy retention 9 حالات، C2 Observability 23، Rate-Limit 12، Inventory 17، Subscription 10، Revenue 19، Unit-Economics 10، Security/privacy 19، vertical-slice 10...). تاريخياً: 399/399 (C2)، 376/376 (C1)، 364/364 (SMS)، 347/347 (Unit Economics)، ثم 155/155، 149/149، 123/123، 106/106 بعد PostgreSQL 17، و94/94 عند MASTER CHECKPOINT 2026-09-14.
- **بيئة PostgreSQL**: الحِزم تُفقد عند إعادة إنشاء الحاوية؛ تُعاد التهيئة بـ `sudo apt-get install -y postgresql-17 postgresql-client-17` + `data_directory='/workspace/pgdata'` في `/etc/postgresql/17/main/postgresql.conf` + `sudo pg_ctlcluster 17 main start`. قواعد `wasit_dev`/`wasit_test` موجودة.
- تشغيل سريع: `cd packages/server && npx vitest run` (يُعيد بناء wasit_test تلقائياً).

## رسوم مالية (2026-09-13)

- **لا نسب مالية Hardcoded في الكود إطلاقاً** (تم إزالة `0.02` و`0.03` الاحتياطية من `orders/service.ts`).
- العمولة (4% قاعدة، 2% بائع + 2% مشتري) تأتي من `commission_policies` (سياسة BASE من seed).
- رسوم الدفع تأتي من `payment_fee_policies` — سياسة افتراضية `WASIT Default Processing Fee` (2%) تُدار من DB/Admin لاحقاً.
- استجابة `createOrder` والـ Audit يعرضان `paymentFeePolicyId`/`feePolicyId`.
- الاختبارات: `tests/payment-fee-policy.test.ts` يثبت أن تغيير السياسة يغيّر الرسوم (مضاد Hardcoding).

## Money Path Invariants (2026-09-24)

- **`Payment ≠ Settlement`** (عقد مُنفَّذ في الكود): تأكيد الدفع (`applyPaymentSucceeded`) **لا يكتب** `transaction_ledger.status='SETTLED'` أبداً — القيود تبقى `PENDING`. الكاتب **الوحيد** لـ`SETTLED` هو `applySettlementConfirmed` في `modules/payments/service.ts`، ولا يُستدعى إلا من حدث webhook نوعه `settlement.confirmed` من مزوّد يعلن `capabilities.settlementEvidence`.
- **حدود القدرات**: كل مزوّد يعرّف `capabilities = { settlementEvidence, payout, demo }` في `lib/payments/providers.ts`. `manual` هو `{ demo: true, settlementEvidence: false }` — هيكل عرض/اختبار، ليس قناة أموال. `resolvePaymentProvider()` يرفض أي مزوّد `demo` إلا عند `DEMO_PAYMENT_MODE=true` (والـproduction يرفض الإقلاع به).
- **تشغيل الاختبارات/E2E**: `DEMO_PAYMENT_MODE=true` مُضاف إلى `vitest.config.ts` و`playwright.config.ts` و`.env.demo` — لأن مزوّد `manual` محجوب افتراضياً. أي suite جديدة تستخدم المزوّد اليدوي يجب أن تُشغَّل مع هذه الراية.
- **Revert/إصلاح**: لا تُعِد كتابة `SETTLED` داخل مسار تأكيد الدفع، ولا تسمح بحدث `settlement.confirmed` من مزوّد ديمو — حرسان مُثبتان في `tests/money-path-invariants.test.ts`.
- **تدقيق قراءة فقط**: `npx tsx src/scripts/verify-money-path.ts` يكشف صفوف `SETTLED` بلا دليل تسوية (`SETTLEMENT.CONFIRMED` في `audit_logs`) ويُخرج exit code غير صفري عند وجود مخالفة. لا يكتب شيئاً.
- **E2E محلي**: Playwright يحتاج `wasit_dev`؛ إن لم توجد فأنشئها فقط (`CREATE DATABASE wasit_dev`) ثم `npx drizzle-kit migrate` + `npx tsx src/scripts/seed.ts`. **ممنوع** `db reset/drop/push`.
## Functional UI audit — running the suites correctly (2026-09-28)

- **Always run UI suites against the public HTTPS link**, not `http://127.0.0.1:12000`. The session cookie `wasit_session` is issued with `Secure`, so Playwright's `page.request.*` silently drops it on plain HTTP and returns spurious `401`s. The app itself is fine in that case — an in-page `fetch('/api/...', { credentials: 'include' })` still returns `200`. Suites affected if run over HTTP: `ui-messages-check`, `ui-subscription-check`, `ui-inventory-search-check`.
- Run: `node scripts/ui-redesign-check.mjs https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev`.
- Preview servers: `vite preview` on port 12000 proxies `/api`, `/sitemap.xml`, `/robots.txt` to the backend (same-origin session semantics as production nginx). Build first with `VITE_DEMO_MODE=true npm run build -w @wasit/web` (the flag turns on the demo banner), then `cd packages/web && npx vite preview --port 12000 --host 0.0.0.0`.
- **Server integration tests need a disposable DB**: `TEST_DATABASE_URL` must name a database ending in `_test` (hard guard in `packages/server/tests/setup.ts`). `npm test` alone fails with `password authentication failed for user "wasit"`. Use: `PW=$(grep '^DATABASE_URL' .env.demo | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/'); TEST_DATABASE_URL="postgresql://wasit_demo:${PW}@localhost:5432/wasit_test" npm test`.

## Landing page (public marketing surface)

- The homepage is the **dark navy premium** theme (`bg-ink-950`, i.e. `#050c24`). All other public routes keep the light/white header.
- Hero artwork is pure SVG in `components/brand/CorporateHero.tsx`, split by `part="map"` (dotted world map + trade network) and `part="skyline"` (illuminated city + water reflection). No external images, no network requests.
- `PublicHeader`/`PublicLayout` take a `dark`/`darkHeader` prop. The header is `sticky top-[var(--demo-banner-h,0px)]`, and `DemoBanner` publishes its measured height as `--demo-banner-h` so the two sticky bars never overlap.
- Design tokens live in `tailwind.config.js` (`ink-950`, `brand-*`) and `index.css` (`.lp-dark-section`, `.lp-dark-card`, `.lp-btn-ghost-dark`). Hero copy keys are `lp.hero.headline/subtitle/ctaPrimary/ctaSecondary` in all four locales.
