# AI-INTEG-P3-T1.6 — Terminal Fencing & Evidence-Based Cost Recovery

> **الحالة:** ✅ COMPLETE (بلا DB) — مع **قيود PostgreSQL موثّقة**.
> **الفرع:** `master` · **HEAD:** `98c3a958…b4aa` (لم يتغيّر) · **M0:** `e731e684…fa8694`.
>
> **ملاحظة حالة (T1.8):** هذا التقرير يوثّق لحظة T1.6. منذ ذلك الحين: (١) **G2** استبدل مفتاح
> دليل المصالحة بـ`metadata.__agentTaskId` المملوك للخادم بدل `metadata.taskId`؛ (٢) **G3**
> أضاف نقل تكلفة `OVER_BUDGET`. تفاصيلهما في §9 أدناه، مع تحديث الجداول المتأثرة داخل النص.

## 1. الهدف والنطاق

إغلاق فجوتَي T1.4/T1.5 بأقل تغيير ممكن، دون إعادة تصميم منظومة الوكلاء:
1. **Terminal fencing** على كتابة `agent_tasks` النهائية: لا يطمس كاتب قديم مهمة لم تعد `running`.
2. **مصالحة تكلفة قائمة على الأدلة**: استعادة التكلفة الفعلية من `ai_requests` فقط عند وجود دليل واحد قاطع، دون إعادة تنفيذ المزوّد.

**خارج النطاق (مقصود):** لا scheduler/sweep دوري، لا أعمدة، لا migrations، لا تغيير في `agentRunSteps`.

## 2. الملفات المعدّلة

| الملف | النوع | السبب |
| --- | --- | --- |
| `packages/server/src/modules/ai/agents.ts` | M | (أ) fencing في `writeTaskTerminal` وإرجاع نتيجة واضحة؛ (ب) احترام نتيجة الـfence في مستدعي `decideAgentTask` (نجاح/فشل)؛ (ج) `reconcileTaskCostFromLedger`؛ (د) استيراد `aiRequests` و`logger` |
| `packages/server/tests/unit/agent-run-context-wiring.test.ts` | M | fake DB يدعم `aiRequests` وتصفية `metadata->>'__agentTaskId'` (المفتاح الموثوق، بعد G2) و`_hooks.onTaskSelect`؛ 10 اختبارات T1.6 (+ اختبارات G2/G3 اللاحقة) |
| `docs/AI-INTEG-P3-T1.6_SAFE_RECOVERY.md` | جديد | هذا التقرير |

**لم يُلمَس:** `executors.ts` · `runtime.ts` · `cost-control.ts` · `scope.ts` · `supervisor-policy.ts` · `agentRunSteps` · Schema · migrations · seeds.
**استيراد `aiRequests` للقراءة فقط** (لا كتابة في `ai_requests` — `recordAiRequest` يبقى insert-only).

## 3. آلية الحماية (Terminal Fencing)

```ts
export interface TaskTerminalWrite { applied: boolean; reason: 'applied' | 'not_running' | 'missing'; }

async function writeTaskTerminal(db, taskId, patch, addCostUsd): Promise<TaskTerminalWrite> {
  return db.transaction(async (tx) => {
    const locked = await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1).for('update');
    const row = locked[0];
    if (!row) return { applied: false, reason: 'missing' };
    if (row.status !== 'running') return { applied: false, reason: 'not_running' };   // ← الحماية
    const base = row.cost ?? '0';
    await tx.update(agentTasks)
      .set({ ...patch, ...(addCostUsd !== null ? { cost: addDecimalStrings(base, addCostUsd) } : {}) })
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'running')));        // ← شرط إضافي
    return { applied: true, reason: 'applied' };
  });
}
```

- القفل (`FOR UPDATE`) + **إعادة فحص الحالة** داخل المعاملة ⇒ كاتب واحد فقط يراقب `running` ويسوّيها.
- كاتب متأخر/مكرّر يرى حالة terminal ⇒ `applied: false` **دون** كتابة النتيجة أو التكلفة ⇒ لا طمس ولا ازدواج تكلفة.
- **لا قفل يُحتجَز أثناء الشبكة**: تُنادى بعد المزوّد فقط.
- مستدعو `decideAgentTask` (نجاح/فشل) يفحصون `applied` ويتوقفون (مع `logger.warn`) إذا رُفضت الكتابة.

**نظير الخطوة:** يطابق `fencedStepWrite` (dispatcher) لكن بفَنسِ دورة حياة المهمة نفسها (`status`).

## 4. آلية المصالحة (Evidence-Based Cost Recovery)

`reconcileTaskCostFromLedger(db, taskId, audit)` — **لا تُعيد تنفيذ المزوّد أبداً**.

> **تحديث G2 (T1.8):** مفتاح الدليل صار `metadata->>'__agentTaskId'` (**مملوك للخادم**، يُكتب
> من سياق تشغيل موثوق فقط) بدل `metadata.taskId` القابل للتزييف من العميل. التفاصيل في §9.1.

تُنفَّذ **فقط** عند تحقق كل الشروط:
1. المهمة `running`.
2. **سجل واحد فقط** في `ai_requests` يحمل `metadata->>'__agentTaskId' = taskId`.
3. حالته `SUCCESS` أو `OVER_BUDGET` (نجاح قابل للفوترة).
4. `cost` يُقرأ كعدد عشري منتهٍ غير سالب.

> **تحديث G1 (T1.8):** هذه الدالة **مُصدَّرة لكن بلا مستدعٍ إنتاجي** حتى الآن (لا scheduler،
> لا sweep، لا مسار HTTP). الاسترداد **لا يعمل تلقائياً** في الإنتاج؛ يتطلب إضافة مستدعٍ
> لاحقاً. التفاصيل في §9.3.

عندها: تُستعاد **التكلفة الفعلية من السجل** (لا تقدير)، وتُغلق المهمة **`failed`** (لا ندّعي نجاحاً؛ النتيجة لم تُحفظ) برسالة:
> `Provider completed, but task result was not durably saved; cost recovered from ai_requests.`

الكتابة النهائية عبر `writeTaskTerminal` المُقَيَّد ⇒ **idempotent** (نداء ثانٍ يجد المهمة غير `running`).

**الامتناع (بلا تغيير + سبب):** `not_running` · `no_ledger_row` · `ambiguous_ledger_rows` (أكثر من سجل ⇒ لا جمع تخميني) · `ledger_row_not_billable` · `ledger_cost_unreadable` · `fenced_out`.

**الحدود المحترمة:** لا إغلاق بمهلة/`startedAt`، لا إعادة تنفيذ، لا اعتبار غياب السجل = تكلفة صفر.

## 5. الاختبارات (10 جديدة · الإجمالي 94/94)

| المطلوب | الاختبار | النتيجة |
| --- | --- | --- |
| 1. كاتب قديم لا يغيّر مهمة terminal | `recovery is fenced out when the task becomes terminal between read and write` (عبر `_hooks.onTaskSelect`) + `a terminal task is never reopened or re-costed` | ✅ |
| 2. كاتب واحد فقط يغلق `running` | `is idempotent: a repeat recovery does NOT double the cost` | ✅ |
| 3. مصالحة سجل نجاح واحد تستعيد التكلفة مرة واحدة | `recovers the EXACT cost from a single clear ledger row and closes as failed` | ✅ |
| 4. تكرار المصالحة لا يضاعف التكلفة | `is idempotent…` (cost ثابت) | ✅ |
| 5. تعدد السجلات ⇒ الامتناع | `refuses to reconcile when several ledger rows make the attempt ambiguous` | ✅ |
| 6. غياب السجل لا يصفّر التكلفة/يغلق | `does NOT close or zero the cost when there is no provider evidence` | ✅ |
| 7. لا استدعاء للمزوّد أثناء المصالحة | `never calls the provider during recovery` (`captured` = 0) | ✅ |
| 8. حفظ سلوك المسارات غير المرتبطة بـagentRunSteps | `a directly-created task still succeeds and records its cost` | ✅ |
| (إضافي) لا تسرّب بين المهام | `only recovers the row whose trusted ledger id matches` (كان: `metadata.taskId` — حُدِّث في G2) | ✅ |
| (إضافي) سجل غير قابل للفوترة | `ignores a non-billable (failed) ledger row` | ✅ |

**النتيجة (لحظة T1.6):** `vitest run --config vitest.t1.config.ts` = **94/94** (5 ملفات) · `tsc --noEmit` = **0 أخطاء** (يشمل `tests/**` بما فيها اختبارات DB).

> **تحديث (T1.8):** الرقم تاريخي. العدد الحالي بعد G2/G3 هو **112/112** على 5 ملفات.

**فحص عدم-العبثية (mutation check):** تعطيل شرط `row.status !== 'running'` يُسقِط اختبار الـfence، ثم أُعيد الملف لحالته ⇒ الاختبار حقيقي لا صوري.

## 6. حدود fake DB وما يتطلب PostgreSQL

| البند | الحالة |
| --- | --- |
| منطق التطبيق (فائز واحد، لا طمس، لا ازدواج تكلفة، الامتناع عند الغموض) | ✅ مُثبت معزولاً |
| ذرّية القفل بين اتصالين حقيقيين | 🔴 **BLOCKED** (يتطلب PostgreSQL) |
| سلوك `SELECT … FOR UPDATE` الفعلي | 🔴 BLOCKED |
| READ COMMITTED + إعادة القراءة بعد القفل | 🔴 BLOCKED |
| اختبارات التكامل `tests/*.test.ts` (تحتاج `globalSetup` + DB) | 🔴 BLOCKED (خارج النطاق: لا PostgreSQL) |

**تصريح صريح:** اختبارات fake DB تُثبت **منطق التطبيق فقط**، ولا تُثبت سلوك PostgreSQL الفعلي. اختبارات التكامل التي تستدعي `decideAgentTask` **لم تُشغَّل** (تتطلب قاعدة بيانات ممنوعة في هذه المهمة).

## 7. البوابة قبل/بعد

| البند | قبل | بعد |
| --- | --- | --- |
| المسار / الفرع | `/workspace/project` / `master` | نفسها |
| HEAD | `98c3a958…b4aa` | `98c3a958…b4aa` (لم يتغيّر) |
| staged | 0 | 0 |
| modified | 101 | 101 (`agents.ts` + الاختبار مُعدّلان أصلاً) |
| untracked | 117 | 118 (+هذه الوثيقة) |
| deleted | 0 | 0 |
| M0 | `e731e684…fa8694` | مطابق |
| لا stage/commit/push/reset/clean/checkout/stash | — | ✅ |

## 8. القرار
**COMPLETE** (بلا DB). نُفِّذ الـfencing والمصالحة القائمة على الأدلة بأقل تغيير، مع الحفاظ على كل التعديلات المتراكمة وعدم المساس بـ`agentRunSteps` أو Schema. السلوك الذرّي الفعلي واختبارات التكامل **BLOCKED** لغياب PostgreSQL.

---

## 9. إضافات لاحقة (G2 / G3 / G1) — أُدرجت في T1.8

### 9.1 G2 — دليل المصالحة الموثوق

**المشكلة (ناقل الاستغلال):** كان `ai_requests.metadata` يُكتب حرفياً من العميل على مسار
`/api/ai/run` (بلا سياق تشغيل)، وكانت المصالحة تختار دليلها بـ`metadata->>'taskId'` ⇒ مستخدم
يملك `AI_USE` يستطيع زرع `taskId` مهمة غيره كدليل مصالحة (تكلفة خاطئة أو إرباك المصالحة).

**الإصلاح:** مفتاح مملوك للخادم `AGENT_TASK_LEDGER_KEY = '__agentTaskId'`:

| الموضع | السلوك |
| --- | --- |
| `agent-run-context.ts` | `mergeAgentTaskMetadata` يجرّد المفتاح **دائماً** من نسخة العميل، ويكتبه من `ctx.ledgerTaskId ?? ctx.taskId` عند وجود سياق |
| `agents.ts` | `buildRunContext` يضبط `ledgerTaskId` من صف المهمة (لا من `input`) |
| `runtime.ts` | `stripReservedAgentMetadata` يجرّد المفتاح على مسار `/api/ai/run` بلا سياق (يبقي بقية المفاتيح) |
| `agents.ts` | المصالحة تُصفّي على `sql`${aiRequests.metadata}->>'__agentTaskId' = ${taskId}`` |

**الاختبارات:** `agent-run-budget-runtime` (الكتابة من السياق / تجريد التزييف بلا سياق) +
`agent-run-context-wiring` (الامتناع عند دليل مزيف / الاعتماد على المفتاح الموثوق).

### 9.2 G3 — نقل تكلفة `OVER_BUDGET`

**المشكلة:** عند تجاوز السقف **بعد** نداء مدفوع، كان `runAIFeature` يسجّل التكلفة في
`ai_requests` (status `OVER_BUDGET`) ثم يطلق `AgentRunBudgetExceededError`؛ لكن مساري
الإنهاء كانا يطابقان `AgentCostRecordingError` فقط ⇒ **تُفقد** تكلفة المهمة.

**الإصلاح:**
- `AgentRunBudgetExceededError` يكتسب `actualCostUsd?` (اختياري): يُمرَّر فقط في الرفض **بعد**
  المزوّد (`runtime.ts`، `actualCost.toFixed(10)`)، ولا يُمرَّر في الرفض القبلي.
- `agents.ts`: دالة موحّدة `measuredCostFromError(err)` تستخرج تكلفة الاستدعاء من
  `AgentCostRecordingError` أو `AgentRunBudgetExceededError`، وتُعيدها حرفياً (ترفض المشوّه/
  غير الموجب)، فلا يتغيّر سلوك `AgentCostRecordingError`.
- `actualCostUsd` **منفصل عن** `spentUsd` (التراكمي)، فلا تُضاعف التكلفة السابقة.

**الاختبارات:** `agent-run-budget-runtime` (حمل التكلفة على الخطأ / تمييزها عن `spentUsd` /
غيابها قبلياً) + `agent-run-context-wiring` (حفظها في `agent_tasks.cost` في المسارين، لا ازدواج،
الحالة تبقى `failed`).

### 9.3 G1 — حالة المصالحة (لا مستدعٍ إنتاجي)

> **تنويه صريح:** `reconcileTaskCostFromLedger` **مُصدَّرة لكن بلا أي مستدعٍ إنتاجي** — لا
> scheduler، لا sweep دوري، لا مسار HTTP. **الاسترداد التلقائي للتكلفة لا يعمل في الإنتاج
> اليوم**؛ الدالة جاهزة ومُختبَرة معزولاً، وتحتاج مستدعياً لاحقاً (مهمة صيانة/استرداد).
>
> **الأثر الأمني:** لأن المصالحة غير مُستدعاة، فناقل G2 غير قابل للوصول إنتاجياً حالياً؛ أُغلق
> استباقاً قبل ربط المصالحة بمشغّل.
