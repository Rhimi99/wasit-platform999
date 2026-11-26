# WASIT-AI-KILLSWITCH-FLEET-01 — تصميم Kill Switch مركزي عبر النسخ

> **الحالة:** ✅ **منفَّذ ومتحقَّق** (Migration `0049` مطبَّقة على قاعدة الاختبار المعزولة فقط).
> **الفرع:** `wasit-ai-killswitch-fleet-01` · **الأساس:** `e8c2ac0` (لوحة المدير العام).
> **حالة §7 (بوابة الموافقة):** وُوفق على تغيير قاعدة البيانات الوحيد، وطُبِّق على `wasit_test`
> المحلية فقط؛ لم تُلمس قاعدة إنتاج/ديمو/staging. حالة التنفيذ في §8.

## 1. الفجوة المؤكدة في الكود الحالي

| الحقيقة | الدليل |
| --- | --- |
| الحالة في ذاكرة العملية (`let runtimeOverride`) | `src/lib/ai/kill-switch.ts:38` |
| تعليق المصدر يعترف صراحةً أنها ليست fleet-wide | `src/lib/ai/kill-switch.ts:24-30` |
| كل نقاط التنفيذ تقرأ الذاكرة نفسها | 11 موضعاً: `planner.ts:305`، `agents.ts:352,835`، `dispatcher.ts:211,788,915`، `copilot/service.ts:96,230`، `supervisor.ts:257,371`، `scheduling.ts:434`، `escalations.ts:671`، `tool-gateway.ts:209`، `runtime.ts:205` |
| لا يوجد جدول إعدادات عام (key/value) | فحص `src/db/schema/*` و`src/db/migrations/*`: لا `platform_settings`/`feature_flags`؛ الجداول العامة الوحيدة `policies` (enum نطاقات تجارية بلا `SYSTEM`) و`agent_registry` (كتالوج هويات) |
| `agent_registry.status` (`ACTIVE|PAUSED|DISABLED`) موثّق كمانع تنفيذ لكنه **غير مُفعَّل** | تعليق العمود `schema/agents.ts:44-45` يقوله؛ لا قراءة له في أي بوابة تنفيذ (`grep PAUSED` ⇒ لا نتيجة في مسارات التنفيذ) |
| الاستئناف بعد إعادة التشغيل يعود لقيمة env | `resolveEnabled()` fallback إلى `AI_AGENT_EXECUTION_ENABLED` |

**الخلاصة:** الإيقاف الحالي يوقف العملية التي استلمت الأمر فقط، ولا يمنع نسخة أخرى، ولا يبقى بعد restart، ولا يميّز إيقاف وكيل واحد، ولا يسجّل صاحب/سبب الإيقاف في حالة دائمة.

## 2. القرار المعماري

**مصدر حقيقة واحد في PostgreSQL** (نفس قاعدة المنصة، بلا Redis/بنية جديدة): جدول واحد
`ai_execution_switches` بصفّين من نوعين:

- `scope='GLOBAL', target_key='*'` — الإيقاف الشامل (صف واحد دائم).
- `scope='AGENT', target_key='<agentKey>'` — إيقاف وكيل محدد (صف لكل وكيل مُوقَف).

كل قراءة/كتابة تمرّ عبر خدمة واحدة `lib/ai/execution-switch/`، و`kill-switch.ts` يصبح واجهة
متوافقة تُفوّض إليها. **لا كاش في الذاكرة** (شرط §3.3): القراءة في نقطة التنفيذ نفسها،
لأن العملية الواحدة `SELECT … WHERE scope='GLOBAL'` على فهرس فريد تكلفتها مهملة أمام تنفيذ وكيل
يستغرق ثواني ويكتب عدة صفوف أصلاً.

### البدائل المرفوضة ولماذا

| البديل | سبب الرفض |
| --- | --- |
| صف في `policies` | `policy_scope` enum نطاقات تجارية (COMMISSION/TAX/…) بلا `SYSTEM`؛ إقحام المفتاح في نطاق تجاري يلوّث `resolveMergedPolicy` وقوائم السياسات. تغيير الـenum نفسه migration كذلك. |
| صف حارس في `agent_registry` | يُغيّر عدّ الوكلاء في لوحة GM وCopilot (`20 agent`) ويكسر «لا تغيّر هويات الوكلاء». |
| صف في `ai_spend_limits` | يُفسد تقرير الإنفاق (سقف وهمي يظهر للمشغّل). |
| اشتقاق الحالة من `audit_logs` | سجل إلحاقي بلا قيد فريد، وترتيب متزامن غير حاسم ⇒ سباق. |
| Redis/ذاكرة مشتركة | بنية جديدة كاملة لمفتاح واحد؛ القاعدة موجودة ومتاحة. |
| 20 صف `status='PAUSED'` كإيقاف شامل | لا يغطي Copilot/Supervisor، ولا الوكلاء المضافين لاحقاً، ويفقد الإيقاف الفردي السابق. |

## 3. تصميم الـMigration (لا تُطبَّق قبل الموافقة)

تغيير **إضافي واحد**: جدول جديد + صف تحكّم واحد داخل نفس الـmigration. لا `ALTER TYPE`،
لا تعديل جدول قائم، لا backfill، لا seed تطبيقي.

```sql
CREATE TABLE IF NOT EXISTS "ai_execution_switches" (
  "id" varchar(36) PRIMARY KEY,
  "scope" varchar(10) NOT NULL,
  "target_key" varchar(64) NOT NULL,
  "stopped" boolean NOT NULL DEFAULT false,
  "reason" text,
  "actor_id" varchar(36),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_execution_switches_scope_chk" CHECK ("scope" IN ('GLOBAL','AGENT')),
  CONSTRAINT "ai_execution_switches_target_chk" CHECK (
    ("scope" = 'GLOBAL' AND "target_key" = '*') OR
    ("scope" = 'AGENT'  AND "target_key" <> '*')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_execution_switches_scope_target_idx"
  ON "ai_execution_switches" ("scope", "target_key");
-- صف التحكّم الوحيد: جزء من الـDDL لا seed تطبيقي.
INSERT INTO "ai_execution_switches" ("id","scope","target_key","stopped","version")
VALUES ('00000000-0000-0000-0000-000000000001','GLOBAL','*',false,1)
ON CONFLICT ("scope","target_key") DO NOTHING;
```

**لماذا هي ضرورية:** لا يوجد في المخطط أي مخزن حالة مشترك عام؛ وكل بديل قائم إمّا يلوّث نطاقاً
تجارياً أو يكسر هويات الوكلاء (الجدول أعلاه). **أثرها:** إضافية بحتة — `DROP TABLE` يعيد الحالة
السابقة بلا فقد بيانات، ولا يقرأها أي كود قبل نشر الكود المرافق.

**أين تُطبَّق:** على `wasit_test` (قاعدة اختبار تُعاد من الصفر) فقط بعد الموافقة، وعلى قاعدة
التطوير إن طلبت. **لن تُطبَّق على إنتاج أو قاعدة مستخدمين، ولن تُشغَّل Seeds.**

## 4. تصميم التشغيل

### 4.1 واجهة الخدمة (`lib/ai/execution-switch/`)

| الدالة | السلوك |
| --- | --- |
| `readSwitch(db, agentKey) → {global, agent, state, source}` | قراءة صفّي GLOBAL+AGENT في استعلام واحد (`WHERE scope='GLOBAL' OR (scope='AGENT' AND target_key=$1)`). صف GLOBAL مفقود أو خطأ قراءة ⇒ `state='UNAVAILABLE'`. |
| `assertAgentExecutionAllowed(db, agentKey)` | `GLOBAL.stopped` ⇒ 503 `AI_EXECUTION_DISABLED`؛ `AGENT.stopped` ⇒ 503 `AI_AGENT_PAUSED`؛ `UNAVAILABLE` ⇒ 503 `AI_CONTROL_UNAVAILABLE` (fail-closed). |
| `beginGuardedTask(db, agentKey, fn)` | معاملة واحدة: `SELECT … FROM ai_execution_switches WHERE scope='GLOBAL' FOR SHARE` ثم فحص، ثم كتابة صف المهمة، ثم commit. |
| `setGlobalStopped(db, {stopped, reason, actorId, audit})` | معاملة: `… FOR UPDATE` على صف GLOBAL، `version = version + 1`، `stopped`, `reason`, `actor_id`, `updated_at`، ثم Audit. |
| `setAgentStopped(db, agentKey, …)` | نفس النمط على صف AGENT (إنشاء الصف إن لم يوجد). |

### 4.2 ضمان عدم وجود سباق (شرط §6)

- **بدء/استئناف مهمة:** `FOR SHARE` على صف GLOBAL داخل معاملة إنشاء المهمة.
- **إيقاف:** `FOR UPDATE` على نفس الصف.
- النتيجة: الإيقاف لا يُثبَّت إلا بعد انتهاء كل إنشاء بدأ قبله (فيُغطّى بسياسة «المهام التي بدأت قبل
  الإيقاف»)، وكل إنشاء يبدأ بعد commit الإيقاف يرى `stopped=true` ويُرفض — **لا نافذة زمنية**.
- لا polling: لا مؤقّت ولا كاش؛ الفحص في نقطة الكتابة/التنفيذ نفسها.

### 4.3 سياسة المهام الجارية والمجدولة (شرط §3.4–3.5، §6.8)

| الحالة عند الإيقاف الشامل | السلوك |
| --- | --- |
| `agent_tasks.status='queued'` | تُلغى في نفس معاملة الإيقاف (`status='cancelled'`, `failureReason='AI_EXECUTION_DISABLED'`) + Audit لكل دفعة (سجل واحد بالعدد، لا سجل لكل صف). **لا تُعاد تلقائياً** عند الاستئناف — تُترك للمشغّل (اختبار يثبتها). |
| `status='awaiting_approval'` | تبقى كما هي؛ موافقتها بعد الإيقاف تُرفض 503. |
| `running`/`PLANNING`/`DISPATCHING` (تشغيلات Copilot) | الخطوة الحالية تكتمل، والخطوة التالية تُرفض عبر `dispatchStep` (كل خطوة تمرّ بالبوابة). لا إلغاء قسري لخطوة داخلية (لا يمكن مقاطعتها بأمان) — موثّق كحدّ. |
| `agent_schedules` | لا تُعدَّل صفوفها؛ الاجتياح نفسه يُرفض (`scheduling.ts:434`) ويُسجَّل `AI.KILL_SWITCH_SCHEDULE_REFUSED` مرة/دورة. |
| Supervisor | دورته تُرفض (لا تدخّلات، لا إعادة تشغيل)، ويبقى سطح القراءة متاحاً. |
| Copilot | `plan` و`advance` يرفضان؛ ولا يستطيع تفويض خطوة (كل خطوة `createAgentTask`). |

### 4.4 Fail-closed عند فقد المصدر (شرط §3.6)

خطأ قراءة/انقطاع القاعدة ⇒ `UNAVAILABLE` ⇒ رفض كل بدء جديد بـ503 `AI_CONTROL_UNAVAILABLE`.
القراءات (لوحة GM، `GET /kill-switch`) تعرض `state='UNAVAILABLE'` و`failClosed:true` ولا تدّعي «مفتوح».
`AI_AGENT_EXECUTION_ENABLED=false` يبقى حزاماً ثابتاً: **يستطيع الإيقاف فقط، ولا يستطيع فتح ما أُوقف في DB**
(أولوية: `env disabled` ∨ `db stopped` ∨ `agent stopped`).

### 4.5 التجاوز (شرط §3.7–3.8)

| المسار | كيف يُمنع |
| --- | --- |
| Copilot | لا مسار تنفيذ خاص به (موثّق في AGENTS.md)؛ كل خطوة `dispatchStep→createAgentTask` ⇒ البوابة. `plan`/`advance` يفحصان أيضاً. |
| Supervisor | كل تدخّل يمرّ بـ`createAgentTask`/`dispatchStep`؛ دورته تُرفض. |
| Retry/Recovery | `dispatcher.ts:788,915` + `escalations` تفحص البوابة؛ لا إعادة تشغيل تلقائية. |
| Agent نفسه | لا يملك أي أداة/مسار كتابة على الجدول؛ أدوات الوكيل من `allowedTools` فقط. |
| API آخر | لا مسار كتابة إلا `/api/admin/ai/execution-switch/*` المحمي. |

### 4.6 الصلاحيات (بلا دور/صلاحية جديدة)

| العملية | البوابة |
| --- | --- |
| قراءة الحالة | `AI_MANAGE` \| `ADMIN_AI` (نفس بوابة مكتب AI) |
| إيقاف وكيل / إيقافه هو | `ADMIN` أو `SUPER_ADMIN` صراحةً (لا يعتمد على `AI_MANAGE` وحده) |
| إيقاف شامل | `ADMIN` أو `SUPER_ADMIN` |
| استئناف فردي | `ADMIN`/`SUPER_ADMIN`، ويُرفض 409 `GLOBAL_STOP_ACTIVE` إن كان الشامل فعالاً |
| استئناف شامل | `SUPER_ADMIN` **فقط** (سلطة مستقلة أعلى من الإيقاف) |

`ai-dashboard` GM: يقرأ الحالة ويعرض المصدر. **لا تغيير في RBAC ولا في الأدوار.**

### 4.7 Audit (شرط §5)

| الحدث | البيانات |
| --- | --- |
| `AI.EXECUTION_STOPPED` | scope, targetKey, reason, actorId, version, cancelledQueuedCount |
| `AI.EXECUTION_RESUMED` | scope, targetKey, reason, actorId, version, previousActorId |
| `AI.EXECUTION_RESUME_REFUSED` | السبب (`GLOBAL_STOP_ACTIVE` / `SELF_RESUME_BLOCKED` / `FORBIDDEN`) |

السبب نصّ حر ≤300 حرف؛ لا أسرار، ولا DSN، ولا مفاتيح. `GET` لا يعيد `actorId` إلا لمن يملك القراءة الإدارية.

### 4.8 ما يتغيّر في الأسطح القائمة

- `getAiExecutionSwitchState()` تصبح **async** وتعيد `{enabled, source:'database'|'env'|'unavailable', global, agents}`.
- `GET/POST /api/admin/ai/kill-switch` يبقيان (توافق خلفي): `POST {enabled}` = إيقاف/استئناف شامل.
- مسارات جديدة: `GET /api/admin/ai/execution-switch`، `POST …/global`، `POST …/agents/:agentKey`.
- لوحة GM: عمود `killSwitch` يعرض `source` الجديد + عدّ الوكلاء الموقوفين (لا أرقام وهمية).
- `docs/AI_KILL_SWITCH.md §9` يُحدَّث من BLOCKED إلى منفّذ بعد الموافقة.

## 5. خطة الاختبارات (12 معيار قبول)

| # | الاختبار | الطريقة |
| --- | --- | --- |
| 1 | إيقاف وكيل في A يمنع B | عمليتان (`createApp` مستقلتان بنفس DB): إيقاف عبر A، ثم `createAgentTask` عبر B ⇒ 503؛ والوكيل الآخر يعمل. |
| 2 | الإيقاف الشامل يمنع الجميع | 20 وكيلاً + Copilot + Supervisor: الكل مرفوض. |
| 3 | Copilot لا يتجاوز | `plan`/`advance` ⇒ 503، ولا صف `agent_run_steps` جديد. |
| 4 | Supervisor لا يتجاوز | `runSupervisorCycle` ⇒ لا تدخّل، Audit رفض واحد. |
| 5 | فشل المصدر | إسقاط الجدول/إغلاق الاتصال داخل الاختبار ⇒ 503 `AI_CONTROL_UNAVAILABLE`، والحالة `UNAVAILABLE`. |
| 6 | استئناف فردي لا يتجاوز الشامل | استئناف الوكيل ⇒ 409، يبقى موقوفاً. |
| 7 | البقاء بعد restart | إعادة `createApp` + `resolveRateLimitStore` جديدة ⇒ الحالة من DB كما هي. |
| 8 | Audit | كل تغيير ⇒ صف `audit_logs` بالحقول المطلوبة؛ لا تغيير ⇒ لا صف. |
| 9 | مستخدم غير مخوّل | CUSTOMER/SUPPORT ⇒ 403. |
| 10 | مجهول | 401. |
| 11 | سباق | Promise.all: إيقاف + 20 إنشاء مهمة؛ كل مهمة أُنشئت بعد commit الإيقاف مرفوضة، والتي قبله تُلغى إن كانت queued. |
| 12 | لا تراجع | `a1-kill-switch`, `ai-core`, `phase14-agents`, `copilot-01`, `ai024-supervisor*`, `gm-dashboard-01`, `security-privacy`, `admin-access`, `secret-scan` + tsc + build. |

## 6. حدود صريحة (تُوثَّق ولا يُدّعى خلافها)

- خطوة تنفيذ **بدأت فعلاً** قبل الإيقاف تكمل حتى نهايتها؛ لا مقاطعة قسرية (لا يمكن إلغاء استدعاء مزوّد بأمان).
- إيقاف وكيل لا يوقف مهامه `awaiting_approval` القديمة — تُرفض عند محاولة الموافقة.
- Kill Switch لا يعوّض RBAC/الموافقات/الميزانية؛ يبقى طبقة إضافية فوقها.

## 7. المطلوب الآن (بوابة الموافقة)

الموافقة على **تغيير قاعدة البيانات الوحيد** الموصوف في §3 (جدول + صف تحكّم، إضافي بحت).
بعد الموافقة: تنفيذ الخدمة والمسارات والاختبارات أعلاه، ثم Commit ودفع فرع المهمة فقط.
قبل الموافقة: **لا migration، لا جدول، لا seed، ولا كود يعتمد عليه** — حتى لا تتحول الاختبارات
القائمة إلى فشل بـ«جدول غير موجود».

---

## 8. حالة التنفيذ (2026-11-26)

### 8.1 قاعدة البيانات — هوية مُثبَتة قبل أي تغيير

| فحص | النتيجة |
| --- | --- |
| الهدف | `wasit_test` على `127.0.0.1:5434` (مستخدم `wasit_test_runner`) |
| `current_database()` | `wasit_test` |
| `inet_server_addr()` / `inet_server_port()` | `127.0.0.1/32` / `5434` |
| قواعد أخرى على نفس العنقود | `pg_database` ⇒ **0** (`wasit_demo`/`wasit_prod`/`wasit_staging` غير موجودة) |
| مقارنة بـ`.env.demo` | هدف الديمو `wasit_demo` ⇒ **مختلف** عن هدف التنفيذ |

**ملف الـmigration:** `packages/server/src/db/migrations/0049_powerful_sandman.sql` — جدول
`ai_execution_switches` + 9 أعمدة + `pkey` + قيدا `CHECK` (نطاق + مفتاح الهدف) + فهرس فريد
`(scope, target_key)` + صف `GLOBAL` واحد (`ON CONFLICT DO NOTHING`). طُبِّق بـ`drizzle-kit migrate`
فقط على `wasit_test`؛ التحقق بعد التطبيق: الأعمدة/القيود/الفهرس/الصف موجودة، و`drizzle_migrations`
تسجّل `0049`.

**العودة للخلف:** `DROP TABLE ai_execution_switches` — إضافي بحت، لا فقد بيانات لأي جدول قائم.

### 8.2 الكود

| الملف | الدور |
| --- | --- |
| `src/db/schema/ai-execution-switch.ts` | تعريف Drizzle + `GLOBAL_TARGET_KEY='*'` |
| `src/lib/ai/execution-switch.ts` | المصدر الوحيد: `readExecutionSwitchState`, `isExecutionBlocked`, `assertExecutionAllowed`, `lockAndAssertExecutionAllowed`, `setGlobalSwitch`, `setAgentSwitch`, `getAiExecutionSwitchState`, `describeSwitchState` |
| `src/lib/ai/kill-switch.ts` | واجهة توافق فوق المصدر نفسه (`assertAiExecutionEnabled`, `isAiExecutionEnabled`, `setAiExecutionEnabled(db, …)`)، **لا ذاكرة محلية** |
| `src/modules/admin/ai-routes.ts` | `GET /api/admin/ai/execution-switch`، `POST …/execution-switch/global`، `POST …/execution-switch/agents/:agentKey` + توافق `GET/POST /kill-switch` |
| `src/modules/ai/agents.ts` | فحص + قفل `FOR SHARE` **داخل** معاملة إنشاء المهمة (المسارين المقيّد وغير المقيّد) وداخل معاملة اعتماد الموافقة |
| `packages/web/src/pages/AdminAiPage.tsx` + `types.ts` + `i18n.ts` | عرض المصدر `database`/`env`/`unavailable` + شارة `failClosed` + السبب + الوكلاء الموقوفون (ar/en/fr/zh) |

**قرارات تنفيذية تختلف عن §4 (موثّقة):**
1. **الاستئناف الذاتي مسموح ومُعلَّم**، لا مرفوض 409: نفس المشغّل الذي أوقف يمكنه الاستئناف (مفتاح
   أمان يجب أن يبقى قابلاً للتشغيل)، لكن الاستجابة/الـAudit تحمل `independentResume:false` بدل حجب
   الاستئناف. رفع الإيقاف الشامل يبقى **SUPER_ADMIN فقط**.
2. **فشل قراءة المصدر = 503 `AI_CONTROL_UNAVAILABLE`** (fail-closed) حتى في مسار القراءة الإدارية
   (`GET` يعيد `source:'unavailable'`, `failClosed:true`, `enabled:false` — لا يدّعي «مفتوح»).
3. **صف `GLOBAL` غائب = UNAVAILABLE**، لا «مفتوح»: حذف الصف ليس تجاوزاً.
4. **الـAudit:** المسارات الجديدة تكتب `AI.EXECUTION_STOPPED`/`AI.EXECUTION_RESUMED`
   (`entityType=AI_EXECUTION_SWITCH`)، والمسار القديم `/kill-switch` يحتفظ بالأسماء التاريخية
   `AI.KILL_SWITCH_DISABLED`/`AI.KILL_SWITCH_ENABLED` (`entityType=AI_KILL_SWITCH`) كي لا تنكسر
   استعلامات/تنبيهات قائمة. الرفض التلقائي يسجّل `AI.KILL_SWITCH_SCHEDULE_REFUSED` /
   `AI.KILL_SWITCH_SUPERVISOR_REFUSED` / `AI.KILL_SWITCH_RECOVERY_REFUSED` **مرة واحدة لكل دورة**،
   و«لا تغيير ⇒ لا صف» (`changed:false`).
5. **حزام البيئة:** `AI_AGENT_EXECUTION_ENABLED=false` يمنع ويجعل `source:'env'`؛ محاولة استئناف من
   الـDB تُرفض `409` (الحزام لا يُفتح من قاعدة البيانات).

### 8.3 الاختبارات

| الملف | الحالات |
| --- | --- |
| `tests/ai-killswitch-fleet-01.test.ts` | **11/11** — قبول كامل: نسختان (مجمّعان مختلفان + `createApp` مستقلان)، 20 وكيلاً، Copilot (plan/advance)، Supervisor، scheduler، recovery، tool-gateway، إلغاء `queued` وعدم إعادته، fail-closed بإعادة تسمية الجدول، 409 للاستئناف الفردي أثناء الشامل، البقاء بعد «restart» (مجمّع جديد)، Audit (who/what/why/version + لا صف عند عدم التغيير)، RBAC (401/403، ADMIN يوقف ولا يرفع)، سباق 20 إنشاءً متزامناً مع الإيقاف |
| `tests/a1-kill-switch-unit.test.ts` | **9/9** — إسقاط الحالة النقي (fail-closed عند غياب صف `GLOBAL`)، رفض المتجر غير القابل للقراءة، رسائل الرفض منفصلة وبلا أسرار |

**تعديل بنيوي لازم:** `vitest.config.ts` ⇒ `fileParallelism: false`. المفتاح أصبح قراراً
**على مستوى المنصة في قاعدة مشتركة**، فتشغيل الملفات بالتوازي كان يعني أن إيقاف ملف يرفض تنفيذ ملف
آخر. تسلسل الملفات يجعل كل قرار في القاعدة ملاحَظاً بشكل حتمي.

### 8.4 خارج النطاق (لم يُنفَّذ)

- لا تغيير في RBAC/الأدوار، ولا صلاحية جديدة.
- لا إلغاء قسري لخطوة تنفيذ بدأت (الحدّ في §6 قائم).
- لا `OBS-01` ولا أي مراقبة جديدة.

