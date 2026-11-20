# AI-INTEG-P3-T1.1 — إصلاحات الميزانية وتسجيل التكلفة (F1 / F2 / F4)

> **الحالة:** ✅ COMPLETE (بلا DB) — تكامل DB: BLOCKED (لا PostgreSQL في البيئة).
> **المرجع:** مراجعة T1 المستقلة · **الفرع:** `master` · **HEAD:** `98c3a95` (لم يتغيّر).
>
> **ملاحظة حالة (T1.8):** هذا التقرير يوثّق لحظة T1.1. عُدِّلت لاحقاً مواضع الالتقاط في
> `agents.ts` (G3) لتشمل `AgentRunBudgetExceededError` أيضاً — انظر §2 «تحديث G3» أدناه.

## 1. التغييرات الدقيقة

| الملف | النوع | التغيير |
| --- | --- | --- |
| `packages/server/src/lib/ai/runtime.ts` | M | F4: `parsePricePer1k` + رفض 503 · F2: تغليف `recordAiRequest` الناجح بـ`AgentCostRecordingError` |
| `packages/server/src/modules/ai/agents.ts` | M | F1: حفظ/تراكم `agent_tasks.cost` في مساري النجاح والفشل + `addDecimalStrings` |
| `packages/server/src/modules/ai/executors.ts` | M | نقل التكلفة: `AgentExecutorResult.cost?` + `cost: out.cost` في 12 موضع إرجاع (لا تغيير منطق) |
| `packages/server/tests/unit/agent-run-budget-runtime.test.ts` | M | +10 اختبارات (F2: 3 · F4: 7) |
| `packages/server/tests/unit/agent-run-context-wiring.test.ts` | M | +5 اختبارات (F1) |

**لم يُلمَس:** `scope.ts`, `supervisor-policy.ts`, Schema, migrations, seeds. لا تغيير في `cost-control.ts`.

---

## 2. F1 — حفظ تكلفة المهمة

### المصدر الدقيق للتكلفة الفعلية
`runAIFeature` يحسب `actualCost = inputPer1k·tokensIn/1000 + outputPer1k·tokensOut/1000` ويعيده في `RunFeatureOutput.cost` (Decimal → `toFixed(10)`).

### سلسلة النقل
```
runAIFeature.cost ─► executors AgentExecutorResult.cost ─► agents.ts agent_tasks.cost
```
- `AgentExecutorResult.cost?: string` (اختياري): غيابه = **تكلفة مجهولة**، لا صفر.
- 12 موضع إرجاع في `executors.ts` تنقل `cost: out.cost` (موزّعة على **11 دالة `exec*`**: `execProductAgent` لها موضعان).

### الكتابة
| المسار | السلوك |
| --- | --- |
| `createAgentTask` نجاح | `...(cost !== null ? { cost } : {})` — يكتب التكلفة المقيسة؛ المجهول يبقى غير مكتوب |
| `createAgentTask` فشل | التكلفة المقيسة بعد المزوّد (من الخطأ) تُحفظ |
| `decideAgentTask` نجاح | `addDecimalStrings(task.cost, advice.cost)` — **تراكم** لا استبدال |
| `decideAgentTask` فشل | `addDecimalStrings(task.cost, <تكلفة الخطأ>)` — تراكم محمي بقفل عبر `writeTaskTerminal` |

> **تحديث G3 (T1.8):** في T1.1 كان المصدر في مساري الفشل هو
> `err instanceof AgentCostRecordingError ? err.costUsd : null`. عُدِّل في G3 إلى دالة موحّدة
> `measuredCostFromError(err)` تستخرج التكلفة من **`AgentCostRecordingError` أو
> `AgentRunBudgetExceededError`** (حيث صار يحمل `actualCostUsd` منفصلاً عن `spentUsd`)، فلا
> تُفقد تكلفة استدعاء `OVER_BUDGET`. القيمة المُستعادة هي تكلفة **الاستدعاء** لا الإجمالي
> التراكمي ⇒ لا ازدواج.

### التراكم وإعادة المحاولة
- `addDecimalStrings(a, b) = parseStoredCostUsd(a).plus(parseStoredCostUsd(b)).toFixed(10)` — Decimal خالص، بلا floating-point.
- بذر الميزانية `new AgentRunBudget(cap, parseStoredCostUsd(task.cost))` يقرأ القيمة المحفوظة ⇒ إعادة المحاولة لا تصفّر السقف.

### المجهول ≠ صفر
- `cost: string | null = null` (مجهول) مقابل `'0'` (صفر حقيقي).
- المجهول يُكتب كـ"غير موجود" (لا يُخزَّن `'0'` مضلّل)، ويُطوى إلى `'0'` عند حدود الـAPI فقط.

---

## 3. F2 — سلامة تسجيل التكلفة

- **مسار النجاح:** `recordAiRequest` ملفوف في `try/catch`؛ عند الفشل يُطلق `AgentCostRecordingError(cost, cause)` ⇒ لا "نجاح" غير مُحاسَب.
- **حفظ الخطأ الأصلي:** يُمرَّر كـ`cause` (حقل) — لا يُخفى بخطأ ثانوي.
- **مسار الفشل (provider):** يبقى `throw err` الأصلي بعد `.catch(logger.error)` لتسجيل الصف الفاشل ⇒ لا يُمحى فشل المزوّد.
- **لا ازدواج:** `settle` مرة واحدة؛ `recordAiRequest` مرة واحدة لكل مسار؛ `release` في مسار فشل المزوّد فقط.
- **لا تسوية ثانية:** لا استدعاء لـ`settle` بعد النجاح.
- **الفرق:** فشل التنفيذ (provider) ≠ فشل تسجيل التكلفة (`RUN_COST_NOT_RECORDED`، قابل لإعادة المحاولة).
- **لا ادّعاء ذرية:** لا توجد معاملة موحّدة بين DB والميزانية؛ `settle` في الذاكرة و`recordAiRequest` في DB خطوتان منفصلتان — موثّق صراحةً.

---

## 4. F4 — التحقق من أسعار النماذج

```ts
function parsePricePer1k(raw: unknown): Decimal {
  let value: Decimal;
  try { value = new Decimal((raw ?? '0') as Decimal.Value); }
  catch { throw ApiError.serviceUnavailable('AI model pricing is misconfigured (non-numeric price)'); }
  if (!value.isFinite() || value.lt(0)) {
    throw ApiError.serviceUnavailable('AI model pricing is misconfigured (invalid price)');
  }
  return value;
}
```
- **fail-closed:** السالب/NaN/Infinity/غير الرقمي ⇒ 503 قبل أي `reserve` أو `provider.call`.
- **الصفر صالح:** النماذج المجانية تعمل (`cost` = 0).
- **سياسة الميزانية الشهرية لم تتغيّر:** `assertWithinBudget` كما هي؛ الإصلاح في طبقة السعر يمنع التقدير السالب من الوصول إلى `reserve` أصلاً.

---

## 5. الاختبارات

| المعيار المطلوب | الاختبار | النتيجة |
| --- | --- | --- |
| حفظ التكلفة الفعلية | `agent-run-context-wiring` | ✅ |
| استعادة التكلفة عند إعادة المحاولة | T1 (`settle`) + بذر `task.cost` | ✅ |
| تراكم السابقة والجديدة دون تصفير | `agent-run-context-wiring` (0.001+0.0002=0.0012) | ✅ |
| فشل تسجيل التكلفة (نجاح/فشل) | `agent-run-budget-runtime` (F2) | ✅ |
| منع ازدواج التسجيل | F2 settle-once + P2 | ✅ |
| الأسعار السالبة/NaN/Infinity/غير الرقمية | `agent-run-budget-runtime` (F4 it.each) | ✅ |
| منع `provider.call` عند تسعير غير صالح | F4 (calls=0) | ✅ |
| حفظ اختبارات P2 وT1 | 53 P2 + T1 | ✅ |

**النتيجة:** **79/79** (53 P2 + 26 T1/T1.1) · `tsc --noEmit` = **0 أخطاء** (src + tests).

---

## 6. ما بقي BLOCKED (غياب PostgreSQL)

| البند | السبب |
| --- | --- |
| سلوك SQL الفعلي لـ`update ... set cost` | لا PostgreSQL |
| حالات القفل الفعلية تحت تزامن متعدد الاتصالات | لا PostgreSQL |
| `upsertAiUsage`/`recordAiRequest` مقابل DB حقيقي | لا PostgreSQL |
| فقدان التحديث المتراكم (lost update) على `cost` | يتطلب معاملة DB؛ الكود يقرأ-ثم-يكتب بلا قفل صف ⇒ 🔴 **قيد مثبت** |

**قيد مثبت (🔴):** في `decideAgentTask`، التراكم `addDecimalStrings(task.cost, advice.cost)` يقرأ `task.cost` من لقطة سابقة؛ تحديثان متزامنان لنفس المهمة قد يفقدان أحدهما (read-modify-write بلا `SELECT ... FOR UPDATE` أو `cost = cost + x`). لا يمكن إثباته/إصلاحه بلا DB، وهو خارج نطاق T1.1.

> **تحديث (T1.8):** عُولج هذا القيد لاحقاً في **T1.3**: التراكم صار داخل معاملة قصيرة تقفل
> الصف (`SELECT … FOR UPDATE`) عبر `writeTaskTerminal`، ثم دُعِّم في **T1.6** بـterminal
> fencing. أُثبت **منطق** التطبيق معزولاً (لا lost update في المحاكاة)، لكن **السلوك الذرّي
> الفعلي في PostgreSQL ما زال BLOCKED** لغياب قاعدة البيانات. التفاصيل في
> `AI-INTEG-P3-T1.3_ATOMIC_CLAIM.md` و`AI-INTEG-P3-T1.6_SAFE_RECOVERY.md`.

**قيد (🟡):** تمييز "مجهول ≠ صفر" يُفقد عند الحدود: عمود `agent_tasks.cost` له `default '0'`، فمهمة لم تُكتب تكلفتها تُقرأ `'0'` لاحقاً. غير مؤثر عملياً لأن كل مسارات المنفّذين (**11 دالة `exec*`، 12 موضع استدعاء `runAIFeature`**) تمرّ بـ`runAIFeature`.

---

## 7. البوابة قبل/بعد

| البند | قبل | بعد |
| --- | --- | --- |
| HEAD | `98c3a95` | `98c3a95` (لم يتغيّر) |
| staged | 0 | 0 |
| modified | 100 | **101** (+`executors.ts`) |
| untracked | 115 | **116** (+وثيقة T1.1) |
| deleted | 0 | 0 |
| M0 | `e731e684…fa8694` | مطابق |
| لا commit/push/reset/checkout/stash | — | ✅ |
| التغييرات المتراكمة | محفوظة | ✅ |

## 8. القرار
**COMPLETE** (بلا DB) — الفجوة الوحيدة: تكامل DB (BLOCKED)، مع قيد lost-update مثبت.
