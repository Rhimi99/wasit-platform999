# AI-02.P0 — حاسمو ما قبل Supervisor (Blockers)

**النوع:** تنفيذ + تحقّق + إغلاق توثيقي. لا commit/push، ولا بدء AI-02.1/Supervisor/Tool Gateway.
**التاريخ:** 2026-11-06 · **الفرع:** `master` · **HEAD:** `e43dee4017d2848e37d03d13025a33890adb483f` (لم يتغيّر).

## 1. النطاق

إغلاق ثلاث تبعيات حرجة كشفتها جولة الجرد (AI-02 التصميمي) قبل بناء `Agent Supervisor`:

1. **حسم تضارب `actorType`** في سجل `AI.AGENT_TASK_SCHEDULED` (AI-01).
2. **منع الموافقة الذاتية** في `decideAgentTask` (Backend).
3. **حسم عدد الوكلاء** وربط كل وكيل بمنفّذ فعلي.

## 2. حسم تضارب `actorType` (AI-01)

**الفحص:** الكود الفعلي `modules/ai/scheduling.ts` (`runClaimedSchedule`) + الاختبار `ai01-agent-scheduling.test.ts` + الوثائق.

**النتيجة:** لا تضارب — التنفيذ الحالي صحيح ومتّسق:

| الحقل | القيمة الفعلية | الدليل |
| --- | --- | --- |
| `actorType` لسجل `AI.AGENT_TASK_SCHEDULED` | `SYSTEM` | `scheduling.ts:315` (`systemAudit = { actorId: null, actorType: 'SYSTEM' }`) |
| `actorId` | `null` (لا هوية أدمن مزيفة) | `writeAudit` يكتب `actorId ?? null` |
| منشئ الجدولة | `metadata.createdBy` | `scheduling.ts:385` |
| ربط التشغيل بالجدولة | `metadata.scheduleId` | `scheduling.ts:385` |
| ملكية المهمة (مساءلة) | `agent_tasks.requested_by = createdBy` | `createAgentTask(... requestedBy: schedule.createdBy ...)` |

**الفصل الثلاثي محفوظ:** منشئ الجدولة (`createdBy`) ≠ منفّذ المهمة المجدولة (`requestedBy`) ≠ هوية النظام (`actorType=SYSTEM`, `actorId=null`).

**الإجراء:** لا تغيير كود. الاختبار موجود ويؤكّد `actorType=SYSTEM` و`actorId=null` و`metadata.scheduleId`. الوثائق (`AI-01_AGENT_SCHEDULING.md`, `AGENTS.md`, `GAP_REGISTER.md`) متّسقة مع الكود.

## 3. منع الموافقة الذاتية (Separation of Duties)

**الثغرة:** `decideAgentTask` لم يكن يمنع منشئ المهمة من اعتماد طلبه بنفسه — حتى `SUPER_ADMIN`.

**الإصلاح (Backend فقط):** في `packages/server/src/modules/ai/agents.ts` أُضيف حارس داخل `decideAgentTask` — الخدمة الوحيدة التي يستدعيها كلا المسارين (`/approve`, `/reject`):

```ts
if (decision === 'APPROVE' && task.requestedBy === approverId) {
  throw ApiError.forbidden('You cannot approve your own agent task; another authorised approver must decide');
}
```

- **الحارس في الخدمة لا في الواجهة**، فيرثه أي سطح موافقة مستقبلي.
- **يشمل SUPER_ADMIN:** امتلاك كل الصلاحيات لا يجيز اعتماد الطلب الشخصي.
- **الرفض واضح:** `403 FORBIDDEN` مع رسالة صريحة.
- **سحب الطلب (REJECT) من طالبه مسموح:** ليس تضارب مصالح — يزيل عملًا لا يؤذن بإجراء حساس.

## 4. جرد الوكلاء الفعلي

**مصدر التسجيل الوحيد:** `AGENT_CATALOGUE` في `modules/ai/agents.ts` → `ensureAgentRegistrySeeded` → جدول `agent_registry`. لا مصدر آخر (`grep insert(agentRegistry)` = موقع واحد). المنفّذات: `modules/ai/executors.ts` — 11 حالة `switch` = 11 مدخل كتالوج.

| # | agentKey | الاسم | الوظيفة | التسجيل | Executor | الصلاحيات | مقيّد بموافقة | قابل للتنفيذ؟ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `sales-agent` | Sales Agent | تحديد المشترين/العملاء المحتملين | ✅ | ✅ | `ai:use` | نعم | ✅ |
| 2 | `marketing-agent` | Marketing Agent | توصية زوايا/قنوات تسويقية | ✅ | ✅ | `ai:use` | لا | ✅ |
| 3 | `ads-agent` | Ads Agent | توزيع ميزانية الإعلان | ✅ | ✅ | `ai:use`, `ad:create` | نعم | ✅ |
| 4 | `product-agent` | Product Agent | تحليل إدراج المنتج/السعر/الاكتمال | ✅ | ✅ | `ai:use` | لا | ✅ |
| 5 | `support-agent` | Support Agent | صياغة رد دعم | ✅ | ✅ | `ai:use` | لا | ✅ |
| 6 | `analytics-agent` | Analytics Agent | حساب مؤشرات KPI | ✅ | ✅ | `ai:use`, `analytics:read:own` | لا | ✅ |
| 7 | `market-research-agent` | Market Research Agent | نظرة سوق/فئة | ✅ | ✅ | `ai:use` | لا | ✅ |
| 8 | `b2b-agent` | B2B Agent | مطابقة مشترين↔موردين | ✅ | ✅ | `ai:use` | نعم | ✅ |
| 9 | `risk-agent` | Risk Agent | تقييم مؤشرات خطر | ✅ | ✅ | `risk:read` | نعم | ✅ |
| 10 | `dispute-assistant` | Dispute Assistant | تلخيص سياق نزاع | ✅ | ✅ | `dispute:read` | نعم | ✅ |
| 11 | `development-agent` | Development Agent | خطة تقنية | ✅ | ✅ | `ai:use` | نعم | ✅ |

**الخلاصة:** 11 وكيلاً — كلها مسجّلة ولها منفّذ حقيقي (يقرأ PostgreSQL، لا mock). لا وكيل «تعريف بلا تنفيذ». لم يُغيَّر الترتيب ولم يُنشأ وكيل جديد.

## 5. الاختبارات

**جديد:** `packages/server/tests/ai02p0-approval-guard.test.ts` — **5/5**:

| الحالة | النوع | النتيجة |
| --- | --- | --- |
| رفض اعتماد الطالب لطلبه (403) + عدم التنفيذ | سلبي | ✅ |
| رفض اعتماد SUPER_ADMIN لطلبه (403) | سلبي | ✅ |
| اعتماد مُعتمِد مخوّل آخر (200 + `approvedBy`) | إيجابي | ✅ |
| المهمة المرفوضة لا تُنفَّذ + تدقيق `AI.AGENT_TASK_REJECTED` وبلا `COMPLETED` | سلبي | ✅ |
| سحب الطالب لطلبه (REJECT) مسموح | إيجابي | ✅ |

**تعديل اختبار:** `phase14-agents.test.ts` — المساعد `runAndComplete` كان يعتمد الطلب بنفس طالبِه؛ صار يستخدم `SUPER_ADMIN` آخر (متوافق مع قاعدة الفصل الجديدة). لا تغيير في توقّعات الحالات.

**النتائج:**

| الحزمة | النتيجة |
| --- | --- |
| `ai02p0-approval-guard.test.ts` | **5/5** |
| `phase14-agents` + `admin-ai` + `ai-core` + `ai01-agent-scheduling` | **61/61** |
| الحزمة الكاملة للخادم | **904/904** (78 ملفاً) — الأساس كان 899/77، +5 حالات و+1 ملف |
| Typecheck (server+web) | نظيف |

**البيئة:** PostgreSQL 16 معزول (`wasit-ai02p0-pg`، `wasit_test` فقط) عبر `sudo dockerd`. الحاوية حُذفت والمنفذ 5432 حُرِّر وDocker أُعيد إلى حالته السابقة (متوقف).

## 6. التبعيات المتبقية (لم تُغلق — خارج نطاق AI-02.P0)

- جدولا `agent_runs`/`agent_run_steps` (نموذج التشغيل المركّب) — AI-02.1.
- Tool Gateway موحّد — مؤجّل.
- سياسة إعادة المحاولة/قاطع الدائرة — AI-02.6.
- Kill Switch + مراقبة التنسيق — AI-02.10.
- تثبيت ترتيب الوكلاء الرسمي — AI-05.

## 7. ما لم يُنفَّذ

لم يُبدأ AI-02.1 ولا Tool Gateway ولا Supervisor. لا commit/push/stage. لا تغيير في أي فجوة أخرى.
