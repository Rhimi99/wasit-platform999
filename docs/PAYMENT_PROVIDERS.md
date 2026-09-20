# PAYMENT PROVIDERS & MULTI-METHOD DESIGN — WASIT BUSINESS GLOBAL

آخر تحديث: **2026-09-19**. مرجع: Payment Kernel الحالي (`packages/server/src/lib/payments/`) + `modules/payments`.

الغرض: توثيق الوضع الحقيقي للمزوّدين المرشّحين لتونس، وما يمكن تنفيذه الآن بلا اختراع API، والتصميم المقترح لتعدد وسائل الدفع.
**لا يحتوي هذا الملف أي credentials** — كل المفاتيح تُقرأ من Environment.

---

## 1. Payment Provider Matrix

| المزوّد | النوع | API رسمي موثّق | Sandbox | Auth | Webhook | Signature | Refund | Settlement | العملات | تونس | Visa/MC | D17 | Flouci | حالة التكامل في WASIT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Flouci** | Gateway + Wallet (PSP مرخّص BCT) | ✅ `docs.flouci.com` (عام) | ✅ TEST APP فوري بعد الـRNE | `Authorization: Bearer <PUBLIC>:<PRIVATE>` | ✅ حقل `webhook` | ⚠️ **غير موثّق** — يُتحقق عبر `verify_payment` | ✅ `POST /api/v2/refund_payment` | ✅ `settlement_status` (PROCESSING/AVAILABLE/IN_PAYOUT/PAID) | TND أساسًا (المبالغ بالمليم) | ✅ | ✅ `type=card` | ✅ محفظة Flouci (`type=wallet`) + mp vice | ✅ **Adapter منفَّذ** — Sandbox جاهز عند توفّر المفاتيح |
| **ClicToPay (SPS Monétique Tunisie)** | Acquirer/Gateway بطاقات | ⚠️ لا بوابة API عامة؛ النماذج الرسمية توزّع من SPS/البنك (العقد العام المكتشَف: `register.do` / `getOrderStatus.do` — لاحظ أن بعض kits تستخدم `getOrderStatusExtended.do`) | ✅ Test credentials عبر البنك/SPS | `userName` + `password` في الطلب (REST) | ❌ لا webhook موقّع موثّق؛ `returnUrl`/`failUrl` فقط | ❌ غير موثّق → يُتحقق بـ`getOrderStatus.do` | ❌ غير موثّق علنًا (غير منفَّذ) | غير موثّق علنًا | TND (المبالغ بالـminor units) + عملات أخرى | ✅ | ✅ Visa/Mastercard + CIB | ❌ | ❌ | ✅ **Adapter منفَّذ** (register.do / getOrderStatus.do) — يحتاج host+credentials من SPS |
| **e-Dinar / D17 (La Poste Tunisienne)** | Wallet/Mobile + Cards | ❌ **لا API عام عبر الإنترنت** — Kit Marchand + تعاقد مباشر | ❌ غير متاح علنًا | غير موثّق | غير موثّق | غير موثّق | غير موثّق | غير موثّق | TND | ✅ | ✅ Visa/MC عبر Kit e-DINAR | ✅ (جوهر D17) | ❌ | ⏸️ **لم يُنفَّذ** — لا API موثّق؛ Adapter مؤجّل حتى التعاقد |
| **Visa / Mastercard مباشرة** | Schemes (ليست PSP) | ❌ لا يُقبل التاجر مباشرة | — | — | — | — | — | — | — | — | ✅ | — | — | ➡️ تُقبل **فقط** عبر Acquirer/Gateway (ClicToPay، Flouci، Konnect…) |
| **Konnect** | Gateway | ⚠️ لم تُفحَص وثائق عامة كافية | — | — | — | — | — | — | — | ✅ | ✅ + e-Dinar | ❌ | ❌ | ⏸️ خارج نطاق المهمة |

**الخلاصة المعمارية**: Visa وMastercard **ليست مزوّدين مستقلّين** يُدمجان مباشرة. القبول يتم عبر Gateway/Acquirer (تجاريًا: Flouci أو ClicToPay). لذلك في WASIT نُنمذجها كـ **schemes داخل method = CARD**، لا كـ providers منفصلة. D17 هو wallet لـ La Poste لا يوفّر API عامًا، لذا يبقى **قرار تعاقد** لا تكاملًا برمجيًا مخترعًا.

---

## 2. ما يمكن تنفيذه الآن مقابل ما ينتظر

### ✅ قابل للتنفيذ الآن (منفَّذ في هذه المهمة)
- **Multi-Provider / Multi-Method kernel**: `PaymentMethod` (CARD / MOBILE_WALLET)، schemes (VISA/MASTERCARD/CIB)، ووصف قدرات كل مزوّد.
- **Flouci adapter** كامل (generate / verify / refund) حسب وثائق `docs.flouci.com` الرسمية:
  - `POST https://developers.flouci.com/api/v2/generate_payment` — body: `amount` (بالمليم)، `developer_tracking_id`، `accept_card`، `success_link`، `fail_link`، `webhook`؛ response `result.payment_id` + `result.link`.
  - `GET /api/v2/verify_payment/{payment_id}` — الحالة: `SUCCESS|PENDING|EXPIRED|FAILURE|PREAUTH_SUCCESS|SYSTEM_FAILURE` + `settlement_status`.
  - `POST /api/v2/refund_payment` — `{payment_id}`.
  - Auth: `Bearer <PUBLIC_KEY>:<PRIVATE_KEY>`.
  - Sandbox `4509 2111 1111 1119` (Visa) / `5440 2127 1111 1110` (MC) — للاختبار فقط عند توفّر مفاتيح TEST APP.
- **ClicToPay adapter** (register.do / getOrderStatus.do) بصيغة الحقول المستخدمة في العقد العام المكتشَف — الـhost والاعتمادات تُمنح من SPS/البنك.
- **قاعدة أمان موحّدة**: لأن Flouci/ClicToPay لا يوثّقان HMAC للتويب هوك، الخدمة **تعيد التحقق من الحالة من المزوّد** قبل تطبيق أي side-effect (نمط Flouci الموصى به رسميًا)، وتطابق المبلغ/العملة.
- **Method selection API** + تخزين method على الـintent.
- **Offline/Manual provider** يبقى للاختبار والتطوير (بلا شبكة، بلا أموال حقيقية).

### ⏸️ يحتاج Merchant Account / Credentials (لا يعطّل الكود)
| البند | المطلوب |
|---|---|
| Flouci live | `FLOUCI_PUBLIC_KEY` + `FLOUCI_PRIVATE_KEY` (Production Tokens من Dashboard بعد KYB) |
| Flouci sandbox | مفاتيح TEST APP (فورية بعد رفع RNE) |
| ClicToPay | `CLICTOPAY_BASE_URL` (host من SPS/البنك) + `CLICTOPAY_USERNAME` + `CLICTOPAY_PASSWORD` |
| Webhook secrets | `PAYMENT_WEBHOOK_SECRET` (للـmanual/open-checkout فقط) |

### ⏸️ يحتاج تعاقد/موافقة (لا يُنفَّذ برمجيًا)
- **D17 / e-Dinar Kit Marchand**: طلب انضمام + CCP + شهادة ANCE (لا API عام).
- **ClicToPay**: طلب من البنك + عقد + مصادقة تقنية.
- **Flouci live**: KYB + زمن التفعيل (Wallet 2–4 أيام عمل، Cards 4–10 أيام عمل).

### ❓ غير قابل للتأكيد من الوثائق
- هل يوفّر Flouci **توقيع HMAC** على التويب هوك؟ الوثائق تذكر الحقل فقط دون آلية توقيع → لا نخترع توقيعًا؛ نتحقق عبر `verify_payment`.
- رسوم Flouci الرسمية لكل نوع بطاقة (الموقع يعرض فئات دون أرقام ملزمة).
- رسوم/exact orderStatus mapping في ClicToPay (النماذج العامة تعرض الأكواد دون جدول رسمي).
- هل يقبل مزوّد معيّن marketplace split (Flouci orchestration `destination[]` موجود لكن شروطه التعاقدية غير موثّقة علنًا).

---

## 3. التصميم المقترح لتعدد المزوّدين (Multi-Provider / Multi-Method)

### 3.1 المفاهيم
- **Provider**: الجهة التي تُنفّذ العملية (`flouci`, `clictopay`, `manual`, `noop`, `open-checkout`).
- **Method type**: `CARD` أو `MOBILE_WALLET`.
- **Scheme/network**: داخل CARD → `VISA` / `MASTERCARD` / `CIB`؛ داخل MOBILE_WALLET → `D17` / `FLOUCI_WALLET`.
- **Capability descriptor**: لكل مزوّد قائمة methods يدعمها + هل هو مُهيَّأ الآن (`available`) + سبب عدم التوفّر (`reason`).

### 3.2 Port موسّع (متوافق خلفيًا)
`lib/payments/port.ts` يبقى العقد الوحيد؛ يُضاف:
- `PaymentMethod` و`PaymentMethodType`.
- `createIntent` يقبل `method?`.
- `getStatus(externalRef)` اختياري.
- `requiresStatusRecheck` (bool): إن كان صحيحًا فالخدمة لا تثق بالتويب هوك وحده.
- `supportedMethods()`: يصف القدرات.

### 3.3 التوجيه (Routing)
- `PAYMENT_PROVIDER` يحدّد المزوّد الافتراضي.
- الطلب يمكن أن يطلب `method`؛ يُمرَّر للمزوّد ليقرّر القناة (Flouci: `accept_card` للبطاقة).
- endpoint `GET /api/payments/methods` يُرجع قدرات المزوّدين بما فيها غير المتوفّر مع السبب — لتُعرض/تُخفى في الواجهة دون كسر التدفق.

### 3.4 ضمانات محفوظة
idempotency · webhook verification/recheck · payment state machine · refund state machine · audit · ledger · order/payment consistency · authorization · فاصل Risk/Fraud.

---

## 4. المراجع الرسمية
- Flouci Payment API: https://docs.flouci.com (Introduction، Requests، Generate/Verify/Refund، Test، Go Live، Error Dictionary، llms.txt).
- ClicToPay (SPS Monétique Tunisie): النماذج الرسمية الموزَّعة (register.do / getOrderStatusExtended.do) — لا بوابة API عامة.
- e-Dinar / D17 (La Poste Tunisienne): Kit Marchand + عقد مباشر (لا API عام). الطلب عبر البريد/ANCE.
- SPS/Monétique Tunisie: لا توثيق API عام.

> ملاحظة: أي معلومة غير موثّقة في هذا الملف تُعدّ **DECISION REQUIRED** ولا تُنفَّذ برمجيًا.