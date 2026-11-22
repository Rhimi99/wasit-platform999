# AI-FIRST COMPLETION — مصفوفة إكمال منظومة WASIT AI

**التاريخ:** 2026-11-22 · **الفرع:** `ai-first-completion` · **الأساس:** `master` @ `1363682`
**المراجع المعتمدة:** `AI-ARCH-ALIGN-01`, `AI-AGENT-MERGE-01`, `AD-049`, `AD-050`, `docs/GAP_REGISTER.md`
**تحديث:** `docs/AI-FIRST-COMPLETION-02.md` (القرارات المعتمدة، وكيل الفيديو، حزمة الإصلاح، فلترة الدعم)

## 1. الغرض والمنهج

هذه المصفوفة تجيب سؤالاً واحداً لكل وكيل: **ماذا يفعل فعلاً اليوم، وما الذي يعلنه بلا تنفيذ؟**
لا تعتمد على الوثائق وحدها — كل خلية مُشتقّة من الكود (`catalogue.ts`, `agent-scope.ts`, `executors.ts`)
أو من اختبار يعمل. ما لا يمكن إثباته مسجَّل كفجوة، لا كإنجاز.

الطبقة كاملة: **21 هوية** (20 متخصصة + المشرف) + **Copilot** منفصل تماماً — لا يُعدّ وكيلاً متخصصاً
ولا يقبل إسناد مهام (`agentRunRefusal` يرفضه).

## 2. المصفوفة — الاثنا عشر CORE_SPECIALIST

| # | الوكيل | الهوية والاختصاص | Scope contract (جداول) | الأدوات والبيانات | Executor | تنفيذ فعلي أم تخطيط؟ | الذاكرة | الصلاحيات / الموافقة / التدقيق | الاختبارات |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `sales-agent` | Sales / lead identification | orders, products, suppliers, merchants, companies, trust_scores | `sales.read_orders_owned/_platform`, `platform.metrics` | `execSalesAgent` | **فعلي** (صفّي: طلباته/مبيعاته + منتجاته فقط) (kpi + leads + recentOrders) | AI-MEM-01 | `ai:use` · موافقة بشرية · Audit + metric | 20 ملفاً |
| 2 | `marketing-agent` | Marketing content & channel mix | products, categories, media_assets | `marketing.read_catalogue_owned/_platform`, `marketing.read_videos_owned` | `execMarketingAgent` | **فعلي** (صفّي: منتجاته/تصنيفاته/ماركاته فقط) (+ `marketingVideos` حقيقية قابلة للمعاينة) | AI-MEM-01 | `ai:use` · تلقائي · Audit | 22 |
| 3 | `ads-agent` | Advertising budget & placement | campaigns, ad_events | `ads.read_campaigns`, `platform.metrics` | `execAdsAgent` | **فعلي** (CTR/CR/سبيند) | AI-MEM-01 | `ai:use`+`ad:create` · **موافقة** · Audit | 12 |
| 4 | `product-agent` | Product listing analysis | products, categories, variants, images, inventory | `product.read_owned/_platform` | `execProductAgent` | **فعلي** (منتجاته فقط؛ منتج الغير ⇒ رفض بلا كشف وجوده) (completeness + issues) | AI-MEM-01 | `ai:use` · تلقائي · Audit | 16 |
| 5 | `support-agent` | Customer support drafting | threads, messages, users | `platform.metrics` | `execSupportAgent` | **فعلي** (unread/threads + رد مقترح) — **مفلتر صفياً**: غير الموظفين يرون خيوطهم فقط | AI-MEM-01 | `ai:use` · تلقائي · Audit | 9 + 3 |
| 6 | `analytics-agent` | Business KPI reporting | users, products, suppliers, merchants, companies, orders, order_items, daily_kpis | `platform.metrics`, `platform.read_orders` | `execAnalyticsAgent` | **فعلي** (snapshot كامل) | AI-MEM-01 | `ai:use`+`analytics:read:own` · تلقائي · Audit | 15 |
| 7 | `market-research-agent` | Market & category research | products, categories, orders, suppliers, merchants | `market.read_overview/_own` | `execMarketResearchAgent` | **فعلي** (متوسط أسعار/فئات) | AI-MEM-01 | `ai:use` · **`requiresPlatformScope` (مفعَّل)** · تلقائي · Audit | 8 |
| 8 | `b2b-agent` | B2B partner matching | suppliers, merchants, companies | `platform.metrics` | `execB2BAgent` | **فعلي** (إداري فقط: مطابقة الشركاء تسمّي أطرافاً أخرى) (matching + verified) | AI-MEM-01 | `ai:use` · **موافقة** · Audit | 7 |
| 9 | `risk-agent` | Risk assessment | risk_profiles, risk_events | `risk.read_overview` | `execRiskAgent` | **فعلي** (posture + أحداث) | AI-MEM-01 | `risk:read` · **موافقة** · Audit | 13 |
| 10 | `dispute-assistant` | Dispute context summarisation | disputes, dispute_messages | `disputes.read_summary` | `execDisputeAssistant` | **فعلي** (ملخص + توصية) | AI-MEM-01 | `dispute:read` · **موافقة** · Audit | 6 |
| 11 | `development-agent` | **Platform Maintenance & Repair** | agent_tasks, agent_runs, agent_run_steps + عدّادات المنصة | `development.read_platform`, `platform.metrics` | `execDevelopmentAgent` | **فعلي**: تحليل سبب جذري + مقترح patch + **حزمة إصلاح (فرع/PR/تراجع) بلا diff** | AI-MEM-01 | `ai:use` · تشخيص تلقائي · `apply_patch`/`merge` **بلا منفّذ** · Audit | 8 + 21 |
| 12 | `marketing-video-agent` | Marketing video planning | products, media_assets, suppliers, merchants, companies | `video.read_assets_owned`, `video.plan_storyboard` | `execMarketingVideoAgent` | **فعلي** (خطة من منتج حقيقي + طلب رندر قابل للتنفيذ) — **لا رندر ولا نشر** | AI-MEM-01 | `ai:use` · موافقة · Audit · `plan_video` | 5 + 5 + 5 |

**الفيديو (محدَّث في AI-FIRST-COMPLETION-02):** الوكيل يُنفّذ **التخطيط** من بيانات حقيقية ويُسلّم طلب رندر
قابلاً للتنفيذ (`POST /api/media/marketing-videos`). الرندر والنشر **لا** يمرّان عبر الوكيل: الرندر يكتب
`media_assets` + `audit_logs` (A2 يمنع كتابة التدقيق على الوكلاء)، والنشر قرار مالك. الإثبات الفعلي
(MP4 35.000s، h264 High، فك ترميز كامل، خط عربي مُطبَّق) في `docs/AI-FIRST-COMPLETION-02.md` §2.4.

## 3. المصفوفة — الداعمون وطبقة الحوكمة (مستقلة)

| الوكيل | Tier | Executor | الحالة الفعلية | ملاحظة |
| --- | --- | --- | --- | --- |
| `finance-agent` | SUPPORTING | `execFinanceAgent` | **فعلي** (P&L لكل عملة، مساهمة أو `null` مع سبب) | لا يقرأ ledger/policies |
| `outreach-acquisition-agent` | SUPPORTING | `execGrowthAgent` | **فعلي** (ترتيب أسواق + شرائح + مسودات `DRAFT_ONLY`) | لا إرسال ولا حملات مدفوعة |
| `payment-settlement-agent` | SUPPORTING | — | مُعلن فقط | `payment.settle` بلا منفّذ |
| `compliance-agent` | SUPPORTING | — | مُعلن فقط | `compliance.final_ruling` بلا منفّذ |
| `supplier-agent` | SUPPORTING | — | مُعلن فقط | `supplier.onboard` بلا منفّذ |
| `merchant-agent` | SUPPORTING | — | مُعلن فقط | `merchant.onboard` بلا منفّذ |
| `customer-intelligence-agent` | SUPPORTING | — | مُعلن فقط | `customer.segment` بلا منفّذ |
| `operations-agent` | SUPPORTING | — | مُعلن فقط | `operations.health_check` بلا منفّذ |
| `agent-supervisor` | GOVERNANCE | — | **رقابة حقيقية** (observe/contain/escalate عبر `supervisor.ts`) | لا يقبل إسناد مهام |
| `wasit-copilot` | GOVERNANCE | — | **تنسيق** (planner + dispatcher + agent runs) | لا يفكّك الأهداف بـLLM؛ الخطوات من المتصل |

**الذاكرة:** طبقة واحدة (`AI-MEM-01`) مربوطة بدورة حياة المهمة لكل الوكلاء
(`buildPriorContext` قبل التنفيذ + `recordTaskOutcomeMemory` بعده) — لا وكيل بلا ذاكرة، ولا ذاكرة تمنح سلطة.

**الصلاحيات والموافقات:** كل المسارات تمرّ عبر `createAgentTask` (RBAC + capability + بوابة الموافقة +
Audit + metric). الموافقة الذاتية مرفوضة (المُعتمِد يجب أن يكون شخصاً آخر).

## 4. الفجوة التي أُغلقت في هذه المهمة

### 4.1 وكيل الصيانة: من «نصيحة ثابتة» إلى سلسلة إصلاح حقيقية

| خطوة السلسلة المطلوبة | قبل | بعد |
| --- | --- | --- |
| تشخيص تلقائي | ✅ موجود | ✅ + عيّنة 200 مهمة فاشلة بدل 5 |
| **تحليل السبب** | ❌ نص ثابت: «جمّع الأعطال حسب الوكيل ورمز الخطأ» — عمل بشري | ✅ تجميع حتمي حسب بصمة الخطأ (11 عائلة) مع فرضية وثقة وأدلة |
| **إعداد patch** | ❌ لا شيء | ✅ `patchProposals`: ملفات حقيقية موجودة في الريبو، نوع التغيير، خطورة، اختبارات، تحقّق، rollback |
| اختبارات معزولة | ❌ | ⛔ **محجوب بنيوياً** — لا runner ولا قاعدة معزولة داخل runtime للوكيل (مذكور صراحةً، لا مُتظاهر به) |
| **تقرير مراجعة** | ❌ | ✅ `reviewReport` بحالة كل خطوة + الموافقات المطلوبة |
| انتظار موافقة GM | ✅ (بوابة) | ✅ + `blocked` صريح لكل خطوة غير منفَّذة |
| تطبيق ضمن النطاق | ⛔ بلا منفّذ | ⛔ كما هو (AD-050) — لا تغيير |

**الكود:** `modules/ai/diagnostics.ts` (جديد، دوال نقية) + ربط في `execDevelopmentAgent`.
**لا migration، لا جدول جديد، لا صلاحية جديدة** — المخرجات تُخزَّن في `agent_tasks.result` القائم.

### 4.2 ثغرة أمنية اكتُشفت أثناء الاختبار وأُغلقت

اختبار الـHTTP أثبت أن **CUSTOMER يحصل على 201** عند تشغيل `development-agent`. السبب:
`requiresPlatformScope: true` معلن على 9 وكلاء **ولم يكن مفروضاً في أي مكان**، وA2 يحدّ
*الجداول* لا *الصفوف* — أي أن وكيلاً بعرض المنصة يقرأ صفوف كل المستأجرين. النتيجة العملية:
عميل يستطيع قراءة **رسائل أخطاء مهام مستخدمين آخرين** وعدّادات المنصة، ووكيل النمو يكشف كل
الموردين/التجار/الشركات.

**الإصلاح:** فرض العلم المعلن في `createAgentTask` (`PLATFORM_SCOPE_ROLES = ADMIN, SUPER_ADMIN`)
مع Audit (`AI.AGENT_RUN_REFUSED` / `PLATFORM_SCOPE_REQUIRED`) وmetric `blocked`، ورفض **قبل**
كتابة أي صف مهمة. لم تُضَف صلاحية ولم تُحذف من أي دور، ولا تغيير في `ROLE_PERMISSIONS`.

**الأثر:** 9 وكلاء بعرض المنصة صاروا للطاقم الإداري فقط. هذا تضييق مقصود ويحتاج مراجعتك إن كنت
تقصد أن يستخدمها التجار (انظر §6).

## 5. اختبارات الإثبات

| الملف | الحالات | يثبت |
| --- | --- | --- |
| `tests/unit/ai-maintenance-rootcause.test.ts` | 12 | العائلات، بصمة موحّدة للأسباب المتساوية، التجميع/الثقة، **كل ملف في كل patch موجود فعلاً**، تقرير المراجعة |
| `tests/ai-maintenance-rootcause.test.ts` | 5 | عبر دورة حياة حقيقية: سبب مهيمن، patch ينتظر GM، كل خطوات السلسلة، **لا تغيير في الصفوف المشخَّصة**، و403 لعميل عبر HTTP |
| `tests/ai-platform-scope.test.ts` | 9 | رفض 5 أدوار غير إدارية على الوكلاء التسعة بعرض المنصة بلا كتابة صف + Audit + نجاح SUPER_ADMIN + بقاء `sales-agent` متاحاً للعميل |
| بقية منظومة AI | 490 | لا كسر في 33 ملفاً (a1, a2, r1, r2, ai0*, ai-*) |
| **الحزمة الكاملة (على أساس `master`)** | **2068 / 160 ملفاً** | exit 0 |

## 6. فجوات مفتوحة تحتاج قرارك (لا أُلتفّ عليها)

1. **تطبيق patch آلياً**: يحتاج قرار آلية التسليم (فرع/PR مقابل مرفق) — `DECISION REQUIRED` في AD-050.
2. **اختبارات معزولة للوكيل**: تحتاج runner معزول وقاعدة قابلة للتدمير داخل بيئة الوكيل. اليوم
   الاختبارات يكتبها الوكيل كخطة، والإنسان يشغّلها.
3. **وكيل الفيديو**: لا يُعلن اكتماله قبل فيديو فعلي 35–120ث؛ الربط يحتاج AD-049.
4. **نطاق البيانات على مستوى الصف**: A2 يحدّ الجداول فقط. `ownerScoped` يوثّق النية ولا يفلتر الصفوف،
   لذا `analytics-agent` (الذي يعلن `analytics:read:own`) يعيد تجميعات المنصة كاملة. الإصلاح الحقيقي
   فلترة صفية لكل جدول — تغيير كبير يحتاج قراراً.
5. **هل يبقى الوكلاء التسعة بعرض المنصة للطاقم فقط؟** إن كنت تقصد أن يستخدمها التجار، فالإصلاح
   الصحيح هو §6.4 (فلترة صفية) لا إعادة فتح البوابة.

## 7. إعادة الإنتاج

```bash
cd packages/server
npx tsc --noEmit
TEST_DATABASE_URL=postgresql://wasit:wasit_dev_password@127.0.0.1:5434/wasit_test \
  npx vitest run tests/unit/ai-maintenance-rootcause.test.ts tests/ai-maintenance-rootcause.test.ts tests/ai-platform-scope.test.ts
```
