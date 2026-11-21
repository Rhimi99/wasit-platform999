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

## 3. AI AGENTS — الهيكل الرسمي (AI-ARCH-ALIGN-01)

الكتالوج (`modules/ai/catalogue.ts`) هو مصدر الحقيقة الوحيد، وكل وكيل يحمل `tier` صريحاً.

### 3.1 الوكلاء المتخصصون الرسميون (12)

`sales-agent` · `marketing-agent` · `ads-agent` · `product-agent` · `support-agent` ·
`analytics-agent` · `market-research-agent` · `b2b-agent` · `risk-agent` ·
`dispute-assistant` · `development-agent` · `marketing-video-agent`

القائمة المرتّبة في `CORE_SPECIALIST_KEYS`؛ أي إضافة أو حذف يمرّ بتعديل هذه القائمة **و** الكتالوج،
وإلا يفشل `catalogueIntegrity()` والاختبارات.

### 3.2 الوكلاء الداعمون (8) — ليسوا من الاثني عشر

`finance-agent` · `payment-settlement-agent` · `compliance-agent` · `supplier-agent` ·
`merchant-agent` · `customer-intelligence-agent` · `operations-agent` · `outreach-acquisition-agent`

هوية وعقد فقط (لا منفّذ)، ولا يجوز عرضها كوكلاء رسميين.

### 3.3 طبقة الحوكمة

| الوكيل | الدور | التنفيذ |
| --- | --- | --- |
| `wasit-copilot` | تنسيق: خطة → فحص صلاحيات → ترتيب تبعيات → إرسال → متابعة → تجميع | طبقة `planner`/`dispatcher`/`supervisor` |
| `agent-supervisor` | رقابة: كشف التعثّر/الفشل/الميزانية والتصعيد للمدير العام | `supervisor.ts` + `escalations.ts` |

لا أحدهما وكيلاً متخصصاً، ولا يقبلان إسناد مهمة (`COPILOT_NOT_RUNNABLE` / `SUPERVISOR_NOT_RUNNABLE`).

### 3.4 القاعدة الحاكمة

**مُعلن ≠ قابل للتنفيذ ≠ مسجَّل ≠ قابل للتوجيه.** `executable` خاصية في الكود (وجود فرع في
`executeAgentTask`)، والتسجيل في `agent_registry` هوية لا سلطة. `agentRunRefusal` هو الحارس الموحّد
في التخطيط والإرسال وكل مسار إنشاء مهمة.

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
- **فصل المهام (AI-02.P0):** منشئ مهمة وكيل لا يعتمد طلبه بنفسه — الحارس في `decideAgentTask` (Backend) ويرجع `403`، ويشمل `SUPER_ADMIN`. أي إجراء حساس يحتاج معتمِدًا مخوّلًا **مختلفًا**؛ سحب الطالب لطلبه (رفض) مسموح لأنه يزيل عملًا لا يؤذن به.
- Audit لكافة طلبات AI (من/ماذا/تكلفة). هوية المنفّذ الآلي `SYSTEM` (`audit_logs.actor_type`) مع إبقاء المهمة منسوبة لمنشئها.
- أنماط الإساءة (طلب كثير) → AI Budgets + Rate Limit.

## 6.5 WASIT AI COPILOT (مُنفَّذ جزئياً — طبقة التنسيق فقط)

> الحالة (2026-11-20): **طبقة التنسيق موجودة وتعمل**: `planner.ts` (تحقق + ترتيب تبعيات + حفظ خطة)،
> `dispatcher.ts` (إرسال خطوة عبر نظام المهام الحقيقي)، `supervisor.ts` (رقابة/حجب/إعادة محاولة)،
> و`POST /api/admin/ai/agent-runs` لإنشاء خطة. **غير موجود**: تفكيك الهدف آلياً (لا LLM Planner)،
> واختيار الوكيل تلقائياً، وواجهة ويب. الاختيار والتفكيك قرار المتصل، والكود يتحقق من الأهلية فقط.

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

## 6.6 حدود Copilot الملزمة (مُثبتة باختبارات)

| الحد | الآلية | الاختبار |
| --- | --- | --- |
| لا يوجّه عملاً لوكيل بلا منفّذ | `agentRunRefusal` داخل `validatePlan` | `tests/ai-arch-align-copilot.test.ts` |
| لا يوجّه لنفسه ولا للمشرف | `COPILOT_NOT_RUNNABLE` / `SUPERVISOR_NOT_RUNNABLE` | نفسه |
| لا يوسّع صلاحية الطالب | `validatePlan` يطلب كل صلاحيات الوكلاء من الطالب | `tests/ai023-dispatch.test.ts` |
| التخطيط ليس تنفيذاً | الخطة تُكتب `PLANNING`، صفر مهام | `tests/ai-arch-align-copilot.test.ts` |
| الخطوة لا تُعاد توجيهها | `agent_run_steps.agent_key` هو المرجع عند الإرسال | نفسه |
| الموافقة لا تُجسر آلياً | خطوة `requiresApproval` تبقى `PENDING` حتى موافقة بشرية مختلفة | `tests/ai023-dispatch.test.ts` |
| Kill Switch يوقف الكل | `assertAiExecutionEnabled` في التخطيط والإرسال | `tests/a1-kill-switch.test.ts` |

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

### 7.1 هوية الوكيل مقابل القدرة (AI-ARCH-ALIGN-01)

القدرة موجودة، والهوية أُضيفت الآن، والتنفيذ **مرفوض عن قصد**:

| السؤال | الجواب |
| --- | --- |
| هل التوليد يعمل فعلاً؟ | نعم — `StructuralVideoProvider` (ffmpeg/libass) + تخزين خاص + روابط موقّعة |
| من يشغّله اليوم؟ | صاحب الحساب عبر `modules/media/routes.ts` (يتطلب `media:upload` وملكية المنتج) |
| هل `marketing-video-agent` ينفّذه؟ | **لا** — `executable: false`، وأي محاولة إسناد تُرفض `AGENT_NOT_EXECUTABLE` |
| لماذا؟ | ربط المنفّذ يحتاج قراراً تجارياً: سقف التكلفة، ملكية الأصول، سياسة النشر، ومن يوافق |

العقد الكامل للوكيل: `docs/AI_MARKETING_VIDEO_AGENT.md`. القرار: AD-049.

## جدولة تنفيذ الوكلاء (AI-01)

- **الوكلاء لم يعودوا طلب-استجابة فقط**: جدول `agent_schedules` يحمل الصفوف الدائمة، و`runAgentSchedules`
  في `lib/scheduler.ts` يمسحها دورياً (مُطفأ افتراضياً عبر `AI_AGENT_SCHEDULER_ENABLED=false`).
- **تنفيذ واحد فقط عبر النسخ**: المطالبة استعلام واحد `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`
  مع عقد (`lease_owner`/`lease_expires_at`). القفل داخل العملية (`agentRunInFlight`) ليس ضمانة عبر النسخ.
- **لا مسار تنفيذ موازٍ**: التنفيذ ينادي `createAgentTask` نفسه (RBAC + ميزانية + تدقيق) — لا كاتب ثانٍ.
- **fail-closed للموافقة والميزانية**: وكيل بـ`requiresHumanApproval` لا يُجدول (409)، ويُتخطّى وقت التشغيل
  لو صار مقيّداً؛ نفاد الميزانية يُوقف الإنشاء (429) قبل أي استدعاء مزوّد.
- **هوية SYSTEM**: `audit_logs.actor_type` يميّز التنفيذ الآلي (`SYSTEM`) عن فعل المستخدم (`USER`)،
  مع إبقاء المهمة منسوبة لمنشئ الجدولة للمساءلة.
- التفاصيل الكاملة: `docs/AI-01_AGENT_SCHEDULING.md`.

## Agent Runs & آلة الحالات (AI-02.1)

- **الأساس التأسيسي لـSupervisor**: جدولا `agent_runs` (تشغيل واحد بهدف) و`agent_run_steps` (خطواته)
  يمثّلان التشغيل المركّب قبل بناء منطق التخطيط/التنسيق. ترحيل `0028_keen_gunslinger.sql`.
- **العلاقات والقيود**: `agent_run_steps.run_id` → `agent_runs.id` بمفتاح أجنبي `ON DELETE CASCADE`
  (أول FK صريح في المستودع)، فهرس فريد `(run_id, step_key)`، و3 CHECKs (`priority>=0`، سلامة المحاولات،
  `depends_on` مصفوفة). سلامة التبعيات الدائرية تُفرض في دالة على مستوى التشغيل لأنها لا تُعبَّر بـCHECK.
- **آلة الحالات مركزية**: `modules/ai/run-state-machine.ts` يعرّف 11 حالة تشغيل و10 حالات خطوة، وجدولا
  انتقالات قانونية، ودوال `assertRunTransition`/`assertStepTransition` ترمي `409` على أي انتقال غير قانوني.
- **الحالات النهائية محمية**: لا إحياء لحالة نهائية دون سياسة صريحة (`allowReopen`). الإكمال لا يتحقق إلا
  إذا انتهت كل الخطوات ونجحت واحدة على الأقل، و`COMPLETED` تتطلب نجاح كل الخطوات وإلا `PARTIALLY_COMPLETED`.
- **فصل الهوية**: التشغيل منسوب دائمًا لمن طلبه (`requested_by`)؛ لا تُستبدل هوية `SYSTEM` بهوية المستخدم.
- **حدود المرحلة**: لا `planRun`/`dispatchStep`/Tool Gateway/إعادة محاولة/Kill Switch/واجهة Supervisor بعد.
- التفاصيل الكاملة: `docs/AI-02.1_AGENT_RUNS_STATE_MACHINE.md`.

## طبقة التخطيط وحلّ التبعيات (AI-02.2)

- **الوظيفة**: خدمة `modules/ai/planner.ts` تحوّل هدفاً من المدير العام + خطوات مقترحة إلى خطة محفوظة
  في `agent_runs` (حالة `PLANNING`) و`agent_run_steps`. **لا تفهم الأهداف عبر LLM** — المتصل يزوّد الخطوات.
- **التحقق**: كل خطوة تُربط بوكيل مسجّل ونشط في `agent_registry`؛ تُرفض المفاتيح المكرّرة، المدخلات غير
  الصالحة، وتجاوز الحدود (25 خطوة، 16KB للخطوة). الطالب يجب أن يملك كل صلاحية يطلبها الوكلاء.
- **الترتيب**: طوبولوجي حتمي — الأولوية ثم المفتاح عند التساوي؛ الأولوية لا تتجاوز التبعية. يُعاد
  استخدام `assertValidDependencies` من AI-02.1، ويُعاد فحص الرسم في كل خطة وفي كل قراءة (`loadPlan`).
- **الحفظ**: `executionOrder` مشتق عند القراءة لا مخزَّن في عمود جديد (لا تغيير على مخطط AI-02.1).
- **حدود صارمة**: لا تنفيذ، لا Executor، لا `dispatchStep`، ولا انتقال إلى `DISPATCHING`/`RUNNING`.
  إنشاء الخطة **ليس** موافقة: الخطوة الحساسة تُسجَّل `requiresApproval=true` وتبقى `PENDING`.
- التفاصيل الكاملة: `docs/AI-02.2_PLANNING_DEPENDENCY_RESOLUTION.md`.

## طبقة الإرسال والتنفيذ المنضبط (AI-02.3)

- **الوظيفة**: خدمة `modules/ai/dispatcher.ts` تُرسل خطوة صالحة من خطة محفوظة إلى **نظام المهام الحالي**
  (`createAgentTask`/`decideAgentTask`) وتُسجّل النتيجة. **لا Executor مباشر، ولا نظام مهام موازٍ.**
- **الربط (بلا Migration)**: `__runId`/`__stepId` داخل `agent_tasks.input` (jsonb)، متسق مع اصطلاح `__userId`.
- **منع التكرار/التزامن**: مطالبة ذرّية `UPDATE agent_run_steps ... WHERE status IN ('PENDING','READY') RETURNING`
  (فائز واحد عند التزامن) + فحص مهمة قائمة بنفس `__stepId` + رفض الحالات النهائية/`RUNNING`. انقطاع
  الاستجابة لا يُفسَّر كعدم إنشاء؛ يُعاد قراءة الحالة الفعلية ولا تُنشأ مهمة بديلة.
- **التبعيات/الفشل**: لا إرسال قبل نجاح كل التبعيات؛ عند فشل خطوة تُعلَّم التابعة `SKIPPED` بشكل متعدٍّ.
  `SKIPPED` ليست نجاحاً. **لا Retry في هذه المرحلة** (الفشل → `FAILED` مسجّلة).
- **الموافقات**: `approveRunStep` يشترط موافقاً مخوّلاً ≠ طالب التشغيل (حماية AI-02.P0)؛ الخطوة الحساسة
  تُجسر عبر Approval Engine القائم، لا مسار متجاوز.
- **الإكمال**: `reconcileRun` يغلق الخطة `COMPLETED`/`PARTIALLY_COMPLETED`/`FAILED` عبر آلة حالات AI-02.1؛
  لا توسيع صلاحيات أي وكيل، ولا مالية/خارجية حقيقية.
- التفاصيل الكاملة: `docs/AI-02.3_CONTROLLED_EXECUTION.md`.

## موثوقية التنفيذ والاستعادة (AI-02.3.1)

- **الوظيفة**: نفس `modules/ai/dispatcher.ts` صار يحوي طبقة مزامنة/استعادة: `syncStepFromTask`،
  `recoverStuckSteps`، `recoverRun`، و`findTaskForStep`. لا Executor جديد ولا نظام موازٍ.
- **المزامنة (idempotent)**: خطوة `RUNNING` تُقارن بمهمتها (`input.__stepId`): نجاح بوجود نتيجة → `SUCCEEDED`؛
  `failed`/`rejected` → `FAILED`؛ `queued`/`running`/`awaiting_approval`/مجهول → **لا إجراء**. لا كِتابة/تدقيق
  إلا عند تغيّر فعلي (لا تكرار Audit).
- **الاستعادة**: `recoverStuckSteps` تجد الخطوات العالقة `RUNNING` بعد مهلة، تطالب بها **ذرّياً** بالإيجار
  (`updated_at`) فلا تتصادم عمليتا Recovery؛ خطوة بلا مهمة → `FAILED` (لا إنشاء بديل)؛ ثم `reconcileRun`.
- **دقّة الإغلاق**: إغلاق الخطوة مشروط بفحص الصفوف المتأثرة (`settleRunningStep` = `UPDATE … RETURNING id`).
  صفر صفوف ⇒ `lost_race` (لا `recovered`، لا Audit نجاح) ويُسجَّل `AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE`
  ويُزاد `lostRace` في الدورة؛ لا يُستدعى `reconcileRun` لخطوة خسرت السباق. بلا تغيير Fencing/`attempt_count`.
- **نقطة التشغيل**: المُجدول الداخلي `lib/scheduler.ts` (`runAgentRunRecovery`) عبر `index.ts` — مُطفأة
  افتراضياً (`AI_AGENT_RUNS_RECOVERY_ENABLED=false`). لا Worker/طابور جديد.
- **المهل**: `AI_AGENT_RUN_STEP_STUCK_SECONDS` (افتراضي 300) و`AI_AGENT_RUNS_RECOVERY_INTERVAL_MINUTES`
  (افتراضي 5) — لا قيمة سحرية.
- **الذرّية (بلا Migration)**: المطالبة الذرّية `UPDATE ... WHERE status IN ('PENDING','READY') RETURNING`
  تبقى الكاتب الوحيد؛ نافذة الانقطاع بين المطالبة وإنشاء المهمة تُعالَج بالاستعادة لا بمعاملة زائفة
  (لأن `createAgentTask` ينفّذ متزامناً).
- **الحدود**: لا Retry (`maxAttempts=1` مفروض في `dispatchStep`)؛ لا مساس بـAI-02.P0 ولا بتوسيع صلاحيات
  الوكلاء؛ Recovery لا يوافق ولا ينتحل هوية موافق.
- التفاصيل الكاملة: `docs/AI-02.3.1_EXECUTION_RELIABILITY_RECOVERY.md`.

## الـFencing وأمان التزامن (AI-02.3.2)

- **المشكلة:** بين مطالبة Dispatch (RUNNING) وإنشاء المهمة/كتابة النتيجة نافذة؛ قد تُغلق Recovery الخطوة `FAILED` ثم يكتب Dispatch القديم فوق القرار، أو ينشئ مهمة بعد فقدان الملكية.
- **الـFencing token:** `attempt_count` يُزاد ذرّياً عند المطالبة ويُعاد للفائز كـ**token**؛ كل كتابة تحمل `WHERE id=? AND status='RUNNING' AND attempt_count=<token>` → كتابة قديمة = no-op.
- **حماية الخدمة:** `createAgentTask(..., fencing)` يتحقق من الملكية ويُدرج المهمة **في معاملة واحدة**؛ لا مهمة بعد فقدان الملكية؛ لا يوسّع صلاحيات. **الترتيب مقصود:** `UPDATE` الملكية (قفل صف الخطوة) **قبل** فحص التكرار، فيتسلسل المُنشِئون المتزامنون ولا تنشأ **مهمتان نشطتان** للخطوة نفسها (تحت `READ COMMITTED`).
- **تعدد عمليات Server:** الضمان على مستوى قاعدة البيانات (أقفال الصفوف + شرط الملكية)، لا Mutex في الذاكرة؛ مُثبت باختبار تزامن حقيقي بحوضَي اتصال مستقلين.
- **Recovery:** الإيجار يمنع معالجة خطوة ما زالت تملك مطالبة صالحة؛ لا تصنيف مبكر `FAILED`؛ خطوة بلا مهمة فقط بعد انتهاء الإيجار.
- **حارس العملية:** `createInFlightGuard()` يمنع تداخل الدورات ويُحرَّر في `finally`.
- **السجلات:** كل دورة Recovery (حتى الفارغة) تُسجَّل بـ`correlationId` وعدّادات وحالة؛ أخطاء الخطوات معزولة.
- **AUTO_DISPATCH:** أُزيل (إعداد ميّت).
- التفاصيل الكاملة: `docs/AI-02.3.2_FENCING_CONCURRENCY_RECOVERY_SAFETY.md`.

## المشرف الآلي وسياسة إعادة المحاولة (AI-02.S1)

- **الفكرة:** طبقة تنسيق تقرأ التشغيلات الحيّة وتتّخذ تدخّلات محدودة — **لا Executor جديد، لا طابور موازٍ**.
- **الخدمة:** `modules/ai/supervisor.ts` — `runSupervisorCycle` (دورة محدودة) · `containRun` (حجب) · `retryStep` (إعادة محاولة) · `buildSupervisorOverview` (قراءة).
- **السياسة:** `modules/ai/supervisor-policy.ts` (قائمة) تُغذّى بصفوف حقيقية؛ `modules/ai/retry-policy.ts` (جديدة، صرفة) تقرّر إعادة المحاولة fail-closed.
- **ما يراقبه:** التشغيلات النشطة/المتعثّرة (stuck/stale)/الحلقات/تجاوز الميزانية، وعدد الخطوات الفاشلة/المنتظرة لإعادة المحاولة.
- **متى يحجب:** عند تعثّر خطوة `RUNNING` بعد `stuckRuntimeSeconds`، أو قِدَم خطوة في الطابور بعد `staleQueueSeconds`، أو بلوغ سقف المحاولات، أو تجاوز `maxRunCostUsd`. الحجب يُغلق التشغيل `FAILED` عبر آلة الحالات ويُلغي خطواته غير المنتهية — **لا يُغلق `COMPLETED` أبداً**.
- **متى يعيد المحاولة:** خطوة `FAILED` فقط، ضمن سقف `maxAttempts=3`، مع تبعيات `SUCCEEDED` وميزانية متاحة وتشغيل مفتوح. الانتقال `FAILED → RETRYING → RUNNING` (آلة AI-02.1) عبر `dispatchStep`.
- **الصلاحيات:** كل إرسال يمرّ بفحص صلاحيات `run.requestedBy` داخل `dispatchStep`؛ Supervisor لا يرفع صلاحية ولا يوافق على خطوة (الموافقة فعل بشري من معتمِد مختلف).
- **التدقيق:** `AI.AGENT_RUN_CONTAINED` · `AI.AGENT_RUN_STEP_RETRY_SCHEDULED` · `AI.AGENT_RUN_STEP_RETRY_FAILED` · `AI.AGENT_RUN_SUPERVISOR_FAILED` — بهوية `SYSTEM`.
- **التزامن:** الحكم قاعدة البيانات (قفل صف التشغيل + كتابات شرطية + مطالبة `dispatchStep` الذرّية)؛ `createSupervisorCycleGuard()` يمنع التداخل داخل العملية فقط.
- **الحدود:** لا LLM Planner · لا Tool Gateway · لا Kill Switch · لا واجهة ويب · لا Migration.
- التفاصيل الكاملة: `docs/AI-02.S1_SUPERVISOR_RETRY.md`.