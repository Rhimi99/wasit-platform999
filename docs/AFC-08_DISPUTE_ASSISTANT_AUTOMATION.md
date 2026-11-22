# AFC-08 — أتمتة مساعد النزاعات (AI-03)

> **التاريخ**: 2026-11-22 · **الفرع**: `afc-08` (من `afc-06` @ `ebcd687`) · **النطاق**: ربط فتح النزاع وتعيين المراجع بمهمة `dispute-assistant` تلقائية.
> **الحالة**: مكتمل ومُثبَت. لا Migration، لا Seed، لا صلاحية RBAC جديدة، لا قرار آلي.

## 1. الفجوة التي تُغلق

`AI-03` في `GAP_REGISTER`: «توجيه النزاعات تلقائياً إلى Agent غير موصول بطابور؛ `dispute-assistant` تشغيله يدوي».

الواقع قبل AFC-08:

| المرحلة | السلوك |
| --- | --- |
| فتح نزاع | لا شيء — لا طلب ولا مهمة. |
| تعيين مراجع | `disputes.assigned_to_id` يُحدَّث + إشعار + Audit + حدث. لا مهمة وكيل. |
| تشغيل المساعد | يدويًا عبر `POST /api/ai/agents/dispute-assistant/tasks` من المراجع نفسه. |

القيد البنيوي الذي منع الحل «الساذج»: `agent_tasks.requested_by` غير قابل للـNULL، وكل تنفيذ يُحتسب على نطاق مالكه (ميزانية، حدود، تدقيق، A2). لا يوجد مستخدم نظام، واختراع واحد يخلق مالكًا وهميًا.

## 2. القرار (AD-055)

| السؤال | القرار | السبب |
| --- | --- | --- |
| هل تُنشأ مهمة عند الفتح؟ | **لا** — طلب مُدقّق فقط (`PENDING_NO_REVIEWER`) | لا مراجع بعد؛ المالك لا يمكن اختياره بصدق. |
| من يملك المهمة؟ | **المراجع المعيَّن** | هو من سيستخدم الملخّص؛ التكلفة والحدود والتدقيق تُنسب إلى نطاقه الحقيقي. |
| متى تُنشأ؟ | عند تعيين مراجع **مؤهّل** | الأهلية تُقرأ من متطلبات الوكيل المعلنة، لا من ثقة ضمنية. |
| من يوافق؟ | مسؤول آخر (`AI_MANAGE`) | فصل المهام كما في AI-02.P0 — الوكيل يبقى `requiresHumanApproval`. |
| عند إعادة الإسناد؟ | دورة جديدة + إلغاء مهام الدورة السابقة | لا يجوز أن تُنفَّذ مهمة بصلاحيات مراجع سابق. |

## 3. التنفيذ

| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/disputes/assistant.ts` (جديد) | `readDisputeAssistant` (قراءة فقط) و`requestDisputeAssistant` (طلب/إنشاء/إلغاء مهام قديمة/تدقيق/احتواء الفشل)، `assignmentCycleOf`، `disputeAssistDedupeKey`، `qualifyReviewer`. |
| `packages/server/src/modules/disputes/service.ts` | `createDispute` يسجّل الطلب بعد `DISPUTE.CREATED`؛ `assignDispute` صار يستقبل سياق الطلب ويعيد `aiAssistant` وينشئ المهمة قبل الإشعار (الذي يحمل `taskId`). |
| `packages/server/src/modules/ai/agents.ts` | `AgentTaskOrigin` (`dedupeKey`/`triggeredBy`/`disputeLink`) + إسقاط كل مفاتيح `__dispute*` من `input` الطالب ثم حقن الرابط الموثوق + كتابة `dedupe_key`/`triggered_by`. |
| `packages/server/src/modules/ai/executors.ts` | حارس `__disputeSource === 'ASSIGNMENT'`: المالك من `getAgentRunContext().requestedBy`؛ إن لم يعد النزاع مُسندًا له ⇒ `409` والمهمة `failed`. |
| `packages/server/src/modules/admin/engines-routes.ts` | `GET /api/admin/disputes/:id/assistant` و`POST .../assistant/retry` (ADMIN/SUPER_ADMIN). |
| `packages/web/src/lib/{types,api}.ts` + `pages/AdminEnginesPages.tsx` + `lib/i18n.ts` | بطاقة «مساعد النزاعات» في تفاصيل النزاع: الحالة، المراجع وأهليته، حالة المهمة، التوصية والثغرات، عدد المهام المُلغاة، زر إعادة المحاولة — بمفاتيح ar/en/fr/zh. |

### دورة التعيين ومنع التكرار

```
cycle = `${assignedToId}@${assignedAt.getTime()}`
dedupe_key = `dispute-assist:${disputeId}:${cycle}`
```

- كل إسناد يكتب `assigned_at`، فتكرار الحدث لنفس الإسناد يعطي نفس الدورة، وإعادة الإسناد (حتى لنفس الشخص) تعطي دورة جديدة.
- قبل الإدراج: فحص وجود المهمة في الدورة بأي حالة + قفل صف النزاع `FOR UPDATE`، ثم `createAgentTask` (فهرس `agent_tasks_dedupe_open_uidx` على `(requested_by, dedupe_key)` هو الخط الأخير).

### الأهلية

| الشرط | مصدره | عند الفشل |
| --- | --- | --- |
| `ADMIN`/`SUPER_ADMIN` | `requiresPlatformScope` في الكتالوج | `REVIEWER_NOT_PLATFORM_SCOPE` |
| `dispute:read` | `permissionsRequired` في الكتالوج | `REVIEWER_MISSING_DISPUTE_READ` |
| حساب نشط | `users.is_active` | `REVIEWER_INACTIVE` |

لا شيء من هذا يمنح صلاحية: المهمة تُنشأ بصلاحيات المراجع المخزَّنة، وتُنفَّذ بعد موافقة مسؤول آخر.

### التدقيق

`DISPUTE.AI_ASSIST_REQUESTED` · `AI_ASSIST_BLOCKED` · `AI_ASSIST_TASK_CREATED` · `AI_ASSIST_SUPERSEDED` · `AI_ASSIST_SKIPPED` · `AI_ASSIST_FAILED` · `AI_ASSIST_RETRY_NOOP`.

الإنشاء يُسجَّل بهوية `SYSTEM` (المنصّة أنشأت المهمة) مع `metadata.triggeredBy` = المستخدم الذي فعّل الحدث؛ إعادة المحاولة اليدوية تُسجَّل بهوية المستخدم.

## 4. الإثبات

`packages/server/tests/afc08-dispute-assistant-automation.test.ts` — 12 حالة:

| # | الحالة |
| --- | --- |
| 1 | فتح نزاع ⇒ صفر مهام + `AI_ASSIST_REQUESTED/PENDING_NO_REVIEWER` |
| 2 | تعيين مراجع مؤهّل ⇒ مهمة واحدة مملوكة له، `awaiting_approval`، دورة + dedupe صحيحان |
| 3 | طلبات مكررة/متزامنة ⇒ مهمة واحدة |
| 4 | تعيين SUPPORT ⇒ لا مهمة + `AI_ASSIST_BLOCKED` |
| 5 | تعطيل AI ⇒ التعيين ينجح والمهمة `TASK_FAILED`؛ التمكين + إعادة المحاولة ⇒ `TASK_CREATED`؛ تكرارها ⇒ `TASK_EXISTS` |
| 6 | إعادة الإسناد ⇒ إلغاء المهمة السابقة + دورة جديدة |
| 7 | تنفيذ مهمة بعد تغيير المراجع ⇒ `failed` بسبب «no longer assigned» |
| 8 | نزاعان ⇒ مهمتان وملخّصان مختلفان |
| 9 | نزاع مغلق ⇒ `CLOSED_CASE` بلا مهمة |
| 10 | CUSTOMER/SUPPORT/DISPUTE مرفوضون على المسارين (403) وADMIN يقرأ ويعيد المحاولة (200) |
| 11 | طلب يدوي بمفاتيح `__dispute*`/`requestedBy` مزوّرة ⇒ المالك هو الطالب والمفاتيح مُسقَطة |
| 12 | طلب يدوي لا يُشبع الأتمتة لنزاع آخر |

## 5. ما لم يتغيّر

- **لا Migration/Seed**: كل الأعمدة موجودة (`dedupe_key`, `triggered_by`, `assigned_at`).
- **لا صلاحية جديدة**: `ROLE_PERMISSIONS` كما هي؛ المساران الإداريان يستخدمان `requireRole('ADMIN','SUPER_ADMIN')`.
- **لا كتابة من الوكيل**: التنفيذ يقرأ فقط، `decisionAuthority: 'HUMAN'` كما في AD-054.
- **لا أثر مالي**: لا قرار ولا استرداد ولا تغيير حالة نزاع.
- **Demo**: لم تُلمس قاعدة `wasit_demo` ولا سكربتات العرض.
