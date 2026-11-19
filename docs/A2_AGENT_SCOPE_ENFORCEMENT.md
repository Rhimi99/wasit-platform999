# WASIT AI Company — A2: فرض نطاق الوكلاء في الإنتاج (Agent Scope Enforcement)

> **المهمة:** `WASIT-AI-COMPANY-A2` — Least Privilege & Data Isolation
> **الحالة:** ✅ مكتملة (مع بند واحد `BLOCKED` موثّق أدناه)
> **النوع:** ضابط أمان تنفيذي · **لا** Migration · **لا** جدول جديد · **لا** صلاحية جديدة · **لا** Tool Gateway · **لا** LLM حقيقي · **لا** Memory.
> **الاعتماد على:** `A1` (مفتاح الإيقاف المركزي) يبقى فعّالاً كما هو.

---

## 1. المشكلة (الفجوة)

الملف `packages/server/src/modules/ai/scope.ts` كان موجوداً لكن **بلا مستدعٍ إنتاجي** — يُستخدم في الاختبارات فقط. أي أن عزل بيانات الوكيل (owner/tenant) كان مُعرَّفاً لكن **غير مفروض** في مسارات الإنتاج، ولم يكن هناك عقد موحّد يحدّد ما يستطيع كل وكيل الوصول إليه.

**النتيجة قبل A2:** الـ11 Executor يقرأون قاعدة البيانات مباشرة دون أي حدّ مركزي يمنع وكيلاً من قراءة جدول خارج اختصاصه.

---

## 2. الحل (نظرة عامة)

أُضيف **عقد نطاق موحّد لكل وكيل** + **حاجز فرض مركزي** على مستوى **الوصول الفعلي للبيانات** (طبقة `db` التي يتلقّاها الـExecutor)، وربط `scope.ts` بمسار الإنتاج.

المبدأ: **الأقل صلاحية (Least Privilege) + الفشل المغلق (Fail-Closed)**. إذا تعذّر تحديد النطاق، أو كان غير معروف، أو كان الوكيل غير معرّف — **يُرفض الوصول**، ولا تُوسَّع الصلاحيات تلقائياً.

---

## 3. الملفات التي تغيّرت

| الملف | التغيير |
|---|---|
| `packages/server/src/modules/ai/agent-scope.ts` | **جديد** — العقد الموحّد + حاجز الفرض (`withAgentDataScope`) + الحُرّاس. |
| `packages/server/src/lib/ai/agent-run-context.ts` | إضافة `allowedTables` إلى سياق التشغيل (منحة مُشتقّة من الخادم). |
| `packages/server/src/modules/ai/agents.ts` | `buildRunContext` يشتقّ `allowedTables` من العقد + يستدعي `assertRunOwnerScope` (ربط `scope.ts`). |
| `packages/server/src/modules/ai/executors.ts` | نقطة التنفيذ الوحيدة `executeAgentTask` تُمرّر `db` مُقيَّداً بالنطاق إلى كل Executor. |
| `packages/server/tests/unit/agent-scope-contract.test.ts` | **جديد** — اختبارات العقد (23). |
| `packages/server/tests/unit/agent-scope-enforcement.test.ts` | **جديد** — اختبارات الحاجز (9). |
| `packages/server/tests/a2-agent-scope.test.ts` | **جديد** — اختبارات تكامل على PostgreSQL حقيقي (10). |
| `docs/A2_AGENT_SCOPE_ENFORCEMENT.md` | **جديد** — هذا المستند. |
| `AGENTS.md` | إضافة مدخل A2. |

**لم يُمَس:** الـ11 Executor لم تُعَد كتابتها · لا وكيل جديد · لا تغيير في RBAC · لا تغيير في A1.

---

## 4. كيف أصبح `scope.ts` مستخدماً في الإنتاج

نقطة الربط الوحيدة: `buildRunContext` في `agents.ts` — وهي الدالة التي تُبنى قبل **كل** تنفيذ وكيل (سواء الطلب المباشر أو بعد الاعتماد). تُستدعى الآن:

```ts
assertRunOwnerScope(task.requestedBy);
```

وهي تُفوّض إلى `scope.ts` (`deriveScope` / `deriveSystemScope` + `assertValidScope`):
- إن كان مُقدّم الطلب مستخدماً حقيقياً ⇒ يُشتقّ نطاق مالك صالح.
- إن كان المُقدّم هو مُعرّف المجدول (`system`) ⇒ يُشتقّ نطاق النظام المخصّص.
- إن غاب المُقدّم أو كان فارغاً ⇒ **رفض مغلق** قبل أي وصول للبيانات.

كما يُستدعى فحص المالك **مرة ثانية** عند حدود البيانات لأي جدول مصنّف «مقيَّد بالمالك» (`agent_metrics` / `agent_memory`)، فلا يمكن قراءة بيانات مالك آخر.

---

## 5. نطاق كل وكيل من الـ11

الحدود مشتقّة من **الجداول التي يقرأها الـExecutor فعلياً** في الكود (لا من اسم الوكيل). كل وكيل **قراءة فقط**، **بلا تفويض**، **مقيَّد بالمالك**.

| الوكيل | المجالات المسموحة | الجداول المسموحة (للقراءة فقط) |
|---|---|---|
| **Sales Agent** | COMMERCE · MARKETPLACE · B2B · TRUST | `orders`, `products`, `suppliers`, `merchants`, `companies`, `trust_scores` |
| **Marketing Agent** | MARKETPLACE · MEDIA | `products`, `categories`, `media_assets` |
| **Ads Agent** | ADS | `campaigns`, `ad_events` |
| **Product Agent** | MARKETPLACE | `products`, `categories`, `product_variants`, `product_images`, `inventory_items` |
| **Support Agent** | MESSAGING · OPS | `threads`, `messages`, `users` |
| **Analytics Agent** | ANALYTICS · COMMERCE · MARKETPLACE · B2B | `users`, `products`, `suppliers`, `merchants`, `companies`, `orders`, `order_items`, `daily_kpis` |
| **Market Research Agent** | MARKETPLACE · ANALYTICS | `products`, `categories`, `orders`, `suppliers`, `merchants` |
| **B2B Agent** | B2B | `suppliers`, `merchants`, `companies` |
| **Risk Agent** | RISK | `risk_profiles`, `risk_events` |
| **Dispute Assistant** | DISPUTE | `disputes`, `dispute_messages` |
| **Development Agent** | OPS · ANALYTICS · COMMERCE · ADS | `users`, `products`, `orders`, `campaigns`, `daily_kpis` |

**ملاحظات:**
- لا وكيل يحصل على نطاق واسع «لكل الجداول» — كل وكيل يستبعد جداول وكيل آخر على الأقل.
- **جداول محظورة على الجميع** (دفاع في العمق): بيانات الاعتماد/الجلسات (`sessions`, `mfa_challenges`, …) · الصلاحيات (`roles`, `permissions`, …) · التدقيق/القانوني (`audit_logs`, `consents`, …) · **حركة الأموال** (`payments`, `payouts`, `refunds`, `seller_settlements`, `transaction_ledger`, `commissions`, …).
- **جداول محاسبة المنصّة** (`ai_models`, `ai_requests`, `ai_usage`, `ai_budgets`) مسموحة لكل وكيل لأنها بنية تحتية لتشغيل الـAI، وليست بيانات أعمال — ولا توسّع أي مجال بيانات.

---

## 6. نقاط الفرض الفعلية

الفرض مركزي، من جهة الخادم، عند **نقطة الوصول الفعلية للبيانات**:

1. **`executeAgentTask`** (نقطة التنفيذ الوحيدة): تُمرّر `db` مُغلَّفاً بـ`withAgentDataScope` إلى كل Executor. لا يمكن لأي Executor أن يتجاوزها لأنه لا يملك `db` خاماً.
2. **حاجز `db` المُغلَّف** يفحص **كل** عملية تحمل جدولاً:
   - `select().from(...)` والوصلات (`innerJoin`/`leftJoin`/`rightJoin`/`fullJoin`) ⇒ فحص **قراءة**.
   - `insert`/`update`/`delete` ⇒ فحص **كتابة** (مرفوضة دائماً لأن الوكلاء قراءة فقط).
   - `execute`/`transaction`/`query` (SQL خام/معاملات) ⇒ **مرفوضة**.
   - مصدر غير معروف ⇒ **مرفوض** (fail-closed).
3. **`buildRunContext`**: يشتقّ منحة الجداول من العقد، ويفرض حدّ المالك (`scope.ts`) **قبل** أي وصول.
4. **منع التجاوز عبر**: Executor آخر · مهمة أخرى · تسليم لوكيل آخر (لا يوجد، `canDelegate=false`) · Endpoint آخر · تغيير `agentKey` · تمرير `parameters`/`context` — كلها مرفوضة لأن المنحة تُقرأ من السياق الموثوق **وتتقاطع** مع عقد الوكيل (لا يمكن إلا **تضييقها**، لا توسيعها)، ولا تُقرأ أبداً من `input`.
5. **الواجهة (UI) لا تُستخدم للفرض** — الفرض كله من جهة الخادم.

---

## 7. السلوك عند الفشل (Fail-Closed)

| الحالة | النتيجة |
|---|---|
| لا سياق تشغيل موثوق | **رفض** (403 `AGENT_SCOPE`) |
| وكيل بلا عقد نطاق | **رفض** |
| جدول خارج نطاق الوكيل | **رفض** |
| جدول محظور عالمياً | **رفض** |
| كتابة على جدول أعمال | **رفض** |
| SQL خام / معاملة | **رفض** |
| جدول مقيَّد بالمالك بلا مالك صالح | **رفض** |
| مصدر بيانات غير معروف | **رفض** |

لا يوجد أي مسار «توسيع تلقائي» عند غياب النطاق.

---

## 8. حدود الوكيل↔الوكيل (Delegation)

- `canDelegate = false` لكل الوكلاء: **لا وكيل يستطيع تسليم مهامه أو تشغيل نفسه كـوكيل آخر**.
- التنسيق بين الوكلاء يبقى عبر **المنسّق (Orchestrator/Planner)** فقط، وكل خطوة تعمل داخل نطاق الوكيل الخاص بها.
- تسليم نطاق أوسع من وكيل إلى آخر **غير ممكن بنيوياً** (العقد لكل وكيل ثابت ومستقل).

---

## 9. كيفية إضافة وكيل جديد بأمان

1. أضف تعريفاً في `AGENT_CATALOGUE` (`agents.ts`) مع `capabilities` و`permissionsRequired`.
2. أضف **عقد نطاق** في `AGENT_SCOPE_CONTRACTS` (`agent-scope.ts`) يحدّد **فقط** الجداول التي يقرأها الـExecutor فعلياً.
3. أضف الـExecutor في `executors.ts` وسجّل `EXECUTOR_ACTION[key]`.
4. **بدون عقد نطاق، الوكيل مرفوض تلقائياً** (fail-closed) — لن يعمل أبداً حتى يُعرَّف نطاقه.
5. لا تمنحه جداول خارج اختصاصه: إن احتاج بيانات غير مبرَّرة، **ارفض الوصول وسجّل النقص** بدل توسيع النطاق.

---

## 10. اختبارات عزل النطاق

- `tests/unit/agent-scope-contract.test.ts` (23 ✅): اكتمال العقود للـ11 · الأقل صلاحية · رفض الجداول المحظورة · الفشل المغلق · **التحقق أن كل جدول مسموح هو جدول حقيقي** (لا أخطاء إملائية).
- `tests/unit/agent-scope-enforcement.test.ts` (9 ✅): الحاجز يسمح داخل النطاق ويرفض خارجه · رفض الكتابة/SQL الخام/المعاملة · الفشل المغلق · **الفرض يعمل على مسار إنتاجي حقيقي** (`createAgentTask`).
- `tests/a2-agent-scope.test.ts` (10 ✅): على **PostgreSQL حقيقي** — الـ11 يعملون · قراءة فعلية عبر الحاجز · رفض جدول وكيل آخر/محظور/كتابة · عزل المالك · **A1 يبقى فعّالاً** · مطابقة السجل الحيّ للعقود.

---

## 11. المخاطر المتبقية و`BLOCKED`

- **BLOCKED (لا يتطلب DB جديداً لكن يحدّ التغطية):** الحاجز يحمي **كل جدول تُبنى عليه استعلامات Drizzle** (`select().from()/join/insert/update/delete`). أي وصول مستقبلي عبر **SQL خام** (`db.execute`) داخل Executor مرفوض بالتصميم — وهو سلوك مقصود (fail-closed)، لكنه يعني أن أي Executor مستقبلي يحتاج SQL خاماً سيتعطّل حتى يُمنح مساراً مُدقَّقاً. لا يوجد هذا النوع اليوم في الـ11.
- **مخاطرة متبقية:** الفرض مرتبط بعقد الوكيل؛ إن أُضيف جدول جديد يقرأه Executor قائم ولم يُحدَّث العقد، سيُرفض التشغيل (fail-closed) — وهو آمن لكنه يحتاج تحديثاً متعمّداً للعقد.
- **غير مشمول في A2 (خارج النطاق):** Tool Gateway · Memory · LLM حقيقي · صلاحيات تنفيذ تجاري — كلها مؤجّلة بقرار GM.

---

## 12. حالة A1 بعد A2

**A1 سليم ولم يتغيّر.** فحوص مفتاح الإيقاف ما زالت في مواضعها العشرة، واختبارات A1 (`a1-kill-switch-unit` 6 + `a1-kill-switch` 13) ناجحة، وأضاف اختبار A2 تكاملياً يؤكّد أن **إنشاء مهمة يُرفض أثناء الإيقاف** ويعمل بعد إعادة التفعيل. الفرضان متكاملان: A1 يوقف التنفيذ، وA2 يحدّ نطاقه.

---

## 13. الخطوة التالية في خارطة WASIT AI Company

`A3` — (تُحدَّد عند طلب GM). **لم تُبدأ تلقائياً.**
