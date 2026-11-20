# AI-INTEG-P3-T1 — Trusted Execution Context & Run Budget (تنفيذ)

> **الحالة النهائية:** ✅ **CLOSED_WITH_LIMITATIONS** (منطق التطبيق COMPLETE — التكامل مع
> PostgreSQL **BLOCKED**، لا PostgreSQL في البيئة).
> **المرجع:** `docs/AI-INTEG-P3_SECURITY_INTEGRATION_DESIGN.md` · **الفرع:** `master` · **HEAD قبل:** `98c3a95`.
>
> **ملاحظة حالة (T1.8):** حُدِّثت الحالة من «COMPLETE» إلى «CLOSED_WITH_LIMITATIONS» لأن
> المنظومة الأمنية **لم تكتمل بعد**: T2 (بوّابة `requireAction`) لم تُنفَّذ، وربط
> `scope.ts`/`supervisor-policy.ts` غير مُثبَت، وإثبات PostgreSQL الفعلي ما زال BLOCKED.
> جرى بعد T1: T1.1 (حفظ التكلفة)، T1.3 (حجز ذرّي)، T1.6 (fencing + مصالحة)، ثم **G2**
> (دليل مصالحة موثوق) و**G3** (نقل تكلفة `OVER_BUDGET`) — موثّقان في §9.

## 1. النطاق المُنفَّذ

| # | الملف | التغيير |
| --- | --- | --- |
| A | `packages/server/src/modules/ai/agents.ts` | ربط `withAgentRunContext` + `withAgentRunBudget` في `createAgentTask` و`decideAgentTask`؛ بناء السياق من بيانات موثوقة (صف المهمة + سجل الوكيل + DB للأدوار). |
| B | `packages/server/src/lib/ai/runtime.ts` | حجز/تحرير/تسوية `AgentRunBudget` حول نداء المزوّد؛ رفض قبل `provider.call`؛ دمج الميتاداتا الموثوقة بصيغة توافقية. |
| C | `packages/server/tests/unit/agent-run-budget-runtime.test.ts` | اختبارات runtime (8) بلا DB. |
| D | `packages/server/tests/unit/agent-run-context-wiring.test.ts` | اختبارات ربط agents.ts (3) بلا DB. |
| E | `packages/server/vitest.t1.config.ts` | إعداد تشغيل معزول بلا DB. |

## 2. بناء السياق الموثوق (agents.ts)

`buildRunContext(db, task, requesterRoles)` يشتق **كل** الحقول من الخادم:

| الحقل | المصدر |
| --- | --- |
| `taskId` | صف المهمة المحفوظ (`id` / `taskId`) — **ليس** من `input` |
| `agentKey` | تعريف الوكيل الموثوق |
| `requestedBy` | صاحب الطلب المحفوظ (`task.requestedBy`) |
| `requesterRoles` | `rolesOfUser(db, requestedBy)` — من `user_roles ⨝ roles` |
| `authorizedActions` | `AGENT_CATALOGUE[key].capabilities[].action` |
| `allowedTools` | `agent_registry.allowed_tools` |
| `runCapUsd` | `agent_registry.limits.maxCostUsdPerRun` (fallback آمن: `5 USD`) |

**سياسة fallback:** قيمة صالحة > 0 تُستخدم كما هي؛ غيابها أو عدم صلاحيتها ⇒ `DEFAULT_AGENT_RUN_CAP_USD = 5` (سقف محدود، لا يُعطَّل أبداً). مطابق لدلالة Rescue.

**بذر إعادة المحاولة:** `new AgentRunBudget(cap, parseStoredCostUsd(task.cost))` — إعادة التشغيل لا تصفّر السقف. (في مسار `createAgentTask` التكلفة `null` لأن المهمة جديدة؛ في `decideAgentTask` تُبذَر بـ`task.cost`.)

## 3. دورة حياة الميزانية (runtime.ts)

```
assertWithinBudget (شهري — دون تغيير)
  └─ runBudget?.reserve(estimated.cost)   ← رفض قبل provider.call عند التجاوز
       ├─ فشل المزوّد ⇒ runBudget?.release(estimated.cost) ثم throw
       └─ نجاح ⇒ runBudget.settle(estimated, actual) مرة واحدة
                   ├─ always: recordAiRequest بالتكلفة الفعلية (OVER_BUDGET إن تجاوز)
                   ├─ always: upsertAiUsage بالتكلفة الفعلية
                   └─ overBudget ⇒ throw AFTER ledger
```

- **لا تسوية مزدوجة:** `settle` يستبدل الحجز (`spent -= reserved; spent += actual`)، ويُستدعى مرة واحدة.
- **لا تحرير مزدوج:** `release` يُستدعى فقط في مسار الفشل؛ لا حجز معلّق (لا `finally` مزدوج).
- **السقف الشهري:** `assertWithinBudget` + `upsertAiUsage` لم يُستبدلا.

## 4. الميتاداتا التوافقية (شرط صريح)

> **تحديث (G2/T1.8):** الصيغة أدناه هي **ما نُفِّذ في T1**. عُدِّلت لاحقاً في G2: فرع «غياب
> السياق» صار `stripReservedAgentMetadata(input.metadata)` (يحذف فقط المفتاح المحجوز
> `__agentTaskId` ويُبقي البقية) بدل `(input.metadata ?? {})`. انظر §9.

```ts
const runCtx = getAgentRunContext();
const requestMetadata = runCtx ? mergeAgentTaskMetadata(input.metadata, runCtx) : (input.metadata ?? {});
```

- **بوجود سياق:** `taskId`/`agentKey` من السياق الموثوق (تزييف العميل لا ينتصر).
- **بغياب السياق:** الميتاداتا **حرفياً** كما هي ⇒ لا حذف لـ`metadata.agentKey` في مسارات Master (مثل `/api/ai/run`، `/status`).

## 5. الاختبارات

| المعيار | الاختبار | النتيجة |
| --- | --- | --- |
| taskId/agentKey من السياق الموثوق | `agent-run-context-wiring` + `agent-run-budget-runtime` | ✅ |
| تزوير taskId/agentKey لا ينتصر | `agent-run-budget-runtime` | ✅ |
| عزل السياق بين تنفيذين متزامنين | `agent-run-context.test.ts` (P2، سطر 45) | ✅ |
| غياب السياق يحافظ على السلوك القديم حرفياً | `agent-run-budget-runtime` | ✅ |
| تجاوز السقف يمنع provider.call | `agent-run-budget-runtime` | ✅ |
| فشل provider ⇒ release صحيح | `agent-run-budget-runtime` | ✅ |
| نجاح provider ⇒ settle مرة واحدة | `agent-run-budget-runtime` | ✅ |
| إعادة المحاولة لا تصفّر التكلفة | `agent-run-budget-runtime` + P2 | ✅ |
| عدم تجاوز الميزانية عند التزامن | `agent-run-budget-runtime` (concurrency) | ✅ |
| اختبارات P2 الـ53 تبقى ناجحة | 53/53 | ✅ |

**النتيجة (لحظة T1):** 64/64 (53 P2 + 11 T1) · `tsc --noEmit` = **0 أخطاء**.

> **تحديث (T1.8):** الرقم أعلاه تاريخي (لحظة إغلاق T1). بعد T1.1/T1.3/T1.6/G2/G3 صار
> العدد الحالي **112/112** على 5 ملفات (آخر تشغيل لـ`vitest.t1.config.ts`). لا تُقرأ أرقام
> T1 كحالة راهنة.

## 6. الفجوة (CLOSED_WITH_LIMITATIONS)

- **تكامل DB حقيقي:** غير مُنفَّذ — لا PostgreSQL ولا Docker في البيئة (منفذ 5432 مغلق). الاختبارات تستخدم fake DB حقيقي-المسارات (`runtime.ts`/`agents.ts` الحقيقيان، fake persistence فقط).
- **الأثر:** منخفض — المنطق المُختبَر هو الإنتاجي؛ المزوّد والمخزن مُحاكيان.
- **غير مُثبَت بـDB:** سلوك SQL الفعلي (`usageSum`, `upsertAiUsage`, `recordAiRequest`)، ذرّية القفل (`SELECT … FOR UPDATE`)، والتزامن بين اتصالين — كلها **BLOCKED** حتى تتوفر PostgreSQL.

## 7. البوابة قبل/بعد

| البند | قبل | بعد |
| --- | --- | --- |
| HEAD | `98c3a95` | `98c3a95` (لم يتغيّر) |
| staged | 0 | 0 |
| modified | 99 | **100** (+`runtime.ts`، و`agents.ts` ضمن الـ99) |
| untracked | 111 | **114** (+2 اختبار +1 إعداد +1 وثيقة) |
| M0 | `e731e684…fa8694` | مطابق |
| لا commit/push | — | ✅ |
| الملفات الـ210 | محفوظة | ✅ (لا reset/checkout/stash) |

## 8. التالي

T2 (بوّابة `requireAction`) — **لم تبدأ** بانتظار الاعتماد.

---

## 9. إضافات لاحقة على مسار T1 (G2 / G3) — أُدرجت في T1.8

### 9.1 G2 — دليل المصالحة الموثوق (Trusted Reconciliation Evidence)

**المشكلة:** كان `ai_requests.metadata` يُكتب حرفياً من العميل على مسار `/api/ai/run`
(بلا سياق تشغيل)، وكانت المصالحة تختار دليلها بـ`metadata->>'taskId'` — أي يمكن لمستخدم
يملك `AI_USE` أن يزرع `taskId` مهمة غيره كدليل مصالحة.

**الإصلاح:** مفتاح **مملوك للخادم** `AGENT_TASK_LEDGER_KEY = '__agentTaskId'`:

- يُكتب **حصراً** من سياق تشغيل موثوق: `mergeAgentTaskMetadata` يضعه من
  `ctx.ledgerTaskId ?? ctx.taskId`، و`buildRunContext` يضبط `ledgerTaskId` من صف المهمة.
- يُجرَّد **دائماً** من ميتاداتا العميل: على مسار السياق (`mergeAgentTaskMetadata`) وعلى
  مسار `/api/ai/run` بلا سياق (`stripReservedAgentMetadata` في `runtime.ts`).
- المصالحة (`reconcileTaskCostFromLedger`) تُصفّي على
  `sql`${aiRequests.metadata}->>'__agentTaskId' = ${taskId}`` بدل `taskId` العادي.

**الأثر:** لا يمكن لأي مدخل من العميل أن يصبح دليل مصالحة. تفاصيل دورة الاستغلال والتحقق
في `AI-INTEG-P3-T1.6_SAFE_RECOVERY.md` §4 (المُحدَّث).

### 9.2 G3 — نقل تكلفة `OVER_BUDGET` (Over-Budget Cost Propagation)

**المشكلة:** عند تجاوز سقف التشغيل **بعد** نداء مدفوع، كان `runAIFeature` يسجّل التكلفة في
`ai_requests` (status `OVER_BUDGET`) ثم يطلق `AgentRunBudgetExceededError`؛ لكن مساري
الإنهاء في `agents.ts` كانا يطابقان `AgentCostRecordingError` فقط ⇒ **تُفقد** تكلفة المهمة.

**الإصلاح:** `AgentRunBudgetExceededError` يحمل الآن `actualCostUsd?` (اختياري):

- `runtime.ts` يمرّره فقط في **الرفض بعد المزوّد** (`actualCost.toFixed(10)`)؛ الرفض القبلي
  بلا استدعاء ⇒ بلا قيمة (لا تكلفة مخترعة).
- دالة موحّدة `measuredCostFromError(err)` في `agents.ts` تستخرج تكلفة الاستدعاء الفعلية من
  `AgentCostRecordingError` **أو** `AgentRunBudgetExceededError`، وتُعيد القيمة الأصلية
  حرفياً (مع رفض المشوّه/غير الموجب) — فلا يتغيّر سلوك `AgentCostRecordingError`.
- `actualCostUsd` **منفصل عن** `spentUsd` (التراكمي = السابق + الاستدعاء)، فتُحفظ تكلفة
  الاستدعاء مرة واحدة دون مضاعفة التكلفة السابقة (عبر `writeTaskTerminal` التراكمي في مسار
  الاعتماد، والكتابة المباشرة في المسار المباشر).

**الأثر:** التكلفة الفعلية تُحفظ في `agent_tasks.cost` في المسارين، وحالة المهمة تبقى
`failed` (لا نجاح زائف). تفاصيل أدق في `AI-INTEG-P3-T1.1_CORRECTIONS.md`.

### 9.3 حالة T1 النهائية

> **CLOSED_WITH_LIMITATIONS:** منطق التطبيق لمسار T1 (سياق موثوق + ميزانية + حفظ تكلفة +
> fencing + مصالحة + G2 + G3) **مُكتمَل ومُختبَر معزولاً**. القيود المتبقية: (١) إثبات
> PostgreSQL الفعلي BLOCKED؛ (٢) T2 (بوّابة `requireAction`) لم تُنفَّذ؛ (٣) ربط
> `scope.ts`/`supervisor-policy.ts` غير مُثبَت؛ (٤) `reconcileTaskCostFromLedger` بلا مستدعٍ
> إنتاجي (انظر §9.4).

### 9.4 G1 — حالة المصالحة (لا مستدعٍ إنتاجي)

> **تنويه صريح:** `reconcileTaskCostFromLedger` (المصالحة القائمة على الأدلة) **مُصدَّرة لكن
> بلا أي مستدعٍ إنتاجي** حتى الآن — لا scheduler، لا sweep دوري، لا مسار HTTP. هي **جاهزة
> للاستخدام** (ومُختبَرة معزولاً)، لكن **الاسترداد التلقائي للتكلفة لا يعمل تلقائياً** في
> الإنتاج اليوم؛ يتطلب إضافة مستدعٍ (مثلاً مهمة صيانة/استرداد) في مرحلة لاحقة.
>
> **الأثر الأمني:** بما أن المصالحة غير مُستدعاة، فإن ناقل G2 (تلويث دليل مصالحة مهمة أخرى)
> **غير قابل للوصول إنتاجياً** حالياً؛ أُغلق الإصلاح استباقاً حتى لا يتحوّل إلى ثغرة فعلية
> لحظة ربط المصالحة بمشغّل.
