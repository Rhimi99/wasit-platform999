# AI-INTEG-P3 — تصميم دمج الأساس الأمني مع محرك Master

> **النوع:** تصميم فقط — **لا تنفيذ، لا تعديل ملفات إنتاجية، لا DB، لا commit.**
> **الفرع:** `master` · **HEAD:** `98c3a95` · **الحالة:** 99 M / 110 ?? / 0 staged.
> **الأساس المُدخَل في P2:** `scope.ts` · `agent-run-context.ts` · `supervisor-policy.ts`
> (غير مربوطة بإنتاج **آنذاك**).
> **المرجع المصمِّم:** `origin/ci/repair-sandbox-2u-g-20261020-190057` @ `0c3d239`.

> **ملاحظة حالة حالية (أُضيفت في T1.8):** هذا مستند **تصميم** كُتب قبل التنفيذ، ويروي حالة
> اللحظة (`HEAD 98c3a95`، 99 M / 110 ??). منذ ذلك الحين نُفِّذت مراحل عدّة (T1 → T1.1 →
> T1.3 → T1.6 → G2 → G3)؛ أرقام الأسطر ونقاط الربط أدناه **تاريخية** وقد تغيّرت (مثلاً
> `agents.ts` صار ~901 سطراً، `runtime.ts` ~351). للتنفيذ الفعلي راجع تقارير T1 وما بعده.
> **المُنفَّذ مقابل المصمَّم:** T1 (W1/W2/W3) ✅ · G2 (مفتاح `__agentTaskId` موثوق) ✅ ·
> G3 (نقل تكلفة `OVER_BUDGET`) ✅ · **T2 (W4، بوّابة `requireAction`) لم يُنفَّذ بعد** ·
> W5/W6/W7 مؤجّلة.

---

## 0. خلاصة تنفيذية

محور التصميم: **إدخال الربط تدريجياً عبر طبقة توافق إضافية (additive)**، بحيث يكون كل
ربط **no-op عند غياب سياق التشغيل**، فلا يتغيّر أي سلوك قائم. اكتشاف حاسم: مخطط Master
المُلتزَم في P0 **يتضمّن فعلاً** أعمدة Rescue المطلوبة (`scope_owner`, `limits`,
`allowed_tools`, `attempts`, `task_type`, `triggered_by`, `dedupe_key`) — أي أن الأساس
البياني جاهز، والمفقود هو **طبقة التنفيذ (Runner)** فقط.

**المبدأ الحاكم:** `AsyncLocalStorage` يعني أن أي ربط لا يُفعَّل إلا داخل
`withAgentRunContext(...)`؛ وطالما لا يوجد Runner، تبقى كل الحرّاس no-op. لذا يمكن إدخال
الربط **بأمان تام**، ويكفي أن نلفّ نقطة التنفيذ الفعلية الوحيدة في Master
(`executeAgentTask`) لتتحوّل الحرّاس إلى فعّالة.

---

## 1. بوابة الحالة (P3)

| البند | القيمة | النتيجة |
| --- | --- | --- |
| المسار | `/workspace/project` | ✅ |
| الفرع | `master` | ✅ |
| HEAD | `98c3a958a0faa7e1bf174e33900d3c298578b4aa` | ✅ |
| staged | 0 | ✅ |
| modified / untracked / deleted | 99 / 110 / 0 (إجمالي 209) | ✅ |
| ملفات P2 السبعة | موجودة | ✅ |
| M0 bundle | `e731e684…fa8694` | ✅ |

---

## 2. خريطة الملفات ونقاط الربط الدقيقة

### 2.1 ملفات المحرك الحالية (Master)

| الملف | الأسطر | الحالة في git | الدور |
| --- | --- | --- | --- |
| `modules/ai/agents.ts` | 528 | **M** (من الـ202) | `createAgentTask` / `decideAgentTask` / `getTask` — **نقطة التنفيذ** |
| `modules/ai/executors.ts` | 884 | نظيف | **11 منفّذاً `exec*`** (يقرأ `input.__userId`) + `executeAgentTask` الموجِّه = **12 دالة، 11 نقطة تنفيذ فعلية** |
| `modules/ai/dispatcher.ts` | 884 | نظيف | Runs/Fencing/Recovery/Approval |
| `modules/ai/planner.ts` | 404 | نظيف | تخطيط Runs + فحص صلاحيات |
| `modules/ai/run-state-machine.ts` | 280 | نظيف | انتقالات الحالة (نقي) |
| `modules/ai/scheduling.ts` | 482 | نظيف | `runClaimedSchedule` → `createAgentTask` |
| `lib/ai/runtime.ts` | 244 | نظيف | `runAIFeature` — نداء المزوّد + ledger |
| `lib/ai/cost-control.ts` | 266 | نظيف | `assertWithinBudget` / `recordAiRequest` |
| `modules/ai/routes.ts` | 286 | نظيف | مسارات HTTP |

### 2.2 وحدات P2 (حالتها عند كتابة التصميم: غير مربوطة)

| الوحدة | التصديرات القابلة للربط |
| --- | --- |
| `scope.ts` | `deriveScope`, `tryDeriveScope`, `derivePlatformScope`, `deriveSystemScope`, `assertValidScope`, `resolvePlatformScope`, `userHasPlatformScope` |
| `agent-run-context.ts` | `withAgentRunContext`, `withAgentRunBudget`, `AgentRunBudget`, `getAgentRunContext`, `getAgentRunBudget`, `requireAction`, `mergeAgentTaskMetadata` |
| `supervisor-policy.ts` | `recommendIntervention`, `DEFAULT_SUPERVISOR_LIMITS` |

### 2.3 نقاط الربط الدقيقة (File:Line)

| # | الوحدة | نقطة الربط | السطر الحالي |
| --- | --- | --- | --- |
| W1 | `agent-run-context` | لفّ التنفيذ غير المُعتمَد | `agents.ts:318` (`executeAgentTask` في `createAgentTask`) |
| W2 | `agent-run-context` | لفّ التنفيذ بعد الموافقة | `agents.ts:485` (`executeAgentTask` في `decideAgentTask`) |
| W3 | `agent-run-context` | حرّاس الميزانية + دمج الميتاداتا | `runtime.ts:143` (بعد `assertWithinBudget`) و`:148` (قبل `provider.call`) و`:170`/`:197` (الميتاداتا) |
| W4 | `requireAction` | بوّابة الإجراءات | بداية كل منفّذ في `executors.ts` (**11 دالة `exec*`**) |
| W5 | `scope` | قراءة/كتابة `agent_metrics` / `agent_memory` | repos جديدة (غير موجودة) |
| W6 | `scope` | توحيد فحص المنصة | `dispatcher.ts:244`, `planner.ts:227`, `routing.ts:37`, `routes.ts:254` |
| W7 | `supervisor-policy` | قرار الاحتواء | مشرف/مراقب جديد (غير موجود) |

> **ملاحظة حاسمة (W1/W2):** لا يوجد Runner في Master؛ نقطة التنفيذ الفعلية الوحيدة هي
> `executeAgentTask` المستدعاة من `agents.ts` فقط. لفّها هو **أقل تغيير يحوّل الحرّاس من
> no-op إلى فعّالة**، دون إدخال Runner.

---

## 3. تدفق التنفيذ قبل الربط وبعده

### 3.1 قبل (Master اليوم)

```
HTTP route (routes.ts)
  └─ createAgentTask(db, roles, userId, input, audit)         [agents.ts]
       ├─ getAgentDef → فحص capability (ADMIN يتجاوز)
       ├─ فحص المهام النشطة (env.AI_AGENT_MAX_ACTIVE_TASKS_PER_USER)
       ├─ INSERT agent_tasks
       └─ إن لم تتطلب موافقة:
            executeAgentTask(db, agent, {…input, __userId})    ← التنفيذ
              └─ exec* (executors.ts)  ─ يقرأ input.__userId مباشرة
                   └─ runAIFeature(db, {userId, roles:['SUPER_ADMIN'], metadata})
                        ├─ assertWithinBudget (شهري)
                        ├─ provider.call
                        └─ recordAiRequest(metadata: {agentKey, action, provider})
```

**نقاط الضعف الحالية:** (أ) لا سياق تشغيل موثوق — الميتاداتا `agentKey` تأتي من المنفّذ
لا من مصدر موثوق؛ (ب) لا بوّابة إجراءات؛ (ج) لا سقف تكلفة لكل تشغيل؛ (د) `agent_metrics`/
`agent_memory` بلا حاجز scope؛ (هـ) لا قرار احتواء آلي.

### 3.2 بعد (الربط المستهدف)

```
HTTP route
  └─ createAgentTask(…)
       ├─ [W0] اشتقاق السياق الموثوق من صف المهمة + سجل الوكلاء (DB):
       │        taskId, agentKey, taskType, requestedBy,
       │        requesterRoles = rolesOf(db, requestedBy)   ← من DB لا من العميل
       │        authorizedActions = capabilities[].action
       │        allowedTools      = agentRegistry.allowed_tools
       │        runCapUsd         = agentRegistry.limits.maxCostUsdPerRun (fallback افتراضي)
       │        runBudget = new AgentRunBudget(cap, parseStoredCostUsd(task.cost))
       └─ [W1/W2] withAgentRunContext(ctx, () => withAgentRunBudget(runBudget, () =>
                    executeAgentTask(db, agent, {…input, __userId})
                      └─ exec*:
                           ├─ [W4] requireAction('<literal-action>')   ← fail-closed
                           └─ runAIFeature(…)
                                ├─ [W3] runBudget.reserve(est) → رفض قبل النداء
                                ├─ [W3] mergeAgentTaskMetadata(input.metadata, getAgentRunContext())
                                ├─ provider.call
                                └─ [W3] runBudget.settle(est, actual) → recordAiRequest
                 )))
```

**مبدأ عدم الكسر:** عند غياب السياق (المسارات التي لا تمرّ بـ`createAgentTask`، مثل
`/api/ai/run`)، فإن `getAgentRunContext()` = `undefined` و`getAgentRunBudget()` =
`undefined`، فيكون:
- `reserve/settle/release` ⇒ **مُتخطّاة** (`runBudget?.…`);
- `mergeAgentTaskMetadata(meta, undefined)` ⇒ **يحذف** `taskId/agentKey` المزوَّدين
  (سلوك Rescue المقصود لمنع التزييف).

⚠️ **تعارض يجب حلّه في T1:** `executors.ts` يضع `metadata.agentKey` صراحةً اليوم. تطبيق
`mergeAgentTaskMetadata` حرفياً **سيحذفه** عند غياب السياق ⇒ تغيّر بيانات `ai_requests`.
**الحل المعتمد:** صيغة توافق إضافية داخل `runtime.ts`:
`const requestMetadata = ctx ? mergeAgentTaskMetadata(input.metadata, ctx) : (input.metadata ?? {})`
— أي **عند غياب السياق: مطابق لـMaster تماماً**؛ وعند وجوده: دمج موثوق. هذا يحقق
«عدم تعطيل السلوك الحالي عند غياب سياق AI».

> **تحديث تنفيذي (T1.8):** في التنفيذ الفعلي صار فرع «غياب السياق»
> `stripReservedAgentMetadata(input.metadata)` بدل `(input.metadata ?? {})` — أي يحذف
> **فقط** المفتاح المحجوز `__agentTaskId` (دليل المصالحة) ويُبقي كل المفاتيح الأخرى،
> تحقيقاً لـG2 دون تغيير بقية السلوك. أما فرع «وجود السياق» فبقي `mergeAgentTaskMetadata`.

---

## 4. ترتيب التنفيذ على مهام صغيرة مستقلة

| المهمة | المحتوى | يعتمد على | قابلية الإغلاق | المخاطر |
| --- | --- | --- | --- | --- |
| **T1** | ربط `agent-run-context` في `agents.ts` (W1/W2) + `runtime.ts` (W3) | — | ✅ **مستقلة تماماً** | منخفضة |
| **T2** | بوّابة `requireAction` في `executors.ts` (W4) + اشتقاق قائمة المنح | T1 | ✅ | متوسطة |
| **T3** | `scope` في `agent_metrics`/`agent_memory` repos (W5) | T1 | ✅ | متوسطة |
| **T4** | توحيد فحص المنصة عبر `resolvePlatformScope` (W6) | — | ✅ | منخفضة |
| **T5** | `supervisor-policy` في مشرف/مراقب (W7) | T3 | ⚠️ يحتاج `agent-monitor` | متوسطة |
| **T6** | تحصين عزل المستأجر في `executors.ts` (`risk-agent`) | T3 | ✅ | متوسطة |
| **T7** | حزمة انحدار Recovery/Fencing/`agent_runs` | T1..T6 | ✅ | منخفضة |

**قاعدة الترتيب:** كل مهمة تُغلق باختباراتها + typecheck قبل التالية. لا مهمة تعتمد على
`runner.ts` أو `copilot.ts` (خارج النطاق).

> **إضافات لاحقة خارج الجدول (T1.8):** عُولجت فجوتان أمنيتان ضمن مسار T1 نفسه:
> **G2 — دليل مصالحة موثوق:** المصالحة (`reconcileTaskCostFromLedger`) تعتمد الآن المفتاح
> **المملوك للخادم** `metadata.__agentTaskId`، الذي يُكتب حصراً من سياق تشغيل موثوق
> (`mergeAgentTaskMetadata`) ويُجرَّد من ميتاداتا العميل على مسار `/api/ai/run` بلا سياق
> (`stripReservedAgentMetadata`). لا يصلح `metadata.taskId` المقدَّم من العميل دليلاً.
> **G3 — نقل تكلفة `OVER_BUDGET`:** عند تجاوز سقف التشغيل بعد نداء مدفوع، يحمل
> `AgentRunBudgetExceededError` الحقل `actualCostUsd` (منفصل عن `spentUsd` التراكمي)،
> فتُحفظ تكلفة الاستدعاء الفعلية في `agent_tasks.cost` مرة واحدة دون مضاعفة السابقة.
> تفاصيلهما في `AI-INTEG-P3-T1.6_SAFE_RECOVERY.md` (G2) و`AI-INTEG-P3-T1.1_CORRECTIONS.md`
> و`AI-INTEG-P3-T1_IMPLEMENTATION.md` (G3).

---

## 5. مصفوفة الصلاحيات

### 5.1 الأدوار × النطاق

| الدور | `deriveScope` (ملكية) | `isPlatform` | بوّابة `requireAction` | ملاحظة |
| --- | --- | --- | --- | --- |
| CUSTOMER / MERCHANT / SUPPLIER / COMPANY / MARKETER | ✅ مالك صفوفه فقط | ❌ | حسب منح الوكيل | لا وصول عابر |
| SUPPORT / RISK / DISPUTE | ✅ مالك صفوفه فقط | ❌ | حسب منح الوكيل | **لا** منصة (خلافاً لـ`analytics:read:all`) |
| ADMIN / SUPER_ADMIN | ✅ | ✅ (تجميع فقط) | حسب منح الوكيل | لا يتجاوز `requireAction` |
| `system` (scheduler) | ❌ (`deriveScope` يرفضه) | ❌ | حسب منح الوكيل | فقط `deriveSystemScope` |

### 5.2 سلوك البوّابة (fail-closed)

| الحالة | النتيجة |
| --- | --- |
| غياب السياق | رفض `ACTION_NOT_AUTHORIZED` |
| غياب/فراغ قائمة المنح | رفض |
| المعرّف ليس في القائمة | رفض |
| `toolId` غير مسجَّل | رفض (بوّابة الأدوات) |
| أداة `platformScoped` + دور غير إداري | رفض |
| `ADMIN`/`SUPER_ADMIN` يحاول إجراءً غير ممنوح | **رفض** (لا توسيع ضمني) |

### 5.3 ثوابت عدم التوسيع

- لا يمنح الربط أي دور صلاحية إضافية: `resolvePlatformScope` **يعيد صياغة** الفحص القائم
  (`ADMIN || SUPER_ADMIN`) حرفياً — سلوك مطابق.
- `requireAction` **لا** يمنح؛ بل يقيّد (المجموعة من `capabilities` المعلنة).
- فشل موافقة الاستقلالية (separation of duties) في `decideAgentTask` يبقى كما هو.

---

## 6. الاختبارات المطلوبة لكل نقطة ربط

| # | نقطة الربط | الاختبار | النوع |
| --- | --- | --- | --- |
| W1/W2 | `agents.ts` | `ai_requests.metadata.taskId` = مهمة حقيقية؛ تزييف `metadata.taskId` في `input` **لا** ينتصر | تكامل (DB) |
| W1/W2 | `agents.ts` | عند غياب السياق (مسار `/api/ai/run`) تبقى الميتاداتا **مطابقة** لما قبل الربط | تكامل (DB) |
| W3 | `runtime.ts` | سقف التشغيل يُرفض **قبل** `provider.call` (لا نداء مدفوع) | تكامل (DB) |
| W3 | `runtime.ts` | التزامن: نداءان متوازيان لا يتجاوزان نفس الهامش (الحجز الذرّي) | تكامل (DB) |
| W3 | `runtime.ts` | إعادة المحاولة تُبذَر بالتكلفة السابقة ⇒ لا تصفير للسقف | وحدة + تكامل |
| W4 | `executors.ts` | إجراء غير ممنوح ⇒ رفض **قبل** أي قراءة/نداء مزوّد | تكامل (DB) |
| W4 | `executors.ts` | وكيل بلا `capabilities` ⇒ قائمة منح فارغة ⇒ كل إجراء مرفوض | وحدة |
| W5 | metrics/memory | مالك A لا يرى صفوف B؛ `deleteOwn` لا يحذف صفّ غيره | تكامل (DB) |
| W5 | metrics/memory | `isSystem` لا يُنتَج من مدخل الطلب؛ كائن مُصنَّع يُرفض | وحدة (موجود) |
| W6 | dispatcher/planner | سلوك ADMIN/SUPER_ADMIN مطابق قبل/بعد التوحيد | تكامل (DB) |
| W6 | dispatcher/planner | SUPPORT/RISK/DISPUTE **لا** يحصلون على منصة | وحدة |
| W7 | supervisor | مهمة `running` متجاوزة `stuckRuntimeSeconds` ⇒ `contain=true` | وحدة (موجود) |
| W7 | supervisor | وكيل متجاوز معدّل الفشل ⇒ `blocked` قبل التنفيذ | تكامل (DB) |
| T7 | Recovery/Fencing | `agent_runs` + `attemptCount` + `recoverStuckSteps` بلا تغيير سلوكي | تكامل (DB) |
| T7 | `agent_runs` | انتقالات الحالة (`run-state-machine`) بلا تغيير | وحدة |

**اختبارات P2 الموجودة (53)** تبقى صالحة وتُوسَّع، لا تُستبدل.

> **حالة التنفيذ (T1.8):** اختبارات W1/W2/W3 نُفِّذت فعلاً كاختبارات **وحدة** بلا DB
> (`agent-run-budget-runtime` + `agent-run-context-wiring`) على الكود الإنتاجي الحقيقي
> مع fake persistence — وليست اختبارات تكامل على PostgreSQL. بنود W4..W7 وT7 لم تُنفَّذ
> بعد. الحدود بين المُثبَت معزولاً و**BLOCKED** (يحتاج PostgreSQL) مفصّلة في
> `AI-INTEG-P3-T1.6_SAFE_RECOVERY.md` §6.

---

## 7. المخاطر وخطة التراجع

| # | الخطر | الشدة | التخفيف | التراجع |
| --- | --- | --- | --- | --- |
| R1 | حذف `metadata.agentKey` عند غياب السياق | 🟠 | صيغة `ctx ? merge : input.metadata` (§3.2) | إزالة سطر الدمج |
| R2 | تفعيل حرّاس الميزانية يرفض نداءات مشروعة | 🟠 | سقف افتراضي واسع + لا يُفعَّل إلا بسياق | إزالة `withAgentRunBudget` |
| R3 | `requireAction` يرفض إجراءً كان يعمل | 🟠 | اشتقاق المنح من `capabilities` المعلنة (لا تقييد أوسع) | حذف نداءات `requireAction` |
| R4 | `agent.ts` من الـ202 (تغيير غير محفوظ) | 🟠 | إجراء التعديل فوق الحالة الراهنة دون `reset`؛ إغلاق T1 أولاً | `git checkout -- agents.ts` (بموافقة) |
| R5 | إدخال repos جديدة (W5) بلا مستهلك ⇒ كود ميت | 🟡 | لا تُدخَل W5 إلا مع مستهلك فعلي (تقارير/metrics API) | حذف الملفات الجديدة |
| R6 | تعارض مع Rescue Runner لاحقاً | 🟡 | الحفاظ على العقود حرفياً (نفس التصديرات) | — |
| R7 | لا DB محلياً ⇒ لا يمكن تشغيل حزمة التكامل | 🟡 | وحدة بلا DB + إثبات typecheck؛ تكامل في CI | — |
| R8 | تغيير سلوك Recovery/Fencing | 🔴 | **لا نلمس** `dispatcher.ts` منطقياً؛ W6 توحيد فحص فقط | revert |

**خطة التراجع العامة:** كل مهمة (T1..T7) = commit مستقل قابل للعكس؛ لا تغييرات Schema؛
لا migration؛ لا لمس لـ`run-state-machine`/`dispatcher` منطقياً.

---

## 8. المهمة الأولى القابلة للإغلاق: **T1**

### 8.1 النطاق الدقيق

1. **`agents.ts` (W1/W2):** لفّ `executeAgentTask` في `createAgentTask` و`decideAgentTask` بـ:
   ```ts
   withAgentRunContext(ctx, () => withAgentRunBudget(runBudget, () =>
     executeAgentTask(db, agent, { ...input.input, __userId: requestedBy })))
   ```
   حيث `ctx`/`runBudget` مشتقّان من **صف المهمة + سجل الوكلاء (DB)** — لا من `input`.
2. **`runtime.ts` (W3):** إدخال حرّاس الميزانية (`reserve` قبل النداء، `release` في catch،
   `settle` بعده) + دمج الميتاداتا **بصيغة توافقية** (no-op عند غياب السياق).

### 8.2 معايير القبول (Definition of Done)

- [ ] `tsc --noEmit` = **0 أخطاء** (src + tests).
- [ ] اختبارات P2 الـ53 لا تتراجع.
- [ ] اختبار جديد: `ai_requests.metadata.taskId` = `agent_tasks.id` الحقيقي (تكامل).
- [ ] اختبار جديد: تزييف `input.metadata.taskId` لا ينتصر.
- [ ] اختبار جديد: عند غياب السياق، الميتاداتا **مطابقة** لسلوك Master.
- [ ] اختبار جديد: تجاوز السقف ⇒ رفض قبل `provider.call`.
- [ ] **لا تغيير** في `agent_runs`/Recovery/Fencing (حزمة T7 خضراء).
- [ ] لا توسيع صلاحيات (مصفوفة §5 دون تغيير).

### 8.3 لماذا T1 أولاً؟

- **أقل تغيير يحوّل الحرّاس من no-op إلى فعّالة** (نقطة تنفيذ واحدة).
- **بلا اعتماد** على `runner.ts`/`copilot.ts` (خارج النطاق).
- **قابلة للعكس بسهولة** (سطران في `agents.ts` + كتلة في `runtime.ts`).
- تفتح الباب لـT2 (بوّابة الإجراءات) التي تعتمد على وجود السياق.

---

## 9. ما لم يُشمَل (خارج P3)

`runner.ts` · `copilot.ts` · `orchestrator.ts` · `tool-gateway.ts` · `tool-registry.ts` ·
`tool-handlers.ts` · `catalogue.ts` · `supervisor.ts` · `agent-monitor.ts` · `gm-actions.ts` ·
`cycle.ts` · `memory-*` · `metrics-repo.ts` · `outbox-*` · أي migration أو Schema.

---

## 10. الخطوة التالية

بانتظار الاعتماد. عند الموافقة، يُنفَّذ **T1 فقط** كأول مهمة قابلة للإغلاق، ثم يُتوقّف
لتقرير قبل T2.
