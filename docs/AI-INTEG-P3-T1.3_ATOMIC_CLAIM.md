# AI-INTEG-P3-T1.3 — الحجز الذرّي للمهمة وحفظ التكلفة (Atomic Task Claim)

> **الحالة:** ✅ COMPLETE (بلا DB) — مع **قيود PostgreSQL موثّقة**.
> **المرجع:** T1.2 (فقدان التحديث) · **الفرع:** `master` · **HEAD:** `98c3a95` (لم يتغيّر).
>
> **ملاحظة حالة (T1.8):** هذا التقرير يوثّق لحظة T1.3. عُزّز لاحقاً في **T1.6** بإضافة
> terminal fencing إلى `writeTaskTerminal`، وعُدِّل مصدر تكلفة الفشل في **G3** ليصير
> `measuredCostFromError(err)` (يشمل `AgentRunBudgetExceededError`). انظر §2.ج أدناه.

## 1. التغييرات الدقيقة

| الملف | النوع | التغيير |
| --- | --- | --- |
| `packages/server/src/modules/ai/agents.ts` | M | `decideAgentTask`: حجز ذرّي + `writeTaskTerminal` (قفل صف قصير) + رفض شرطي |
| `packages/server/tests/unit/agent-run-context-wiring.test.ts` | M | fake-DB شرطي (تقييم شروط Drizzle) + `transaction`/`for('update')` + 5 اختبارات T1.3 |

**لم يُلمَس:** `runtime.ts`, `executors.ts`, `scope.ts`, `supervisor-policy.ts`, Schema, migrations, seeds.
**لا أعمدة جديدة، لا migrations، لا تغييرات DB فعلية.**

## 2. التصميم المنفَّذ

### أ) الحجز الذرّي (منع التنفيذ المزدوج)
```ts
const claimed = await db
  .update(agentTasks)
  .set({ status: 'running', approvedBy, approvedAt, startedAt })
  .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'awaiting_approval')))
  .returning({ id: agentTasks.id });
if (claimed.length === 0) throw ApiError.conflict('Task is not awaiting approval');
```
- انتقال `awaiting_approval → running` في **UPDATE شرطي واحد** ⇒ فائز واحد فقط.
- جملة وحيدة (معاملتها الضمنية تنتهي فوراً) ⇒ **لا قفل يُحتجَز بعدها**.
- الخاسر: `returning` فارغ ⇒ `CONFLICT` **قبل** أي `executeAgentTask`.
- **مسارات الفشل بعد الحجز:** كل مسارات الخطأ اللاحقة تُعيد الحالة إلى `failed` (كتابة طرفية)، فلا تبقى المهمة عالقة في `running`.

### ب) حفظ التكلفة (منع الفقدان)
```ts
async function writeTaskTerminal(db, taskId, patch, addCostUsd) {
  await db.transaction(async (tx) => {
    const locked = await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1).for('update');
    const base = locked[0]?.cost ?? '0';
    await tx.update(agentTasks).set({ ...patch, ...(addCostUsd !== null ? { cost: addDecimalStrings(base, addCostUsd) } : {}) }).where(eq(agentTasks.id, taskId));
  });
}
```
- **معاملة قصيرة** تقفل الصف ثم تُعيد قراءة `cost` الحالية وتجمع بـ`addDecimalStrings` ⇒ لا lost update.
- تُنادى **بعد** انتهاء نداء المزوّد فقط ⇒ **لا قفل مفتوح أثناء الشبكة**.
- `addCostUsd === null` (مجهول) ⇒ لا يُكتب عمود `cost` (لا صفر مضلّل).

> **تحديث T1.6 (T1.8):** النسخة أعلاه هي نسخة T1.3 (بلا fencing). استبدلتها T1.6 بنسخة
> تُرجع `TaskTerminalWrite` وتعيد فحص `row.status !== 'running'` داخل المعاملة (لا يطمس كاتب
> متأخر مهمة terminal). راجع `AI-INTEG-P3-T1.6_SAFE_RECOVERY.md` §3.

### ج) مسارات النجاح والفشل
- **نجاح:** `advice.cost ?? null` (مجهول يترك القيمة كما هي).
- **فشل:** التكلفة المقيسة بعد المزوّد تُحفظ؛ غيرها لا يمسّ القيمة.
- **رفض (REJECT):** صار شرطياً كذلك ⇒ الخاسر في السباق لا يُبلّغ نجاحاً مضلّلاً ولا يطمس نتيجة الفائز.

> **تحديث G3 (T1.8):** في T1.3 كان المصدر في مسار الفشل
> `err instanceof AgentCostRecordingError ? err.costUsd : null`. عُدِّل في G3 إلى
> `measuredCostFromError(err)` الذي يشمل أيضاً `AgentRunBudgetExceededError` (يحمل
> `actualCostUsd` = تكلفة الاستدعاء، منفصلاً عن `spentUsd` التراكمي). فلا تُفقد تكلفة
> `OVER_BUDGET` ولا تُضاعف السابقة. `writeTaskTerminal` نفسه لم يتغيّر منطقياً في G3.

## 3. ما تم اختباره فعلياً (اختبارات معزولة، بلا DB)

| المعيار المطلوب | الاختبار | النتيجة |
| --- | --- | --- |
| طلبان متزامنان: فائز واحد | `lets only ONE of two concurrent approvals win the claim` | ✅ |
| نداء مزوّد واحد فقط | نفس الاختبار (`captured` = 1) | ✅ |
| المرفوض لا يستدعي المزوّد | `refuses a second approval after the task already completed` | ✅ |
| لا قفل مفتوح أثناء المزوّد | `does not hold a row lock across the provider call` | ✅ |
| تراكم التكلفة لا يفقد القيمة السابقة | `accumulates a post-approval cost onto a prior stored cost` | ✅ |
| القراءة من الصف الحالي لا اللقطة | `does not lose a cost written by another writer during the provider call` | ✅ |
| الحفظ في مساري النجاح والفشل | F1 (`persists … on success` / `on the FAILURE path`) | ✅ |
| فشل التسجيل ⇒ لا نجاح مضلّل | F2 (`RUN_COST_NOT_RECORDED`) | ✅ |
| رفض خاسر السباق لا يطمس النتيجة | `refuses a REJECT that loses the race to an APPROVE` | ✅ |
| الحفاظ على P2 + T1 + T1.1 | 53 P2 + 31 T1/T1.1/T1.3 | ✅ |

**النتيجة (لحظة T1.3):** **84/84** (5 ملفات) · `tsc --noEmit` = **0 أخطاء**.

> **تحديث (T1.8):** الرقم تاريخي. العدد الحالي بعد T1.6/G2/G3 هو **112/112** على 5 ملفات.

**آلية الاختبار:** fake-DB يحاكي محرّك SQL: يقيّم شروط Drizzle (`eq`/`and`) فيُظهر أن الـUPDATE الشرطي يطابق صفاً واحداً فقط؛ ويوفر `transaction` و`for('update')`. المحاكاة **تثبت منطق التطبيق** (فائز واحد، نداء واحد، قراءة الصف الحالي)، لا سلوك PostgreSQL الفعلي.

## 4. ما بقي BLOCKED (يتطلب PostgreSQL — غير مثبت)

| البند | السبب |
| --- | --- |
| سلوك `SELECT … FOR UPDATE` الحقيقي | أقفال الصفوف دلالة محرّك؛ fake-DB يحاكيها ولا يثبتها |
| تزامن معاملتين حقيقيتين على نفس الصف | يتطلب اتصالين حقيقيين |
| سلوك READ COMMITTED / إعادة قراءة الصف بعد القفل | يتطلب محرّكاً فعلياً |
| تسلسل `update … set cost` مع الصيغة النصية الناتجة | يتطلب PG |
| عدم وجود deadlock بين المعاملة القصيرة والـUPDATE الشرطي | يتطلب PG |

**تصريح صريح:** الاختبارات المعزولة **لا تُثبت** التزامن الحقيقي في PostgreSQL. أثبتت منطق التطبيق فقط؛ السلوك الذرّي الفعلي **BLOCKED** لغياب PostgreSQL.

## 5. البوابة قبل/بعد

| البند | قبل | بعد |
| --- | --- | --- |
| HEAD | `98c3a95` | `98c3a95` (لم يتغيّر) |
| staged | 0 | 0 |
| modified | 101 | 101 (`agents.ts` + اختبار الربط مُعدّلان أصلاً) |
| untracked | 116 | 117 (+هذه الوثيقة) |
| deleted | 0 | 0 |
| M0 | `e731e684…fa8694` | مطابق |
| لا stage/commit/push/reset/checkout/stash | — | ✅ |
| لا ملفات مُسترجَعة أو مُستبدلة | — | ✅ |

## 6. القرار
**COMPLETE** (بلا DB) — التصميم المطلوب نُفِّذ بالكامل (حجز ذرّي، لا قفل حول المزوّد، تراكم محمي بقفل قصير، مسارات نجاح/فشل/رفض آمنة). السلوك الذرّي الفعلي في PostgreSQL **BLOCKED**.
