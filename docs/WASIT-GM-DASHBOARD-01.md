# WASIT-GM-DASHBOARD-01 — مركز قيادة المدير العام

> **النوع:** سطح قراءة إداري (read-only command center) · **الفرع:** `wasit-gm-dashboard-01`
> **الواجهة:** `/admin/gm` · **الـAPI:** `/api/admin/gm/{overview,tasks,audit}`

## 1. الغرض

سطح واحد يقرأ ما تبنيه الوحدات القائمة (الوكلاء، الـCopilot، المشرف، الإنفاق، المزوّدون، الصحة،
التدقيق) ويعرضه للمدير العام. **لا يملك كتابة**: لا POST/PUT/PATCH/DELETE تحت `/api/admin/gm`،
وكل زر تنفيذي في الصفحة يستدعي المسار الذي يملك الفعل أصلاً (موافقة مهمة، اعتماد خطوة، إلغاء تشغيل).

## 2. العقد

| المسار | الاستعلام | الاستجابة |
| --- | --- | --- |
| `GET /api/admin/gm/overview` | `days=1..90` (افتراضي 30) | `generatedAt`, `environment`, `window`, `viewer`, `sections` |
| `GET /api/admin/gm/tasks` | `status`, `agentKey`, `kind`, `severity`, `from`, `to`, `page`, `pageSize≤100` | `items`, `totals`, `page`, `pageSize` |
| `GET /api/admin/gm/audit` | `action` (بادئة فقط)، `entityType`, `from`, `to`, `page`, `pageSize≤100` | `items`, `page`, `pageSize` |

كل قسم في `overview` يحمل `{state, source, generatedAt, data, error}`:

- `state='OK'` ⇒ `data` موجود.
- `state='UNAVAILABLE'` ⇒ `data=null` + رسالة قصيرة؛ القسم الفاشل لا يُفشل الطلب.
- القيم المجهولة `null` لا `0` (نجاح بلا تشغيل = `null`، لا «0%»).

## 3. الأقسام العشرة

`platform` (ملخص تنفيذي مشتق من الأقسام، لا استعلام ثانٍ) · `agents` · `copilot` · `supervisor`
· `tasks` · `approvals` · `providers` · `spending` · `health` · `audit`.

- **الوكلاء:** الاسم/المهمة/الفئة/المستوى من `agent_registry`، و`generation` من
  `AGENT_GENERATIVE_CAPABILITY` (مصدر واحد يثبته اختبار مقابل مواضع `draftFor`)، لا من مجرد وجود منفّذ.
  `noExecutorAgents` (مثل المشرف) منفصل عن `counts.declared`.
- **الموافقات:** `selfApprovalBlocked` و`independentApproverAvailable` و`state=BLOCKED_PENDING_INDEPENDENT_APPROVER`
  محسوبة من `user_roles`؛ والخادم يرفض موافقة الطالب على مهمته (`agents.ts`).
- **المزوّدون:** `maskProvider` (انتقل إلى `lib/ai/provider-config.ts` ليتشاركه مكتب AI والمركز) — الحالة
  والوجود فقط، بلا مفتاح أو سرّ.
- **الصحة:** فحوص حيّة (Postgres، مخزن الحدود، الكتالوج، المزوّدون، الوسائط، التنبيهات، المشرف، النسخ
  الاحتياطي). مخزن `memory` يُوصف `process-local, not shared` ولا يُدّعى أنه مشترك.

## 4. الصلاحيات

`requireAuth` + `requirePermission(AI_MANAGE, ADMIN_AI)` على كل المسارات — نفس بوابة مكتب حوكمة الذكاء،
بلا دور أو صلاحية جديدة. الواجهة تُخفي الصفحة عن غير الإداري (`AdminOnly`) لكن القرار في الخادم.

## 5. الحدود المعروفة

- Kill Switch في العملية الواحدة (غير مشترك بين النسخ) — يُعرض مع `source` (`runtime`/`env`).
- لا مصدر دليل في المخطط لقياس «أثر توصية نُفّذت» ⇒ العمود يبقى صفراً صريحاً لا مُستنتجاً.
- `backup` = `UNKNOWN` إن لم يُضبط heartbeat في النشر.

## 6. التغطية

`packages/server/tests/gm-dashboard-01.test.ts` — 17 اختباراً: الوصول (401/403/ADMIN/SUPER_ADMIN)،
عقد الأقسام، تصنيف التوليد، `null` مقابل `0`، منع تسريب الأسرار، فشل قسم معزول، الموافقات ومنع
الموافقة الذاتية، فلاتر/ترقيم المهام والتدقيق، غياب أي مسار كتابة، تغطية حدّ المعدل، وعدم تغيّر الحالة
عند القراءة، وصدق وصف مخزن الحدود.
