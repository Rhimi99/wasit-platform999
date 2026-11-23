# AGENTS.md — WASIT BUSINESS GLOBAL

ذاكرة الوكيل لحالة المشروع وإرشادات البناء.

## ⛔ إلزامي قبل أي عمل — سياسة حفظ العمل (2026-11-20)

**GitHub هو النسخة الدائمة. الحاوية والمساحة المحلية مؤقتتان. أي عمل ليس في
commit مدفوع على `origin` معرّض للضياع.**

```bash
./scripts/session/session start                       # قبل أي تعديل — يجب أن يكون SAFE
./scripts/session/session checkpoint -m "…"           # بعد كل جزء مكتمل ومُختبَر
./scripts/session/session close                       # قبل إنهاء الجلسة — يجب أن ينجح
./scripts/session/session backup                      # bundle مستقل + SHA-256
./scripts/session/session recovery --target <جديد>    # بعد فقدان الحاوية
```

1. افحص حالة الحفظ قبل العمل (`session start`).
2. لا تبدأ مهمة فوق أعمال غير محفوظة.
3. احفظ التقدم المرحلي في Git (`session checkpoint`).
4. ادفع نقاط الحفظ إلى GitHub عند سلامة الحالة.
5. لا تعتبر commit محليًا نسخة احتياطية دائمة.
6. لا تُنهِ مهمة مكتملة قبل التحقق من الدفع (`origin/<branch> == HEAD`).
7. لا تُنهِ جلسة قبل فحص الملفات والـcommits غير المدفوعة (`session close`).
8. لا تستخدم أوامر Git التدميرية: لا `push --force`، لا `reset --hard`، لا `clean`، لا حذف فروع/نسخ.
9. لا تتجاوز قيود الموافقات، ولا ترفع أسرارًا أو bundles إلى المستودع العام.
10. عند أي تعارض أو غموض: احمِ العمل (bundle + checkpoint) وتوقّف — لا تستبدل.

الأدلة الكاملة: [`docs/session/`](docs/session/README.md) — ابدأ منها لا من ذاكرة المحادثة.

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

## CI (GitHub Actions) — عقد يجب احترامه (CI-01، 2026-11-23)

- **`tests/test-db-guard.ts` هو المرجع، لا ملف الـCI.** الحارس يرفض أي هدف غير `127.0.0.1:5434/wasit_test` (ولا fallback إلى `DATABASE_URL`/`localhost`/`5432`) لأن `tests/setup.ts` ينفّذ `DROP/CREATE DATABASE`. لذلك CI ينشر خدمة Postgres على **`127.0.0.1:5434:5432`** ويكتب `postgresql://wasit@127.0.0.1:5434/...`.
- **لا كلمة مرور في الـworkflow**: الحاوية عابرة لكل وظيفة، مربوطة بـloopback، وتعمل بـ`POSTGRES_HOST_AUTH_METHOD: trust`. إن أُضيفت قاعدة مُدارة لاحقاً فالقيمة من `secrets` مع بقاء المضيف/المنفذ مطابقين للحارس.
- **`ffprobe` ليس من `ffmpeg-static`**: الرسم يستخدم `ffmpeg` (نظام أو `ffmpeg-static`)، لكن التحقّق (`verify.ts`/`video-quality.ts`/`tts.ts`) يستدعي **`ffprobe` من PATH**. وظيفتا `test` و`e2e` تثبّتان `ffmpeg` + `fonts-dejavu-core` وتتحقّقان من `libass` قبل التشغيل.
- **لا `skipIf` لأدوات مفقودة**: الاختبارات تُفشل عند غياب الأداة (كما في `marketing-video.test.ts` قبلAll). الإصلاح يكون بتثبيت الأداة في البيئة.
- **مهل الفيديو صريحة**: ملفات الفيديو تُرسم فعلياً وتتنافس على CPU ⇒ مهلة على مستوى الحزمة 180s (و240s لاختبار 35s+120s). لا تعتمد على المهلة العامة 30s.
- **عدّ الصفوف يجب أن يُقيَّد بالكيان الذي أنشأه الاختبار** (مثل `media_assets WHERE product_id = ...`) لا بـ`count(*)` عالمي — الملفات تعمل متوازية على نفس القاعدة.
- **`age` في وظيفة النسخ الاحتياطي بلا إصدار دقيق**: أرشيف Ubuntu يبدّل إصدارات patch، وتثبيت `age=1.1.1-1ubuntu0.24.04.3` أوقف الوظيفة سابقاً (exit 100).
- **عميل `pg_dump` يأتي من الـrunner، لا من apt**: `ubuntu-latest` صار Ubuntu 26.04 بعميل PostgreSQL **18**، و`pg_dump` 18 يكتب دائماً `SET transaction_timeout = 0;` — يرفضه أي خادم 16. لذلك خدمة وظيفة النسخ الاحتياطي على `postgres:17` (أول إصدار يعرف الإعداد). لا تُثبّت `postgresql-client-16` (غير موجود في أرشيف 26.04) ولا تُخفّض الخادم إلى 16.
- **piper يُثبَّت بـ`scripts/install-tts.sh`**: يستخدم `tar --strip-components=1` لينتج `packages/server/vendor/piper/piper` (ملف). لا تُعِد `cp -a piper/. .` — مدخل `piper` في الأرشيف ملف بنفس اسم مجلده فيفشل. `vendor/piper` مستبعد من git، وبدونه `voice-pack.test.ts` يفشل و26 اختباراً صوتياً تُتخطّى.
- **`npm ci --ignore-scripts` يعني باينري `ffmpeg-static` غائب**: أضف `npm rebuild argon2 ffmpeg-static`، وإلا فشلت `marketing-video.test.ts` عند `beforeAll` رغم وجود ffmpeg النظامي.
- **تشغيل البوابة على فرع عمل**: `workflow_dispatch` مفعّل؛ استخدم `gh workflow run ci.yml --ref <branch>`. لا تضف الفرع إلى فلتر `push` (الفلتر للفروع التكاملية فقط).
- **مواصفات E2E قد تتخلّف عن الواجهة**: تفعيل MFA يتطلّب إعادة إدخال كلمة المرور (`mfa-enroll-password`) قبل `mfa-enable`، وإلا فالزر `disabled` وينتهي الاختبار بمهلة. راجع الواجهة قبل تعديل المواصفة.

## E2E Testing (Playwright — 2026-09-19، Phase 18)

```bash
npm run test:e2e     # من الجذر — يشغّل server + web تلقائياً ضد wasit_dev
```

**نتيجة التشغيل الفعلي (2026-11-20): 243 ناجح، 8 متخطى، 0 فشل (8.1 دقيقة).** التخطيات الثمانية كلها في `demo-auto-login.spec.ts` و`demo-owner.spec.ts` وهي مشروعة: `DEMO_AUTO_LOGIN=false` هو الافتراضي الآمن، فتتخطى نفسها عبر `test.skip(!autoLoginEnabled(...))`.

**تفصيل تجهيز البيئة من الصفر** (لا يوجد اختصار — كل خطوة لازمة):
```bash
sudo apt-get install -y postgresql postgresql-contrib age
sudo -u postgres initdb -D /var/lib/postgresql/e2edata -A scram-sha-256
sudo -u postgres pg_ctl -D /var/lib/postgresql/e2edata -o "-p 5432" -l /tmp/pg.log start
# ثم: أنشئ دور wasit + قاعدة wasit_dev، ثم
cd packages/server && DATABASE_URL=...wasit_dev npx drizzle-kit migrate   # 41 ترحيلاً → 104 جدولاً
DATABASE_URL=...wasit_dev npx tsx src/scripts/seed.ts
npx playwright install --with-deps chromium
```

**فخّان بيئيان كلّفا وقتاً، وليسا عيباً في الكود** — افحصهما أولاً عند أي فشل غريب:
1. **`initdb -A trust` يجعل كل الاختبارات التي تعتمد على رفض كلمة مرور خاطئة تنجح كذباً.** استخدم `scram-sha-256`؛ وإلا فشل `backup-restore.test.sh` في «failed backup left no folder» لأن النسخة «الفاشلة» تنجح فعلياً.
2. **لا تصدّر `PG_BIN` عند تشغيل `backup-restore.test.sh`.** السكربت يحقنه في مقدمة `PATH` (`restore-db.sh:46`) فيتجاوز الـstubs الخاصة بالاختبار ويصل لخادم حقيقي — تسقط اختبارات G8 وحدها. صدّر `PATH` بدلاً منه.

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
- ✅ **اختبارات** (`tests/phase14-agents.test.ts` — **20/20**): الكتالوج 11، كل وكيل ينتج حقله المتخصص، marketingVideos عقد (previewable/downloadable/mimeType/mediaUrl)، product-agent بمنتج حقيقي + error لغير موجود، RBAC (CUSTOMER لا يقدر ads)، gated awaiting_approval + autorisation ADMIN (HTTP 403→approve), list/get, reject unknown, non-gated succeeded. (المساعد `runAndComplete` يعتمد عبر `SUPER_ADMIN` **مختلف** عن الطالب التزامًا بفصل المهام — AI-02.P0.)
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
- **حساب اختبار Demo الرسمي** `demo@wasit.tn`: عنوان محايد (لا بريد شخصي)، يُنشَأ من `seed-demo.ts` (CUSTOMER عادي، verified في Demo). كلمة مروره من `DEMO_ACCOUNT_PASSWORD` في `.env.demo` (git-ignored) — نفس بيانات اعتماد حسابات العرض الأربعة، لا plaintext في الكود. عند rebuild لقاعدة الـDemo يعود تلقائيًا بعد الـbootstrap.
- **مركز تدقيق المالك** `/demo/owner` (`DemoOwnerAuditPage` + `lib/demo-owner-catalog.ts`): يفتح جلسات Demo حقيقية لكل دور عبر `POST /api/auth/demo-audit-session` بمعرّف دور فقط (`{persona}`) ضد قائمة مُصرَّحة في `lib/demo-account.ts`. الخادم يتحقق أن الحساب يحمل الدور المُعلن (وإلا 409)، والجلسة تحمل صلاحيات الحساب المخزَّنة فقط — لا توسيع من الواجهة. اختباره `e2e/demo-owner.spec.ts`.
- **فخ تشغيل الـDemo** (مُعالَج في الكود): `.env.demo` يضبط `API_URL` على الرابط العام للـAPI، فإذا خُدِمت الواجهة على نفس الأصل صار proxy الويب يشير إلى نفسه ⇒ حلقة proxy و`431 Request Header Fields Too Large` على كل `/api/*` بينما تظهر الواجهة سليمة. `packages/web/vite.config.ts` يكتشف الآن الأصل الذاتي (`API_URL` == `APP_URL`، أو منفذ `WEB_PORT` نفسه) ويسقط إلى `http://localhost:3000`؛ وللتجاوز الصريح استخدم `WEB_PROXY_TARGET`. لا حاجة بعد الآن لتصدير `API_URL=http://localhost:3000` يدويًا. ولبناء الـDemo استخدم `VITE_DEMO_MODE=true npm run build -w @wasit/web` كي يظهر البانر.
- **فخ اختبارات الخادم** (مُعالَج في الكود): `packages/server/.env` غير المتعقّب (يُستخدم لتشغيل الـDemo محليًا) كان يتسرّب إلى `vitest` عبر `dotenv`، فتُفشل مواصفات تؤكد أن `DEMO_SKIP_EMAIL_VERIFICATION`/`DEMO_AUTO_LOGIN` **مطفأتان** افتراضيًا. `vitest.config.ts` يضبط الآن `DOTENV_CONFIG_PATH` على مسار غير موجود، فبيئة الاختبار معزولة عن `.env` المحلي.
- **فخ تشغيل E2E على الرابط العام**: `globalSetup` يسجّل الدخول عبر `E2E_API_URL` (localhost) ويخزّن الكوكي لـ`localhost`، ثم المتصفح يتنقّل إلى `E2E_WEB_URL` العام ⇒ الكوكي لا يُرسل فتظهر بعض الاختبارات كأنها فاشلة. شغّل E2E على `E2E_WEB_URL=http://localhost:12000` لتطابق الأصل. و`DEMO_AUTO_LOGIN`/`DEMO_SKIP_EMAIL_VERIFICATION` يجب أن تطابق إعداد الخادم، وإلا تُخطّى/تفشل مواصفات الـDemo.
- **فخ تهريب `.env.demo` إلى E2E (خطير — يُلوّث قاعدة الـDemo)**: بيئة التشغيل تصدّر متغيّرات `.env.demo` (ومنها `DATABASE_URL=.../wasit_demo` و`NODE_ENV=staging`) في كل shell، فيرثها `npx playwright test` ويهاجم قاعدة الـDemo بدل `wasit_dev`. الأثر المزدوج: (1) `globalSetup` يزرع بيانات اختبار في `wasit_demo`، و(2) أخطر — مسار «إصلاح كلمة المرور» في `globalSetup` (عند 401) يعيد تعيين كلمة مرور حسابات الـstaff إلى **كلمة مرور الـDemo المنشورة** `Passw0rd!2026`، فيصبح `admin@wasit.tn` قابلًا للدخول بكلمة منشورة على منصة staging عامة (خطر أمني حقيقي)، ويفشل تدقيق admin في `ui-functional-audit` (26/45). الوقاية: شغّل E2E بـ`DATABASE_URL` صريح لـ`wasit_dev` مع منافذ معزولة:
  `DATABASE_URL='postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev' E2E_API_URL=http://localhost:3100 E2E_WEB_URL=http://localhost:5199 npx playwright test`
  و`playwright.config.ts` يمنع فقط إعادة استخدام خادم أجنبي على نفس المنفذ؛ لا يمنع وراثة `DATABASE_URL`. الإصلاح إن حدث التلويث: أعد تشغيل `npx tsx src/scripts/seed-demo.ts` مع `.env.demo` (يستعيد كلمة مرور الـstaff من `DEMO_STAFF_PASSWORD`)، ثم احذف حسابات الاختبار المُقحَمة (`privdel-%`/`adminsub-%`/`e2e-%`/`audit-%`/`demo-signin-%`/`demo-signup-%`/`subui-%`/`mfa.e2e.%`) بشرط `created_at`.
- **14 فشل E2E متوقّع في وضع Demo**: مواصفات تعتمد `dev/verification-link` (404 في staging) أو locators `getByRole('status')` التي يزاحمها بانر DEMO. تُمرَّر في إعداد dev الأصلي (منافذ معزولة، بلا بانر) — ليست regressions.
- **فخ خادم يدوي على `:3000` أثناء E2E**: `playwright.config.ts` يضبط `reuseExistingServer: !CI`، فإن كان خادم `npm run dev -w @wasit/server` يعمل فسيُعاد استخدامه **بلا** تجاوزات الـrate-limit الخاصة بالـE2E (`RATE_LIMIT_LOGIN_MAX=500` ...). النتيجة 13 إخفاقة كاذبة سريعة في مكاتب admin (`admin-user-status`/`admin-privacy`/`admin-subscriptions`: `Cannot read properties of undefined (reading 'userId')` من تسجيل 429). أوقف الخادم اليدوي قبل تشغيل `npm run test:e2e` (المنفذ يجب أن يكون حرًّا).
- **منطق كشف التهريب مشترك**: أي مسار يكتب رسالة (لا الردود فقط) يجب أن يستدعي `scanMessageForFeeEvasion` في `modules/messaging/service.ts`. `openDirectThread` كان يتجاوز الكشف على الرسالة الأولى في الخيط الجديد (ثغرة C5 حقيقية أُصلحت 2026-09-24)؛ اختبار الانحدار في `tests/fee-evasion.test.ts`.

## AI-REG-01 — طبقة الوكلاء مصدر واحد (2026-11-20)

- **`modules/ai/catalogue.ts` هو المصدر الوحيد**: 20 وكيلًا (19 متخصصًا + المشرف #20) + Copilot خارج العدّ. كل مدخل يحمل `executable: boolean`؛ 11 قابل للتنفيذ و8 «معلنة» بلا executor.
- **`AGENT_CATALOGUE` في `agents.ts` مشتق** من `executableAgents()` — لا قائمة يدوية ثانية. `executors.ts` يملك جدول `EXECUTORS` ويصدّر `EXECUTABLE_AGENT_KEYS`؛ اختبارات `ai-reg01` تثبت تطابق (الكتالوج ⟷ جدول المنفّذين ⟷ `AGENT_SCOPE_CONTRACTS`).
- **الرفض قبل الكتابة**: `resolveAgentSpec()` + `agentRunRefusal()` → `UNKNOWN_AGENT` / `AGENT_NOT_EXECUTABLE` / `SUPERVISOR_NOT_RUNNABLE` / `COPILOT_NOT_RUNNABLE`، مع Audit `AI.AGENT_RUN_REFUSED`، قبل فحص الصلاحية وقبل أي صف `agent_tasks`.
- **التسجيل ≠ التشغيل**: `ensureAgentRegistrySeeded` يسجّل الـ20 كلها؛ `executable` وحدها تحدد ما يُشغَّل. نتيجة جدولة جديدة: `skipped_not_executable`.
- **المُوزِّع**: فحص القابلية داخل مسار الخطوة ⇒ الخطوة `FAILED` والتابع `SKIPPED` (لا إسقاط لنداء التوزيع).
- **API**: `GET /api/ai/agents` و`GET /api/admin/ai/agents` يعيدان الشريحة كاملة + `counts` (total/specialised/supervisor/executable/declared/copilot) + `copilot`. لوحة الإدارة تعرض شارات (auto/gated/declared/supervisor) وعدّادات؛ لوحة المستخدم تعرض القابل للتنفيذ فقط.
- **العقود الحيّة لم تتغيّر**: actions/permissions/approval/inputSchema للـ11 نُسخت حرفيًا من القائمة القديمة (تحقق آلي) — أي تضييق/توسيع كان سيغيّر RBAC الفعلي.
- **اختبارات**: `tests/unit/ai-reg01-agent-layer.test.ts` (9) + `tests/ai-reg01-agent-layer.test.ts` (7). التشغيل يتطلب `TEST_DATABASE_URL` صريحًا على 127.0.0.1:5434/wasit_test (بوابة `vitest.config.ts`).
- **الحالة**: **146 ملف · 1895 اختبار · 0 فشل** — server tsc 0 — web tsc 0 — web build نظيف.

## AI-MEM-01 — ذاكرة الوكلاء المؤسسية (2026-11-21)

- **`agent_memory` كان جدولًا فارغًا بلا كود** منذ migration `0033`؛ الطبقة الآن في
  `packages/server/src/modules/ai/memory.ts`. كل عملية تحمل `scope_owner` (من الجلسة، لا من الجسم)
  و`agent_key` معًا؛ `.strict()` على مخططات zod يرفض `scopeOwner`/`ownerId` بدل تجاهله.
- **المسارات**: `/api/ai/memory` (GET list, POST, GET/PATCH/DELETE `/:memoryId?agentKey=`) بـ`AI_USE`؛
  الإشراف `/api/admin/ai/memory/{summary,entries,entries/:id,purge}` بـ`AI_MANAGE` (لا صلاحية جديدة).
  فحص صف واحد يتطلب `reason` ≥ 10 أحرف ويُدقَّق `AI.MEMORY_INSPECTED`.
- **الأنواع** `operational|contextual|procedural|task_result`؛ TTL افتراضي 30/7/180/90 يومًا بسقف
  `AI_MEMORY_MAX_TTL_DAYS`. `task_result` يُكتب تلقائيًا لكل مهمة منتهية (حالة/زمن/رمز فقط) وسجل
  متدحرج يحذف أقدم `task_result` فقط — لا يحذف ملاحظات المالك.
- **رفض الأسرار**: 422 `MEMORY_CONTENT_REFUSED` (مفاتيح، رموز API/JWT/Bearer، كلمات مرور، بطاقات
  Luhn، IBAN، بريد). **السلامة**: checksum لكل صف ⇒ 409 `MEMORY_INTEGRITY_FAILED` عند التلاعب؛
  `revision` + `expectedRevision` ⇒ 409 `MEMORY_REVISION_MISMATCH`.
- **لا توسيع صلاحيات**: `agent_memory` ليست في `allowedTables` لأي وكيل (اختبارات
  `agent-scope-contract` تفرض ذلك)؛ `priorContext` يُبنى في `buildRunContext` من ذاكرة الوكيل نفسه
  ويمنح معلومات لا سلطة. فشل الذاكرة لا يُفشل المهمة.
- **بلا migration**: الظرف `{text,updatedAt,expiresAt,taskId,entityType,entityId,revision,checksum}`
  داخل `content` jsonb؛ الترقية إلى أعمدة مؤجَّلة (AD-046). لا واجهة ويب بعد.
- **اختبارات**: `tests/ai-mem01-agent-memory.test.ts` (15) + `tests/unit/agent-memory-policy.test.ts` (6).
  عند اختبار الحدود عدّل `env.AI_MEMORY_MAX_*` مؤقتًا وأعِدها في `finally` (بيئة الاختبار مشتركة).

## AI-MET-01 — قياس أداء الوكلاء الدائم (2026-11-21)

- **`agent_metrics` كان جدولًا فارغًا** منذ migration `0033` (لا كاتب ولا قارئ)، وA3
  (`agent-metrics.ts`) كان يحسب كل رقم وقت الطلب. الآن السجل الدائم في
  `packages/server/src/modules/ai/metrics.ts` — **بلا migration**.
- **منع التكرار في قاعدة البيانات**: المفتاح الأساسي = `sha256(JSON[agentKey,taskId,attempt,outcome])`
  بصيغة UUID. نفس الحدث مرتين ⇒ تصادم PK + `ON CONFLICT DO NOTHING`. **لا تضمّ الحقول بـ`|`** —
  استخدم `JSON.stringify` وإلا تصادمت مفاتيح تحتوي الفاصل (اختبار وحدة يفرض ذلك).
- **ربط دورة الحياة** في `agents.ts` عبر `recordMetricSafely` (يبتلع الفشل، لا يُفشل المهمة):
  نجاح/فشل مباشر، نجاح/فشل بعد الموافقة، `rejected` عند الرفض البشري، و`blocked` عند الرفض قبل
  التنفيذ (`task_id = null`). محاولة ثانية = صف جديد (attempt من `agent_tasks.attempts + 1`).
- **المسارات** (كلها `AI_MANAGE` تحت `/api/admin/ai`): `GET /metrics/report|series|coverage`،
  `POST /metrics/backfill`. النافذة ≤ 366 يومًا، `from < to`، ومخطط `.strict()` يرفض `ownerId`.
  القراءة `AI.METRICS_REPORT_READ` والملء `AI.METRICS_BACKFILLED` في `audit_logs`.
- **لا أرقام مُخترعة**: التكلفة `unavailable`/`null` عند غياب صف `ai_requests` (لا صفر)،
  `businessOutcomes` دائمًا `unavailable` مع سبب، و`stalled` = «مفتوحة أطول من العتبة» وليست timeout.
  التقرير يعرض `coverage` (مهام النافذة مقابل مهام لها صف) و`truncated` عند بلوغ سقف الصفوف.
- **مصادر الأرقام**: التنفيذ/الإعادة/الزمن من `agent_metrics`؛ الموافقات والتعليق من `agent_tasks`؛
  الأدوات من `audit_logs` (`AI.TOOL_*`, `TOOL_TIMEOUT`)؛ الذاكرة عدًّا فقط (`AI.MEMORY_*` +
  أنواع `agent_memory`)؛ التكلفة من `ai_requests`.
- **عزل**: كل صف يحمل `scope_owner` من الصف المخزَّن؛ التقرير لا يعرض معرّفات مالكين ولا نصوصًا —
  عدد المالكين المختلفين فقط.
- **`agent-metrics.ts` (A3) لم يتغيّر عقده**؛ السطح الدائم إضافة. اختبار `ai-reg01` يسمح الآن
  بكتابة تدقيق + قياس عند الرفض، ويشترط **عدم** كتابة `agent_tasks`.
- **اختبارات**: `tests/ai-met01-agent-metrics.test.ts` (18) + `tests/unit/agent-metrics-store.test.ts` (6).

## AI-SUP-02 — التصعيد إلى المدير العام (2026-11-21)

- **الكتالوج كان يعلن `escalate` وهدف `supervisor.escalation_delivery` بلا تنفيذ.** الآن:
  `modules/ai/escalation-policy.ts` (صرف: 9 قواعد، بلا DB/ساعة) + `modules/ai/escalations.ts`
  (جمع حقائق → فتح/ترقية/إشعار → دورة حياة). **بلا migration**: الحالة في `alert_events`
  بـ`rule = 'supervisor.<code>'`، والمغلّف (fingerprint/توصية/أدلة/من أقرّ) في `details`.
- **منع التكرار بلا فهرس فريد**: كل كتابة داخل معاملة تبدأ بـ
  `select pg_advisory_xact_lock(hashtext('ai-escalation:<fingerprint>'))` ثم تقرأ الحالة المفتوحة.
  البصمة = `sha256(JSON[code,agentKey,taskId,runId])` (JSON لا ضمّ). لا تحذف القفل: بدونه يمكن
  فتح حالتين لنفس الشرط تحت التزامن.
- **التصنيف**: `INFO/WARNING/HIGH/CRITICAL`؛ نفس البصمة بخطورة أعلى ⇒ ترقية + إعادة فتح + إشعار
  ثانٍ (جيل جديد في `dedupe_key`)؛ نفس الخطورة ⇒ تحديث أدلة و`occurrences` **بلا إشعار**.
  حالة `RESOLVED` لا تُفتح؛ `reopenCooldownMinutes` (60) يمنع إعادة الفتح الفوري.
- **قناة GM**: `notifications` + `notification_deliveries` لمستخدمي `SUPER_ADMIN` النشطين فقط.
  لا بريد/SMS/webhook. `dedupeKey = escalation:<id>:<user>:IN_APP:<generation>` يمنع التكرار ويسمح
  بإعادة التسليم (تحديث الصف، لا صف جديد).
- **فشل القناة لا يُفقد الحالة**: تُكتب الحالة أولًا، ويُسجَّل `notified_result=FAILED` + صف FAILED،
  و`POST /api/admin/ai/escalations/:id/notify` يعيد المحاولة.
- **المسارات** (`AI_MANAGE` فقط، بلا صلاحية جديدة): `GET /api/admin/ai/escalations` (+`/:id`)،
  `POST /scan`، `POST /:id/acknowledge`، `POST /:id/resolve` (ملاحظة إلزامية)، `POST /:id/notify`.
  سجّل `/escalations/scan` **قبل** `/:id` وإلا قُرئ المسار الحرفي كمعرّف.
- **Kill Switch**: المسح يتوقف كليًا ويُدقَّق `AI.KILL_SWITCH_ESCALATION_REFUSED`؛ الإقرار/الإغلاق
  البشري يبقى متاحًا (الإيقاف يوقف الآلة لا الإنسان).
- **⚠️ انحراف ساعة**: حدود النافذة تُقارَن بـ`created_at` المكتوب من PostgreSQL، لذا `curTo` مضاف
  إليه `CLOCK_SKEW_MS = 5000`. إزالة هذا الهامش تُسقط صفوفًا كُتبت للتو (اختبار متقطع أثبته).
- **لا تشخيص مزدوج للمهمة**: `awaiting_approval` ⇒ `approvals_pending` فقط (ليست متوقفة)،
  و`queued` عند سقف المحاولات ⇒ `task_attempts_exhausted` فقط.
- **اختبارات**: `tests/ai-sup02-escalations.test.ts` (21) + `tests/unit/escalation-policy.test.ts` (22).
  بيانات الاختبار مفهرسة بـ`sup02-*` agent keys لأن الاكتشاف يقرأ كل الصفوف في النافذة.

## PHASE 17 — Security + Privacy + Audit (مكتملة — 123/123)

- ✅ **MFA (TOTP RFC 6238)** `modules/auth` + `lib/mfa.ts`: enroll/confirm/disable/status/verify/recovery-codes/dev-totp. كل endpoint: `requireAuth` + `rateLimit` + Audit (`AUTH.MFA_*`). `dev-totp` محجوب في `NODE_ENV=production` (403).
- ✅ **تحدي MFA عند الدخول (C4)**: `loginUser` يعيد `mfa_required` + `challengeToken` بلا جلسة عند `mfaEnabled`؛ جدول `mfa_challenges` (migration `0019`، `tokenHash` فقط، أحادي الاستخدام، TTL/عدّاد محاولات) و`completeMfaLogin` يصدر الجلسة عبر `issueSession` بعد TOTP أو رمز استرداد. الواجهة: خطوة ثانية في `LoginPage` + بطاقة MFA في `DashboardSecurityPage`. اختبارات: `tests/mfa-login-challenge.test.ts` (10) + `e2e/mfa.spec.ts` (2) — لا mocks.
- ✅ **Recovery codes مخزّنة salted** بصيغة `salt:hash` — `hashRecoveryCode()` يولد salt عشوائي 16 بايت لكل وسم، SHA-256 لـ `salt+code`. التحقق عبر `verifyRecoveryCode()` يعيد `{valid, legacy}` ويستخدم `timingSafeEqual` (constant-time). **Single-use**: الكود المحظوظ يُحذف من `recoveryCodesHash`، إعادة الاستخدام تفشل.
- ✅ **Backward compat**: الهاش القديم غير المملّح (64-hex بلا `:`) يتحقق ويعيد `legacy:true`، ويُرقّى تلقائياً عند أول استخدام ناجح. لا حاجة إلى migration جديدة.
- ✅ **Privacy Engine** `modules/privacy`: `/api/privacy/me|consents|export|deletion` (auth صريح لكل route، rate limit قبل auth على الحساسة) + `/api/admin/privacy/deletions` (ADMIN/SUPER_ADMIN).
- ✅ **لا تسريب**: لا يعيد أي endpoint `recoveryCodesHashed`/hash/secret (سوى `secretBase32`+`recoveryCodes` مرة واحدة في enroll للعرض). مُثبت في `tests/security-privacy.test.ts`.
- ✅ **Rate-limit store معزول للاختبار فقط**: `resetRateLimitStore()` من `middleware/rate-limit.ts` (إنتاجية unchanged). لا تغيير في deletion logic أو isActive.
- 🛠 **إشارة**: أي اختبار جديد يلمس `rate-limit` في privacy يجب أن يستدعي `resetRateLimitStore()` في `beforeEach` ويستخدم IPs فريدة عبر `makeClient(ip)`.

## AI-ARCH-ALIGN-01 — الهيكل الرسمي للمنظومة الذكية (2026-11-20)

- **مصدر الحقيقة الواحد**: `packages/server/src/modules/ai/catalogue.ts`. كل وكيل يحمل `tier`:
  `CORE_SPECIALIST` (12) · `SUPPORTING` (8) · `GOVERNANCE` (Copilot + Supervisor).
- **`CORE_SPECIALIST_KEYS`** هي القائمة الرسمية المرتّبة: sales, marketing, ads, product, support,
  analytics, market-research, b2b, risk, dispute-assistant, development, **marketing-video**.
  `catalogueIntegrity()` يفحص الاتجاهين — لا تعدّل أحدهما وحده.
- **العدّ الحالي (بعد AI-FIRST-COMPLETION-03)**: `agentCount()` = 21 (20 متخصصاً + المشرف)،
  `allAgentSpecs()` = 22 (مع Copilot)، `declaredOnlyAgents()` = **6**، `executableAgents()` = **14**،
  `requiresPlatformScope` = **11** (`b2b-agent` أُضيف).
  أي اختبار يثبّت رقماً يجب تحديثه معاً (r1 · ai-reg01 unit+HTTP · phase14 · a2 · r2 · agent-scope-contract).
- **`marketing-video-agent` يخطّط ويرندر ويتحقق داخل المهمة** (`plan_video`): يقرأ منتجاً حقيقياً بملكية محققة،
  يرندر محلياً (ffmpeg+libass) إلى `agent-videos/<requester>/<taskId>-<sha12>.mp4`، ثم `ffprobe` + فك ترميز كامل،
  ويُعيد `video{storageKey,bytes,sha256,durationSeconds,codec,width,height,frames,decode,verified}` و`steps[]`.
  **لا يكتب `media_assets` ولا `audit_logs`** (A2) ولا ينشر. `render:false` يطلب خطة فقط.
  `video.publish`/`video.render_paid` إجراءان حسّاسان (موافقة بشرية دائماً).
- **`validatePlan` يرفض وقت التخطيط** أي خطوة تستهدف وكيلاً غير قابل للتنفيذ أو المشرف أو Copilot —
  قبل كتابة صف تشغيل. لا تعد إلى قبولها «لأن الإرسال يرفضها»: الرفض المبكر هو العقد.
- **`POST /api/admin/ai/agent-runs`** هو مدخل التنسيق الوحيد: ينشئ `PLANNING` فقط، بلا إرسال ولا
  موافقة، ويحترم Kill Switch و`AI_MANAGE`.
- **لا تفكيك أهداف آلي** ولا اختيار وكيل تلقائي — المتصل يزوّد الخطوات، والكود يتحقق من الأهلية.
- **اختبارات**: `tests/unit/ai-arch-align.test.ts` (17) + `tests/ai-arch-align-copilot.test.ts` (12).
- التفاصيل: `docs/AI-ARCH-ALIGN-01_STRUCTURE_ALIGNMENT.md` · `docs/AI_MARKETING_VIDEO_AGENT.md` · AD-049.

## AI-AGENT-MERGE-01 — دمج الاختصاصات وتطوير الوكلاء (2026-11-20)

- **لا وكيل جديد ولا محذوف**: ثلاث هويات قائمة أُعيد توجيهها بمفاتيحها الأصلية:
  `outreach-acquisition-agent` (Global Growth & Acquisition) · `finance-agent` (Finance & Cost Accounting) ·
  `development-agent` (Platform Maintenance & Repair). الهيكل الرسمي 12+8+حوكمة كما هو.
- **ثلاثة منفّذين حتميين على بيانات حقيقية** (`src/modules/ai/executors.ts`):
  `execGrowthAgent` (`discover_markets`) · `execFinanceAgent` (`report_pnl`) ·
  `execDevelopmentAgent` (`diagnose_platform`، موسّع). `EXECUTOR_ACTION` مُصدَّر ليُفحص مقابل القدرات.
- **قاعدة صارمة للمالية**: لا خلط عملات. كل رقم يحمل عملته ومصدره؛ المساهمة `null` + `reason`
  عند غياب تكلفة بعملة الإيراد. **لا تقرأ `transaction_ledger` ولا `commission_policies`** (محجوبان).
  أُزيلت `finance.read_ledger` من `allowedTools` لأنها غير قابلة للخدمة أصلاً.
- **قاعدة صارمة للصيانة**: التشخيص تلقائي من `agent_tasks`/`agent_runs`/`agent_run_steps`؛
  `code.apply_patch`/`code.merge` إعلان بلا منفّذ، و`repairProtocol.appliesChanges === false`.
  **لا تضف منفّذاً لهما** بلا قرار GM صريح + مراجعة بشرية.
- **النمو لا يخرج من المنصة**: `outreach.send`/`growth.paid_campaign` في `SENSITIVE_ACTIONS` وبلا منفّذ،
  والمسودات `DRAFT_ONLY` / `delivery: 'none'`، والوكيل يبقى `requiresHumanApproval: true`.
- **`taskTypes` القديمة محفوظة** (`outreach.run_cycle`, `finance.reconcile`, `dev.plan_change`) — لا تحذفها،
  فهي جزء من تاريخ المهام.
- **اختبارات**: `tests/unit/ai-agent-merge-01.test.ts` (14) + `tests/ai-agent-merge-01.test.ts` (5، PostgreSQL).
- التفاصيل: `docs/AI-AGENT-MERGE-01.md` · AD-050 · `docs/AI_MARKETING_VIDEO_AGENT.md` (§7–§10).

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

## AI-04 — Secure AI Provider Management (2026-11-22, `afc-09`)

- **`ai_providers`** (`schema/ai_providers.ts`, migration `0042`): one row per (environment, provider). `model` holds a **catalogue key** (`ai_models.key`), never a vendor name — `VENDOR_MODEL_NAMES` translates at the adapter boundary. Validation rejects a model that is unknown or belongs to another provider.
- **Secrets never leave**: `lib/ai/secret-box.ts` seals with AES-256-GCM under `AI_SECRET_ENCRYPTION_KEY` (32B base64, env only) and `aad = environment:provider:v1`. No route returns a key; `keyState` exposes presence/source/`sha256[:16]` fingerprint only. No master key → `409 SECRET_STORAGE_DISABLED`, nothing written. A stored key is invisible to another `AI_CONFIG_ENVIRONMENT`.
- **Chain**: `default → fallback → local-heuristic`, resolved by `resolveProviderChain` (never throws). A fallback serves **its own** model/price; a vendor never receives another vendor's model name. `noop` is refused in production. No key anywhere → the platform runs on the local engine at zero cost.
- **Backward compatibility**: a provider row no admin has touched (`updatedBy IS NULL`) stays active when `AI_PROVIDER` names it, so env-only deployments need no migration step.
- **Agent isolation**: `ai_providers` is in `HARD_DENY_TABLES`; platform resolution inside an agent run unwraps the scoped handle via `platformDb()` (`PLATFORM_DB` symbol in `db/client.ts`). An agent's own query is still refused — proven in `tests/afc09-ai-providers.test.ts`.
- **Live probes are opt-in** (`AI_PROVIDER_ALLOW_LIVE_TEST=true`), send only `ping`/`max_tokens:1`, and `baseUrl` must be HTTPS + allowlisted (`AI_PROVIDER_ALLOWED_HOSTS`) — SSRF guard.
- **API**: `/api/admin/ai/providers` (list, `-readiness`, `:key`, PATCH, `PUT/DELETE :key/secret`, `POST :key/test`, `GET :key/usage`) under `AI_MANAGE`/`ADMIN_AI`, audited as `AI_PROVIDER.*`. Mounted **before** `app.route('/api/admin', ...)` — Hono dispatches to the first matching mount.
- **UI**: tab «المزوّدون» in `/admin/ai` (`components/AiProvidersPanel.tsx`), i18n `adminAi.providers.*` in ar/en/fr/zh.
- **Tests**: `tests/afc09-ai-providers.test.ts` (23). Full suite after AI-04: **174 files / 2233 tests**.

## GM-ACCESS-01 — دخول المدير العام بلا بريد (2026-11-23)

- **البوابة لم تُعطَّل ولن تُعطَّل**: `loginUser` يبقى يرفض `emailVerified=false` بـ`403 EMAIL_NOT_VERIFIED` لكل حساب. لا تُضِف استثناءً لدور (لا `SUPER_ADMIN` ولا غيره) ولا `if (role === ...) skip`.
- **مسارات الإشباع الثلاثة**: رابط البريد · **عامل ثانٍ مؤكَّد** (`authenticator_apps.enabled AND confirmed_at IS NOT NULL`، يُقرأ حيًّا عبر `hasConfirmedSecondFactor`) · **تذكرة مشغّل** (`gm_access_tickets`، هاش فقط، 15 دقيقة، أحادية الاستخدام، مقيَّدة بحساب، سقف 3 محاولات).
- **التذكرة تُولَّد من CLI فقط**: `npm run gm:access -- issue|reset-factor|status --email <..> --reason ".." --confirm` (`src/scripts/gm-access.ts`). لا مسار HTTP يولّدها، و`issueGmAccessTicket` ترفض أي حساب ليس `SUPER_ADMIN` وتدقّق الرفض `GM_ACCESS.TICKET_REFUSED`. لا تُضِف مسار HTTP للاسترداد.
- **التذكرة لا تتجاوز عاملًا مُفعَّلًا** ولا تمنح دورًا ولا تعيد تعيين كلمة مرور — مُثبت في `tests/gm-access-01.test.ts` (17 حالة). لا تُغيّر ترتيب الفحص: العامل المؤكَّد أولًا، ثم التذكرة، ثم الرفض.
- **`/api/auth/mfa/enroll` يتطلب كلمة المرور دائمًا** (+ رمز حالي إن كان العامل مُفعَّلًا) عبر `assertIdentityForFactorChange`. لا تُعِد قبول جلسة وحدها: جلسة مسروقة كانت تُزيح عامل المالك.
- **تغيير العامل يُبطل الجلسات الأخرى**: `revokeOtherSessions` بعد confirm/disable/recovery-codes، و`revokeAllSessionsForUser` في `reset-factor`. الجلسة الطالبة تبقى.
- **لا أسرار في التدقيق**: صفوف `GM_ACCESS.*` تحمل `ticketId`/السبب/المشغّل فقط. أي إضافة تكتب التذكرة أو هاشها أو كلمة المرور تُفشل `secret-scan` أو اختبار التسريب.
- **التوثيق**: `docs/GM-ACCESS-01.md` (الإجراء للمالك) + AD-058 + §25 في `docs/GAP_REGISTER.md`.

## GM-ACCESS-04 — حارس بيئة قاعدة البيانات (2026-11-23)

- **البوابة** `lib/db-target-guard.ts`: `set-password` و`reset-factor` يرفضان ما لم يتحقّق **ثلاثة شروط مستقلة**: `NODE_ENV=production`، و`WASIT_PRODUCTION_DB_NAME` مساوٍ لِـ`current_database()` المقروء من الخادم، والاسم غير محمي. `WASIT_PRODUCTION_DB_HOST` تثبيت اختياري (يقارن بـ`host(inet_server_addr())` بلا netmask).
- **ترتيب مقصود**: فحص الاسم المحمي **بعد** التطابق (فإعلان `wasit_demo` لا يُشرّع نفسه)، والبوابة كلها **قبل** البحث عن الحساب ⇒ الرفض لا يكتب صف تدقيق ولا يبطل جلسة ولا يقرأ ملف السر. رمز الخروج `2`.
- **الأسماء المحمية**: `postgres`, `template*`, `wasit_dev`, `wasit_staging`, `wasit_test`, `wasit_demo`, `*_test`, `*_demo`, `*_dev`, `*_staging`, `_restore*`, `_drill*`. لا تُخفّف القائمة ولا تُضاف استثناءات.
- **الهوية من الخادم لا من السلسلة**: `current_database()`/`host(inet_server_addr())`/`inet_server_port()`/`current_user` — `DATABASE_URL` ليس دليلًا أبدًا.
- **غير محروس بقصد**: `status` (قراءة) و`issue` (خارج النطاق — `DECISION REQUIRED` في AD-060).
- **`lib/env.ts`** يعطي إشارة ثانية مجانية: الإقلاع في `production` يُرفض بـ`JWT_SECRET` افتراضي أو بـ`ALLOW_DEV_TOOLING`/`DEMO_PAYMENT_MODE`، فلا يمكن تزييف بيئة إنتاج على خادم اختباري.
- **الاختبارات** `tests/gm-access-04.test.ts` (18): مصفوفة قبول/رفض على دالّة القرار + 4 حالات تشغّل الـCLI الحقيقي كعمليّة فرعية (برفض `wasit_test` حتى مع `NODE_ENV=production`). أي تعديل على `main()` يجب أن يُبقي هذه الأربع ناجحة.
- **التوثيق**: `docs/GM-ACCESS-04.md` (إجراء الإنتاج + الفحوص قبل الكتابة) · AD-060 · §27. لا Migration، لا مسار HTTP، لا صلاحية.

## GM-ACCESS-02 — تدوير كلمة مرور المدير العام (2026-11-23)

- **الأمر الوحيد**: `npm run gm:access -- set-password --email <..> --reason ".." --confirm [--generate | --password-file <path>]`. لا مسار HTTP، ولا كلمة مرور مشتركة، ولا `Rhimi123`/`Passw0rd!2026` (قائمة رفض في `BANNED_PASSWORDS`).
- **النطاق**: `users.password_hash` لحساب `SUPER_ADMIN` واحد + `sessions.revoked_at`. **لا تلمس** `email_verified` (البوابة باقية) ولا `mfa_enabled`/`authenticator_apps` (العامل يبقى مطلوبًا) ولا `user_roles` (لا ترقية).
- **لا سر في argv ولا في المخرجات**: `--password` مرفوض صراحةً؛ المولّد `generateGmPassword()` (٣٢ حرفًا، أربع فئات مضمونة، CSPRNG عبر `randomInt`)؛ `--password-file` يُرفض إن كان مقروءًا للمجموعة/الآخرين؛ الخزانة ملف `0600` داخل مجلد `0700` **خارج أي شجرة Git** (`assertOutsideGitTree`)، تُكتب قبل التغيير وتُحذف إن فشل التطبيق.
- **السياسة**: ≥ ٢٤ حرفًا + أربع فئات + لا اسم الحساب (`assertStrongGmPassword`) — أقوى من التسجيل (٨) ومن `bootstrap-super-admin` (١٢). لا تُخفّضها.
- **التدقيق**: `GM_ACCESS.PASSWORD_RESET` (سبب + مشغّل + `sessionsRevoked`) و`GM_ACCESS.PASSWORD_RESET_REFUSED` لغير `SUPER_ADMIN` — **بلا** كلمة المرور أو الهاش. اختبار `tests/gm-access-02.test.ts` (12 حالة) يبحث عن السر والهاش في الصفوف.
- **لا Migration**: الأداة تستخدم `users.password_hash` و`sessions` القائمين. لا تُضِف جدولًا لهذا الغرض.
- **التوثيق**: `docs/GM-ACCESS-02.md` (إجراء المالك + الخزانة) · AD-059 · §26 في `docs/GAP_REGISTER.md`. أي تطبيق على حساب فعلي يحتاج موافقة صريحة.

## Money Path Invariants (2026-09-24)

- **`Payment ≠ Settlement`** (عقد مُنفَّذ في الكود): تأكيد الدفع (`applyPaymentSucceeded`) **لا يكتب** `transaction_ledger.status='SETTLED'` أبداً — القيود تبقى `PENDING`. الكاتب **الوحيد** لـ`SETTLED` هو `applySettlementConfirmed` في `modules/payments/service.ts`، ولا يُستدعى إلا من حدث webhook نوعه `settlement.confirmed` من مزوّد يعلن `capabilities.settlementEvidence`.
- **حدود القدرات**: كل مزوّد يعرّف `capabilities = { settlementEvidence, payout, demo }` في `lib/payments/providers.ts`. `manual` هو `{ demo: true, settlementEvidence: false }` — هيكل عرض/اختبار، ليس قناة أموال. `resolvePaymentProvider()` يرفض أي مزوّد `demo` إلا عند `DEMO_PAYMENT_MODE=true` (والـproduction يرفض الإقلاع به).
- **تشغيل الاختبارات/E2E**: `DEMO_PAYMENT_MODE=true` مُضاف إلى `vitest.config.ts` و`playwright.config.ts` و`.env.demo` — لأن مزوّد `manual` محجوب افتراضياً. أي suite جديدة تستخدم المزوّد اليدوي يجب أن تُشغَّل مع هذه الراية.
- **Revert/إصلاح**: لا تُعِد كتابة `SETTLED` داخل مسار تأكيد الدفع، ولا تسمح بحدث `settlement.confirmed` من مزوّد ديمو — حرسان مُثبتان في `tests/money-path-invariants.test.ts`.
- **تدقيق قراءة فقط**: `npx tsx src/scripts/verify-money-path.ts` يكشف صفوف `SETTLED` بلا دليل تسوية (`SETTLEMENT.CONFIRMED` في `audit_logs`) ويُخرج exit code غير صفري عند وجود مخالفة. لا يكتب شيئاً.
- **E2E محلي**: Playwright يحتاج `wasit_dev`؛ إن لم توجد فأنشئها فقط (`CREATE DATABASE wasit_dev`) ثم `npx drizzle-kit migrate` + `npx tsx src/scripts/seed.ts`. **ممنوع** `db reset/drop/push`.
- **`Refund = request ≠ money returned`** (LC-04، WASIT-EXECUTION-009.1): `createRefund` يكتب **طلب** فقط (`REQUESTED` بلا مسار موثوق، `PROCESSING` عند مزوّد موثوق سيُستدعى). **الكاتب الوحيد** للحالة `COMPLETED` + قيد `REFUND` (DEBIT/PENDING) + عكس العمولة/الرسم + `REFUNDED` هو `completeRefundWithEvidence`، ولا يُقبل إلا بـ**إثبات خارجي موثوق** مطابِق للمبلغ/العملة. `canProveRefund` (في `lib/payments/refund-integrity.ts`) يرفض كل مزوّد `demo`/غير متاح. **webhook `REFUND_SUCCEEDED` من مزوّد عرض يُرفض (422)**. لا Migration (نوع `refund_status` يكفي، والإثبات في `audit_logs`). تشغيل معزول: `npx vitest run --config vitest.lc04.config.ts`.
- **قيد عمولة المشتري يحمل نصيبه لا الإجمالي** (2026-11-17): قيد `transaction_ledger` للعمولة يحمل `metadata.share` (`SELLER`/`BUYER`) و`metadata.rate` = **سعر تلك الحصة وحدها** (`commission.buyerRate` للمشتري، `commission.sellerRate` للبائع). السياسة المُجمَّدة BASE: 4% إجمالاً = 2% بائع + 2% مشترٍ. **فخ مُصلَح**: كان قيد المشتري يسجّل `commissionTotalRate` (4%) مع أنّ مبلغه 2% من البضاعة ⇒ تناقض بين السعر المُعلَن والمبلغ. كود الإنتاج **لا يقرأ** `metadata.rate` (فقط `meta.share==='SELLER'`)، فهو وصفي — لكن `financial-audit.spec.ts` يتحقّق منه (`0.02`). حرس: اختبار في `tests/money-path-invariants.test.ts`.
- **فخ Git — لا تُرجِع ملفاً بتعديل غير محفوظ** (2026-11-17، حادثة): `git checkout -- <file>` يمحو تعديلات العمل غير المحفوظة نهائياً. أثناء «الفحص» جرى إرجاع 3 ملفات فمُحي تعديل مسبق على `money-path-invariants.test.ts` (مواءمة LC-04). **القاعدة**: قبل أي `checkout/reset/restore/stash` افحص `git diff -- <file>` أولاً؛ لا تلمس ملفاً بتعديل غير متوقّع. التفاصيل: `docs/WASIT_EXECUTION_REGISTER.md` §9.

## Functional UI audit — running the suites correctly (2026-09-28)

- **Always run UI suites against the public HTTPS link**, not `http://127.0.0.1:12000`. The session cookie `wasit_session` is issued with `Secure`, so Playwright's `page.request.*` silently drops it on plain HTTP and returns spurious `401`s. The app itself is fine in that case — an in-page `fetch('/api/...', { credentials: 'include' })` still returns `200`. Suites affected if run over HTTP: `ui-messages-check`, `ui-subscription-check`, `ui-inventory-search-check`.
- Run: `node scripts/ui-redesign-check.mjs https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev`.
- Preview servers: `vite preview` on port 12000 proxies `/api`, `/sitemap.xml`, `/robots.txt` to the backend (same-origin session semantics as production nginx). Build first with `VITE_DEMO_MODE=true npm run build -w @wasit/web` (the flag turns on the demo banner), then `cd packages/web && npx vite preview --port 12000 --host 0.0.0.0`.
- **Server integration tests need a disposable DB**: `TEST_DATABASE_URL` must name a database ending in `_test` (hard guard in `packages/server/tests/setup.ts`). `npm test` alone fails with `password authentication failed for user "wasit"`. Use: `PW=$(grep '^DATABASE_URL' .env.demo | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/'); TEST_DATABASE_URL="postgresql://wasit_demo:${PW}@localhost:5432/wasit_test" npm test`.

## DEMO-SEC-01 — تأمين العرض العام (2026-11-21)

- **مركز تدقيق المالك أداة تشغيلية**: `POST /api/auth/demo-audit-session` يبقى محصورًا بـ`DEMO_AUTO_LOGIN` (404 خارج العرض/الإنتاج، يُفحص **قبل** المصادقة)، ثم `requireAuth` + `canOpenDemoPersona` في `lib/demo-account.ts`: زائر `401`، غير موظف `403`، والشخصية لا تتجاوز دور المستدعي (ADMIN لا يفتح SUPER_ADMIN). `/demo/owner` لم يعد يفتح جلسة تلقائيًا؛ يعرض `owner-staff-only` + رابط دخول.
- **`/api/auth/demo-session`** بقي كما هو: يفتح حساب العميل الرسمي فقط، بلا صلاحيات موظفين.
- **تدوير بيانات الاعتماد**: `DEMO_ACCOUNT_PASSWORD` (اختياري) يحل محل `Passw0rd!2026` لحسابات العرض الأربعة + `demo@wasit.tn`؛ وجوده يجعل `seed-demo` يعيد هاش كل حساب (تدوير فعلي). غيابه = احتياطي التطوير/E2E فقط.
- **لا كلمات مرور في السجلات**: `seed-demo` لم يعد يطبع كلمة المرور المنشورة ولا كلمة مرور الموظفين المولَّدة.
- **الاختبارات**: `tests/unit/demo-audit-authorization.test.ts` (قاعدة السقف)، `tests/demo-auto-login.test.ts` (401/403/404 + منع التصعيد + جلسة العميل)، `e2e/demo-owner.spec.ts` (زائر/SUPER_ADMIN/ADMIN).

## Public demo (DEMO-02 — 2026-11-22)

- الرابط العام الحالي يُخدَم من `vite preview` على 12000 + API على 3000 + PostgreSQL 17 على
  `127.0.0.1:5434` بقاعدة **`wasit_demo` معزولة** (migrate + `seed.ts` + `seed-demo.ts`).
  التفاصيل والاستعادة في `docs/DEMO-01_PUBLIC_DEMO.md` (لا يوجد مستند DEMO-02 على هذا الفرع).
- **سبب تعطّل الرابط السابق**: قاعدة `wasit_demo` كانت في حاوية Docker اختفت مع إعادة إنشاء
  الحاوية، و`vite preview` يرفض أي Host غير مُدرج. الآن `allowedHosts` يُشتق من `APP_URL`
  و`CORS_ORIGIN` و`WEB_ALLOWED_HOSTS` (`packages/web/vite.config.ts`, اختبار
  `tests/preview-hosts.test.ts`) — فلا حاجة لتعديل الكود عند تغيّر اسم نطاق التشغيل.
- **إعدادان إلزاميان للعرض العام في `.env.demo`**: `DEMO_AUTO_LOGIN=false` (لا جلسة بلا بيانات
  اعتماد) و`ALLOW_DEV_TOOLING=false` (وإلا صار `devResetToken` متاحاً لأي بريد بما فيه
  `admin@wasit.tn`). `DEMO_SKIP_EMAIL_VERIFICATION=true` يبقى لأن البريد `log` فقط.
- **شريط التنقّل**: `AppSidebar` صار drawer تحت `lg` (زر في `TopHeader`، إغلاق تلقائي عند
  التنقّل) — كان يُضغط محتوى لوحة التحكم على هواتف 412px.

## Demo credentials (DEMO-SEC-03 — 2026-11-22)

- كل حساب تجريبي له **كلمة مرور فريدة** (`DEMO_ACCOUNT_PASSWORD_<NAME>`) وليس واحدة مشتركة،
  والـstaff له `DEMO_STAFF_PASSWORD_ADMIN` / `_ADMIN2`. المنطق في `lib/demo-credentials.ts`
  (يستخدمه `seed-demo` وسكربت التدوير معاً)، والاختبار `tests/demo-credentials.test.ts`.
- التدوير: `npx tsx src/scripts/rotate-demo-credentials.ts --include-staff` — يولّد أسراراً
  جديدة، يبطل كل الجلسات + رموز إعادة التعيين + تحديات MFA، ويكتب `AUTH.DEMO_CREDENTIAL_ROTATED`.
  لا Migration ولا RBAC change.
- الأسرار في `.env.demo.secrets` و`.env.demo` بصلاحية 0600 ومستبعدة من git (`.env.demo.*`).
  **لا تُطبع ولا تُنسخ إلى تقرير أو commit.**
- أعد تشغيل `seed-demo` مع `.env.demo` الكامل (يحوي مفاتيح كل حساب) كي لا تعود كلمة المرور
  المنشورة. التفاصيل: `docs/DEMO-03_CREDENTIAL_ROTATION.md`.

## AFC-06.1 — الصوت التونسي (حزمة تسجيل مرخَّصة) — 2026-11-22

- **لا نموذج تونسي بترخيص تجاري**: Piper فيه صوتان عربيان فقط (`ar_JO-kareem`)، وكل نماذج الدارجة المنشورة `CC-BY-NC-4.0` (`Ghazouaniwala/silma-tts-derja`, `Nouira-Oussema/Tunisian-TTS`) أو بلا ترخيص (`amenIKh/Tunisian_TTS`). الأساسات نفسها NC: XTTS-v2 (CPML)، F5-TTS، MMS.
- **المسار المعتمد**: `lib/media/voice-pack.ts` — `VOICE_PACK_DIR` أو `vendor/voices/<lang>/manifest.json` + WAV، مطابقة `sha256` على السطر بعد تطبيع المسافات. الحزمة تسبق أي صوت صناعي في `resolveVoice`.
- **حرس الترخيص (لا يُتجاوَز)**: رفض عند `license.commercialUse !== true`، غياب `license.holder`/`terms`، غياب `consent.reference`، انتهاء `validUntil`، ملف مفقود، سطر مكرَّر، و`dialectNative !== true` لأي حزمة `ar-TN`.
- **قيد تصميمي**: نص `ar-TN` صار ثابتًا (اسم المنتج/السوم/البائع على الشاشة فقط) لأن الحزمة المسجَّلة لا تنطق أسماء متغيّرة. `npm run voices:brief -w @wasit/server` يولّد `artifacts/voice-packs/ar-TN/{brief.md,lines.json}`: **6 أسطر / 60 كلمة** تغطي كل الفيديوهات.
- **لا تسمية فصحى بتونسي**: الحزمة التجريبية `tests/fixtures/voice-pack/ar-TN` صوت Piper فصحى ومعلَّمة `dialectNative:false` ⇒ مرفوضة (اختبار صريح). أي إثبات بـ`dialectNative:true` هو سباكة فقط وليس ادعاء لهجة.
- **الوضع الحالي**: `ar-TN` محجوب (`audio.voiceover`)، والبقية `DELIVERED` — `verify:videos` يحتاج `DATABASE_URL` من `.env.demo`.
- **بديل التوسع**: Azure `ar-TN-ReemNeural`/`ar-TN-HediNeural` ($15/1M حرف، 0.5M مجانًا/شهر على F0) أو Custom Neural Voice ($4.032/ساعة استضافة) — يحتاج موافقة مالية واختبار سماع. التفاصيل في `docs/VOICE-TUNISIAN.md` وAD-053.

## AFC-07 — مساعد النزاعات يلخّص نزاعًا واحدًا (2026-11-20)

- **العيب الذي أُغلق:** `dispute-assistant` كان يتجاهل `input.disputeId`، ويجمع آخر 5 رسائل من كل النزاعات في مخرج واحد، ويعيد جملة ثابتة كتوصية. وجود executor + اختبار يفحص وجود الحقل لم يكونا دليل اكتمال.
- **الوضعان:** `summary` (مع `disputeId`: وقائع + مبلغ الطلب + أدلة + أحداث + استئنافات + مهل + ثغرات + مسارات + توصية) و`triage` (بلا `disputeId`: أعداد وأعمار فقط، **بلا أي نص رسالة**).
- **السياسة:** `policies` محجوب عن كل الوكلاء (`HARD_DENY_TABLES`). تُقرأ في طبقة الخدمة عبر `disputePolicySnapshot(db, disputeId|null)` (بلا كتابة `country_policy_gaps`) وتُحقن في `input.__disputePolicy` بعد إسقاط قيمة الطالب — نفس نمط `__partnerConsent`.
- **عقد A2 للوكيل:** `disputes, dispute_messages, dispute_evidence, dispute_events, dispute_appeals, orders` + نطاق `COMMERCE`، قراءة فقط ومقيدة بـ`disputeId`. أي قراءة خارجها ترمي `AgentScopeError`.
- **قاعدة:** أي أثر مالي في المخرج يأتي من `rules.decisionEffects` في اللقطة؛ غيابه = `DECISION_REQUIRED` (مثل `SPLIT`)، ولا يُخترع.
- **الأدلة:** `tests/unit/dispute-summary.test.ts` (23) + `tests/ai-dispute-assistant.test.ts` (12، منها عزل نزاع A عن B ورفض CUSTOMER/SUPPORT قبل أي صف وعدم الكتابة).
- **AI-03 يبقى مفتوحًا:** الإنشاء التلقائي لمهمة عند فتح النزاع يحتاج مالكًا من نطاق المنصة (`agent_tasks.requested_by` غير قابل للـNULL) — قرار في AD-054.

## Landing page (public marketing surface)

- The homepage is the **dark navy premium** theme (`bg-ink-950`, i.e. `#050c24`). All other public routes keep the light/white header.
- Hero artwork is pure SVG in `components/brand/CorporateHero.tsx`, split by `part="map"` (dotted world map + trade network) and `part="skyline"` (illuminated city + water reflection). No external images, no network requests.
- `PublicHeader`/`PublicLayout` take a `dark`/`darkHeader` prop. The header is `sticky top-[var(--demo-banner-h,0px)]`, and `DemoBanner` publishes its measured height as `--demo-banner-h` so the two sticky bars never overlap.
- Design tokens live in `tailwind.config.js` (`ink-950`, `brand-*`) and `index.css` (`.lp-dark-section`, `.lp-dark-card`, `.lp-btn-ghost-dark`). Hero copy keys are `lp.hero.headline/subtitle/ctaPrimary/ctaSecondary` in all four locales.

## SEC-04B — حماية قراءة الكيانات (2026-11-05)

- **القاعدة:** مسارات `GET /api/{suppliers,merchants,companies}` و`/:id` **عامة** (`optionalAuth`) لكنها تُرجع **الإسقاط العام فقط** (`*_PUBLIC_FIELDS` في `modules/*/service.ts`) — لا `userId`/`isActive`/`createdAt`/`updatedAt` أبداً. لا تستخدم `db.select()` عارياً في مسار قراءة كيان.
- **البيانات الخاصة:** `contacts` (بريد/هاتف) و`taxId`/`registrationNumber` تُعاد فقط للمالك (`row.userId === viewer.userId`) أو الموظف. بوابة الموظف = `isEntityStaff()` في `src/lib/entity-access.ts` وتستند إلى الصلاحية **الموجودة** `user:read` (تملكها SUPPORT/RISK/DISPUTE/ADMIN/SUPER_ADMIN، ولا يملكها أي دور بائع — البائعون لديهم `user:read:own`). **لا تُنشئ صلاحية جديدة** لهذا.
- **غير النشط:** `/:id` تُعيد `404` للزوار وغير المالك (لا تكشف الوجود)؛ `200` للمالك/الموظف.
- **الدليل:** `listSupplierDirectory(db, query, { includeContacts })` — تُحجب `contactEmail/contactPhone` عن غير الموظف (تُختار ثم تُجرَّد قبل الإرسال).
- **اختبار:** `tests/sec04b-entity-read-access.test.ts` (9 حالات تكامل). تشغيلها يحتاج PostgreSQL — غير متوفّر في بيئة العمل الحالية (لا psql، لا daemon Docker).
- **التوثيق الكامل:** `docs/SEC-04B_ENTITY_READ_ACCESS.md`.

## PS-02 — Manual Payment Completion Desk (DEMO only, 2026-11-06)

- **السطح:** تبويب `manual` (testid `admin-fin-tab-manual`) داخل `/admin/finance` — **ليس** صفحة منفصلة. الكتابة تمرّ عبر `applyPaymentSucceeded` نفسه (`completeManualPayment` في `modules/payments/service.ts`)، لا كاتب جديد. المسارات: `POST/GET /api/admin/finance/manual-completions` + `GET /manual-payment-availability`، محروسة ADMIN/SUPER_ADMIN. `Paid ≠ Settled`: الدفتر يبقى `PENDING`، وAudit باسم `PAYMENT.MANUAL_COMPLETED`.
- **فخ اختبار E2E (مُعالَج):** إنشاء الـintent ينقل `orders.paymentStatus` من `UNPAID` إلى **`PENDING`** — لا تتوقّع `UNPAID` في الـspec بعد إنشاء intent. وزر الإتمام `admin-fin-manual-submit` **معطّل** حتى ينجح البحث (`!manualView?.eligible`)، فانقر `admin-fin-manual-lookup` **قبل** `admin-fin-manual-submit` وإلا علّق الاختبار (timeout) — بما فيه اختبار «المرجع الفارغ» (يرفضه الخادم 422).
- **التشغيل الحيّ:** PostgreSQL 16 معزول (`wasit_test` فقط) + `DEMO_PAYMENT_MODE=true` + مزوّد `manual`. حزمة الـDB تحتاج migrate+seed أولاً (`DATABASE_URL=.../wasit_test npx drizzle-kit migrate && npx tsx src/scripts/seed.ts`) ثم E2E بنفس `DATABASE_URL`. النتيجة المعتمدة: Backend 10/10 + بوّابات 4/4 + E2E 5/5 + تراجع PS-01 (16/16 و10/10) = 45/45.

## OBS-01 — Webhook Failures & Replay (2026-11-06)

- **السطح:** تبويب `webhooks` (testid `admin-obs-tab-webhooks`) داخل `/admin/observability` — صفحة محروسة أصلاً بـ`AdminOnly` (ADMIN/SUPER_ADMIN) وهو نفس نطاق `REFUND_MANAGE` الخلفي. الجدول يعرض `FAILED`/`DEAD_LETTERED` فقط، وزر إعادة التشغيل `admin-obs-webhook-replay-<id>` **مفعّل فقط لـ`DEAD_LETTERED`**.
- **إعادة التشغيل ≠ تحرّك مال:** `POST /api/payments/webhook-failures/:id/replay` يعيد الحدث إلى `RECEIVED` ويصفّر `attempts` فقط — لا `SETTLED`، لا `Payout`، ولا تطبيق فوري (ينتظر تسليم المزوّد التالي). الرسالة في الواجهة تقول ذلك صراحةً.
- **تدقيق بالهوية:** `AppContext` **بلا** حقل `actorId` — لا تمرّر `ctx` مباشرةً إلى `writeAudit` (يكتب `actorId=NULL`). مرّر `{ actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }`. (عيب متبقٍّ محتمل في مسارات أخرى مثل `admin/analytics-routes.ts` — لم يُمسّ.)
- **ترقيم آمن:** `offset` عبر `parseNonNegativeIntParam` (`lib/query.ts`) — `NaN`/`Infinity` يعودان إلى الافتراضي قبل SQL. القائمة تعيد `{ items, meta:{total,limit,offset} }` ولا تحمل `payload`/توقيع.
- **التشغيل الحيّ:** نفس وصفة PS-02 (PostgreSQL 16 معزول `wasit_test` + `DEMO_PAYMENT_MODE=true` + migrate/seed). النتيجة المعتمدة: Backend `p6-p7-dispute-webhook.test.ts` 19/19 + الحزمة الكاملة 887/887، E2E `admin-webhook-failures.spec.ts` 4/4 + الحزمة الكاملة 226 ناجحة / 8 متخطّاة (الإخفاقات الثمانية شرطية `DEMO_AUTO_LOGIN`).
- **التوثيق الكامل:** `docs/OBS-01_WEBHOOK_FAILURES_REPLAY.md` + `docs/GAP_REGISTER.md` §10.6.

## AI-01 — جدولة تنفيذ الوكلاء (2026-11-06)

- **ليست `setInterval` ينادي الوكلاء:** الجدولة صفوف دائمة في جدول `agent_schedules` (ترحيل `0027_melodic_lifeguard.sql`)، والتنفيذ يمرّ عبر `createAgentTask` نفسه — لا مسار تنفيذ موازٍ. الخدمة في `modules/ai/scheduling.ts`، والمؤقّت `runAgentSchedules` في `lib/scheduler.ts`.
- **تنفيذ واحد فقط عبر النسخ:** المطالبة استعلام `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` مع `lease_owner`/`lease_expires_at`. **لا تعتمد على قفل داخل العملية** (`agentRunInFlight` يمنع التداخل داخل النسخة فقط) — الأمان عبر النسخ من القاعدة. عند المطالبة يُقدَّم `next_run_at` فوراً (سياسة تفويت لا تراكم).
- **fail-closed للموافقة:** جدولة وكيل بـ`requiresHumanApproval` مرفوضة `409` (الجدولة ليست موافقة مسبقة)، ولو صار الوكيل مقيّداً لاحقاً يُتخطّى وقت التشغيل ويُدقّق `AI.AGENT_TASK_SKIPPED_APPROVAL_REQUIRED`. **لا تُنشئ صلاحية جديدة** — البوّابة `AI_MANAGE|ADMIN_AI` نفسها.
- **الميزانية قبل الإنشاء:** `isBudgetExhausted` (جديدة في `lib/ai/cost-control.ts`) تُرجع `429` قبل إنشاء المهمة وتُدقّق `AI.AGENT_TASK_BUDGET_EXCEEDED`.
- **هوية SYSTEM:** `audit_logs.actor_type` جديد (`USER` افتراضياً، `SYSTEM` للتنفيذ الآلي بلا `actorId` مزيف)؛ المهمة تبقى منسوبة لمنشئ الجدولة (`createdBy`/`requestedBy`) للمساءلة. `AuditContext` صار يقبل `actorType`.
- **env:** `AI_AGENT_SCHEDULER_ENABLED=false` (مُطفأ افتراضياً) + `AI_AGENT_SCHEDULER_INTERVAL_MINUTES=5` + `AI_AGENT_SCHEDULE_MIN_INTERVAL_MINUTES=15` + `AI_AGENT_SCHEDULE_LEASE_SECONDS=300`. الوكلاء الجدوليّون: غير مقيّدين فقط (مثل `marketing-agent`, `product-agent`, `support-agent`, `analytics-agent`, `market-research-agent`).
- **الاختبار:** `tests/ai01-agent-scheduling.test.ts` **12/12** + الحزمة الكاملة **899/899**. التشغيل يحتاج PostgreSQL (استُخدم PostgreSQL 16 معزول) — الحزمة الكاملة تُسقط/تُنشئ `wasit_test` عبر `tests/setup.ts`.
- **التوثيق الكامل:** `docs/AI-01_AGENT_SCHEDULING.md` + `docs/GAP_REGISTER.md` §3/§6.

## AI-02.P0 — حاسمو ما قبل Supervisor (2026-11-06)

- **حسم `actorType`:** لا تضارب — سجل `AI.AGENT_TASK_SCHEDULED` يُكتب بـ`actorType='SYSTEM'` و`actorId=null`، مع `metadata.createdBy` (منشئ الجدولة) و`metadata.scheduleId`. الفصل الثلاثي (منشئ/منفّذ/هوية النظام) محفوظ. **لا تغيير كود.**
- **منع الموافقة الذاتية (Backend):** حارس في `decideAgentTask` (`modules/ai/agents.ts`): الطالب لا يعتمد طلبه (`403 FORBIDDEN`)، ويشمل ذلك `SUPER_ADMIN`. الحارس في الخدمة (لا الواجهة) فيرثه أي سطح موافقة. سحب الطالب لطلبه (`REJECT`) يبقى مسموحًا.
- **جرد الوكلاء:** 11 وكيلًا في `AGENT_CATALOGUE` → `agent_registry` (مصدر تسجيل وحيد)، ولكل وكيل منفّذ حقيقي في `executors.ts` (11 حالة `switch`). لا وكيل «تعريف بلا تنفيذ». لم يُغيَّر الترتيب ولم يُنشأ وكيل جديد.
- **الاختبار:** `tests/ai02p0-approval-guard.test.ts` **5/5** (سلبي: اعتماد ذاتي 403 لـADMIN وSUPER_ADMIN، ومهمة مرفوضة لا تُنفَّذ؛ إيجابي: مُعتمِد آخر، وسحب الطالب). إصلاح مساعد `runAndComplete` في `phase14-agents.test.ts` ليستخدم معتمِدًا مختلفًا. الحزمة الكاملة **904/904** (78 ملفاً)؛ Typecheck نظيف.
- **التوثيق الكامل:** `docs/AI-02P0_PRE_SUPERVISOR_BLOCKERS.md`.

## AI-02.1 — Agent Runs & State Machine (2026-11-06)

- **نموذج البيانات:** `db/schema/agent_runs.ts` يعرّف `agent_runs` (تشغيل واحد بهدف: `run_key` فريد للـidempotency، `title`/`description`، `status`، `requested_by`، `summary`/`error`/`metadata`، طوابع زمنية) و`agent_run_steps` (خطوة: `step_key`، `agent_key`، `status`، `input`/`result`/`error`، `priority`، `attempt_count`/`max_attempts`، `depends_on`، `requires_approval`/`approved_by`).
- **العلاقات والقيود:** FK `run_id` → `agent_runs.id` مع `ON DELETE CASCADE` (أول FK صريح في المستودع)؛ فهرس فريد `(run_id, step_key)`؛ CHECKs: `priority>=0`، `attempt_count>=0 AND max_attempts>=1 AND attempt_count<=max_attempts`، `jsonb_typeof(depends_on)='array'`. الترحيل: `0028_keen_gunslinger.sql` (مولّد بـ`drizzle-kit generate`).
- **آلة الحالات:** `modules/ai/run-state-machine.ts` (منطق صرف): 11 حالة تشغيل و10 حالات خطوة، جدولا انتقالات، و`assertRunTransition`/`assertStepTransition` (ترمي `409` على انتقال غير قانوني/`from===to`/إحياء حالة نهائية)، و`assertStepSuccess` (لا `SUCCEEDED` بلا `result`)، و`assertRunCompletion` (لا إكمال وخطوات غير منتهية، و`COMPLETED` تتطلب نجاح كل الخطوات وإلا `PARTIALLY_COMPLETED`)، و`assertValidDependencies` (تبعية غير معروفة/ذاتية/دائرية عبر خوارزمية Kahn). الإحياء يحتاج `allowReopen` صريحًا.
- **حدود المرحلة:** لا `planRun`/`dispatchStep`/Tool Gateway/إعادة محاولة/Kill Switch/واجهة Supervisor/تغيير ترتيب الوكلاء — كلها مراحل لاحقة.
- **الاختبار:** `tests/ai021-agent-runs.test.ts` **31/31** (persistence + انتقالات قانونية/غير قانونية + إحياء نهائي + إكمال + تبعيات + عدم التأثير على `agent_tasks`/`agent_schedules`)؛ الحزمة الكاملة **935/935** (79 ملفاً)؛ Typecheck نظيف.
- **التوثيق الكامل:** `docs/AI-02.1_AGENT_RUNS_STATE_MACHINE.md`.

## AI-02.2 — Planning & Dependency Resolution (2026-11-06)

- **الخدمة:** `modules/ai/planner.ts` — `planAgentRun(db, requesterId, input, audit)` تحوّل هدفاً + خطوات مقترحة إلى خطة محفوظة: صف `agent_runs` بحالة `PLANNING` + صفوف `agent_run_steps` بحالة `PENDING`. لا تفهم الأهداف عبر LLM؛ المتصل يزوّد الخطوات.
- **التحقق (`validatePlan`):** وكيل مسجّل ونشط في `agent_registry`، `stepKey` فريد غير فارغ، `input` كائن، `priority` صحيح، تبعيات صحيحة (عبر `assertValidDependencies` من AI-02.1)، حدود (25 خطوة، 16KB)، وصلاحيات الطالب (RBAC؛ `ADMIN`/`SUPER_ADMIN` يمرّان كما في `createAgentTask`).
- **الترتيب (`topologicalOrder`):** حتمي — الأعلى أولوية أولاً، والتساوي يُفصل بـ`stepKey`؛ الأولوية لا تتجاوز التبعية؛ الدورة تُرفض (`CYCLE`). `executionOrder` يُشتق عند القراءة لا يُخزَّن (لا عمود جديد).
- **الحفظ:** ذرّي داخل `db.transaction`؛ `runKey` فريد (idempotency → `409`). الميزانية تُفحص مسبقاً (`isBudgetExhausted` → `429`).
- **حدود صارمة:** لا تنفيذ، لا Executor، لا `createAgentTask`، لا `dispatchStep`، لا `DISPATCHING`/`RUNNING`. الإنشاء ليس موافقة؛ الخطوة الحساسة `requiresApproval=true` وتبقى `PENDING`. حماية AI-02.P0 (منع الموافقة الذاتية) لم تُلمس.
- **الاختبار:** `tests/ai022-planning.test.ts` **28/28** (الخطة الصحيحة، الربط بالوكلاء، الترتيب، رفض وكيل/مكرّر/تبعية غير موجودة/ذاتية/دائرية/مدخلات/حدود، الصلاحيات والموافقة، عدم تشغيل Executor، عدم الانتقال لـ`DISPATCHING`/`RUNNING`، إعادة قراءة الخطة، سلامة AI-02.P0)؛ الحزمة الكاملة **963/963** (80 ملفاً)؛ Typecheck نظيف.
- **التوثيق الكامل:** `docs/AI-02.2_PLANNING_DEPENDENCY_RESOLUTION.md`.

## AI-02.3 — Dispatch & Controlled Execution (2026-11-06)

- **الخدمة:** `modules/ai/dispatcher.ts` — `dispatchStep(db, runId, stepKey, audit)` تُرسل خطوة صالحة إلى نظام المهام الحالي عبر `createAgentTask`/`decideAgentTask`، وتسجّل النتيجة على الخطوة والخطة. **لا Executor مباشر، ولا نظام مهام موازٍ.**
- **الربط (بلا Migration):** `__runId`/`__stepId` داخل `agent_tasks.input` (jsonb) — متسق مع اصطلاح `__userId`؛ `taskId` يُخزَّن أيضاً في `agent_run_steps.result`/`error`. لا عمود/جدول جديد.
- **التحقق قبل الإرسال:** الخطة في حالة قابلة للإرسال، الخطوة غير نهائية/غير `RUNNING`، كل التبعيات `SUCCEEDED`، الوكيل مسجّل ونشط، صلاحيات الطالب تغطي `permissionsRequired`، الخطوة الحساسة معتمدة من موافق مخوّل، والميزانية غير مستنفدة.
- **منع التكرار والتزامن:** مطالبة ذرّية `UPDATE ... WHERE status IN ('PENDING','READY') RETURNING` (فائز واحد) + فحص مهمة قائمة بنفس `__stepId` + رفض الحالات النهائية/`RUNNING`. انقطاع الاستجابة لا يُفسَّر كعدم إنشاء؛ يُعاد قراءة الحالة الفعلية ولا تُنشأ مهمة بديلة.
- **التبعيات/الفشل:** لا إرسال قبل نجاح كل التبعيات؛ عند فشل خطوة تُعلَّم التابعة `SKIPPED` بشكل متعدٍّ؛ `SKIPPED` ليست نجاحاً. **لا Retry** (الفشل → `FAILED` مسجّلة).
- **الموافقات:** `approveRunStep` (موافق ≠ طالب التشغيل، AI-02.P0 + صلاحية `ai:manage`/ADMIN) ثم جسر عبر Approval Engine؛ لا مسار متجاوز.
- **الإكمال:** `reconcileRun` يغلق الخطة `COMPLETED`/`PARTIALLY_COMPLETED`/`FAILED` عبر `assertRunTransition`/`assertRunCompletion`؛ `cancelRun` يمنع أي إرسال جديد. لا توسيع صلاحيات، ولا مالية/خارجية حقيقية.
- **الاختبار:** `tests/ai023-dispatch.test.ts` **21/21**؛ مجموعة AI **125/125**؛ الحزمة الكاملة **984/984** (81 ملفاً)؛ Typecheck نظيف.
- **التوثيق الكامل:** `docs/AI-02.3_CONTROLLED_EXECUTION.md`.

## AI-02.3.1 — Execution Reliability & Recovery (2026-11-06)

- **المزامنة:** `syncStepFromTask(db, stepId, audit)` تقارن خطوة `RUNNING` بمهمتها المرتبطة (`input.__stepId`): `succeeded`/`approved` بشرط وجود نتيجة → `SUCCEEDED`؛ `failed`/`rejected` → `FAILED`؛ `queued`/`running`/`awaiting_approval`/مجهول → **لا إجراء** (لا إعادة إرسال، لا نتيجة مخترعة). idempotent: لا كتابة/تدقيق إلا عند تغيّر فعلي.
- **الاستعادة:** `recoverStuckSteps(db, {stuckSeconds, leaseSeconds}, audit)` تجد الخطوات العالقة `RUNNING` (بعد المهلة)، تطالب بها **ذرّياً** (`UPDATE ... WHERE status='RUNNING' AND updated_at < now()-lease RETURNING` — فائز واحد)، تُزامنها، ثم `reconcileRun`. خطوة بلا مهمة → `FAILED` (**لا إنشاء مهمة بديلة**). `recoverRun(db, runId, audit)` تُزامن كل خطوات `RUNNING` في خطة ثم تُغلقها.
- **نقطة التشغيل:** إعادة استخدام المُجدول الداخلي `lib/scheduler.ts` — وظيفة `runAgentRunRecovery` تُوصَل في `index.ts`؛ **مُطفأة افتراضياً** (`AI_AGENT_RUNS_RECOVERY_ENABLED=false`). لا Worker/طابور جديد.
- **المهل والإعداد:** `AI_AGENT_RUN_STEP_STUCK_SECONDS` (افتراضي 300) · `AI_AGENT_RUNS_RECOVERY_INTERVAL_MINUTES` (افتراضي 5) — لا قيمة سحرية. **ملاحظة (AI-02.3.2):** أُزيل `AI_AGENT_RUNS_AUTO_DISPATCH_ENABLED` لأنه إعداد ميّت (لم يُقرأ في أي مسار)؛ لا Auto Dispatch معتمداً ضمن النطاق — الإرسال دائماً إجراء صريح مخوّل.
- **الذرّية (بلا Migration):** المطالبة الذرّية `UPDATE ... WHERE status IN ('PENDING','READY') RETURNING` تبقى الكاتب الوحيد؛ نافذة الانقطاع بين المطالبة وإنشاء المهمة تُعالَج بالاستعادة الـidempotent (لأن `createAgentTask` ينفّذ متزامناً ولا يُدمج في معاملة المطالبة). **لا عمود/جدول/ترحيل جديد.**
- **السياسة:** لا Retry في هذه المرحلة؛ `maxAttempts` مفروض في `dispatchStep` (المحاولات المستنفدة تُرفض)؛ `FAILED` تُسجَّل ولا تتحوّل نجاحاً؛ `SKIPPED` ليست نجاحاً؛ `reconcileRun` يمرّ عبر الحالات القانونية (حتى عند إغلاق خطة ما زالت `PLANNING`).
- **الصلاحيات:** لا مساس بـAI-02.P0؛ Recovery/Dispatcher لا يوافقان ولا ينتحلان هوية موافق؛ لا توسيع صلاحيات أي وكيل.
- **المسارات الإدارية:** `GET/POST /api/admin/ai/agent-runs/...` (inspect/dispatch/approve/cancel/recover) خلف `AI_MANAGE`/`ADMIN_AI`.
- **الاختبار:** `tests/ai0231-reliability.test.ts` **23/23**؛ الحزمة الكاملة **1007/1007** (82 ملفاً)؛ Typecheck نظيف (server+web).
- **التوثيق الكامل:** `docs/AI-02.3.1_EXECUTION_RELIABILITY_RECOVERY.md`.

## AI-02.3.2 — Fencing, Concurrency & Recovery Safety (2026-11-06) — **CLOSED**

- **الـFencing token:** كل مطالبة Dispatch تزيد `attempt_count` ذرّياً وتستلم القيمة الجديدة كـ**token**؛ كل كتابة لاحقة تحمل `WHERE id=? AND status='RUNNING' AND attempt_count=<token>`. فتكتب قديمة بعد قرار Recovery أحدث = **no-op** (يُسجَّل `AI.AGENT_RUN_STEP_WRITE_REJECTED`). لا عمود/ترحيل جديد.
- **حماية خدمة `createAgentTask`:** معامل اختياري `fencing {runId, stepId, claimToken}` — فحص الملكية (تجديد الإيجار) **وإدراج المهمة في معاملة واحدة**؛ 0 صفوف → رفض (لا مهمة). **ترتيب القفل مقصود**: يُنفَّذ `UPDATE` الملكية **قبل** فحص التكرار ليعمل كقفل صف؛ هذا يمنع مهمتين نشطتين للخطوة نفسها تحت `READ COMMITTED` (فحص-then-إدراج غير ذرّي كان يسمح بهما — أُثبت باختبار تزامن حقيقي). **لا يوسّع صلاحيات** (الوكيل الحساس يبقى `awaiting_approval`).
- **`fencedStepWrite`:** الكتابة الذرّية المُصدَّرة التي تحمل شرط الملكية — كل نتائج `dispatchStep` تمرّ عبرها.
- **حارس داخل العملية:** `createInFlightGuard()` في `lib/scheduler.ts` — يمنع تداخل دورتَي Recovery، ويُحرَّر في `finally` (لا يعلق بعد استثناء). ليس بديلاً عن الإيجار في قاعدة البيانات.
- **سجل كل دورة Recovery:** `correlationId` + `status` (SUCCESS/PARTIAL/FAILED) + `scanned/recovered/skippedLease/lostRace/reconciledRuns/errors/durationMs` — تُسجَّل حتى الدورة الفارغة. لا بيانات حساسة. فشل خطوة واحدة يُعزل (`AI.AGENT_RUN_STEP_RECOVERY_FAILED`) ولا يُسقط الدورة.
- **دقّة إغلاق Recovery (تصحيح التدقيق النهائي):** إغلاق الخطوة مشروط بفحص الصفوف المتأثرة (`settleRunningStep` = `UPDATE … WHERE id=? AND status='RUNNING' RETURNING id`). صفر صفوف = `lost_race` ⇒ **لا** يُزاد `recovered`، **لا** يُسجَّل Audit نجاح (`AI.AGENT_RUN_STEP_SYNCED`/`AI.AGENT_RUN_STEP_RECOVERED`)، ويُسجَّل بدلاً منه `AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE` مع `observedStatus`، ويُزاد `lostRace` في الدورة؛ ولا يُستدعى `reconcileRun` لخطوة خسرت السباق. **بلا تغيير Fencing/`attempt_count`/Retry/الصلاحيات.**
- **AUTO_DISPATCH:** أُزيل (إعداد ميّت)؛ لا Auto Dispatch ضمن النطاق.
- **الاختبار:** `tests/ai0232-fencing.test.ts` **30/30** (منها تزامن حقيقي عبر seam `dispatchStep(..., {onClaimed})`) + `tests/ai0232-concurrency.test.ts` **14/14** (تزامن حقيقي **متعدد الاتصالات**: حوضَا `pg.Pool` منفصلان = اتصالان/جلستان مستقلان بقاعدة PostgreSQL، دون مشاركة الاتصال أو المعاملة، `Promise.all` على أقفال الصفوف؛ + 4 اختبارات دقّة تدقيق الاستعادة عبر seam `SyncHooks.beforeSettle` غير مُمرَّر في الإنتاج)؛ الحزمة الكاملة **1051/1051** (84 ملفاً)؛ Typecheck نظيف (server+web).
- **التوثيق الكامل:** `docs/AI-02.3.2_FENCING_CONCURRENCY_RECOVERY_SAFETY.md`.
- **قيد صريح محفوظ:** تم اختبار التزامن عبر **اتصالين/جلستين مستقلتين بقاعدة PostgreSQL**، ولم يُختبر بعد تشغيل **عمليتَي Node Server مستقلتين فعلياً**.
- **الحالة:** AI-02.3.2 **CLOSED**؛ AI-02 كاملة تبقى `IN_PROGRESS` (Supervisor/LLM planner/Tool Gateway/Retry مؤجّلة).

## AI-02.S1 — Agent Supervisor + Retry Policy (2026-11-16) — **COMPLETED (شريحة فرعية)**

- **المهمة:** الشريحة الأولى المحدودة من AI-02: طبقة Supervisor تقرأ التشغيلات وتتّخذ تدخّلات محدودة + سياسة إعادة محاولة مركزية. **بلا مزوّد خارجي · بلا Migration · بلا Seed · بلا تغيير مخطط أو آلة حالات.**
- **الخدمة:** `packages/server/src/modules/ai/supervisor.ts` (جديد) — `runSupervisorCycle` (دورة محدودة) · `containRun` (حجب) · `retryStep` (إعادة محاولة) · `buildSupervisorOverview` (قراءة) · `createSupervisorCycleGuard`.
- **السياسة:** `modules/ai/retry-policy.ts` (جديد، صرف) — `decideRetry` fail-closed. تُغذّي `supervisor-policy.ts` القائمة بصفوف حقيقية (أول مستهلك إنتاجي لها).
- **ما يراقبه:** تشغيلات نشطة/متعثّرة (stuck/stale)/حلقات/تجاوز الميزانية + خطوات فاشلة/منتظرة لإعادة المحاولة.
- **الحجب:** يُغلق التشغيل `FAILED` عبر آلة الحالات ويُلغي خطواته غير المنتهية (قفل صف التشغيل ⇒ idempotent عبر العمليات) — **لا يُغلق `COMPLETED` أبداً**؛ الإغلاق الناجح حصراً عبر `reconcileRun`.
- **إعادة المحاولة:** خطوة `FAILED` فقط (`FAILED → RETRYING → RUNNING` عبر `dispatchStep`)، ضمن سقف `DEFAULT_SUPERVISOR_LIMITS.maxAttempts=3`، مع تبعيات `SUCCEEDED` وميزانية متاحة وتشغيل مفتوح. تُرفع `max_attempts` في الصف (بلا Migration) وفكّ ربط المهمة الفاشلة (`__stepId`) لإتاحة مهمة جديدة. لا حلقة لانهائية.
- **السطح الإداري:** `GET /api/admin/ai/supervisor/overview` + `POST /api/admin/ai/supervisor/runs/:runId/contain`، محروسان بـ`AI_MANAGE|ADMIN_AI` (لا صلاحية جديدة)؛ CUSTOMER/MERCHANT/SUPPLIER مرفوضون (403).
- **التزامن:** الحكم قاعدة البيانات (قفل صف التشغيل + كتابات شرطية + مطالبة `dispatchStep` الذرّية)؛ `createSupervisorCycleGuard()` يمنع التداخل داخل العملية فقط. **دورة دورية اختيارية** في `lib/scheduler.ts` **مُطفأة افتراضياً** (`AI_AGENT_RUNS_SUPERVISOR_ENABLED=false`).
- **التدقيق:** `AI.AGENT_RUN_CONTAINED` · `AI.AGENT_RUN_STEP_RETRY_SCHEDULED` · `AI.AGENT_RUN_STEP_RETRY_FAILED` · `AI.AGENT_RUN_SUPERVISOR_FAILED` (هوية `SYSTEM`).
- **الاختبار:** `tests/unit/retry-policy.test.ts` **10/10** + `tests/ai024-supervisor.test.ts` **17/17** + `tests/ai024-supervisor-routes.test.ts` **7/7** + تراجع AI-02 **158/158** + الحزمة الكاملة **1670/1671** (الفشل الوحيد `sec04b` سابق/متقطّع، يمرّ معزولاً)؛ Typecheck (server+web) نظيف.
- **مؤجّل صراحةً:** LLM Planner · Tool Gateway · Kill Switch · Circuit Breaker/Backoff المتقدّم · واجهة ويب Supervisor · AI-03/AI-04/AI-05.
- **التوثيق الكامل:** `docs/AI-02.S1_SUPERVISOR_RETRY.md` (+ `docs/AI_ARCHITECTURE.md` §AI-02.S1، `docs/GAP_REGISTER.md` §23).
- **الحالة:** AI-02.S1 **COMPLETED**؛ **AI-02 تبقى `IN_PROGRESS`** (المكوّنات المؤجّلة أعلاه).

## WASIT-EXECUTION-AI02S1-CLOSE — إغلاق AI-02.S1 + تدقيق `sec04b` المتقطّع (2026-11-16)

- **النوع:** إغلاق إداري لشريحة + تحقيق READ-ONLY في اختبار متقطّع. **بلا تعديل اختبار أو منطق تطبيق، بلا Migration، بلا Seed، بلا كتابة على DEMO/إنتاج، بلا Git مُغيِّر.**
- **إغلاق AI-02.S1:** `AI-02.S1 = COMPLETED` بعد التحقق من تحقّق كل شروط القبول — اختبارات جديدة **34/34** (`unit/retry-policy` 10 + `ai024-supervisor` 17 + `ai024-supervisor-routes` 7) + تراجع AI-02 **158/158** + `tsc` (server+web) نظيف + توثيق كامل. **AI-02 تبقى `IN_PROGRESS`** (LLM Planner · Tool Gateway · Kill Switch · واجهة Supervisor الكاملة). **لا ادّعاء جاهزية إنتاجية.**
- **`sec04b` المتقطّع — السبب الجذري مُثبت:** **مشاركة بيانات/قاعدة الاختبار + ترتيب الاختبارات**. اختبار `SEC-04B E` يطلب `GET /api/directory/suppliers?pageSize=100` (دليل **عالمي** مرتَّب بـ`companyName`، سقف 100) ويتوقّع صفّه في الصفحة الأولى؛ لكن **26 ملف اختبار** يُنشئ موردين بلا تنظيف على قاعدة `wasit_test` **مشتركة** ⇒ **397 مورداً نشطاً**، منها **352** تُسبق `S4` أبجدياً، فصفوفه تسقط في المواضع **#354–#359** (خارج الصفحة) ⇒ `find` = `undefined`. **ينجح منفرداً** لغياب التراكم.
- **مستقلّ عن AI-02.S1:** يُعاد إنتاجه مع **استبعاد ملفات AI-02.S1 الثلاثة** (`1 failed | 127 passed`)؛ ومسار `directory`/`suppliers` لا يستورد أي وحدة من AI-02.S1. **ليس سباقاً زمنياً ولا تنظيفاً ناقصاً.**
- **أصغر إصلاح مقترح (لم يُطبَّق):** في الاختبار فقط، استخدام `?q=<companyName>` بدل الاعتماد على الصفحة الأولى (يقلّ العائد إلى 6 صفوف) — **لا يمسّ كود الإنتاج** (الدليل العام المرتَّب سلوك مقصود).
- **التوثيق الكامل:** `docs/GAP_REGISTER.md` §24 + §23 + `docs/WASIT_EXECUTION_REGISTER.md` §8 (1.2).

## WASIT-EXECUTION-SEC04B-FIX — إصلاح `sec04b` + تحقق شامل (2026-11-17)

- **النوع:** إصلاح اختبار فقط (test-only) بأصغر تعديل. **بلا تعديل كود إنتاج، بلا Migration، بلا Seed، بلا تغيير مخطط، بلا Git مُغيِّر.**
- **التغيير الدقيق** (`packages/server/tests/sec04b-entity-read-access.test.ts` — كتلة `SEC-04B E` فقط): قراءة `companyName` للمورّد بالمعرّف من DB، ثم `GET /api/directory/suppliers?q=<companyName>&pageSize=100` بدل الاعتماد على الصفحة الأولى؛ **نفس** `find` بالمعرّف و**نفس** تأكيدات الصلاحيات/حجب PII.
- **لماذا صحيح:** المرشّح `q` يُطبَّق على العدّ والقائمة معاً (`ilike(companyName,'%q%')`) والاسم فريد ⇒ العائد 6 صفوف ⇒ الصف داخل الصفحة. **لا يمسّ API ولا كود الإنتاج.**
- **النتائج (PostgreSQL 16 معزولة `wasit_test`@5434):** `sec04b` منفرداً **12/12** · ×3 **12/12** · مجموعة الأمان (`sec04b`+`security-privacy`) **31/31** · **الحزمة الكاملة 131 ملفاً / 1671 اختباراً = كلها ناجحة** · `tsc` (server+web) **0 أخطاء**.
- **إزالة السبب فعلياً:** أثناء النجاح كان شرط الفشل قائماً (**397** مورداً نشطاً، **352** تُسبق `S4`) ⇒ لولا الإصلاح لكان الفشل حتمياً. **لا فشل متبقٍ.**
- **التوثيق:** `docs/GAP_REGISTER.md` §24.7 + `docs/WASIT_EXECUTION_REGISTER.md` §8 (1.3).

## LC-01 — إطار قانوني ومسوّدات (WASIT-EXECUTION-010، 2026-11-07)

- **الحالة:** الجاهزية التقنية **COMPLETE_VERIFIED**؛ الفجوة **تبقى مفتوحة** (`BLOCKED` على الاعتماد الخارجي). لا تُنشر أي وثيقة ولا يُقبل أي إقرار حتى تُنقل صراحةً إلى `PUBLISHED`.
- **الكتالوج:** `packages/server/src/lib/legal/catalogue.ts` — 9 وثائق (ToS, Privacy, Cookie, Refund/Dispute, Buyer, Seller/Merchant, Supplier, DPA, Prohibited Goods)، كلها `LEGAL_REVIEW_REQUIRED` بـ`effectiveDate=null`. النشر فعل كود مُراجَع، لا مفتاح وقت تشغيل.
- **الأسطح:** عام `GET /api/public/legal/documents[/:code]` (المنشور فقط؛ غير المنشور ⇒ 404) · مُصادَق `GET /api/legal/acceptances/me` و`POST /api/legal/acceptances` (قبول **إصدار محدّد**؛ غير المنشور/غير الساري ⇒ 409) · **حق التصحيح** `PATCH /api/privacy/me` (قائمة بيضاء: firstName/lastName/phone/locale/displayName؛ البريد/التحقّق غير قابلين للتعديل؛ التدقيق يسجّل أسماء الحقول فقط).
- **الموافقة:** `recordLegalAcceptance`/`getPendingLegalAcceptances` تقبل `catalogue?` اختيارياً (الافتراضي الإنتاجي بلا تغيير). رفع إصدار وثيقة ⇒ إعادة قبول (`needsReacceptance`). تُخزَّن في `consents`/`consent_events` (نوع `LEGAL_DOCUMENT`) + `audit_logs`. **بلا Migration.**
- **الويب:** `packages/web/src/pages/LegalPage.tsx` + مسار `/legal` في `App.tsx` + رابط التذييل + مفاتيح i18n (ar/en/fr/zh). السطح فارغ عمداً حتى النشر.
- **المسوّدات:** `docs/legal/00..10` (مسوّدات غير سارية للمراجعة). السياق التونسي: `docs/legal/10-tunisia-legal-context.md`. الوثيقة الكاملة: `docs/LC-01_LEGAL_FRAMEWORK.md`.
- **الاختبار:** `packages/server/tests/lc01-legal-framework.test.ts` **18/18** · الحزمة الكاملة **1267/1267** (107 ملف) · الويب **35/35** · Typecheck (server+web) نظيف.
- **العدّ:** بلا تغيير في ذلك الوقت (المفتوحة 18 / المغلقة 30) — جوهر الفجوة (النصّ المعتمد) اعتماد خارجي لا يُخترع. **(صُحّح العدّاد الموحّد لاحقاً إلى المفتوحة 21 / المغلقة 32 — WASIT-EXECUTION-012.1.)**

## LC-01.1 — بنية الموافقة القانونية + بوابة إلزامية (WASIT-EXECUTION-010.1، 2026-11-07)

- **الحالة:** بنية الموافقة **COMPLETE_VERIFIED**؛ الفجوة (LC-01) **تبقى مفتوحة** (`BLOCKED` على النصّ المعتمد). البوّابة **مطفأة افتراضياً** ولا تُفرض أي موافقة على مسودّة غير معتمدة.
- **بوابة إلزامية مطفأة:** `packages/server/src/modules/legal/enforcement.ts` → `requireLegalAcceptance()` مثبّتة على كل `/api` في `app.ts` (بعد CSRF). تُحجب فقط عند تحقّق **ثلاثة** شروط معاً: `LEGAL_ACCEPTANCE_ENFORCEMENT=on` + وجود وثيقة **منشورة وسارية** (`isAcceptable`) + عدم قبول المستخدم الإصدار الساري ⇒ `403 LEGAL_ACCEPTANCE_REQUIRED`. **معفاة:** `/api/auth`, `/api/health`, `/api/legal/*`, `/api/public/legal/*`.
- **العلم:** `LEGAL_ACCEPTANCE_ENFORCEMENT` (`off` افتراضياً / `on`) في `lib/env.ts` + `legalAcceptanceEnforced()`. **مستقل عن `NODE_ENV`**: التفعيل فعل مُراجَع صريح (مفتاحان: نشر الوثيقة + تفعيل العلم). `on` مقابل المسودات = no-op.
- **السجل والأمان:** `GET /api/legal/acceptances/history` (سجل المتصل فقط، الأحدث أولاً؛ لا ip/ua في الاستجابة) + `listLegalAcceptances`. مخطط القبول `.strict()` يرفض أي حقل هوية مُنتحَل (422) — لا قبول نيابةً عن الغير. الهوية من الجلسة حصراً.
- **الويب:** `packages/web/src/pages/LegalAcceptancePage.tsx` + مسار `/dashboard/legal` + رابط الشريط الجانبي + مفاتيح i18n (ar/en/fr/zh) + طرق API في `lib/api.ts` والأنواع في `lib/types.ts`.
- **التوثيق:** `docs/LC-01.1_LEGAL_CONSENT_INFRASTRUCTURE.md` (البنية والتفعيل) · `docs/LC-01_LEGAL_INFO_REQUIRED.md` (قائمة معلومات الكيان/المحامي، لا قيم مخترعة).
- **الاختبار:** `tests/lc011-legal-consent-gate.test.ts` **14/14** (منطق القرار النقي + ترتيب التثبيت الحقيقي + الحجب 403) + `tests/lc01-legal-framework.test.ts` **27/27** (تكامل HTTP+DB: السجل/الإصدار/العزلة/رفض التزوير/عدم الحجب/الفصل عن Cookies) · الحزمة الكاملة **1290/1290** (108 ملف) · الويب **35/35** · Typecheck (server+web) نظيف · بناء الويب ✅. **بلا Migration.**
- **العدّ:** بلا تغيير في ذلك الوقت (المفتوحة 18 / المغلقة 30) — جوهر الفجوة اعتماد خارجي. **(صُحّح العدّاد الموحّد لاحقاً إلى المفتوحة 21 / المغلقة 32 — WASIT-EXECUTION-012.1.)**

## WASIT-EXECUTION-012.1 — تصحيح اتساق توثيقي (2026-11-08) — **DOC-ONLY**

- **النطاق:** توثيق فقط (`docs/**` + `AGENTS.md`). لا كود/اختبارات/Schema، لا Migration/Seed/DEMO/إنتاج، لا stage/commit/push.
- **العدّ الصحيح الموحّد:** **المفتوحة = 21** · **المغلقة = 32** (كان 18/30). سبب الفارق: `SEC-011.4` أُغلق في §12 دون تحديث العدّاد؛ `SEC-XFF-01` كان يُحتسب خطأً «مفتوحاً»؛ `SEC-03` كان غائباً من §6؛ و§6 يحوي 31 معرّفاً مميّزاً (14 منها غير موجودة في §2–§5).
- **فصل `LC-08` عن `SEC-XFF-01`:** `LC-08` = فجوة **وثائق امتثال DPA/PCI** (من `MASTER_GAP_AUDIT.md`)، **تبقى مفتوحة/غير مُغلقة** (لا دليل خاص بها). الوسم الخاطئ `(LC-08)` أُزيل من `SEC-XFF-01` (وفي `03-ENVIRONMENT-REFERENCE.md` و§12). إغلاق `SEC-XFF-01` لا يُنسب إلى `LC-08`.
- **TLS:** `deploy/nginx.conf` **لا ينهي TLS** (`listen 80;` فقط)؛ صُحّح الادّعاء في `COMMERCIAL-RELEASE-MANIFEST.md` §6 و`04-DEPLOYMENT-GUIDE.md` §0/§5.
- **الوثائق القانونية:** `docs/legal/` = **11 ملفاً** = **9 مستندات سياسات** (`01`…`09`) + `00-README.md` (فهرس) + `10-tunisia-legal-context.md` (سياق، ليس سياسة). المصدر الموثوق `lib/legal/catalogue.ts` (9).
- **ملفات مُعدَّلة:** `docs/GAP_REGISTER.md` · `docs/MASTER_GAP_AUDIT.md` · `docs/LC-01_LEGAL_FRAMEWORK.md` · `docs/legal/00-README.md` · `docs/commercial-release/{COMMERCIAL-RELEASE-MANIFEST,03-ENVIRONMENT-REFERENCE,04-DEPLOYMENT-GUIDE}.md` · `AGENTS.md`.
- **بوابة السلامة:** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — **بلا تغيير**. modified 97 → 98 (ملف توثيقي واحد كان نظيفاً)، untracked 122 ثابت.

## WASIT-EXECUTION-013.0 — تصليب أمان النسخ الاحتياطي/الاستعادة (2026-11-09)

- **النطاق:** `scripts/{lib/common.sh,backup-db.sh,restore-db.sh,backup-restore.test.sh}` + توثيق (`docs/DEPLOYMENT.md`, `docs/commercial-release/08-OPERATIONS-RUNBOOK.md`). لا stage/commit/push.
- **العيوب المُصلَحة:**
  - **تحقق سلامة اختياري → إلزامي:** `restore-db.sh` كان يتخطّى التحقق عند غياب `checksums.sha256` (تحذير فقط). الآن **غيابه/فراغه/عدم تطابق أي مدخل = رفض تام**. أُضيف منع خروج المدخلات عن مجلد النسخة (`../`, مسار مطلق) ومنع **الروابط الرمزية** (symlink escape).
  - **حقن اسم قاعدة الهدف:** `EXISTS` كان يبني SQL نصياً بـ`'$TARGET_DB'`، و`DROP/CREATE DATABASE` بـ`\"$TARGET_DB\"`. الآن: تحقق صارم للاسم (`^[a-z][a-z0-9_]*$`, ≤63) ⇒ **الرفض لا الهروب**، و`EXISTS` عبر متغيّر psql `:'target'` **عبر stdin** (ملاحظة: `psql -c` لا يوسّع `:'var'` — عبر stdin فقط)، و`DROP/CREATE` عبر `wasit_sql_ident` (مضاعفة `"`).
  - **حماية DEMO/إنتاج/نظام:** قائمة محميّة (`wasit_prod`, `wasit_staging`, `wasit_demo`, `postgres`, `template0`, `template1`) + بادئة `_restore`/`_drill`، **غير قابلة للتجاوز بـ`--force` أو`--allow-live`**. قابلة للتوسيع بـ`WASIT_PROTECTED_DB_NAMES`.
  - **صلاحيات مجلد النسخ:** كان يعتمد umask؛ الآن `0700` صراحةً (`wasit_secure_dir`، مع `BACKUP_DIR_MODE`).
- **مساعدات جديدة في `scripts/lib/common.sh`:** `wasit_validate_db_name`, `wasit_sql_ident`, `wasit_protected_db_names`, `wasit_extra_protected_names`, `wasit_is_protected_db_name`, `wasit_secure_dir`.
- **الاختبارات:** أُضيفت أقسام **G1–G8** (حماية استعادة بلا خادم، بـ`psql` مُموّه) + **الأقسام 1–6** تُتخطّى بصوت عالٍ (`SKIP`) عند غياب الخادم. النتيجة على **PostgreSQL 17 حقيقي**: **39/39 ناجح** (كانت 15). فحوص: checksums مفقود/فارغ/غير مطابق/تجاوز مسار/رابط رمزي؛ اسم محقون؛ DEMO/إنتاج/نظام (مع `--force`/`--allow-live`)؛ صلاحيات 0700 رغم umask 000؛ واستعادة ناجحة لهدف scratch.
- **دليل حقيقي (منفّذ):** نسخة فعلية بمجلد `0700` + manifest؛ رفض `wasit_prod --force --allow-live`؛ رفض اسم محقون؛ رفض الهدف الحيّ؛ استعادة scratch مع تحقق أعداد صفوف ثم `--drop-after`. **`wasit_prod` لم يُنشأ/يُمَس**.
- **بيئة:** PostgreSQL 17 لم يكن مثبتاً (أُضيف للتو في هذه الجلسة بموافقة صريحة؛ خادم عابر للتجربة). ملاحظة: `/workspace/pgdata` **غير موجود** و`data_directory` ما زال الافتراضي `/var/lib/postgresql/17/main` — يخالف ما يوثّقه AGENTS.md أعلاه (لا تغيير في الإعداد دون موافقة).
- **بوابة السلامة (بعد):** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — **بلا تغيير**. modified 98 → **104** (+6 ملفات هذا العمل)، untracked 122، deleted 0، staged 0، reflog@0 ثابت. **تنبيه منهجية:** العدّ يجب أن يكون بـ`git status --porcelain -uall` (المجلدات غير المتعقّبة تُطوى افتراضياً فيظهر 98 بدل 122).

## WASIT-EXECUTION-013.1-A/B — تصميم وتنفيذ تشفير النسخ (age) (2026-11-09)

- **013.1-A (تصميم، READ-ONLY):** قارن `age` مقابل GPG مقابل KMS/Secret Manager على 8 معايير (تشغيل آلي، فصل المفتاح، استعادة عند فقدان الخادم، تدوير، نسخ المفتاح، الاعتماد على مزوّد، التكلفة). **القرار: `age` (X25519)** أساساً، وGPG خطة بديلة (متاح بلا تثبيت). تصميم كامل: معمارية Mermaid، تسلسل نسخ/استعادة، دورة حياة المفاتيح، أسماء ملفات/`manifest` مشفّرة، خطة انتقال 5 مراحل، خطة اختبار، متغيّرات بيئية، مخاطر، ومقارنة تخزين خارجي (S3/B2/R2/Azure/GCS/restic). **بلا اختيار مزوّد نهائي.**
- **013.1-B (تنفيذ محلي):** `BACKUP_ENCRYPTION=off|age` (الافتراضي `off` = سلوك سابق بلا تغيير، مُثبَت بمقارنة مُخرَج off القديم/الجديد = متطابق بنيوياً). في وضع `age`: تشفير **كل** ملفات الحمولة (`*.dump`, `pg_globals.sql`, `table-counts.tsv`) إلى مُستقبِلين (`BACKUP_AGE_RECIPIENTS`/`_FILE`)، الـ`manifest`/`checksums.sha256` بالصيغة المشفّرة مع `plaintextSha256` و`algo`, `encryption`, `recipients`. **`BACKUP_PLAINTEXT_RETENTION=keep` افتراضياً** (لا حذف أثناء الانتقال)، و`drop` يزيل النصّي **بعد** نجاح التشفير وكتابة الـmanifest.
- **الاستعادة:** `BACKUP_AGE_IDENTITY_FILE` **مسار فقط** (لا يمرّر المحتوى ⇒ لا ظهور في `ps`/السجلات)؛ رفض غياب المفتاح/خطئه/تلف ciphertext/المفتاح داخل مجلد النسخة **قبل أي عملية DB**؛ فكّ إلى مجلد `0700` مؤقت يُنظَّف دائمًا (trap EXIT)؛ تحقق `plaintextSha256` بعد الفكّ.
- **مساعدات جديدة في `scripts/lib/common.sh`:** `wasit_age_bin`, `wasit_age_recipients`, `wasit_require_age`, `wasit_age_recipient_args`, `wasit_age_identity_path`.
- **الاختبارات:** `scripts/backup-restore.test.sh` أُضيفت **E1** (off-parity، رفض غياب/خطأ/داخل-المجلد المفتاح، رفض غياب الأداة، «الرفض قبل أي DB»)، **E2** (رفض بدء التشفير بلا أداة/مُستقبِل + بلا مجلد متبقٍّ)، **E3** (round-trip حقيقي: تشفير كامل، حفظ النصّي، استعادة بالمفتاح الصحيح، رفض المفتاح الخاطئ، رفض تلف ciphertext، عدم تسرّب الأسرار للسجلات، تنظيف المؤقت، `drop` + استعادة ciphertext-only). **النتيجة: 61/61 مع `age` حقيقي (v1.2.1)، و48/48 بدون `age` (E3 يُتخطّى بصوت عالٍ).**
- **التوثيق/البيئة:** `docs/DEPLOYMENT.md` · `docs/commercial-release/08-OPERATIONS-RUNBOOK.md` (قسم تشفير + استعادة) · `docs/commercial-release/03-ENVIRONMENT-REFERENCE.md` (متغيّرات) · `.github/workflows/ci.yml` (تثبيت `age` في `backup-drill` لتفعيل E3) · `docker-compose.yml` (`BACKUP_ENCRYPTION` افتراضي `off`).
- **تحقق:** `npm run typecheck` (server+web) = **0** · `secret-scan.test.ts` **3/3** · لا مفاتيح/أسرار في Git (لا `AGE-SECRET-KEY` ولا recipient حقيقي ولا ملفات `*.key`/`*.age`).
- **بيئة:** `age` **غير مثبّت** في البيئة ولا في صورة `postgres:16`؛ لتنفيذ E3 استُخدم ثنائي `age` ثابت **مؤقت** في `/tmp/agebin` (لا تثبيت دائم، لا تعديل صورة). قرار إضافة `age` للصورة الدائمة = مطلوب قبل الإنتاج.
- **حدود:** لا ربط مزوّد خارجي، لا رفع، لا WAL/PITR، لا تغيير PostgreSQL/PGDATA، لا Git stage/commit/push.
- **بوابة السلامة (بعد 013.1-B):** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — **بلا تغيير**. modified 104 → **106** (ملفان جديدان دخلا حالة `M`: `.github/workflows/ci.yml` و`docker-compose.yml`؛ أما الثمانية الأخرى فكانت معدّلة سابقاً)، untracked 122، deleted 0، staged 0، reflog@0 ثابت. ملفات هذه المهمة العشرة: 4 سكربتات + `docs/DEPLOYMENT.md` + `08-OPERATIONS-RUNBOOK.md` + `03-ENVIRONMENT-REFERENCE.md` + `ci.yml` + `docker-compose.yml` + `AGENTS.md`.

## WASIT-EXECUTION-013.1-B.1 — إصلاح ترتيب drop + تثبيت age في CI (2026-11-09)

- **إصلاح الترتيب في `scripts/backup-db.sh`:** صار الترتيب — تشفير كل الحمولة والتحقق البنيوي ⇒ كتابة `manifest.json` (مع `plaintextSha256`) ⇒ كتابة `checksums.sha256` ⇒ **التحقق الفعلي منها** (`verify_checksums_file` عبر `sha256sum -c`، سطر ~254–263) ⇒ **ثم** حذف plaintext. أُزيل الحذف الذي كان يسبق كتابة checksums.
- **حراسة الحذف:** لكل ملف هدف: رفض `-L` (symlink) صراحةً، ثم `cd dirname && pwd -P` والتحقق أن المسار القانوني داخل `OUT_DIR_REAL` وإلا رفض؛ `rm -f --` على المسار القانوني. لا glob يمسّ مجلدات سابقة. (سطور ~265–290)
- **تحقق مبكر من `BACKUP_PLAINTEXT_RETENTION`:** نُقل إلى ما قبل أي عمل DB (سطور 66–78)؛ `keep` افتراضي، و`drop` اختياري، وأي قيمة أخرى ⇒ `exit 1` بلا لمس قاعدة بيانات. أُزيل التكرار في موقع التشفير.
- **اختبارات معزولة جديدة (F1–F6)** في `scripts/backup-restore.test.sh` بـ`pg_dump/pg_dumpall/psql/age` مُموّهة وبيئة `env -i` معزولة (بلا DB): F1 ترتيب drop + checksums تتحقق وتغطي ciphertext فقط؛ F2 keep افتراضي؛ F3 symlink لا يُتبع ولا يُحذف الهدف الخارجي؛ F4 لا يُمَس مجلد نسخة سابقة؛ F5 فشل checksum (حقن فشل في `sha256sum -c`) يمنع الحذف؛ F6 قيمة غير صالحة تُرفض. **النتيجة: 77/77 مع age حقيقي، و64/64 بدونه (E3 يُتخطّى).**
- **تثبيت age في CI:** `.github/workflows/ci.yml` — `sudo add-apt-repository -y universe` ثم `sudo apt-get install -y age=1.1.1-1ubuntu0.24.04.3` (الإصدار الحقيقي في مستودع Ubuntu 24.04 noble universe، مُتحقَّق منه عبر `packages.ubuntu.com`؛ لا رقم مُختلق ولا مصدر خارجي). لا تنزيل مباشر ⇒ لا حاجة لتحقق SHA256. محصور في job `backup-drill`. **لم يُعدّل `docker-compose.yml`/صورة الإنتاج لإضافة age.**
- **تحقق:** typecheck=0 · secret-scan 3/3 · off-parity (manifest/checksums القديم vs الجديد) متطابق.
- **حدود:** لم يُشغَّل CI فعلياً، ولم يُختبر الإنتاج. لا DB إنتاج/DEMO، لا migrations/seeds، لا تثبيت أدوات، لا حذف نسخ سابقة، لا Git مُغيِّر.
- **بوابة السلامة (بعد 013.1-B.1):** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — بلا تغيير. modified **106** (لا ملف جديد)، untracked 122، deleted 0، staged 0.

## WASIT-EXECUTION-013.1-C — اختبارات تشفير واستعادة متقدمة (2026-11-09)

- **قسم اختبارات جديد `H`** في `scripts/backup-restore.test.sh` (بعد F، قبل E3)، بـ`age` **حقيقي** وخادم **مُموّه** يسجّل كل استدعاءات `psql` (لإثبات أن الرفض يسبق أي عملية DB). يعمل داخل `env -i` معزول ويُتخطّى برسالة SKIP صريحة إن غاب `age`. يغطي: H1 استعادة بمفتاح من مجموعة مستلمين متعددة، H2 تدوير المفاتيح (نسخة جديدة بمستلمين جدد + بقاء القديمة قابلة للاستعادة بمفتاحها القديم + رفض المفتاح المُتقاعد)، H3 رفض هوية فارغة/مبتورة/غير صالحة قبل أي DB، H4 رفض recipient غير صالح قبل `pg_dump`، H5 نقص ciphertext، H6 manifest/checksums مفقود أو معدّل، H7 عدم تطابق `plaintextSha256` بعد الفكّ، H8 تلف ملف واحد من عدة، H9 نسخة قديمة غير مشفّرة تعمل بلا تغيير، H10 تنظيف المؤقت بعد فشل، H11 عدم تسرّب المفتاح/المحتوى إلى السجلات.
- **إصلاحان حقيقيان اكتشفهما H:**
  1. `wasit_age_recipients` (في `scripts/lib/common.sh`) كان يقسّم على السطر الجديد فقط بينما الوثائق تعد بفصل بالمسافات ⇒ أُضيف `tr '[:blank:]' '\n'` للصيغة المضمّنة. (كان `BACKUP_AGE_RECIPIENTS="r1 r2"` يفشل.)
  2. `wasit_require_age` كان يرفض فقط إن لم يوجد أي مُستقبِل صالح؛ صار يرفض إن كان **أي** مُدخل غير صالح (`^age1[0-9a-z]+$`)، **قبل** أي `pg_dump`.
- **نتائج:** **105/105 مع age** (يشمل E3 وH)، **64/64 بدونه** (H وE3 SKIP بصوت عالٍ). typecheck=0 · secret-scan 3/3. تحقق إضافي: صيغة `BACKUP_AGE_RECIPIENTS_FILE` (سطر لكل مستلم) تُحلّ لمستلمين.
- **توثيق:** `08-OPERATIONS-RUNBOOK.md` (سياسة التدوير، الاحتفاظ بالهويات، فقدان المفتاح، «السلامة ليست أصالة»، خارج النطاق) · `DEPLOYMENT.md` · `03-ENVIRONMENT-REFERENCE.md`.
- **حدود:** لا DB إنتاج/DEMO، لا migrations/seeds، لا رفع خارجي، لا تفعيل تشفير افتراضي، لا تعديل صورة الإنتاج، لا تثبيت أدوات، لا Git مُغيِّر.
- **بوابة السلامة (بعد 013.1-C):** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — بلا تغيير. modified **106**، untracked 122، deleted 0، staged 0.

## WASIT-EXECUTION-013.1-C.1 — تحقق مستلم موثوق + توثيق الأصالة (2026-11-09)

- **تحقق موثوق من المستلم (لا regex):** `wasit_require_age` في `scripts/lib/common.sh` صار يمرّر **كل** مستلم إلى **محلِّل `age` نفسه** عبر `printf '' | age --encrypt -r "$r" -o /dev/null` (تحقق نوع المفتاح + **Bech32 checksum**). يُرفض أي مستلم غير صالح — حتى لو طابق `^age1[0-9a-z]+$` (checksum تالف/مبتور/مزيج صحيح+خاطئ) — **قبل** أي `pg_dump`/DB. لا تثبيت أدوات، لا اعتماد خارجي (نستخدم `age` الموجود أصلاً). السبب: لا يوجد أمر تحقق مخصّص في age، والفحص بـ regex وحده كان يمرّر مفتاحاً تالف الـchecksum.
- **اختبارات H4 موسّعة:** مستلم صحيح يُقبل ويصل `pg_dump`؛ bad-checksum / truncated / junk / مزيج صحيح+خاطئ تُرفض كلها، ويُثبت بسجل `pg_dump` المُموّه أنه **لم يُستدعَ إطلاقاً** في حالات الرفض. (113/113 مع age، 64/64 بدونه.)
- **تصحيح توثيق الأصالة:** أُزيلت الصياغة التي كانت توحي أن تشفير `age` يثبت هوية المنشئ. الآن موثّق بدقة: `checksums.sha256`/`plaintextSha256` = **سلامة محتوى**، و`age` = **سرية الحمولة**، ولا يثبت أيٌّ منهما **أصالة المصدر/هوية المنشئ**؛ وإثبات المصدر يحتاج **توقيعاً رقمياً بمفتاح توقيع منفصل** = **خارج نطاق 013.1** (لم يُنفَّذ). (`08-OPERATIONS-RUNBOOK.md`، `DEPLOYMENT.md`، `03-ENVIRONMENT-REFERENCE.md`.)
- **نتائج:** typecheck=0 · secret-scan 3/3 · `bash -n` OK.
- **حدود:** لا DB إنتاج/DEMO، لا migrations/seeds، لا offsite، لا تعديل صورة الإنتاج، لا تفعيل تشفير افتراضي، لا تثبيت نظامي، لا Git مُغيِّر، لا بدء 013.1-D/E.
- **بوابة السلامة (بعد 013.1-C.1):** HEAD `a5391a5…` · branch `master` · M0 `e731e…` — بلا تغيير. modified **106**، untracked 122، deleted 0، staged 0.

## WASIT-EXECUTION-M2 — معمارية الطلب متعدد البائعين (Parent Order + Seller Suborders) (2026-11-03)

- **السياق:** كان القيد M0 يرفض أي طلب يجمع أكثر من بائع (409) لأن `orders.sellerId` مفرد وكل صفوف `transactions`/`transactionLedger` تُكتب على البائع الأول ⇒ خطر إسناد أموال بائع آخر. أُزيل القيد وطُبِّقت المعمارية النهائية.
- **المخطّط (`src/db/schema/commerce.ts`):**
  - جدول جديد `seller_orders` (طلب فرعي لكل بائع): `parent_order_id`, `seller_id`, `seller_type`, `items_total`, `commission`, `buyer_commission`, `seller_commission`, `seller_payable`, `status`, `settlement_status`, `order_number`, `seller_order_number` (`<orderNumber>-S<n>`). فهرس فريد `(parent_order_id, seller_id)` (يمنع تكرار الطلب الفرعي) + فهرس فريد `(id, parent_order_id, seller_id)` كهدف للقيد المركّب.
  - `orders.sellerId`/`sellerType` صارا **اختياريين**: طلب البائع الواحد يحتفظ بهما (شكل ما قبل M2)، وطلب متعدد البائعين يتركهما `null`. `orders.metadata.sellerCount` يوضّح العدد.
  - `order_items`: عمودان جديدان `seller_order_id` و`seller_id` (اختياريان للصفوف القديمة)، مع **قيد مركّب** `order_items_suborder_fk (seller_order_id, order_id, seller_id) → seller_orders(id, parent_order_id, seller_id)` ⇒ يستحيل على بند أن يُنسب لطلب فرعي أو بائع آخر (MATCH SIMPLE يتجاهله عند null).
- **الهجرة:** `src/db/migrations/0037_tiny_rhodey.sql` — إضافية بالكامل (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN` + `DROP NOT NULL`)، لا حذف/إعادة تسمية، لا لمس بيانات قائمة.
- **الخدمات:**
  - `orders/service.ts::createOrder` — يُجمّع البنود حسب البائع (ودمج الأسطر المكرّرة لنفس المنتج)، ويُنشئ **طلباً أماً واحداً + طلباً فرعياً لكل بائع** داخل **معاملة واحدة** (حجز المخزون + الأم + الفرعية + البنود + الحركة + الدفتر + التدقيق + الإشعارات كلها ذرّية). كل بائع يُحتسب على مجموعه الفرعي: `resolveCommission` لكل بائع، ودفتر: ائتمان `TRANSACTION_VALUE` **لكل بائع** + خصم عمولة بائع لكل بائع + خصم واحد لعمولة المشتري + خصم واحد للرسوم. أُضيف حارس عملة واحدة (كل منتجات الطلب بعملة واحدة). الاستجابة تُبقي الأوتار (`commission`/`commissionSeller`/... بصيغة `toFixed(4)`) كما كانت + `sellerOrderIds`, `sellerCount`.
  - `orders/service.ts::updateOrderStatus` — يقبل `opts.sellerOrderId`. بائع يؤكّد **طلبه الفرعي فقط** (لا يمسّ مخزون غيره)؛ حالة الطلب الأم تُشتق من الفرعية عبر `aggregateParentStatus`. المشتري يستطيع إلغاء السلة كاملة (كل الفرعية CANCELLED). طلب قديم بلا فرعية يُحدَّث مباشرة كما قبل. الدعوى على الصف (guarded UPDATE) تمنع التطبيق المزدوج.
  - `orders/service.ts::getOrder` — يُرجع `sellerOrders[]` (كل فرعية ببنودها وبائعها) و`isMultiSeller` و`viewerRole`؛ الوصول للبائع عبر أي فرعية يملكها.
  - `orders/service.ts::listMyOrders` — تُظهر الطلب متعدد البائعين لكل بائع مشارك (`id in (select parent_order_id from seller_orders where seller_id in (...))`).
  - `orders/routes.ts` — `sellerOrderId` اختياري في `PATCH /:id/status`.
  - `payments/service.ts::assertOrderAccess` — يعترف بالبائع الشريك عبر `seller_orders` (الأم بلا `sellerId`).
  - `disputes/service.ts::canAccessDispute` — نفس المنطق للبائع الشريك.
  - `payouts/service.ts::createPayout` — **يفشل مغلقاً** على الطلب متعدد البائعين (409) لأن جدول `payouts` مفتاحه `transaction_id` واحد؛ الدفع لكل بائع فرعي = تصميم لاحق غير مُختلق (مسجّل في GAP_REGISTER).
  - `analytics/service.ts` — `sellerCond` يشمل الطلبات التي للبائع فيها فرعية؛ GMV/العمولة تُجمَع من `seller_orders` (لا من الأم) لتجنّب العدّ المزدوج.
  - `admin/routes.ts` — يُدرج `metadata` (فيه `sellerCount`) في قائمة الطلبات.
- **الاختبارات:**
  - `tests/unit/order-mixed-seller-guard.test.ts` (DB-free): كان يتحقق من الرفض؛ صار يتحقق من **التقسيم** (أم واحد + فرعية لكل بائع، مال كل بائع، ائتمان دفتر لكل بائع، حجز لكل بائع) + عدم تغيّر سلوك البائع الواحد. (5/5)
  - `tests/m2-multi-seller-order.test.ts` (PostgreSQL حقيقي): تقسيم بائعَين (بنود/مال/دفتر)، تأكيد كل بائع فرعيه فقط وتجميع حالة الأم، رفض تأكيد فرعية لا يملكها (403)، تفاصيل الطلب لكل طرف، إلغاء المشتري للسلة كاملة وتحرير كل الحجوزات، وثبات شكل البائع الواحد. (6/6)
- **التحقق:** `npm run typecheck` (server+web) = **0** · الوحدة (t1) **127/127** · **المجموعة الكاملة 118 ملفاً / 1507 اختبار = كلها ناجحة** على قاعدة الاختبار المعزولة (`127.0.0.1:5434`, `wasit_test`). ملاحظة: ظهر فشل عابر واحد في اختبار تزامن (`two concurrent confirmations…`) تحت التوازي، ونجح عند الإفراد وعند إعادة التوازي (تزاحم على القاعدة، ليس انحداراً).
- **حدود:** لا DEMO/إنتاج، لا migrations على غير قاعدة الاختبار المعزولة، لا Git مُغيِّر (بلا stage/commit/push)، لا حذف/استبدال أي عمل سابق.
- **بوابة السلامة (بعد M2):** المسار `/workspace/project` · الفرع `master` · HEAD `98c3a958…b4aa` (بلا تغيير) · staged 0 · modified **106** · untracked **129** · deleted 0 · stash 0 · M0 `repo.bundle` = `e731e6845b3d1fe5647fd4168e592067099f591a336de0fa8117d53050fa8694` (بلا تغيير). ملفات M2: 8 معدّلة + 5 جديدة (هجرة 0037 + snapshot + 3 اختبارات).

---

## WASIT-EXECUTION-M2.1 — إلغاء الطلبات الفرعية وتصحيح المخزون (2026-11-03)

- **الخلل المُصلَح (انحدار M2، كُشف بالتدقيق المستقل):** في `orders/service.ts::updateOrderStatus` كان قرار المخزون عند الإلغاء (`restoreStockForCancelledOrder` مقابل `releaseReservation`) يُتَّخذ من حالة **الطلب الأم** (`order[0].status`) بدل حالة **الطلب الفرعي المستهدف**. ففي سلة متعدّدة البائعين (الأم `PENDING` لأن فرعية أخرى لم تُؤكَّد)، إلغاء فرعية **مؤكَّدة** كان يستدعي `releaseReservation` ⇒ **لا يُعاد مخزونها**. وإلغاء الأم لسلة بحالات مختلفة كان يطبّق قاعدة واحدة على كل الفرعيات.
- **الإصلاح (`orders/service.ts`):**
  - `applyInventory(items, priorStatus)` يستقبل **حالة السجل المستهدف** صراحةً: حالة الفرعية عند استهدافها، وحالة الأم للطلب القديم (بلا فرعية). لم يبقَ أي قرار مخزون مبني على حالة الأم لفرعية بعينها.
  - استهداف فرعية: دعوى ذرّية على الفرعية بحالتها (`WHERE id = ? AND status = ?`)، ثم معالجة بنودها وحدها، ثم إعادة حساب حالة الأم.
  - إلغاء الأم لسلة متعدّدة: **كل فرعية تُدَّعى وتُعالَج على حدة وفق حالتها** — المؤكَّدة يُعاد مخزونها، والمعلّقة يُحرَّر حجزها فقط، والملغاة مسبقاً تُتخطّى (لا إعادة مزدوجة).
  - طلب قديم بلا فرعية: يبقى كما قبل (حالة الأم تقود القرار) — لا تغيير سلوكي.
  - `aggregateParentStatus`: تُستبعد الفرعيات `CANCELLED` من التلخيص، فالسلة الملغاة جزئياً لا تعود `PENDING` وهي تحوي جزءاً حيّاً مؤكَّداً (بلا اختراع حالات جديدة).
  - سجل التدقيق يسجّل حالة **السجل المستهدف** فعلاً (لا حالة الأم) عند استهداف فرعية.
- **قاعدة المخزون المُثبَّتة بالكود:** الخصم الفعلي يقع حصراً عند الانتقال إلى `CONFIRMED` (`commitReservationToSale`). لذلك: الانتقال من `PENDING`/`PROCESSING` ⇒ حجز فقط (`releaseReservation`)؛ ومن `CONFIRMED` أو ما بعده ⇒ مخزون مخصوم (`restoreStockForCancelledOrder`).
- **الاختبارات:** `tests/m21-cancel-inventory.test.ts` (**9/9** على PostgreSQL 17 معزول `wasit_test`@5434): فرعية مؤكَّدة تُلغى فيُعاد مخزونها وحدها · فرعية معلّقة تُلغى فيُحرَّر حجزها بلا إعادة مخزون · إلغاء سلة مختلطة يعالج كل فرعية بحالتها · إعادة الإلغاء لا تعيد المخزون مرتين · إلغاءان متزامنان لا يضاعفان الإعادة · لا يتغيّر مخزون بائع آخر · الطلب القديم بلا فرعية يعمل كما كان · لا سجلات مالية غير صحيحة (لا إدخال/حذف في الدفتر، حالة المعاملة ثابتة) · حالة الأم بعد إلغاء جزئي = `CONFIRMED` لا `PENDING`.
  - **إثبات أن الاختبار يكشف الخلل:** أُعيد الخلل مؤقتاً (استخدام `fromStatus` بدل حالة الفرعية) ⇒ **4 اختبارات فشلت** (`expected 47 to be 50`)، ثم أُعيد الملف المُصلَح بنفس البصمة `7bf89e79…812004` ونجحت **9/9**.
- **التوثيق:** أُضيف القسم §13 في `docs/GAP_REGISTER.md` بستة صفوف: `M2.1-CANCEL-INV` و`M2.1-PARENT-STATUS` (**COMPLETE_VERIFIED**) + `M2.2-PAYOUT-SUBORDER` و`M2.3-SUBORDER-SETTLEMENT` و`M2.4-REFUND-SUBORDER` و`M2.5-TX-SELLER-ATTRIBUTION` (**OPEN** موثَّقة). لم يبقَ اعتماد على ذكر الفجوة في AGENTS.md فقط.
- **`transactions.sellerId` والثقة:** في الطلب متعدّد البائعين يُسند لبائع واحد (`soleSeller ?? firstProduct.sellerId`) ⇒ تلوّث مجاميع Trust Engine (فجوة `M2.5` موثَّقة). **التصميم الصحيح المقترح:** اشتقاق تقييم كل بائع من فرعيته (`seller_orders`) كما في `analytics`. **لم تُغيَّر حسابات الثقة ولا البنية المالية في هذه المهمة.**
- **حدود:** إصلاح الإلغاء/المخزون + تجميع حالة الأم + التوثيق فقط. **لا Payout، ولا تغييرات مزوّد دفع، ولا Migration جديدة.** لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.3 — تسوية كل Seller Suborder (2026-11-14)

- **الفجوة المُصلَحة:** `seller_orders.settlement_status` لم يكن يكتبه أي كود — يبقى `PENDING` دائماً، والتسوية تُحدِّث حالة الطلب الأب والدفتر على مستوى الأم فقط، فلا يُعرف أي بائع سُوِّي فعلاً في سلة مختلطة.
- **البنية (Migration 0039، منفَّذة على قاعدة الاختبار فقط):** جدول `seller_settlements` + ست قيود `CHECK` + ثلاث مفاتيح أجنبية مركّبة (منها `seller_settlements_parent_entry_fk`) + الفهارس. صُحّح خلل ترتيب (`42830`): فهرسان فريدان (`transaction_ledger_identity_idx`، `transactions_identity_idx`) كانا يُعرَّفان **بعد** المفاتيح التي تشير إليهما ⇒ نُقلا قبلهما. أُعيد التشغيل: `migrations applied successfully` (40 ترحيلاً).
- **الكاتب الوحيد (`settlements/service.ts::settleSellerSuborder`):** هو الكاتب الوحيد لـ`seller_orders.settlement_status = 'SETTLED'`. الترتيب: قفل الفرعية (`FOR UPDATE`) ← فحص التكرار ← تقييم الأهلية ← قفل المعاملة الأب ← إدراج `seller_settlements` بقيم مأخوذة من **الصف المقفول** لا من المستدعي ← تحديث الحالة بشرط `<> 'SETTLED'` ← تدقيق `SELLER_SETTLEMENT.CONFIRMED`. كل رفض يُسجَّل `SELLER_SETTLEMENT.REJECTED` ويُعاد مع السبب.
- **شروط الأهلية (`evaluateSuborderRow`):** فرعية `DELIVERED`/`COMPLETED` · طلب `PAID` · بلا استرداد (كامل/جزئي/قيد المعالجة) · بلا نزاع مفتوح (`≠ CLOSED/ARCHIVED`) · قيد `SETTLEMENT / SETTLED` على المعاملة الأب. الأسباب: `SUBORDER_NOT_DELIVERED`، `PARENT_ORDER_NOT_PAID`، `REFUND_PRESENT`، `DISPUTE_OPEN`، `PARENT_TRANSACTION_NOT_SETTLED`، `ALREADY_SETTLED`، `SUBORDER_NOT_FOUND`.
- **الربط التلقائي (`orders/service.ts::updateOrderStatus`):** بعد **commit** الانتقال إلى `DELIVERED`، تُسوَّى الفرعيات التي انتقلت فعلاً — **best-effort ومتكرّر-آمن**: فشل التسوية لا يُلغي انتقالاً نجح، والفرعية غير المؤهّلة تبقى `PENDING`.
- **بوابة الدفع (`payouts/service.ts::createPayout`):** داخل معاملة واحدة؛ قفل الفرعية ثم المعاملة **قبل** أي بوابة (نفس ترتيب `settleSellerSuborder` ⇒ لا deadlock)؛ فحص قيد التسوية الأب أولاً ثم تسوية الفرعية ⇒ `Cannot create a payout before this seller suborder is settled`.
- **مسار الإدارة:** `POST /api/admin/finance/settlements/suborders/reconcile` (صلاحية `COMMISSION_MANAGE`/`PAYMENT_READ`) — idempotent، يعيد حكماً لكل فرعية، ولا يكتب أي قيد دفتر.
- **الواجهة:** لوحة «تسويات البائعين الفرعية» في تبويب التسوية بـ`AdminFinancePages.tsx` + مفاتيح i18n لـ4 لغات + اختبار تكافؤ `packages/web/tests/m23-i18n.test.ts`.
- **الاختبارات:** `tests/m23-t2-suborder-settlement.test.ts` **20/20** · الحزمة الكاملة للخادم **1573/1573** (123 ملف) · حزمة الويب **51/51** · Typecheck (server+web) نظيف · `drizzle-kit check` نظيف. كما حُدِّثت تركيبات `m22-t2-suborder-payout` و`persistence-invariants` و`finance-routes` لتُسوّي الفرعية قبل الدفع (بوابة جديدة).
- **التوثيق:** §15 في `docs/GAP_REGISTER.md` (انتقلت `M2.3-SUBORDER-SETTLEMENT` من `OPEN` إلى `COMPLETE_VERIFIED`) + `docs/M2.3-T2_SUBORDER_SETTLEMENT.md`.
- **حدود:** لا Refund على مستوى الفرعية (M2.4)، لا تغيير في إسناد `transactions.sellerId` (M2.5)، لا Wallet، لا مزوّد خارجي فعّال، لا reverse-settlement. لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.4-T2.1 — أساس بيانات تخصيص الاستردادات (Refund Allocation) (2026-11-03)

- **الفجوة المُعالَجة (جزئياً):** `M2.4-REFUND-SUBORDER` — الاسترداد لا يُنسَب لبائع في نموذج البيانات، فيعكس عمولة كل البائعين ولا يُحدِّث حالة الفرعيات. **T2.1 = أساس البيانات فقط**؛ طبقة الخدمة في T2.2+.
- **Migration 0040 (جديدة، غير مُطبَّقة على أي قاعدة):** جدول `refund_allocations` + قيدا `CHECK` + ثلاثة مفاتيح أجنبية مركّبة + ثلاثة فهارس هوية `UNIQUE` جديدة. **additive فقط** — لا حذف ولا إعادة تسمية ولا تغيير هدّام، ولا Wallet ولا أرصدة ولا حالات مالية جديدة.
- **الجدول `refund_allocations`:** `id`، `refund_id`، `parent_order_id`، `seller_order_id`، `order_item_id` (اختياري)، `amount`، `currency_code`، `created_at`. يسمح لاسترداد واحد بتغطية **عدة فرعيات**. **ليس حركة مالية ولا قيد دفتر ولا محفظة ولا رصيد** — الاسترداد يبقى مصدر الحقيقة.
- **المفاتيح المركّبة:** `refund_fk → refunds(id, order_id)` · `suborder_fk → seller_orders(id, parent_order_id, currency_code)` · `item_fk → order_items(id, order_id, seller_order_id)`. تثبت أن الاسترداد والفرعية والبند ينتمون لنفس الطلب الأب، وأن البند يتبع الفرعية نفسها لا مجرد وجوده.
- **منع التكرار:** فهرس فريد `refund_allocations_refund_suborder_idx (refund_id, seller_order_id)`.
- **قرار تصميمي:** عمود `seller_id` مُستبعَد عمداً من مفتاح الفرعية — المفتاح المركّب يتطلّب فهرساً فريداً بنفس أعمدة المرجع بالضبط، و`refund_fk` على `(refund_id, parent_order_id)` يضمن أصلاً تطابق الطلب الأب.
- **ترتيب الإنشاء (خطأ 42830):** فهارس الهوية تُنشأ **قبل** المفاتيح التي تشير إليها — نفس تصحيح 0039؛ ملف `drizzle-kit generate` الخام يضع المفاتيح أولاً (خطأ) فصُحّح يدوياً.
- **حارس الانحراف:** كتلة `DO $$` ترفض التنفيذ إذا وُجد كائن بالاسم نفسه بتعريف مختلف — نفس نمط 0039.
- **الاختبارات:** `tests/m24-t21-refund-allocation-schema.test.ts` (بنية + ثوابت الإسناد: فرعية من طلب آخر مرفوضة، بند من فرعية أخرى مرفوض، استرداد واحد لفرعيتين مقبول، منع التكرار). **لم تُشغَّل هنا** (PostgreSQL غير متاح).
- **ما أُثبت:** `drizzle-kit check` نظيف · `tsc` (server) نظيف · `drizzle-kit generate` = «No schema changes» (snapshot مطابق للمخطط حرفياً) · سلسلة `0039.id == 0040.prevId` ✅ · بصمات 0039 دون تغيير.
- **التوثيق:** §16 في `docs/GAP_REGISTER.md` (`M2.4-REFUND-SUBORDER` → **PARTIAL — T2.1 مكتمل**) + `docs/M2.4-T2.1_REFUND_ALLOCATION.md`.
- **حدود:** لا منطق خدمة، لا تعديل على `seller_payable`، لا حذف قيود، لا Wallet/clawback، **Migration 0040 لم تُطبَّق على أي قاعدة بيانات**، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.4-T2.2 — إنشاء الاسترداد مع التخصيص لكل بائع (Refund Creation & Allocation) (2026-11-03)

- **الفجوة المُعالَجة (جزئياً):** `M2.4-REFUND-SUBORDER` — الاسترداد لا يُنسَب لبائع. **T2.1 = أساس البيانات** (Migration 0040). **T2.2 = إنشاء الاسترداد بالتخصيص** (طبقة الخدمة). يبقى تحديث حالة الفرعية وعكس العمولة لكل بائع في T2.3+.
- **الشكل الجديد (`payments/service.ts::createRefund`):** حقل اختياري `allocations?: { sellerOrderId, orderItemId?, amount }[]`. **بلا تخصيص = استرداد كامل** يُوزَّع على الفرعيات بحسب **المتبقّي القابل للاسترداد الفعلي** لكل فرعية (توزيع الباقي الأكبر، مجموعه = المبلغ بالضبط). **مع تخصيص:** المجموع = المبلغ بالضبط، وكل فرعية/بند يخص هذا الطلب.
- **قاعدة السقف:** سقف الفرعية = `items_total + buyer_commission` (ما دفعه المشتري فعلاً) — **ليس `seller_payable`** (صافي البائع، رقم مختلف). مطابقة لتقرير M2.4-T1.
- **قواعد الرفض (كلها `422 VALIDATION_FAILED`):** مبلغ غير موجب · فرعية من طلب آخر · عملة مختلفة · بند لا يخص الفرعية المسمّاة · تكرار فرعية · تكرار بند · مجموع ≠ المبلغ · تجاوز سقف الفرعية/البند · **استرداد جزئي لطلب متعدد البائعين بلا تخصيص** (لا تخمين). **البائع الواحد:** الاسترداد الجزئي بلا تخصيص يُقبل ويُنسب للفرعية الوحيدة (يحفظ سلوك ما قبل M2). **الطلب القديم بلا فرعيات:** `[]`.
- **التزامن:** كل التحقق + الحجز + كتابة التخصيصات في **`db.transaction` واحدة**: قفل صف الطلب `FOR UPDATE` (قفل أول ثابت لا تأخذه مسارات التسوية/الدفع ⇒ لا deadlock) ← قراءة المتبقّي ← قفل الفرعيات ثم البنود بترتيب ثابت (`ORDER BY id`، نفس ترتيب «فرعية ← معاملة») ← قراءة التخصيصات المحجوزة (ضمّ `refunds`، استبعاد غير المحجوز) ← إدراج `refunds` (الحجز) ثم `refund_allocations`. **طلب متزامنان لا يصرفان نفس المتبقّي مرتين.**
- **Idempotency:** فحص مسبق (إعادة الاسترداد الأصلي) + **حارس عند الالتزام** عبر `refunds_idem_idx`: طلبان متزامنان بنفس المفتاح ⇒ يفوز أحدهما ويرفض الفهرس الآخر فيُعاد الأصلي `reused: true` بدل `500`.
- **الكاتب الوحيد للاكتمال يبقى `completeRefundWithEvidence`:** T2.2 **لا** يكتب قيد `REFUND` ولا يغيّر `orders.paymentStatus`/`refundStatus`/`status` ولا حالة الفرعية. الإنشاء ≠ الاكتمال.
- **المسار:** `POST /api/payments/orders/:orderId/refunds` — `refundAllocationSchema` اختياري (`max 200`) ⇒ الطلبات القديمة صالحة. مسار النزاعات يستدعي بلا تخصيص (استرداد كامل) وطلباته بلا `seller_orders` ⇒ بلا تغيير سلوكي.
- **الاختبارات:** `tests/m24-t22-refund-allocation.test.ts` (14 حالة: مسارات سعيدة، رفض، تزامن، idempotency، توافق قديم، «الإنشاء لا يُكمل»). **لم تُشغَّل** (PostgreSQL غير متاح). الاختبارات القائمة (`payments`، `money-path-invariants`، `p6-p7-dispute-webhook`) محفوظة السلوك.
- **ما أُثبت:** `tsc` (server+web) نظيف · `drizzle-kit check` نظيف · لا Migration جديدة · لا تعديل على أي ملف سابق (فقط `service.ts` و`routes.ts` مُعدَّلان + ملف اختبار جديد).
- **التوثيق:** §17 في `docs/GAP_REGISTER.md` (`M2.4-REFUND-SUBORDER` → **PARTIAL — T2.1 + T2.2 مكتملان**) + `docs/M2.4-T2.2_REFUND_CREATION.md`.
- **حدود:** لا تحديث حالة الفرعية، لا عكس عمولة لكل بائع عند الاكتمال (T2.3+)، لا توزيع تلقائي على بنود داخل فرعية واحدة، لا Wallet/clawback، لا مزوّد خارجي فعّال، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.4-T2.3 — حالة الفرعية لكل بائع + عكس العمولة لكل بائع عند اكتمال الاسترداد (2026-11-16)

- **الفجوة المُعالَجة (جزئياً):** `M2.4-REFUND-SUBORDER`. **T2.1 = أساس البيانات** (Migration 0040) · **T2.2 = إنشاء الاسترداد بالتخصيص** · **T2.3 = الأثر لكل بائع عند الاكتمال** (حالة الفرعية + عكس عمولتها). تبقى الواجهة (T2.4+).
- **النطاق:** التغيير كله داخل `completeRefundWithEvidence` في `packages/server/src/modules/payments/service.ts`. **بلا تغيير في `createRefund`/`routes.ts`/المخطط، وبلا Migration جديدة.**
- **`attributedRefundsBySuborder(db, orderId)`:** مجموع تخصيصات **الاستردادات `COMPLETED` فقط** لكل فرعية (`refund_allocations ⋈ refunds`). طلب/معالجة لا يُحتسب (المال لم يرجع بعد). فرعية بلا تخصيص = صفر.
- **عكس العمولة/الرسوم لكل بائع (`reverseCommissionAndFee`):** حصة البائع (`COMMISSION`/`SELLER` مع `sellerOrderId`) تُعكَس بنسبة **فرعيته** = `attributed ÷ (items_total + buyer_commission)` مقصوصة عند `1`. حصة المشتري (`share=BUYER`) ورسم الدفع يبقيان على نسبة الطلب = `cumulativeRefunded ÷ grandTotal` (بلا تغيير). بيانات قديمة بلا `sellerOrderId`/فرعية مجهولة ⇒ سقوط لسياسة الطلب. **Idempotency محفوظة:** الهدف دالة في المجاميع، ويُكتب الفرق الناقص فقط.
- **حالة الفرعية (`markRefundedSuborders`):** كل فرعية مستردة **بالكامل** (`attributed >= cap`) ⇒ `status = 'REFUNDED'` (بشرط `<> 'REFUNDED'` ⇒ idempotent). **الجزئية تحافظ على حالتها التفيذية.** لا تُكتب `settlement_status` (المُعدَّد لا يحوي «مسترد»).
- **منع التسوية:** `evaluateSuborderRow` يشترط `DELIVERED/COMPLETED` ⇒ الفرعية `REFUNDED` **غير مؤهَّلة**، فلا يُدفع مستحقات بائع رُدّ ثمنه.
- **حالة الطلب الأب:** تبقى من المجموع الكلي (`fullyRefunded`) — **بلا تغيير**.
- **التدقيق:** `refundedSuborders` مُضاف إلى حمولة `REFUND.COMPLETED`.
- **قرار التصميم:** في طلب مختلط باسترداد كامل لبائع واحد، السياسة القديمة كانت تخفض عمولة البائع الآخر (نسبة على مستوى الأب). القاعدة الجديدة تربط عمولة كل بائع بمصير ماله (نصيب فرعيته) — «لا خصم بلا استرداد فعلي».
- **الاختبارات (مُشغَّلة فعلاً):** `tests/m24-t23-refund-suborder-status.test.ts` (جديد) **7/7** على PostgreSQL 16 معزول (`wasit_test` @127.0.0.1:5434، حاوية `wasit-m243-test-pg`). **أول مهمة في سلسلة M2.4 تُشغَّل اختباراتها فعلياً.**
- **إصلاح عيبين كامنين (اختباران لم يُشغَّلا قبل الآن، بلا تغيير سلوك إنتاجي):** `m24-t22` (كلمة مرور المدير في مساعد الدخول ⇒ 14/14) · `m24-t21` (`product_id` يتجاوز 36 + نص قيد `CHECK` بعد تطبيع Postgres ⇒ 13/13).
- **الحزمة الكاملة للخادم:** 1608 حالة، 1596 نجحت؛ الفاشل (12) في ملفين **قبل** هذا العمل (`m24-t21` أُصلح؛ `sec04b-entity-read-access` حسّاس للتوازي، ينجح 12/12 منفردة). `tsc` (server) نظيف.
- **التوثيق:** §18 في `docs/GAP_REGISTER.md` (`M2.4-REFUND-SUBORDER` → **PARTIAL — T2.1 + T2.2 + T2.3**) + `docs/M2.4-T2.3_REFUND_SUBORDER_STATUS.md`.
- **حدود:** لا Wallet/clawback، لا توزيع تلقائي على بنود داخل فرعية واحدة، لا مزوّد خارجي فعّال، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.4-T2.4 — واجهة عرض تخصيص الاستردادات لكل بائع (Per-seller Refund Allocation View) (2026-11-16)

- **الفجوة المُعالَجة (جزئياً):** `M2.4-REFUND-SUBORDER`. **T2.4 = طبقة قراءة + واجهة إدارية للقراءة فقط.** بهذا تكتمل سلسلة T2.1→T2.4 (أساس البيانات → إنشاء الاسترداد بالتخصيص → الأثر لكل بائع → العرض). **قراءة فقط: لا كتابة، لا زر ينقل مالاً.**
- **الخادم — `getOrderRefundAttribution(db, orderId, actorId, { isOperator })`** في `packages/server/src/modules/payments/service.ts`: لطلب واحد تُرجِع حالة الطلب ومجاميعه، الاستردادات (مع الفرعيات المنسوب إليها)، وقائمة البائعين — لكل بائع: `refundableCap` (= `items_total + buyer_commission`)، `refundedAmount` (تخصيصات **`COMPLETED` فقط**)، `remainingAmount`، `sellerCommission`، **`sellerCommissionReversed` مقروءة من الدفتر** (قيود العكس عبر `metadata.reversalOf`، لا معاد حسابها)، `fullyRefunded`، البنود، واستردادات البائع مع `counted`. الطلبات القديمة بلا فرعيات ⇒ `legacy = true`.
- **المسار `GET /api/payments/orders/:orderId/refund-attribution`** في `packages/server/src/modules/payments/routes.ts` بصلاحية **`REFUND_MANAGE`** (`ADMIN`/`SUPER_ADMIN` فقط).
- **قرار التصميم — لماذا `REFUND_MANAGE` لا `PAYMENT_READ`؟** `PAYMENT_READ` يملكه أيضاً `MERCHANT`/`SUPPLIER`/`COMPANY`، فلو بوّبنا عليه لاستطاع بائع قراءة **نصيب بائع آخر** (تسرّب تجاري + IDOR). `REFUND_MANAGE` يحصرها في مكتب الاسترداد المصرّح؛ مسارا القراءة الذاتية القائمان يبقيان مقيَّدين بالملكية.
- **مبدأ ثابت:** كل رقم يُعرض **مأخوذ من الخادم كما هو**؛ الواجهة تصنّف وتُسمّي فقط. الاسترداد غير المكتمل يُعرض بحالته لكنه **لا يُحتسب** (نفس مبدأ LC-04/T2.3).
- **الواجهة:** مكوّن `packages/web/src/components/RefundAttributionPanel.tsx` (عرض بحت) + زر «عرض تفاصيل التخصيص» في `AdminOrdersPage` + مساعدات عرض بحتة `packages/web/src/lib/refund-attribution.ts` + مفاتيح `admin.refundAttr.*` و`common.yes/no` في اللغات الأربع (ar/en/fr/zh) + `api.orderRefundAttribution(orderId)`.
- **اختبارات الخادم (مُشغَّلة فعلاً):** `packages/server/tests/m24-t24-refund-attribution-view.test.ts` (جديد) **11/11** على PostgreSQL 16 معزول (`wasit_test` @127.0.0.1:5434، حاوية `wasit-m243-test-pg`): بائع واحد بلا استرداد؛ بائعان بسقفين مستقلين؛ جزئي؛ كامل لبائع واحد (والآخر لا يُمَس)؛ كامل للجميع؛ **العمولة المعكوسة من الدفتر**؛ `CUSTOMER`/`MERCHANT`/`SUPPLIER`/`SUPPORT` ⇒ `403` و`ADMIN` ⇒ `200`؛ بلا استردادات؛ `404`؛ **القراءة لا تكتب**؛ طلب قديم ⇒ `legacy`.
- **اختبارات الويب (مُشغَّلة فعلاً):** `packages/web/tests/m24-t24-refund-attribution.test.ts` (جديد) **12/12** — عقد الترجمة في اللغات الأربع + تصنيف `NONE`/`PARTIAL`/`FULL` + تصيير فعلي بالمكوّن عبر `react-dom/server` (بلا DOM، بلا اعتماديات جديدة). **حزمة الويب الكاملة 73/73** (7 ملفات). أُضيف alias `@` إلى `packages/web/vitest.config.ts` (مطابق `vite.config.ts`) ليصيّر الاختبار مكوّناً حقيقياً.
- **الحزمة الكاملة للخادم:** 1619 حالة، 1618 نجحت؛ الفشل الوحيد `sec04b-entity-read-access.test.ts` (حالة دليل الموردين حسّاسة للتوازي على قاعدة مشتركة؛ **12/12 منفردة** — ليست انحداراً). `tsc` (server+web) نظيف.
- **التوافقية:** بلا تغيير في `createRefund`/`completeRefundWithEvidence`/المخطط؛ بلا Migration جديدة. طبقة القراءة لا تكتب شيئاً.
- **التوثيق:** §19 في `docs/GAP_REGISTER.md` (`M2.4-REFUND-SUBORDER` → **PARTIAL — T2.1 + T2.2 + T2.3 + T2.4**) + `docs/M2.4-T2.4_REFUND_ATTRIBUTION_VIEW.md`.
- **حدود:** لا Wallet/clawback، لا إنشاء/إتمام استرداد من هذه الواجهة، لا مزوّد خارجي فعّال، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

## WASIT-EXECUTION-M2.5-T3 — تدقيق اتساق حالة الدفع وإغلاق الفجوة (2026-11-16)

- **النوع:** تدقيق قراءة + إغلاق إداري + توثيق. **بلا تعديل منطق تطبيق، بلا Migration، بلا Seed، بلا كتابة على قواعد البيانات، بلا Git مُغيِّر (بلا commit/stage/push).** الحاوية `wasit-m243-test-pg` لم تُمَس.
- **الغرض:** التأكد أن `orders.payment_status` (دلالة النجاح في `countSellerTransactions`) لا يختلف اختلافاً مؤثّراً عن `transactions.status`.
- **النتيجة:** كل انتقال يمسّ النجاح يكتب الحقلين **معاً في نفس الدالة** (`applyPaymentSucceeded`: `:798,812`؛ `applyPaymentFailed`: `:852,851`؛ الاسترداد: `:1037,1026`؛ الدفع اليدوي الإداري يمرّ عبر `applyPaymentSucceeded`؛ Webhooks تُفوّض). **إلغاء/انتهاء الصلاحية:** لا كاتب لأي حقل (`CANCELLED`/`EXPIRED` قيم نية دفع فقط). **التسوية** تكتب `settlementStatus` فقط. الحالة الابتدائية `UNPAID`/`PENDING` ليست نجاحاً.
- **اختبارات التدقيق:** أُضيفت **4** اختبارات اختلاف صناعي (`orders=PAID`+`tx=PENDING` ⇒ ناجح؛ `orders=REFUNDED`+`tx=PAID` ⇒ غير ناجح؛ قديم `orders=PAID`+`tx=FAILED` ⇒ ناجح؛ `orders=UNPAID`+`tx=PAID` ⇒ غير ناجح). الملف: `packages/server/tests/m25-tx-seller-attribution.test.ts` ⇒ **18/18** ✅ (14 من T2 + 4 من T3).
- **التراجع:** `payments`(19)/`money-path-invariants`(6)/`verification-trust`(11)/`analytics`(15)/`revenue`(16) ✅ + `tsc` (server+web) نظيف ✅.
- **لقطات الثقة:** **لم تُعَد حساب أي لقطة تاريخية** في `trust_scores` (D3).
- **القرار:** `M2.5-TX-SELLER-ATTRIBUTION` → **`CLOSED`** (§13 + §22 في `docs/GAP_REGISTER.md`)؛ العدّاد: **المفتوحة 21 → 20** و**المغلقة 38 → 39**.

## WASIT-EXECUTION-M2.5-T2 — تنفيذ إسناد معاملات الثقة لكل بائع (2026-11-16)

- **النوع:** تنفيذ + اختبار + توثيق. **بلا Migration، بلا Seed، بلا Git مُغيِّر (بلا stage/commit/push)، بلا لمس أي قاعدة DEMO/إنتاج/اختبار.** الحاوية `wasit-m243-test-pg` لم تُمَس.
- **القرارات المعتمدة:** D1 إسناد لكل بائع · D2 اشتقاق من `seller_orders` + احتياطي للبائع الواحد فقط، واستبعاد القديم المختلط · D3 لا إعادة حساب جماعية · D4 حصر التغيير بمسار قراءة الثقة.
- **ملف جديد:** `packages/server/src/lib/seller-attribution.ts` — `countSellerTransactions(db, sellerIds)` (قراءة فقط): عدّ من `seller_orders` (النجاح = `orders.payment_status='PAID'`، دفعة واحدة) + احتياطي `orders` بلا فرعية + `NOT EXISTS suborder` (منع الازدواج) + استبعاد المختلط غير القابل للإسناد + إزالة التكرار/الفراغ.
- **تعديل:** `packages/server/src/lib/trust-engine.ts` — استُبدل استعلاما `transactions.sellerId` بنداء واحد `countSellerTransactions(db, [userId, ...ownedSellers])`؛ أُزيل استيراد `transactions`/`inArray`؛ **معادلة الدرجة/الأوزان/الحدود/الشارات دون تغيير**.
- **الأدلة:** `packages/server/tests/m25-tx-seller-attribution.test.ts` (جديد) **14/14**؛ تراجع `verification-trust`(11)+`analytics`(15)+`revenue`(16)=**42/42**؛ الحزمة الكاملة للخادم **1631/1633** (الفشلان `p6-p7-dispute-webhook` و`sec04b-entity-read-access` نجحا منفردين **31/31** — سباق قاعدة مشتركة، لا انحدار)؛ `tsc` نظيف للخادم والويب.
- **حدود:** لا تغيير على `transactions.sellerId` كتابةً؛ اللقطات التاريخية في `trust_scores` تبقى كما هي (D3)؛ القديم المختلط يبقى غير مُسنَد.
- **الحالة:** الفجوة **`IN_PROGRESS`** (لا إغلاق قبل التحقق الكامل). التفاصيل: §12 في `docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md`.

## WASIT-EXECUTION-M2.5-T1 — تصميم إسناد المعاملات والثقة لكل بائع (Discovery & Design) (2026-11-16)

- **النوع:** اكتشاف وتصميم (READ-ONLY). **بلا تعديل كود، بلا Migration، بلا Seed، بلا لمس أي قاعدة، بلا Git مُغيِّر.** الحاوية `wasit-m243-test-pg` لم تُمَس.
- **الفجوة:** `M2.5-TX-SELLER-ATTRIBUTION` (§13) — تبقى **`OPEN`** (لا إغلاق).
- **المشكلة المؤكَّدة من الكود:** الطلب متعدّد البائعين يُسجَّل بصف `transactions` **واحد** يُنسب لبائع واحد — الكاتب الوحيد `modules/orders/service.ts:358` (`sellerId: soleSeller ?? firstProduct.sellerId`)؛ والطلب المختلط `soleSeller = null` ⇒ يُنسب لبائع أول المنتجات.
- **القرّاء (حصر كامل، آلي):** موضعان فقط — `lib/trust-engine.ts:84` و`:100` (يترجمان إلى `totalTransactions`/`successfulTransactions` في درجة الثقة، ثم لقطة `trust_scores`). **لا يوجد** ترتيب/شارات بائعين تقرأ الحقل.
- **لا أثر مالي:** كل التحليلات/GMV/العمولة/التسوية/الدفتر/التقارير/المخاطر تقرأ `seller_orders`/`orders`/الدفتر بمفاتيح `transaction.id`/`order_id`، لا `transactions.sellerId`. الأثر محصور في **الثقة**.
- **الحل الموصى به (بلا Migration):** الاشتقاق للقراءة من `seller_orders` (كل بائع يُحتسب نصيب فرعيته) + احتياطي للطلبات القديمة بلا فرعية (`orders.sellerId`) بشرط `NOT EXISTS suborder` لمنع الازدواج. الطلبات المختلطة القديمة لا تُخمَّن. **لا تغيير في `transactions.sellerId` كتابةً.**
- **البدائل المرفوضة:** عمود مصفوفة `sellerIds`؛ صف `transactions` لكل فرعية (يكسر النموذج المالي)؛ الإبقاء على «البائع الأول»؛ الاعتماد على `orders.sellerId` وحده (فارغ في المختلط)؛ تعبئة رجعية لـ`seller_orders` (اختراع بيانات تاريخية).
- **قرارات تحتاج موافقة:** تغيير دلالة عدّ الثقة (D1)، الاحتياطي مقابل backfill (D2)، إعادة حساب الثقة (D3)، حصر النطاق بالقراءة (D4).
- **الاختبارات المخطَّطة:** 11 سيناريو (بائع واحد/بائعان/ثلاثة؛ بائع بلا فرعية؛ بيانات قديمة كاملة/ناقصة/متضاربة؛ عدم مضاعفة GMV؛ ثبات الدفتر؛ عزل/IDOR؛ عدم تغيير بقية عوامل الثقة) — **لم تُشغَّل** (تصميم فقط).
- **التوثيق:** `docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md` (جديد) + §21 في `docs/GAP_REGISTER.md`.

## WASIT-EXECUTION-M2.4-CLOSE — إغلاق فجوة الاسترداد لكل بائع (M2.4-REFUND-SUBORDER) (2026-11-16)

- **النوع:** مراجعة تحقّق وإغلاق إداري + توثيق. **بلا تعديل منطق تطبيق، بلا Migration، بلا Seed، بلا Git مُغيِّر.**
- **القرار:** `M2.4-REFUND-SUBORDER` انتقلت **`PARTIAL` → `CLOSED`** بعد مطابقة **11 شرطاً** مقابل الكود والاختبارات الفعلية (لا التقارير). المصفوفة الكاملة في `docs/GAP_REGISTER.md` §20.1.
- **أبرز الأدلة:** تخصيص فعلي لكل فرعية (`refund_allocations`, Migration 0040) · احتساب `COMPLETED` فقط · السقف `items_total + buyer_commission` · عكس العمولة **مقروء من الدفتر** · عدم مسّ عمولة بائع لم يُسترد · idempotency · منع تسوية الفرعية `REFUNDED` (`evaluateSuborderRow`) · مسار `REFUND_MANAGE` (ADMIN/SUPER_ADMIN) · لا IDOR (`PAYMENT_READ` لا يفتحه) · الواجهة قراءة فقط.
- **الاختبارات المُشغَّلة فعلياً (2026-11-16):** `m24-t21` **13/13** · `m24-t22` **14/14** · `m24-t23` **7/7** · `m24-t24` (خادم) **11/11** = **45/45** · `m24-t24` (ويب) **12/12** ضمن الحزمة الكاملة **73/73** · `tsc` (server+web) نظيف. البيئة: `wasit_test` @127.0.0.1:5434 (حاوية `wasit-m243-test-pg`).
- **العدّ (§1):** «المغلقة» **33 → 38** و«المفتوحة» **20 → 21**. **تنبيه:** سلسلة M2 (§13–§19) كانت موثَّقة لكنها **لم تكن مُحتسبة في §1**؛ أُدرجت الآن صراحةً ⇒ القفز يعكس **إدراج 4 بنود M2 مغلقة سابقاً + إغلاق M2.4**، وليس 5 إغلاقات جديدة.
- **ناقص متبقٍّ:** `sec04b-entity-read-access` حسّاس للتوازي على قاعدة مشتركة (سباق ترقيم صفحات؛ **12/12 منفردة**) — سباق في مُهيّئ الاختبار لا في منطق M2.4/الإنتاج.
- **التوثيق:** §20 (سجل الإغلاق) + §21 (تعريف المهمة التالية) + §1 + §13 + §19 في `docs/GAP_REGISTER.md`.
- **المهمة التالية (تعريف فقط، بلا تنفيذ):** `M2.5-TX-SELLER-ATTRIBUTION` — إسناد `transactions.sellerId` لبائع واحد (`soleSeller ?? firstProduct.sellerId`، `orders/service.ts:358`) بينما `trust-engine.ts` (سطور 84/100) يقرأه لمجاميع الثقة ⇒ تضخّم ثقة بائع واحد وإهمال الآخرين في الطلب المختلط. لا أثر مالي (التحليلات تقرأ `seller_orders`). التصميم المقترح: الاشتقاق من `seller_orders`. لا يبدأ في هذه الجولة.

## WASIT-EXECUTION-014 — إغلاق PR-05 (حاسبة الأعمال `/tools/calculator`) (2026-11-03)

- **الفجوة المُغلقة:** `PR-05` (§4 في `docs/GAP_REGISTER.md`) — `/tools/calculator` غير منفَّذ. انتقلت **PENDING → COMPLETE_VERIFIED**.
- **ما نُفِّذ:** صفحة عامة `BusinessCalculatorPage` على `/tools/calculator` + منطق صرف معزول `packages/web/src/lib/business-calculator.ts` يعكس نموذج رسوم الطلب الفعلي (`orders/service.ts`): عمولة البائع والمشتري على المجموع، رسوم الدفع على البائع، `buyerTotal = المجموع + عمولة المشتري`، `sellerNet = المجموع − عمولة البائع − رسوم الدفع`، تقريب 4 منازل (half-up) كبقية المنصة.
- **النسب:** افتراضية قابلة للتعديل = سياسة القاعدة الموثّقة (4% عمولة: 2% بائع + 2% مشتري، و2% رسوم دفع). **موسومة صراحةً** كقيم افتراضية لا كالسياسة الحيّة (`commission_policies`/`payment_fee_policies` تُدار من DB) — لا ادّعاء بأنها السعر النهائي.
- **الرفض:** سعر/كمية غير موجبين، كمية غير صحيحة، نسب سالبة، أو تركيبة تُفرغ صافي البائع → رسالة «قيم غير صالحة» بلا أرقام مضلّلة.
- **الوصول:** رابط في تذييل الموقع (`PublicLayout` → `nav.businessCalculator`) + مسار عام في `App.tsx`.
- **الاختبارات:** `packages/web/tests/business-calculator.test.ts` **10/10** معزول (بلا DB/DOM: نموذج المال، الرفض، عقد الترجمة في اللغات الأربع) + `e2e/business-calculator.spec.ts` **4/4** متصفّح حقيقي بلا DB (`playwright.tools.config.ts`) + كامل حزمة الويب **61/61** + Typecheck الويب نظيف + Build ناجح.
- **بلا Migration/Seed/DB، بلا تغيير على أي مسار قائم، بلا Git مُغيِّر.** العدّ: «المفتوحة» 21 → **20**، «المغلقة» 32 → **33**.

## WASIT-EXECUTION-T3-R1 — دورة حياة إثبات الاسترداد + تثبيت E2E (2026-11-18)

- **النوع:** إصلاح اختبارات فقط (E2E) + استعادة البيئة. **بلا تعديل كود إنتاج، بلا Migration، بلا Seed، بلا Git مُغيِّر.** قاعدة معزولة `wasit_test`/`wasit_dev` على `127.0.0.1:5434`.
- **استعادة البيئة:** الحاوية أُعيد إنشاؤها فلم تكن Postgres قائمة ولا Playwright browsers مثبّتة. أُعيد تشغيل `dockerd`، وإنشاء حاوية `wasit-m243-test-pg` (postgres:16 على `127.0.0.1:5434` فقط)، وقاعدتا `wasit_test`+`wasit_dev`، ثم `db:migrate` + `seed` + `seed-demo`، و`npx playwright install chromium`. **لا DB reset/drop/push لأي بيانات قائمة، ولا لمس لأي قاعدة خارج 5434.**
- **القاعدة المالية المحفوظة (لم تُمسّ):** `completeRefundWithEvidence` هو الكاتب الوحيد لإكمال الاسترداد؛ مزوّد offline/manual/demo **لا يثبت حركة الأموال** ⇒ يبقى `REQUESTED` (لا تسوية، لا قيد، لا تغيير طلب). الإكمال فقط بإثبات خارجي موثوق.
- **جديد:** `e2e/refund-evidence.ts` — مُساعِد اختباري يستدعي الدالة الحقيقية `completeRefundWithEvidence` (عبر `pg`/drizzle لمرة واحدة) + `latestRefundForOrder` لقراءة `/api/payments/orders/:id/refunds`.
- **مُعدَّل:** خمسة اختبارات E2E (`admin-refunds` · `payments` · `dispute-refund` · `financial-audit` · `settlement-integrity`) + `playwright.config.ts` (سقوف محدّد المعدّل لعمليّة E2E فقط؛ أُضيف `RATE_LIMIT_VIDEO_MAX: '500'`). المحدّد الحقيقي يبقى مُختبَراً بالسقوف الإنتاجية في `tests/rate-limit*.test.ts`.
- **النتائج:** الخادم **131 ملفاً/1672 اختباراً ناجح** · E2E **235 ناجح/4 فاشل/8 متخطّى (0 سلسلة 429)** · الاسترداد **18/18** · `tsc` (server+web) نظيف.
- **أعطال باقية (سابقة، خارج نطاق الاسترداد):** `admin-ai:37` (حارس منع الموافقة الذاتية 403) · `admin-finance:240` (بوابة تسوية Payout 409) · `functional-audit:68` (حقلان `commissionSellerRate`/`commissionBuyerRate` مفقودان من ردّ `POST /api/orders` ⇒ NaN) · `order-lifecycle:102` (`aggregateParentStatus` يطوي `DELIVERED` إلى `SHIPPED`).
- **بوابة السلامة:** `master` @ `98c3a958…` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0. التفاصيل: `docs/WASIT_EXECUTION_REGISTER.md` §10.

## WASIT-EXECUTION-T3-R2 — إصلاح الأعطال الأربعة المتبقية في E2E (2026-11-19)

- **النوع:** إغلاق الأعطال الأربعة الباقية بعد T3-R1 بإثبات تكامل تشغيلي حقيقي. تعديلا إنتاج اثنان **يُعيدان سلوكاً كان في `HEAD`** (انحداران من إعادة كتابة الطلب متعدد البائعين M2)، والباقي اختبارات فقط. **بلا Migration، بلا Seed، بلا Git مُغيِّر.** قاعدة معزولة `wasit_test`/`wasit_dev` على `127.0.0.1:5434`.
- **بوابة السلامة:** `master` @ `98c3a958a0faa7e1bf174e33900d3c298578b4aa` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0 · Modified 126 · Untracked 144 — مطابق لإغلاق T3-R1.
- **العطل 1 — `admin-ai.spec.ts:37` (403 موافقة ذاتية):** حارس **فصل المهام** في `agents.ts` (`decideAgentTask`) صحيح ومقصود (طالب المهمة لا يعتمدها). **اختبار فقط:** إنشاء المهمة بمعتمِد مستقل (`admin2`) واعتمادها من الواجهة. أُضيفت 3 اختبارات انحدار (رفض الموافقة الذاتية 403 + نجاح معتمِد مستقل + رفض من لا يملك `ai:manage`).
- **العطل 2 — `admin-finance.spec.ts:240` (409 دفعة):** بوابة التسوية (M2.3) تتطلّب سطر بائع **مُسلَّماً ومُسوَّى**. **اختبار فقط:** تسليم الطلب بمزود البائع عبر مسار الحالة الرسمي (`CONFIRMED→PROCESSING→SHIPPED→DELIVERED`) + تأكيد التسوية + `reconcile` للفروع (كلها مسارات إنتاج). أُضيف اختبارا انحدار (منع الدفعة المزدوجة، ورفض دفعة لسطر غير مُسوَّى). القاعدة المالية لم تُمسّ.
- **العطل 3 — `functional-audit.spec.ts:68` (NaN):** **انحدار عقد API** — إعادة كتابة M2 أَسقطت `commissionSellerRate`/`commissionBuyerRate` من ردّ `POST /api/orders`. **إصلاح إنتاج:** أُعيدا إلى كائن الإرجاع وسجل التدقيق في `orders/service.ts`. اختبار خادم جديد: `tests/order-commission-rate-fields.test.ts` (مفرد + متعدد البائعين).
- **العطل 4 — `order-lifecycle.spec.ts:102` (الأب يعلق عند SHIPPED):** **انحدار M2** — `aggregateParentStatus` كان يطوي `DELIVERED` داخل `SHIPPED`. **إصلاح إنتاج:** فرع `DELIVERED` فوق `SHIPPED`. حالة خادم جديدة في `tests/m2-multi-seller-order.test.ts`.
- **النتائج:** الخادم **132 ملفاً / 1675 اختباراً ناجح** (منها الجديدان) · E2E الكامل **243 ناجح / 0 فاشل / 8 متخطّى** · `tsc` (server+web) نظيف · Build ناجح.
- **التوثيق:** `docs/WASIT_EXECUTION_REGISTER.md` §11 (الجلسة كاملة + بوابة السلامة بعدها).

## WASIT-EXECUTION-T3-CLOSE — التحقق النهائي وإغلاق سجل التكامل (2026-11-19)

- **النوع:** READ-ONLY توثيقي بحت. **لا إعادة تشغيل لاختبارات مُثبتة، لا تعديل كود تطبيق أو اختبار، لا Migration، لا Seed، لا تعامل مع قواعد بيانات قائمة، لا Git مُغيِّر.**
- **بوابة السلامة:** `master` @ `98c3a958a0faa7e1bf174e33900d3c298578b4aa` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0 · Modified 127 · Untracked 145 (172 بـ`-uall`). قاعدة الاختبار معزولة `wasit_test` @127.0.0.1:5434.
- **أدلة تكامل PostgreSQL الأربعة (كلها مُثبتة وموجودة في الحزمة الخضراء لـT3-R2):** (1) **Live write/read** — `settlement-ledger` · `persistence-invariants` · `m22-t2-suborder-payout` (خدمات إنتاج على DB حقيقي بلا mock)؛ (2) **Rollback** — `order-confirmation-payment-guard:373` (فشل خصم المخزون ⇒ رجوع كامل، الطلب يبقى `PENDING`)؛ (3) **FK enforcement** — `m22-t2-suborder-payout:292` (`payouts_suborder_fk`) · `m23-t2-suborder-settlement:365` (FK `(transaction_id, parent_order_id)`) · `m24-t21-refund-allocation-schema:207`؛ (4) **Concurrency single-winner** — `ai0232-concurrency:127` (سباق حقيقي عبر اتّصالين مستقلّين `db`/`dbB`) + `ai01-agent-scheduling`/`ai023-dispatch`/`m23-t2-suborder-settlement:282`.
- **آلية العزل:** `tests/setup.ts` (إعادة إنشاء `wasit_test` + migrate + seed) و`tests/test-db-guard.ts` (يرفض أي هدف غير `127.0.0.1:5434/wasit_test`) ⇒ إثبات أن الحزمة حيّة على PostgreSQL حقيقي.
- **ملخّص T3-R1/T3-R2:** T3-R1 (131 ملفاً/1672 اختباراً · E2E 235/4/8) · T3-R2 (132 ملفاً/1675 اختباراً · E2E 243/0/8 · `tsc` نظيف · Build ناجح).
- **القرار:** **T3 = `COMPLETED`** — أُغلق إدارياً في `docs/WASIT_EXECUTION_REGISTER.md` (§1 صف T3 + فكّ `B-09` في §5 + §12 سجل الإغلاق). **لا تغيير على `GAP_REGISTER.md`** (T3 ليست فجوة مُدرجة فيه).
- **أول مهمة PENDING تالية:** **`T1` — تثبيت الرؤية ونطاق MVP في وثيقة رسمية (قرار GM)**. **السبب:** كل المسارات تعتمد على نطاق مثبّت، وهي الخطوة التالية المنطقية بعد إغلاق التكامل (T3)؛ T4/T5 جارية وT6 محجوبة بمزوّدين/بنك.
- **التوثيق:** `docs/WASIT_EXECUTION_REGISTER.md` §12 (الجلسة كاملة).

## WASIT-EXECUTION-T1.1-CORRECTION + T1.2 — ميثاق GM للرؤية ونطاق MVP (2026-11-19)

- **النوع:** توثيقي بحت. تصحيح استراتيجي لنتائج T1.1 + إعداد ميثاق GM (T1.2). **لا تطوير، لا تعديل كود، لا Migration، لا Seed، لا Git مُغيِّر.** لا إعادة تدقيق شامل.
- **بوابة السلامة:** `master` @ `98c3a958a0faa7e1bf174e33900d3c298578b4aa` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0 · Modified 127 · Untracked 145.
- **التصحيح الاستراتيجي المعتمد:** **منظومة الوكلاء المتخصصين (20 Agent) ركيزة أساسية** من رؤية WASIT — **ليست** ميزة ثانوية ولا بند «LATER». التنفيذ التدريجي مقبول، لكن بناء المنظومة العشرين **هدف أساسي**.
- **وضع الوكلاء الحقيقي (بلا افتراضات):** **11/20** موجودون تقنياً (`AGENT_CATALOGUE` + executors + مسارات + بوابة `requireAction` + موافقة بشرية لستة منهم) — لكنهم **قراءة/توصية فقط** (`db.insert/update/delete = 0`) وبمزوّد `local-heuristic` (**ليس LLM حقيقي**). **9/20 = `NOT DEFINED`** (لا تعريف في المستودع؛ `AD-043` يؤكّد الكود يضم 11). حدود إضافية: لا Tool Gateway · لا Kill Switch · لا ذاكرة · `scope.ts` بلا مستدعٍ.
- **مسارات الاستكمال:** R1 (تشغيل الـ11 بمزوّد LLM) → R2 (+5) → R3 (+4) → R4 (Tool Gateway/Kill Switch/Copilot). **⚠️ مُحدَّث في T1.2-R2 أدناه:** قائمة التسعة المقترحة **أُلغيت** (لم تكن مرجعاً معتمداً) واستُبدلت بمصفوفة التخصصات المرجعية الثمانية.
- **جديد:** `docs/T1.2_GM_MVP_CHARTER.md` — ميثاق GM (12 قسماً): الرؤية · نموذج B2B+B2C · منظومة الوكلاء العشرين (تقييم/سجل مرجعي مقترح/أهداف R1–R4) · حدود MVP/Closed Pilot · القدرات · المشمول/المستبعد · دور GM · الضوابط · شروط الانتقال · القرارات · الاقتراح النهائي.
- **الحالة:** **T1 يبقى `PENDING`** — مسودة القرار جاهزة للاعتماد. تحديث §1 (T1) + §4 (P-01) + §13 في السجل. لا تغيير على `GAP_REGISTER.md`.
- **التوثيق:** `docs/T1.2_GM_MVP_CHARTER.md` + `docs/WASIT_EXECUTION_REGISTER.md` §13.

## WASIT-EXECUTION-T1.2-R2 — تصحيح الميثاق ومواءمة معمارية الوكلاء (2026-11-19)

- **النوع:** توثيقي بحت. إغلاق تصحيحات T1.2-R1 الأربعة. **لا كود، لا DB/Migration/Seed، لا Git مُغيِّر، لا إعادة Audit شامل.**
- **بوابة السلامة:** `master` @ `98c3a958a0faa7e1bf174e33900d3c298578b4aa` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0 · Modified 127 · Untracked 146.
- **التصحيحات المُغلقة:** (1) الوكلاء العشرون ركيزة أساسية **تدريجية داخل R1–R4** — **التدريج ≠ تأجيل**؛ أُزيلوا من «المستبعد» (§7). (2) **Global-first** صريح: «تونس أول سوق تشغيلي، لا قاعدة مضمّنة؛ الدولة/العملة/الجغرافيا قابلة للتكوين». (3) **إلغاء قائمة التسعة المقترحة** واستبدالها بمصفوفة **التخصصات المرجعية الثمانية** (Finance · Payment & Settlement · Compliance · Operations · Customer Intelligence · Outreach · Merchant · Supplier). (4) §3.5 **فصل الاختصاصات** (Risk↔Fraud-Monitor · B2B↔Supplier-Outreach) + «لا تتشارك الصلاحيات؛ التعاون عبر إحالة مهام منظّمة».
- **إفصاح دقّة حاسم:** **«مخطط الفرق الستة» و«التخصصات الـ19» غير موجودَين في المستودع** (فُحص `docs/` + كل الصور/المرفقات = صفر). المصادر المرجعية الفعلية: `AI_ARCHITECTURE.md §3` · `WASIT_ADMINISTRATIVE_PLATFORM_GUIDE.md §23.أ` · `WASIT_MASTER_PRODUCT_AUDIT.md §7.1` (كلها **11 وكيلاً**). ⇒ **لم يُخترع «الوكيل العشرون»، ولم يُحذف أي تخصص؛ هويته غير محسومة وتنتظر تسليم المرجع.**
- **قائمة الـ20:** **لا تُعتمد اسمياً** قبل حسم التخصص العشرين وتداخلات الاختصاص. الـ11 الحاليون **بلا تغيير**.
- **الحالة:** **T1 يبقى `PENDING`** بانتظار اعتماد GM + تسليم المرجع. لا تغيير على `GAP_REGISTER.md`.
- **التوثيق:** `docs/T1.2_GM_MVP_CHARTER.md` (§1/§3.2–3.5/§4/§7/§11.2/§12) + `docs/WASIT_EXECUTION_REGISTER.md` §14.

## WASIT-EXECUTION-A0 — جرد الوكلاء الحقيقي وتدقيق الواقع (2026-11-19)

- **النوع:** READ-ONLY بالكامل. **لم يُكتب أي ملف.** لا Git مُغيِّر، لا تشغيل اختبارات/خدمات.
- **النتيجة:** **11 وكيلاً فقط** في `AGENT_CATALOGUE` (لا فئات/مصانع/تعريف ثانٍ). لا «وكيل رقم 20» في الكود.
- **المستوى:** كل الـ11 = **`L4`** (لا `L5`) — لأن `agent_metrics` (متابعة النتائج) غير مستخدم، والمزوّد `local-heuristic`.
- **البيانات/الأدوات:** كلهم يقرأون DB حيّة؛ **لا كتابات**؛ `allowedTools=[]` (لا أدوات)؛ لا Tool Gateway.
- **البنية:** IMPLEMENTED = Runtime/Orchestrator/Supervisor/RBAC/Approval/Scheduling/Retry-Recovery/Handoff/Audit/Cost. NOT IMPLEMENTED = Tool Gateway/Kill Switch. PARTIAL = LLM Provider (لا LLM حقيقي) · Memory (غير موصول) · Monitoring (`agent_metrics` غير مستخدم) · Inter-agent (عبر Orchestrator فقط).
- **غير موصول:** `scope.ts` (اختبار فقط) · `agent_memory` · `agent_metrics`.

## WASIT-EXECUTION-T1.2-R3 — تثبيت المرجع الرسمي (6 فرق / 19 تخصصاً) ومطابقة A0 (2026-11-19)

- **النوع:** توثيقي بحت (Docs-only). **لا كود، لا اختبارات/Builds، لا DB/Migration/Seed، لا Git مُغيِّر.**
- **بوابة السلامة:** `master` @ `98c3a958a0faa7e1bf174e33900d3c298578b4aa` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0 · Modified 127 · Untracked 146.
- **المرجع الرسمي المُثبَّت (الميثاق §3.2):** **19 تخصصاً على 6 فرق** — TECH (1: Development) · FINANCE (2: Finance, Payment & Settlement) · TRUST & RISK (3: Risk, Dispute, Compliance) · OPERATIONS & CUSTOMER SERVICE (4: Support, Customer Intelligence, Analytics, Operations) · MARKETING & GROWTH (4: Marketing, Advertising, Outreach, Market Research) · COMMERCE & SALES (5: Sales, Product, Merchant, Supplier, B2B).
- **مطابقة A0 (الميثاق §3.3):** **موجود=11** (Sales · Marketing · Advertising · Product · Support · Analytics · Market Research · B2B · Risk · Dispute · Development) · **ناقص=8** (Finance · Payment & Settlement · Compliance · Operations · Customer Intelligence · Outreach · Merchant · Supplier) · **`Agent #20 = UNDECIDED`**.
- **تمييز الجاهزية (الميثاق §3.4):** A موجود ✅ (11/11) · B مكتمل تخصصياً 🟡 (جزئي) · C قابل للتشغيل ✅ · D متصل بأدوات ❌ (0/11) · E مستقل ضمن حدود ❌ (0/11). ⇒ **الـ11 ليسوا مكتملين تشغيلياً رغم `L4`.**
- **قيود مُحترمة:** لا تخصصات غير معتمدة أُضيفت (Fraud Monitor وأمثاله **خارج المرجع الـ19** ⇒ مرفوض)؛ لا وكيل قائم حُذف؛ لا اختراع لـ`Agent #20`.
- **الحالة:** **T1 يبقى `PENDING`** بانتظار اعتماد GM + حسم `Agent #20`. لا تغيير على `GAP_REGISTER.md`.
- **التوثيق:** `docs/T1.2_GM_MVP_CHARTER.md` (§3.2–3.6/§4/§11.2/§12) + `docs/WASIT_EXECUTION_REGISTER.md` §15.

## WASIT-AI-COMPANY-A1 — مفتاح إيقاف الذكاء الاصطناعي المركزي (2026-11-19)

- **النوع:** ضابط أمان تنفيذي (أول مهمة في خارطة WASIT AI Company). **لا Migrations ولا جداول جديدة.** لا يمنح أي صلاحية جديدة.
- **بوابة السلامة:** `master` @ `98c3a958…` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0.
- **التصميم:** مفتاح منطقي **مركزي واحد** في `packages/server/src/lib/ai/kill-switch.ts`، **يفشل مغلقاً** (fail-closed) و**لا يعتمد على الـLLM**. الحارس `assertAiExecutionEnabled()` يرمي `ApiError` (503 `SERVICE_UNAVAILABLE`)؛ الفحص `isAiExecutionBlocked()` للفروع التي تسجّل رفضها.
- **نقاط التنفيذ المحمية:** `createAgentTask` · `decideAgentTask` (APPROVE) · `planAgentRun` · `dispatchStep` · `runDueAgentSchedules` · `runSupervisorCycle` · `retryStep` · `recoverStuckSteps` · `recoverRun` · **`runAIFeature` (الشبكة الأعمق — كل استدعاء مزوّد)**.
- **الفحص عند كل خطوة، لا عند البداية فقط:** Run متعدد الخطوات يتوقف قبل الخطوة التالية، ويستأنف بعد التفعيل **بلا إعادة تنفيذ مزدوجة** (الإيقاف يرفض قبل أي انتقال حالة).
- **التحكم:** `GET/POST /api/admin/ai/kill-switch`، محكوم بـ`AI_MANAGE | ADMIN_AI` (SUPER_ADMIN وADMIN يتحكمان؛ CUSTOMER 403؛ غير مصادَق 401). مفتاح الإيقاف عبر واجهة `AdminAiPage` (تبويب «نظرة عامة»).
- **المُهيّئ:** `AI_AGENT_EXECUTION_ENABLED` (افتراضي `true`) — لا تغيير في السلوك الحالي.
- **التدقيق:** `AI.KILL_SWITCH_DISABLED/ENABLED` (واجهة) + `AI.KILL_SWITCH_{SCHEDULE,SUPERVISOR,RECOVERY}_REFUSED` (اجتياحات خلفية، سجل واحد لكل دورة). لا secrets.
- **BLOCKED:** الإيقاف عبر نسخ متعددة (fleet-wide) يحتاج جدول إعدادات مشترك + Migration ⇒ مؤجّل بقرار GM. الحالة حالياً **عامة على مستوى العملية** ولا تستمر عبر إعادة التشغيل (تُعاد إلى قيمة env).
- **الاختبارات:** `tests/a1-kill-switch-unit.test.ts` (6 ✅) + `tests/a1-kill-switch.test.ts` (13 ✅). **بلا regressions:** 268 اختبار AI قائم ناجح.
- **التوثيق:** `docs/AI_KILL_SWITCH.md`.

## WASIT-AI-COMPANY-A2 — فرض نطاق الوكلاء في الإنتاج (2026-11-19)

- **النوع:** ضابط أمان تنفيذي (المهمة الثانية في خارطة WASIT AI Company). **لا Migrations، لا جداول جديدة، لا صلاحيات جديدة، لا Tool Gateway، لا LLM حقيقي، لا Memory.** لا يُعيد كتابة أي Executor ولا يُنشئ وكيلاً.
- **بوابة السلامة:** `master` @ `98c3a958…` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0.
- **الفجوة المُغلقة:** `packages/server/src/modules/ai/scope.ts` كان **بلا مستدعٍ إنتاجي** (اختبار فقط). الآن مربوط بمسار الإنتاج عبر `assertRunOwnerScope` في `buildRunContext`.
- **العقد:** وحدة جديدة `packages/server/src/modules/ai/agent-scope.ts` — عقد نطاق موحّد لكل وكيل (هوية · تخصص · مجالات بيانات مسموحة · جداول مسموحة · قراءة فقط · مجالات ممنوعة · لا تفويض · حدود المالك).
- **الفرض المركزي (Server-side):** نقطة التنفيذ الوحيدة `executeAgentTask` تُمرّر `db` مُقيَّداً (`withAgentDataScope`) إلى كل Executor؛ يفحص **كل** `from`/`join` (قراءة) و`insert`/`update`/`delete` (كتابة) ويرفض `execute`/`transaction`/`query`. الواجهة لا تُستخدم للفرض.
- **Fail-closed:** لا سياق · وكيل بلا عقد · جدول خارج النطاق · جدول محظور · كتابة · SQL خام · مالك غائب ⇒ **رفض 403 `AGENT_SCOPE`**. لا توسيع تلقائي.
- **الأقل صلاحية:** كل وكيل من الـ11 له حدّ مستقل مبني على الجداول التي يقرأها فعلاً؛ لا نطاق موحّد واسع. جداول حركة الأموال/الاعتماد/الجلسات/التدقيق **محظورة على الجميع**.
- **منع التجاوز:** المنحة تُقرأ من السياق الموثوق وتُتقاطع مع عقد الوكيل (تضييق فقط)، ولا تُقرأ من `input`؛ لا handoff (`canDelegate=false`).
- **عزل المالك/المستأجر:** `scope.ts` مربوط؛ الجداول المقيَّدة بالمالك (`agent_metrics`/`agent_memory`) تتطلّب نطاق مالك صالحاً. لا توسيع لبيانات عميل لتسهيل تنفيذ وكيل.
- **الاختبارات:** `tests/unit/agent-scope-contract.test.ts` (23 ✅) + `tests/unit/agent-scope-enforcement.test.ts` (9 ✅) + `tests/a2-agent-scope.test.ts` (10 ✅ على PostgreSQL حقيقي). **بلا regressions:** 294 اختبار AI قائم ناجح. `tsc` نظيف.
- **حالة A1:** سليم ولم يتغيّر (10 نقاط حماية + 19 اختبار A1 ناجح).
- **BLOCKED:** أي Executor مستقبلي يحتاج SQL خاماً (`db.execute`) سيُرفض بالتصميم حتى يُمنح مساراً مُدقَّقاً (لا يوجد هذا النوع في الـ11 حالياً).
- **التوثيق:** `docs/A2_AGENT_SCOPE_ENFORCEMENT.md`.

## WASIT-AI-COMPANY-A3 — قياس أداء الوكلاء وتتبّع النتائج (2026-11-20)

- **النوع:** طبقة قياس **للقراءة فقط** (المهمة الثالثة في خارطة WASIT AI Company). **لا Migrations، لا جداول جديدة، لا صلاحيات جديدة، لا Tool Gateway، لا LLM حقيقي، لا ذاكرة جديدة.** لا يُنشئ وكلاء ولا يُوسّع صلاحيات.
- **بوابة السلامة:** `master` @ `98c3a958…` (لم يتغيّر) · Staged 0 · Stash 0 · Deleted 0.
- **الوحدة:** `packages/server/src/modules/ai/agent-metrics.ts` — `buildCompanyMetrics(db, {since, agentKey})` (قراءة فقط، لا تصدّر أي دالة كتابة).
- **نقطة النهاية:** `GET /api/admin/ai/company-metrics` في `modules/admin/ai-routes.ts`، محكومة بـ`AI_MANAGE | ADMIN_AI` + `derivePlatformScope` (ADMIN/SUPER_ADMIN فقط) ⇒ غير مصادَق 401، غير مدير 403.
- **مصادر البيانات:** `agent_tasks` (التشغيلات — مصدر الحقيقة، كل صف = تشغيل واحد) · `agent_registry` (الهوية) · `ai_requests` (الكلفة الفعلية + الرموز + النموذج) · `agent_run_steps` (المحاولات) · `audit_logs` (الاستعادة).
- **لماذا لا تُقرأ `agent_metrics`؟** الجدول مُهاجَر (migration 0033) لكن **بلا كاتب إنتاجي**؛ لا تنضمّ الوحدة إليه إطلاقًا لضمان عدم ازدواج العدّ مستقبلاً.
- **المؤشرات:** تنفيذ (إجمالي/مكتمل/فاشل/معلّق/جارٍ/معدّل نجاح) · أداء (متوسط/وسيط/P95/بطيء/إعادات/استعادة) · كلفة (فعلية من الدفتر، أو «غير متاحة» صراحةً — لا تقديرات) · نتائج (مهام بنتيجة محفوظة؛ النتيجة التجارية = 0 صراحةً) · حالة صحية (`healthy/degraded/failing/idle/no_data`).
- **قواعد الإسناد:** «اكتمال المهمة» ≠ «تحقّق نتيجة تجارية»؛ لا تُنسب نتيجة تجارية دون دليل على تنفيذ توصية الوكيل (لا مصدر دليل حاليًا ⇒ 0). لا تُختلق بيانات لوكيل لم يعمل (`no_data`).
- **النزاهة:** لا مسار كتابة للوكيل؛ التشغيل يُحتسب مرة واحدة؛ إعادات المحاولة لا تُحتسب كتشغيلات؛ الكلفة السالبة/غير الرقمية تُهمَل.
- **الواجهة:** قسم «صحة شركة الوكلاء (AI Company)» داخل تبويب «نظرة عامة» في `AdminAiPage` (دمج، لا واجهة منفصلة).
- **الاختبارات:** `tests/unit/agent-metrics.test.ts` (22 ✅) + `tests/a3-agent-metrics.test.ts` (3 ✅ على PostgreSQL حقيقي، تشمل 401/403). `tsc` نظيف (Server + Web).
- **حالة A1/A2:** لم يُمَس `kill-switch.ts` ولا `agent-scope.ts`/`agent-run-context.ts`/`executors.ts`؛ اختباراتهما كاملة بلا انحدار.
- **BLOCKED:** (1) الكلفة الفعلية صفر/غير متاحة حتى تشغيل مزوّد حقيقي؛ (2) النتيجة التجارية بلا مصدر دليل؛ (3) `agent_metrics` بلا كاتب؛ (4) التجميع العام يتطلّب نطاق منصّة (ADMIN) — مطابق لنموذج A2.
- **التوثيق:** `docs/A3_AGENT_METRICS_OUTCOME_TRACKING.md`.

## OBS-01 — Webhook Failure Recovery (2026-11-20)

- **`lib/payments/webhook-retry.ts`**: تصنيف الفشل + backoff أسي. `TRANSIENT` فقط قابل لإعادة المحاولة؛ `CONFLICT`/`PERMANENT`/`CAPABILITY` تُسدَّل فورًا؛ `STALE` تُسجَّل `PROCESSED` ولا تُطبَّق.
- **`claimWebhookEvent`** (`modules/payments/service.ts`): الإدراج يحمل `claim_token` مباشرة (لا فجوة إدراج→حيازة)، والاستلام `UPDATE … RETURNING` بشرط `status IN ('RECEIVED','FAILED')` + انقضاء الـlease + `next_attempt_at <= now()`. الخاسر يحصل على `inProgress`/`duplicate`/`retryScheduled`/`deadLettered` ولا يطبّق أبدًا.
- **المزوّد هو محرّك إعادة المحاولة**: لا مؤقّت خلفي يطبّق أثرًا ماليًا. أي اختبار يعيد تسليم حدث فاشل **يجب** أن يقدّم `next_attempt_at` (مثال `makeRetryDue` في `tests/p6-p7-dispute-webhook.test.ts`) وإلا يعود `retryScheduled` بلا محاولة.
- **سجل `payment_webhook_attempts`** لكل محاولة (`SUCCESS`/`FAILURE`/`STALE`/`REPLAY`) — لا يحتوي `payload` ولا توقيعًا؛ `GET /api/payments/webhook-failures/:id/attempts`.
- **`replay` مسقوف** بـ`WEBHOOK_REPLAY_MAX` (بعد الاستنفاد 409) ولا يطبّق أثرًا ماليًا؛ يصفّر العدّاد فقط.
- **Migration `0041_flimsy_winter_soldier`** إضافية (أعمدة + جدول + فهرسين) — لا DROP.
- **بيئة الاختبار المحلية**: PostgreSQL 17 على `127.0.0.1:5434`، والدخول عبر `TEST_DATABASE_URL=postgresql://wasit:wasit_test_password@127.0.0.1:5434/wasit_test` (حرّاس `tests/test-db-guard.ts` تمنع أي هدف آخر).
- **إخفاقان بيئيان معروفان في الحزمة الكاملة المتوازية**: `a1-kill-switch` يحسب `ai_requests` عالميًا (يمرّ منفردًا)، و`marketing-video` يحتاج ثنائية `ffmpeg-static` (`node node_modules/ffmpeg-static/install.js`).

## نظام استمرارية العمل — تفاصيل تشغيلية (2026-11-20)

- **الأدوات**: `scripts/session/session-{start,checkpoint,close,status,recovery,backup}.sh` + `lib/session-common.sh`، وواجهة موحّدة `scripts/session/session <subcommand>`، ومقابلات npm: `npm run session:start|checkpoint|close|status|backup|recovery|selftest`.
- **رموز الخروج**: `0` سليم · `1` مرفوض/غير آمن (الأسباب تُطبع) · `3` خطأ استخدام أو لسنا في مستودع.
- **`session-start`** يرفض الحالة إذا: شجرة غير نظيفة، commits غير مدفوعة، متأخر عن البعيد، detached HEAD، stashes، أو تعذّر التحقق من GitHub. `--report-only` للعرض فقط — **لا تستخدمه لتجاوز المنع**.
- **`session-checkpoint`** يرفض افتراضيًا العمل على `master` (استخدم فرع مهمة، أو `--allow-master` للمسار المعتمد fast-forward). يفحص السطور المضافة في الـstaged diff بأنماط أسرار عالية الثقة؛ عند الرفض لا commit ولا push. `--push-only` لإكمال دفع انقطع.
- **`session-close`** يفشل عند: تعارضات، شجرة غير نظيفة، stashes (إلا `--ack-stash`)، commits غير مدفوعة، تعذّر التحقق من البعيد (لا `--no-fetch` للنجاح)، أو ملفات مهمة متجاهَلة (إلا `--ack-ignored`).
- **`session-backup`** يكتب `wasit-<UTC>-<label>.bundle` في `backups/git` (مستثنى من Git) مع `manifest.tsv` (sha256/size/head/branch/refs). **لا يقبل حزمة لا تُستنسخ**: يجري `git clone` تجريبيًا ويقارن HEAD قبل التسجيل. clone ضحل ينتج حزمة تمرّ من `verify` وتفشل عند `clone` ⇒ استخدم `--unshallow` (يضيف كائنات فقط: HEAD/المراجع/الشجرة بلا تغيير). `--prune` وحده يحذف، ولا يحذف ما عمره < 7 أيام.
- **`session-recovery`** يرفض هدفًا موجودًا غير فارغ، ويطلب `--sha256` للـbundle قبل `git bundle verify`. لا يحذف ولا يستبدل شيئًا.
- **ملفات لا يحميها Git أبدًا**: `.env*`، `backups/*.dump`، `packages/server/.wasit-media/`، `e2e/.auth/`، `node_modules/`. تُبلَّغ دائمًا؛ انسخها خارجيًا قبل نهاية الجلسة.
- **الاختبار العملي**: `./scripts/session/session-selftest.sh` (22 فحصًا على فرع اختبار، لا master) — النتائج في `docs/session/08-test-results.md`.
- **الأدلة**: `docs/session/README.md` + 9 أدلة (بداية، checkpoint، إغلاق، استعادة، backup، تعارضات، احتفاظ، نتائج، نسخة خارجية).
- **عزل وسائط الاختبار (2026-11-21)**: `vitest.config.ts` يفرض `MEDIA_STORAGE_DIR=.wasit-media-test` (ويحذف أي قيمة موروثة من الـshell)، و`tests/setup.ts` يمسح المجلد قبل التشغيل وبعده عبر `tests/test-media-dir.ts` (حارس مسار يمنع أي هدف غير `.wasit-media-test`). `LocalMediaStorage` يرمي استثناءً عند `NODE_ENV=test`/`VITEST` إذا أُشير إلى `.wasit-media` الحقيقي — فوسائط المستخدم لا تُلمس. إثبات: `tests/media-storage-isolation.test.ts` (6 حالات، DB-free).

## AI-FIRST COMPLETION (2026-11-22) — وكيل الصيانة + بوابة نطاق المنصة

- **`modules/ai/diagnostics.ts`** (جديد، دوال نقية بلا DB/IO): `classifyFamily` (11 عائلة + `UNKNOWN`)، `failureSignature` (تطبيع UUID/بريد/أرقام ⇒ سبب واحد = بصمة واحدة)، `clusterFailures` (ترتيب بالتكرار + ثقة: 3+=high، 2=medium، 1/UNKNOWN=low)، `proposePatch`، `analyseFailures`، `buildReviewReport`. تُستدعى من `execDevelopmentAgent` فقط؛ لا تكتب شيئاً — المخرجات في `agent_tasks.result`.
- **قاعدة صارمة**: أي مسار في `likelyFiles` يجب أن يكون ملفاً موجوداً فعلاً — `tests/unit/ai-maintenance-rootcause.test.ts` يفحص كل العائلات بـ`existsSync`. لا تُضِف مساراً غير موجود.
- **ما لا يفعله الوكيل ومصرَّح به**: لا تشغيل اختبارات معزولة ولا `apply_patch`/`merge` (لا منفّذ، AD-050). `reviewReport.checklist` يقول `blocked`/`pending_approval` صراحةً بدل تخطّي الخطوة؛ `repairProtocol.blocked` يحمل نفس القائمة.
- **`requiresPlatformScope` صار مفروضاً** في `createAgentTask`: `PLATFORM_SCOPE_ROLES = ADMIN, SUPER_ADMIN`. 11 وكيلاً بعرض المنصة (ads, analytics, b2b, compliance, development, dispute-assistant, finance, market-research, operations, outreach-acquisition, risk) صارت للطاقم فقط، والرفض يُدقَّق `AI.AGENT_RUN_REFUSED`/`PLATFORM_SCOPE_REQUIRED` + metric `blocked` **قبل** كتابة أي صف. لا تُعِد فتحها لعميل/تاجر: A2 يحدّ الجداول لا الصفوف، فأي وكيل بعرض المنصة يقرأ صفوف كل المستأجرين (فلترة الصفوف فجوة مفتوحة، §6.4 في `docs/AI-FIRST-COMPLETION-01.md`).
- **حدود الجداول فقط**: `withAgentDataScope` يتحقق من اسم الجدول؛ لا فلتر صفوف تلقائي. **الفلترة الصفية منفَّذة في المنفّذات**: `execSupportAgent` (خيوط المشارك)، و`execSalesAgent`/`execMarketingAgent`/`execProductAgent` عبر `resolveRequesterScope` (ملكية `suppliers/merchants/companies.user_id` + `orders.buyer_id` + `order_items.seller_id`)، و`execB2BAgent` يرفض غير الطاقم. `execSupportAgent` يفلتر بـ`threads.participant_ids @> [requesterId]` + حصر الرسائل في خيوط المشارك، و`activeUsers = null` لغير الموظفين. أي وكيل آخر يعلن `*:read:own` ويعيد تجميعات منصة هو خلل تصميم لا خطأ في الصلاحية.
- **تشغيل الاختبارات**: `TEST_DATABASE_URL=postgresql://wasit:wasit_dev_password@127.0.0.1:5434/wasit_test npx vitest run` (بلا هذا المتغير يرفض `vitest.config.ts` الإقلاع). الحزمة الكاملة بعد هذه المرحلة: **160 ملفاً / 2068 اختباراً / exit 0**.
- **ملفات الاختبار الجديدة**: `tests/unit/ai-maintenance-rootcause.test.ts` (15)، `tests/ai-maintenance-rootcause.test.ts` (6)، `tests/ai-platform-scope.test.ts` (10)، `tests/ai-video-agent.test.ts` (5)، `tests/unit/ai-video-plan.test.ts` (5)، `tests/ai-support-scope.test.ts` (3).

## AI-FIRST COMPLETION 04 (2026-11-20) — الوكلاء الستة المتبقّون + B2B بالموافقة + تنزيل الفيديو

- **القابلون للتنفيذ 14 → 20** (من 20 مختصاً + المشرف). الستة الجدد: `payment-settlement-agent`، `compliance-agent`، `supplier-agent`، `merchant-agent`، `customer-intelligence-agent`، `operations-agent`. لكل واحد منفّذ حتمي في `executors.ts` + عقد A2 في `agent-scope.ts`.
- **`payment-settlement-agent` لا يمسّ المال**: يقرأ حالة الدفع/التسوية المسجّلة على `orders` فقط؛ `payment_intents`/`payment_webhook_events`/`payouts`/`transaction_ledger` ممنوعة بنيوياً على كل وكيل. المخرجات تحمل `moneyMovement: false` و`blindSpots` صريحة.
- **`compliance-agent` findings فقط**: يقرأ verified/risk/disputes/`country_policy_gaps` ويعيد `findings[]` + `nextStep`، و`findingsOnly: true`. لا حكم ولا إجراء.
- **`supplier-agent`/`merchant-agent` ملكية صارمة**: الكيان يُحدَّد من `userId` للطالب (الطاقم قد يمرّر `entityId`)، وإلا `ENTITY_NOT_FOUND`. لا مراجعة كيان غيره أبداً.
- **`customer-intelligence-agent`**: شرائح RFM من `orders` مقيّدة بـ`orderScope`؛ `customerRef` = SHA-256 مقطوع 10 hex، `pii: 'masked'`. لا معرّف مشترٍ خام في أي حقل.
- **`operations-agent`**: `healthScore` + `blockers[]` من عدّادات حقيقية (طلبات/مهام/تشغيلات/مخزون/رسائل). منصّي.
- **`b2b-agent` تغيير ضمان**: `requiresPlatformScope: true → false`. الفلتر صار **موافقة**: نوع جديد `B2B_PARTNER_DISCOVERY` في `CONSENT_TYPES`. `createAgentTask` تحسب `resolvePartnerConsent()` (لأن `consents` ممنوع على الوكلاء) وتحقنها في `input.__partnerConsent`، **وأي لقطة يرسلها العميل تُحذف**. بدون موافقة الطالب ⇒ `CONSENT_REQUIRED` + `howToGrant`. المنفّذ يرى الموافقين فقط، أدواراً تكميلية، بلا بريد/هاتف/معرّف خام، ومع `reasons[]` و`score`.
- **تحديث اختبارات الضمان**: `ai-platform-scope` (أُخرج `b2b`، أُضيف `payment-settlement`) و`ai-agent-data-scope` (عيّنة «الرفض قبل كتابة صف» انتقلت إلى `compliance-agent`). لا تُعِد `b2b` إلى منصّي بلا إعادة تصميم الفلتر.
- **تنزيل فيديو الوكيل**: `GET /api/ai/tasks/:taskId/video` — بالمعرّف المهمة فقط (المفتاح من `result.advice.video.storageKey`)، مالك أو `ADMIN`/`SUPER_ADMIN`، غير ذلك **404**، `Range` ⇒ **206**، `private, no-store`، تدقيق `AI.AGENT_VIDEO_DOWNLOADED`. لا مجلد عام ولا رابط موقّع.
- **احتفاظ الفيديو**: `AGENT_VIDEO_RETENTION_DAYS` (7) + `purgeAgentVideos()` + `npx tsx src/scripts/purge-agent-videos.ts [--days N] [--dry-run]`. يحذف `agent-videos/` فقط — لا يلمس `media_assets`.
- **وكيل التطوير يبقى بلا PR آلي** (AD-050/AD-051): حزمة إصلاح + موافقة بشرية. `DECISION REQUIRED` مسجّل.
- **الاختبارات**: `tests/ai-first-04.test.ts` (11) · `tests/agent-video-download.test.ts` (6) + تحديث عدّادات 8 ملفات. `ffmpeg` مطلوب لاختبارات الفيديو (`apt-get install -y ffmpeg` — غير مثبّت افتراضياً في الحاوية).

## AI-FIRST COMPLETION 03 (2026-11-22) — نطاق البيانات الصفّي + رندر داخل المهمة

- **`resolveRequesterScope(db, input)`** في `executors.ts`: تعيد `{ requesterId, isStaff, sellerIds }` من `getAgentRunContext()` (لا من `input`)، وتقرأ الملكية من `suppliers/merchants/companies.user_id` عبر `select` عادي (**لا `db.execute`** — A2 يرفض SQL الخام).
- **`orderScope`**: `buyer_id = requester` أو `seller_id ∈ ملكه` أو `exists(order_items.seller_id ∈ ملكه)` (الطلب الأب متعدد البائعين). **`seller_orders` ممنوع منيع** (`HARD_DENY_TABLES`) — لا تستخدمه.
- **`productScope`**: `inArray(products.sellerId, sellerIds)`؛ لا ملكية ⇒ شرط SQL ثابت `false` (لا استعلام بلا شرط).
- **أرقام المنصة `null` لغير الطاقم**: `kpi.suppliers/merchants/companies`, `leadsPotential`. `PLATFORM_VIEW_ROLES = ADMIN, SUPER_ADMIN` فقط (SUPPORT ليس منها).
- **`product-agent` لا يكشف الوجود**: منتج الغير وغير الموجود يعطيان نفس `PRODUCT_NOT_AVAILABLE` بلا اسم/SKU.
- **`b2b-agent` إداري فقط**: `requiresPlatformScope: true` + رفض `SCOPE_REQUIRED` داخل المنفّذ (دفاع مزدوج).
- **رندر الوكيل**: `lib/media/verify.ts` (`probeMp4File`, `decodeMp4File` — spawn لـffprobe/ffmpeg بمهلة) + `resolveMediaStorage().put()` بمفتاح `agent-videos/...`. الفحوص: h264 · 720×1280 · المدة 35–120 ومطابقة ±0.5s · مدة الحاوية = ffprobe ±0.5s · decode كامل · حجم المخزَّن = البايتات.
- **لا تكتب الوكيل `media_assets` ولا `audit_logs`**: الملف على القرص + البيانات في `agent_tasks.result`. لا تنزيل عبر API لهذا الملف (قرار مطلوب، موثّق).
- **الاختبارات**: `tests/ai-agent-data-scope.test.ts` (15) · `tests/ai-video-agent.test.ts` (6، رندر حقيقي) · `tests/unit/ai-video-plan.test.ts` (5).
- **عزل معروف**: `ai-met01-agent-metrics` يعدّ صفوفاً عالمية ⇒ يتأثر بالتوازي؛ ينجح منفرداً (18/18).

## AI-FIRST COMPLETION 02 (2026-11-22) — القرارات المعتمدة + الوكلاء التنفيذيون

- **القرار (1) مُنفَّذ**: لا صلاحية جديدة ولا تعديل `ROLE_PERMISSIONS`؛ `requiresPlatformScope` مفروض على 10 وكلاء (أُضيف `market-research-agent` الذي كان يعلن `scope: 'platform'` بلا تفعيل)، و**فلترة صفية حقيقية** لوكيل الدعم بدل حرمان العملاء منه.
- **القرار (2) مُنفَّذ**: `buildRepairPackage(cluster, proposal, now)` في `diagnostics.ts` يُنتج `branch: ai-repair/<slug>`, `baseBranch: master`, `prTitle`, `prBody` (سبب/أدلة/اختبارات/تحقق/**تراجع**/بوابات موافقة), `approvalStatus: 'NOT_RECORDED'`, `delivery: { appliedBy: 'human', mergeBlockedUntilApproval: true }`. **لا diff ولا تطبيق**؛ التطبيق والموافقة بشريان.
- **وكيل الفيديو**: منفّذ تخطيط (`plan_video`) يقرأ منتجاً حقيقياً بملكية محققة، ويعيد `plan` (4 شرائح من `planRenderSlides` — نفس دالة الرندر) + `readiness` من فحص ffmpeg الحقيقي + `renderRequest` جاهز. لا رندر/نشر/إنفاق.
- **`planRenderSlides` مصدر واحد**: أي تغيير في الشرائح يغيّر الخطة والفيديو معاً. `buildAss` مُصدَّر للاختبار (فاصل السطر `\N` الحقيقي — كان `\\N` يطبع حرفياً).
- **إثبات الفيديو الحقيقي**: `npx tsx src/scripts/render-test-video.ts --seconds=35 --language=ar` ⇒ MP4 35.000s، h264 High/yuv420p/720×1280/25fps/875 إطاراً، فك ترميز كامل، وتقرير في `docs/evidence/ai/`. الفيديو نفسه في `backups/media/` (git-ignored).
- **حدود معروفة (لا تُخفى)**: خمسة وكلاء يعلنون `own`/بلا نطاق ويُعيدون **مجاميع منصة** (`sales`, `marketing`, `product`, `b2b`, `finance`, `outreach`) — أرقام لا صفوف مستخدمين، لكنها تكشف مؤشرات أعمال؛ تحتاج فلترة صفية أو تقييداً (قرار مطلوب).
- **الاختبارات**: 163 ملفاً · 2085 اختباراً · exit 0 · `tsc --noEmit` = 0. التفاصيل: `docs/AI-FIRST-COMPLETION-02.md`.

## AI-FIRST COMPLETION 05 — واجهات تشغيل الفيديو/الشركاء + احتفاظ + جدولة (2026-11-20)

- **`/dashboard/agent-video`** (`DashboardAgentVideoPage.tsx`): تشغيل حقيقي لـ`marketing-video-agent` — منتج مملوك (`/api/products/mine`)، مدة داخل حدود `MARKETING_VIDEO_DURATION`، ثم معاينة `<video>` وتنزيل عبر `GET /api/ai/tasks/:id/video[?download=1]` فقط. **`storageKey` لا يصل الواجهة أبداً.**
- **حالتان نهائيتان**: المهمة غير المُبوَّبة تنتهي `succeeded`، والمُبوَّبة (`requiresHumanApproval`) تنتهي **`approved`**. أي واجهة تستقصي الحالة يجب أن تعتبر `approved` مكتملة، و`awaiting_approval` نهائية للاستقصاء (زر تحديث بدل انتظار أبدي).
- **`/dashboard/partners`** (`DashboardPartnersPage.tsx`): موافقة `B2B_PARTNER_DISCOVERY` عبر `/api/privacy/consents`، ثم `b2b-agent` (مُبوَّب أيضاً) — بلا بريد/هاتف/عنوان ولا مراسلة تلقائية؛ السحب يمسح النتائج.
- **احتفاظ الفيديو**: `purgeAgentVideos` يصنّف من DB — `TEST` 7 أيام، `DRAFT` 30 يوماً، `APPROVED` لا يُحذف، `UNKNOWN` يُحفظ. الجدولة **خارج العملية**: `scripts/agent-video-purge.sh` (flock + سطر JSON) عبر `scripts/deploy/wasit-agent-video-purge.{service,timer}` أو `agent-video-purge.cron`.
- **`e2e/global-setup.ts`** يقرأ الآن `DEMO_ACCOUNT_PASSWORD_*` / `DEMO_STAFF_PASSWORD_*` — كلمة المرور المنشورة لم تعد صالحة على بيئة مُدوَّرة (DEMO-SEC-03).
- **CSRF**: أي `request.newContext` في Playwright يستدعي مساراً يغيّر الحالة يجب أن يرسل `Origin` (وإلا 403 `Request origin could not be verified`).
- **E2E**: `e2e/agent-surfaces.spec.ts` — 6/6 (Desktop Chrome + Pixel 7 project `mobile-chromium`).

## AFC-06 — Marketing video agent, commercial grade (2026-11-20)

- **Pipeline**: `lib/media/video-script.ts` (script from real product facts) → `tts.ts` (Piper, local, MIT) → `music.ts` (procedural bed) → `audio-mix.ts` (loudnorm + ducking) → `marketing-video.ts` (`produceMarketingVideo`, `planTimeline`, `buildMarketingAss`, `fitTitle`) → `video-quality.ts` (18-check gate).
- **Nothing ships ungated**: `evaluateMarketingVideo()` must pass before the file is stored; the UI hides preview/download unless `qualityGate.passed === true`. Checks cover voiceover presence, −16…−13 LUFS, ≤ −1 dBTP, h264/yuv420p/720×1280/25fps, AAC stereo 44.1kHz, subtitle cues, and every number in the copy traced to product data.
- **Languages**: ar / fr / en / zh deliver; **ar-TN is withheld on purpose** — the public Tunisian models are CC-BY-NC or unlicensed, so labelling an MSA voice "Tunisian" would be a false claim. `resolveVoice()` returns `{voice: null, reason}` and the gate fails `audio.voiceover`.
- **TTS install**: `scripts/install-tts.sh` (also `npm run install:tts -w @wasit/server`) extracts Piper into `packages/server/vendor/piper/` (git-ignored) with `espeak-ng-data` beside the binary — the binary resolves its data relative to itself, so an unflattened `piper/piper/` breaks with `EACCES`/missing `phontab`.
- **Evidence**: `npm run verify:videos -w @wasit/server` renders one advert per language against a real `products` row and writes `packages/server/artifacts/marketing-videos/report.{json,md}` (build output, git-ignored). Last run: 4 delivered, ar-TN withheld, verdict PASS.
- **Fonts**: `assets/fonts/NotoSansSC-Regular.otf` (CJK) + `NotoSansArabic-Regular.ttf`; `VIDEO_FONTS_DIR` autodetected.
- **Rendering pitfalls worth remembering**: fit every headline/CTA with `fitTitle` (libass clips silently), keep price and currency on separate lines (a mixed-direction line splits into two mis-sized boxes in RTL), and drop the `•` prefix in Arabic copy.

## DEMO-01 — تشغيل الرابط التجريبي العام (2026-11-22)

- **التشغيل/الإيقاف/الفحص**: `bash scripts/demo-up.sh [--build]` (يتحقق من PostgreSQL، يشغّل API ثم `vite preview`، وينتظر `/api/health/ready` عبر الـproxy) · `bash scripts/demo-health.sh` (pg + api + web + proxy + الرابط العام) · `bash scripts/demo-down.sh`. ملفات pid والسجلات في `.demo-run/` (git-ignored) — لا `pkill -f node`.
- **الأسرار**: `scripts/lib/demo-credentials.mjs` (`demoPasswordFor(email)`) يقرأ `DEMO_ACCOUNT_PASSWORD_*`/`DEMO_STAFF_PASSWORD_*` من البيئة أو `.env.demo` (0600، غير متعقّب). **لا كلمة مرور حرفية في أي سكربت** — و`scripts/session/secret-allowlist.txt` بلا استثناءات لكلمات المرور، فأي ظهور لها يُعدّ finding.
- **فخ تسرّب `.env.demo` إلى الاختبارات**: `set -a; . ./.env.demo; set +a` في shell دائم يترك `APP_URL`/`NODE_ENV`/`DATABASE_URL` مُصدَّرة، فيرثها `vitest` وتفشل مواصفات تعتمد القيم الافتراضية (كانت `seo.test.ts` تفترض `http://localhost:5173`). شغّل الاختبارات بـ`env -u APP_URL -u WEB_URL -u NODE_ENV ...`، و`tests/seo.test.ts` صار يشتق الأصل من `env.APP_URL` بدل قيمة ثابتة.
- **التحقق على الرابط العام**: `scripts/demo-security-smoke.sh` (74 فحصاً)، `scripts/ui-demo-audit.mjs` (69 فحصاً: 4 لغات + شاشة هاتف + رفض RBAC)، `scripts/ui-mobile-smoke.mjs` (16)، `scripts/ui-flows-check.mjs` (6).

## AI-05 / AFC-10 — ضبط الاستهلاك والتكلفة (2026-11-23)

- **Reserve-before-call / settle-after-call**: `lib/ai/spend-limits.ts` (`reserveSpend`/`settleSpend`/`releaseSpend`). الحجز عبارة عن بيان واحد محروس (`INSERT … SELECT … WHERE` + `ON CONFLICT … DO UPDATE … WHERE`) على `ai_spend_counters`، فطلبان متزامنان لا يستهلكان نفس المتاح. الفشل يعيد `rows=[]` فقط — إشارة الرفض.
- **حدود من DB لا من الكود**: `ai_spend_limits` بمفاتيح (`environment`, `scope` = GLOBAL|PROVIDER|AGENT, `targetKey`, `period`) + `maxCost`/`maxRequests`/`warnRatio`. صف بلا أي سقف مرفوض (422) — وإلا لأذِن بإنفاق غير محدود.
- **الرفض ليس عطلاً**: عند بلوغ السقف يتراجع الـruntime إلى `LocalHeuristicProvider` (مجاني) ما لم يمرّر المستدعي `allowLocalFallback: false` (حينها 429). سقف المزوّد لا يُسقط المسار الآمن أبداً. `routing.ts` يتخطى المزوّد المحظور مسبقاً حتى لا يختار الـrouter مزوّداً سيرفضه الـruntime.
- **`releaseSpend` مقيَّد بالبيئة**: `SpendReservation` يحمل `environment`؛ بدونه كان `release` قد ينقص عدّاد بيئة أخرى له نفس `period_start`.
- **تكلفة مجهولة ≠ صفر**: `resolveModelPrice().registered === false` ⇒ `costSource: 'UNKNOWN'`. لا تُسجَّل تكلفة صفرية كأنها مجانية، ولا تُتخذ قرارات ميزانية على سعر غير مسجّل.
- **Idempotency**: `ai_requests.request_key` (فهرس فريد). إعادة المحاولة/الحدث المُعاد تُرجع الصف الأول بلا نداء مزوّد ثانٍ ولا حجز ثانٍ؛ التسابق يحسمه `23505` فيقرأ الخاسر صف الفائز.
- **الجداول الأربعة (`ai_requests`، `ai_usage`، `ai_budgets`، `ai_spend_*`) ليست ضمن نطاق الوكيل**: `modules/ai/agent-scope.ts` يمنعها في `HARD_DENY`، والقراءات المالية تمرّ عبر `platformDb(db)`.
- **إدارة**: `/api/admin/ai/spend` (`AI_MANAGE`/`ADMIN_AI`) — overview + limits PUT/DELETE، كل تغيير في `audit_logs` (`AI_SPEND.LIMIT_UPDATED`/`LIMIT_DELETED`). الواجهة: تبويب «الاستهلاك» في `AdminAiPage` (`components/AiSpendPanel.tsx`).
- **فخ بيئي (ليس عطلاً في الكود)**: مسار TTS يستدعي `ffprobe` من النظام. `ffmpeg-static` يوفّر `ffmpeg` فقط؛ بدون `apt-get install -y ffmpeg` تفشل 4 اختبارات فيديو بـ`spawn ffprobe ENOENT`. الصورة الإنتاجية تُثبّت `ffmpeg`+`ffprobe` عبر apt.
- **اختبارات**: `tests/afc10-ai-spend.test.ts` (22). لا تُنشئ SUPER_ADMIN في اختبار جديد: `super-admin-bootstrap.test.ts` يفشل إن وُجد صف SUPER_ADMIN أثناء تشغيله (تلوّث بين الملفات).

## GM-ACCESS-05 — Production recovery deployment package (2026-11-23)

- **`deploy/gm-recovery/`** is the operator-facing package: `check-runtime.sh` → `precheck.sh` (writes a baseline, changes nothing) → `generate-password.sh` (on-host secret) or a 0600 file → `rotate.sh` (typed confirmation of the DB name) → `verify.sh` (10 checks against the baseline) → `login-check.sh` (real login, prints only status/MFA). `package.sh --out <dir>` builds `wasit-gm-recovery-<stamp>.tar.gz` with `SHA256SUMS` and refuses to stage any secret-shaped file.
- **Bundle is not fully self-contained**: `build:prod` keeps `argon2` external (native addon). The package copies `argon2`, `@phc/format`, `node-gyp-build` into `scripts/node_modules/` (prebuilds for linux-x64/arm64). `check-runtime.sh` proves it loads; on another platform run from the deployed `packages/server`.
- **CLI needs the deployment env**, not just `DATABASE_URL`: it imports `db/client` → `env.ts`, so `JWT_SECRET` must be present in production (`lib/env.ts` refuses the committed default). Source the deployment env file; never retype the URL.
- **New read-only CLI actions**: `precheck` (identity + gate decision + masked account + target counts + session count; exit 2 when the gate refuses, writes a baseline only when it passes), `verify` (compares live state with the baseline; exit 2 on any failed check), `generate-password` (writes a 0600 file, applies to no account, needs no `--email`).
- **Ordering trap (fixed)**: `precheck`/`verify`/`generate-password` are handled **before** `loadSuperAdmin`, so a wrong email cannot mask a wrong database, and generation needs no account.
- **Baseline contains no secret**: account id, masked email, `email_verified`, `mfa_enabled`, confirmed-factor presence, roles, hash *algorithm*, live session count, last audit id. `verify` fails if the audit row carries a secret-shaped key (`auditPayloadLeaksSecret`).
- **Shell arg convention**: `require_email "$@"` reads `$1/$2` without consuming them — every script must `shift 2`, not `shift`.
- **Docs**: `docs/GM-ACCESS-05.md` (runbook, refusal layers, test limits), AD-061, gap §28. Tests: `tests/gm-access-05.test.ts` (33).
