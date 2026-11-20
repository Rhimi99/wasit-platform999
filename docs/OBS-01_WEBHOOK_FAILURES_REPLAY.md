# OBS-01 — WEBHOOK FAILURES & REPLAY (OPERATOR DESK)

تاريخ: 2026-11-06 · الحالة: **VERIFIED LIVE — COMPLETED** (PostgreSQL 16 معزول `wasit_test`) · لا Commit/Push

مرجع: `docs/GAP_REGISTER.md` §2 (OBS-01، P0/MEDIUM) · `docs/FULL_PROJECT_COVERAGE_AUDIT.md` §5.2 (webhooks/إدارة فشل) · `docs/PILOT_EXECUTION_PLAN.md` §8 (Replay مُدقَّق).

---

## 1. ملخّص

كان مسارا `GET /api/payments/webhook-failures` و`POST /api/payments/webhook-failures/:id/replay`
موجودين ومحروسين بـ`REFUND_MANAGE` (ADMIN/SUPER_ADMIN)، لكن **بلا أي سطح إداري**: لا تبويب يعرض
الأحداث الفاشلة، ولا زر لإعادة تشغيلها، ولا توثيق مشغّل. النتيجة: حدث webhook عالق (`DEAD_LETTERED`)
كان **غير مرئي** للمشغّل عملياً — الـAPI موجود لكن لا أحد يصل إليه.

أُضيف **مكتب فشل الـWebhooks** كتبويب `webhooks` داخل `/admin/observability`، يعرض الأحداث
`FAILED`/`DEAD_LETTERED` ويتيح إعادة تشغيل المعلّقة منها، مع تدقيق كامل لهوية المشغّل.

> **إعادة التشغيل ≠ تحرّك مال.** الإجراء يعيد الحدث إلى `RECEIVED` ويصفّر عدّاد المحاولات، فيُعاد
> المحاولة عند **التسليم التالي من المزوّد** — لا يُطبَّق الأثر المالي فوراً، ولا يُكتب `SETTLED`، ولا
> يُنشأ `Payout`. الرسالة في الواجهة تقول ذلك صراحةً.

**قرار الموضع:** تبويب إضافي داخل صفحة Observability القائمة بدل صفحة منفصلة. السبب: (أ) الصفحة
محروسة أصلاً بـ`AdminOnly` (ADMIN/SUPER_ADMIN) وهو نفس نطاق `REFUND_MANAGE` — مطابقة تامة بين
الواجهة والخادم؛ (ب) إضافة تبويب **إضافية بحتة** لا تتراجع عن أي عمل سابق؛ (ج) أقرب موضع دلالياً
للفشل والتنبيهات (التبويب `alerts` موجود في الصفحة نفسها).

## 2. مبدأ التصميم — «الفشل مرئي، والإجراء محكوم»

- **لا إخفاء للفشل:** كل حدث `FAILED`/`DEAD_LETTERED` يظهر بمعرّفه ومزوّده ونوعه وعدّاد محاولاته وآخر
  خطأ. «لا مهام صامتة».
- **لا تسريب بيانات:** القائمة تُسقِط `payload` والتوقيع — تُعرض حقول التحديد فقط.
- **إعادة التشغيل محصورة:** الزر مفعّل **فقط** لـ`DEAD_LETTERED`؛ حدث `FAILED` تحت السقف يُعاد
  تلقائياً فلا معنى لإعادته يدوياً.
- **تدقيق بالهوية:** كل إعادة تشغيل تكتب `PAYMENT.WEBHOOK_REPLAY` بـ`actorId` الحقيقي (كانت تُكتب
  `NULL` — انظر §6).
- **تأكيد قبل الفعل:** `window.confirm` قبل الإرسال؛ رفضه لا يُرسل أي طلب.
- **لا نجاح قبل الخادم:** الواجهة تعيد قراءة القائمة بعد الإجراء، فتُعرض الحالة لأن الخادم قال ذلك.
- **حماية الإدخال:** `offset` يُمرَّر عبر `parseNonNegativeIntParam` فلا يصل `NaN`/`Infinity` إلى SQL.

## 3. الملفات المعدّلة والجديدة

### جديدة (1)
| الملف | الغرض |
| --- | --- |
| `e2e/admin-webhook-failures.spec.ts` | E2E من الواجهة الحقيقية: 4 حالات |

### معدّلة (7)
| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/payments/routes.ts` | `GET /webhook-failures` يعيد `{ items, meta:{total,limit,offset} }`؛ `POST /:id/replay` يمرّر هوية المشغّل إلى `writeAudit` |
| `packages/server/src/modules/payments/service.ts` | `listWebhookFailures` يدعم `offset` ويعيد `{ items, total }` |
| `packages/server/src/lib/query.ts` | `parseNonNegativeIntParam` (offset ≥ 0، منع `NaN`/`Infinity`) |
| `packages/web/src/lib/api.ts` | `adminWebhookFailures({limit,offset})` + `adminReplayWebhookFailure(id)` |
| `packages/web/src/lib/types.ts` | `WebhookFailureRow` + `WebhookFailuresResponse` |
| `packages/web/src/lib/i18n.ts` | 15 مفتاح `adminObs.webhook.*`/`adminObs.tab.webhooks` في ar/fr/en/zh |
| `packages/web/src/pages/AdminObservabilityPage.tsx` | تبويب `webhooks` + جدول + ترقيم + تأكيد قبل الفعل |
| `packages/server/tests/p6-p7-dispute-webhook.test.ts` | 9 حالات OBS-01 جديدة (10 → 19) |

> لم تُمسّ أي صلاحية أو مصفوفة أدوار أو نموذج العمولة 4%. لا تغيير في منطق التسوية/الدفعات/الاسترداد.

## 4. المسارات (تحت `/api/payments`)

| الإجراء | المسار | الطريقة | الصلاحية |
| --- | --- | --- | --- |
| قائمة الأحداث الفاشلة | `/webhook-failures?limit=&offset=` | GET | `REFUND_MANAGE` (ADMIN/SUPER_ADMIN) |
| إعادة تشغيل حدث | `/webhook-failures/:id/replay` | POST | `REFUND_MANAGE` (ADMIN/SUPER_ADMIN) |

استجابة القائمة: `{ success:true, data:{ items:[…], meta:{ total, limit, offset } } }`.
`limit` افتراضياً 50 وسقفه 200؛ `offset` غير الصالح (سالب/كسر/نص/`Infinity`) يعود إلى 0.

## 5. عقد إعادة التشغيل

`POST /api/payments/webhook-failures/:id/replay`

| الحالة | الاستجابة |
| --- | --- |
| نجاح (الحدث `DEAD_LETTERED`) | 200 `{ replayed:true }` — الحدث → `RECEIVED`، `attempts=0` |
| الحدث ليس `DEAD_LETTERED` (مثلاً `FAILED`/`RECEIVED`) | 404 `NOT_FOUND` |
| لا يوجد حدث | 404 `NOT_FOUND` |
| إعادتان متزامنتان لنفس الحدث | واحدة 200 وواحدة 404 (انتقال ذرّي واحد) |
| غير مصرّح | 401 (زائر) / 403 (غير ADMIN/SUPER_ADMIN) |

الأثر: `paymentWebhookEvents.status=RECEIVED`، `attempts=0`، Audit `PAYMENT.WEBHOOK_REPLAY` يحمل
`actorId` + `ipAddress` + `userAgent`. **لا** أثر على الدفتر/التسوية/الدفعات.

## 6. إصلاح عيب التدقيق (actorId = NULL)

`AppContext` لا يحمل حقل `actorId`، وكانت بعض المسارات — ومنها إعادة التشغيل — تستدعي
`writeAudit(ctx.db, ctx, …)` فتُمرِّر الكائن `ctx` كسياق تدقيق، فيُكتب `actorId = NULL`: أي أن
السجل يقول «حدث تغيير» بلا فاعل. أُصلح المسار ليمرّر صراحةً
`{ actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }`، وأُضيف اختبار
يقرأ صف التدقيق ويؤكّد `actorId` = هوية المشغّل (لا `NULL`).

> ملاحظة نطاق: العيب نفسه قد يوجد في مسارات أخرى (`admin/analytics-routes.ts` مثلاً) — لم تُمسّ في
> هذه المهمة حفاظاً على النطاق؛ تُسجَّل كمرشّح لمهمة تدقيق لاحقة.

## 7. الاختبارات

| الحزمة | الملف | الحالات | حالة التشغيل (تحقّق حيّ) |
| --- | --- | --- | --- |
| Backend (DB) | `p6-p7-dispute-webhook.test.ts` | 19 (منها 9 جديدة) | ✅ **19/19 ناجحة** (PostgreSQL 16 معزول) |
| Backend (كامل) | الحزمة الكاملة | 887 (76 ملف) | ✅ **887/887 ناجحة** (بلا تراجع) |
| E2E (المكتب) | `admin-webhook-failures.spec.ts` | 4 | ✅ **4/4 ناجحة** |
| E2E (كامل) | الحزمة الكاملة | 234 | ✅ **226 ناجحة / 8 متخطّاة** (الإخفاقات الثمانية شرطية `DEMO_AUTO_LOGIN`، سابقة لا علاقة لها) |

الحالات التسع الجديدة تغطّي: هوية التدقيق (لا NULL) + `ipAddress`/`userAgent`، رفض إعادة تشغيل
`FAILED` (404)، رفض معرّف غير موجود (404)، تزامن → انتقال واحد، لا أثر مالي/دفتر، ترقيم + `offset`
غير صالح، لا تسريب `payload`/توقيع، RBAC (SUPER_ADMIN مسموح؛ SUPPORT/RISK/DISPUTE/MERCHANT/CUSTOMER
مرفوضون)، و401 للزائر.

**التحقق الحيّ (بإذن محدود):** PostgreSQL 16 في حاوية مؤقتة `wasit-obs01-pg` مربوطة بـ
`127.0.0.1:5432` بقاعدة `wasit_test` فقط (مزوّد `manual`، `DEMO_PAYMENT_MODE=true`، بلا مزوّد
حقيقي، لا `wasit_dev` ولا `wasit_demo`). الحاوية حُذفت والمنفذ حُرِّر وأُعيد Docker إلى حالته
السابقة (متوقف) بعد التشغيل.

## 8. ما لم يُفعل (حفاظاً على النطاق)

- لا Commit/Push، ولا تغيير في HEAD (`e43dee4017d2848e37d03d13025a33890adb483f`).
- لا حذف/استبدال لأي ملف أو عمل سابق (PS-01/PS-02/DOC-PS03-ALIGN سليمة).
- لا تنفيذ حقيقي لتسوية/تحويل، ولا ربط بمزوّد حي، ولا إرسال تسليم webhook (الإعادة تنتظر تسليم المزوّد).
- لا تغيير في الصلاحيات أو النموذج المالي.
