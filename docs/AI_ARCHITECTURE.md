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

> ملاحظة نطاق: البوابة **ليست** القناة الإلزامية لكل أدوات الوكلاء بعد؛ بقي 12 منفّذاً
> آخر يقرأون مباشرةً بنطاق ذاتي أو بوّابة داخلية (انظر القسم 10).

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
| `execAdsAgent`, `execDevelopmentAgent` | بوّابة داخلية `requirePlatformGate` (إداري) |
| `execSalesAgent`, `execMarketingAgent`, `execSupportAgent`, `execB2BAgent`, `execCustomerIntelligenceAgent`, `execOutreachAcquisitionAgent` | وصول مشروع ضمن نطاق المالك / قراءة عامة مسموحة |
| `execMarketResearchAgent` | **ثغرة مؤكّدة** (مجاميع منصّة بلا قيد) → أُصلحت في AI-03.6 (القسم 14) |
| `execSupplierAgent`, `execMerchantAgent` | وصول مشروع ضمن نطاق المالك |
| `execAgentSupervisor` | حتمي، بلا قراءة صفوف متعدّدة المالكين |

لا تُعدّ مجرّد عدم المرور عبر البوابة ثغرة بذاتها؛ التصنيف مبنيّ على أثر أمني مُثبَت.

### 10.5 قيود متبقّية
- البوابة ليست إلزامية لكل الأدوات بعد (12 منفّذاً خارجها بنطاق ذاتي/بوّابة داخلية). توحيدها
  مهمّة مستقلة.
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
