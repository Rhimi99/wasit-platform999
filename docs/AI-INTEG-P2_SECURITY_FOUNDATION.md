# AI-INTEG-P2 — الأساس الأمني المستقل (Security Foundation)

> **الحالة:** IMPLEMENTED (ملفات فقط). **لا DB، لا migration، لا seed، لا DEMO/إنتاج.**
> التحقّق كان ساكناً (typecheck) + اختبارات وحدة بلا قاعدة بيانات.
>
> **الفرع:** `master` · **HEAD قبل المهمة:** `98c3a95` (AI-INTEG-P0).
> **المصدر:** `origin/ci/repair-sandbox-2u-g-20261020-190057` @ `0c3d239`.

> **ملاحظة حالة حالية (أُضيفت في T1.8):** هذا التقرير يوثّق **لحظة إدخال P2** (كانت
> الوحدات الثلاث غير مربوطة). منذ ذلك الحين تغيّر الوضع جزئياً:
> - `agent-run-context` **رُبط إنتاجياً** في T1: `agents.ts` (لفّ `createAgentTask` /
>   `decideAgentTask`) و`runtime.ts` (حجز/تسوية الميزانية + دمج الميتاداتا الموثوقة)،
>   ثم عُزّز في G2 (مفتاح `__agentTaskId` الموثوق) وG3 (نقل تكلفة `OVER_BUDGET`).
> - `scope.ts` و`supervisor-policy.ts` **ما زالتا بلا ربط إنتاجي مُثبَت** حتى الآن
>   (لا مستدعٍ إنتاجي). التفاصيل في §3 و§5.1 المُحدَّثين، وفي
>   `AI-INTEG-P3-T1_IMPLEMENTATION.md` و`AI-INTEG-P3-T1.6_SAFE_RECOVERY.md`.
>
> لم تُحذف أي عبارة تاريخية من هذا التقرير؛ أُضيفت ملاحظات الحالة الحالية فقط.

---

## 1. الهدف والنطاق

إدخال **الأساس الأمني المستقل** من Rescue-Canonical كوحدة أولى، **دون استبدال محرك AI
الحالي** (`agents.ts` / `dispatcher.ts` / `planner.ts` / `run-state-machine.ts` /
`scheduling.ts`) ودون كسر توافقه.

**النطاق المُدخَل (3 وحدات، منسوخة حرفياً من Rescue):**

| الوحدة | المسار | الأسطر | الاعتماديات |
| --- | --- | --- | --- |
| Owner/Tenant Scope | `packages/server/src/modules/ai/scope.ts` | 211 | `@wasit/shared` (ApiError, UserRole)، `drizzle-orm`، `DB` (type) |
| Trusted Run Context + Action Gate + Budget | `packages/server/src/lib/ai/agent-run-context.ts` | 287 | `node:async_hooks`، `decimal.js`، `@wasit/shared` (UserRole) |
| Supervisor Policy | `packages/server/src/modules/ai/supervisor-policy.ts` | 107 | لا شيء (نقي) |

**ما لم يُدخَل (خارج نطاق P2):** `runner.ts`، `tool-gateway.ts`، `tool-handlers.ts`،
`tool-registry.ts`، `catalogue.ts`، `supervisor.ts`، `copilot.ts`، `orchestrator.ts`،
`gm-actions.ts`، `cycle.ts`، `memory-*`، `metrics-repo.ts`، `outbox-*`، `agent-monitor.ts`.

---

## 2. تصميم الصلاحيات والسياق

### 2.1 `scope.ts` — عزل المالك (Tenant Isolation)

- **مُعرَّف واحد فقط لكل عملية**: `owner` = معرّف المستخدم المُصادق (لا كيان بائع، لا شركة،
  لا المُجدوِل المشترك). النوع `OwnerId` مُوسَّم (branded) لمنع تمرير سلسلة عارية.
- **الحاجز الحقيقي وقت التشغيل**: `WeakSet` (`VALID_SCOPES`). الأنواع تختفي وقت التشغيل،
  لذا `assertValidScope` يرفض أي كائن مُصنَّع يدوياً (مثل `{isPlatform:true}`) ويرمي
  `NoScopeError` (403 / `FORBIDDEN` / `NO_SCOPE`).
- **fail-closed**: غياب الهوية أو كونها فارغة/مسافات ⇒ رفض. المُجدوِل `system` **ليس**
  مالكاً بشرياً ⇒ `deriveScope` يرفضه.
- **نطاق المنصة**: `isPlatform` لا يأتي أبداً من الطلب؛ يُمنح فقط عبر
  `derivePlatformScope` بعد `resolvePlatformScope` التي تشترط دور `ADMIN` أو `SUPER_ADMIN`
  (لا يكفي `analytics:read:all`).
- **نطاق النظام**: `deriveSystemScope` هو السبيل الوحيد لإنتاج `owner='system'`، ولا يمنح
  أي أدوار أو قراءة عابرة للمالكين.

### 2.2 `agent-run-context.ts` — سياق موثوق + بوابة إجراءات + ميزانية

- **`AsyncLocalStorage`**: هوية المهمة (`taskId`/`agentKey`) تُضبط مرة واحدة حول تنفيذ مهمة،
  فلا تتسرّب بين تنفيذات متزامنة، وتنتهي فور انتهاء التنفيذ.
- **`requireAction(actionId, scope)`**: بوابة **تفشل مغلقة**. غياب السياق، أو غياب قائمة
  المنح، أو غياب المعرّف منها ⇒ رمي `ActionNotAuthorizedError` **قبل** تنفيذ العملية.
  القائمة تُقرأ دائماً من السياق الموثوق، ولا تُمرَّر كوسيط.
- **`mergeAgentTaskMetadata`**: `taskId`/`agentKey` يُؤخذان من السياق الموثوق؛ أي قيمة
  يزوّدها المتصل تُستبدل عند وجود مهمة وتُحذف عند غيابها (منع التزييف).
- **`AgentRunBudget`**: سقف تكلفة لكل تشغيل عبر **حجز ذرّي** (`reserve` قبل النداء،
  `settle` بالتكلفة المقاسة بعده، `release` لنداء لم يصل المزوّد). التزامن لا يسمح
  لندائين بتجاوز نفس الهامش، وإعادة المحاولة تُبذَر بالتكلفة السابقة فلا تُصفَّر البوابة.

### 2.3 `supervisor-policy.ts` — قرار احتواء حتمي

دالة نقية `recommendIntervention(task, limits, nowMs)` بلا DB/ساعة/I-O. الترتيب مقصود
(الأشد أولاً): `stuck` (CRITICAL) → `stale` (WARNING) → `halt-loop` (CRITICAL) →
`block-budget` (CRITICAL). سقف المحاولات يُقصّ إلى `limits.maxAttempts` فلا يرفع مهمة
سقفها بنفسها.

---

## 3. ما تم إدخاله / ما لم يتم إدخاله

| البند | القرار |
| --- | --- |
| الوحدات الثلاث أعلاه | ✅ مُدخَلة (verbatim، بصمة مطابقة للفرع) |
| اختبارات وحدة مركزة (3 ملفات، 53 اختباراً) | ✅ مُضافة (بلا DB) |
| ربط إنتاجي (`runtime.ts` / `routes.ts`) | ⛔ **لم يُنفَّذ في P2** — التبرير في §5 · **مُحدَّث:** `runtime.ts` رُبط لاحقاً في T1 (انظر §5) |
| تعديل `agents.ts` أو أي من الـ202 المتراكمة | ⛔ لم يُلمَس في P2 · **مُحدَّث:** `agents.ts` عُدّل لاحقاً في T1/T1.1/T1.3/T1.6/G2/G3 |
| Schema / migrations / journal / snapshots | ⛔ بلا تغيير (ولا حتى الآن) |
| دورة حياة `agent_runs` / Recovery / Fencing | ⛔ بلا تغيير |
| توسيع صلاحيات ADMIN/SUPER_ADMIN/الوكلاء | ⛔ لا توسيع (السياسة تشدّد فقط) |
| مسارات مالية/دفع/تحويل | ⛔ لا شيء |

---

## 4. الاختبارات ونتائجها

| الاختبار | الملف | العدد | النتيجة |
| --- | --- | --- | --- |
| عزل المالك + الحاجز + المنصة + النظام | `tests/unit/agent-scope-isolation.test.ts` | 21 | ✅ |
| السياق + بوابة الإجراءات + الميزانية | `tests/unit/agent-run-context.test.ts` | 21 | ✅ |
| سياسة الاحتواء | `tests/unit/supervisor-policy.test.ts` | 11 | ✅ |
| **المجموع** | | **53** | **✅ 53/53** |

**تغطية المطلوب:** عزل المستأجرين، منع الوصول خارج النطاق، رفض السياق غير الصحيح،
فشل آمن عند غياب الهوية أو الصلاحية — كلها مغطّاة.

| فحص ساكن | الأمر | النتيجة |
| --- | --- | --- |
| Server typecheck (src + tests) | `tsc --noEmit` | ✅ **EXIT=0 / 0 أخطاء** |
| اختبارات الوحدة (بلا DB) | `vitest run … --config /dev/null` | ✅ **53/53** |

---

## 5. التوافق مع Master — ولماذا لا ربط إنتاجي الآن

> **تحديث الحالة (T1.8):** لم تعد `agent-run-context` غير مربوطة. رُبطت إنتاجياً في T1
> (§5.1 أدناه تحقّقت فعلاً). أما `scope.ts` و`supervisor-policy.ts` فما زالتا بلا مستدعٍ
> إنتاجي. التبريرات التاريخية التالية تشرح **لماذا تأجّل الربط في P2**، وتُقرأ الآن كسجل
> لا كحالة راهنة.

**الوحدات الثلاث لا يستوردها أي ملف إنتاجي** ⇒ إضافتها **لا يمكن أن تكسر** أي سلوك قائم
(لا يقرؤها إلا اختباراتها). هذا مُتحقَّق بالـtypecheck الشامل (src + tests) = 0 أخطاء.

**لماذا لم يُربط إنتاجياً في هذه المرحلة:**

1. **المستهلك الطبيعي لـ`agent-run-context` هو الـRunner** (`runner.ts`)، وهو **مستثنى
   صراحةً** من P2. بدون Runner، لا يُستدعى `withAgentRunContext`/`withAgentRunBudget`،
   فتبقى حرّاس الميزانية والبوابة **فروعاً ميتة عملياً** (no-op) — أي ربط بلا أثر وظيفي.
2. **المستهلك الطبيعي لـ`scope.ts` هو repos الـ`agent_metrics`/`agent_memory`** — لا
   وجود لها في Master.
3. **المستهلك الطبيعي لـ`supervisor-policy` هو `supervisor.ts`** — مستثنى من P2.
4. **تعديل `runtime.ts` غير قابل للتحقق الآن**: أي ربط فيه يجب إثباته عبر حزمة التكامل
   (تحتاج PostgreSQL)، وهي **غير متاحة في هذه المهمة** ⇒ لا يمكن إثبات عدم الكسر. لذلك
   امتنعنا عن لمسه بدل تنفيذ ربط لا يمكن إثباته (التزاماً بـ«اربط فقط إذا أمكن إثبات عدم
   كسر Master»).

**الخلاصة:** هذه وحدات **أساس (foundation)** مُختبَرة بعقد واضح، يستهلكها P5 (Runner) وما
بعده — وليست حشواً منقولاً من Rescue: اقتصر النقل على الوحدات المُسمّاة في نطاق P2 فقط،
ولم يُنقل أي ملف خارجها.

### 5.1 نقاط الربط المحددة للمرحلة التالية (P5)

> **حالة التنفيذ (T1.8):** الصف الأول **نُفِّذ فعلاً في T1** (وليس في P5). الصفّان الآخران
> ما زالا مؤجّلين.

| الوحدة | نقطة الربط المستقبلية | الحالة |
| --- | --- | --- |
| `agent-run-context` | `lib/ai/runtime.ts`: `getAgentRunBudget()` (reserve/release/settle) + `mergeAgentTaskMetadata(input.metadata, getAgentRunContext())` — بشرط إبقاء السلوك مطابقاً عند غياب السياق | ✅ **مُنفَّذ في T1** (+ G2/G3). اللفّ أيضاً في `agents.ts` (`createAgentTask`/`decideAgentTask`) |
| `scope` | `agent-monitor.ts` / `metrics-repo.ts` / `memory-repo.ts`: `assertValidScope` قبل كل قراءة/كتابة، و`derivePlatformScope` لقراءات التجميع | ⛔ **لم يُنفَّذ** — لا مستدعٍ إنتاجي (الملفات الهدف غير موجودة) |
| `supervisor-policy` | `supervisor.ts`: `recommendIntervention` لكل صف مهمة | ⛔ **لم يُنفَّذ** — لا `supervisor.ts` إنتاجي |

---

## 6. المخاطر والفجوات المتبقية

| # | البند | الشدة | الملاحظة |
| --- | --- | --- | --- |
| R1 | الوحدات الثلاث **غير مربوطة بإنتاج** حالياً | 🟡 منخفضة | **مُحدَّث (T1.8):** `agent-run-context` رُبط في T1 ⇒ مغلق؛ `scope`/`supervisor-policy` ما زالتا غير مربوطتين (أساس مُختبَر ينتظر مستهلكاً) |
| R2 | `userHasPlatformScope(db, …)` غير مغطّى باختبار وحدة (يحتاج DB) | 🟡 منخفضة | منطقها النقي (`resolvePlatformScope`) مغطّى؛ الاستعلام يُغطّى في حزمة التكامل |
| R3 | `runtime.ts` لم يُعدّل ⇒ حرّاس الميزانية غير مُفعَّلة | 🟡 منخفضة | **مُحدَّث (T1.8):** `runtime.ts` عُدّل في T1 ⇒ الحرّاس مُفعَّلة داخل سياق التشغيل؛ تبقى no-op خارجه (مقصود) |
| R4 | حزمة التكامل (PostgreSQL) لم تُشغَّل | 🟡 منخفضة | **مستمر:** ممنوعة في هذه المهام؛ التحقّق ساكن + وحدة فقط — التكامل ما زال BLOCKED |
| R5 | اعتماد `decimal.js` | 🟢 منخفضة | موجود في `packages/server/package.json` (^10.6.0) ومُثبَّت |

---

## 7. الملفات المتغيّرة

**جديدة (7):**

- `packages/server/src/modules/ai/scope.ts`
- `packages/server/src/lib/ai/agent-run-context.ts`
- `packages/server/src/modules/ai/supervisor-policy.ts`
- `packages/server/tests/unit/agent-scope-isolation.test.ts`
- `packages/server/tests/unit/agent-run-context.test.ts`
- `packages/server/tests/unit/supervisor-policy.test.ts`
- `docs/AI-INTEG-P2_SECURITY_FOUNDATION.md` (هذا الملف)

**معدَّلة:** لا شيء. **محذوفة:** لا شيء.

---

## 8. الخطوة التالية

P3/P5 (خارج هذه المهمة): استكمال طبقات L1–L3 (Tool Gateway، Memory/Metrics، Runner) مع
ربط الوحدات أعلاه بنقاط الربط في §5.1، وإثبات عدم الكسر عبر حزمة التكامل على PostgreSQL
معزولة.

> **تحديث (T1.8):** أُنجز شطر من هذا في T1 (`agent-run-context` في `agents.ts`/`runtime.ts`).
> يبقى ربط `scope.ts` و`supervisor-policy.ts` بلا مستهلك إنتاجي، وإثبات PostgreSQL الفعلي
> (ذرّية القفل، التزامن) ما زال **BLOCKED** لغياب قاعدة البيانات في البيئة.
