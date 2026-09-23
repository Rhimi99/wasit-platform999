# WASIT BUSINESS GLOBAL — تقرير هندسي: الدفع، التحصيل، وتسوية العمولة

**النطاق:** مراجعة قراءة فقط (Read-only audit) للنظام كما هو على `master` — لا تعديل على كود الإنتاج، لا migrations، لا تغيير في قاعدة البيانات.
**آخر تحديث:** 2026-09-23.
**المرجع الأساسي:** `docs/PAYMENT_PROVIDERS.md`، `docs/REVENUE_MODEL.md`، `docs/DATABASE_SCHEMA.md`، `docs/PROJECT_BASELINE.md`.

> كل نتيجة في هذا التقرير **مُتحقَّق منها تجريبيًا** على قاعدة بيانات أُعيد بناؤها من الصفر (migrations 0000→0024 + seed + seed-demo) عبر واجهات API الحقيقية وwebhook موقّع فعليًا — لا mocks.

---

## 1. السؤال المحوري

> كيف تتحول عملية شراء حقيقية إلى **مال فعلي يصل إلى حساب WASIT** (البنك أو مزوّد الدفع) — وليس مجرد قيود دفترية (ledger entries)؟

**الجواب المختصر:** حاليًا **لا توجد** أي مسار في النظام يُحرّك مالًا فعليًا إلى حساب WASIT. توجد بنية دفع (payment kernel) تصل حتى **تأكيد المزوّد للعملية (authorization/capture)**، ثم تنتهي. لا يوجد أي كود لـ payout / bank transfer / IBAN / settlement account ، و`SETTLEMENT` كنوع قيد لا يُكتب به أي صف من أي مسار خدمي.

---

## 2. المسار الحقيقي للمال — خطوة بخطوة (كما هو مُنفَّذ فعليًا)

| # | المرحلة | الملف / الدالة | ماذا يحدث فعليًا | حركة مال حقيقية؟ |
|---|---|---|---|---|
| 1 | إنشاء الطلب | `modules/orders/service.ts` → `createOrder` | يُحسب `commission` عبر Policy Engine و`payment_fee` عبر `payment_fee_policies`، ثم تُدرج `orders` + `transactions` + `transaction_ledger` | ❌ لا |
| 2 | حالة المعاملة | `orders/service.ts:178` | `transactions.status` يُدرج بقيمة **`'PAID'` مباشرةً** عند إنشاء الطلب | ❌ لا |
| 3 | نيّة الدفع | `modules/payments/service.ts` → `createIntent` | يُنشأ `payment_intents` بحالة `PENDING`، ويُردّ `checkoutUrl` من المزوّد (أو `null` للـmanual) | ❌ لا |
| 4 | الدفع عند المزوّد | `lib/payments/{flouci,clictopay,providers}.ts` | تحويل المشتري إلى صفحة المزوّد (live فقط عند توفّر credentials) | ✅ عند مزوّد حقيقي مرخّص |
| 5 | تأكيد المزوّد | `lib/payments/*` → `getStatus` / webhook | المزوّد يؤكّد النجاح؛ الخدمة تعيد التحقق من المبلغ والعملة | ✅ (تأكيد فقط) |
| 6 | تطبيق النجاح | `payments/service.ts` → `applyPaymentSucceeded` | تُحدَّث `payment_intents=SUCCEEDED`، `payments=PAID`، `orders.paymentStatus=PAID`، وتُحوَّل كل قيود الـledger إلى `SETTLED` | ✅ قيد محاسبي فقط |
| 7 | تسوية/تحويل إلى WASIT | **غير موجود** | لا كود، لا جدول، لا مهمة مجدولة | ❌ **لا يوجد** |

**الاستنتاج:** "SETTLEMENT" في هذا النظام هو **حالة قيد محاسبي** (`transaction_ledger.status ∈ {PENDING, SETTLED}` و`orders.settlement_status`)، وليس تحويل أموال إلى حساب WASIT.

---

## 3. الأسباب الجذرية المؤكَّدة تجريبيًا (Root Causes)

### RC-1 — `transactions.status` يُسجَّل `'PAID'` قبل أي دفع
- **الملف:** `packages/server/src/modules/orders/service.ts:178`
- **السبب:** الإدراج يستخدم قيمة ثابتة `status: 'PAID'` بدل `'PENDING'`.
- **الأثر:** النظام يعتبر كل طلب "مدفوعًا" على مستوى `transactions` حتى لو لم يدفع المشتري أبدًا. المستهلكون المتأثرون: `GET /api/admin/transactions`، `lib/risk-engine.ts` (إشارة `REPEATED_PAYMENT_FAILURES`)، وتقارير المباني عليها.
- **الدليل الفعلي:** طلبات بـ`orders.payment_status = 'UNPAID'` لها `transactions.status = 'PAID'` في نفس الوقت.
- **الحالة:** لم يُصلَح (خارج نطاق المراجعة القراءة-فقط؛ انظر §6).

### RC-2 — لا كاتب لقيد `SETTLEMENT` ولا لـ`orders.settlement_status`
- **البحث:** `grep entry_type = 'SETTLEMENT'` → **صفر نتائج كتابة** (يظهر فقط في التعريف والقراءة/التحليلات).
- **`settlement_status`:** لا يوجد أي `set/update/insert` له في كل `src` — يبقى `PENDING` إلى الأبد.
- **الدليل الفعلي:** `SELECT count(*) FROM transaction_ledger WHERE entry_type='SETTLEMENT'` = **0**، وكل الطلبات `settlement_status='PENDING'`.
- **الأثر:** واجهة العميل تعرض `order.settlement` بقيمة `—` دائمًا (`DashboardListPages.tsx:346`).

### RC-3 — تعارض إشارة العمولة بين تقريرين (Bug حقيقي ظاهر في Admin)
- **`/api/revenue/report`** (`modules/revenue/service.ts` → `ledgerTotal`) يحسب `CREDIT − DEBIT`. وبما أن قيود `COMMISSION` كلها `DEBIT`، تكون النتيجة **سالبة**.
- **`/api/admin/analytics/revenue-breakdown`** (`modules/analytics/service.ts:230-234`) يلفّ نفس القيمة بـ`Math.abs`.
- **الدليل الفعلي (نفس البيانات):**

| المصدر | commission | refunds | netRevenue |
|---|---|---|---|
| `/api/revenue/report` | **-686.2000** | 0.0000 | **-686.2000** |
| `/api/admin/analytics/revenue-breakdown` | **+686.2000** | +100.0000 | +929.3000000000002 |

- **الأثر:** رقمان متناقضان لنفس الحقيقة المحاسبية؛ إشارة خاطئة في تقرير واحد على الأقل.
- **ملاحظة إضافية:** حتى حساب `Math.abs` التفصيلي لا يعكس عمولة الرحلات المستردة (RC-5)، و`netRevenue` غير مُقرَّب (كسر عشري).

### RC-4 — ثغرة إثبات-الاستلام (Idempotency) تُسقط حدث النجاح
- **الملف:** `modules/payments/service.ts:243-257`
- **السبب:** الصف يُدرج في `payment_webhook_events` (بمفتاح فريد `provider+eventId`) **قبل** تقرير ما إذا كان الحدث قابلاً للتنفيذ. حدث غير معروف (مثل `payment.pending` → `UNKNOWN`) يُستهلك المفتاح، فأي حدث لاحق بنفس `eventId` ونوع نهائي يُعامل كتكرار `duplicate: true, applied: false` ويُسقط.
- **الدليل الفعلي:**
  - `{eventId: "evt_same_1", type: "payment.pending"}` → `duplicate:false, applied:false, eventType:"UNKNOWN"`
  - ثم `{eventId: "evt_same_1", type: "payment.succeeded"}` → **`duplicate:true, applied:false`** → الطلب **لم يُوسم PAID أبدًا**.
- **الأثر:** مع مزوّد حقيقي يرسل `pending` ثم `succeeded` بنفس معرّف الحدث (نمط شائع)، **لا يُسجَّل الدفع إطلاقًا**.

### RC-5 — الاسترداد لا يعكس العمولة أو الرسوم
- **الملف:** `modules/payments/service.ts` → `createRefund`
- **السبب:** يُدرج قيد `REFUND` فقط (DEBIT)؛ لا قيد عكسي لـ`COMMISSION` (بشقيها seller/buyer) ولا `PAYMENT_FEE`.
- **الدليل الفعلي (طلب 214.20، استرداد جزئي 100):**

| entry_type | direction | amount | ملاحظة |
|---|---|---|---|
| TRANSACTION_VALUE | CREDIT | 210.0000 | — |
| COMMISSION (SELLER) | DEBIT | 4.2000 | **لم تُعكس** |
| COMMISSION (BUYER) | DEBIT | 4.2000 | **لم تُعكس** |
| PAYMENT_FEE | DEBIT | 4.2000 | **لم تُعكس** |
| REFUND | DEBIT | 100.0000 | — |

- **الأثر:** عمولة WASIT تبقى مسجّلة كاملة على طلب مسترد جزئيًا — مبالغة في الإيراد.

### RC-6 — لا مسار واجهة لتسوية الـmanual (Checkout لا يكتمل من UI)
- المزوّد `manual` ينشئ intent بحالة `PENDING` و`checkoutUrl=null`.
- لا يوجد في الواجهة أي زر/لوحة لتنفيذ التسوية اليدوية (لا "settlement desk" في `packages/web/src`).
- **الأثر:** المستخدم يرى "بانتظار الدفع" فقط ولا توجد طريقة لإتمام العملية من الواجهة — وهو ما يُطابق ملاحظة "الوظائف لا تعمل عند التجربة اليدوية".
- **تأكيد:** تسجيل الدخول كـadmin ثم `POST /api/payments/orders/:id/refunds` يعمل، لكن لا قِبل للواجهة بذلك للمشتري.

---

## 4. ما اكتُشف أنه **يعمل فعليًا** (حتى لا يُكسَر)

مُتحقَّق منه عبر واجهات API حقيقية + webhook موقّع بـHMAC فعلي:

| القدرة | النتيجة الفعلية |
|---|---|
| تسجيل الدخول (Customer/Admin) | ✅ `200` + جلسة صالحة |
| `GET /api/payments/methods` | ✅ يعرض `active: "manual"` + القدرات |
| إنشاء نيّة دفع | ✅ `201` مع `externalRef` و`amount=214.2000` |
| التحقق من توقيع الـwebhook | ✅ التوقيع المزيف → `401 UNAUTHORIZED` |
| منع إعادة التشغيل (replay) | ✅ الحدث الصحيح المكرَّر → `duplicate:true` |
| تطبيق النجاح (حدث نظيف) | ✅ `intent=SUCCEEDED`, `payment=PAID`, `order.paymentStatus=PAID`, القيود→`SETTLED` |
| إشعار المشتري | ✅ `PAYMENT_SUCCEEDED` |
| idempotency الاسترداد | ✅ نفس `idempotencyKey` → نفس الاسترداد (`reused`) |
| منع الاسترداد الزائد | ✅ مُطبَّق (remaining guard) |
| سياسة العمولة 4% = 2%+2% | ✅ مُطبَّقة: 8.40 على 210 (=4%)، منها 4.20 buyer |
| Commission Engine (لا سعر ثابت في الكود) | ✅ يقرأ من `commission_policies` |

---

## 5. فجوة "المال الفعلي" مقابل "المال المحاسبي"

| السؤال | الحالة |
|---|---|
| هل يُنفَّذ charge حقيقي؟ | نعم — عبر مزوّد مرخّص (Flouci/ClicToPay) عند توفّر credentials. |
| هل يُؤكَّد الدفع؟ | نعم (webhook + status recheck + مطابقة المبلغ/العملة). |
| هل يُسجَّل الدخل؟ | نعم، كقيود دفترية (ledger). |
| هل يُحوَّل صافي المال إلى حساب WASIT؟ | **لا. لا يوجد كود payout/settlement ولا حساب مستفيد مُهيَّأ.** |
| هل يوجد فصل بين "المحصّل عبر المزوّد" و"المستحق للتاجر"؟ | لا — لا settlement إلى التاجر/البائع. |
| هل يوجد حساب bank/IBAN في الإعدادات؟ | لا. البحث عن `payout/iban/swift/bank_transfer` = **صفر نتائج**. |

**الخلاصة:** النظام محاسبيا يصل إلى "المال مؤكَّد عند المزوّد"، لكن **لا توجد طبقة Treasury / Payout / Reconciliation** تنقل الفعلي إلى Wasit أو إلى التجار.

---

## 6. جدول الأوديت الوظيفي (Feature Audit)

> **مهم:** وفق قيود خط الأساس المجمّد (لا تعديل كود إنتاج، لا migrations، لا DB changes)، **لم أُعدّل أي كود**. الجدول يوثّق السبب الجذري والإصلاح الموصى به دون تنفيذه، حفاظًا على `commit 64bdcf0` وسياسة العمولة 4% وMarketing Video Agent (`0dda091`/`89e68d7`).

| Feature | Tested from UI | Result | Root cause if failed | Fix (موصى به — غير منفَّذ) | Test status |
|---|---|---|---|---|---|
| Login | ✅ | PASS | — | — | verified |
| Payment methods listing | ✅ | PASS | — | — | verified |
| Create order (API) | ✅ | PASS | — | — | verified |
| Create payment intent | ✅ | PASS | — | — | verified |
| Webhook signature (forged) | ✅ | PASS (rejects) | — | — | verified |
| Webhook replay (same id) | ✅ | PASS (dedup) | — | — | verified |
| Webhook pending→succeeded (same id) | ✅ | **FAIL** | RC-4: event key consumed by UNKNOWN before side-effect | لا تُدرج الحدث كـ"معالج" إلا للنوع القابل للتنفيذ، أو اسمح بالترقية UNKNOWN→terminal | **reproduced** |
| Order marked PAID after success | ✅ | PASS (clean event) | — | — | verified |
| `transactions.status` accuracy | ✅ (admin) | **FAIL** | RC-1: inserted hardcoded `'PAID'` at creation | تغيير `orders/service.ts:178` إلى `'PENDING'` (تُرقَّى في `applyPaymentSucceeded`) | **reproduced** |
| Refund + idempotency | ✅ | PASS | — | — | verified |
| Refund reverses commission | ✅ | **FAIL** | RC-5: no reversing commission/fee entries | إدراج قيود عكسية `COMMISSION`/`PAYMENT_FEE` بنسبة المبلغ المسترد | **reproduced** |
| Settlement entry / status | ✅ | **FAIL (absent)** | RC-2: no writer | بناء Settlement/Payout engine والكتابة إلى `SETTLEMENT` + `settlement_status` | **reproduced** |
| Revenue report consistency | ✅ | **FAIL** | RC-3: sign inconsistency between two endpoints | توحيد الإشارة وإضافة عكس عمولة الاسترداد + تقريب | **reproduced** |
| Manual checkout completion from UI | ✅ | **FAIL** | RC-6: no settlement desk UI | إضافة مسار تسوية يدوية (admin) وإظهار حالته للمشتري | **reproduced** |
| Real payout to WASIT bank | — | **NOT IMPLEMENTED** | لا كود | تصميم Treasury/Payout + تكامل مزوّد | missing |
| Payout to seller/merchant | — | **NOT IMPLEMENTED** | لا كود | Ledger settlement + payout ledger | missing |

---

## 7. التوصيات المعمارية (بالترتيب)

1. **إصلاح RC-1** أولًا: `transactions.status` يجب أن يبدأ `PENDING` — لأنه يلوّث الـRisk Engine والتقارير الإدارية.
2. **إصلاح RC-4**: لا تُستهلك هوية الحدث إلا عند وجود side-effect فعلي (أو اسمح بترقية الحالة).
3. **إصلاح RC-3**: توحيد دلالة الإشارة في `revenue/service.ts` و`analytics/service.ts`، وإضافة عكس عمولة الاسترداد.
4. **إصلاح RC-5**: قيود عكسية للعمولة والرسوم عند الاسترداد.
5. **بناء طبقة Settlement/Payout حقيقية** (RC-2, RC-6): جدول settlement_accounts، حالة على الطلب، كاتب لقيد `SETTLEMENT`، ومسار UI للـmanual/التسوية.
6. **طبقة Treasury/Reconciliation** لمطابقة `payments` عند المزوّد مع الحساب البنكي الفعلي.

---

## 8. ملاحظات نزاهة

- جميع الأرقام أعلاه مُستخرجة من تشغيل فعلي على قاعدة أُعيد بناؤها بـ migrations الرسمية + seed المشروع — **لا DB reset/drop/push**، ولم تُحذف بيانات اختبار ضرورية.
- لم تُعدَّل سياسة العمولة (4% = 2%+2%) ولم يُمسّ Marketing Video Agent.
- لم يُنشأ أي commit لهذه المراجعة (مطابقةً لقيود الأساس المجمّد).
- الملفات المؤقتة المستخدمة للاستعلام أُزيلت، والخادم التجريبي أُوقف.
