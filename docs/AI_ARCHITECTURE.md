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