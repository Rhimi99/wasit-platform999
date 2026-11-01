# AI ARCHITECTURE — WASIT BUSINESS GLOBAL (WASIT AI CORE)

## 1. المبدأ

طبقة AI مستقلة، **Provider-agnostic**، مقيدة بميزانية وبصلاحيات المستخدم.

## 2. WASIT AI CORE (استعدادات)

| الخدمة | الوصف | الحالة |
| --- | --- | --- |
| Product Recommendations | توصية منتجات | Schema (aiRequests) + تصميم |
| Smart Search | بحث ذكي (تتمة البحث النصي) | قابل للإضافة فوق Search Engine |
| Market Analysis | تحليل سوق | تصميم |
| Customer Assistant | مساعد عميل | تصميم |
| Supplier Recommendations | توصيات موردين | تصميم |
| Product Analysis | تحليل منتجات | تصميم |
| Price Intelligence | ذكاء أسعار (مصدر Price Comparison) | تصميم |
| Sales Intelligence | ذكاء مبيعات | تصميم |
| Admin Intelligence | مؤشرات إدارية | تصميم |
| Risk Analysis | تحليل خطر (يدعم Risk Engine) | تصميم |
| Dispute Assistant | مساعد نزاعات | تصميم |
| Advertising Assistant | مساعد إعلانات | تصميم |

## 3. AI AGENTS

Agents قابلة للإضافة أفقيًا (Sales, Marketing, Ads, Product, Support, Analytics, Market Research, B2B, Risk, Dispute, Development).

**ضابط إلزامي**: كل Agent يرث دور المستخدم/المتصل — **لا يتجاوز صلاحياته**. أي Tool يتحقق عبر RBAC قبل التنفيذ. تتمة تفاصيل الأدوار في `docs/PERMISSIONS_MATRIX.md`.

## 4. AI COST CONTROL LAYER

| بند | آلية |
| --- | --- |
| AI Budget | جدول `aiBudgets` (per month/scope) |
| Token Usage | `aiRequests` (input/output tokens) + `aiUsage` (مجمّع) |
| Model Routing | `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY` عبر env (Selection قابلة للتبديل) |
| Request Limits | لكل مستخدم/أدمن في حدود الاشتراك (`limits.aiPerDay` في SubscriptionPlans) |
| Cost Tracking | إجمالي مبلغ/عملة في aiRequests |
| User Limits / Admin Limits | حدود لكل دور (DB) |

## 5. قابلية تغيير المزود

- لا استيراد SDK لأي مزود داخل Services.
- واجهة `AiProvider` (generate, embed) تجريدية؛ التطبيقات عبر Env.
- Default: `noop`/`mock` لتطوير دون تكلفة — لا تكلفة فعلياً حتى إعداد مفتاح.

## 6. أخلاقيات/أمان

- النظام لا ينفذ أي تغيير مالي/تسويقي دون إذن المستخدم صاحب الصلاحية.
- Audit لكافة طلبات AI (من/ماذا/تكلفة).
- أنماط الإساءة (طلب كثير) → AI Budgets + Rate Limit.

## 6.5 WASIT AI COPILOT (مواصفة — غير منفَّذة)

> الحالة: **مواصفة تصميمية فقط. لا كود، لا routes، لا UI.** أُضيفت لتوضيح الحدود المعمارية قبل أي تنفيذ مستقبلي.

ميزة **مستقلة واختيارية للتاجر**، فوق طبقة الـAgents الحالية. Copilot هو **Orchestration/Conversational Layer**، وليس Agent جديدًا ولا بديلًا عن أي Agent.

| القاعدة | التفصيل |
| --- | --- |
| لا يحذف Copilot أي Agent | لا إزالة ولا دمج لأي وكيل قائم |
| لا يدمج الـAgents في Agent واحد | كل وكيل يبقى مستقلًا وقابلًا للاستخدام المباشر عبر مساراته الحالية |
| Orchestration فقط | يستدعي وكيلًا واحدًا أو عدة وكلاء حسب المهمة، ويجمّع نتائجهم للمستخدم |
| Extensible عبر Agent Registry | إضافة وكيل مستقبلي = صف في `agent_registry` + executor، دون تعديل Copilot |
| لا يتجاوز RBAC | يرث دور المستدعي؛ كل استدعاء وكيل يمرّ بنفس `requirePermission` القائم |
| تأكيد التاجر للإجراءات الحساسة | أي إجراء ذي أثر مالي/تسويقي يُقترح ثم ينتظر تأكيدًا صريحًا (نفس مفهوم `requiresHumanApproval`) |
| نتائج من بيانات فعلية | لا معلومات مختلقة؛ الاعتماد على خدمات المنصة الحقيقية (orders/analytics/products…) |
| Audit لكل execution/action | كل تنسيق وكل إجراء وكيل يُسجَّل في `audit_logs` (من/ماذا/متى/النتيجة) |

**مثال تنسيقي:** «أريد بيع هذا المنتج في فرنسا» → يمكن أن يُنسّق Copilot بين: Product Agent + Market Research Agent + Sales Agent + Marketing Agent + Ads Agent + Analytics Agent — وكلها تبقى مستخدمة بشكل مستقل.

**فرق جوهري عن الـAgents:** الوكيل ينفّذ مهمة واحدة محدّدة؛ Copilot يخطّط ويوزّع ويربط السياق ويعرض نتيجة موحّدة. طبقة Copilot لا تملك صلاحيات خاصة ولا تتجاوز صلاحيات المستخدم.

## 7. توليد الفيديو التسويقي (Marketing Video Generation)

أول قدرة **توليد وسائط حقيقية** في AI CORE، منفّذة End-to-End:

| الطبقة | الواجهة | الملف |
| --- | --- | --- |
| منفذ التوليد | `VideoGenerationProvider` | `lib/media/video-types.ts` |
| المحرّك الافتراضي | `StructuralVideoProvider` (MP4 حقيقي عبر ffmpeg+libass) | `lib/media/video-provider.ts` |
| التعطيل | `NoopVideoProvider` (يفشل بصوت عالٍ) | `lib/media/video-provider.ts` |
| منفذ التخزين | `MediaStorage` | `lib/media/port.ts` |
| التخزين الخاص | `LocalMediaStorage` | `lib/media/local-storage.ts` |
| روابط موقّعة | `signDownloadToken`/`verifyDownloadToken` | `lib/media/tokens.ts` |
| التسجيل | `resolveMediaStorage`/`resolveVideoProvider`/`describeMediaProviders` | `lib/media/resolve.ts` |
| قياس مدة الأصل | `measureMp4DurationSeconds` (قراءة `moov/mvhd` من bytes) | `lib/media/mp4.ts` |

- **سياسة المدة 35–120ث**: ثوابت موحّدة في `@wasit/shared` (`MARKETING_VIDEO_DURATION`: min 35،
  max 120، default 60) يشترك فيها الـAPI والرندر والواجهة فلا تتفرّق. بعد كل render تُقرأ المدة
  **فعليًا من bytes الـMP4** (`measureMp4DurationSeconds`)؛ إن خرجت عن 35–120 يُرفض الأصل ويُسجَّل
  `FAILED` ولا يصبح READY، وتُخزَّن **القيمة المقاسة** لا قيمة الطلب — أي أن المزوّد لا يستطيع
  إدّعاء مدة لا تحملها البايتات.
- **Provider-agnostic**: لا SDK مزوّد يُستورد خارج `resolve.ts`. إضافة مزوّد generative
  خارجي (async) لاحقاً = تطبيق الواجهة + سطر في `resolve.ts`، دون لمس الخدمة/الـroutes/الواجهة.
  الواجهة تحمل `isAsync` جاهزاً للمزوّدين الذين يعيدون job id ويكملون لاحقاً.
- **محكوم بالميزانية**: كل render يمرّ عبر `assertWithinBudget` + `recordAiRequest`
  (`requestType = MARKETING_VIDEO`) + `upsertAiUsage`، فلا يمكن لتوليد الفيديو تجاوز AI Cost Control.
- **لا يتجاوز الصلاحيات**: التوليد يتطلب `media:upload`؛ الملكية تُفحص على كيان البيع؛
  المنتج يجب أن يكون ACTIVE. Marketing Agent **قراءة/توصية فقط** ولا ينشئ وسائط بنفسه —
  يعرض فقط الفيديوهات التي ولّدها صاحب الحساب (بروابط موقّعة).
- **خصوصية**: الأصول تُخزَّن خاصة وتُقدَّم فقط عبر روابط موقّعة قصيرة العمر — لا كشف ثابت.

## 8. سياق تنفيذ الوكيل الآمن (AI-01.1)

عند تشغيل أي مهمة وكيل، يربط الـrunner (`modules/ai/runner.ts`) هويتين موثوقتين بالتزامن
الفعلي للمهمة عبر `AsyncLocalStorage` (`lib/ai/agent-run-context.ts`)، وكلتاهما مشتقّتان من
سياسة الخادم — لا من مدخلات المستخدم ولا من صف المهمة:

| الضابط | المصدر الموثوق | آلية الرفض |
| --- | --- | --- |
| هوية التشغيل (`taskId`, `agentKey`, `taskType`, `attempt`) | الـrunner من صف المهمة والكتالوج | — (للتدقيق فقط) |
| `authorizedActions` | `authorizedActionsForAgent(agent)` = `capabilities` من الكتالوج | `requireAction(id)` يرفض `ACTION_NOT_AUTHORIZED` عند غياب السياق أو غياب الإذن |
| سقف التكلفة لكل تشغيل | `resolveRunCostCapUsd(agent)` من `limits.maxCostUsdPerRun` | `AgentRunBudgetExceededError` قبل وبعد كل نداء مزوّد |

- **مصدر الصلاحيات**: قائمة الإذن تُشتق من `capabilities` المعلنة في الكتالوج
  (`catalogue.ts`)، وليس من `allowedTools` (التي تسمّي مصادر البيانات لا الآثار) ولا من
  `input`. وكيل بلا `capabilities` يحصل على قائمة فارغة → كل بوّابة `requireAction` ترفض
  (fail-closed). الـ`requireAction` نفسه لا يكفي أن يكون الإجراء في السجل؛ يجب أن يكون ضمن
  قائمة الإذن الخاصة بالتشغيل.
- **آلية سقف التكلفة (محجوز/مُسوَّى)**: `AgentRunBudget` يُنشأ مرة واحدة لكل تشغيل بسقف
  مشتق من الكتالوج (افتراضي الـrunner 5 USD عند غياب قيمة صالحة؛ `0` = بلا سقف بقرار صريح).
  **قبل** نداء المزوّد يُحجز `estimateBudget` حجزًا ذرّيًا (`reserve`) — فحص-وإضافة متزامنان
  يمنعان نداءين متزامنين من استهلاك نفس المتاح (لا race). إن لم يتّسع التقدير للسقف يُرفض
  النداء قبل الوصول للمزوّد. **بعد** النداء يُسوَّى الحجز إلى التكلفة **المقاسة الفعلية**
  (`settle` يستبدل التقدير ولا يضيفه → لا احتساب مزدوج). إن فشل النداء يُحرَّر الحجز
  (`release`) فلا يُحتسب نداء لم يكتمل. يُغذّى الرصيد بالتكلفة المسجَّلة للمهمة من محاولات
  سابقة، فيُحدّ السقف المهمة كاملةً ولا تستطيع إعادة المحاولة إعادة ضبط العدّاد.
- **محاسبة التكلفة الفعلية عند تجاوز السقف (AI-01.2)**: المزوّد استُدعي فعلاً، فالتكلفة
  أُنفقت فعلاً. لذلك تُسجَّل التكلفة المقاسة **كاملةً** في سجل `ai_requests` بغضّ النظر عن
  السقف (بحالة `OVER_BUDGET` عند التجاوز، و`SUCCESS` ضمنه)، ثم يُرفض التشغيل بعد الكتابة
  (`AgentRunBudgetExceededError`) ويُمنع أي نداء لاحق لأن الرصيد سُوِّي على القيمة الحقيقية
  المتجاوزة. هذا يغلق ثغرة إسقاط التكلفة عند الرفض.
- **فشل حفظ التكلفة**: إن فشل إدراج صف السجل (المصدر الموثوق الذي تعيد `usageSum` جمعه)،
  يُرفض التشغيل بخطأ `AgentCostRecordingError` (`RUN_COST_NOT_RECORDED`) — لا يُعلن النجاح،
  ولا يُصفَّر العدّاد، ولا يُسمح بنداء لاحق. أما تجميع `ai_usage` فهو مشتق للعرض فقط: فشله
  يُسجَّل ولا يوقف التشغيل، لأن السجل الفعلي محفوظ والميزانية الشهرية تعيد جمعه.
- **التنظيف**: ينتهي السياق والميزانية مع رجوع الاستدعاء المُغلَّف؛ ويؤكّد الـrunner في
  `finally` عدم بقاء أي سياق (تسريب = خطأ يُسجَّل بصوت عالٍ).
## 9. بوابة الأدوات المركزية (AI-02.1)

بوّابة واحدة إلزامية يمرّ عبرها **كل** استدعاء أداة من أي وكيل. لا يوجد مسار جانبي:
أي أداة غير مسجّلة، أو استدعاء خارج سياق تشغيل موثوق، أو بلا إذن، أو بلا صلاحية/نطاق، أو
بمدخلات غير صالحة — يُرفض **قبل** تنفيذ المعالج، ويُسجَّل كل محاولة (مسموحة أو مرفوضة) في
`audit_logs`.

### المكوّنات
- `src/lib/ai/tool-registry.ts`: السجل الوحيد لكل أداة — معرّف ثابت (`id` = معرّف الإجراء)،
  مخطط Zod للمدخلات، نوع الأثر (`read` فقط في هذه المرحلة)، الصلاحية المطلوبة، وهل تقرأ
  بيانات على مستوى المنصّة (`platformScoped`). الأداة المسجّلة بلا معالج = خطأ يُفشل التحميل.
- `src/lib/ai/tool-handlers.ts`: معالج حقيقي واحد لكل أداة مسجّلة، يقرأ بيانات WASIT الفعلية
  (PostgreSQL) فقط، ولا يستقبل هوية/نطاق من الوسائط.
- `src/lib/ai/tool-gateway.ts`: نقطة الدخول `invokeTool(db, toolId, args, opts)`.

### ترتيب الفحوص (كل فحص fail-closed)
1. **التسجيل**: المعرّف يجب أن يكون في السجل (`TOOL_NOT_REGISTERED`).
2. **سياق التشغيل الموثوق**: يجب وجود `AsyncLocalStorage` من الـrunner (`NO_RUN_CONTEXT`).
3. **الإذن**: المعرّف ضمن قائمة `allowedTools` المشتقّة من الكتالوج في سياق التشغيل
   عبر `requireAction(id, allowedTools)` — إعادة استخدام بوّابة AI-01.1 لا نظام موازٍ
   (`ACTION_NOT_AUTHORIZED`).
4. **RBAC**: أدوار الطالب (المحلولة خادميًّا في الـrunner) تحمل صلاحية الأداة
   (`PERMISSION_DENIED`).
5. **نطاق المنصّة**: أداة `platformScoped` تتطلّب دور `ADMIN`/`SUPER_ADMIN`
   (`PLATFORM_SCOPE_DENIED`).
6. **التحقّق من المدخلات**: مخطط Zod صارم (`.strict()`) — أي مفتاح غير متوقّع (مثل محاولة
   تزوير `userId`/`roles`) يُرفض (`INVALID_INPUT`).
7. **التنفيذ** بمهلة (افتراضي 15s)، والنجاح يُدقَّق بمهلة زمنية (`AI.TOOL_EXECUTED`).

### العلاقة بـ AI-01.1 (لا ازدواجية)
تُعاد استخدامات `getAgentRunContext` و`requireAction` حرفيًّا. الـrunner يوسّع السياق الموثوق
بحقلين جديدين مشتقّين خادميًّا من صف المهمة والكتالوج (لا من `input`):
`allowedTools` (المسجّل ∩ `allowedTools` الكتالوج) و`requesterRoles` (أدوار الطالب من قاعدة
البيانات). الهوية والصلاحيات لا تُؤخذ أبدًا من وسائط الأداة.

### الأثر على الوكلاء
سبعة منفّذين كانوا يقرؤون بيانات عبر أصحاب متعدّدين مباشرةً
(`analytics-agent`, `operations-agent`, `risk-agent`, `dispute-assistant`, `finance-agent`,
`payment-settlement-agent`, `compliance-agent` — الأخير أُضيف في AI-02.1-R1) صاروا يقرؤون
**فقط** عبر `invokeTool` — لم يبقَ استعلام مباشر في مساراتهم. يُثبت ذلك اختبار على مستوى
المصدر (لا `.from(` داخل المنفّذ) واختبارات سلوكية حقيقية على قاعدة بيانات.

> ملاحظة نطاق: البوابة **ليست** القناة الإلزامية لكل أدوات الوكلاء بعد؛ بقي 10 منفّذين
> آخر يقرأون مباشرةً بنطاق ذاتي (انظر القسمين 10 و22).

## 10. إصلاح ثغرات المراجعة الأمنية (AI-02.1-R1)

عالجت هذه المرحلة الثغرتين المؤكّدتين في تقرير المراجعة النهائية لـ AI-02.1، وشدّدت واجهة
`requireAction`، دون أي إعادة تصميم شاملة.

### 10.1 ثغرة `product-agent` — قراءة منتج غير منشور لتاجر آخر
- **السبب**: `pickProduct` كان يستعلم بـ`eq(products.id, productId)` فقط، بلا أي فحص ملكية أو
  نشر، بينما `products` تحمل `sellerId`.
- **السياسة المستخرجة من الكود** (`modules/products`): الكتالوج العام = `is_published AND
  status='ACTIVE'` (كما في `listProducts`)؛ المالك يرى منتجاته عبر `resolveOwnedSellerIds`؛
  الإدارة ترى الكل.
- **الإصلاح**: `pickProduct(db, productId, viewer)` يبني شرط الظهور في `WHERE`:
  مدير → بلا قيد؛ مالك → `sellerId IN owned` أو العام؛ غيره → العام فقط. `viewer` يُشتق
  خادميًّا من `canReadPlatformData` و`resolveOwnedSellerIds`، لا من `input`. منتج غير مرئي →
  `null` (رفض نظيف، لا قراءة موسّعة). `productId` ليس دليل صلاحية.
- **الاختبارات**: `tests/ai02r1-scope-repair.test.ts` (CUSTOMER/منشور، CUSTOMER/غير منشور لتاجر
  آخر، MERCHANT/منتجه غير المنشور، MERCHANT/منتج غيره، ADMIN/الكل، تزوير `productId`/scope).

### 10.2 ثغرة `compliance-agent` — مجاميع منصّة بلا قيد
- **السبب**: `execComplianceAgent` كان يستعلم مباشرةً عن عدّ الموردين/التجّار/الشركات غير
  الموثّقين والنزاعات المفتوحة عبر كل المستأجرين، بلا بوّابة.
- **الإصلاح**: نُقلت القراءة إلى أداة مسجّلة مركزية `compliance.read_platform`
  (`platformScoped: true`، `effect: 'read'`، مخطط `.strict()`). المنفّذ يستدعي
  `invokeTool(db, COMPLIANCE_READ_PLATFORM, {})` فقط. البوابة تفرض: التسجيل → سياق موثوق →
  الإذن (`allowedTools`) → RBAC (`order:read`) → نطاق المنصّة (`ADMIN`/`SUPER_ADMIN`) →
  المدخلات → التنفيذ، وتُدقّق النجاح (`AI.TOOL_EXECUTED`) والرفض (`AI.TOOL_REFUSED`) والفشل
  (`AI.TOOL_FAILED`). أُضيف `requiresPlatformScope: true` للوكيل كطبقة ثانية (بوّابة الـrunner).
- **الاختبارات**: تسجيل الأداة ونطاقها؛ رفض CUSTOMER/SUPPORT/RISK/DISPUTE عند الإنشاء وعند
  البوابة (`PLATFORM_SCOPE_DENIED` / `PERMISSION_DENIED`)؛ نجاح SUPER_ADMIN وتدقيقه؛ رفض
  تزوير scope في الوسائط (`INVALID_INPUT`).

### 10.3 تصليب `requireAction`
- **قبل**: `requireAction(id, granted?: readonly string[])` — معامل اختياري يقبل مصفوفة، أي
  أن أي مستدعٍ مستقبلي يستطيع تمرير قائمة اعتباطية لتجاوز `ctx.authorizedActions`.
- **بعد**: `requireAction(id, scope: 'actions' | 'tools' = 'actions')` — القائمة تُقرأ **دائمًا**
  من السياق الموثوق؛ ما يمرّره المستدعي هو اسم قائمة لا مصفوفة، فلا يمكن تزوير الإذن.
  البوابة تستدعي `requireAction(toolId, 'tools')`. الاستخدام الحالي محفوظ، والاختبارات تثبت
  الفصل بين `authorizedActions` و`allowedTools`.

### 10.4 مراجعة بقية المنفّذين (تصنيف)
| المنفّذ | التصنيف |
| --- | --- |
| `execProductAgent` | **ثغرة مؤكّدة** → أُصلحت (10.1) |
| `execComplianceAgent` | **ثغرة مؤكّدة** → أُصلحت (10.2) |
| `execAdsAgent`, `execDevelopmentAgent` | بوّابة داخلية `requirePlatformGate` (إداري) — **وُحِّدت عبر البوابة في G5 Phase 1 (القسم 22)** |
| `execSalesAgent`, `execMarketingAgent`, `execSupportAgent`, `execB2BAgent`, `execCustomerIntelligenceAgent`, `execOutreachAcquisitionAgent` | وصول مشروع ضمن نطاق المالك / قراءة عامة مسموحة |
| `execMarketResearchAgent` | **ثغرة مؤكّدة** (مجاميع منصّة بلا قيد) → أُصلحت في AI-03.6 (القسم 14) |
| `execSupplierAgent`, `execMerchantAgent` | وصول مشروع ضمن نطاق المالك |
| `execAgentSupervisor` | حتمي، بلا قراءة صفوف متعدّدة المالكين |

لا تُعدّ مجرّد عدم المرور عبر البوابة ثغرة بذاتها؛ التصنيف مبنيّ على أثر أمني مُثبَت.

### 10.5 قيود متبقّية
- البوابة ليست إلزامية لكل الأدوات بعد. بعد G5 Phase 1 (القسم 22) بقي **10 منفّذين** خارجها
  بنطاق ذاتي (الملكية): `sales`, `marketing`, `support`, `product`, `b2b`, `customer-intelligence`,
  `outreach-acquisition`, `supplier`, `merchant`، إضافةً إلى `agent-supervisor` الحتمي. توحيدهم
  مهمّة مستقلة (G5 Phase 2 وما بعدها).
- أدوات `allowedTools` المُعلنة بلا تنفيذ تبقى خاملة في البوابة (`UNBOUND_DECLARED_TOOLS`)؛
  صارت القائمة الآن مكتملة ومتطابقة مع المُعلَن (انظر القسم 12).

## 11. حماية L-1: منع إنشاء مهام Copilot التنفيذية (AI-03.2)

### 11.1 سبب الخلل
`wasit-copilot` مُعرَّف في الكتالوج (`COPILOT_CATALOGUE`) بـ`taskTypes:
['copilot.route_event', 'copilot.summarize']`، لكن `executeAgentTask` لا يملك حالة له —
الـ`switch` ينتهي بـ`default: throw new Error('Unknown agent key: …')`. لذلك أي طلب إلى
`POST /api/ai/agents/wasit-copilot/tasks` كان يمرّ من `createAgentTask` (يمرّ فحص النوع لأن
`copilot.route_event` مُعلَن) ثم **يُدرَج صف مهمة في قاعدة البيانات** قبل أن يفشل عند الإرسال
— أي سجل مهمة فاشلة ملوِّث للطابور. الـCopilot منسّق (routing/planning) لا منفّذ.

### 11.2 موضع الحماية
دفاع على طبقتين، كلتاهما مشتقّة من الكتالوج (`agent.isCopilot`) لا من مدخلات المستدعي:

1. **وقت الإنشاء** — `createAgentTask` (`modules/ai/runner.ts`) يرفض مبكرًا مباشرةً بعد
   `getAgentDef`، **قبل** أي إدراج أو `writeAudit` أو إطلاق مهمة:
   `ApiError.forbidden('The Copilot is a coordinator and cannot be run as an agent task; …')`
   → لا صف مهمة، ولا أثر تدقيق (فشل نظيف).
2. **وقت التنفيذ** — `executeAgentTask` (`modules/ai/executors.ts`) يرمي
   `Error('The Copilot is a coordinator and cannot be executed as an agent task')` قبل
   الـ`switch`، فيُحتوى أي صف قديم (سابق للحماية) عبر مسار الـrunner العادي (يُسجَّل `failed`
   مع سبب واضح) بدل الوصول إلى منفّذ متخصّص.

هذا لا يمسّ مسارات Copilot المخصّصة: `routeEvents` / `planRouteEvents` / واجهات Admin
Copilot تُوجّه إلى الوكلاء المتخصّصين فقط، ولم يُحذف `copilot.route_event` ولم يتغيّر معناه.

### 11.3 الاختبارات ونتائجها
`tests/ai03-copilot-task-guard.test.ts` — **8/8 نجحت**:
- رفض إنشاء مهمة `wasit-copilot` حتى لـ`SUPER_ADMIN` (403).
- عدم إدخال أي صف مهمة عند الرفض (عدّ الصفوف ثابت).
- استمرار إنشاء وتشغيل مهمة لوكيل متخصّص مسموح (`product-agent` → `succeeded`).
- استمرار عمل Copilot preview وrouting (يوجَّهان لوكيل متخصّص، ليس للـCopilot).
- احتواء صف Copilot قديم عبر الـrunner (ينتهي `failed` بسبب «coordinator»).
- عدم وجود أي مسار في `EVENT_ROUTING` يستهدف الـCopilot، والـCopilot ليس في
  `AGENT_CATALOGUE`.
- عدم تغيّر الصلاحيات/الموافقات للوكلاء الآخرين (finance-agent يبقى `awaiting_approval`،
  والبوابة ترفض أداة غير مُصرَّح بها).

### 11.4 الملفات التي تغيّرت
- `packages/server/src/modules/ai/runner.ts` — حارس وقت الإنشاء.
- `packages/server/src/modules/ai/executors.ts` — حارس وقت التنفيذ (دفاع إضافي).
- `packages/server/tests/ai03-copilot-task-guard.test.ts` — اختبارات جديدة.
- `docs/AI_ARCHITECTURE.md` — هذا القسم.

## 12. اتساق الأدوات المعلنة (AI-03.3 — إغلاق L-2)

### 12.1 سبب الخلل
وكيل الاستقطاب يعلن `OUTREACH_TOOLS` في `catalogue.ts`، لكن سبعًا من هذه الأدوات لم تكن
مسجّلة في البوابة **ولم تكن مُدرَجة** في `UNBOUND_DECLARED_TOOLS`:

`outreach.verify_entity`, `outreach.classify_fit`, `outreach.persist_prospects`,
`messaging.draft_outreach`, `outreach.persist_drafts`, `outreach.record_outcome`,
`outreach.refer`.

النتيجة: تصنيف ناقص — «مُعلَنة، غير مسجّلة، وغير مُتتبَّعة». لا خطر تنفيذي (الوكيل لا يستدعي
البوابة أصلًا)، لكن الجرد لم يكن يطابق الواقع.

### 12.2 الإصلاح (توثيق اتساق فقط)
أُدرِجت الأدوات السبع في `UNBOUND_DECLARED_TOOLS` (`lib/ai/tool-registry.ts`) بلا تكرار.
**لم** تُسجَّل كأدوات فعّالة، **ولم** تُنشأ لها handlers، **ولم** تُمنح صلاحيات تنفيذية. تبقى
خاملة: `findTool(id)` = `undefined`، و`toolGrantForAgent` يُسقطها (لأنه `allowedTools` ∩
السجل)، فلا يمكن تنفيذها. لم يتغيّر أي `allowedTools` ولا سلوك أي وكيل.

### 12.3 الاختبارات ونتائجها
`tests/ai03-tool-consistency.test.ts` — **6/6 نجحت**، وهي تشتقّ مجموعة المُعلَن من الكتالوج
نفسه (لا نسخة يدوية) لتثبت:
- `UNBOUND_DECLARED_TOOLS` تساوي بالضبط المُعلَن غير المسجَّل.
- لا معرّف مُعلَن بلا تصنيف (مسجَّل XOR غير مربوط)، ولا معرّف في الحالتين معًا.
- لا تكرار في القائمة.
- سطح الاستقطاب الثمانية موجود بالكامل.
- كل معرّف غير مربوط غير مسجَّل وفعليًا خامل (لا handler، ولا منحة).
- لا تغيير في تعريفات الوكلاء.

### 12.4 الملفات التي تغيّرت
- `packages/server/src/lib/ai/tool-registry.ts` — إدراج الأدوات السبع في
  `UNBOUND_DECLARED_TOOLS` + توضيح الدلالة.
- `packages/server/tests/ai03-tool-consistency.test.ts` — اختبارات جديدة.
- `docs/AI_ARCHITECTURE.md` — هذا القسم.

## 13. تصحيح المراجع التوثيقية (AI-03.4 — إغلاق L-5)

### 13.1 سبب الخلل
وثائق كانت تشير إلى `packages/server/src/modules/ai/agents.ts` — وهو ملف **غير موجود**؛ أُزيل في
commit `4af09b7` («fix(ai): remove obsolete agent definitions»). المراجع الحالية الصحيحة:

| الوظيفة | الملف الحالي |
|---|---|
| الكتالوج `AGENT_CATALOGUE` (وكذلك `support-agent` و`dispute-assistant`) | `packages/server/src/modules/ai/catalogue.ts` (سطر 80؛ و169 و279 للوكيلين) |
| المنفّذون المتخصّصون لكل وكيل | `packages/server/src/modules/ai/executors.ts` |
| `createAgentTask` / `listRegistryAgents` / `syncAgentRegistry` | `packages/server/src/modules/ai/runner.ts` |

### 13.2 التصحيح (توثيق فقط — لا كود تطبيق)
- `docs/MASTER_GAP_AUDIT.md` — صُحّح مرجع صف `AI-03` إلى `modules/ai/catalogue.ts:169,279` مع
  الإبقاء على المرجع التاريخي (`modules/ai/agents.ts:54,94`) كسياق، وأُضيفت كتلة «تصحيح L-5».
- `docs/ARCHITECTURE_DECISIONS.md` — `AD-043` يشير الآن إلى `modules/ai/catalogue.ts`.
- `docs/CHECKPOINT.md` — مُيِّز المرجع كـ«تاريخي» مع الموضع الحالي لـ`listRegistryAgents()`.
- `CHECKPOINT.md` (الجذر) — سجل مؤرّخ؛ وُسم السطر كـ«مرجع تاريخي» مع الملفات الحالية.

لم يُحذف أي أثر تدقيق، ولم يُعدَّل أي كود تطبيق.

### 13.3 تمييز تاريخي/حالي (لماذا لم تُعدَّل حزمة الشراكة)
نسختا `docs/partnership/WASIT-BUSINESS-GLOBAL-PARTNERSHIP-DOSSIER.md` و`.partner-docs/…` إصدار
**مجمّد موثّق** (`b03d17b`، 2026-10-04) بختم `SHA256SUMS.txt`، وملفات PDF/DOCX مولّدة منه. أي تعديل
على `.md` يخالف بصمته المُعلنة ويكسر تطابق الإصدار المنشور، فتُركت كما هي؛ مرجعها يُقرأ كحالة
**تاريخية** لا حالية، والمرجع الحيّ للحالة التقنية هو هذا الملف و`docs/MASTER_GAP_AUDIT.md`.

### 13.4 الاختبار
لا يوجد في المشروع نمط قائم لاختبارات صحة مراجع الوثائق (لا اختبار يقرأ ملفات `.md` أو يتحقّق من
الروابط)، فلم تُنشأ بنية اختبار جديدة لهذا التصحيح. التحقّق تمّ بـ`grep` مباشر + `git diff --check`.

### 13.5 الملفات التي تغيّرت
- `docs/MASTER_GAP_AUDIT.md` · `docs/ARCHITECTURE_DECISIONS.md` · `docs/CHECKPOINT.md` ·
  `CHECKPOINT.md` · `docs/AI_ARCHITECTURE.md` (هذا القسم).

## 14. ترحيل `market-research-agent` إلى البوابة (AI-03.6)

### 14.1 سبب التغيير
`execMarketResearchAgent` كان يستعلم مباشرةً (بلا `invokeTool`) عن مجاميع على مستوى المنصّة:
عدد المنتجات، توزيع الفئات، متوسّط السعر، عدد الموردين/التجّار، و**مجموع قيمة الطلبات**
(`sum(items_total)`) عبر كل المستأجرين. كان العقد يعلن `scope: 'platform'` بينما العلم الفعلي
`requiresPlatformScope` غير مضبوط، فلم يبوّبه الـrunner؛ وكان الوكيل متاحًا لأي دور يحمل
`ai:use` (بما فيه CUSTOMER). في المقابل `analytics-agent` — بنفس نوع المجاميع — مبوَّب.

### 14.2 الإصلاح — فصل نطاقين عبر البوابة
أُضيفت أداتان مسجّلتان (`effect: 'read'`, مخطط `.strict()`):

| الأداة | نطاق | الصلاحية | الحماية |
|---|---|---|---|
| `market.read_overview` | منصّة (`platformScoped: true`) | `analytics:read:all` | البوابة ترفض غير الإدارة بـ`PLATFORM_SCOPE_DENIED` |
| `market.read_own` | مالك (`platformScoped: false`) | `ai:use` | الهوية من `getAgentRunContext().requestedBy` الموثوق — لا من الوسائط |

- الـhandlers في `tool-handlers.ts`: `marketReadOverview` (مجاميع منصّة) و`marketReadOwn`
  (يحلّ المالك من السياق الموثوق، ثم `resolveOwnedSellerIds`؛ لا مالك → شريحة صفرية، لا قراءة
  موسّعة).
- المنفّذ `execMarketResearchAgent` صار يستدعي **فقط** `invokeTool(MARKET_READ_OWN)` و
  `invokeTool(MARKET_READ_OVERVIEW)` — **لا استعلام مباشر**. طلب المجاميع من غير الإدارة يُرفض
  في البوابة (`PLATFORM_SCOPE_DENIED`/`PERMISSION_DENIED`) فيُحذف الحقل `snapshot` من الخروج
  (غياب، لا صفر)، بينما تبقى شريحة المالك `yourMarket`. لا بوّابة داخلية في المنفّذ — البوابة
  هي الحدّ.
- الكتالوج: أُضيفت الأداتان إلى `allowedTools`، مع الإبقاء على `scope: 'platform'` (وصف نوع
  الخرج) و`requiresPlatformScope` غير مضبوط (لأن غير الإدارة يستحقّ شريحته الذاتية، مع منع
  المجاميع). فصار العقد متّسقًا: «المجاميع منصّة للإدارة، والشريحة الذاتية للمالك».

### 14.3 الاختبارات ونتائجها
`tests/ai03-market-research-gateway.test.ts` (11 اختبارًا):
- COMPANY → شريحة ذاتية فقط، و`snapshot` **غائب** (لا مجاميع منصّة).
- SUPER_ADMIN → يحصل على المجاميع.
- لا تسريب بين مالكين (A يرى منتجه، B يرى منتجيه).
- الوصول المباشر إلى `market.read_overview` من غير الإدارة (`RISK` يملك الصلاحية لكن ليس
  إداريًا) → `PLATFORM_SCOPE_DENIED` + أثر `AI.TOOL_REFUSED`؛ COMPANY → `PERMISSION_DENIED`؛
  ADMIN → نجاح + `AI.TOOL_EXECUTED`.
- تزوير الهوية في الوسائط → `INVALID_INPUT` (المخطط الصارم)؛ والـhandler يقرأ الهوية من السياق
  لا من الوسائط.
- فحص على مستوى المصدر: لا `.from(` داخل `execMarketResearchAgent`.

حُدِّث `tests/phase3d-scope-gate.test.ts` ليُدرج المنفّذ ضمن قائمة «المُوجَّهة عبر البوابة»
(`GATEWAY_ROUTED_EXECUTOR_FUNCS`)، فيتحقّق تلقائيًّا من `invokeTool` ومن غياب البوّابة الداخلية.

### 14.4 الملفات التي تغيّرت
- `packages/server/src/lib/ai/tool-registry.ts` (أداتان جديدتان)
- `packages/server/src/lib/ai/tool-handlers.ts` (handlerان جديدان)
- `packages/server/src/modules/ai/catalogue.ts` (allowedTools لـ`market-research-agent`)
- `packages/server/src/modules/ai/executors.ts` (المنفّذ عبر البوابة فقط)
- `packages/server/tests/ai03-market-research-gateway.test.ts` (جديد)
- `packages/server/tests/phase3d-scope-gate.test.ts` (قائمة الموجَّهة عبر البوابة)

### 14.5 قيود متبقّية
البوابة ما زالت غير إلزامية للأربعة الباقين (`sales`, `marketing`, `support`, `b2b`) — ترحيلهم
مهمّة مستقلة (يتطلّب تمرير هوية موثوقة للأدوات ذاتية النطاق).

## 15. طبقة تنسيق المدير العام (GM Orchestrator) — AI-05.0

### 15.1 الغاية
طبقة **قيادة وتنسيق مركزية** فوق الوكلاء، تعمل بصلاحية مالك المنصة (`SUPER_ADMIN`). تستقبل هدفًا
إداريًا، تحلّله، تختار الوكلاء المتخصّصين المسؤولين، تنسّق تنفيذهم، تجمع نتائجهم وتراجعها، ثم تُخرج
**تقريرًا إداريًا واحدًا** مع إجراءات مقترحة. هي **ليست وكيلًا جديدًا** و**ليست محرّك تنفيذ ثانٍ**.

### 15.2 المبدأ الأمني — لا سلطة تنفيذ خاصة
كل خطوة تُنسَّق تمرّ عبر `createAgentTask` — **البوابة التنفيذية الوحيدة** في المنصة. لذلك ترث
الطبقة، دون تجاوز:
- **دور المستدعي الحقيقي** (`role`) — لا تُصنّع `SUPER_ADMIN` أبدًا؛
- **RBAC لكل وكيل** (`callerMayUseAgent`) و**نطاق البيانات** (`assertAgentScope`)؛
- **مفتاح الإيقاف** (وكيل `PAUSED`/`DISABLED` يُتخطّى، لا يُنفَّذ)؛
- **بوّابة الموافقة البشرية** (وكلاء حسّاسون يُدرَجون في `awaiting_approval`)؛
- **حدّ الميزانية لكل تشغيل**، **المهلة الزمنية**، و**سجل التدقيق `AI.*`**.

لا يوجد أي مسار تجاوز: الطبقة لا تستدعي منفّذًا مباشرةً، ولا تُنشئ نظام صلاحيات موازيًا.

### 15.3 التخطيط الحتمي (لا LLM في التوجيه)
التوجيه مبنيّ على **دفتر تشغيل ثابت** (`GM_PLAYBOOKS`) يُطابق كلمات مفتاحية في الهدف — تمامًا كما
يفعل `EVENT_ROUTING` في الـCopilot. الدوال النقية:
- `classifyGoal(goal)` → اختيار دفتر التشغيل (تعادل → الأسبق؛ لا تطابق → الافتراضي)؛
- `planWaves(steps)` → ترتيب طوبولوجي (Kahn) إلى **موجات** حسب الاعتماديات؛ خطوة باعتمادية مفقودة
  أو دورة تُحذف (`dropped`) بدل تنفيذها خارج الترتيب؛
- سقفان صلبان: `MAX_STEPS_PER_RUN = 8` و`MAX_WAVES_PER_RUN = 5`.

### 15.4 المراجعة والتقرير
- `reviewResults(results)` — نقي وحتمي: يصنّف `failed`/`blocked`/`not_run`/`awaiting_approval`/
  `skipped`، ويرصد **نقص الأدلة** (خطوة «نجحت» بلا مفاتيح بيانات فعلية — الاقتراح اللغوي ليس دليلًا)،
  و**التعارضات** بين الوكلاء على نفس المفتاح، ويحدّد `hasBlockingIssues`.
- `buildReport(...)` — تقرير إداري بالعربية والإنجليزية: ملخّص، مخاطر، أولويات، توصيات.
- `proposeActions(...)` — إجراءات متابعة **مقترحة فقط**، كلٌّ منها `executed: false`، والحسّاسة منها
  `requiresApproval: true`. **لا يُنفَّذ أي إجراء مقترح تلقائيًا.**

### 15.5 الواجهة (HTTP)
- `GET /api/admin/gm/playbooks` — دفاتر التشغيل المتاحة (للعرض).
- `POST /api/admin/gm/orchestrate` — تشغيل هدف إداري كاملًا. محميّ بـ`requireRole('SUPER_ADMIN')`؛
  تُحلّ أدوار المستدعي من قاعدة البيانات (لا من جسم الطلب).

### 15.6 الاختبارات ونتائجها
`tests/ai05-gm-orchestrator.test.ts` (20 اختبارًا) — تكامل حقيقي بلا mocks:
- **تخطيط نقي**: التصنيف، الموجات، إسقاط الاعتمادية المفقودة/الدورة، نقص الأدلة، التعارض، التقرير.
- **تنسيق حقيقي**: مراجعة صحّة تجمع أدلة فعلية وتُدقَّق (`AI.GM_ORCHESTRATED`)؛ الترابط عبر
  `correlationId`؛ **عدم تغيير أي بيانات تجارية**.
- **الأمان**: تاجر (`MERCHANT`) لا يصل للوكلاء ذوي النطاق المنصّي → تخطٍّ لا تصعيد؛ مفتاح الإيقاف
  يُتخطّى الوكيل المُعطَّل؛ وكيل حسّاس يُدرَج في `awaiting_approval` دون تنفيذ.
- **السقف**: `maxSteps` يحدّ الخطوات.
- **المسار**: 401 للمجهول، 403 لـ`ADMIN`، و`SUPER_ADMIN` ينجح.

### 15.7 الملفات التي تغيّرت
- `packages/server/src/modules/ai/orchestrator.ts` (جديد)
- `packages/server/src/modules/admin/gm-routes.ts` (جديد)
- `packages/server/src/app.ts` (تسجيل `/api/admin/gm`)
- `packages/server/tests/ai05-gm-orchestrator.test.ts` (جديد)

### 15.8 قيود متبقّية
دفاتر التشغيل ثابتة (6 دفاتر)؛ التوسيع مهمّة مستقلة. الطبقة لا تنفّذ إجراءات حسّاسة بنفسها — تُقترح
فقط وتمرّ عبر بوّابات الموافقة/RBAC القائمة.

---

## 16. استرجاع تقارير تشغيل المدير العام (GM Run Retrieval) — AI-07.0 / AI-07.0a

### 16.1 الغاية
قبل AI-07.0 كانت `orchestrateGmGoal` تُرجع التقرير الإداري **في الذاكرة فقط**: يُكتب صف تدقيق
`AI.GM_ORCHESTRATED` بعدّادات فقط، ولا توجد أي وسيلة لاسترجاع تقرير تشغيل سابق. AI-07.0 يضيف
**استرجاعًا حتميًا** للتقرير الأصلي عبر `getGmRun` و`GET /api/admin/gm/runs/:correlationId`.

### 16.2 المانع الذي اكتُشف قبل التنفيذ
البيانات المحفوظة سابقًا **لا تكفي** لإعادة البناء الحتمي:
- `intentAr` كان يُبنى في الذاكرة ولا يُحفظ في أي مكان؛
- الخطوات **المتخطّاة قبل الإرسال** (دور غير مسموح، وكيل غير `ACTIVE`، سقف الخطوات، اعتمادية مفقودة)
  لم يكن يُنشأ لها صف `agent_tasks` إطلاقًا → لا أثر محفوظ؛
- الهدف (`goal`) كان مقتطعًا عند 200 حرف في الـ`metadata`.

لذلك أُقرّ **توسيع النطاق (AI-07.0a)**: حفظ **Snapshot كامل** وقت التنفيذ. بدون ذلك، أي استرجاع
سيكون «إعادة بناء من الحالة الحالية» — وهو ممنوع صراحةً.

### 16.3 تصميم الـSnapshot (versioned)
`orchestrateGmGoal` يحفظ الآن **Snapshot مُصدَّرًا** (`GM_SNAPSHOT_VERSION = 1`) في عمود
`audit_logs.after` (عمود `jsonb` قائم — **بلا migration وبلا تغيير Schema**):

```
GmRunSnapshot {
  version, goal (كامل), requestedBy, role[], playbookId, matchedKeywords[],
  plan { waves, dropped },
  results[]   // كل الخطوات: succeeded/failed/not_run/blocked/skipped/awaiting_approval
              //   مع intent/intentAr/taskId/evidence/skippedReason/error
  review, report, proposedActions,   // النتائج الأصلية كما حُسبت — لا تُعاد حسابها
  capturedAt
}
```

`metadata` يبقى كما هو (عدّادات + `goal` مقتطع + `snapshotVersion`) للعروض التدقيقية القائمة،
وهو **مشتق** لا مصدر حقيقة. `after` هو المصدر الوحيد للاسترجاع.

**الخصوصية:** لا يُخزَّن `ipAddress`/`userAgent` (موجودان أصلًا على صف التدقيق)، ولا أي حمولة أدوات أو
بيانات دفع/أسرار. يُحفظ معرّف المستدعي وأدواره وقت التشغيل فقط لأغراض الإسناد.

### 16.4 الذرّية (atomicity)
الـSnapshot يُكتب داخل **نداء `writeAudit` واحد** — وهو آخر عملية في التشغيل، بعد اكتمال كل الخطوات
وبناء `review`/`report`/`proposedActions`. لذلك **لا يوجد سجل نجاح ناقص**: إمّا يُكتب صف واحد يحمل
النتيجة الكاملة، أو لا يُكتب صف إطلاقًا (لو فشل التشغيل قبله). لا يُعاد حساب أي شيء لاحقًا.

### 16.5 الاسترجاع الحتمي و fail-closed
`getGmRun(db, correlationId, ownerId)`:
- يبحث عن صف `AI.GM_ORCHESTRATED` حيث `entityId = correlationId` (وهو نفسه `runId`)؛
- يفكّ `after` **حرفيًا** ويعيده مع `createdAt`/`capturedAt` — **لا يعيد الحساب من حالة الوكلاء/المهام
  الحالية**، فتغيير حالة لاحق (موافقة، مفتاح إيقاف، دور) لا يعيد كتابة التاريخ؛
- **fail-closed**: تشغيل غير موجود، أو قديم بلا Snapshot، أو نسخة Snapshot غير مدعومة → `404`،
  **دون** أي رجوع إلى إعادة البناء من الصفوف الحيّة (لتفادي تقرير معقول لكن خاطئ).

### 16.6 الصلاحيات وعزل المالك (لا تغيير في الصلاحيات)
المسار محميّ كما هو بـ`requireRole('SUPER_ADMIN')` (401 للمجهول، 403 لغير المالك الإداري).
إضافةً إلى ذلك، داخل `getGmRun` يُقارَن `ownerId` بـ`requestedBy` في الـSnapshot: يُسمح بالقراءة
لمالك التشغيل أو لمن يملك **نطاق المنصة** (يُحلّ من قاعدة البيانات عبر `userHasPlatformScope`، لا من
الطلب). غير المالك غير المنصّي يحصل على **نفس 404** — دون كشف وجود التشغيل.

### 16.7 الواجهة (HTTP)
- `GET /api/admin/gm/runs/:correlationId` — يعيد التقرير المُسترجع. `:correlationId` = `runId`
  الذي يُرجعه `/orchestrate`.

### 16.8 الاختبارات ونتائجها
`tests/ai07-gm-run-retrieval.test.ts` (13 اختبارًا) — تكامل حقيقي بلا mocks:
- **Snapshot**: نسخة صحيحة، نتيجة كاملة، `skipped`/`failed`/`awaiting_approval` بأسبابها، ولا أسرار/IP.
- **الحتمية**: التطابق الحرفي مع نتيجة `orchestrateGmGoal`، وعدم إعادة الحساب بعد تغيير حالة حيّة.
- **عدم الكتابة**: الاسترجاع لا يُنشئ ولا يغيّر أي صف (مهام/تدقيق/Snapshot).
- **fail-closed**: تشغيل مجهول، وتشغيل قديم بلا Snapshot، ونسخة غير مدعومة → 404.
- **الصلاحيات**: 401، 403، 404، وعدم تسريب تشغيل مالك آخر لغير المنصّي، مع نجاح المالك/المنصّي.

### 16.9 الملفات التي تغيّرت
- `packages/server/src/modules/ai/orchestrator.ts` (حفظ Snapshot + `getGmRun` + الأنواع)
- `packages/server/src/modules/admin/gm-routes.ts` (مسار `GET /runs/:correlationId`)
- `packages/server/tests/ai07-gm-run-retrieval.test.ts` (جديد)

### 16.10 قيود متبقّية
- **التشغيلات القديمة** (قبل AI-07.0a) لا تحتوي Snapshot → استرجاعها **غير مدعوم** ويعيد 404 عن
  قصد؛ لا نعيد بناء نتائج تاريخية من الحالة الحالية.
- لا تُنفَّذ الإجراءات المقترحة (`proposedActions`) — تُسترجع للعرض فقط.

## 17. مركز عمليات المدير العام (GM Desk) — AI-07.1

### 17.1 الغاية
AI-07.1 يضيف **واجهة إدارة** لطبقة تنسيق المدير العام على `/admin/gm` (SUPER_ADMIN فقط)، تُربط
بمسارات GM الحالية وتستعرض سجل التشغيلات وتقاريرها. الواجهة **عرض + مُشغّل**، لا محرّك ثانٍ:
كل عملية تمرّ عبر `POST /api/admin/gm/orchestrate` الحقيقي، فتبقى نفس بوابات RBAC ونطاق البيانات
والمفتاح القاتل وبوابة الاعتماد والحد المالي. الاسترجاع والسجل **للقراءة فقط** ولا يكتبان شيئًا.

### 17.2 مسار سجل التشغيلات (إضافة خادمية)
أُضيف `GET /api/admin/gm/runs` (`listGmRuns`) لعرض السجل: يقرأ صفوف تدقيق `AI.GM_ORCHESTRATED`
الأحدث أولًا ويستخرج **ملخّصًا** من `metadata` (الهدف، دفتر اللعب، العدّادات) — لا إعادة حساب من
الحالة الحيّة، ولا كتابة. `hasSnapshot=false` للتشغيلات القديمة: تُعرض للسجل لكن تفاصيلها غير قابلة
للاسترجاع (يبقى `getGmRun` يعيد 404 لها). الحد الأقصى 200 سطرًا.

### 17.3 الواجهة (Web)
- **الصفحة**: `packages/web/src/pages/AdminGmPage.tsx`، المسار `/admin/gm` داخل `SuperAdminOnly`
  (مع `requireRole('SUPER_ADMIN')` على الخادم — إخفاء الرابط ليس الضابط الوحيد).
- **تبويب «التشغيل»**: نموذج هدف + زر تشغيل (يُعطّل حتى 3 أحرف)، قائمة دفاتر اللعب الحقيقية، وعرض
  تفاصيل آخر تشغيل.
- **تبويب «سجل التشغيلات»**: جدول التشغيلات (الهدف/دفتر اللعب/التاريخ/العدّادات)، وزر «استعراض»
  لكل تشغيل يفتح تفاصيله من الـSnapshot المُسترجع.
- **التفاصيل (للقراءة فقط)**: البيانات الوصفية، نتائج كل خطوة مع شارة النتيجة، المراجعة (فشل/حجب/
  لم يُنفّذ/بانتظار الموافقة/متخطّى/أدلة غير كافية/تعارضات)، التقرير (مخاطر/أولويات/توصيات)، الخطة
  (الموجات/المُسقطة)، والإجراءات المقترحة **موسومة «غير مُنفّذ»**.
- **RTL/الترجمة**: كل النصوص عبر `t('adminGm.*')` بمفاتيح في اللغات الأربع (ar/en/fr/zh)، والحقول
  التقنية (`agentKey`, `action`, الموجات) بـ`dir="ltr"` داخل التخطيط RTL.

### 17.4 الحدود (لا تجاوز)
- لا وظائف تنفيذية جديدة: لا زر «تنفيذ إجراء مقترح»، ولا تجاوز لبوابة الاعتماد. الإجراءات المقترحة
  تُعرض فقط وتُوسم صراحةً بأنها غير منفّذة.
- لا كتابة عند الاسترجاع أو العرض — أُثبت باختبار («لا يكتب شيئًا عند السرد» و«الاسترجاع يعيد نفس
  البايتات»).

### 17.5 الاختبارات
- **API (vitest)**: `tests/ai07-gm-run-retrieval.test.ts` أُضيفت له 3 حالات (AI-07.1): السرد من
  الـmetadata مع `hasSnapshot=true`، عدم الكتابة عند السرد، ورفض ADMIN بـ403. المجموع 16 اختبارًا.
- **E2E (Playwright)**: `e2e/admin-gm.spec.ts` (8 حالات) — فتح الصفحة من الشريط، تشغيل هدف من الواجهة
  ثم استرجاع الـSnapshot المُخزَّن، عدم الكتابة عند الاسترجاع (تطابق الحمولة مرّتين)، فتح تشغيل من
  السجل، 404 لتشغيل غير موجود، وRBAC (ADMIN 403/الصفحة، الشريط، تاجر).

### 17.6 الملفات التي تغيّرت
- `packages/web/src/pages/AdminGmPage.tsx` (جديد)
- `packages/web/src/lib/api.ts` (`adminGmPlaybooks/adminGmRuns/adminGmRun/adminGmOrchestrate`)
- `packages/web/src/lib/types.ts` (أنواع GM)
- `packages/web/src/lib/i18n.ts` (مفاتيح `adminGm.*` في ar/en/fr/zh)
- `packages/web/src/App.tsx` (المسار) + `packages/web/src/components/layouts/AppSidebar.tsx` (الرابط)
- `packages/server/src/modules/ai/orchestrator.ts` (`listGmRuns` + `GmRunSummary`)
- `packages/server/src/modules/admin/gm-routes.ts` (`GET /runs`)
- `packages/server/tests/ai07-gm-run-retrieval.test.ts` + `e2e/admin-gm.spec.ts` (جديد)

### 17.7 قيود متبقّية
- الإجراءات المقترحة للعرض فقط ولا يمكن تنفيذها من هذه الواجهة (بقصد).
- التشغيلات القديمة بلا Snapshot تظهر في السجل لكن تفاصيلها غير قابلة للاسترجاع.

## 18. مركز عمليات الوكلاء (Agent Operations Desk) — AI-06.2

### 18.1 الغاية
كان الـBackend لمراقبة فريق الوكلاء موجودًا وناضجًا (`agent-monitor.ts`: الصحة والأداء والنشاط،
و`supervisor.ts`: تقرير المشرف) بمسارات محميّة، لكن **بلا أي استهلاك من الواجهة**. AI-06.2 يضيف
صفحة `/admin/agent-ops` تقرأ تلك الأسطح الأربعة وترسمها للمدير العام.

### 18.2 ما هو موجود مسبقًا (لا يتغيّر)
- `GET /api/admin/agent-ops/health` → `TeamHealth` (وكلاء، مهام حيّة، 24 ساعة، ميزانية، تنبيهات،
  `needsHumanAttention`، وكتلة `system` للمنصّة فقط).
- `GET /api/admin/agent-ops/performance` → صف لكل وكيل (`{ scope, items[] }`).
- `GET /api/admin/agent-ops/activity` → آخر المهام.
- `GET /api/admin/ai/supervisor/report` → تقرير المشرف + المهام المحتَواة.
- الحماية: `requireAuth` + `requirePermission(AI_MANAGE, ADMIN_AI)`؛ والنطاق يُحلّ خادميًا
  (`userHasPlatformScope`)، لا من الطلب.

### 18.3 ما أُضيف (واجهة فقط — بلا تغيير خادمي)
- **الصفحة**: `packages/web/src/pages/AdminAgentOpsPage.tsx`، المسار `/admin/agent-ops` داخل
  `AdminOnly` (ADMIN + SUPER_ADMIN — مطابقة تمامًا لـ`AI_MANAGE`/`ADMIN_AI` على الخادم).
- **أربعة تبويبات قراءة فقط**:
  1. **نظرة عامة**: KPIs الوكلاء (إجمالي/نشط/متوقف/معطّل/غير سليم)، المهام الحيّة، نافذة 24 ساعة،
     **الميزانية (للقراءة فقط، بلا أي إجراء مالي)**، **كتلة المجدول `system` منفصلة**، التنبيهات،
     ويحتاج تدخّلًا بشريًا.
  2. **الأداء**: جدول لكل وكيل بكل الأعمدة التي يعيدها الخادم (عائد/فشل/حجب/رفض/معدلات/كمون/تكلفة/
     رموز/فشل المزوّد/محلي/أدوات/آخر نشاط).
  3. **النشاط**: آخر المهام (وكيل/نوع/حالة/مُشغِّل/كمون/تكلفة/تواريخ).
  4. **المشرف**: العدّادات، الأعلام، الوكلاء المتوقّفون، تنبيهات المشرف، المهام المحتَواة، التدخّلات.
- **الأنواع**: `AgentPerformanceRow`, `TeamHealth`, `MonitorAlert`, `AgentActivityRow`,
  `SupervisorReportRow` في `lib/types.ts`.
- **عميل API**: `adminAgentOpsHealth/Performance/Activity` + `adminAiSupervisorReport`.
- **الترجمة**: مفاتيح `adminAgentOps.*` في اللغات الأربع (ar/en/fr/zh) — **98 مفتاحًا × 4** بتكافؤ كامل.
- **الشريط**: عنصر `admin.agentOps` في `ADMIN_NAV` (بدون `superAdminOnly`، لأن ADMIN مسموح).

### 18.4 المبادئ الملتزم بها
- **لا بيانات وهمية**: كل رقم = استجابة الـAPI الحقيقية؛ الاختبار يقارن الواجهة بالحمولة الحيّة.
- **فصل النظام عن البشر**: كتلة `system` تُعرض في قسمها الخاص، ولا تُدمج في عدّادات النشاط.
- **الميزانية قراءة فقط**: لا زرّ ولا إجراء مالي؛ مع نصّ صريح بذلك.
- **لا تجاوز للصلاحيات**: الواجهة لا تمنح أكثر مما يحميه الـAPI (`AdminOnly` = `AI_MANAGE`).
- **لا كتابة**: كل المسارات GET؛ لا يُنشئ/يغيّر أي صف (مُثبت باختبار ثبات الحمولة).

### 18.5 الاختبارات
- **E2E (Playwright)**: `e2e/admin-agent-ops.spec.ts` (10 حالات) — الفتح من الشريط، مطابقة KPIs
  للحمولة، مطابقة الأداء/النشاط/المشرف، ثبات الحمولة عبر إعادة التحميل (لا كتابة)، وصول ADMIN،
  ومنع MERCHANT/CUSTOMER (403 + منع الصفحة + غياب الرابط).
- **vitest**: لا اختبارات خادم جديدة (المسارات مُغطّاة في `ai06`/`ai061`)؛ الحزمة كما هي 1300 ناجح.

### 18.6 الملفات التي تغيّرت
- `packages/web/src/pages/AdminAgentOpsPage.tsx` (جديد)
- `packages/web/src/lib/types.ts` (أنواع Agent Ops)
- `packages/web/src/lib/api.ts` (عميل Agent Ops + المشرف)
- `packages/web/src/lib/i18n.ts` (مفاتيح `adminAgentOps.*` في ar/en/fr/zh)
- `packages/web/src/App.tsx` (المسار) + `packages/web/src/components/layouts/AppSidebar.tsx` (الرابط)
- `e2e/admin-agent-ops.spec.ts` (جديد)

### 18.7 قيود متبقّية
- لا تحكّم من هذه الصفحة (إيقاف/تغيير حالة الوكيل يبقى في `/admin/ai`) — بقصد، فهي مراقبة فقط.
- لا migration ولا تغيير Schema.

## 19. الصادر المعاملاتي (Transactional Outbox) + حدث `order.placed` — AI-08.0

### 19.1 الغاية
ربط حدث النطاق `order.placed` بمسار توجيه الوكلاء تلقائيًا، دون أن يفقد الحدث عند تعطّل، ودون أن
يُعلن عن طلب لم يُحفظ، ودون أن يتأثر نجاح الطلب بفشل الوكيل. الوسيلة: **جدول outbox معاملاتي** —
يُدرَج الحدث داخل نفس معاملة إنشاء الطلب، ثم يستنزفه عامل مجدول بعد الـCommit ويوجّهه عبر المسار
الموثوق نفسه الذي يمرّ به أي مستدعٍ (`createAgentTask` → `runTask`).

### 19.2 المخطّط والترحيل (إضافي فقط — لا تغيير لأي جدول قائم)
- **`event_outbox`** (Migration `0032_event_outbox.sql`، نمط `0031`): `id`, `event_type`,
  `aggregate_type`, `aggregate_id`, `payload jsonb`, `dedupe_key`, `status`
  (`PENDING|PROCESSING|PROCESSED|FAILED`), `attempts`, `max_attempts` (افتراضي 8), `available_at`,
  `locked_at`, `last_error`, `processed_at`, `created_at`, `updated_at`.
- فهارس: فريد على `dedupe_key`، و`(status, available_at, created_at)` للاستنزاف، و
  `(aggregate_type, aggregate_id)`، و`created_at`.
- `CREATE TABLE IF NOT EXISTS` + فهارس `IF NOT EXISTS` — آمن على قاعدة معمورة.
- `schema/outbox.ts` مُصدَّر عبر `schema/index.ts`، ومُسجَّل في `meta/_journal.json` (idx 32).

### 19.3 الذرّية (atomicity)
- `createOrder` أُعيد تنظيمه: الغلاف `createOrder(db, …)` يفتح `db.transaction(...)` ويستدعي
  `createOrderWithin(tx, …)`. كل الكتابات — حجز المخزون، الطلب وبنوده، المعاملة وقيود الـLedger،
  سجل التدقيق، إشعار البائع، وصفّ الـoutbox — داخل **معاملة واحدة**. إما تُحفظ جميعها أو لا شيء.
- إدراج `order.placed` يتم داخل المعاملة نفسها، لذا لا يُتاح للعامل قبل نجاح الـCommit، وفشل
  أي خطوة (حتى تعارض مخزون متأخر) يُرجع الطلب والحدث معًا.
- فشل التوجيه/الوكيل لا يمسّ الطلب إطلاقًا: العامل يعمل **بعد** الـCommit فقط.

### 19.4 التكرار المانع (idempotency)
- **على مستوى الإدراج**: `dedupe_key = order.placed:{orderId}` فريد + `onConflictDoNothing`،
  فإعادة الإدراج لا تُنشئ صفًا ثانيًا (المفتاح الثابت المعتمد).
- **على مستوى التوجيه**: `correlation_id = outbox row id` على `agent_tasks`؛ العامل يتحقق من وجود
  مهمة سابقة قبل الإنشاء، فلا تُنشأ مهمة ثانية عند إعادة المحاولة/إعادة حجز الـLease.

### 19.5 الحجز والاستعادة بعد التعطّل (lease + reclaim)
- الاستنزاف **أحادي-الطيران**: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` — من عدة
  عمال، واحد فقط يحجز كل صف؛ لا معالجة متزامنة مكرّرة.
- الحجز يضبط `status=PROCESSING` + `locked_at` (Lease) ويرفع `attempts`.
- `reapStaleEvents`: أي Lease أقدم من مهلة يُعاد إلى `PENDING` (لا يُفقد الحدث)، ويُفشَل عند نفاد
  المحاولات. الفشل العابر يعيد الصف إلى `PENDING` بتراجع أُسّي (`backoffMs`, حتى 30 دقيقة).

### 19.6 الهوية والصلاحيات (لا سلطة عامة)
- هوية نظام **مسمّاة ومفردة** `OUTBOX_PRINCIPAL='outbox'` — لا معرّف مستخدم، غير قابلة للوصول من أي
  مسار، ولا تملك صفّ مستخدم.
- تُمنح أدوار الأتمتة (`SUPER_ADMIN` الداخلية) **فقط** لوكيل مدرَج في قائمة السماح، وأي وكيل آخر
  يُحلّ بـ**صفر أدوار** فيُرفض عبر RBAC/النطاق.
- تأكيد مزدوج وقت التنفيذ (`executeClaimedTask`): يُقبل المسار فقط إذا كان `triggeredBy` يبدأ بـ
  `outbox:` **و** الوكيل في القائمة **و** `(event → agent, taskType)` مطابقًا في القائمة.
- قائمة السماح `outbox-routes.ts` صغيرة وصريحة (`order.placed → operations-agent /
  operations.health_check`) ومربوطة باختبار يُثبّتها مع `EVENT_ROUTING` (منع الانحراف).
- Kill Switch وRBAC وميزانية التشغيل (شهريًا + سقف لكل تشغيل) وسجل التدقيق (لكل حدث) كلها محفوظة؛
  الوكلاء قراءة فقط ولا يعدّلون الطلبات/المدفوعات/Ledger (لا Tool كتابة في مسار `order.placed`).

### 19.7 الواجهة (HTTP)
- **لا مسار عام جديد.** الـoutbox داخلي بالكامل؛ يُنشأ عبر إنشاء الطلب `POST /api/orders` ويُستنزف
  داخل نبضة المجدول (`src/lib/scheduler.ts` → `dispatchOutboxEvents`)، ولا يعتمد على تشغيل
  المجدول في الإنتاج لصحّة الطلب.

### 19.8 الاختبارات ونتائجها
- **`tests/ai08-outbox.test.ts`** (21 حالة، قاعدة حقيقية بلا mocks): ذرّية الطلب+الحدث، Rollback
  كامل عند الفشل، لا حجز/حركة مخزون جزئية، لا معالجة قبل الـCommit، منع تكرار الحدث والمهمة،
  استعادة الحدث بعد تعطّل العامل، لا حجز متزامن مكرّر، فشل الوكيل لا يُفشل الطلب، هوية محدودة
  وغير قابلة للانتحال (3 حالات انتحال)، منع المشتري من وكيل المنصّة، Kill Switch، وحالات repo.
- **النتائج**: حزمة الخادم كاملة **102 ملف / 1321 ناجح / 3 متخطّى / 0 فاشل**؛
  **E2E Playwright** للـspecs المتأثرة (order-lifecycle + admin-agent-ops + admin-copilot) **23 ناجح**.

### 19.9 الملفات التي تغيّرت
- `packages/server/src/db/schema/outbox.ts` (جديد) + `src/db/schema/index.ts` (تصدير)
- `packages/server/src/db/migrations/0032_event_outbox.sql` (جديد) + `meta/_journal.json`
- `packages/server/src/modules/ai/outbox-repo.ts` (جديد) — enqueue/claim/mark/reap/counts
- `packages/server/src/modules/ai/outbox-routes.ts` (جديد) — قائمة السماح الصريحة
- `packages/server/src/modules/ai/outbox-worker.ts` (جديد) — الاستنزاف والتوجيه والتدقيق
- `packages/server/src/modules/ai/runner.ts` — الهوية الموثوقة + تأكيد المسار وقت التنفيذ
- `packages/server/src/lib/scheduler.ts` — ربط الاستنزاف بالنبضة
- `packages/server/src/modules/orders/service.ts` — معاملة `createOrder` الذرّية + إدراج الحدث
- `packages/server/tests/ai08-outbox.test.ts` (جديد)

### 19.10 قيود متبقّية
- نطاق الأحداث مقصود أن يكون حدثًا واحدًا (`order.placed`)؛ الأحداث الأخرى (مثل `order.paid`) تُربط
  لاحقًا في مهام مستقلة (AI-08.1+) بقرار منفصل.
- التسليم at-least-once على مستوى الـoutbox، و**مرة واحدة فعليًا** على مستوى التأثير عبر مفتاح
  التوجيه (correlation/dedupe)؛ لا ضمان "بالضبط مرة" على مستوى نقل الصف نفسه.

## 20. دورة الوكلاء عند الطلب (GM On-Demand AI Cycle) — G8

### 20.1 الغاية
تمكين المدير العام (`SUPER_ADMIN`) من تقديم فريق الوكلاء يدويًا — توزيع الجداول المستحقة، تنفيذ
المهام في الانتظار/المعتمدة، إفشال التشغيلات العالقة، واستنزاف الصادر المعاملاتي — **دون تفعيل
المجدول في الإنتاج** (`SCHEDULER_ENABLED=false` افتراضيًا). هذه *إشارة تشغيل*، وليست محرّكًا ثانيًا،
وليست إذنًا لتنفيذ إجراءات تجارية/مالية تلقائيًا.

### 20.2 لا مسار تنفيذ جديد
`runAgentCycle` يركّب — بالترتيب نفسه — الدوال التي يناديها نبض المجدول:
`dispatchDueSchedules` → `executeDueTasks` → `reapStaleTasks` → `dispatchOutboxEvents`. لذلك تبقى
كل الضمانات كما هي: RBAC، نطاق بيانات الوكيل، مفتاح الإيقاف (kill switch)، بوابة الموافقة البشرية،
ميزانية التشغيل الواحد، الحجز أحادي المسار (single-flight claim)، ومسار تدقيق `AI.*`.

### 20.3 بوابتان على مستوى الدورة
- **أحادية المسار (single-flight):** قفل استشاري لجلسة Postgres (`pg_try_advisory_lock` على اتصال
  مخصّص) يمنع دورتين متزامنتين؛ الخاسر يُبلَّغ `blocked / ALREADY_RUNNING` بدل تكديس تمريرة ثانية.
- **ميزانية المنصّة/المشغّل:** إذا استُنفدت ميزانية الشهر (حد المنصّة العالمي أو حد المشغّل) ترفض
  الدورة البدء (`blocked / BUDGET_EXHAUSTED`) بدل الإنفاق بالسالب. الحد العالمي من صف `ai_budgets`
  العالمي إن وُجد، وإلا سقف النشر `AI_BUDGET_MONTHLY_USD`؛ والإنفاق مجموع تكاليف `ai_requests` للشهر.

### 20.4 الصدق في النتيجة
- خطوة تفشل ⇒ `AI.AGENT_CYCLE_FAILED` بالعدّادات المبلوغة حتى لحظة الفشل، ولا `COMPLETED` أبدًا.
- عملية تموت في المنتصف ⇒ يبقى `AI.AGENT_CYCLE_STARTED` بلا سجل نهائي — حالة «بدأ، النتيجة مجهولة»
  الصادقة، ويُظهرها السجل «قيد التشغيل».

### 20.5 الهوية والصلاحيات
كل مسارات الدورة تحت `requireAuth` + `requireRole('SUPER_ADMIN')`. هوية المشغّل هي `ctx.user.id`
المحلولة من الجلسة، ولا تُقرأ من جسم الطلب أبدًا، وهي الفاعل على كل قيود الدورة.

### 20.6 الواجهة (HTTP)
| Method | Path | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/api/admin/gm/cycle` | SUPER_ADMIN | تشغيل دورة واحدة؛ الجسم `{ limit? }` (1..100، الافتراضي 25)؛ يعيد النتيجة الفعلية `completed`/`blocked`/`failed` |
| GET | `/api/admin/gm/cycles` | SUPER_ADMIN | سجل الدورات (`?limit=`)، مبني على قيود التدقيق، قراءة فقط |

### 20.7 الواجهة (Web)
تبويب جديد «دورة الوكلاء» في `AdminGmPage` (`/admin/gm`): زر تشغيل، بطاقة نتيجة (الحالة/المدة/
العدّادات/الميزانية/`correlationId`)، وجدول سجل الدورات. مفاتيح `adminGm.cycle.*` في اللغات الأربع
(ar/en/fr/zh).

### 20.8 الاختبارات ونتائجها
`tests/gm-agent-cycle.test.ts` — **16/16**: RBAC (401/403/200، 422 على حدّ خارج النطاق)، دورة تُنفّذ
مهمة حقيقية وتستنزف حدث صادر حقيقيًا، عدم تنفيذ مهمة `awaiting_approval`، **احترام مفتاح الإيقاف**
(وكيل `PAUSED` ⇒ المهمة `blocked` ولا تُنفَّذ)، **عدم الكتابة على مسار الأموال** (لا طلب/دفع/حركة
مُنشأة للحدث)، أحادية المسار (`ALREADY_RUNNING`)، بوابة الميزانية (`BUDGET_EXHAUSTED`)، فشل خطوة ⇒
`failed` بلا `COMPLETED`، سجل الدورات (قراءة فقط + عبر HTTP)، وسلامة السجل. وE2E `e2e/admin-gm.spec.ts`
— **10/10**.

### 20.9 الملفات التي تغيّرت
- `packages/server/src/modules/ai/cycle.ts` (جديد)
- `packages/server/src/modules/admin/gm-routes.ts` (مسارا `/cycle` و`/cycles`)
- `packages/web/src/pages/AdminGmPage.tsx`، `packages/web/src/lib/api.ts`،
  `packages/web/src/lib/types.ts`، `packages/web/src/lib/i18n.ts`
- `packages/server/tests/gm-agent-cycle.test.ts` (جديد)

### 20.10 قيود متبقّية
- الدورة تشغيل يدوي فقط؛ لا تُفعّل المجدول ولا تُنشئ بيانات مجدولة جديدة.
- لا تُنشئ الدورة أي إجراء تجاري/مالي تلقائي؛ المهام المحتاجة موافقة تبقى `awaiting_approval`.
- القفل استشاري لكل قاعدة بيانات (per-database)؛ يكفي لمنصّة أحادية القاعدة.

---

## 21. تنفيذ إجراءات المدير العام المقترحة (GM Proposed-Action Execution) — G4

### 21.1 المشكلة
كانت توصيات المدير العام «مقترحة» فقط (`executed: false`) — عرض للقراءة دون أي وسيلة لتحويلها إلى
مهمة وكيل فعلية. G4 يجعلها قابلة للتنفيذ عبر بوابة المهام القياسية، بموافقة بشرية مضبوطة، دون فتح
مسار تنفيذ جديد أو صلاحيات جديدة.

### 21.2 المبدأ: بوابة واحدة، لا مسار موازٍ
`executeGmAction` لا ينفّذ شيئًا بنفسه؛ يتحقق من الإجراء مقابل لقطة التشغيل ثم يستدعي
`createAgentTask` — نفس بوابة الوكلاء — فترث المهمة RBAC والنطاق ومفتاح الإيقاف وبوابة الموافقة
والميزانية والتدقيق تلقائيًا. لا كتابة على مسار الأموال ولا تغيير مخطط/ترحيلات.

### 21.3 قائمة السماح الصريحة والتحقق
`GM_ACTION_ROUTES` تربط كل إجراء مقترح بوكيله ونوع مهمته. أي إجراء غير مُسجَّل ⇒ `NO_AGENT`. كل
تحقق ينتج سبب حجب مُنمّط (`GmActionReason`): `UNKNOWN_ACTION` (لم تقترحه اللقطة)، `NO_AGENT`،
`AGENT_UNAVAILABLE`، `NOT_AUTHORIZED`، `AGENT_STOPPED`، `AGENT_NOT_ACTIVE`، `CONFLICT`.

### 21.4 الموافقة البشرية
الإجراءات الحساسة (`ads.spend_increase`, `risk.block_account`, `compliance.final_ruling`,
`outreach.send`) تحمل `requiresApproval` فتُنشئ مهمة `awaiting_approval` ولا تُنفَّذ تلقائيًا أبدًا.

### 21.5 الأحادية والهوية
المفتاح `gm-action:{runId}:{action}` في `dedupe_key` (varchar 200) + الفهرس الفريد الجزئي
`agent_tasks_dedupe_open_uidx` ⇒ الطلب المتكرر/المتزامن يعيد نفس المهمة (`deduplicated: true`) ولا
يُنشئ ثانية. `triggered_by` (varchar 64) يحمل الوسم الخشن `gm-action` لأن الزوج أطول من العمود.
هوية المشغّل من الجلسة (`ctx.user.id`) لا من الجسم.

### 21.6 التدقيق
`AI.GM_ACTION_REQUESTED` ثم `AI.GM_ACTION_EXECUTED` أو `AI.GM_ACTION_BLOCKED`. `entity_id` = runId
(varchar 36)، والإجراء في `metadata` — لأن زوج runId+action يتجاوز 36 حرفًا.

### 21.7 الواجهة (HTTP)
| Method | Path | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/api/admin/gm/runs/:correlationId/actions` | SUPER_ADMIN | عرض الإجراءات المقترحة مع قابليتها للتنفيذ (قراءة فقط) |
| POST | `/api/admin/gm/runs/:correlationId/actions/execute` | SUPER_ADMIN | تنفيذ إجراء واحد؛ الجسم `{ action }` فقط؛ يعيد النتيجة الفعلية |

### 21.8 الواجهة (Web)
عمود «الحالة» وزر «تنفيذ» في بطاقة الإجراءات المقترحة بـ`AdminGmPage`: الزر معطّل حتى تُعرف قابلية
التنفيذ من العرض المُعلَّق، ويعرض سبب الحجب عند التعذّر. مفاتيح `adminGm.actions.*` و
`adminGm.actionReason.*` في اللغات الأربع (ar/en/fr/zh).

### 21.9 الاختبارات ونتائجها
`tests/gm-action-execution.test.ts` — **23/23**: RBAC والهوية من الجلسة، التحقق مقابل اللقطة،
الموافقة البشرية، الأحادية (متكرر/متزامن/إجراء مختلف)، التدقيق (REQUESTED→EXECUTED/BLOCKED)، عدم
الكتابة على مسار الأموال، وعرض الإجراءات (قراءة فقط، قابل/غير قابل). وحراسة الترجمة في
`tests/i18n-locale-parity.test.ts`، وE2E في `e2e/admin-gm.spec.ts`.

### 21.10 الملفات التي تغيّرت
- `packages/server/src/modules/ai/gm-actions.ts` (جديد)
- `packages/server/src/modules/admin/gm-routes.ts` (مسارا التنفيذ والعرض)
- `packages/web/src/pages/AdminGmPage.tsx`، `packages/web/src/lib/api.ts`،
  `packages/web/src/lib/types.ts`، `packages/web/src/lib/i18n.ts`
- `packages/server/tests/gm-action-execution.test.ts` (جديد)، `tests/i18n-locale-parity.test.ts`،
  `e2e/admin-gm.spec.ts`

### 21.11 قيود متبقّية
- الإجراءات غير المربوطة بوكيل تبقى غير قابلة للتنفيذ (`NO_AGENT`) حتى يُسجَّل لها مسار صريح.
- لا تنفيذ تلقائي؛ كل إجراء حساس يمرّ عبر بوابة الموافقة البشرية.

## 22. توحيد بوابة الأدوات — G5 Phase 1 (Ads + Development)

### 22.1 الهدف
كان `execAdsAgent` و`execDevelopmentAgent` آخر منفّذين يقرآن بيانات منصّة متعدّدة المالكين
مباشرةً خلف بوّابة داخلية `requirePlatformGate`. نقلت هذه المرحلة قراءاتهما إلى البوابة المركزية
عبر أداتين جديدتين مسجّلتين، **دون تغيير أي صلاحية أو نطاق أو سلوك**.

### 22.2 الأدوات الجديدة (قراءة فقط، نطاق المنصّة)
| الأداة | الوصف | `effect` | `permission` | `platformScoped` |
| --- | --- | --- | --- | --- |
| `ads.read_campaigns` | دفتر الإعلانات: عدد الحملات/النشطة، انطباعات/نقرات/تحويلات، CTR، وأول 5 حملات (ميزانية/مصروف) | `read` | `ad:manage` | ✅ |
| `development.read_platform` | سياق البناء: عدّ المستخدمين/المنتجات/الطلبات/الحملات + أحدث مؤشر يومي | `read` | `analytics:read:all` | ✅ |

كلاهما `read` فقط، مخطط مُدخل `.strict()` (لا حقن هوية/نطاق)، ولا يمنح أي صلاحية جديدة: الصلاحية
المطلوبة مملوكة أصلاً من `ADMIN`/`SUPER_ADMIN`، وبوّابة النطاق الإدارية هي الحكم.

### 22.3 ما تغيّر في المنفّذين
- `execAdsAgent` و`execDevelopmentAgent`: يبقيان على `requirePlatformGate` كما هو (دفاع في العمق)،
  ثم يقرآن **فقط** عبر `invokeTool` — لا استعلام Drizzle مباشر داخل الجسم.
- `allowedTools`: أُضيف `ads.read_campaigns` لـ`ads-agent` و`development.read_platform`
  لـ`development-agent` فقط. لم تُمسّ `permissionsRequired` ولا `requiresPlatformScope` ولا
  `approvalActions`.

### 22.4 الأمان (لا توسيع)
- البوابة تفشل مغلقًا: `NO_RUN_CONTEXT` (بلا سياق موثوق)، `ACTION_NOT_AUTHORIZED` (أداة غير
  ممنوحة)، `PLATFORM_SCOPE_DENIED` (دور يملك الصلاحية لكن ليس إداريًا)، `INVALID_INPUT` (محاولة
  حقن معطيات).
- لا كتابة: كل الأدوات `read`؛ الاختبار يثبّت ثبات صفوف `campaigns`/`ad_events` بعد قراءات متكرّرة.
- المجدول و`SYSTEM_PRINCIPAL` وبقية الوكلاء: لم يُمَسّوا — لا `ads-agent` ولا `development-agent`
  في `DEFAULT_SCHEDULES` ولا في `OUTBOX_ROUTES`.

### 22.5 الاختبارات ونتائجها
- `tests/g5-phase1-tool-unification.test.ts` — **18/18** (تسجيل الأداتين + قراءة فقط + عدم تفعيل
  `UNBOUND_DECLARED_TOOLS` + رفض غياب السياق/الأداة غير الممنوحة/غير الإداري/حقن المعطيات + نجاح
  المسار المصرّح مع تدقيق `AI.TOOL_EXECUTED` + عدم كتابة + تشغيل المنفّذين الحقيقيين + عدم التوسيع
  + سلامة المجدول/الصادر/`SYSTEM_PRINCIPAL`).
- `tests/phase3d-scope-gate.test.ts` — محدَّث: `execAdsAgent`/`execDevelopmentAgent` يقرآن عبر
  `invokeTool` **مع** الإبقاء على `requirePlatformGate` وبلا `.from(` مباشر.

### 22.6 الملفات التي تغيّرت
- `packages/server/src/lib/ai/tool-registry.ts` (أداتان جديدتان)
- `packages/server/src/lib/ai/tool-handlers.ts` (معالجان)
- `packages/server/src/modules/ai/executors.ts` (توجيه المنفّذين)
- `packages/server/src/modules/ai/catalogue.ts` (`allowedTools` فقط)
- `packages/server/tests/g5-phase1-tool-unification.test.ts` (جديد)، `tests/phase3d-scope-gate.test.ts`

### 22.7 قيود متبقّية
- بقي 10 منفّذين بنطاق المالك خارج البوابة (`sales`, `marketing`, `support`, `product`, `b2b`,
  `customer-intelligence`, `outreach-acquisition`, `supplier`, `merchant`) + `agent-supervisor`.
  توحيدهم = G5 Phase 2 وما بعدها (لم تبدأ).
- لا أدوات كتابة أو مالية جديدة؛ لا migrations.
