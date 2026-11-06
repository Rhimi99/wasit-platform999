# AI-01 — جدولة تنفيذ الوكلاء (Agent Scheduling)

> الحالة: **COMPLETED** · التاريخ: 2026-11-06 · النطاق: تشغيل دوري حقيقي + تدقيق + حدود ميزانية.

## 1. المشكلة

كانت الوكلاء تعمل بنمط **طلب-استجابة فقط**: مهمة تُنشأ عبر `POST /api/ai/agents/:key/tasks` أو `/api/ai/run` ثم تنتهي. لا يوجد أي مفهوم للتنفيذ الدوري/المستقل. المطلوب تحويل ذلك إلى نظام **مجدول، آمن، مراقَب، قابل للتدقيق** — وليس مجرّد `setInterval` ينادي الوكلاء مباشرة.

## 2. البنية

| الطبقة | الملف | الدور |
| --- | --- | --- |
| المخطّط | `packages/server/src/db/schema/agent_schedules.ts` | جدول `agent_schedules` (جدولة دائمة في القاعدة، لا في الذاكرة) |
| الترحيل | `packages/server/src/db/migrations/0027_melodic_lifeguard.sql` | إنشاء الجدول + `audit_logs.actor_type` |
| الخدمة | `packages/server/src/modules/ai/scheduling.ts` | إنشاء/تحديث/حذف الجدولة + المطالبة الذرّية + التنفيذ |
| المؤقّت | `packages/server/src/lib/scheduler.ts` | وظيفة `runAgentSchedules` (مُطفأة افتراضياً) |
| الإدارة | `packages/server/src/modules/admin/ai-routes.ts` | مسارات `/api/admin/ai/agent-schedules` |
| الهوية | `packages/server/src/lib/audit.ts` + `db/schema/audit.ts` | `actorType: USER \| SYSTEM` |

### جدول `agent_schedules`

`id`, `agent_key`, `input` (jsonb), `interval_minutes`, `is_active`, `next_run_at`, `last_run_at`, `lease_owner`, `lease_expires_at`, `last_task_id`, `created_by`, `created_at`, `updated_at`. فهارس: `(is_active, next_run_at)`, `(agent_key)`, `(created_by)`.

## 3. الضمانات الأمنية والتشغيلية

### 3.1 تنفيذ واحد فقط عبر النسخ (atomic lease claim)
المطالبة استعلام واحد:

```sql
update agent_schedules
set lease_owner = $worker, lease_expires_at = now() + ($lease * interval '1 second'),
    last_run_at = now(), next_run_at = now() + (interval_minutes * interval '1 minute')
where id = (
  select id from agent_schedules
  where is_active = true and next_run_at <= now()
    and (lease_expires_at is null or lease_expires_at < now())
  order by next_run_at asc limit 1
  for update skip locked
) returning …;
```

`FOR UPDATE SKIP LOCKED` يجعل نسختين تعملان في اللحظة نفسها تتجنّبان الصف نفسه: واحدة تفوز والأخرى تتخطّى. حارس `agentRunInFlight` في العملية يمنع التداخل **داخل** النسخة فقط؛ الأمان عبر النسخ يأتي من القاعدة.

### 3.2 سياسة التفويت (skip, never backfill)
عند المطالبة يُقدَّم `next_run_at` فوراً. إن تأخّرت العملية، يُفوَّت الفائت ولا يُبنى رصيد تراكمي لا نهائي.

### 3.3 الموافقة fail-closed
- **عند الإنشاء:** وكيل بـ`requiresHumanApproval` → `409`. الجدولة **ليست** موافقة مسبقة.
- **وقت التشغيل:** لو صار الوكيل مقيّداً بعد إنشاء الجدولة → يُتخطّى ويُدقّق `AI.AGENT_TASK_SKIPPED_APPROVAL_REQUIRED` (لا تنفيذ تلقائي أبداً).
- **التفعيل من جديد:** لا يُسمح بتفعيل جدولة لوكيل مقيّد.

### 3.4 حدود الميزانية
بوابة **قبل** إنشاء المهمة (`isBudgetExhausted`) تُرجع `429` عند نفاد ميزانية المنشئ، وتُدقّق `AI.AGENT_TASK_BUDGET_EXCEEDED`. لا استدعاء مزوّد مدفوع بعد نفاد الميزانية. الفحص لكل استدعاء في `runtime.ts` يبقى المرجع النهائي.

### 3.5 الهوية والتدقيق
`audit_logs.actor_type` جديد (`USER` افتراضياً، `SYSTEM` للتنفيذ الآلي). المهمة تُنسب إلى **منشئ الجدولة** (مساءلة)، بينما سجلّ التنفيذ `SYSTEM` بلا `actorId` مزيف.

أحداث التدقيق: `AI.AGENT_SCHEDULE_CREATED`, `AI.AGENT_SCHEDULE_UPDATED`, `AI.AGENT_SCHEDULE_DISABLED`, `AI.AGENT_TASK_SCHEDULED`, `AI.AGENT_TASK_SKIPPED_APPROVAL_REQUIRED`, `AI.AGENT_TASK_SKIPPED_UNKNOWN_AGENT`, `AI.AGENT_TASK_SKIPPED_FORBIDDEN`, `AI.AGENT_TASK_BUDGET_EXCEEDED`, `AI.AGENT_TASK_FAILED`.

### 3.6 إعادة استخدام خط الأنابيب
لا مسار تنفيذ موازٍ: التنفيذ ينادي `createAgentTask` نفسه (RBAC + ميزانية + تدقيق).

## 4. الإعداد (env)

| المتغيّر | الافتراضي | المعنى |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `false` | يُشغّل المؤقّت كاملاً |
| `AI_AGENT_SCHEDULER_ENABLED` | `false` | يُفعّل مسح الجدولة (مُطفأ افتراضياً) |
| `AI_AGENT_SCHEDULER_INTERVAL_MINUTES` | `5` | وتيرة المسح |
| `AI_AGENT_SCHEDULE_MIN_INTERVAL_MINUTES` | `15` | أصغر وتيرة مسموحة للجدولة |
| `AI_AGENT_SCHEDULE_LEASE_SECONDS` | `300` | مدّة العقد قبل إمكانية الاستعادة |

## 5. واجهة الإدارة

| المسار | الوصف |
| --- | --- |
| `GET /api/admin/ai/agent-schedules` | القائمة + `minIntervalMinutes` |
| `POST /api/admin/ai/agent-schedules` | إنشاء (زود: agentKey, intervalMinutes, input) |
| `GET /api/admin/ai/agent-schedules/:id` | تفاصيل |
| `PATCH /api/admin/ai/agent-schedules/:id` | تعديل (intervalMinutes/isActive/input) |
| `DELETE /api/admin/ai/agent-schedules/:id` | حذف |

كلها محروسة بـ`AI_MANAGE | ADMIN_AI` (نفس بوّابة لوحة AI الإدارية).

## 6. التحقّق

- **الاختبارات:** `packages/server/tests/ai01-agent-scheduling.test.ts` — **12/12** (يشمل سباق مطالبة حقيقي بنسختين، حجب عقد حيّ، استعادة عقد منتهٍ، بوابة ميزانية، بوّابة موافقة، تدقيق `SYSTEM`, RBAC).
- **الحزمة الكاملة:** **899/899** (77 ملفاً).
- **التحقّق الحيّ:** PostgreSQL 16 معزول (`wasit-ai01-pg`) + نسختان (`:3005`/`:3006`) بجدولة دقيقة واحدة، ثم فرض `next_run_at` في الماضي → `claimed=1` لنسخة و`claimed=0` للأخرى؛ سجلّ `AI.AGENT_TASK_SCHEDULED` بـ`actor_type=SYSTEM`؛ ومهمة `succeeded` منسوبة للمنشئ. أُثبت أيضاً رفض 409 (وكيل مقيّد)، 422 (وتيرة قصيرة)، 401 (زائر)، والتخطّي وقت التشغيل (`AI.AGENT_TASK_SKIPPED_APPROVAL_REQUIRED`)، وحجب الميزانية (`AI.AGENT_TASK_BUDGET_EXCEEDED`). الحاوية حُذفت وأُعيد Docker إلى حالته السابقة (متوقف).

## 7. خارج النطاق (متابعات)

- **AI-02** (Agent Supervisor) و**AI-03** (توجيه النزاعات/الدعم تلقائياً) يعتمدان على AI-01 كأساس جدولة.
- لا واجهة مستخدم (UI) للجدولة في هذه المهمة — سطح API فقط. أي سطح واجهة لاحق يُبنى فوق نفس المسارات.
