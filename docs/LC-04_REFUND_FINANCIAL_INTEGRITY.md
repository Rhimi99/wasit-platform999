# LC-04 — Refund Financial Integrity (external proof required)

الحالة: **`COMPLETE_VERIFIED`** (تقنياً — محور تكامل الـRefund) — إغلاق **WASIT-EXECUTION-009.1** بعد نجاح **11/11** اختبار معزول (LC-04) + **1223/1223** للحزمة الكاملة + TypeScript نظيف، على PostgreSQL 17 مؤقت معزول.

> **تنبيه نطاق:** هذا البند يعالج **محور التكامل المالي للـRefund** (شرط «لا نجاح مالي بلا إثبات خارجي»). الجزء القانوني من LC-04 في سجل الفجوات (نصوص Refund/Dispute Policy وMerchant/Buyer Terms **المنشورة**) يبقى **اعتماداً خارجياً مفتوحاً** تحت **LC-01**، ويُغلَق بتوقيع قانوني لا بكود. لا يدّعي هذا المستند امتثالاً قانونياً.

## 1. الفجوة قبل العمل

كان مسار `createRefund` في `packages/server/src/modules/payments/service.ts` يعتبر الـRefund **مكتملاً** (`COMPLETED`) افتراضياً، حتى دون أي تحقّق خارجي:

```ts
let finalStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED';
if (provider.isFunctional && provider.isAvailable() && payment[0].externalRef) {
  const result = await provider.refund({ … });
  finalStatus = result.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
}
await db.update(refunds).set({ status: finalStatus, externalRef, … });
if (finalStatus === 'COMPLETED') { /* writes REFUND DEBIT + reverses commission + sets order REFUNDED */ }
```

النتيجة:
- **نجاح صامت:** أي مزوّد غير مفعّل/غير متاح (أو غياب `payment.externalRef`) كان يترك `finalStatus='COMPLETED'` — فيُكتب قيد `REFUND` (DEBIT)، وتُعكَس العمولة/الرسم، وتتحوّل حالة الطلب إلى `REFUNDED` **دون أي إثبات أن المال رجع**.
- **مزوّد العرض (demo) يُصدَّق:** `ManualPaymentProvider`/`SandboxPaymentProvider`/`NoopPaymentProvider` كانوا `isFunctional=true`، فيُستدعى `refund()` ويعيد `SUCCEEDED` محلياً — و«نجاحه» علامة محلية لا حركة بنكية.
- **مسار الـWebhook الجزئي:** `applyRefundSucceeded` (عند `REFUND_SUCCEEDED`) كان يقلب `refunds.status='COMPLETED'` فقط، بلا قيد دفتر ولا عكس عمولة — حالة مالية غير متسقة.
- **قرار النزاع يوحي بإتمام لم يحدث:** `decideDispute(IN_FAVOR_OF_BUYER)` يمرّ عبر نفس المسار، فكان قرار إداري وحده كافياً لظهور Refund «مكتمل».

## 2. القرار التقني (fail-closed)

**قاعدة واحدة:** لا يُعتبر الـRefund ناجحاً مالياً إلا بـ**إثبات خارجي موثوق** (Proof-of-Refund) من مزوّد قادر فعلياً على تحريك المال، **مطابِق لهذا الـRefund** بالمبلغ والعملة.

1. **فصل الطلب عن الإتمام:** `createRefund` يكتب الآن **طلب** Refund فقط (`REQUESTED` عند غياب مسار موثوق، `PROCESSING` عند وجود مزوّد موثوق سيُستدعى). لا قيد دفتر، لا عكس عمولة، ولا `REFUNDED` في هذه المرحلة.
2. **مسار إتمام واحد:** `completeRefundWithEvidence(db, refundId, evidence, ctx)` هو **الكاتب الوحيد** للحالة النهائية `COMPLETED` + قيد `REFUND` + عكس العمولة/الرسم + حالة الطلب/المعاملة. لا يوجد كاتب ثانٍ.
3. **مسند الثقة (trust predicate):** `canProveRefund(provider)` في `lib/payments/refund-integrity.ts` — يرفض أي مزوّد `capabilities.demo` (noop/manual/sandbox) وأي مزوّد غير `isFunctional` أو غير `isAvailable()`. أي مزوّد لا يستطيع تحريك المال لا يُكمل Refund أبداً.
4. **مطابقة الإثبات:** `evidenceMatchesRefund(refund, evidence)` ترفض إثباتاً بلا مرجع، أو بمبلغ/عملة مختلفين — فلا يُعتمد إثبات حركة أخرى على هذا الـRefund.
5. **Webhook العرض مرفوض:** `applyRefundSucceeded` يرفض `REFUND_SUCCEEDED` من مزوّد لا يمكنه الإثبات (422) **قبل** أي تغيير حالة، ثم يمرّر الإثبات الموثوق إلى `completeRefundWithEvidence`.
6. **ذرّية/idempotency:** الإتمام داخل `db.transaction` مع قفل صفّي `FOR UPDATE` على الـRefund وإعادة قراءة الحالة تحت القفل — فإتمامان متزامنان (استجابة المزوّد وسباق الـWebhook، أو إعادة تشغيل) لا يكتبان قيدين؛ الثاني يرى `COMPLETED` ويرجع بلا أثر.
7. **تدقيق السبب لا النتيجة فقط:** سجل `REFUND.COMPLETED` يحمل `evidenceSource` (PROVIDER_API/PROVIDER_WEBHOOK)، `provider`، `evidenceRef`، و`evidenceVerified=true` — فلا يُخفى على المدقّق مصدر الإثبات. ولا تُخزَّن أي بيانات بطاقة أو أسرار.
8. **بلا Migration:** لا جدول/عمود جديد. نوع `refund_status` القائم يتّسع للحالات (`REQUESTED/PROCESSING/COMPLETED/FAILED/REJECTED`)، والإثبات يُسجَّل في `audit_logs` (jsonb) القائم. (GM أذن بترحيل عند الحاجة؛ لم تُثبت الحاجة.)

## 3. مسار الـRefund بعد الإصلاح

| الحالة | من يكتبها | قيد REFUND؟ | عكس عمولة؟ | الطلب |
| --- | --- | --- | --- | --- |
| `REQUESTED` | `createRefund` (لا مسار موثوق) | لا | لا | يبقى `PAID` |
| `PROCESSING` | `createRefund` (مزوّد موثوق سيُستدعى) | لا | لا | يبقى `PAID` |
| `FAILED` | `createRefund` (رفض/خطأ المزوّد) | لا | لا | يبقى `PAID` |
| `COMPLETED` | `completeRefundWithEvidence` **فقط** | نعم (DEBIT/PENDING) | نعم | `REFUNDED`/`PARTIALLY_REFUNDED` |

## 4. التنفيذ

| الملف | الدور |
| --- | --- |
| `packages/server/src/lib/payments/refund-integrity.ts` | **المسند الصرف** (بلا DB): `canProveRefund`، `evidenceMatchesRefund`، أنواع `RefundEvidence`/`RefundEvidenceSource`. |
| `packages/server/src/modules/payments/service.ts` | `createRefund` (طلب فقط) + `completeRefundWithEvidence` (كاتب الإتمام الوحيد) + `applyRefundSucceeded` (يرفض webhook العرض). |
| `packages/server/src/modules/disputes/service.ts` | `applyDisputeFinancialEffect` يعيد **حالة** الـRefund الفعلية (`status`) لا إتماماً مفترضاً. |
| `packages/server/vitest.lc04.config.ts` | مشغّل LC-04 المعزول (طبقة بلا DB + طبقة متكاملة). |
| `packages/server/tests/lc04-refund-integrity-policy.test.ts` | 5 حالات بلا DB على أصناف المزوّدين الحقيقية. |
| `packages/server/tests/lc04-refund-external-proof.test.ts` | 6 حالات تكامل عبر HTTP + DB حقيقي. |

## 5. الإثبات (تحقّق فعلي)

**البيئة:** PostgreSQL 17 مؤقت معزول (`wasit_test`، `127.0.0.1:5432`)، `DEMO_PAYMENT_MODE=true`، `PAYMENT_PROVIDER=manual` (مزوّد عرض — الشاهد الأمثل على الفشل المُغلق).

| الأمر | النتيجة |
| --- | --- |
| `npx vitest run --config vitest.lc04.config.ts` | **11/11 passed** |
| `npx vitest run` (الحزمة الكاملة) | **1223/1223 passed** (103 ملف) |
| `npx tsc --noEmit` | نظيف |

**الحالات المُثبَتة (تكامل):**
1. مزوّد عرض **لا يستطيع** إكمال Refund: لا قيد `REFUND`، لا `REFUNDED`، الطلب يبقى `PAID`.
2. Webhook `refund.succeeded` **موقّع صحيحاً** من مزوّد عرض **يُرفض** (422) ولا يحرّك شيئاً.
3. الإتمام يحدث **فقط** بإثبات خارجي موثوق (يصبح `COMPLETED` + قيد DEBIT/PENDING + الطلب `REFUNDED`).
4. إثبات بمبلغ مختلف **يُرفض** (409) ولا يحرّك شيئاً.
5. الإتمام مرتين **idempotent**: قيد عكسي واحد فقط.
6. سجل التدقيق يحمل **مصدر الإثبات** ومرجعه و`evidenceVerified=true`.

## 6. ما لم يُغيَّر (حدود متعمّدة)

- **محرّك التسوية (`confirmSettlement`) وكاتب `SETTLED` الوحيد** لم يُمسّا: الـRefund قيد دفتر (`PENDING`) ولا يُرقّى إلى `SETTLED` إلا بإثبات تسوية، وهو مسار مستقل.
- **Commission Policy** (4% = 2% + 2%) دون تغيير.
- **لا تغيير في RBAC** (`refund:manage` كما هو؛ العميل يُرفض 403 على الخادم).
- **الجزء القانوني من LC-04** (نصوص Refund/Dispute Policy المنشورة + Merchant/Buyer Terms) يبقى **اعتماداً خارجياً مفتوحاً** تحت LC-01 — لم يُدَّع إغلاقه.

## 7. WASIT-EXECUTION-009.2 — الأُطُر التشغيلية للنزاع (مُهل، سحب، تنحٍّ، خصوصية، سطح سياسة عام)

**النطاق:** الوجه التشغيلي من LC-04 (بلا تغيير على محور المال في §1–§6). كل القيم الزمنية صارت **من السياسة**، لا ثوابت في الكود.

1. **`responseWindowDays` في السياسة:** أُضيف إلى `disputeRulesSchema` (حد أقصى 3650) وإلى `DISPUTE_RESOLUTION` في `seed.ts` (`7`). الحقول الزمنية تُقرأ عبر `parseDeadlineRules` — أي قيمة غائبة أو غير صالحة تصبح `null` (نافذة مفتوحة) لا افتراضاً صامتاً.
2. **مُهل مشتقّة (`lib/disputes/deadlines.ts`، نقي بلا DB):** `openWindowClosesAt` من إنشاء الطلب، والباقي من إنشاء النزاع (`responseDeadline`, `evidenceDeadline`, `decisionDeadline`, `autoEscalateAt`)، و`appealDeadline` من وقت البتّ. الحدود شاملة عند اللحظة تماماً، ولا أيام سالبة.
3. **فرض النوافذ:** فتح النزاع يُرفض بعد `openWindowDays` (409)، والأدلة تُرفض بعد `evidenceDeadlineDays` (409).
4. **السحب (`withdrawDispute`):** **كاتب الحالة الوحيد** للسحب — يقبل فقط من فاتح النزاع، وفقط قبل قرار (`NONE`)، وينتقل ذرّياً إلى `CLOSED` بحدث `STATUS_CHANGED` + تدقيق `DISPUTE.WITHDRAWN`. سحب مكرّر أو بعد قرار ⇒ 409.
5. **فصل المهام (تنحٍّ):** `decideDispute` يرفض (403) أي طرف في الطلب — ولو حمل دور موظف؛ و`reviewDisputeAppeal` يرفض (403) من أصدر القرار الأصلي. الانتقالات ذرّية عبر `UPDATE ... WHERE status IN (...)` فيُرفض السباق بـ409.
6. **خصوصية الأطراف:** `maskEmail` يخفي بريد الطرف الآخر عن غير الموظفين (`o***@domain`)؛ الموظفون يرون البريد كاملاً. يظهر ذلك في تفاصيل النزاع وقائمة الاستئنافات.
7. **سطح سياسة عام:** `GET /api/public/disputes/refund-policy` (بلا جلسة) يعيد ملخّص النوافذ التشغيلية مع `operationalSummaryOnly=true`، **بلا أي بيانات قضية ولا `decisionEffects`**، ويحلّ تجاوز الدولة عند تمرير `?country=`. رمز دولة غير معروف ⇒ `countryCode=null` لا خطأ.

**الإثبات (009.2):** `tests/lc04-dispute-rails.test.ts` **9/9 ✅** (تكامل عبر HTTP + DB حقيقي) + `tests/lc04-dispute-deadlines.test.ts` **9/9 ✅** (نقي بلا DB)؛ الحزمة الكاملة للخادم **1241/1241 ✅** (105 ملف)؛ TypeScript (server+web) نظيف.

**الحدّ:** السطح العام **ملخّص تشغيلي** وليس نصاً قانونياً — الصياغة القانونية تبقى **اعتماداً خارجياً مفتوحاً** تحت LC-01.

## 8. WASIT-EXECUTION-009.3 — إنفاذ المتطلبات المتبقية (تحقّق مستقل + إغلاق فجوات الإنفاذ)

**المنهج:** تحقّق مستقل من كل إعداد من السبعة على الكود الفعلي (أين يُقرأ/يُطبَّق/السلوك عند الانتهاء/التجاوز/الاختبارات)، فظهرت **ثلاث فجوات إنفاذ حقيقية** أُثبتت باختبار استكشافي (HTTP + DB حقيقي) ثم أُغلقت. الإعدادات الثلاثة الأخرى (`openWindowDays`, `evidenceDeadlineDays`, `appealWindowDays`/`maxAppeals`) كانت مُنفَّذة ومُختبرة فعلاً من قبل.

### الفجوات الثلاث المُثبتة والمُغلقة

1. **`DECIDED` بلا قرار (تجاوز كامل لمسار البتّ):** `POST /admin/disputes/:id/status` كان يقبل `DECIDED` (من `UNDER_REVIEW`/`ESCALATED`)، فيُكتب `status=DECIDED` مع `decision=NONE` و`decidedBy=null` و`decidedAt=null` — **بلا قرار، بلا تنحٍّ، وبلا أي أثر مالي**؛ وهو ما يُظهر للنزاع كأنه «مُبتوت» ويؤهّله للاستئناف. **الإصلاح:** رُفض `DECIDED` من مسار الحالة (409) وأُزيل من قائمة الانتقالات، فلا يُسجَّل قرار إلا عبر `decideDispute` (الذي يفرض التنحّي والأثر المالي ويسجّل `decidedBy`/`decidedAt`). أُزيل `DECIDED` من قائمة اختيار الحالة في واجهة الإدارة.
2. **`responseWindowDays` للعرض فقط:** لم يكن مُنفَّذاً في أي مسار — الطرف المقابل كان يظل قادراً على الردّ بعد انتهاء نافذة الردّ إلى الأبد. **الإصلاح:** `addDisputeMessage` يرفض (409) رسالة **الطرف المقابل** بعد انتهاء نافذة الردّ؛ الفاتح والمُسنَد إليه والموظفون يبقون القناة مفتوحة (هم ليسوا «مُجيبين»). الأدلة تبقى على نافذتها الأطول (`evidenceDeadlineDays`) المستقلّة.
3. **`autoEscalateDays` بلا مُنفِّذ:** كان يُحسب (`needsEscalation`) ويُعرض في الواجهة، لكن **لا شيء يحرّك النزاع** — لا مهمة مجدولة ولا مسار. **الإصلاح:** `escalateOverdueDisputes(db)` — مسح **idempotent وآمن عبر النسخ** (`UPDATE` شرطي على الحالات الحيّة فقط، فمسارَان متزامنان لا يُصعِّدان النزاع مرتين)، يُسجّل حدث `STATUS_CHANGED` وتدقيقاً `DISPUTE.AUTO_ESCALATED` بـ`actorType=SYSTEM`. مُربَط بالمجدول (`DISPUTE_ESCALATION_ENABLED`، افتراضي `false`) وبمسار إداري يدوي `POST /api/admin/disputes/escalate-overdue` (صلاحية `dispute:manage`). السياسة التي لا تحدّد `autoEscalateDays` لا تُصعِّد شيئاً (نافذة مفتوحة).

### الإثبات (009.3)

| الأمر | النتيجة |
| --- | --- |
| `tests/lc04-dispute-enforcement.test.ts` | **6/6 ✅** (تكامل HTTP+DB: رفض `DECIDED` عبر الحالة وبقاء السجل غير مبتوت + البتّ الحقيقي عبر `decide`؛ إنفاذ نافذة الردّ للطرف المقابل مع بقاء الفاتح/الموظف؛ تصعيد idempotent + تدقيق SYSTEM؛ عدم تصعيد المبتوت؛ تصعيد واحد تحت مسحَين متزامنَين؛ مسار المشغّل الإداري 403/401/200) |
| `tests/lc04-dispute-deadlines.test.ts` | **11/11 ✅** (نقي بلا DB، أُضيفت حالتان: نافذة ردّ مفتوحة عند غياب الإعداد، والتصعيد بعد الحدّ لا عنده) |
| `tests/lc04-dispute-rails.test.ts` + `disputes.test.ts` + `dispute-country-policy.test.ts` | ✅ بلا تراجع |
| الحزمة الكاملة للخادم | **1249/1249 ✅** (106 ملف) |
| Typecheck (server) | نظيف |

### ما لم يُغيَّر

- لا تغيير على محور المال (009.1) ولا على الأُطُر التشغيلية المُنجزة (009.2).
- **بلا Migration:** لا جدول/عمود جديد (الحدث والتدقيق في الجداول القائمة).
- الإعدادات المُنفَّذة سابقاً (`openWindowDays`, `evidenceDeadlineDays`, `appealWindowDays`, `maxAppeals`) لم تُمسّ.
