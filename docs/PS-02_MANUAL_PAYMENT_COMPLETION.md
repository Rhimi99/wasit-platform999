# PS-02 — MANUAL PAYMENT COMPLETION DESK (DEMO ONLY)

تاريخ: 2026-11-06 · الحالة: **VERIFIED LIVE — COMPLETED** (PostgreSQL 16 معزول `wasit_test`) · لا Commit/Push

مرجع: `docs/GAP_REGISTER.md` §2 (PS-02، P0/MEDIUM) + `docs/PAYMENT_SETTLEMENT_AUDIT.md` (RC-6) + `docs/MANUAL_VS_AUTOMATED_FINANCIAL_ANALYSIS.md`.

---

## 1. ملخّص

PS-02 (بالنطاق المعتمد لهذه المهمة): لا مسار إداري يُتمّ دفع `manual`/offline من الواجهة، فلا
يستطيع المشغّل تسجيل استلام دفعة خارجية، ولا يرى المشتري أي مخرج (RC-6: «Payment Confirmation»).

أُضيف **مكتب إتمام دفع يدوي** في تبويب جديد ضمن `/admin/finance`، يسمح لـ**ADMIN** و**SUPER_ADMIN**
بتسجيل استلام دفعة يدوية في **وضع DEMO فقط**، فينتقل الـintent والطلب إلى **PAID** عبر **منطق الدفع
المعتمد نفسه** (`applyPaymentSucceeded`) — لا كاتب جديد ولا قاعدة مالية جديدة.

> **ليس تسوية بنكية حقيقية.** الإتمام يعني «مدفوع» لا «مسوّى»: لا يُنشئ `SETTLEMENT`، ولا `Payout`،
> ولا يمسّ محفظة، ولا يحرّك أموالاً حقيقية. البند PS-02 الأصلي (Payout للبائع) يبقى كما هو.

**قرار الموضع:** أُضيف السطح كـ**تبويب `manual`** داخل مكتب المالية `/admin/finance` (تبويب سادس)
بدل صفحة منفصلة. السبب: (أ) تبويب واحد يحقّق «لوحة الإدارة المناسبة» التي طلبها النطاق بلا رابط
ملاحي جديد؛ (ب) التسمية «إكمال الدفع اليدوي» تُبقي الفصل الدلالي صريحاً عن تبويب `settlement`
(تسوية المزوّد)؛ (ج) إضافة تبويب **إضافية بحتة** لا تتراجع عن عمل PS-01 ولا تكسر اختباراته (تؤكّد
الاختبارات وجود تبويبات بعينها بـtestid، لا «خمسة بالضبط»). كان القرار المؤقّت أثناء التنفيذ صفحة
منفصلة، ثم عُدل إلى التبويب لأنه الموضع الأنسب وظيفياً مع أقل سطح جديد؛ لم يُحذف أي عمل.

## 2. مبدأ التصميم — البوّابات تُغلق لا تُفتح

- **DEMO فقط:** الدالة ترفض (503) ما لم يكن `demoPaymentMode()` صحيحاً، وهو يستثني `production`
  أصلاً. لا يمكن لـ«بشري يشهد على مال» أن يعمل على مال حقيقي.
- **مزوّد `manual` فقط:** يُرفض (409) أي intent أنشأه مزوّد حقيقي — هذا المسار لا يؤكّد إلا الدفع
  خارج الشبكة؛ مزوّد حقيقي يُؤكَّد بدليله (webhook/status recheck).
- **مرجع دفع إلزامي:** يُرفض (422) بلا مرجع؛ ويُسجَّل في الـAudit كشهادة المشغّل لا كدليل بنكي.
- **إعادة الاستخدام لا الازدواج:** الكتابة تمرّ عبر `applyPaymentSucceeded` (idempotent بمفتاح
  `externalRef`)؛ إعادة التطبيق لا تُضاعف الأثر.
- **لا نجاح قبل الخادم:** الواجهة تعيد قراءة الحالة بعد الإتمام، فتُعرض `PAID` لأن الخادم قال ذلك.
- **تأكيد قبل الفعل:** الإتمام يغيّر حالة مال، فيُطلب تأكيد صريح (`window.confirm`) قبل الإرسال؛
  رفضه لا يُرسل أي طلب.
- **`Payout Created ≠ Payout Completed`، و`Paid ≠ Settled`:** لا شيء في هذا المسار يلمس التسوية.

## 3. الملفات المعدّلة والجديدة

### جديدة (3)
| الملف | الغرض |
| --- | --- |
| `packages/server/tests/manual-payment-completion.test.ts` | تكامل حقيقي (auth → `/api/admin` → صلاحية → خدمة → DB): 10 حالات |
| `packages/server/tests/manual-payment-completion-guard.test.ts` | بوّابات ما قبل الـDB (بلا قاعدة بيانات): 4 حالات |
| `e2e/manual-payment-completion.spec.ts` | E2E من الواجهة الحقيقية: 5 حالات |

### معدّلة (6)
| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/payments/service.ts` | `completeManualPayment` (الكاتب + البوّابات)، `manualCompletionAvailability`، `getManualPaymentView` (قراءة فقط) |
| `packages/server/src/modules/finance/routes.ts` | 3 مسارات جديدة: `POST /manual-completions`، `GET /manual-completions/:orderId`، `GET /manual-payment-availability` + `manualCompletionSchema` |
| `packages/web/src/lib/api.ts` | 3 دوال تطابق المسارات 1:1 |
| `packages/web/src/lib/types.ts` | `ManualPaymentView` + `ManualCompletionResult` |
| `packages/web/src/lib/i18n.ts` | 15 مفتاح `adminFin.*` في ar/fr/en/zh |
| `packages/web/src/pages/AdminFinancePages.tsx` | تبويب `manual` + نموذج البحث/الإتمام + تأكيد قبل الإتمام + لوحة الحالة |

> لم تُمسّ أي صلاحية أو مصفوفة أدوار أو نموذج العمولة 4%. لا تغيير في منطق التسوية/الدفعات/الاسترداد.

## 4. المسارات الجديدة (تحت `/api/admin/finance`)

| الإجراء | المسار | الطريقة | الصلاحية |
| --- | --- | --- | --- |
| قراءة أهلية الطلب | `/manual-completions/:orderId` | GET | `payment:read` أو `commission:manage` |
| توفّر الإجراء | `/manual-payment-availability` | GET | نفسها |
| إتمام دفع يدوي | `/manual-completions` | POST | `commission:manage` أو `payment:read` |

الحارس العام `adminRoutes.use('*', requireRole('ADMIN','SUPER_ADMIN'))` يسبق تطبيق `financeRoutes`
على نفس البادئة `/api/admin`، فيحصر الوصول في ADMIN/SUPER_ADMIN — ولا حتى `MERCHANT` (الذي يملك
`payment:read`) يستطيع الوصول. أُعيد استخدام `payment:read`/`commission:manage` عمداً بدل اختراع
صلاحية لا يملكها أي دور.

## 5. عقد الإتمام

`POST /api/admin/finance/manual-completions` → `{ orderId, paymentReference }`

| الحالة | الاستجابة |
| --- | --- |
| نجاح | 200 `{ orderId, intentId, externalRef, paymentReference, amount, currencyCode, alreadyPaid }` |
| بلا مرجع (فارغ/مسافات) | 422 `VALIDATION_ERROR` |
| خارج وضع DEMO | 503 `SERVICE_UNAVAILABLE` |
| intent لمزوّد غير `manual` | 409 `CONFLICT` |
| لا يوجد intent/طلب | 404 `NOT_FOUND` |
| غير مصرّح | 401 (زائر) / 403 (غير ADMIN/SUPER_ADMIN) |

الأثر: `paymentIntents.status=SUCCEEDED`، `payments.status=PAID`، `orders.paymentStatus=PAID`
(عبر `applyPaymentSucceeded`)، و`orders.settlementStatus` **يبقى `PENDING`**، وقيد الدفتر **يبقى
`PENDING`** (لا `SETTLED`)، وAudit باسم `PAYMENT.MANUAL_COMPLETED` يحمل `actorId` + المرجع.

## 6. الاختبارات

| الحزمة | الملف | الحالات | حالة التشغيل (تحقّق حيّ) |
| --- | --- | --- | --- |
| Backend (DB) | `manual-payment-completion.test.ts` | 10 | ✅ **10/10 ناجحة** (PostgreSQL 16 معزول) |
| Backend (بلا DB) | `manual-payment-completion-guard.test.ts` | 4 | ✅ **4/4 ناجحة** (بلا قاعدة بيانات) |
| E2E | `manual-payment-completion.spec.ts` | 5 | ✅ **5/5 ناجحة** (PostgreSQL 16 معزول + متصفح Chromium) |
| تراجع PS-01 (Backend) | `finance-routes.test.ts` | 16 | ✅ **16/16 ناجحة** (بلا تراجع) |
| تراجع PS-01 (E2E) | `admin-finance.spec.ts` | 10 | ✅ **10/10 ناجحة** (التبويب الجديد لم يكسر سطح PS-01) |

**التحقق الحيّ (بإذن محدود):** PostgreSQL 16 في حاوية مؤقتة `wasit-ps02-pg` مربوطة بـ`127.0.0.1:5432`
بقاعدة `wasit_test` فقط (`DEMO_PAYMENT_MODE=true`، مزوّد `manual`، بلا مزوّد حقيقي). الحاوية حُذفت
والمنفذ حُرِّر بعد التشغيل. **الإجمالي: 45 اختباراً ناجحاً / 0 فاشل / 0 متخطّى.**

**إصلاحان في الاختبار (لا في المنتج) اكتُشفا أثناء التحقق:** كان الـspec يتوقّع أن الطلب يبدأ `UNPAID`
بينما إنشاء الـintent ينقله فعلاً إلى `PENDING` (سلوك المنتج الصحيح)؛ وكان اختبار «مرجع فارغ» ينقر زر
الإتمام **قبل** البحث فيظل الزر معطّلاً (`!manualView?.eligible`). صُحّح الـspec فقط (إضافة خطوة البحث +
توقّع `PENDING`)، ولم يُغيَّر أي كود منتج.

## 7. ما لم يُفعل (حفاظاً على النطاق)

- لا Commit/Push، ولا تغيير في HEAD (`e43dee4017d2848e37d03d13025a33890adb483f`).
- لا حذف/استبدال لأي ملف أو عمل سابق.
- لا تنفيذ حقيقي لتسوية/تحويل، ولا ربط بمزوّد حي.
