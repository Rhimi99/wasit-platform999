# WASIT BUSINESS GLOBAL — MASTER GAP AUDIT

> **نوع الوثيقة**: تشخيص فقط (Diagnosis-only). لا إصلاح، لا migration، لا تغيير في الكود أو قاعدة البيانات.
> **تاريخ التدقيق**: 2026-09-24 (UTC) · **HEAD**: `bada224` · **الفرع**: `master`
> **المنهج**: قراءة الكود الفعلي (`packages/server/src`, `packages/web/src`, `e2e/`, `scripts/`) + مقارنته بالوثائق
> (`docs/PROJECT_BASELINE.md`, `docs/PRODUCTION_GAP_LIST.md`, `docs/PAYMENT_SETTLEMENT_AUDIT.md`,
> `docs/DEVELOPMENT_ROADMAP.md`, `docs/DEPLOYMENT.md`) + تحقق حيّ من قاعدة `wasit_demo` و`/api/*`.
> **قاعدة صارمة**: لا يُعتبر النقص مغلقًا إلا بدليل من الكود أو اختبار/تكامل حقيقي. E2E أخضر ≠ اكتمال تجاري.

---

## 1. ملاحظات دقّة على وثائق الأساس (قبل الجدول)

بعض 「الفجوات」 المذكورة كـ **مفتوحة** في التقارير السابقة **أُغلقت فعليًا في الكود** (تحقّقت منها سطرًا بسطر):

| التقارير تقول | الكود الفعلي | الحكم |
| --- | --- | --- |
| `PAYMENT_SETTLEMENT_AUDIT.md` RC-1: `transactions.status` يُدرج `'PAID'` قبل الدفع | `orders/service.ts:183` يُدرج `status: 'PENDING'` مع تعليق صريح، ويُرقّى عند `applyPaymentSucceeded` | ✅ **مُغلق** (الوثيقة stale) |
| RC-4: حدث `pending` ثم `succeeded` بنفس `eventId` يُبتلع كتكرار | `payments/service.ts:243-272`: لا يُحتسب مفتاح الـidempotency إلا لحدث نهائي (`isTerminal`) | ✅ **مُغلق** (الوثيقة stale) |
| RC-3: إشارة العمولة سالبة في تقرير ومطلقة في آخر | `lib/ledger-flows.ts`: مصدر واحد للدلالة (`flowMagnitude` + `abs`)، وكلَا التقريرين يستخدمانه | ✅ **مُغلق** (الوثيقة stale) |
| RC-5: الاسترداد لا يعكس العمولة/الرسوم | `payments/service.ts:317-380 reverseCommissionAndFee` يكتب قيود CREDIT عكسية نسبيًا | ✅ **مُغلق** (الوثيقة stale) |
| `DEVELOPMENT_ROADMAP.md`: «⚠️ لا اختبار مخصص لـ geo» و«364/364 اختبار، 52 E2E» | `geo.test.ts` = 16 حالة؛ الواقع الحالي 585 وحدة / 200 E2E | ⚠️ **Documentation Drift** |
| `WASIT_..._ADVANCED_STATUS_REPORT` (2026-09-14): Marketing Video = «CONTRACT فقط، `mediaUrl: null`» | مُنفَّذ فعليًا: مُصيّر ffmpeg/libass حقيقي، MP4 مُقاس من البايتات، معاينة/تنزيل/حذف | ⚠️ **Documentation Drift** (قديم) |

**الخلاصة**: نطاق الـPayment Kernel **أنضج** مما تصفه وثيقة التسوية؛ الفجوة الحقيقية ليست في تأكيد الدفع بل في
**ما بعد الدفع** (Settlement/Payout/Treasury/Reconciliation) وفي الطبقات القانونية/التشغيلية.

### ما تم التحقق من أنّه يعمل فعليًا (لا يُكسَر)
- **سياسة العمولة 4% = 2% + 2%** مُطبَّقة عبر Policy Engine (غير Hardcoded): طلب حيّ `grand_total = items + buyer_commission`،
  و`transaction_ledger` يحمل قيدَي `COMMISSION` (SELLER/BUYER) منفصلين + `PAYMENT_FEE` مستقل. مُتحقَّق من DB الحيّة.
- **Order → Intent → Webhook (HMAC) → Confirmation → Ledger** موصول كاملًا، مع رفض توقيع مزيّف وعدم إعادة تشغيل.
- **Refunds**: idempotent + منع over-refund + عكس العمولة/الرسوم + قيد `REFUND`.
- **Inventory**: حجز ذرّي قبل كتابة الطلب + تحرير/خصم حسب الانتقالات.
- **11 AI Agent** مُسجَّلون مع RBAC/capabilities/budget/usage/approval gate؛ Marketing Video E2E حقيقي (720×1280, d=35).
- **Disputes**: دورة حالة كاملة + Appeals + سياسة per-country + Audit.
- **Trust/Risk/Fee-evasion**: مطبَّقة ومختبرة، مع كشف التهريب على الرسالة الأولى.

---

## 2. جدول الفجوات الموحّد

**الفئات**: Product · Technical · Business · Production/Infra · Payment/Settlement · Security/Compliance ·
AI/Automation · Documentation · Test/Harness
**الشدة**: Critical · High · Medium · Low
**العمودان الأخيران**: Required before Pilot (P) / Required before Global Launch (G)

| ID | Gap | Category | Current State | Evidence | Severity | P | G |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PS-01 | لا طبقة Settlement: `settlement_status` لا يُكتب أبدًا، ولا كاتب لقيد `SETTLEMENT`، ولا جداول settlement | Payment/Settlement | `settlement_status` مُعرَّف (`commerce.ts:79`) لكن **صفر كتابة**؛ `SETTLEMENT` enum فقط (`commerce.ts:149`)؛ `ledger-flow` يقرأه فيعطيه 0 | `grep -rn "settlementStatus" src/modules` = ∅ · DB: كل الطلبات `settle=PENDING` · `count(SETTLEMENT)=0` | Critical | Yes | Yes |
| PS-02 | لا Seller/Merchant Payout: لا مسار يحوّل صافي مستحقّ البائع | Payment/Settlement | لا كود ولا جدول `payouts`/`settlement_accounts` | `grep -rniE "payout\|iban\|swift\|bank_transfer\|treasury" src` = ∅ | Critical | Yes | Yes |
| PS-03 | قدرة Split لدى المزوّد (iPay/ClicToPay/Flouci) **غير مؤكَّدة وغير موثَّقة** | Payment/Settlement | الكود يمرّر `metadata` للتسوية فقط؛ النموذج 1020→980+40 يحتاج split أو WASIT كحامل أموال | `docs/PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` §D: لا endpoint منشور للـsplit/sub-merchant/settlement/settlement_status | Critical | Yes | Yes |
| PS-04 | لا Reconciliation مع حساب المزوّد/البنك (لا Treasury) | Payment/Settlement | «التسوية» الحالية = حالة قيد محاسبي فقط (`transaction_ledger.status=SETTLED`) | `payments/service.ts:142` تعليق صريح: «provider record … NOT a user wallet» | Critical | Yes | Yes |
| PS-05 | لا مسار إتمام دفع `manual`/offline من الواجهة | Payment/Settlement | `manual` يُنشئ intent `PENDING` بـ`checkoutUrl=null`، ولا «settlement desk» في الويب | `lib/payments/providers.ts:50-79` · `grep web "settle\|markPaid"` = ∅ · CheckoutPage يبقى «بانتظار الدفع» | Critical | Yes | Yes |
| PS-06 | Refunds غير مدعومة في ClicToPay | Payment/Settlement | `refund()` يرمي 503 | `lib/payments/clictopay.ts:121-122` («not exposed via the documented REST API») | High | Yes | No |
| PS-07 | لا Credentials إنتاجية لمزوّد الدفع | Production/Infra | الكل يمرّ عبر `PaymentProviderPort`؛ لا مفاتيح حيّة | `.env.demo`: `PAYMENT_PROVIDER=manual`؛ `docs/PROJECT_BASELINE.md` §6 بند 3 | Critical | Yes | Yes |
| LC-01 | لا ToS / Privacy Policy / Cookie Policy (محتوى أو صفحات) | Security/Compliance | لا Route ولا نصّ قانوني في المستودع | `grep web "terms\|privacy policy\|cookie"` = ∅ · لا ملفات قانونية في `docs/` | Critical | Yes | Yes |
| LC-02 | لا التقاط موافقة الكوكيز/GDPR من الواجهة (API موجود) | Security/Compliance | `PUT /api/privacy/consents` موجود، لكن لا banner/UI | `modules/privacy/routes.ts:70` مقابل `grep web "cookie"` = ∅ | High | Yes | Yes |
| LC-03 | لا سياسة سلع محظورة (محتوى/إنفاذ) | Security/Compliance | لا قائمة ولا فلترة | `grep -rniE "prohibit\|banned\|restricted goods" src` = ∅ | High | Yes | Yes |
| LC-04 | لا Refund/Dispute Policy ولا Merchant/Buyer Terms (محتوى عام) | Security/Compliance | سياسات النزاع/الاستبقاء موجودة كـ**بيانات داخلية**، لا كنصوص تعاقدية عامة | `admin/policy-routes.ts` (داخلي) مقابل لا صفحات عامة | High | Yes | Yes |
| LC-05 | لا تكامل KYC/KYB/AML/sanctions — التحقق مراجعة وثائق بشرية | Security/Compliance | حقول `documentType/documentRef` + موافقة أدمن؛ لا مزوّد هوية | `modules/verification/service.ts:76,121` · `seed.ts:320` (requirements) · لا مزوّد | High | Yes | Yes |
| LC-06 | MFA غير مُلزم لموظّفي/مديري المنصّة | Security/Compliance | MFA اختياري لكل مستخدم؛ لا فرض على الأدوار الحسّاسة | `lib/env.ts` فيه TTL/attempts فقط؛ لا `MFA_ENFORCED`/`requireMfa` | High | Yes | Yes |
| LC-07 | لا قفل حساب دائم بعد محاولات دخول فاشلة (فقط rate-limit لكل IP) | Security/Compliance | لا عدّاد `loginAttempts`/`lockedUntil` | `grep "failedLogin\|lockedUntil\|loginAttempts"` = ∅ · `loginRateMax=15/60s` فقط | Medium | No | Yes |
| LC-08 | لا وثائق DPA/PCI/compliance في المستودع | Security/Compliance | لا ملفات | `ls docs/ \| grep compliance` = ∅ | Medium | No | Yes |
| PI-01 | لا بيئة إنتاج/Staging مستضافة فعلًا | Production/Infra | نطاق الريبو مكتمل (compose/CI/scripts)؛ البيئة الخارجية غائبة | `docs/PRODUCTION_GAP_LIST.md` E1 · `DEPLOYMENT.md` §9.1 | Critical | Yes | Yes |
| PI-02 | لا Domain/DNS/TLS إنتاجي | Production/Infra | لا إعداد نطاق | `docs/PROJECT_BASELINE.md` §6 بند 1-2 | Critical | Yes | Yes |
| PI-03 | النسخ الاحتياطي محلي فقط: لا تشفير، لا نقل offsite، لا WAL streaming | Production/Infra | سكربتات نسخ/استعادة مُختبَرة لكن بلا offsite/encryption | `grep -rniE "offsite\|s3\|encrypt" scripts/backup-db.sh` = ∅ · Baseline §6 بند 4 | High | Yes | Yes |
| PI-04 | لا جسر تنبيه مركزي مُهيّأ | Production/Infra | `OBS_ALERT_NOTIFY=webhook` مدعوم لكن لا endpoint/قناة مُهيّأة | `DEPLOYMENT.md` §6 · Baseline §6 بند 5 | Medium | No | Yes |
| PI-05 | لا Error tracking (Sentry/Datadog) | Production/Infra | لا تكامل | `grep -rniE "sentry\|bugsnag\|datadog" src` = ∅ | Medium | No | Yes |
| PI-06 | تخزين الوسائط محلي فقط (لا Object Storage) | Production/Infra | `resolveMediaStorage()` = `local` فقط | `lib/media/resolve.ts` (لا حالة S3) | Medium | No | Yes |
| PI-07 | Rate limiter افتراضيًا في الذاكرة (غير صالح لأكثر من نسخة) | Technical | وضع `postgres` مدعوم لكن يجب تفعيله صراحةً | `DEPLOYMENT.md` §2 · `middleware/rate-limit.ts:32` | Medium | No | Yes |
| PI-08 | Scheduler داخلي العملية (افتراض نسخة واحدة) | Technical | لا قفل موزّع كامل؛ اعتماد على optimistic lock فقط | `lib/scheduler.ts:14` · `index.ts:4` | Medium | No | Yes |
| PI-09 | لا مفاتيح AI provider إنتاجية | Production/Infra | الافتراضي `local-heuristic` | `.env.demo`: `AI_PROVIDER=local-heuristic` · `lib/ai/provider.ts:204` | Medium | No | Yes |
| PI-10 | Email/SMS افتراضيًا `log`؛ لا بوابة إنتاجية | Production/Infra | المنافذ جاهزة (SMTP/HTTP) بلا مزوّد مُهيّأ | `.env.demo`: `MAIL_TRANSPORT=log`, `SMS_TRANSPORT=log` | Medium | No | Yes |
| PI-11 | لا HA/DR (replica/multi-region/failover) | Production/Infra | لا إعداد | لا كود/إعداد replica | Medium | No | Yes |
| PR-01 | لا Cart دائم/دفع متعدد البنود من الواجهة | Product | `CheckoutPage` يشتري **منتجًا واحدًا** (`productId` + `qty`)؛ لا سلة | `App.tsx:86` · `CheckoutPage.tsx:91-93` (`items:[{…}]`) · لا جدول cart | Medium | No | Yes |
| PR-02 | Admin Desks ناقصة: Merchants/Suppliers/Companies/Categories/Currencies/Languages/Commissions | Product | لا مسارات admin لها (فقط users/products/orders/transactions/ledger/audit + engines) | `grep "admin/merchants\|admin/suppliers\|admin/companies\|admin/commissions"` = ∅ · `admin/routes.ts` | High | No | Yes |
| PR-03 | أسطح أدوار Placeholder: Branches، Employees | Product | EmptyState بلا Backend | `DashboardListPages.tsx:322-334` | Medium | No | Yes |
| PR-04 | أسطح Placeholder: Sales، Finance، Reports | Product | بطاقات «—» ثابتة/نص roadmap | `DashboardInventoryPages.tsx:438` · `DashboardListPages.tsx:338,352` | Medium | No | Yes |
| PR-05 | Business Calculator `/tools/calculator` غير منفَّذ | Product | لا Route ولا وحدة | `grep web "calculator"` = ∅ · Baseline §5 | Medium | No | Yes |
| PR-06 | Business/Market Map `/map` غير منفَّذ | Product | لا Route ولا وحدة | `App.tsx` (لا `/map`) · Baseline §5 | Medium | No | Yes |
| PR-07 | Offers (Supplier) غير منفَّذة | Product | لا وحدة | Baseline §5 | Medium | No | Yes |
| PR-08 | Recommendations (Customer) غير منفَّذة | Product | لا وحدة | Baseline §5 | Low | No | No |
| PR-09 | لا قنوات تسليم للإشعارات (Email/SMS/Push) — In-app فقط | Product | `sendMail/sendSms` تُستدعى في `auth` فقط، لا في `notifications` | `grep "sendMail\|sendSms" modules/notifications` = ∅ | High | Yes | Yes |
| PR-10 | لا مركز تفضيلات إشعارات | Product | لا preferences (فقط privacy consents) | `notifications/routes.ts` (list/read فقط) | Medium | No | Yes |
| PR-11 | لا Support Desk / آلية تصعيد دعم | Product | المراسلة بين المستخدمين فقط؛ لا ticket/queue دعم | لا وحدة support/tickets | Medium | No | Yes |
| PR-12 | WASIT AI Copilot غير منفَّذ (اختياري صراحةً) | Product | مواصفة فقط | `docs/AI_ARCHITECTURE.md` §6.5 · Roadmap «مستقبلي» | Low | No | No |
| AI-01 | الوكلاء طلب-استجابة فقط؛ لا تنفيذ autonomous/مجدول | AI/Automation | لا scheduler/cron للوكلاء | `grep -rniE "schedule\|cron\|autonomous" modules/ai lib/ai` = ∅ | Medium | No | Yes |
| AI-02 | Marketing Video متزامن؛ مسار المزوّد غير المتزامن غير منفَّذ | AI/Automation | `isAsync` مُعرَّف في النوع، لا polling pipeline | `lib/media/video-types.ts:53` · `video-provider.ts:168` (`isAsync=false`) | Low | No | No |
| AI-03 | توجيه النزاعات/الدعم تلقائيًا إلى Agent غير موصول بطابور | AI/Automation | `dispute-assistant`/`support-agent` موجودان لكن تشغيلهما يدوي | `modules/ai/agents.ts:54,94` | Low | No | No |
| DO-01 | `PAYMENT_SETTLEMENT_AUDIT.md` stale (يعرض RC-1/3/4/5 كمفتوحة وهي مُصلَحة) | Documentation | خطر قرارات خاطئة | §1 أعلاه (الأدلة من الكود) | Medium | Yes | No |
| DO-02 | `DEVELOPMENT_ROADMAP.md` drift (أعداد اختبارات، ادعاء غياب اختبار geo) | Documentation | أرقام قديمة | Roadmap vs `geo.test.ts`/الواقع | Low | No | Yes |
| DO-03 | تقرير 2026-09-14 يقول Marketing Video «contract only» | Documentation | متجاوَز | §1 أعلاه | Low | No | No |
| TH-01 | لا اختبارات لـSettlement/Payout/Reconciliation (لعدم وجودها) | Test/Harness | لا شيء يُختبر | متعدد PS-01..04 | Medium | No | Yes |
| TH-02 | أسطح Placeholder غير مغطّاة بـE2E | Test/Harness | لا تغطية للأسطح «—» | PR-03/04 | Low | No | Yes |
| TH-03 | 8 اختبارات demo-gated تُتخطّى في E2E العادي | Test/Harness | SKIP ما لم يُفعّل auto-login | `functional-audit.spec.ts` (8 skipped) | Low | No | Yes |
| BU-01 | لا عقد مزوّد دفع حقيقي (تأكيد split/settlement من iPay) | Business | None (تجاري خارجي) | `PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` §A/§M/§O | Critical | Yes | Yes |
| BU-02 | لا حساب تسوية/بنكي لـWASIT | Business | None | PS-01/PS-04 + Baseline §6 | Critical | Yes | Yes |
| BU-03 | لا عقد مزوّد KYC/KYB | Business | None | LC-05 | High | Yes | Yes |
| BU-04 | لا موردين/مشترين حقيقيين ولا سيولة سوق أولية | Business | بيانات demo فقط | seed-demo | High | Yes | Yes |
| BU-05 | لا قناة اكتساب عملاء | Business | None | خارج الكود | Medium | No | Yes |
| BU-06 | لا سياسة بلد إطلاق تشغيلية (سلع محظورة/ضرائب) | Business | فعّل/عطّل بلد متاح تقنيًا فقط | `admin/country-routes.ts` + LC-03 | Medium | Yes | Yes |
| BU-07 | الامتثال الضريبي/المحاسبي (فواتير المزوّد فقط) | Business | iPay يوفّر فواتير ضريبية، لا فاتورة marketplace | iPay audit §F/E12 | Medium | No | Yes |
| BU-08 | لا آلية دعم/تصعيد تشغيلية | Business | لا عملية (Software PR-11 + Agent ممكنان) | PR-11 | Medium | No | Yes |

---

## 3. التصنيف النهائي (القوائم الأربع)

### 1) BLOCKERS — تمنع Pilot حقيقيًا بمال فعلي
- **PS-01** لا طبقة Settlement (لا كاتب لـ`SETTLEMENT`/`settlement_status`).
- **PS-02** لا Seller/Merchant Payout.
- **PS-03** قدرة Split لدى المزوّد غير مؤكَّدة/موثّقة.
- **PS-04** لا Reconciliation/Treasury مع المزوّد/البنك.
- **PS-05** لا مسار إتمام دفع `manual`/offline من الواجهة.
- **PS-07** لا Credentials إنتاجية لمزوّد الدفع.
- **PI-01 / PI-02** لا بيئة إنتاج/Staging مستضافة، ولا Domain/DNS/TLS.
- **LC-01** لا ToS/Privacy/Cookie Policy.
- **LC-05** لا KYC/KYB/AML provider.
- **PR-09** لا قنوات تسليم للإشعارات (In-app فقط) — يمنع إشعارًا موثوقًا بالمعاملات.
- **BU-01 / BU-02 / BU-03 / BU-04 / BU-06** (تجارية): لا عقد مزوّد، لا حساب تسوية، لا مزوّد KYC، لا موردين/مشترين، لا سياسة بلد.

### 2) PRE-LAUNCH GAPS — تُغلق قبل إطلاق تجاري حقيقي
- **LC-02** موافقة كوكيز/GDPR من الواجهة.
- **LC-03** سياسة سلع محظورة.
- **LC-04** Refund/Dispute Policy + Merchant/Buyer Terms.
- **LC-06** إلزام MFA للـstaff/admin.
- **LC-07** قفل حساب دائم بعد فشل الدخول المتكرر.
- **LC-08** وثائق DPA/compliance.
- **PI-03** نسخ خارجية + تشفير + WAL.
- **PI-04** جسر تنبيه مركزي.
- **PI-05** Error tracking.
- **PI-06** Object storage للوسائط.
- **PI-07** Rate limiter موزّع.
- **PI-08** Scheduler موزّع.
- **PI-09** مفاتيح AI إنتاجية.
- **PI-10** Email/SMS إنتاجي.
- **PI-11** HA/DR.
- **PS-06** Refunds في ClicToPay.
- **PR-02** Admin Desks (Merchants/Suppliers/Companies/Categories/Currencies/Languages/Commissions).
- **PR-10** تفضيلات الإشعارات.
- **PR-11 / BU-08** Support Desk/التصعيد.
- **DO-01** تحديث وثيقة التسوية (تجنّب قرارات خاطئة).
- **TH-01** اختبارات Settlement/Payout.

### 3) POST-LAUNCH / SCALE — قابلة للتأجيل
- **PR-01** Cart/دفع متعدد البنود.
- **PR-03** Branches/Employees.
- **PR-04** Sales/Finance/Reports.
- **PR-05** Business Calculator.
- **PR-06** Business/Market Map.
- **PR-07** Offers (Supplier).
- **PR-08** Recommendations (Customer).
- **AI-01** تنفيذ الوكلاء autonomous/مجدول.
- **AI-02** مسار فيديو غير متزامن (مزوّد خارجي).
- **AI-03** توجيه تلقائي للنزاعات/الدعم إلى Agent.
- **DO-02 / DO-03** ضبط drift التوثيق.
- **TH-02 / TH-03** توسيع التغطية.
- **BU-05** قناة اكتساب العملاء.
- **BU-07** الامتثال الضريبي المتقدّم.

### 4) FALSE GAPS — تبدو ناقصة لكنها غير مطلوبة لسبب حقيقي
- **Wallet / رصيد داخل المنصّة**: غير مطلوب بالتصميم (لا Wallet في المواصفات) — يُثبت بوضوح في `PAYMENT_SETTLEMENT_AUDIT.md` §5.
- **تخزين بيانات البطاقات / PCI DSS**: خارج النطاق لأن الدفع **redirect إلى مزوّد مرخّص**؛ لا بيانات بطاقة تلمس النظام.
- **Arbitration/Mediation قانوني خارجي داخل الكود**: المنصّة تملك دورة قرار/استئناف فعلية؛ التحكيم القانوني **عملية تجارية**، لا وحدة برمجية.
- **إصدار الفواتير الضريبية**: يوفّره المزوّد (iPay: فواتير عربية) — لا يُعاد بناؤه.
- **WASIT AI COPILOT**: **اختياري صريحًا** في المواصفات (`AI_ARCHITECTURE.md` §6.5) — ليس متطلب إطلاق.
- **Push notifications**: يمكن حلها بمزوّد/API خارجي (FCM) دون بناء داخلي — ليست فجوة معمارية.
- **«نحتاج موظّفين»**: **مرفوض كحل افتراضي**؛ لكل فجوة أعلاه مسار Software (PS/PR/PI)، أو Agent (AI-01/AI-03/PR-11)، أو Provider/API خارجي (LC-05, BU-01, PI-05/06/09/10)، والتدخل البشري يبقى **استثنائيًا** لا افتراضيًا.
- **Modules فارغة (analytics/geo/users/transactions)**: ادعاء قديم متجاوَز — هذه الوحدات لها `routes+service+tests` فعلية.

---

## 4. الأعداد

| المقياس | العدد |
| --- | --- |
| **إجمالي الفجوات الحقيقية** | **64** (55 صفًّا في الجدول أعلاه + 9 بنود حُسمت في §3) |
| **BLOCKERS** (شدة + تبعية) | **16** |
| **PRE-LAUNCH GAPS** | **22** |
| **POST-LAUNCH / SCALE** | **16** |
> **ملاحظة عدّ**: القوائم الثلاث الأولى **غير متقاطعة** (16 + 22 + 16 = 54 فجوة) + `PR-12` (اختياري صراحةً) = **55 صفًّا** في الجدول، + 9 بنود في §3 (منها FALSE GAPS الثمانية) = **64 فجوة مُشخَّصة**.
> مقياسا الجدول: **P=Yes** = 23 قبل Pilot، **G=Yes** = 48 قبل الإطلاق العالمي — و«BLOCKERS» تصنيف تشغيلي فلا يلزم تطابق عضويته مع العمود الزمني.
> **FALSE GAPS ليست صفوفًا في الجدول** — هي 8 ادعاءات نقص شائعة فُحصت ورُفضت.

---

## 5. أهم 10 نواقص حقيقية مرتّبة حسب تأثيرها على الإطلاق

| # | Gap | لماذا هو الأعلى تأثيرًا |
| --- | --- | --- |
| 1 | **PS-01** لا Settlement | لا مال يصل إلى WASIT؛ `settlement_status` جامد → كل تقارير التسوية كاذبة هيكليًا |
| 2 | **PS-02** لا Payout للبائع | لا يستطيع المورّد استلام 980 → يفرغ السوق من البائعين |
| 3 | **PS-03** Split المزوّد غير مؤكَّد | النموذج المالي (1020 = 980 + 40) بلا مسار تنفيذي مثبت |
| 4 | **BU-01/BU-02** لا عقد مزوّد ولا حساب تسوية | بلا كيان قانوني/بنكي، لا يمكن تحصيل أو توزيع |
| 5 | **PS-04** لا Reconciliation/Treasury | لا مطابقة بين ما عند المزوّد وما في الدفاتر/البنك → مخاطر محاسبية |
| 6 | **PI-01/PI-02** لا بيئة إنتاج + Domain/TLS | لا إطلاق حقيقي ممكن |
| 7 | **LC-01** لا ToS/Privacy/Cookie | يمنع التشغيل القانوني (تونس وEU/FR) |
| 8 | **LC-05** لا KYC/KYB/AML | لا يمكن التحقق من المورّدين/التجار بشكل نظامي |
| 9 | **PS-05** لا مسار إتمام الدفع اليدوي | كل عملية `manual` تبقى «معلّقة» بلا مخرج من الواجهة |
| 10 | **PI-03** نسخ بلا offsite/تشفير/WAL | فقدان بيانات = توقف أعمال بلا تعافٍ مضمون |

> **تنبيه**: لم يُنفَّذ أي إصلاح في هذه المهمة. التشخيص فقط. لا migration/reset/drop/push، ولا تغيير في DB،
> ولا مساس بسياسة العمولة (4% = 2%+2%) أو Marketing Video Agent أو الـPayment Kernel أو RBAC.
