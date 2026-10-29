# WASIT BUSINESS GLOBAL — MASTER GAP AUDIT

> **نوع الوثيقة**: تشخيص فقط (Diagnosis-only). لا إصلاح، لا migration، لا تغيير في الكود أو قاعدة البيانات.
> **تاريخ التدقيق**: 2026-09-24 (UTC) · **HEAD**: `bada224` · **الفرع**: `master`
> **المنهج**: قراءة الكود الفعلي (`packages/server/src`, `packages/web/src`, `e2e/`, `scripts/`) + مقارنته بالوثائق
> (`docs/PROJECT_BASELINE.md`, `docs/PRODUCTION_GAP_LIST.md`, `docs/PAYMENT_SETTLEMENT_AUDIT.md`,
> `docs/DEVELOPMENT_ROADMAP.md`, `docs/DEPLOYMENT.md`) + تحقق حيّ من قاعدة `wasit_demo` و`/api/*`.
> **قاعدة صارمة**: لا يُعتبر النقص مغلقًا إلا بدليل من الكود أو اختبار/تكامل حقيقي. E2E أخضر ≠ اكتمال تجاري.

> **تصحيح PS-01-A (توثيقي فقط) — الفرع `ci/repair-sandbox-2u-g-20261020-190057` · HEAD `9fa85ae4`**:
> هذا التدقيق كُتب عند HEAD `bada224`، ثم نُفِّذت طبقة التسوية/الدفع للمورّد/المطابقة في commits لاحقة
> (`1ecfc23` PS-01 · `e9a99de` PS-02 · `de59216` PS-02/PS-04 schema · `12c3949` provenance). لذلك صفوف
> `PS-01` و`PS-02` و`PS-04` أدناه **قديمة** ويجب قراءتها مع «الملحق أ» في نهاية هذا الملف.
> لم يُغيَّر أي كود تسوية في هذا التصحيح؛ الإغلاق المُعلَن هو **إغلاق منطقي برمجي**، ولا يعني اكتمالًا تجاريًا/إنتاجيًا.

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
| PS-01 | طبقة Settlement: **مغلقة منطقيًا** (كانت: `settlement_status` لا يُكتب أبدًا، ولا كاتب لقيد `SETTLEMENT`) — التفاصيل في «الملحق أ» | Payment/Settlement | `modules/settlements/service.ts:74 confirmSettlement` هو **الكاتب الوحيد** لـ`transaction_ledger.status='SETTLED'` (سطر 149) و**الكاتب الوحيد** لقيد `SETTLEMENT` (سطر 165)، خلف دليل إلزامي (`settlementRef` سطر 39/75) داخل `db.transaction` مع قفل `FOR UPDATE` (سطر 125) + ترقية `orders.settlementStatus='SETTLED'` (سطر 181) + Audit `SETTLEMENT.CONFIRMED` (سطر 185). مُفوَّض من الـwebhook (`payments/service.ts:370`) ومسار إداري (`finance/routes.ts:117` على `/api/admin/finance`، `app.ts:126`) | `tests/settlement-ledger.test.ts` (9 حالات) · `tests/money-path-invariants.test.ts` (9) · `tests/persistence-invariants.test.ts` · `e2e/settlement-integrity.spec.ts` (4) · `scripts/verify-money-path.ts` | ~~Critical~~ → **Closed (logic)** | No | Yes |
| PS-02 | Seller Payout: **مغلقة منطقيًا** (كانت: لا مسار يحوّل صافي مستحقّ البائع) — التفاصيل في «الملحق أ» | Payment/Settlement | محرّك خالص `modules/payouts/engine.ts` (`CREATED→PROCESSING→COMPLETED/FAILED/HELD`؛ `COMPLETED` يتطلّب `payoutRef` + مطابقة مبلغ/عملة) + تخزين `modules/payouts/service.ts` + جدول `payouts` (migration `0024`، CHECK `payouts_completed_requires_ref`) + منفّذ المزوّد `provider-service.ts`؛ صافي البائع = `itemsTotal − sellerCommission` (سطر `engine.ts:computeSellerPayable`) | `tests/payout-engine.test.ts` (11) · `tests/payout-provider.test.ts` (20) · `tests/finance-routes.test.ts` (16) · `tests/persistence-invariants.test.ts` | ~~Critical~~ → **Closed (logic)** | No | Yes |
| PS-03 | قدرة Split لدى المزوّد (iPay/ClicToPay/Flouci) **غير مؤكَّدة وغير موثَّقة** — **تبقى مفتوحة (مسارات مستقل، لا يُغلقها PS-01-A)** | Payment/Settlement | الكود يمرّر `metadata` للتسوية فقط؛ النموذج 1020→980+40 يحتاج split أو WASIT كحامل أموال | `docs/PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` §D: لا endpoint منشور للـsplit/sub-merchant/settlement/settlement_status | Critical | Yes | Yes |
| PS-04 | Reconciliation/Treasury: **مغلقة منطقيًا** (كانت: لا Reconciliation مع حساب المزوّد/البنك) — التفاصيل في «الملحق أ» | Payment/Settlement | محرّك مطابقة ثلاثية خالص `modules/reconciliation/engine.ts` (Provider ↔ Bank ↔ Ledger بفروق مصنَّفة تظهر MISMATCH) + تخزين `service.ts` + جداول `reconciliation_{imports,lines,decisions}` (migration `0024`) + provenance `provenance.ts` + Receipt `receipt-service.ts` | `tests/reconciliation-engine.test.ts` (17) · `tests/finance-routes.test.ts` (16) · `tests/persistence-invariants.test.ts` | ~~Critical~~ → **Closed (logic)** | No | Yes |
| PS-05 | مسار إتمام دفع `manual`/offline: **مغلق على هذا الفرع** — `POST /api/payments/orders/:orderId/complete-manual` (`payments/service.ts:950`) + واجهة `/admin/orders` (`AdminPages.tsx:385`، `admin-order-complete-manual-<id>`) | Payment/Settlement | كان: `manual` يُنشئ intent `PENDING` بلا مخرج من الويب | `payments/routes.ts:77` · `e2e/manual-payment.spec.ts` · `tests/manual-payment-completion.test.ts` | ~~Critical~~ → **Closed (demo rail only)** | No | Yes |
| PS-06 | Refunds غير مدعومة في ClicToPay | Payment/Settlement | `refund()` يرمي 503 | `lib/payments/clictopay.ts:121-122` («not exposed via the documented REST API») | High | Yes | No |
| PS-07 | لا Credentials إنتاجية لمزوّد الدفع | Production/Infra | الكل يمرّ عبر `PaymentProviderPort`؛ لا مفاتيح حيّة | `.env.demo`: `PAYMENT_PROVIDER=manual`؛ `docs/PROJECT_BASELINE.md` §6 بند 3 | Critical | Yes | Yes |
| LC-01 | لا ToS / Privacy Policy / Cookie Policy (محتوى أو صفحات) | Security/Compliance | لا Route ولا نصّ قانوني في المستودع | `grep web "terms\|privacy policy\|cookie"` = ∅ · لا ملفات قانونية في `docs/` | Critical | Yes | Yes |
| LC-02 | التقاط موافقة الكوكيز/GDPR من الواجهة (API موجود) — **مُغلق تقنيًا** | Security/Compliance | `PUT /api/privacy/consents` + `GET /api/privacy/me` خلف `requireAuth`؛ الواجهة تعرض banner للزيارة الأولى + بطاقة إعدادات وتكتب عبر الـendpoint الحقيقي | `packages/web/src/components/CookieConsent.tsx` · `e2e/cookie-consent.spec.ts` · `security-privacy.test.ts` (رفض الزائر المجهول + التطبيع). لا يوجد endpoint موافقة مجهول، والكوكي الوحيد هو جلسة أساسية — موثَّق في `FINAL-AUDIT.md` | High | Yes | Yes |
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
| PR-02 | Admin Desks ناقصة: Merchants/Suppliers/Companies/Categories/Currencies/Languages/Commissions — **جزئيًا مُغلق**: تمّت إضافة مكتب تحقق للموردين/التجار/الشركات | Product | `/api/admin/trade/{suppliers,merchants,companies}` (GET/PATCH) خلف `requireAuth`+`requireRole('ADMIN','SUPER_ADMIN')`+`requirePermission` لكل نوع؛ `verified`/`isActive` أصبح لهما مسار كتابة مُدقّق (`TRADE.VERIFIED`/`TRADE.SUSPENDED`/…). لا تزال Categories/Currencies/Languages/Commissions بلا مسارات admin | `modules/admin/trade-routes.ts` · `modules/admin/trade-service.ts` · `AdminTradePage.tsx` · `admin-trade.test.ts` · `e2e/admin-trade.spec.ts` | High | Partial | Yes |
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
| TH-01 | اختبارات Settlement/Payout/Reconciliation: **مغلقة** (كانت: لا شيء يُختبر لعدم وجود الوحدات) | Test/Harness | الاختبارات موجودة ومحصورة: `settlement-ledger.test.ts` (9) · `payout-engine.test.ts` (11) · `payout-provider.test.ts` (20) · `reconciliation-engine.test.ts` (17) · `finance-routes.test.ts` (16) · `persistence-invariants.test.ts` · `money-path-invariants.test.ts` (9) · `e2e/settlement-integrity.spec.ts` (4) · `e2e/admin-finance.spec.ts` (15) | تغطية خادمية كاملة للوحدات + **E2E لمسارات `/api/admin/finance/*` مُغلقة** (`e2e/admin-finance.spec.ts`، 15 حالة: settlements/confirm + payouts)؛ **تبقى فجوة الواجهة (UI) مستقلة** (الملحق أ.5-1) | ~~Medium~~ → **Closed (unit/integration/E2E)** | No | Yes |
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
> **تصحيح PS-01-A**: `PS-01`/`PS-02`/`PS-04` **لم تعد blockers برمجية** — نُفِّذت منطقيًا (انظر «الملحق أ»).
> ما يبقى مانعًا فعليًا في المسار المالي هو **المتطلبات الخارجية**: `PS-03` (split المزوّد) · `PS-07`
> (credentials إنتاجية) · `BU-01` (عقد مزوّد) · `BU-02` (حساب تسوية/بنكي) — وهذه لا يُغلقها أي كود داخلي.
- ~~**PS-01** لا طبقة Settlement~~ → **مُغلقة منطقيًا** (`modules/settlements/service.ts` + 9 اختبارات + E2E).
- ~~**PS-02** لا Seller/Merchant Payout~~ → **مُغلقة منطقيًا** (`modules/payouts/*` + migration `0024`).
- **PS-03** قدرة Split لدى المزوّد غير مؤكَّدة/موثّقة — **تبقى مفتوحة** (مسار مستقل، خارجي).
- ~~**PS-04** لا Reconciliation/Treasury~~ → **مُغلقة منطقيًا** (`modules/reconciliation/*` + migration `0024`).
- ~~**PS-05** لا مسار إتمام دفع `manual`/offline~~ → **مُغلقة على هذا الفرع** (مسار `complete-manual` + واجهة؛ للمزوّد التجريبي فقط).
- **PS-07** لا Credentials إنتاجية لمزوّد الدفع — **تبقى مفتوحة** (بنية/تعاقد خارجي).
- **PI-01 / PI-02** لا بيئة إنتاج/Staging مستضافة، ولا Domain/DNS/TLS.
- **LC-01** لا ToS/Privacy/Cookie Policy.
- **LC-05** لا KYC/KYB/AML provider.
- **PR-09** لا قنوات تسليم للإشعارات (In-app فقط) — يمنع إشعارًا موثوقًا بالمعاملات.
- **BU-01 / BU-02 / BU-03 / BU-04 / BU-06** (تجارية): لا عقد مزوّد، لا حساب تسوية، لا مزوّد KYC، لا موردين/مشترين، لا سياسة بلد.

### 2) PRE-LAUNCH GAPS — تُغلق قبل إطلاق تجاري حقيقي
- **LC-02** موافقة كوكيز/GDPR من الواجهة — **مُغلق تقنيًا** (banner + بطاقة إعدادات؛ انظر `FINAL-AUDIT.md`). يبقى الاعتماد القانوني لنصوص السياسات (LC-01).
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
- ~~**TH-01** اختبارات Settlement/Payout~~ → **مُغلقة** (اختبارات الوحدات + E2E لمسارات `/api/admin/finance/*` في `e2e/admin-finance.spec.ts`)؛ تبقى فجوة **الواجهة (UI)** لمسارات المالية مستقلة (الملحق أ.5-1).

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

> **تصحيح PS-01-A**: الأعداد أدناه تعكس التدقيق الأصلي (HEAD `bada224`) ولا تُعاد صياغتها بأثر رجعي.
> الفرق الحالي: `PS-01`/`PS-02`/`PS-04` و`TH-01` خرجت من قائمة «مفتوح» منطقيًا (انظر «الملحق أ»).

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

> **تصحيح PS-01-A**: الصفوف 1 و2 و5 (PS-01/PS-02/PS-04) **لم تعد نواقص برمجية**؛ بقي تأثيرها
> فقط عبر اعتمادها على متطلبات خارجية (`PS-03`/`PS-07`/`BU-01`/`BU-02`). أُبقيت هنا موسومة ~~مُشطوبة~~
> للحفاظ على أثر التدقيق الأصلي.

| # | Gap | لماذا هو الأعلى تأثيرًا |
| --- | --- | --- |
| 1 | ~~**PS-01** لا Settlement~~ → **مُغلقة منطقيًا** | ~~لا مال يصل إلى WASIT~~ — المنطق موجود؛ الأثر المتبقّي: لا إثبات حركة فعلية بلا `PS-07`/`BU-01` |
| 2 | ~~**PS-02** لا Payout للبائع~~ → **مُغلقة منطقيًا** | ~~المورّد لا يستلم 980~~ — المحرّك والتخزين موجودان؛ يبقى تنفيذ تحويل فعلي (مزوّد/بنك) |
| 3 | **PS-03** Split المزوّد غير مؤكَّد | النموذج المالي (1020 = 980 + 40) بلا مسار تنفيذي مثبت — **فجوة خارجية قائمة** |
| 4 | **BU-01/BU-02** لا عقد مزوّد ولا حساب تسوية | بلا كيان قانوني/بنكي، لا يمكن تحصيل أو توزيع |
| 5 | ~~**PS-04** لا Reconciliation/Treasury~~ → **مُغلقة منطقيًا** | ~~لا مطابقة~~ — المطابقة الثلاثية موجودة؛ يبقى استيراد كشوف فعلية من المزوّد/البنك |
| 6 | **PI-01/PI-02** لا بيئة إنتاج + Domain/TLS | لا إطلاق حقيقي ممكن |
| 7 | **LC-01** لا ToS/Privacy/Cookie | يمنع التشغيل القانوني (تونس وEU/FR) |
| 8 | **LC-05** لا KYC/KYB/AML | لا يمكن التحقق من المورّدين/التجار بشكل نظامي |
| 9 | ~~**PS-05** لا مسار إتمام الدفع اليدوي~~ → **مُغلقة على هذا الفرع** | ~~عمليات `manual` تبقى معلّقة~~ — المسار والواجهة موجودان (للمزوّد التجريبي فقط) |
| 10 | **PI-03** نسخ بلا offsite/تشفير/WAL | فقدان بيانات = توقف أعمال بلا تعافٍ مضمون |

> **تنبيه**: لم يُنفَّذ أي إصلاح في هذه المهمة. التشخيص فقط. لا migration/reset/drop/push، ولا تغيير في DB،
> ولا مساس بسياسة العمولة (4% = 2%+2%) أو Marketing Video Agent أو الـPayment Kernel أو RBAC.

---

## الملحق أ — إغلاق PS-01/PS-02/PS-04 (تصحيح PS-01-A)

> **السياق**: هذا الملف كُتب عند HEAD `bada224`. بعد ذلك نُفِّذت طبقات حركة المال في commits لاحقة على
> الفرع `ci/repair-sandbox-2u-g-20261020-190057`. هذا الملحق يوثّق الأدلة الفعلية من الكود الحالي
> **دون تغيير أي كود**، ويفصل بين (أ) منطق التسوية المُنجَز و(ب) الفجوات المتبقية (واجهة/E2E/خارجية).

### أ.1 الأدلة من الكود (HEAD `9fa85ae4`)

| المرحلة | الوحدة/الملف | الدليل |
| --- | --- | --- |
| **PS-01 Settlement** | `packages/server/src/modules/settlements/service.ts` | `confirmSettlement` (سطر 74) — الكاتب الوحيد لـ`transaction_ledger.status='SETTLED'` (سطر 149) والكاتب الوحيد لقيد `SETTLEMENT` (سطر 165)؛ دليل إلزامي `settlementRef` (سطر 39/75)؛ مطابقة amount/currency؛ `db.transaction` + قفل `FOR UPDATE` (سطر 125)؛ ترقية `orders.settlementStatus='SETTLED'` (سطر 181)؛ Audit `SETTLEMENT.CONFIRMED` (سطر 185) |
| تفويض الـwebhook | `modules/payments/service.ts` | استيراد (سطر 18)؛ بوابة `capabilities.settlementEvidence` (سطر 272)؛ استدعاء `confirmSettlement` (سطر 370) |
| مسار HTTP | `modules/finance/routes.ts` | `POST /settlements/confirm` (سطر 117) بصلاحية `payment:read`/`commission:manage`؛ مثبَّت في `app.ts:126` على `/api/admin/finance` |
| **PS-02 Payout** | `modules/payouts/engine.ts` · `service.ts` · `provider-service.ts` | محرّك خالص `CREATED→PROCESSING→COMPLETED/FAILED/HELD`؛ `COMPLETED` يتطلّب `payoutRef` + مطابقة؛ `assertPayoutCapable` يمنع مزوّد الديمو؛ صافي البائع = `itemsTotal − sellerCommission` |
| **PS-04 Reconciliation** | `modules/reconciliation/engine.ts` · `service.ts` · `provenance.ts` · `receipt-service.ts` | مطابقة ثلاثية Provider ↔ Bank ↔ Ledger بفروق مصنَّفة (MISMATCH لا يتحوّل لنجاح)؛ تخزين idempotent بـ`(source, checksum)`؛ provenance لا يخمّن |
| Schema/migration | `db/schema/{payouts,reconciliation,receipts}.ts` · `migrations/0024_remarkable_redwing.sql` | 5 enums + 5 جداول + 20 index + CHECK `payouts_completed_requires_ref` + **0 FK** |

### أ.2 معرّفات commits مثبتة فعليًا (من `git log`)

| الـcommit | الوصف | يخصّ |
| --- | --- | --- |
| `1ecfc23` | `feat(settlement): PS-01 real Settlement Ledger with evidence-gated SETTLED writer` | PS-01 |
| `e9a99de` | `feat(payout): PS-02 provider-agnostic seller payout engine (no persistence yet)` | PS-02 |
| `9b164f5` | `fix(payments): enforce Payment != Settlement in the money path` | PS-01/PS-02 |
| `de59216` | `feat(money): PS-02/PS-04/WASIT Receipt additive schema + persistence (migration 0024)` | PS-02/PS-04 |
| `12c3949` | `fix(reconciliation): persist MATCHED provenance (transaction/ledger/audit) + final audit` | PS-04 |

### أ.3 الاختبارات ذات الصلة (أعداد `it(...)` الفعلية)

`settlement-ledger.test.ts` = **9** · `payout-engine.test.ts` = **11** · `payout-provider.test.ts` = **20** ·
`reconciliation-engine.test.ts` = **17** · `finance-routes.test.ts` = **16** · `money-path-invariants.test.ts` = **9** ·
`persistence-invariants.test.ts` (كاتب واحد لكل انتقال) · `e2e/settlement-integrity.spec.ts` = **4**.

### أ.4 ما هو مُغلق منطقيًا (بحسب الأدلة)

- **PS-01** — منطق التسوية المُقاد بالأدلة، بكاتب واحد، idempotent، داخل معاملة ذرّية: **مُغلق منطقيًا**.
- **PS-02** — محرّك Payout + تخزين + CHECK على مستوى DB: **مُغلق منطقيًا**.
- **PS-04** — محرّك المطابقة الثلاثية + تخزين + provenance + Receipt: **مُغلق منطقيًا**.
- **TH-01** — اختبارات الوحدات/التكامل للتسوية/Payout/Reconciliation موجودة: **مُغلقة (unit/integration)**.

### أ.5 ما يبقى **مفتوحًا** (لا يُغلقه PS-01-A)

1. **واجهة الإدارة (UI)** — لا صفحة `/admin/finance` ولا مدخل Sidebar ولا دالة في `packages/web/src/lib/api.ts`
   لمسارات التسوية/Payout/Reconciliation؛ الطبقة backend-only. (`grep` على الويب = ∅.) → **مفتوح**.
2. **E2E لمسارات `/api/admin/finance/*`** — **مُغلقة الآن**: `e2e/admin-finance.spec.ts` (15 حالة، HTTP حقيقي + جلسات حقيقية) يغطي
   `POST /settlements/confirm` (رفض 422 بلا مرجع/بعملة مشوّهة، 404 لنية غير موجودة، 409 لنية غير مدفوعة، تأكيد + idempotency + رفض مرجع مختلف 409،
   ترقية `orders.settlementStatus='SETTLED'`) و`/payouts` (`CREATED` بمبلغ مشتق من سياسة 4%، 409 لمعاملة غير مسوّاة، 422 لمزوّد بلا صلاحية payout،
   قراءة/404، `dispatch→PROCESSING` ولا `COMPLETED`، رفض payout نشط ثانٍ 409) مع حُرّاس RBAC (401/403). الواجهة المالية (UI) تبقى مفتوحة (البند 1).
3. **PS-03 (Split المزوّد)** — خارجي/تعاقدي: **مفتوح**، مسار مستقل.
4. **PS-07 (credentials إنتاجية)** + **BU-01/BU-02** (عقد مزوّد/حساب تسوية) — خارجي/بنكي: **مفتوح**.
5. **الدلالة الإنتاجية**: الإغلاق أعلاه **منطقي برمجي**، ولا يعني أن حركة أموال حقيقية مُثبتة في الإنتاج —
   ذلك يتطلّب مزوّدًا فعليًا + بيئة إنتاج + حساب تسوية (أعلاه).

### أ.6 خلاصة

`PS-01` (وكذلك `PS-02`/`PS-04`) **مغلقة على مستوى منطق التسوية/الدفع/المطابقة** بدليل الكود والاختبارات.
الفجوات المتبقية **منفصلة**: سطح إدارة (UI)، تغطية E2E للمسارات المالية، ومتطلبات خارجية (`PS-03`/`PS-07`/`BU-01`/`BU-02`)
لا يمكن إغلاقها بكود داخلي. **لم يُعلَن أي اكتمال تجاري أو إنتاجي.**
