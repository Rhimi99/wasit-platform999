# CHECKPOINT — WASIT BUSINESS GLOBAL

> **التاريخ**: 2026-09-24 — **PUBLIC DEMO: Owner Audit Center + Functional Audit (من الواجهة، بلا mocks)**
> **الفرع**: `master`
> **HEAD**: `bada224` + هذا الـcommit

## ✅ الحالة — Money Path Invariants: `Payment ≠ Settlement` (2026-09-24)

**السياق**: نُفِّذت إصلاحات المسار المالي وفق أحدث READ-ONLY AUDIT، مع الحفاظ على قرار
Automated-First وإبقاء PS-05 خارج المسار المالي (صفر مراجع برمجية له).

**ما أُصلح (جذريًا، لا إخفاءً):**

1. **`Payment ≠ Settlement`**: `applyPaymentSucceeded` لم يعد يكتب `transaction_ledger.status='SETTLED'`.
   القيود تبقى `PENDING` عند تأكيد الدفع. الكتابة الوحيدة لـ`SETTLED` صارت
   `applySettlementConfirmed`، ولا تُستدعى إلا من حدث `settlement.confirmed`.
2. **`Commission Earned ≠ Received`**: قيود عكس الاسترداد (`COMMISSION`/`PAYMENT_FEE`/`REFUND`)
   تُكتب `PENDING`، و`refunds.status` يبقى مستقلاً عن حالة القيد.
3. **الديمو لا يصنع مالًا**: `ManualPaymentProvider.capabilities = { demo: true, settlementEvidence: false }`.
   `resolvePaymentProvider()` يرفض مزوّدًا `demo` إلا عند `DEMO_PAYMENT_MODE=true`
   (والـproduction يرفض الإقلاع به)، ورفض `settlement.confirmed` من مزوّد لا يعلن `settlementEvidence`.
4. **الأدلة تطابق النية**: تأكيد الدفع يُطابَق المبلغ/العملة إن وُجدا؛ تأكيد التسوية يتطلّب
   المبلغ والعملة والعملة المطابقة دائماً — فلا يُوسم intent بـ1020 TND مدفوعًا بتأكيد 500 TND.
5. **موثوقية الـwebhook**: مفتاح idempotency يُحتجز فقط للحدث النهائي القابل للتنفيذ، ويُحرَّر
   إن فشل تطبيق الأثر (كان الحدث يُفقد نهائيًا في نمط `pending → succeeded`).
6. **تناقض التوثيق**: صُحّح `docs/PAYMENT_SETTLEMENT_AUDIT.md` (أضيف §9) ولم تعد RC-2/4/5 مفتوحة خطأً.

**ملفات الإصلاح**: `lib/payments/port.ts` · `lib/payments/providers.ts` · `lib/payments/resolve.ts`
· `lib/payments/flouci.ts` · `lib/payments/clictopay.ts` · `lib/env.ts` · `modules/payments/service.ts`.

**فحوص إلزامية جديدة**:
- `packages/server/tests/money-path-invariants.test.ts` — 9 اختبارات على الخدمة الحقيقية وقاعدة حقيقية،
  منها انتقال `SETTLED` فعلي عبر مزوّد مُسوِّر.
- `packages/server/src/scripts/verify-money-path.ts` — تدقيق **قراءة فقط** لكشف صفوف `SETTLED`
  بلا دليل تسوية، وتصدير exit code غير صفري عند وجود مخالفة.

**المصادقة**: زُرع `wasit_dev` (CREATE DATABASE جديد فقط — لا drop/reset/push، ولم تُمَس `wasit_test`).

**النتائج**:
- server tests: **594/594 PASS** (54 ملفًا).
- Browser E2E حقيقي: `payments`/`settlement-integrity` = **10/10**،
  `functional-audit`+`admin-refunds`+`order-lifecycle` = **61/61** (يشمل Marketing Video كاملًا وكل مساحات admin).
- typecheck = 0 أخطاء · build = PASS · `verify-money-path` = 0 مخالفة.
- لم تُمس Commission Policy (4% = 2%+2%) ولا Marketing Video Agent (`89e68d7`) ولا الـschema/الـmigrations.

## ✅ الحالة — Functional Audit: إصلاح تجاوز كشف التهريب خارج المنصة (2026-09-24)

**العَرَض**: في تشغيل الـE2E الكامل، فشلت حالة واحدة حقيقية:
`functional-audit.spec.ts:600 › risk desk reassesses a user and the refreshed score is rendered`
— `/api/admin/risk/profiles` أعاد **0 صفوف** بعد إرسال رسالة تحتوي رقم هاتف.

**السبب الجذري**: `openDirectThread` في `modules/messaging/service.ts` كان يكتب الرسالة الأولى
دون استدعاء `detectOffPlatformSignals`/`recordRiskSignal`، بينما `sendMessage` (الردود داخل نفس
الخيط) يستدعيهما. فكانت **الرسالة الأولى في أي خيط جديد** — وهي المكان الطبيعي لعرض نقل الصفقة
خارج المنصة — تتجاوز محرّك المخاطر بالكامل (ثغرة تجاوز عمولة C5، لا مجرد عيب اختبار).

**الإصلاح**: استُخرج الكشف إلى `scanMessageForFeeEvasion(...)` خاصية واحدة، تُستدعى الآن من مساري
الكتابة (`openDirectThread` و`sendMessage`). لا تغيير في سلوك الردود، ولا في القواعد/الأوزان،
ولا في الخصوصية (تُخزَّن رموز الإشارات فقط، لا نص الرسالة ولا الرقم).

**الإثبات الحي** (خادم حقيقي + PostgreSQL، قبل/بعد):
- قبل: رسالة أولى بـ`+216 99 123 456` → لا صف في `risk_profiles` (0).
- بعد: نفس الرسالة → `currentScore=15` مع `reasonCodes:["OFF_PLATFORM_PHONE"]`.
- ردّ داخل الخيط كان يعمل قبل وبعد: `wa.me` + «avoid the commission» → `currentScore=30`.

**التحقق الآلي الكامل**:
- **E2E**: **200 passed / 0 failed** (كانت 199 passed + 1 failed) — 6.9m.
- **Unit/Integration**: **585/585** (55 ملفًا) — +2 حالات انحدار جديدة في `fee-evasion.test.ts`
  (الرسالة الأولى في خيط جديد تُسجّل الإشارة؛ والرسالة الأولى النظيفة لا تُسجّل).
- **Typecheck** (server+web) = 0 · **Build** = 0.
- `ffmpeg`/`ffprobe` مثبّتان محليًا لتشغيل مسار Marketing Video الحقيقي (المُصيّر البنيوي عبر
  `ffmpeg-static` كان متاحًا أصلًا لاختبارات الوحدة؛ التثبيت النظامي يخدم التشغيل اليدوي).

**بلا مساس**: لا تغيير في الإنتاج، RBAC، Commission Policy (4% = 2%+2%)، Payment Kernel/iPay،
أو Marketing Video Agent (89e68d7). لا migration، لا DB reset/drop/push.

**ملاحظة تشغيلية**: تشغيل الـE2E بينما خادم يدوي يعمل على `:3000` يُعاد استخدامه (`reuseExistingServer`)
بلا تجاوزات rate-limit الخاصة بالـE2E، فتظهر 13 إخفاقة كاذبة في مكاتب admin. شغّل الـE2E على منفذ
حرّ (أوقف الخادم اليدوي أولًا).

**إعادة تشغيل رابط الـPreview (كان 502)**: قاعدة `wasit_demo` وخدمتا الـAPI/الويب لم تكونا تعملان في
بيئة التشغيل الجديدة. أُعيد إنشاؤها **معزولة تمامًا** (`wasit_dev` بلا مساس: 22 منتج / 78 مستخدمًا كما هي):
`CREATE ROLE/DATABASE wasit_demo` ← `drizzle-kit migrate` ← `seed.ts` ← `seed-demo.ts` (لا reset/drop/push)،
ثم API بـ`.env.demo` على `:3000` والويب **بناء إنتاج** (`VITE_DEMO_MODE=true`) عبر `vite preview` على
`:12000` مع `API_URL=http://localhost:3000`. النتيجة: `/`, `/demo/owner`, `/demo/customer`, `/marketplace`
= **200** و`/api/health/ready` = `{"status":"ready","db":"connected"}` — فيمكن التجربة من الهاتف.

**Browser Functional Smoke حقيقي (Chromium ضد البناء المُقدَّم على `:12000`، جلسات حقيقية عبر `/api/auth/me`)**:
**26/26 PASS** — CUSTOMER (auto-login، حجب 403، Marketplace 12 بطاقة، بحث 3 نتائج، تفاصيل منتج،
orders/notifications/messages، صفحة الطلبات) · OWNER/MERCHANT (جلسة staff حقيقية، تبديل الدور إلى
`merchanta@wasit.tn` مع بقاء RBAC 403، `/api/products/mine` 200، تسع صفحات dashboard) ·
ADMIN (**15/15** سطح إداري يرندر لصاحب الجلسة) · MARKETING VIDEO (اختيار منتج/لغة/جمهور/نمط/مدة 35s،
Generate، ظهور `<video>` جديد، حمولة MP4 حقيقية `720×1280 d=35 readyState=4`، زر تنزيل، حذف يزيله).

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Risk desk: reassess user (رسالة أولى بخيط جديد) | ✅ | ✅ PASS | `openDirectThread` لم يستدعِ كاشف التهريب → لا إشارة ولا ملف مخاطر | استخراج `scanMessageForFeeEvasion` واستدعاؤها من مساري الكتابة | E2E + وحدة (12 حالة) |
| Anti-fee-evasion: رسالة أولى نظيفة | ✅ | ✅ PASS | — | — | وحدة (حالة انحدار جديدة) |
| Anti-fee-evasion: ردّ داخل الخيط | ✅ | ✅ PASS | — | — | وحدة + إثبات حيّ |
| CUSTOMER: تسجيل الدخول / auto-login | ✅ | ✅ PASS | — | — | Browser smoke |
| CUSTOMER: RBAC (حجب `/api/admin/stats` 403) | ✅ | ✅ PASS | — | — | Browser smoke |
| CUSTOMER: تصفح Marketplace | ✅ | ✅ PASS | — | — | Browser smoke (12 بطاقة) |
| CUSTOMER: البحث + صفحة النتائج | ✅ | ✅ PASS | — | — | Browser smoke (3 منتجات) |
| CUSTOMER: تفاصيل المنتج | ✅ | ✅ PASS | — | — | Browser smoke |
| CUSTOMER: الطلبات / الإشعارات / الرسائل | ✅ | ✅ PASS | — | — | Browser smoke + E2E |
| MERCHANT: Dashboard KPIs | ✅ | ✅ PASS | — | — | Browser smoke + E2E |
| MERCHANT: Products / Inventory / Orders | ✅ | ✅ PASS | — | — | Browser smoke + E2E |
| MERCHANT: Ads / AI / Analytics / Subscriptions | ✅ | ✅ PASS | — | — | Browser smoke + E2E |
| MERCHANT: إنشاء/تعديل/نشر منتج | ✅ | ✅ PASS | — | — | E2E (functional-audit) |
| ADMIN: 15 سطحًا (Users/Products/Orders/Ledger/Audit/Verification/Trust/Risk/Disputes/Ads/AI/Subscriptions/Analytics) | ✅ | ✅ PASS | — | — | Browser smoke 15/15 + E2E |
| ADMIN: دمج KPIs من API الحيّ | ✅ | ✅ PASS | — | — | E2E |
| MARKETING VIDEO: كل الحقول + Generate + Preview + Download + Delete | ✅ | ✅ PASS | — | — | Browser smoke (MP4 حقيقي) |
| MARKETING VIDEO: نافذة المدة 35–120s | ✅ | ✅ PASS | — | — | E2E |

---

## ✅ الحالة — PUBLIC DEMO: Owner Audit Center + Functional Audit حقيقي (2026-09-24)

**الهدف**: إتاحة تدقيق وظيفي حقيقي للمنصة (CUSTOMER / MERCHANT / SUPPLIER / ADMIN / MARKETING VIDEO)
من الواجهة نفسها على الـPreview، وليس SPA routes ولا HTTP 200. كل اختبار يقود Chromium حقيقيًا،
يضغط الأزرار الفعلية، ثم يتحقق من الأثر عبر `GET /api/auth/me` والـAPI الحيّ. Backend حقيقي +
PostgreSQL `wasit_demo`، بلا mocks.

**الميزة الجديدة — Owner Audit Center (`/demo/owner`)**:
- `packages/web/src/pages/DemoOwnerAuditPage.tsx` + `lib/demo-owner-catalog.ts`: كتالوج واحد يجمع
  مكاتب CUSTOMER/MERCHANT/SUPPLIER/COMPANY/ADMIN ومساراتها وprobe endpoints، مع شبكة أدوار
  وزرّي «افتح مساحة الدور» (ينقل إلى `/dashboard`) و«Session» (يفتح الجلسة في المكان) و«افحص» (probe
  حيّ يعرض كود الحالة الفعلي).
- `packages/server/src/modules/auth/{routes.ts,service.ts}`: `POST /api/auth/demo-audit-session`
  يعيد استخدام قواعد `/demo-session` نفسها (بوابة demo-only، جلسة حقيقية عبر `issueSession`، بلا
  منح أدوار) ويضيف **قائمة أدوار مُصرَّحة** في `lib/demo-account.ts` (`resolveDemoAuditPersona`).
  الطلب يحمل **معرّف دور فقط** `{persona}`، لا بريدًا ولا كلمة مرور. يُتحقق أن الحساب المخزَّن يحمل
  الدور المُعلن فعلًا وإلا **409** (انحراف الـseed لا يفتح مكتبًا بلا حق).
- **حماية RBAC حقيقية**: جلسة `customer` تُرفض بـ**403** على `/api/admin/stats` تمامًا كأي عميل،
  والواجهة تعرض ذلك. الـprobe يُثبت أن الشارات نتائج خادم حيّة لا تسميات ثابتة (200 ثم 403 بعد التبديل).
- **fallback محدود وآمن**: إن بُنيت قاعدة Demo من `seed.ts` فقط (بلا `seed-demo.ts`) تُستبدل حسابات
  الأدوار التجارية الثلاثة بالحساب الأساسي `customer1@wasit.tn` (CUSTOMER بلا دور) — ولا ينجح الاستبدال
  إلا إن حمل الـfallback الدور المطلوب، فلا يوسّع الصلاحيات أبدًا.
- لا تغيير في الإنتاج، RBAC، سياسة العمولة (4% = 2%+2%)، Payment Kernel/iPay، ولا Marketing Video
  Agent (89e68d7). لا migration، لا DB reset/drop/push.

**نتائج Functional Audit (متجر demo الافتراضي)**:
- **`e2e/demo-owner.spec.ts` (جديد)**: **6/6 PASS** ضد الرابط العام (وضع demo) —
  فتح جلسة super-admin بلا نموذج دخول، تبديل الدور يغيّر الجلسة فعليًا (merchant/customer) مع بقاء
  RBAC، probes 200→403، فتح مكتب `/admin/users` بصفوف حقيقية، تسجيل الخروج يُنهي الجلسة، ورفض
  المعرّف المجهول **400**؛ والوضع المعطّل (production/dev) يعرض «غير مُتاح» و**404** بلا جلسة.
- **`e2e/demo-auto-login.spec.ts`**: **2/2 + 1 skip** (وضع demo).
- **Full browser E2E على الرابط العام (وضع demo)**: **192 passed / 14 failed / 2 skipped (7.0m)**.
  الفشل الـ14 **ليست regressions**: كلها تعتمد قدرات Dev-only أو locators تتأثر ببانر DEMO
  (`dev/verification-link` = 404 في staging، `getByRole('status')` يطابق عنصرين بسبب البانر، إلخ).
- **إعادة تشغيل الـ14 في إعداد Dev الأصلي** (منافذ معزولة `:3100`/`:5273` و`DEMO_AUTO_LOGIN=false`
  و`DEMO_SKIP_EMAIL_VERIFICATION=false`): **70/70 PASS** ⇒ الفشل تهيئة اختبار لا عيب منتج.
- **Server suite**: **583/583 (55 ملفًا)** في بيئة نظيفة. **Typecheck** (server+web) = 0.
  **Build** (`VITE_DEMO_MODE=true npm run build -w @wasit/web`) = PASS.
- **الرابط العام HTTPS**: `/`, `/demo/owner`, `/demo/customer` = 200؛ `demo-audit-session` يفتح
  `admin2@wasit.tn` بدور ADMIN مع كوكي جلسة حقيقي؛ البناء الجديد `index-C4xoDGfW.js` مُخدَّم.

**الملفات**: جديدة `packages/web/src/pages/DemoOwnerAuditPage.tsx`,
`packages/web/src/lib/demo-owner-catalog.ts`, `e2e/demo-owner.spec.ts`. معدّلة
`packages/server/src/lib/demo-account.ts`, `packages/server/src/modules/auth/{routes,service}.ts`,
`packages/server/tests/demo-auto-login.test.ts`, `packages/web/src/{App.tsx,lib/api.ts,lib/i18n.ts}`.

**جدول التدقيق الوظيفي (Functional Audit Matrix)**:

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Owner Audit Center: فتح جلسة staff | ✅ | ✅ PASS | — | — | E2E (demo) |
| Owner Audit Center: تبديل الدور + RBAC | ✅ | ✅ PASS | — | — | E2E (demo) |
| Owner Audit Center: probe حيّ 200→403 | ✅ | ✅ PASS | — | — | E2E (demo) |
| Owner Audit Center: فتح مكتب `/admin/users` | ✅ | ✅ PASS | — | — | E2E (demo) |
| Owner Audit Center: logout | ✅ | ✅ PASS | — | — | E2E (demo) |
| Owner Audit Center: رفض معرّف مجهول | — (API) | ✅ PASS (400) | — | — | E2E |
| Owner Audit Center: الوضع المعطّل | ✅ | ✅ PASS (404 بلا جلسة) | — | — | E2E (dev) |
| `/demo/customer` جلسة عميل حقيقية | ✅ | ✅ PASS | — | — | E2E (demo) |
| CUSTOMER: تسجيل/دخول/بحث/تصفح/تفاصيل/طلب/طلبات/إشعارات/رسائل | ✅ | ✅ PASS | — | — | E2E `functional-audit` |
| MERCHANT: dashboard/إنشاء/تعديل/نشر/مخزون/طلبات/إعلانات/AI/فيديو/تحليلات/اشتراك | ✅ | ✅ PASS | — | — | E2E `functional-audit` |
| ADMIN: KPIs/users/products/orders/transactions/ledger/audit/verification/trust/risk/disputes/ads/AI/subscriptions | ✅ | ✅ PASS | — | — | E2E `functional-audit` + dev run |
| MARKETING VIDEO: منتج→لغة→جمهور→نمط→مدة→Generate→READY→معاينة→تنزيل→حذف | ✅ | ✅ PASS | الأصل المحذوف يبقى للتدقيق (سلوك مقصود) | تصفية `DELETED` في الواجهة | E2E |


## ✅ الحالة — إصلاح regression أمني حقيقي: حسابات staff لم تكن محصّنة في الـseed (2026-09-24)

**النتيجة**: التدقيق الأمني `scripts/demo-security-smoke.sh` على الرابط العام = **37/37 PASS** (كان
**31/33** مع فشلين: `admin@wasit.tn` و`admin2@wasit.tn` يُفتحان بكلمة المرور المنشورة).

**السبب الجذري الحقيقي**: commit `c41cf06` وثّق أن "كلمات مرور الـstaff دُوِّرت على مستوى قاعدة
البيانات فقط (بلا تغيير كود/RBAC)". لكن `seed-demo.ts` كان **ما زال** ينشئ/يحدّث `admin@wasit.tn`
و`admin2@wasit.tn` بكلمة المرور المنشورة `Passw0rd!2026` (السطر 216 سابقًا). أي إعادة بناء لقاعدة
الـDemo — بما فيها تشغيل `seed-demo.ts` من E2E global-setup — كانت **تتراجع** عن التدوير يدويًا
تُبطله. هذا ليس خطأ اختبار؛ إنه فجوة provisioning دائمة.

**الإصلاح (أقل تغيير ممكن، بلا مساس بأي شيء محظور)**:
- `packages/server/src/lib/demo-account.ts`: دالة نقية `resolveStaffPassword({nodeEnv, configuredPassword, generate})`
  + ثابت `DEMO_PUBLISHED_PASSWORD`. السياسة: `DEMO_STAFF_PASSWORD` الصريحة تفوز؛ وعلى الـDemo العام
  (`NODE_ENV=staging`) تُولَّد كلمة مرور عشوائية **لا** تعود أبدًا إلى كلمة المرور المنشورة؛ وفي
  dev/test تبقى كلمة المرور المعروفة كي تستطيع E2E قيادة مكاتب الـadmin.
- `seed-demo.ts`: يستخدم `staffPassword()` لحسابي الـstaff، و`enforcePassword: true` في `ensureDevUser`
  يعيد الـhash في كل تشغيل (فلا تبقى كلمة مرور قديمة عبر عمليات seed متتالية)، ويطبع تذكيرًا بأن
  الـstaff لهم credential منفصل.
- `.env.demo` (git-ignored): `DEMO_STAFF_PASSWORD` عشوائي — لا plaintext في Git.
- `scripts/demo-security-smoke.sh`: قسم 2b جديد يثبت أن كلمة مرور الـstaff المُدوَّرة **تفتح** مكاتب
  الـstaff (login + `/api/admin/stats` = 200)، ولا تفتح حساب الـdemo العام، وأن كلمة المرور المنشورة
  ما زالت تفتح الحسابات العامة — فلا يُقفل الإصلاح أحدًا.
- `packages/server/tests/demo-auto-login.test.ts`: 5 اختبارات وحدة للسياسة (بوابة regression).

**تحقق حقيقي على الرابط العام**: `admin@/admin2@` + كلمة المرور المنشورة = **401**؛ كلمة مرور الـstaff
المُدوَّرة = **200** مع `admin/stats=200`؛ `customer1@` بكلمة المرور المنشورة = **200**، وبكلمة مرور
الـstaff = **401**. متصفح فعلي: `/demo/customer` ⇒ جلسة CUSTOMER حقيقية ⇒ `/dashboard`؛ السوق (13
منتجًا)، تفاصيل منتج، الرسائل، الإشعارات، دخول merchant من النموذج، لوحة merchant بطلبات/منتجات حقيقية،
نموذج إنشاء منتج، واستوديو الفيديو التسويقي (منتج/لغة/جمهور/نمط/مدة 35–120s + توليد) تعمل.

**بوابات**: server tests **576/576**؛ E2E (demo، `DEMO_SKIP_EMAIL_VERIFICATION=true DEMO_AUTO_LOGIN=true`)
**200/200**؛ typecheck 0 أخطاء؛ build PASS.

**القيود المُحترمة**: لا migration/reset/drop/push؛ Commission Policy 4% (2%+2%) دون تغيير؛ لا مساس بـ
Payment Kernel/iPay ولا Marketing Video Agent (89e68d7)؛ RBAC كما هو؛ لا Mock؛ لم تُعطّل أزرار.

### جدول
| الميزة | اختُبرت من الواجهة | النتيجة | السبب الجذري عند الفشل | الإصلاح | حالة الاختبار |
|---|---|---|---|---|---|
| `/demo/customer` ⇒ جلسة حقيقية | نعم (Public HTTPS) | PASS | — | — | PASS |
| staff بمفتاح منشور | نعم (API + رأس الصفحة) | **PASS بعد الإصلاح** | `seed-demo.ts` يمنح الـstaff كلمة المرور المنشورة فتُبطِل التدوير اليدوي عند كل rebuild | `resolveStaffPassword` + `enforcePassword` + `DEMO_STAFF_PASSWORD` | PASS (37/37 smoke) |
| كلمة مرور staff المُدوَّرة تفتح الـstaff فقط | نعم | PASS | — | — | PASS |
| product browse/detail/search | نعم | PASS | — | — | PASS |
| messaging/notifications | نعم | PASS | — | — | PASS |
| merchant dashboard/orders/products | نعم | PASS | — | — | PASS |
| create-product form + video studio | نعم (تحميل + ضوابط) | PASS | — | — | PASS |

---

## ✅ الحالة — حساب اختبار Demo رسمي وثابت (2026-09-24)

**السبب الجذري السابق**: الحساب `rhimiimed18@gmail.com` كان **غير موجود** في `wasit_demo`
(0 صفوف، لا حساب `@gmail.com` إطلاقًا؛ عنقود Postgres أُنشئ اليوم 05:06 وأقدم حساب 05:35).
`loginUser` كان يأخذ فرع `USER_NOT_FOUND` (مقارنة على هاش وهمي لموازنة التوقيت) ⇒ **لا خطأ كود**، بل
فقدان بيانات بسبب قاعدة Demo مؤقتة/رخوة. لا bypass، ولا مشكلة كلمة مرور.

**الحل المطبَّق**: إضافة الحساب إلى **آلية الـDemo seed الحالية** (`seed-demo.ts`)، وليس أي
workaround داخل login. الـseed هو المصدر الوحيد: أي إعادة بناء لـDemo DB تعيد إنشاءه تلقائيًا.

- **الحساب**: `rhimiimed18@gmail.com` — `CUSTOMER` عادي، `active=true`، `email_verified=true` (في
  Demo فقط عبر `ensureDevUser` الحالي)، **لا Admin/Staff** ولا bypass كلمة مرور ولا تفويض خاص.
- **كلمة المرور**: لا plaintext في الكود إطلاقًا. تُقرأ من `DEMO_TEST_ACCOUNT_PASSWORD` في
  `.env.demo` (git-ignored، كبقية أسرار الـDemo)، وتُمرَّر عبر **نفس** `hashPassword`/`registerUser`
  المستخدم في نظام المصادقة. لا أسرار إنتاج. لا كلمة مرور في logs/CHECKPOINT/التقرير.
- **Idempotent**: تشغيل الـseed مرتين لا يُنشئ نسخة ثانية (تحقّقنا: `count(*)=1` بعد تشغيلين)،
  ويحافظ على الصف والبيانات القائمة؛ لا delete/recreate، لا reset/drop/truncate، ولا مساس بحسابات
  أخرى. `login`/الـauth **لا يعرفان هذا البريد** (لا شرط خاص).
- **إعادة الإنشاء بعد rebuild**: أُثبت على قاعدة scratch جديدة تمامًا (migrate → `seed.ts` →
  `seed-demo.ts`) أن الحساب يُنشأ تلقائيًا `CUSTOMER`/verified/active ثم حُذفت قاعدة الـscratch وحدها.

### الاختبار الحقيقي (لا Mock)
- **Public HTTPS UI (Pixel 5)**: **11/11 PASS** — login، `/api/auth/me`، customer dashboard،
  search، product details، favorites toggle (قراءة/كتابة حقيقية)، messaging، notifications،
  orders، logout (`me=401`)، login مرة ثانية.
- **بعد restart طبيعي للـDemo**: أُعيد التدقيق 11/11 PASS عبر الرابط العام.
- **E2E جديد** `e2e/demo-test-account.spec.ts` (حالتان): دخول كـCUSTOMER عادي مع
  `roles=['CUSTOMER']`، ورفض سطح الـAdmin (Forbidden + `403` على `/api/admin/stats`).

### البوابات
- **server tests**: 54 ملفًا / **565/565** ناجح.
- **E2E — default/production verification**: **198/198** ناجح.
- **E2E — demo mode** (`DEMO_SKIP_EMAIL_VERIFICATION=true`): **198/198** ناجح.
- **typecheck**: 0 أخطاء. **build**: PASS (server + web).

### إصلاح جانبي حقيقي (سبب جذري، لا إخفاء)
- **`e2e/functional-audit.spec.ts:796`** — شرط `verified` كان يستهلك رمز التحقق عبر
  `completeEmailVerification` ثم يطلب **رمزًا ثانيًا** لنفس الحساب، وهو مستحيل لأن الاستهلاك الأول
  يمسح الرمز ⇒ `data.token` undefined في وضع التحقق الإلزامي. أُضيف `isDemoVerified()` (فحص غير
  استهلاكي) ونُفّذت صفحة `/verify-email` برمز **واحد**؛ صار السpec يغطي الصفحة فعليًا في الوضعين.

### القيود المُحترمة
لا DB reset/drop/push؛ حُذفت قاعدة scratch وحدها؛ الإنتاج و`wasit_dev` دون تغيير؛ تحقق بريد الإنتاج
دون تغيير؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ Marketing Video `89e68d7` دون مساس؛ لا كلمة مرور
حقيقية في Git.

### الملفات
`packages/server/src/scripts/seed-demo.ts`، `e2e/helpers.ts`، `e2e/demo-test-account.spec.ts` (جديد)،
`e2e/functional-audit.spec.ts`، `.env.demo` (git-ignored).

---

## ✅ حالة معتمدة — تسجيل فوري في العرض العام + إصلاح ثغرة تجاوز بوابة الدخول (2026-09-24)

**الهدف**: زائر العرض العام لا يملك صندوق بريد، فكان يسجّل ثم يُطالَب بتحقق مستحيل. المطلوب: بعد التسجيل يستطيع الدخول فورًا — **دون** إضعاف بوابة التحقق على أي بيئة حقيقية.

### 1) السبب الجذري الأهم: بوابة الدخول كانت تحت سيطرة العميل
كانت `POST /api/auth/login` تقرأ `allowUnverifiedEmail` من جسم الطلب وتمرّرها كما هي إلى `loginUser`. أي أن **أي مُتصل** يستطيع إرسال `{"allowUnverifiedEmail": true}` وتجاوز بوابة التحقق — على الإنتاج أيضًا. لم يكن مجرد خيار dev، بل متجه تجاوز حقيقي.

- **الإصلاح (`modules/auth/routes.ts`)**: `allowUnverifiedEmail: body.allowUnverifiedEmail && devToolingActive()`. يجب أيضًا أن تكون أداة dev مُفعّلة (development/test أو staging opt-in)، لذا الإنتاج لا يمكن أن يفتح البوابة عبر جسم الطلب.
- **`lib/env.ts`**: `devToolingEnabled` (ثابت وقت الاستيراد) → `devToolingActive()` قارئ **وقت النداء**؛ كل بوابات dev (السطور 178/227/263/431) تستخدمه الآن. لا ثابت ميت.

### 2) تخطّي التحقق في العرض العام فقط، مع حرس مزدوج
- **`lib/env.ts`**: علم `DEMO_SKIP_EMAIL_VERIFICATION` (افتراضي false). الإنتاج **يرفض الإقلاع** إذا كان true (نفس نمط `ALLOW_DEV_TOOLING`)، و`demoEmailVerificationSkipped()` يستثني الإنتاج مرة ثانية عند النداء.
- **`auth/service.ts`**: في التسجيل، `skipEmailVerification = demoEmailVerificationSkipped()` ⇒ الحساب يُخزَّن `emailVerified=true` ولا يُصدر رمز تحقق، ويُكتب سجل تدقيق `AUTH.EMAIL_VERIFICATION_SKIPPED`. الاستجابة تحمل `requiresEmailVerification:false`.
- **الواجهة (`RegisterPage.tsx` + `i18n.ts`)**: الرسالة تتبع نتيجة الخادم الفعلية بدل أن تدّعي دائمًا «تحقق من بريدك». مفتاح جديد `auth.registerSuccessVerified` بأربع لغات (ar/en/fr/zh).

### الاختبار الحقيقي (لا Mock)
- **`packages/server/tests/demo-email-verification.test.ts` (جديد، 6 حالات، HTTP حقيقي)**: السلوك الافتراضي يبقى صارمًا (حساب غير مُتحقق + رمز + رفض دخول)؛ `allowUnverifiedEmail` يُتجاهل حين تكون أدوات dev معطّلة؛ مع التفعيل: حساب مُتحقق، لا رمز، و`/api/auth/me` يؤكده.
- **`e2e/demo-registration.spec.ts` (جديد، حالتان)**: يكتشف البيئة من نص البانر ويكتسب العقد المطابق — إما دخول فوري (عرض عام) أو **403 EMAIL_NOT_VERIFIED** (بيئة تفرض التحقق). يقود نموذجي التسجيل والدخول فعليًا ويؤكد `GET /api/auth/me`.
- **`e2e/helpers.ts`**: `completeEmailVerification()` يتحمّل الوضعين (رمز حقيقي، أو 422 ALREADY_VERIFIED في العرض العام)؛ حُدّثت مواضع استخدامه في `functional-audit`/`mfa`/`admin-privacy`/`admin-subscriptions`.
- **HTTP حقيقي على الرابط العام HTTPS**: تسجيل ⇒ `requiresEmailVerification:false`، دخول ⇒ 200 + `emailVerified:true`، `/api/auth/me` ⇒ جلسة صحيحة.
- **Browser smoke من عرض هاتف (Pixel 5) على الرابط العام**: **6/6 PASS** (بانر «يمكنك تسجيل الدخول الآن»، دخول → داشبورد، شريط جانبي، صفحة الطلبات، 12 منتجًا في المتجر).

### البوابات
- **حزمة الخادم**: 54 ملفًا / **564 اختبارًا ناجحًا** (كانت 558؛ +6).
- **حزمة E2E كاملة (وضع العرض العام)**: **196/196 ناجح** (كانت 194؛ +2 صافي).
- **typecheck**: 0 أخطاء. **build**: PASS (server + web).

### الملفات
- `packages/server/src/lib/env.ts`، `packages/server/src/modules/auth/service.ts`، `packages/server/src/modules/auth/routes.ts`
- `packages/web/src/pages/RegisterPage.tsx`، `packages/web/src/lib/i18n.ts`
- `packages/server/tests/demo-email-verification.test.ts` (جديد)، `e2e/demo-registration.spec.ts` (جديد)
- `e2e/helpers.ts`، `e2e/functional-audit.spec.ts`، `e2e/mfa.spec.ts`، `e2e/admin-privacy.spec.ts`، `e2e/admin-subscriptions.spec.ts`، `playwright.config.ts`، `.env.staging.example`

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ لا مساس بـMarketing Video `89e68d7`؛ لا Mock؛ لم تُعطّل أزرار لإخفاء أخطاء؛ RBAC كما هو؛ ar/fr/en/zh وRTL محفوظة؛ `wasit_dev`/الإنتاج دون تغيير.

---

## ✅ حالة معتمدة — FUNCTIONAL AUDIT من الواجهة على الرابط العام HTTPS (2026-09-23)

**الهدف**: تجاوز "الصفحة تفتح وHTTP 200" إلى تدقيق وظيفي فعلي: تسجيل دخول بحسابات Demo، والضغط على الأزرار وتنفيذ العمليات من الواجهة نفسها على **نفس رابط HTTPS العام** (لا localhost)، وتتبّع كل فشل من الزر → handler الواجهة → API → service/DB → السبب الجذري.

### إصلاحان جذريان (سببان حقيقيان، لا إخفاء للأخطاء)

1. **`e2e/policies.spec.ts:24` — فحص واجهة خاطئ (وليس خللًا في المنتج)**: `getByText(/Global|عالمي/i).first()` كان يطابق أولًا خيار `<option>` المخفي في مُحدِّد النطاق (`الافتراضي العالمي (كل الدول)`)، وهو عنصر لا يصبح مرئيًا أبدًا ⇒ فشل دائم زائف. أُعيد النطاق إلى الجدول: `table tbody tr` الذي يحوي النص العالمي. السبب الجذري: مطابقة نص غير مقيّدة بالسياق، لا عيب في `AdminPolicyPages`.
2. **`e2e/functional-audit.spec.ts:603` — شرط مسبق غير مُبنى (وليس خللًا في المنتج)**: مكتب المخاطر `/admin/risk` يُبنى من `risk_profiles`، وهذه لا تُكتب إلا عند وصول **إشارة مخاطر حقيقية**. على قاعدة نظيفة يكون الجدول فارغًا بحق ⇒ لا يوجد صف ولا زر "إعادة تقييم". أُضيف تهيئة عبر مسار المنتج نفسه: إرسال رسالة تحوي رقم هاتف خارج المنصة (إشارة `ANTI_FEE_EVASION` عبر `recordRiskSignal`) قبل فتح المكتب. لا Mock ولا كتابة مباشرة في الجدول.

### نتائج التدقيق على الرابط العام (متغيّر `BASE=https://work-1-...prod-runtime.all-hands.dev`)

متصفّح حقيقي (Chromium)، حساب Demo لكل دور، **PASS=33 / FAIL=2** (الفشلان كانا في سكربت التدقيق المؤقّت لا في المنتج، وأُعيد التحقق بعد تصحيح الـselectors: إنشاء/تعديل/نشر منتج ناجح، وإنشاء طلب ناجح 38→39).

| الوحدة | تم اختباره من الواجهة | النتيجة |
| --- | --- | --- |
| PUBLIC | تحميل الرئيسية + عرض الهاتف 390px | PASS |
| CUSTOMER | تسجيل حساب جديد | PASS |
| CUSTOMER | تسجيل الدخول من النموذج | PASS |
| CUSTOMER | البحث (`/search?q=olive`) | PASS (3 نتائج) |
| CUSTOMER | تفاصيل المنتج (SKU/السعر/الكمية) | PASS |
| CUSTOMER | إنشاء طلب من الواجهة (checkout) | PASS (38→39 على الخادم) |
| CUSTOMER | صفحة الطلبات | PASS (39 صفًا) |
| CUSTOMER | الرسائل + الإشعارات | PASS |
| MERCHANT | إنشاء منتج من النموذج | PASS (بانر نجاح) |
| MERCHANT | تعديل منتج من المودال | PASS (الاسم الجديد ظاهر) |
| MERCHANT | نشر/إلغاء نشر | PASS (ACTIVE→INACTIVE في الصف) |
| MERCHANT | المخزون | PASS (9 صفوف) |
| MERCHANT | الطلبات | PASS (33 صفًا) |
| MERCHANT | الإعلانات | PASS (لا حملة قابلة للتفعيل حاليًا) |
| MERCHANT | AI (تنفيذ أداة) | PASS |
| MERCHANT | Analytics (GMV) | PASS |
| MERCHANT | الاشتراك (خطط) | PASS (4 عناصر) |
| MARKETING VIDEO | منتج/لغة/جمهور/نمط/مدة → توليد → معاينة → تنزيل → حذف | PASS (`ACTIVE-only=true`, preview 200, download 200 ~110KB, delete 6→5) |
| ADMIN | KPIs, Users, Products, Orders, Transactions, Ledger, Audit, Verification, Trust, Risk, Disputes, Ads, AI, Subscriptions | PASS (صفوف حقيقية: 46/18/50/50/100/100/2/1/1/6/9/0/8) |
| ADMIN | زر إعادة تقييم المخاطر | PASS |

### البوابات
- **typecheck**: 0 أخطاء (server + web).
- **build**: PASS (server + web، إنتاج).
- **اختبارات الخادم**: 53 ملفًا / **558 ناجح**.
- **E2E كاملة**: **194/194 ناجح** (كانت 192/194؛ أُصلح الفشلان أعلاه).

### الملفات
- `e2e/functional-audit.spec.ts` — تهيئة إشارة مخاطر حقيقية قبل مكتب المخاطر.
- `e2e/policies.spec.ts` — تحديد نطاق فحص الصف العالمي إلى جدول السياسات.
- `packages/web/src/pages/DashboardVideoStudioPage.tsx` — قائمة المنتجات في الاستوديو تُرشّح ACTIVE فقط (مطابقة لقاعدة الخادم).

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ لا مساس بـPayment Kernel/iPay ولا Marketing Video Agent (89e68d7)؛ لا Mock؛ لم تُعطّل أزرار؛ RBAC كما هو؛ لا تغيير في الوظائف العاملة.

---

## ✅ حالة معتمدة — PUBLIC DEMO / PRIVATE BETA: تدقيق أمني عملي + إصلاح فجوتين حقيقيتين (2026-09-23)

**الهدف**: تجهيز العرض العام للمشاركة مع أشخاص حقيقيين بأمان، بلا أي مساس بالإنتاج أو `wasit_dev` أو RBAC أو Commission Policy (4% = 2% مشتري + 2% بائع) أو Payment Kernel أو iPay أو Marketing Video Agent (89e68d7)، وبلا Migration أو reset/drop/push.

**فجوتان حقيقيتان أُصلحتا (بأقل تغيير ممكن)**:

1. **الرابط العام كان يخدم Vite *dev server***: `/src/main.tsx` كان يُرجع كود TSX حقيقيًا، والـSPA كان يُقدَّم بلا `X-Content-Type-Options` ولا `X-Frame-Options` ولا `Referrer-Policy`. الآن يُقدَّم **بناء الإنتاج** عبر `vite preview` (لا مصدر، لا sourcemaps) مع نفس رؤوس أمان nginx الإنتاجية، عبر كتلة `preview` في `packages/web/vite.config.ts`. الإنتاج نفسه يستخدم nginx ولم يتغيّر.
2. **CORS مُصدَّق كان يعكس أي origin**: `CORS_ORIGIN` لم يكن مقروءًا في أي مكان، والـAPI كان يُرجع `Access-Control-Allow-Origin` لأي `Origin` مع `credentials: true`. الآن `CORS_ORIGIN` مفتاح env حقيقي و`resolveCorsOrigin()` يعكس فقط الـorigins المسموح بها (+ `APP_URL` للمنصة)؛ وعند تركه فارغًا يبقى سلوك dev/test السابق. مغطّى بـ`packages/server/tests/cors.test.ts`.

**نتيجة التدقيق الأمني: 33/33 PASS** (`scripts/demo-security-smoke.sh`, `DEMO_URL=...`) + تحقّق متصفّح فعلي:

| الضابط | النتيجة |
| --- | --- |
| الحسابات الأربعة بكلمة المرور المنشورة | تعمل بالضبط: `customer1`/`merchantA`/`supplierA`/`companyA` بأدوار CUSTOMER/MERCHANT/SUPPLIER/COMPANY |
| حسابات staff بكلمة المرور المنشورة | `admin`, `admin2` → **401** (مُدوَّرة، محفوظة خارج Git، صلاحية 0600) |
| Admin/Staff API من عميل Demo | **403** على 15 مسارًا |
| Admin/Staff API من merchant/supplier/company | **403** |
| Admin/Staff API بدون مصادقة | **401** |
| مسار `/admin` من متصفّح merchant | يعرض "Forbidden: Admin area" |
| كوكي الجلسة على HTTPS | `HttpOnly; Secure; SameSite=Lax` |
| `DATABASE_URL` للـAPI العامل | `wasit_demo` فقط؛ `wasit_dev`/`wasit_test` موجودة وغير ملموسة |
| `PAYMENT_PROVIDER` | `manual` — لا اتصال بـiPay/Audasoft/Flouci/ClicToPay |
| `AI_PROVIDER` | `local-heuristic` — لا مفاتيح إنتاجية |
| أسرار في bundle العام | لا شيء؛ ولا sourcemaps |
| بانر DEMO | ظاهر في الواجهة وفي الـbundle |
| `.env.demo` | مُستثنى من Git وغير متعقَّب |

**ملاحظة**: الـedge proxy في بيئة التشغيل يجيب على `OPTIONS` preflight بنفسه بدون `Access-Control-Allow-Origin`. هذا خارج المستودع ولا يؤثّر على العرض لأن الـSPA والـAPI على نفس الـorigin (بروكسي `/api` كما في nginx الإنتاجي).

**التحقق النهائي**: Server **558/558 (53 ملفًا)**، Typecheck (server+web) نظيف، Build (server+web) نظيف، Functional smoke **21/21**، Extended smoke **13/13**، Security smoke **33/33**.

**التقرير الكامل**: `docs/PUBLIC_DEMO_FUNCTIONAL_AUDIT.md` §5 (Security posture) و§6 (non-blockers).

---

## ✅ حالة معتمدة — PUBLIC DEMO / PRIVATE BETA: تدقيق وظيفي حقيقي + تحصين سطح الإدارة (2026-09-23)

**الهدف**: تجهيز المنصة كعرض عام (هاتف + أجهزة خارجية) على رابط HTTPS عام، بلا أي مساس بالإنتاج أو قاعدة بيانات الإنتاج، وبلا reset/drop/push، وبلا مزوّد دفع حقيقي، مع الحفاظ على عمولة **4% = 2%+2%** وMarketing Video Agent (89e68d7). القاعدة المُطبَّقة: لا يُقبل HTTP 200 ولا رندر الصفحة — كل وظيفة نُفِّذت فعليًا من الواجهة أو عبر نداء حقيقي يغيّر/يقرأ حالة حقيقية في PostgreSQL.

**البيئة المعزولة**: قاعدة `wasit_demo` (دور `wasit_demo`) منفصلة تمامًا؛ `wasit_dev` بلا مساس. API بـ`NODE_ENV=staging` على 3000، وWeb (بناء production) على 12000، والرابط العام `https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev` يعمل 200 و`/api/health/ready` متصل بقاعدة البيانات. المدفوعات `PAYMENT_PROVIDER=manual` (مكتب offline)، والذكاء `local-heuristic`. `.env.demo` مُستثنى من Git وبأسرار عشوائية.

**فجوة حقيقية أُصلحت (تحصين لا تجميل)**: كلمة مرور العرض المنشورة `Passw0rd!2026` كانت تفتح **حسابات الطاقم** `admin@wasit.tn`/`admin2@wasit.tn` ⇒ أي زائر يصل لسطح الإدارة. لم ألمس الكود ولا RBAC؛ بدلًا من ذلك:
1. **تدوير كلمات مرور الطاقم** إلى قيم عشوائية محفوظة محليًا فقط (`/tmp/demo_admin_pw.txt` بصلاحية 0600). كلمة العرض المنشورة صارت **مرفوضة 401** للإدارة، بينما customer/merchant/supplier/company تعمل كما هي.
2. **بانر DEMO** (`packages/web/src/components/DemoBanner.tsx`) يُعرض فقط عند `VITE_DEMO_MODE=true` ⇒ بناء الإنتاج بلا تأثّر. يوضّح أن البيانات تجريبية والمدفوعات غير حقيقية.
3. مسارات الإدارة كانت مُقيّدة أصلًا بـ`AdminOnly`/`StaffOnly` — تم التحقق.

**الإثبات (أرقام فعلية من الرابط العام)**:
- **Smoke أساسي 21/21**: الصفحة العامة، الفئات (13 فئة)، المنتجات (13)، تفاصيل منتج، بحث `q=Demo`=3، دخول customer/merchant/supplier/company، الطلبات، الإشعارات، الرسائل، المخزون، ورفض دخول admin.
- **Smoke موسّع 13/13**: تسجيل→تأكيد بريد→دخول **201/200**؛ إنشاء طلب **201** مع `grandTotal 214.20` (شامل 2% مشتري)؛ Payment intent على مكتب manual **201**؛ **توليد فيديو تسويقي حقيقي 201 بحالة `READY`** (45s) ثم قائمة/حذف **200**.
- **Browser UI فعلي**: الصفحة الرئيسية + البانر، تسجيل دخول تاجر→`/dashboard` (طلبات ومنتجات حقيقية)، `/marketplace` (منتجات وفئات وفرز)، `/products/:id` (SKU/MOQ/كمية/اطلب)، `/dashboard/video-studio` (اختيار منتج/لغة/جمهور/نمط/مدة + توليد).
- **Admin APIs بالاعتماد المُدوَّر**: stats (`users 9, products 13, orders 13, GMV`), users/products/orders/transactions/ledger/audit-logs, verification/trust/risk, disputes, ads/AI/subscriptions, observability (metrics/logs/alerts), privacy/deletions — كلها **200**.

**ملاحظة تشغيلية مهمة**: تشغيل `npm test` أثناء تصدير `.env.demo` في نفس الـshell يُسرّب `WEB_BASE_URL`/أعلام metrics إلى vitest فيُنتج فشلًا **زائفًا** (SEO/sitemap/robots و/metrics). بعد تنظيف البيئة: **Server 554/554 (52 ملفًا)**، **Typecheck (server+web)** و**Build (server+web)** نظيفة.

**التقرير الكامل**: `docs/PUBLIC_DEMO_FUNCTIONAL_AUDIT.md` (جدول Feature | Tested from UI | Result | Root cause | Fix | Test status). لا migrations، لا reset/drop/push، لا مزوّد دفع، والعمولة **4%=2%+2%** وAgent (89e68d7) بلا مساس.

---

## ✅ حالة معتمدة — SETTLEMENT INTEGRITY: إصلاح RC-1 / RC-3 / RC-4 / RC-5 من الواجهة (2026-09-23)

**الهدف**: تنفيذ **فقط** الإصلاحات الداخلية المُثبَتة في تقرير `docs/PAYMENT_SETTLEMENT_AUDIT.md` المعتمد — بلا Bank Settlement/Payout/Treasury، بلا تكامل مزوّد جديد، بلا `settlement_accounts`، وبلا مساس بنموذج العمولة **4% = 2% بائع + 2% مشتري** ولا سياسة العمولة ولا DB reset/drop/push. القاعدة المُطبَّقة: لا يُقبل HTTP 200 ولا رندر الصفحة — الإثبات **UI → API → DB/response → UI**.

**الإصلاحات (كود الإنتاج)**:
- **RC-1** `modules/orders/service.ts`: كان صف الـtransaction يُدرَج بـ`status: 'PAID'` **قبل** تحرّك أي مال، فيرى admin/risk/analytics دفعة لم تحدث. صار `PENDING` ويُرقّى إلى `PAID`/`FAILED` فقط عند تأكيد المزوّد (`applyPaymentSucceeded`/`applyPaymentFailed`).
- **RC-4** `modules/payments/service.ts`: كان مفتاح idempotency `(provider, eventId)` يُحتجَز لأي حدث — بما فيه غير القابل للتنفيذ (UNKNOWN) — فتسلسل `pending → succeeded` بنفس المعرّف يُبتلع كـ«duplicate» ولا يُنفَّذ أبدًا. الآن **الحدث النهائي القابل للتنفيذ فقط** يحتجز المفتاح؛ الحدث غير القابل للتنفيذ يُقرّ ولا يُسجَّل، وإعادة الحدث النهائي تبقى idempotent.
- **RC-5** `modules/payments/service.ts`: الاسترداد لم يكن يعكس عمولة/رسم WASIT، فتبقى العمولة كاملة رغم إرجاع المال. أُضيف `reverseCommissionAndFee`: عكس **تناسبي** لقيود `COMMISSION`+`PAYMENT_FEE` (CREDIT مقابل كل قيد أصلي) مبني على **المبلغ المُسترد التراكمي** ⇒ idempotent بطبيعته ولا يعكس أكثر من الأصل. وصار `transactions.status` يتبع حالة الاسترداد (`REFUNDED`/`PARTIALLY_REFUNDED`).
- **RC-3** `modules/analytics/service.ts` + `modules/revenue/service.ts` + `lib/ledger-flows.ts`: وحدتان كانتا تناقضان نفسها — `/api/revenue/report` كان يُخرج عمولة **سالبة** (`-686.2000`) بينما admin breakdown يُخرجها **موجبة** (`686.2000`)، و`analytics` كان يعدّ **رسوم المزوّد إيرادًا** بينما التقرير يعدّها **تكلفة**. أُضيف `ledger-flow-totals` كمصدر وحيد للاتفاقية: كل المبالغ تُقرأ **موجبة** (CREDIT−DEBIT ثم abs بعد roundMoney)، والرسوم تتبع اتفاقية الـledger (مستفيدها `payment-provider`) ⇒ **تكلفة**، والاسترداد يخفض الصافي. الآن الوجهان متطابقان رقميًا.

**الإثبات (أرقام فعلية)**:
- **من الواجهة الحيّة**: `/api/revenue/report` و`/api/admin/analytics/revenue-breakdown` أصبحا **متطابقين تمامًا**: `commission 733.2000 / paymentFees 366.6000 / refunds 584.5000 / net -217.9000` (قبل: `-686.2000` مقابل `+686.2000`).
- **RC-1/RC-4/RC-5 حيًّا عبر API حقيقي**: tx = `PENDING` قبل الدفع و`PAID` بعده؛ `pending` بنفس `eventId` ⇒ `applied:false` ثم `succeeded` ⇒ `applied:true` وإعادة ⇒ `duplicate:true`؛ ledger العمولة/الرسوم `4/2 → 2/1 (استرداد 50%) → 0/0 (كامل)`.
- **`e2e/settlement-integrity.spec.ts` جديد: 4/4** — كل حالة من الواجهة (admin transactions/orders/ledger/analytics) مع تحقق API/DB.
- **Full server suite: 554/554** (52 ملفًا) — **Typecheck** (server+web) و**Build** (server) نظيفان.
- **E2E انحدار**: `payments` + `financial-audit` + `admin-refunds` + `admin-reports` + `admin-unit-economics` = **18/18**، وعمولة **4% = 2%+2%** ظلّت مثبَّتة (كل تأكيدات `financial-audit` للعمولة نجحت).
- لا migrations ولا reset/drop/push، وبلا مساس بـMarketing Video Agent (89e68d7).

---

## ✅ حالة معتمدة — M7: إصلاح هوية ميزانية الذكاء (الهدف + الدورة) من الواجهة (2026-09-23)

**الهدف**: إغلاق أول فجوة وظيفية حقيقية في M7 بعد استنفاد M6/B18–M6. القاعدة: لا يُقبل HTTP 200 ولا رندر الصفحة — الإثبات **UI → API → DB/response → UI**.

**الفجوة الحقيقية**: `POST /api/admin/ai/budgets` كان يطابق الصف القائم بـ**الهدف فقط** ويتجاهل `period`، بينما محرّك التنفيذ `resolveLimit` (`lib/ai/cost-control.ts`) يقرأ الميزانيات بـ`eq(aiBudgets.period, period)`. فالميزانية اليومية والشهرية مُفترض أن تتعايشا لنفس الهدف، لكن الحفظ كان يستبدل إحداهما بالأخرى. **إثبات من الواجهة**: حفظ `SUPPLIER/DAILY(111)` ثم `SUPPLIER/MONTHLY(222)` ⇒ صف واحد `MONTHLY/222` (ضاع السقف اليومي بصمت).

**الإصلاح**: `modules/admin/ai-routes.ts` — المطابقة صارت `and(targetMatch, eq(aiBudgets.period, body.period))`. لا migrations ولا تغيير في قواعد العمل؛ الحفظ لنفس `(target, period)` يبقى تحديثًا في المكان.

**الإثبات**: `e2e/admin-ai.spec.ts` حالة جديدة — حفظ DAILY ثم MONTHLY من النموذج ⇒ **صفّان** في `/api/admin/ai/budgets`، وكلاهما مرئي في الواجهة؛ وإعادة حفظ DAILY تحديث في المكان (العدد يبقى 2، DAILY=5003، MONTHLY=5002). كما ثُبِّت زر **إعادة احتساب الدرجة** في `/dashboard/trust` (سجل 0→1، الدرجة 65) وفتح محادثة في `/dashboard/messages` (unread 1→0) بلا حاجة لتغيير.

**التحقق**: **Full E2E 181/181** (6.3m) — **server 534/534** (51 ملفًا) — **Typecheck** (server+web) و**Build** (server+web) نظيفان. لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** وسياسة Marketing Video **35–120ث** وAgent (89e68d7) بلا مساس.

---

## ✅ حالة معتمدة — MARKETING VIDEO: سياسة المدة 35–120ث مع تحقق فعلي من مدة الـMP4 (2026-09-23)

**الهدف**: إغلاق Marketing Video رسميًا على نافذة **35–120 ثانية** (شاملة، افتراضي 60)، مع ضمان أن ما يُخزَّن هو **المدة الفعلية للأصل المُنتَج** لا قيمة الطلب.

**الفجوة الحقيقية**: كان التحقق من المدة على **المُدخل فقط** (`zod` + `clamp`)، و`service.ts` يخزّن `rendered.durationSeconds` وهو **echo للطلب**. لا شيء يقرأ bytes الـMP4 الناتج، فأي مزوّد يُقصّر الرندر كان سيُسجَّل READY بمدة كاذبة.

**الإصلاح** (الملفات): `packages/shared/src/constants/media.ts` (ثوابت موحّدة MIN=35/MAX=120/DEFAULT=60 يشترك فيها الخادم والواجهة) — `packages/server/src/lib/media/mp4.ts` (`measureMp4DurationSeconds` يقرأ `moov/mvhd` بلا اعتماديات، ويتعامل مع `+faststart` وصناديق 64-bit) — `modules/media/service.ts` (قياس المدة من bytes بعد الرندر، رفض ما يخرج عن النافذة قبل READY، وتخزين القيمة المقاسة) — `modules/media/routes.ts` (schema من الثوابت المشتركة) — `lib/media/video-provider.ts` (رفع timeout الرندر لاستيعاب 120ث) — `pages/DashboardVideoStudioPage.tsx` (`min=35`/`max=120`/افتراضي 60 من الثوابت المشتركة).

**التحقق (أرقام فعلية)**:
- **marketing-video.test.ts: 16/16** — 34/121/4/300 ⇒ **422**؛ قبول 35 و120 مع **إعادة قياس مستقلة** للمدة من الـbytes عبر الرابط الموقّع ومطابقة صف الـDB؛ ومزوّد مُتلاعَب به (رندر 10ث بإدخال 35 مقبول) ⇒ **502** ورفض الأصل — أي أن التحقق من الـMP4 الفعلي يمنع مدة غير صحيحة.
- **Full E2E: 180/180** (6.0m) — يشمل توليد **35ث و120ث من الواجهة** ومعاينة `<video>` حقيقي، ورفض 4/34/121/300 بـ`VALIDATION_ERROR`.
- **Full server unit suite: 534/534** (51 ملفًا) — **Typecheck** (server+web) و**Build** (server+web) نظيفان.
- لا migrations ولا DB reset/drop/push؛ العمولة **4% = 2%+2%** والـMarketing Video Agent (89e68d7) بلا regression.

## ✅ حالة معتمدة — M6: ADMIN DESK CONTROLS PROVEN FROM THE UI (2026-09-23)

**الهدف**: إغلاق آخر عناصر التحكّم المتبقّية من المسح الآلي لكل `data-testid` تفاعلي: أزرار `*-refresh` في لوحات الأدمن، ومُحدِّد `comparison-category-select`، وزر `admin-ai-model-cancel`. القاعدة المُطبَّقة: لا يُعتبر reload ناجحًا إلا إذا أثبت **UI → API → DB/response → UI**.

**الفجوة**: كانت أزرار `admin-ai-refresh`، `admin-obs-refresh`، `admin-reports-refresh`، `admin-privacy-refresh`، `admin-sub-refresh` موصولة بـ`load()` الذي يُنفَّذ مرة واحدة عند mount، لكن **لا اختبار نقرها بعد تغيير حقيقي من طرف آخر**، فلم يكن مُثبَتًا أنها تعيد القراءة فعلًا بدل عرض لقطة قديمة. (كان `admin-ads-refresh` الوحيد المُثبَت، M5.)

**الإصلاح**: لا تغيير في كود الإنتاج — كل الأزرار كانت صحيحة؛ الفجوة كانت في الإثبات. أُضيفت حالات E2E حقيقية لكل زر:

| الزر/المسار | الإثبات (UI → API → DB → UI) |
| --- | --- |
| `admin-ai-refresh` | طلب AI حقيقي من جلسة مشترٍ بعد رندر الجدول ⇒ النقر يُقدّم الصف الجديد للأعلى ويطابق أحدث صف من `/api/admin/ai/requests?limit=1` |
| `admin-obs-refresh` | 5 طلبات HTTP حقيقية من طرف آخر ⇒ عدّاد `admin-obs-kpi-requests` يزيد بعد النقر (الصفحة لا تُpoll) |
| `admin-reports-refresh` | تقرير يُنشأ من جلسة `admin2` بعد فتح الصفحة ⇒ النقر يزيد عدد الصفوف ويُظهر كود التقرير |
| `admin-privacy-refresh` | طلب حذف حقيقي يُقدَّم بعد فتح الصفحة ⇒ النقر يزيد صفوف الطابور ويُظهر `admin-privacy-row-<id>` |
| `admin-sub-refresh` | اشتراك حقيقي عبر API بعد استقرار التحميل الأولي ⇒ صف `admin-sub-<id>` غير موجود قبل النقر وموجود بعده |
| `admin-ai-model-cancel` | تعديل نموذج ثم Cancel ⇒ النموذج يُصفَّر (key فارغ، الزر يختفي) **والخادم يحتفظ بالاسم الأصلي** (لا كتابة) |
| `comparison-category-select` | اختيار تصنيفين حقيقيين: URL + `comparison-count` يطابقان `pagination.total`، والتصنيف الفارغ يُظهر empty state (تغطية قائمة، لا تغيير) |

**قاعدة مدة الفيديو**: مؤكَّدة **35–120 ثانية** (شاملة)، والافتراضي **60 ثانية**. الواجهة تثبت `min=35`/`max=120`، وAPI يرفض 34/121/4/300 بـ**422**. الأهم: **المدة تُقاس فعليًا من bytes الـMP4 الناتج** بعد الرندر (وليس من قيمة الطلب)، وتُخزَّن القيمة المقاسة، ولو خرجت عن النافذة يُرفض الـasset ولا يصبح READY.

**إصلاح عرض ثانوي**: `e2e/marketplace.spec.ts` (اختبار MOQ) صار يتنقّل بين صفحات السوق حتى 12 بدل الاكتفاء بالصفحة الأولى — نفس انجراف القائمة المُوثَّق في M5 (`placeOrderViaUi`). لم يُمسّ أي كود إنتاج.

**التحقق**: **Full E2E 179/179** (7.2m) — **الخادم 531/531** (51 ملفًا) — **Typecheck** (server+web) و**Build** (server+web) نظيفان. لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** والـMarketing Video Agent بلا مساس.

---


## ✅ حالة معتمدة — B17: ADMIN AI GOVERNANCE WRITES (2026-09-22)

**الهدف**: إغلاق الفجوة الداخلية التالية بعد B16 حسب ترتيب الـroadmap. المسارات الخادمية للكتابة في حوكمة الذكاء كانت **منفَّذة ومُختبَرة**، لكن **صفر مستدعين في الواجهة**: تبويبا «النماذج» و«الميزانيات» في `/admin/ai` كانا جدولي قراءة فقط، ودالتا العميل `adminUpsertAiModel`/`adminUpsertAiBudget` بلا مستدعٍ. الأسوأ أن `adminUpsertAiModel` لم يكن له **أي اختبار خادمي** إطلاقًا — فالـupsert بالنموذج كان غير مُثبَت من أي سطح.

**دليل الفجوة قبل الإصلاح**:
- `packages/web/src/lib/api.ts`: `adminUpsertAiModel` و`adminUpsertAiBudget` معرَّفتان؛ `grep -r` في `packages/web/src/**` ⇒ **0 مستدعين**.
- `packages/web/src/pages/AdminAiPage.tsx`: تبويبا `models`/`budgets` جدولا عرض فقط (6 أعمدة، بلا عمود إجراءات ولا نموذج).
- `packages/server/src/modules/admin/ai-routes.ts`: `POST /models` و`POST /budgets` موجودان مع Audit.
- `packages/server/tests/admin-ai.test.ts`: يغطّي `POST /budgets` فقط؛ **لا اختبار لـ`POST /models`** (والـe2e كان يُنشئ الميزانية عبر `page.request` لا عبر الواجهة).

**ما تم**:

| البند | النتيجة |
| --- | --- |
| **نموذج النماذج في الواجهة** | ✅ `admin-ai-model-form` (key/name/provider/context/maxout/currency/input/output/تفعيل) → `POST /api/admin/ai/models`؛ upsert بـ`key` فلا يتكرّر الصف |
| **تعديل نموذج** | ✅ زر `admin-ai-model-edit-<key>` يملأ النموذج ويحوّل الزر إلى «حفظ التعديل» + إلغاء |
| **تفعيل/إيقاف نموذج** | ✅ زر `admin-ai-model-toggle-<key>` يقلب `isActive` عبر نفس الـupsert، مع Badge محدَّث من الخادم |
| **نموذج الميزانيات** | ✅ `admin-ai-budget-form`: الهدف حسب الدور أو المستخدم (واحد فقط)، الدورة، حد الطلبات، حد الكلفة، العملة → `POST /api/admin/ai/budgets` |
| **تفعيل/إيقاف ميزانية** | ✅ زر `admin-ai-budget-toggle-<id>` |
| **نتيجة مرئية للمستخدم** | ✅ إشعار نجاح لكل عملية، الصف الجديد/المحدَّث يظهر فورًا من الخادم (لا حالة محلية فقط) |
| **i18n** | ✅ مفاتيح `adminAi.model.*`/`adminAi.budget.*` الجديدة + `common.activate`/`common.deactivate` + `common.actions` (المفقودة في fr/zh) في ar/fr/en/zh |
| **Server tests** | ✅ `admin-ai.test.ts` (+3): upsert نموذج insert→update بالـ`key` نفسه، قيد `AI.MODEL_UPSERTED`، بقاء صف واحد، ثم تنظيف الصف؛ رفض `userId`+`roleTarget` معًا 422 |
| **E2E من الواجهة** | ✅ `e2e/admin-ai.spec.ts` (+3 حالات حقيقية: إنشاء نموذج من النموذج ثم التحقق من الخادم وإيقافه من الصف ثم استرجاعه؛ تعديل يملأ النموذج ويحدّث في المكان بلا صف مُكرَّر؛ إنشاء ميزانية وتبديلها مع التحقق من الراية المخزَّنة) |
| **Full E2E** | ✅ **158/158 passed** (155 قبل هذا البند + 3) |
| **Server suite** | ✅ **524/524 — 51 ملف** |
| **Typecheck + build** | ✅ `@wasit/server` + `@wasit/web` نظيفان و`vite build` ناجح |

**ملاحظة صريحة**: سلوك الإلغاء في زر الجلسات/المنتجات لم يُلمَس؛ الكتابة الجديدة تُمرَّر عبر نفس الـupsert الخادمي القائم (بلا مسار خادمي جديد وبلا migration — الجداول `ai_models`/`ai_budgets` موجودة من قبل).

**دون مساس**: Commission Policy 4% = 2%+2%، وMarketing Video Agent (commit `89e68d7`)، وPrice Comparison، وOrder Lifecycle، وUnit Economics UI، وG/H/I/J، وE2–E5، وB10–B16.

---

## ✅ حالة معتمدة — B16: ADMIN REPORTS UI (2026-09-22)

**الهدف**: إغلاق الفجوة الداخلية التالية بعد B15 حسب ترتيب الـroadmap. الفجوة لم تكن في قدرة الخادم — `GET/POST /api/admin/analytics/reports` منفَّذان ومُختبَران — بل في **سطح المستخدم**: لا صفحة `/admin/reports` ولا مدخل تنقّل ولا أي مستهلك لدالتي العميل `adminAnalyticsReports()`/`adminCreateAnalyticsReport()`، فالمشغّل لا يستطيع إنشاء تقرير من المنتج ولا رؤيته. وكشف التدقيق سببًا حقيقيًا إضافيًا: `listDashboardReports` كانت تُسقط `reportData` من الاستجابة ⇒ التقرير المحفوظ **صالح للكتابة فقط** ولا يمكن قراءة محتواه حتى عبر API.

**دليل الفجوة قبل الإصلاح**:
- `docs/UI_SCREEN_MAP.md` يسرد «Reports» ضمن شاشات الأدمن، و`docs/API_SPECIFICATION.md:269` يوثّق `GET/POST /api/admin/analytics/reports`.
- `api.adminAnalyticsReports()` و`adminCreateAnalyticsReport()` ونوع `DashboardReportRow` موجودة، وصفر مستدعين في `packages/web/src/**/*.tsx`.
- `ADMIN_NAV` فيه `/admin/analytics` فقط بلا `/admin/reports`.
- `packages/server/src/modules/analytics/service.ts`: دالة القائمة تُعيد `{id,reportCode,title,createdAt}` فقط رغم وجود عمود `report_data`.

**ما تم**:

| البند | النتيجة |
| --- | --- |
| **إصلاح السبب الجذري (backend)** | ✅ `listDashboardReports` تُعيد `reportData` و`generatedById` إلى جانب البيانات الوصفية (بلا migration — `dashboard_reports.report_data` موجود من قبل) |
| **صفحة `/admin/reports`** | ✅ `AdminReportsPage`: نموذج (code + title + JSON اختياري) مع رفض JSON غير صالح في الواجهة قبل الإرسال، جدول من الخادم، زر «عرض» يكشف المحتوى المخزّن، وزر «تحديث» |
| **نتيجة مرئية للمستخدم** | ✅ إشعار «تم حفظ التقرير»، ظهور الصف الجديد فورًا، و«عرض» يبدّل إلى «إخفاء» ويعرض الـJSON المخزّن |
| **تنقّل + RBAC** | ✅ `/admin/reports` في `App.tsx` خلف `AdminOnly`، ومدخل في `ADMIN_NAV`؛ الصلاحية الخادمية `admin:analytics` لم تتغيّر |
| **i18n** | ✅ مفاتيح `admin.reports` + `adminReports.*` في ar/fr/en/zh |
| **Server test** | ✅ `analytics.test.ts` يتحقق الآن أن `reportData` العائد يساوي المُرسَل (وليس البيانات الوصفية فقط) — **522/522** |
| **Full E2E من الواجهة** | ✅ `e2e/admin-reports.spec.ts` (3 حالات): إنشاء تقرير من الواجهة ثم قراءة محتواه المخزّن بعد «عرض» مع تطابق حمولة الـAPI، رفض JSON غير صالح بلا إنشاء، 403 لغير الأدمن — **155/155** |
| **Typecheck + build** | ✅ نظيف (`@wasit/server` + `@wasit/web` + build الويب) |
| **Manual browser smoke** | ✅ دخول `admin@wasit.tn` → `/admin/reports` → إنشاء `manual-smoke-q3` → ظهر الصف والإشعار → «عرض» أظهر `{"period":"Q3","gmv":123456}` |

**دون مساس**: Commission Policy 4% = 2%+2%، وMarketing Video Agent (commit `89e68d7`)، وPrice Comparison، وOrder Lifecycle، وUnit Economics UI، وG/H/I/J، وE2–E5.

---

## ✅ حالة معتمدة — A3: REFUNDS FROM THE ADMIN UI (2026-09-22)

**الهدف**: إغلاق أول فجوة داخلية حقيقية بعد E5 حسب ترتيب الـroadmap. الفجوة لم تكن في قدرة الخادم — الاسترداد منفَّذ ومُختبَر بالكامل على مستوى الـAPI — بل في **سطح المستخدم**: لم يكن هناك أي زر أو مسار في الواجهة يُنشئ استردادًا، فكان `api.createRefund` بلا مستدعٍ واحد، وصفحة `/admin/orders` للقراءة فقط. أي أن المشغّل (ADMIN/SUPER_ADMIN فقط) لا يستطيع تنفيذ الاسترداد من المنتج إطلاقًا.

**دليل الفجوة قبل الإصلاح**:
- `packages/web/src/lib/api.ts`: `createRefund` موجود، وصفر مستدعين في `packages/web/src/**/*.tsx`.
- `AdminOrdersPage`: جدول بلا عمود حالة دفع وبلا أي إجراء.
- `e2e/payments.spec.ts`: كان يثبت الاسترداد عبر `page.request` (HTTP خام) لا عبر الواجهة.

**ما تم**:

| البند | النتيجة |
| --- | --- |
| **`GET /api/admin/orders`** | ✅ يُسقط الآن `paymentStatus` + `refundStatus` + `currencyCode` (أعمدة موجودة أصلًا — **لا migration ولا تغيير schema**) حتى تعرف الواجهة أي طلب قابل للاسترداد |
| **زر الاسترداد في `/admin/orders`** | ✅ يظهر فقط لـ`PAID`/`PARTIALLY_REFUNDED`؛ يفتح لوحة تعرض تاريخ الاستردادات ثم نموذجًا (المبلغ اختياري = كامل المتبقي، والسبب اختياري) |
| **نتيجة مرئية للمستخدم** | ✅ إشعار نجاح + تحديث الصف إلى `REFUNDED`/`PARTIALLY_REFUNDED`، وسجل الاستردادات في اللوحة |
| **إصلاح سبب حقيقي (UX)** | ✅ كان `message` العام `"Validation failed"` يُعرض بدل السبب الفعلي (`Refund exceeds remaining refundable amount 316.2000`) لأن **نوع الواجهة كان خاطئًا**: `fieldErrors?: Record<string,string[]>` بينما الشكل الفعلي على السلك `FieldError[]`، فلا يستطيع أي مستدعٍ قراءته. صُحّح النوع + أُضيف `apiErrorMessage()` (يفضّل رسائل الحقول) و`apiCall` يستخدمه ⇒ كل الواجهة تستفيد |
| **RBAC دون تغيير** | ✅ الاسترداد يبقى خلف `refund:manage` على الخادم؛ العميل لا يمنح صلاحية |
| **idempotency** | ✅ مفتاح جديد لكل فتح نموذج ⇒ ضغط مزدوج يعيد نفس الاسترداد بدل استردادين |
| **Server test** | ✅ اختبار جديد: الإسقاط الإداري يحمل `PAID`/`NONE`/`TND` ثم `REFUNDED`/`COMPLETED` — **519/519** |
| **Full E2E من الواجهة** | ✅ 3 اختبارات متصفح حقيقية (`e2e/admin-refunds.spec.ts`): استرداد كامل (زر + إشعار + صف + تحقق مستقل عبر API + قيد `REFUND`/`DEBIT` في الـLedger)، ورفض over-refund مع إظهار السبب وبقاء الطلب `PAID`، واسترداد جزئي يبقي الطلب قابلًا للاسترداد — **148/148** |
| **Typecheck + build** | ✅ نظيف (`@wasit/server` + `@wasit/web` + build الويب) |

**دون مساس**: Commission Policy 4% = 2%+2%، وMarketing Video Agent (commit `89e68d7`)، وG/H/I/J، وE2–E5.

---


## ✅ حالة معتمدة — E4/E5: BACKUP AUTOMATION + MONITORING/ALERTING (2026-09-22)

**الهدف**: إكمال آخر بند فعلي متبقٍّ في Deployment/Staging Hardening حسب ترتيب الـroadmap — تشغيل النسخ الاحتياطي تلقائيًا، وربطه بالمراقبة بحيث لا يموت الجدول صامتًا.

| البند | النتيجة |
| --- | --- |
| **خدمة `backup` في compose** | ✅ تنسخ فور الإقلاع ثم كل `BACKUP_INTERVAL_SECONDS` (افتراضي 86400)؛ صورة `postgres:16` لتطابق عميل `pg_dump` مع الخادم؛ النسخ ناجح فعليًا داخل الـStack |
| **قلب النسخ (heartbeat)** | ✅ `scripts/backup-db.sh` يكتب `.last-success.json` و`checksums.sha256` بعد كل نجاح؛ الـapi يقرأه **قراءة فقط** عبر volume `backup-data` |
| **`/api/health/channels`** | ✅ يعرض `backup.lastSuccessAt` و`backup.ageHours` و`backup.maxAgeHours` (بلا أسرار) |
| **قاعدة `backup_stale`** | ✅ جديدة: CRITICAL عند تجاوز العمر `BACKUP_MAX_AGE_HOURS` (26) أو غياب القلب؛ خاملة إن لم يُضبط `BACKUP_HEARTBEAT_FILE` |
| **إطلاق حقيقي** | ✅ تقادم القلب إلى 54.19h ⇒ `POST /api/admin/observability/alerts/evaluate` ⇒ `fired: ["backup_stale"]`، ثم صف FIRING في `alert_events`، ثم RESOLVED بعد تجديد القلب |
| **إصلاح bug حقيقي (state بعد restart)** | ✅ كانت حالة القواعد in-memory فقط؛ بعد restart يبقى صف FIRING معلّقًا وتُكرَّر الإطلاقات. الآن تُعاد الحالة من `alert_events` عند أول تقييم لكل عملية ⇒ انتقال صحيح FIRING→RESOLVED بلا تكرار |
| **جدولة خارج الحاويات** | ✅ `scripts/deploy/backup.cron` + `wasit-backup.service`/`.timer` |
| **توثيق** | ✅ `docs/DEPLOYMENT.md` §4/§5/§6 مُحدَّثة (تشغيل/مراقبة/تنبيه) |
| **Server unit suite** | ✅ **492/492 — 48 ملف** (+3 اختبارات جديدة: قاعدة `backup_stale`، خمولها، rehydration) |
| **Full E2E (UI, real API+DB)** | ✅ **128/128 passed** (+1 اختبار متصفح جديد لتقادم القلب عبر الواجهة) |
| **Typecheck + build** | ✅ نظيف (`@wasit/server` + `@wasit/web`) |

**ملاحظة اختبار معروفة**: تشغيل `observability.test.ts` منفردًا يُظهر فشلًا واحدًا في اختبار حلقة اللوج (`buffers recent records...`)، وهو فشل قائم مسبقًا في `HEAD` وسببه ترتيب حلقة اللوج المُشتركة بين الملفات، وليس من هذا التغيير — المجموعة الكاملة نظيفة.

**دون مساس**: Commission Policy 4% = 2%+2%، وMarketing Video Agent (commit `89e68d7`).

---

## ✅ حالة معتمدة — E1: LOCAL/CI STAGING STACK VERIFICATION (2026-09-22)

**الهدف**: إغلاق الجزء القابل للإثبات داخل الريبو من `E1 — Staging environment` (أول بند غير مكتمل بعد F3)، دون ادّعاء أي بنية خارجية.

**ما تم (كلّه داخل نطاق الريبو)**:

| البند | النتيجة |
| --- | --- |
| **`scripts/staging-smoke.sh`** (جديد) | ✅ اختبار قابل للتكرار: يولّد `.env.staging.smoke` بأسرار عشوائية، يقلع مشروع compose منفصلًا (فوليومات مستقلة) فلا يلمس DB المطوّر، وينظّف containers/volumes/env عند الانتهاء **بما في ذلك عند الفشل** |
| **تشغيل بـ`NODE_ENV=staging`** | ✅ عبر `.env.staging.example` مع خطوة `migrate → seed → serve` |
| **build + up** | ✅ `db + api + web + backup`؛ يبني `dist-bundle` للتحقق من حارس الإقلاع |
| **صحة الخدمات الثلاث** | ✅ `db`/`api`/`web` كلها `healthy` |
| **التحقق عبر nginx (لا منفذ API)** | ✅ `/`=200، `/api/health/live`=200، `/api/health/ready`=`ready/connected`، `/api/health/channels`=`ok` وبلا حقول أسرار |
| **تسجيل → تحقق → دخول** | ✅ register 201 → رمز تحقق حقيقي → verify 200 → login 200 + كوكي جلسة → `/api/auth/me` يعيد الحساب |
| **قراءة السوق/منتج** | ✅ 10 تصنيفات؛ `GET /api/products`=200؛ إنشاء كيان تاجر → نشر منتج → قراءة عامة باسمه + ظهوره في البحث |
| **حداثة قلب النسخ** | ✅ `/api/health/channels.backup` = configured، والعمر `0h <= 26h` |
| **الفشل المُغلق (JWT)** | ✅ `NODE_ENV=staging` + `JWT_SECRET` التنموي المُلزَم ⇒ خروج بغير صفر ورسالة تذكر `JWT_SECRET`؛ وبسر صالح يمرّ الحارس |
| **`scripts/staging-smoke.sh`** | ✅ **36/36 pass** |
| **`.env.staging.example`** | ✅ أُضيفت `AI_PROVIDER`/`AI_MODEL`/`AI_DEFAULT_MODEL`/`AI_API_KEY`/`AI_REQUEST_TIMEOUT_MS` و`BACKUP_HEARTBEAT_FILE`/`BACKUP_MAX_AGE_HOURS`/`BACKUP_RETENTION_COUNT`/`BACKUP_INTERVAL_SECONDS`؛ وصُحّح تعليق التحذير لينسب حماية `JWT_SECRET` إليها بدقة (لا إلى `ALLOW_DEV_TOOLING`) |
| **`docker-compose.yml` / nginx / Dockerfiles** | ✅ روجعت بلا تغيير — لا حاجة لتغيير architecture لإثبات E1 |
| **`.gitignore`** | ✅ تجاهل `.env.staging.smoke` و`.env.staging.smoke.failed` |

**إصلاح اختبار واحد أثناء التنفيذ**: استعلام `GET /api/products?q=` يبحث في الاسم/الوصف (لا `sku`)؛ كان الاختبار يفترض البحث بـSKU. صُحّح الاختبار ليبحث بالاسم — **لا تغيير في الكود الإنتاجي**.

**تمييز صريح للإثبات**:
- **E1 داخل نطاق الريبو = verified ✅** (`scripts/staging-smoke.sh` 36/36).
- **Hosted staging = ❌ غير مكتمل**: يتطلب بنية خارجية — VM/مضيف، نطاق + DNS/TLS، أسرار منفصلة في secret store، ووجهة نسخ خارجية. لا يُدَّعى إغلاقه.

**الاختبارات**: `scripts/staging-smoke.sh` 36/36؛ Server suite كاملة؛ Full E2E؛ `typecheck`؛ builds.

**دون مساس**: Commission Policy 4% = 2%+2%، F3 (`18e0c72`)، Marketing Video Agent (`89e68d7`)، لا Security/Cyber agent، لا db reset/drop/push.

---

## ✅ حالة معتمدة — F3: EXTERNAL AI PROVIDER VERIFICATION (2026-09-22)

**الهدف**: إغلاق أول بند غير مكتمل فعليًا بعد E5 حسب ترتيب roadmap/PRODUCTION_GAP_LIST: `F3 — AI provider خارجي مُتحقق`. F4 (Marketing Video) مُثبَت أنه منفَّذ في `89e68d7` ولم يُمَس.

**٣ bugs حقيقية اكتُشفت وأُصلحت** (لم تكن مجرد نقص اختبار):

| # | السبب الجذري | الأثر قبل الإصلاح |
| --- | --- | --- |
| 1 | `provider.ts` تغليف معكوس: `env.AI_MODEL ?? 'gpt-4o-mini'` — و`AI_MODEL` قيمته الافتراضية `''` في zod فتُستخدم السلسلة الفارغة (`??` لا يلتقط الفارغ) | مزوّد خارجي مع مفتاح صالح يُبلَّغ `isAvailable()===false` ⇒ كل نداء ينحدر صامتًا إلى المحرك المحلي؛ الـAI المدفوع لا يعمل أبدًا |
| 2 | `runtime.ts`: `input.modelKey ?? env.AI_MODEL?.length ? env.AI_MODEL : 'local-heuristic'` — أسبقية عوامل JavaScript خاطئة | `modelKey` القادم من الراوتر يُتجاهَل، والطراز يُختار من env أو يسقط إلى `local` |
| 3 | `resolveAiRoute` كانت تُرجع مُمثِّل مزوّد **غير متاح** في مسار الانحدار، ولا تُترجم مفتاح الكتالوج إلى اسم الطراز لدى المزوّد، و`runAIFeature` كانت تُعيد حل المزوّد بنفسها فتُهمل اختيار الراوتر | اختيار المزوّد/القدرة يُبتلع؛ لا يوجد أي مكان يُمرَّر فيه الطراز المُوجَّه إلى المزوّد |

**ما تغيّر**:
- `lib/ai/provider.ts`: أسبقية `model` لكل نداء (`opts.model` يتقدم على افتراضي المحول)، `VENDOR_DEFAULT_MODELS`، حراسة `vendorFetch` بحد زمني (`AI_REQUEST_TIMEOUT_MS`) وتحويل أخطاء النقل/الحالة إلى 503 آمن **دون بثّ جسم المزوّد** (لا تسريب مفتاح/هوية الحساب)، وتسجيل التفاصيل في اللوج فقط.
- `lib/ai/types.ts`: `AIProviderCallOptions.model` (الطراز الموجَّه لكل نداء).
- `lib/ai/routing.ts`: أسبقية صريحة (طلب > سياسة القدرة > `AI_MODEL` > `AI_DEFAULT_MODEL`)، `vendorModel` (ترجمة مفتاح الكتالوج → اسم المزوّد)، ومسار انحدار يُنشئ `LocalHeuristicProvider` فعّالًا مباشرة.
- `lib/ai/runtime.ts`: أسبقية طراز صحيحة، تمرير `provider`/`vendorModel` من الراوتر، ربط السعر بالمزوّد **الفعلّي** (مزوّد مجاني لا يُفوتر بسعر مدفوع)، وتسجيل صف `ai_requests` بحالة `UNAVAILABLE`/`FAILED` بلا فاتورة tokens عند فشل المزوّد.
- `modules/ai/routes.ts`: تمرير المزوّد المُوجَّه والطراز. `modules/ai/service.ts`: تقرير `defaultModel` الصحيح.

**الإثبات**: `tests/ai-provider-routing.test.ts` (16 حالة) يشغّل **خادم HTTP محلي حقيقي** يعمل كطرف مزوّد، فتسلك المحوّلات `OpenAIChatCompletionsProvider`/`AnthropicProvider`/`LocalHeuristicProvider` مسارها الكامل (round-trip HTTP حقيقي، بلا Mock لمنطق AI ولا مفتاح حقيقي): نجاح + قراءة usage + تمرير الطراز الموجَّه، 401 → 503 آمن بلا تسريب، timeout فعلي (إلغاء)، غياب المفاتيح → 503، وأسبقية الطراز/المزوّد/السعر وعدم كتابة المفتاح في حلقة اللوج.

**تمييز صريح للإثبات**: **integration verified by tests = ✅** (تكامل حقيقي مقابل خادم HTTP محلي). **real external credential smoke test = ❌ لم يُنفَّذ** لعدم وجود مفتاح مزوّد حقيقي في البيئة؛ لا يُدَّعى أنه verified.

**الاختبارات**: Server suite **508/508 — 49 ملف** (+16). Full E2E **128/128**. `typecheck` + `build` نظيفان.

**دون مساس**: Commission Policy 4% = 2%+2%، Marketing Video Agent (`89e68d7`)، لا Security/Cyber agent، لا db reset/drop/push.

---

## ✅ حالة معتمدة — PHASE 20: STAGING / E1 (2026-09-21)

**الهدف**: فصل بيئة Staging عن الإنتاج، تأمين أسرارها، وإكمال مسار `migrate → seed → serve` مع Health checks، ثم التحقق من الدخول والتسجيل من الواجهة الحقيقية على الـStack المُعاد بناؤه.

| البند | النتيجة |
| --- | --- |
| **Staging stack (compose, rebuilt)** | ✅ `project-api-1` / `project-web-1` / `project-db-1` كلها **healthy** على `:8080` |
| **Health** | ✅ `/`, `/api/health/live`, `/api/health/ready` = 200 عبر nginx |
| **Migrate → Seed → Serve (DB نظيف)** | ✅ migrations + seed المرجعي ثم boot ناجح، `/api/health/ready` = `ready/db connected` |
| **Secrets** | ✅ `JWT_SECRET` (64 hex) و`POSTGRES_PASSWORD` (48 hex) عشوائية، مختلفة عن افتراضي التطوير |
| **حرس الإنتاج** | ✅ `NODE_ENV=production` + `ALLOW_DEV_TOOLING=true` ⇒ رفض البدء؛ `staging` + JWT الافتراضي الملتزم ⇒ رفض البدء |
| **Cookie `Secure`** | ✅ لا يُضبط على staging عبر HTTP محلي (وإلا لفشل الدخول صامتًا)، ويُضبط على HTTPS/الإنتاج |
| **Login/Registration من الواجهة** | ✅ register → verify-email → login (201/200/200) ثم دخول من المتصفح |
| **Browser Functional Smoke (staging)** | ✅ **12/12** صفحة تاجر حقيقية بلا `role=alert` وبلا أي HTTP ≥400 |
| **Full E2E (UI, real API+DB)** | ✅ **97/97 passed** |
| **Server unit suite** | ✅ **457/457 — 45 ملف** |
| **Typecheck + build (server/web)** | ✅ نظيف |

### قرارات الإصلاح في هذه المرحلة
1. **قاعدة مدة الفيديو 35–120ث**: هي السياسة المعتمدة نهائيًا (شاملة)، والافتراضي **60ث**. تُفرض في الواجهة (`min=35`/`max=120`) وفي schema الـAPI (422 خارج النافذة)، **وتُتحقَّق فعليًا من bytes الـMP4** بعد الرندر: تُقرأ المدة من `moov/mvhd`، وتُرفض القيمة إن خرجت عن النافذة (لا يصبح الـasset READY)، وتُخزَّن المدة **المقاسة** لا قيمة الطلب.
2. **رسالة إنشاء المنتج**: كانت صفحة إنشاء المنتج تعرض نص «تم إنشاء الطلب بنجاح»؛ صُحّحت إلى «تم إنشاء المنتج بنجاح» عبر مفتاح `product.createSuccess` في اللغات الأربع، وحُدِّث تأكيد E2E ليطابق الوظيفة الفعلية.
3. **عمولة**: بقيت **4% = 2% seller + 2% buyer** بلا مساس.
4. **Marketing Video Agent**: بقي كما هو — لا regression.

---

## ✅ حالة معتمدة — Functional UI Audit (Drive the real interface) (2026-09-20)

**الهدف**: تدقيق وظيفي حقيقي من الواجهة نفسها — لا SPA routes ولا HTTP 200 وحده. كل اختبار يقود المتصفح الحقيقي (Playwright + Chromium)، يضغط الأزرار الفعلية، يقرأ ما يراه المستخدم، ثم يتحقق من الأثر عبر الـAPI الحيّ. Backend حقيقي + PostgreSQL، بلا mocks (`packages/web` على `:12000`، API على `:3000`).

| البند | النتيجة |
| --- | --- |
| **Full E2E (UI, real API+DB)** | ✅ **97/97 passed** (54s) — `npx playwright test` |
| **Server unit suite** | ✅ **434/434 — 42 ملف** (`npm test`) |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 |
| **Web Typecheck + Build** | ✅ `tsc --noEmit` = 0 و`vite build` = 0 |
| **`e2e/functional-audit.spec.ts`** | جديد — CUSTOMER / MERCHANT / MARKETING VIDEO / ADS / AI / ONBOARDING / MESSAGING / NOTIFICATIONS |
| **`e2e/navigation-audit.spec.ts`** | جديد — كل رابط في sidebar التاجر والإدارة يفتح صفحة حقيقية (لا 404 shell) |

### الأعراض الجذرية التي أُصلحت (من الواجهة، لا من API)
1. **Verify email لا يفتح**: كان مسار `/verify-email` غائبًا من الـrouter رغم وجود endpoint — إضافة `VerifyEmailPage` + `api.verifyEmail` + route.
2. **نشر/إخفاء المنتج معطّل من الواجهة**: لم تكن هناك واجهة لمعرّف الكيان البائع. أُضيف `GET /api/products/mine/entities` (+ `listOwnedSellerEntities`) وربطها بالمُنشئ/المحرّر.
3. **لوحة البائع تُظهر إحصاءات الإدارة**: كان `DashboardOverviewPage` يقرأ `adminStats` للجميع. الآن البائع يرى أرقامه الخاصة (`myAnalyticsOverview`)، والإدارة ترى الإجماليات.
4. **عنوان الإشعار**: `NotificationsBell` كان يستخدم fallback ثابتًا؛ الآن يعرض `n.title` ثم `data.title` ثم الترجمة حسب النوع.
5. **حذف فيديو تسويقي يبقى ظاهرًا**: API يحتفظ عمدًا بالأصل soft-deleted للتدقيق (مؤكد في `tests/marketing-video.test.ts:259`)؛ الإصلاح في الواجهة فقط — تصفية `status !== 'DELETED'` من المكتبة.
6. **صفحة منتجات الإدارة مفقودة**: أُضيفت `AdminProductsPage` + `/admin/products` + `adminProducts`/`adminSuspendProduct`.
7. **عمولة**: بقيت **4% = 2% seller + 2% buyer** بلا مساس.
8. **Marketing Video Agent (89e68d7)**: بقي كما هو — لا regression.

### لماذا كانت اختبارات الـMFA/payments تفشل في المجموعة الكاملة
الخادم كان يعمل يدويًا بلا هامش حدّ المعدل الذي يضبطه `playwright.config.ts` (`RATE_LIMIT_LOGIN_MAX=500`)، و`reuseExistingServer` يعيد استخدامه → 429. أُعيد تشغيل الخادم ببيئة E2E. وكذلك استنزاف المخزون عبر 14 إنشاء طلب في الجولة → فشل `placeOrderViaUi`. كلاهما **عيب في تهيئة الاختبار** لا في المنتج (كلٌّ ينجح منفردًا).

### الملفات
- جديدة: `e2e/functional-audit.spec.ts`, `e2e/navigation-audit.spec.ts`.
- معدّلة: `packages/web/src/{App.tsx,pages/AuthPages.tsx,pages/AdminPages.tsx,pages/DashboardOverviewPage.tsx,pages/DashboardProductsPage.tsx,pages/DashboardVideoStudioPage.tsx,pages/DashboardMessagesPage.tsx,components/layouts/NotificationsBell.tsx,lib/api.ts,lib/i18n.ts,vite.config.ts}`, `packages/server/src/{lib/seller-ownership.ts,modules/products/{routes.ts,service.ts}}`.

### جدول التدقيق الوظيفي (Functional Audit Matrix)

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| CUSTOMER register/login | ✅ form حقيقي | ✅ PASS | — | — | E2E |
| CUSTOMER logout | ✅ زر | ✅ PASS | — | — | تحقّق يدوي + E2E |
| Search (home form) | ✅ كتابة + زر بحث | ✅ PASS | — | — | E2E |
| Browse marketplace | ✅ | ✅ PASS | — | — | E2E |
| Product details | ✅ ضغط بطاقة منتج | ✅ PASS | — | — | E2E |
| Create purchase (checkout) | ✅ إتمام طلب | ✅ PASS | — | — | E2E |
| Orders list + detail | ✅ | ✅ PASS | — | — | E2E |
| Notifications (titles/read) | ✅ الجرس | ✅ PASS | عنوان ثابت fallback | عرض `title` ثم `data.title` ثم الترجمة | E2E |
| Messages (thread + send) | ✅ | ✅ PASS | تسمية حقل خاطئة (`common.info`) | `messages.subject` | E2E |
| Verify email (public) | ✅ رابط | ✅ PASS | مسار غير مسجّل في الـrouter | `VerifyEmailPage` + route + API | E2E |
| MERCHANT dashboard KPIs | ✅ | ✅ PASS | كان يعرض إحصاءات الإدارة | `myAnalyticsOverview` للبائع | E2E |
| Create product | ✅ نموذج | ✅ PASS | — | — | E2E |
| Edit product | ✅ | ✅ PASS | — | — | E2E |
| Publish/unpublish product | ✅ زر | ✅ PASS | لا واجهة لمعرّف الكيان | `mine/entities` + ربط | E2E |
| Inventory adjust | ✅ | ✅ PASS | — | — | E2E |
| Merchant orders | ✅ | ✅ PASS | — | — | E2E |
| Ads create/manage | ✅ | ✅ PASS | — | — | E2E |
| AI tools run | ✅ | ✅ PASS | — | — | E2E |
| Marketing Video (كامل) | ✅ | ✅ PASS | الأصل المحذوف يبقى في المكتبة | تصفية `DELETED` في الواجهة | E2E |
| Analytics | ✅ | ✅ PASS | — | — | E2E |
| Subscriptions | ✅ | ✅ PASS | — | — | E2E |
| ADMIN dashboard KPIs | ✅ | ✅ PASS | — | — | E2E |
| Admin users/orders/transactions | ✅ | ✅ PASS | — | — | E2E |
| Admin ledger/audit | ✅ | ✅ PASS | — | — | E2E |
| Admin products (+suspend) | ✅ | ✅ PASS | الصفحة غير موجودة | `AdminProductsPage` | E2E |
| Admin verification/trust/risk/disputes | ✅ | ✅ PASS | — | — | E2E |
| Admin ads/AI/subscriptions | ✅ | ✅ PASS | — | — | E2E |
| Sidebar nav (merchant+admin) | ✅ كل رابط | ✅ PASS | روابط ميتة محتملة | تدقيق تنقّل كامل | E2E |


---

## ✅ حالة معتمدة — C1: Distributed Rate-Limit Store (2026-09-20)

**الهدف**: إغلاق أول فجوة مفتوحة في `docs/PRODUCTION_GAP_LIST.md` (C1) — كان حدّ المعدل خريطةً في ذاكرة كل عملية، فبتشغيل أكثر من نسخة تتضاعف الحدود الفعلية.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 |
| **Full Test Suite** | ✅ **376/376 — 38 ملف** (364 سابقًا + 12 جديدة في `rate-limit.test.ts`) |
| **Production bundle** | ✅ `npm run build:prod` نظيف؛ E2E حقيقي عبر `dist-bundle/index.cjs` مع Postgres |
| **Migration** | `0016_breezy_lester.sql` — **إضافية فقط** (`rate_limit_counters` + فهرس)، لا drop ولا تغيير على أي جدول قائم |
| **الواجهة الأمامية** | لا تغيير |

### البنية
- `packages/server/src/lib/rate-limit/port.ts` — عقد `RateLimitStore` (`increment` / `reset` / `purgeExpired`).
- `memory.ts` — المخزن داخل العملية (تطوير/اختبارات/نسخة واحدة) بسلوك النافذة الثابتة السابق.
- `postgres.ts` — مخزن مشترك؛ `increment` عبارة upsert **واحدة ذرّية** تُنشئ الدلو أو تُصفّر النافذة المنتهية في نفس القيد (لا lost updates تحت التزامن).
- `resolve.ts` — `resolveRateLimitStore` حسب `RATE_LIMIT_STORE=memory|postgres` + `setRateLimitStore`/`rateLimitStoreStatus`.
- `middleware/rate-limit.ts` — يفوّض للمخزن؛ **الموضوع per-user** (`user:<id>`) للمصادَق و`ip:<ip>` للمجهول. `resetRateLimitStore()` صار async (واجهة الاختبارات فقط).

### الفروق
- جدول `rate_limit_counters` (مفتاح `bucket_key`, `count`, `expires_at`, `expires_at_ms`, timestamps) — لا PII، عدّادات فقط.
- purge: `scheduler` (`RATE_LIMIT_PURGE_INTERVAL_MINUTES`, افتراضي 15) + `POST /api/admin/rate-limits/purge` (`admin:system` + Audit `RATE_LIMIT.PURGE_RUN`).
- `GET /api/health/channels` يعرض `rateLimit: { store, durable }` بلا أسرار.
- env جديد: `RATE_LIMIT_STORE`، `RATE_LIMIT_PURGE_INTERVAL_MINUTES` في `env.ts` و`.env.example`.

### إثبات E2E حقيقي (bundle + Postgres)
- `RATE_LIMIT_STORE=postgres` → `/api/health/channels` = `rateLimit:{store:"postgres",durable:true}`.
- burst `forgot-password` (حدّ 5/300s): `200 200 200 200 200 429 429`، والصف في DB `auth-forgot:ip:203.0.113.240|7`.
- العدّاد **ثبت عبر إعادة تشغيل العملية** (قُرئ مباشرة من Postgres بعد الإيقاف) — هذا هو الفرق الجوهري عن المخزن السابق.
- `POST /api/admin/rate-limits/purge` بلا جلسة → 401 (محمي).
- تم حذف صف الاختبار ثم التأكد من عدم بقاء أي عملية/صفوف.

### الملفات
- جديدة: `src/db/schema/rate_limit.ts`, `src/lib/rate-limit/{port,memory,postgres,resolve}.ts`, `src/db/migrations/0016_breezy_lester.sql` (+snapshot), `tests/rate-limit.test.ts`.
- معدّلة: `middleware/rate-limit.ts`, `lib/rate-limit/resolve.ts`, `lib/scheduler.ts`, `lib/env.ts`, `index.ts`, `db/schema/index.ts`, `modules/health/routes.ts`, `modules/admin/engines-routes.ts`, `tests/security-privacy.test.ts`, `tests/sms.test.ts`, `.env.example`, docs.

### القرار المعماري
- **لا Redis**: Postgres كافٍ، وتفادى خدمة إضافية؛ العقد يسمح بإضافة Redis لاحقًا دون لمس الـrouter. سُجِّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-038).

---

## ✅ حالة معتمدة — PHASE 18: Unit Tests (2026-09-19)

**الهدف**: تنفيذ الجزء الأول المتبقي من PHASE 18 (طبقة Unit Tests) بدون لمس أي كود إنتاجي.

| البند | النتيجة |
| --- | --- |
| **Unit Tests جديدة** | ✅ **40 اختبارًا — 8 ملفات** تحت `packages/server/tests/unit/` |
| **المجموعة الكاملة** | ✅ **195/195 — 22 ملف** (155 تكامل + 40 وحدة) |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 — صفر أخطاء |
| **كود إنتاجي معدّل** | لا شيء — ملفات اختبار جديدة فقط |
| **Schema/Migrations** | لا تغيير |

### التغطية (pure functions معزولة، بلا DB وبلا mocks)
| الملف | الدوال |
| --- | --- |
| `unit/money.test.ts` | `toDecimal`, `fmt`, `isNegative`, `assertNonNegative`, `roundMoney` |
| `unit/commission.test.ts` | `commissionForAmount` + `commissionSplitForAmount` (النسب تُمرَّر — لا 3% ولا 4% Hardcoded) |
| `unit/slugify.test.ts` | `slugify` (ASCII + عربي + سقف 200 حرف) |
| `unit/revenue-scenario.test.ts` | `calculateScenario` (حساب المحاكاة + حرس الإيراد الصفري) |
| `unit/risk-actions.test.ts` | `recommendedActionFor` |
| `unit/trust-explain.test.ts` | `explainTrustScore` |
| `unit/security-token.test.ts` | `hashToken`, `parseBearerToken`, `signToken`, `verifyToken` (تلاعب + انتهاء) |
| `unit/mfa.test.ts` | `generateMfaSecret`, `generateMfaQrUri`, `generateTotp`, `verifyTotp`, `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode` |

### المتبقي لإغلاق PHASE 18
- **E2E حقيقي مع الواجهة (Playwright)** — الطبقة رقم 6 في `docs/TESTING_STRATEGY.md`، **لم تبدأ** بأمر صريح.
- تحديث `docs/TESTING_STRATEGY.md` ليعكس الطبقة المنفّذة (Unit) والعدد الفعلي.

---

## ✅ حالة معتمدة — Inventory Low-Stock Notifications (2026-09-19)

**الهدف**: إغلاق أول مهمة PENDING — إشعارات المخزون المنخفض. أقل تغيير معماري: استخدم نظام Notifications الموجود، بلا جدول جديد، بلا migration.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = exit 0 — صفر أخطاء |
| **Full Test Suite** | ✅ **155/155 — 14 ملف** (149 سابقًا + 6 جديدة) |
| **Inventory Suite** | ✅ 17/17 (`tests/inventory.test.ts` — 11 قديمة + 6 جديدة) |
| **Migration** | لا شيء — لا تغيير schema |

### السلوك الجديد (transition-based)
- الإشعار يُصدر فقط عند **انتقال هبوطي** بين الحالات: `IN_STOCK→LOW_STOCK`، `IN_STOCK→OUT_OF_STOCK`، `LOW_STOCK→OUT_OF_STOCK`.
- البقاء في نفس الحالة (أو العودة إلى `IN_STOCK`) **صامت**، لكن العودة تُعيد تسليح العنصر فيُصدر إشعار جديد عند هبوط لاحق.
- الإشعار يُسلَّم الآن إلى **المستخدم المالك** عبر `resolveSellerUserId(db, sellerId)` (عكس `resolveOwnedSellerIds`) — سابقًا كان `notifications.user_id` يُكتب بـ seller entity id فلا يصل الإشعار للمستخدم.
- `applyStockMovement` أصبح **ذرّيًا** (guarded SQL increment + RETURNING) فلا يمكن لحركات متزامنة أن تُنزل المخزون تحت الصفر.
- `setMyStock` يُصدر إشعارًا عند تجاوز الحد يدويًا بنفس قواعد الانتقال.

### الملفات
- `packages/server/src/lib/inventory-engine.ts` — محرك الانتقالات + الذرّية
- `packages/server/src/lib/seller-ownership.ts` — `resolveSellerUserId` جديدة
- `packages/server/src/modules/inventory/service.ts` — إشعار عند `setMyStock`
- `packages/server/tests/inventory.test.ts` — 6 اختبارات تكامل جديدة

### القرار التالي
- **PENDING السابق (مُنجَز الآن)**: Price Comparison Engine — نُفِّذ كوحدة كاملة (انظر القسم أدناه). توسيع E2E مستمر عبر المواصفات المضافة.

---

## ✅ حالة معتمدة — Geo + Subscription مكتملتان ومتحققتان (2026-09-17)

**الهدف**: إغلاق مرحلتي Geo وSubscription: ربط المسارات في `app.ts`، تشغيل الاختبارات فعليًا على PostgreSQL 17، إصلاح السبب الجذري لأي فشل، ثم commits منفصلة.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ PostgreSQL 17 مثبّت ومشغّل (`data_directory=/workspace/pgdata`، `wasit_dev` + `wasit_test`) |
| **Server Typecheck** | ✅ `npx tsc --noEmit` = **exit 0 — صفر أخطاء** |
| **Full Test Suite** | ✅ **149/149 ناجحة — 14 ملف اختبار** |
| **Subscription** | ✅ 10/10 (`tests/subscriptions.test.ts`) |
| **Geo API** | ✅ 16 مسار GET عام (countries/regions/cities/currencies/languages/exchange-rates) + zod query validation |

### إصلاحان جذريان (Subscription)
1. **Audit actorId**: الـ routes كانت تمرّر `AppContext` إلى `writeAudit` بينما `AuditContext` يتطلب `actorId` → `audit_logs.actor_id` كان يصبح NULL. أُصلح بالتمرير الصحيح `{ actorId: ctx.user!.id, ipAddress, userAgent }` — بنفس النمط المعتمد في auth/orders/verification/suppliers.
2. **RBAC test setup**: `createUserWithRole` كان يسجّل المستخدم دائمًا كـ CUSTOMER ثم **يضيف** الدور المطلوب، فيحمل SUPPORT + CUSTOMER معًا ويمرّ `userHasAnyRole` بصلاحية CUSTOMER → 200 بدل 403. أُصلح بحذف الدور الافتراضي قبل إدراج الدور المقصود (دور واحد فقط). **RBAC الإنتاجي لم يُلمس.**

### الـ Commits
- `c446741` — `feat(geo): expose geo reference REST API and wire routes`
- `cb4c963` — `fix(subscriptions): record audit actor and correct test role setup`

### تنظيف
- حُذف `packages/web/vite.public.tmp.config.ts` (مؤقت، لا مراجع له).
- `packages/web/vite.config.ts` (host بيئي) و`WASIT_BUSINESS_GLOBAL_UI_REFERENCE_PHASE17.png` (مرجع UI) باقيان خارج commit البرمجي.

### القرار التالي
- إغلاق هذه المرحلة؛ لا Module جديد حتى أمر منفصل.

---

## ✅ حالة معتمدة — TypeScript Clean (2026-09-13)

**الهدف**: إغلاق أخطاء TypeScript في ثلاثة ملفات كانت تمنع جهة الخادم من `tsc --noEmit` النظيف: `tests/subscriptions.test.ts`، `tests/revenue.test.ts`، `src/modules/geo/service.ts` — بلا تغيير في منطق الإنتاج (Production behavior unchanged)، بلا `any`، بلا `sql.raw`.

| البند | النتيجة |
| --- | --- |
| **Server Typecheck** | ✅ `npx tsc --noEmit` (في `packages/server`) = **exit 0 — صفر أخطاء** |
| **Subscriptions test** | ✅ أُصلحت 5 أخطاء TS2339 في `tests/subscriptions.test.ts` — توسعة أنواع `items`/`plans` لإضافة `isActive`/`planTarget`، وتعويض `auditLogs.userId` → `auditLogs.actorId` (عمود الـ audit الفعلي) |
| **Revenue test** | ✅ أُصلحت 3 أخطاء TS2345 في `tests/revenue.test.ts` — استدعاءات `calculateScenario` الثلاثة أكملت كل حقول `ScenarioInput` المطلوبة بقيم محايدة (`0`/`TND`) فلا تتغير النتائج المتوقعة |
| **Geo service** | ✅ أُصلحت 3 أخطاء TS2345 في `src/modules/geo/service.ts` — `conditions` أصبح `(SQL | undefined)[]` (نوع صريح) في `listCountries`/`listCurrencies`/`listLanguages` + استيراد type `SQL` — لا تغيير في منطق الاستعلامات |
| **لا `any`** | ✅ لا يوجد أي استخدام لـ `any` في التعديلات الثلاثة |
| **Scope discipline** | ✅ لم تُلمس `src/modules/revenue/*` Production logic، ولا `src/modules/subscriptions/*`، ولا Analytics، ولا أي Module جديد |

### الملفات
- `packages/server/tests/subscriptions.test.ts` (إصلاح سابق — خارج commit المرحلة الحالية، يعمل قائم في working tree)
- `packages/server/tests/revenue.test.ts`
- `packages/server/src/modules/geo/service.ts` (خطأ سابق: `geo/routes.ts` هو ملف سابق غير متتبع — لم يُلتزم في هذا الـ commit)
- `CHECKPOINT.md` / `AGENTS.md` (تحديث التوثيق)

### أخطاء TypeScript المتبقية
- **Geo**: 0 (كانت 3)
- **Revenue**: 0 (كانت 3)
- **Subscriptions (test)**: 0 (كانت 5)
- **الإجمالي**: 0/0

---

## ✅ حالة معتمدة — Subscriptions / Phase 14 (2026-09-13)

**الهدف**: إغلاق وحدة الاشتراكات: Plans + Subscription lifecycle + Invoices + Rollover + RBAC + Admin — بلا Wallet، بلا تغيير النموذج التجاري، الأسعار من DB (لا Hardcode).



| البند | النتيجة |
| --- | --- |
| **Implementation** | ✅ `src/modules/subscriptions/{types,service,routes}.ts` — plans/subscribe/me/change-plan/cancel/invoices/rollover/admin — audit على كل عملية |
| **RBAC** | ✅ `SUBSCRIPTION_READ_OWN` + `SUBSCRIPTION_CREATE` + `SUBSCRIPTION_UPDATE` + `SUBSCRIPTION_CANCEL` للأدوار التجارية الأربعة (CUSTOMER/MERCHANT/SUPPLIER/COMPANY)؛ `SUBSCRIPTION_MANAGE` للإدارة فقط — صحيح في `shared/rbac.ts` |
| **Permissions** | ✅ `SUBSCRIPTION_CREATE/UPDATE/CANCEL` أُضيفت إلى `shared/permissions.ts` + منحت في RBAC |
| **Integration** | ⚠️ `app.ts` فيه تسجيل `subscriptionRoutes` + `geoRoutes` معًا — لم يُلتزم ليفصل عن Geo (يبقى متاحًا في working tree) |
| **TypeScript / Builds** | ✅ Server typecheck للـ module نظيف؛ Web build ناجح؛ Server build فيه أخطاء `geo/service.ts` القديمة فقط (خارج النطاق) |
| **DB Tests** | ⛔ **لم تُنفذ** — الاختبارات مكتوبة (`tests/subscriptions.test.ts` — 282 سطرًا: plans/lifecycle/RBAC/admin/rollover) لكنها تتطلب PostgreSQL وغير متوفر في هذه البيئة؛ **لا تُسجَّل ناجحة** |
| **لا Wallet** | ✅ لا يوجد رصيد مستخدمين — طلب/تفعيل/ترقية/إلغاء/فوترة فقط |

---

## 1. النطاق المثبَّت في هذا الـ Checkpoint

| المجال | الحالة |
| --- | --- |
| **Subscription Plans** | ✅ `subscription_plans` مزروع: `CUSTOMER_FREE` (مجاني)، `SMALL_MERCHANT` (19)، `COMPANY` (99)، `GLOBAL` (299) — أسعار من DB |
| **Subscription Lifecycle** | ✅ subscribe (idempotent)، read `/me`،change plan (delta invoice عند الترقية)، cancel، invoices، rollover (auto-renew + فاتورة جديدة) |
| **Rollover Service** | ✅ `rolloverDueSubscriptions` — يُجدّد بسبب subscriptions ذات `autoRenew=true` و`status='ACTIVE'` و`endsAt < now()`؛ `startsAt` يرث `endsAt` السابق (مع fallback آمن `?? new Date()`)؛ فاتورة جديدة `INV-` |
| **RBAC** | ✅ 5 صلاحيات Subscription موصولة بدقة في routes (CREATE/UPDATE/CANCEL/READ_OWN/MANAGE) — الأدوار غير التجارية لا تملك CREATE/UPDATE/CANCEL |
| **Admin** | ✅ `SUBSCRIPTION_MANAGE` (ADMIN/SUPER_ADMIN): plan activate/deactivate، list plans/subscriptions/invoices |
| **Audit** | ✅ `SUBSCRIPTION.SUBSCRIBED` / `SUBSCRIPTION.CHANGED_PLAN` / `SUBSCRIPTION.CANCELLED` / `SUBSCRIPTION.INVOICE_ISSUED` — كل عملية تُسجَّل |
| **Tests (مكتوبة)** | ✅ `tests/subscriptions.test.ts` — 282 سطرًا — plans/lifecycle/RBAC/admin/rollover — **مكتوبة ولم تُشغَّل** (تتطلب PostgreSQL) |
| **TypeScript** | ✅ module معزول: نظيف — صفر أخطاء؛ Web build ناجح؛ Server build: أخطاء `geo/service.ts` القديمة فقط |
| **Git** | ✅ Commit انتقائي `feat: complete subscription module` — module+tests+permissions+rbac+docs؛ `app.ts` خارج الـ commit (اختلاط مع Geo) ويبقى working-tree |

---

## 2. الملفات

- `packages/server/src/modules/subscriptions/types.ts` (50 سطرًا)
- `packages/server/src/modules/subscriptions/service.ts` (362 سطرًا)
- `packages/server/src/modules/subscriptions/routes.ts` (172 سطرًا)
- `packages/server/tests/subscriptions.test.ts` (282 سطرًا)
- `packages/shared/src/constants/permissions.ts` (+`SUBSCRIPTION_CREATE/UPDATE/CANCEL`)
- `packages/shared/src/constants/rbac.ts` (+منح 4 للأدوار التجارية)
- `packages/server/src/app.ts` (⚠️ working-tree فقط — لم يُلتزم)

---

## 3. القرار / ملاحظات معلّقة

- **`app.ts`** يحمل تسجيل `geoRoutes` + `subscriptionRoutes` مختلطين في ملف واحد؛ لم يُلتزم في هذا الـ commit ليبقى الـ commit خاصًا بـ Subscription — سيلتزم في commit لاحق مع Geo أو منفصلًا بقرار.
- أي `DECISION REQUIRED` جديد يُسجَّل في `docs/ARCHITECTURE_DECISIONS.md`.

---

## 4. التالي

1. تشغيل PostgreSQL في البيئة ثم `npm test` — كاملاً (بما فيه `tests/subscriptions.test.ts`).
2. الالتزام اللاحق: `app.ts` (مع Geoأو منفصل) + أي إصلاحات ينتجها تشغيل الاختبارات.
3. تحديث هذا الـ Checkpoint بنتائج الاختبارات الفعلية عند توفر PostgreSQL.
4. **توقف** — لا نبدأ Phase جديدة حتى أمر منفصل.

---

## ✅ حالة معتمدة رسمياً — Revenue & Profitability (2026-09-17) — 139/139

**الهدف**: إغلاق وحدة Revenue & Profitability (migration 0007 + schema + module + RBAC + اختبارات) مع تسجيلها في التطبيق الرئيسي `createApp()` — بلا Wallet، بلا تغيير النموذج التجاري.



| البند | النتيجة |
| --- | --- |
| **Full Test Suite** | ✅ **13 Test Files · 139/139 Tests Passed · Exit 0** (138 سابقة + اختبار تكامل واحد جديد) |
| **Revenue Tests** | ✅ **16/16** (`tests/revenue.test.ts` — 15 سابقة + 1 تكامل عبر createApp الحقيقي) |
| **التسجيل في app.ts** | ✅ `import { revenueRoutes }` + `app.route('/api/revenue', revenueRoutes)` (بين analytics وprivacy) |
| **Migrations** | ✅ `0007_rainy_killraven` (revenue_accounts + scenario_reports + 3 enums) — `_journal.json` idx 7، snapshot `7080cac1…` (خلف ff43efb8…) |
| **Schema** | ✅ `src/db/schema/revenue.ts` (82 سطرًا) — مصدَّر عبر `schema/index.ts` → `export * from './revenue'` |
| **RBAC** | ✅ `REVENUE_READ`/`REVENUE_MANAGE`/`REVENUE_SIMULATE` — ممنوحة لـ SUPER_ADMIN فقط (كامل Object.values(P)) |
| **لا Wallet** | ✅ لا يُحفظ رصيد المستخدمين — الجداول P&L التشغيلية + scenario snapshots فقط |



### Revenue Module (الملفات)
- `packages/server/src/modules/revenue/routes.ts` (3 endpoints: `GET /report`,`POST /scenario`,`GET /scenarios)`) — requireAuth + requirePermission + validateBody + audit + owner-scope.

- `packages/server/src/modules/revenue/service.ts` (getRevenueProfitability + calculateScenario + listScenarioReports) — تجميعات من tables حقيقية (`transaction_ledger` CREDIT−DEBIT، `invoices` PAID فقط، `ai_usage` per-currency، `revenue_accounts`) بلا كتابة على البيانات الحية.

- `packages/server/src/modules/revenue/types.ts` + `src/db/schema/revenue.ts` + migration `0007_rainy_killraven`.
- `tests/revenue.test.ts` — **16/16**: pure calculation (3)، routes validation+RBAC (4)، aggregations من tables حقيقية(5)، scenario reports owner-isolation(2)، no-wallet(1)، **integration عبر createApp الحقيقي(1)**.





---



## ✅ حالة معتمدة رسمياً — Phase 17 (Security + Privacy + Audit) — 123/123 (2026-09-15)

**الهدف**: إغلاق متطلبات الأمن/الخصوصية/التدقيق (MFA، Privacy، Audit، Rate-Limit-ordering) مع الالتزام بكل قيود المستخدم (لا rate-limit في الإنتاج، لا تغيير deletion logic، لا bypass عبر DB inserts في اختبارات الخصوصية، عزل rate-limit store عبر test-only mechanism).

| البند | النتيجة |
| --- | --- |
| **Full Test Suite** | ✅ **12 Test Files · 123/123 Tests Passed · Exit 0** (106 سابقة + 17 جديدة لـ Phase 17) |
| **Server TypeScript** | ✅ `tsc --noEmit` exit 0 |
| **Server Build** | ✅ `tsc -p tsconfig.build.json` exit 0 |
| **Web TypeScript** | ✅ `tsc --noEmit` exit 0 |
| **Web Build** | ✅ `vite build` exit 0 (74 modules) |
| **Migrations** | ✅ `0005_privacy_module` + `0006_mfa_recovery_codes` (json) في `meta/_journal.json` — قابلة لإعادة التشغيل (idempotent) |
| **Dev DB** | ✅ داخِل `wasit_dev`: جداول `consent_events`/`data_export_requests`/`data_deletion_requests` موجودة، `enum deletion_stage` موجود، عمود `authenticator_apps.recovery_codes_hash` موجود |

### MFA (RFC 6238 TOTP) — hardened
- **Recovery Codes مخزّنة salted** بصيغة `salt:hash` (salt عشوائي 16 بايت بهرمٌ لكل وسم) — عبر `node:crypto` فقط (لا dependencies جديدة).
- **التحقق** يستخدم `crypto.timingSafeEqual` (constant-time) بعد تساوي الطول.
- **Single-use**: الكود المستعمَل يُحذف من المجموعة المخزنة؛ إعادة استخدامه تفشل (مُثبت باختبار API حقيقي).
- **Backward compatibility**: الهاش القديم غير المملّح (SHA-256 الخام) ما زال يتحقق ويعيد `legacy:true`، ويُرقّى تلقائياً إلى salted عند أول استخدام.
- **لا تسريب**: `enroll` يكشف `secretBase32`+`recoveryCodes` (مرة واحدة للعرض الوجيز كما صُمم)، لكنه **لا** يعيد `recoveryCodesHashed` أو الـ hash؛ `status`/`verify` لا يعيدان secret أو hashes (مُثبت باختبار HTTP Leakage).
- **Rate limiting**: كل MFA endpoints محمية بـ `rateLimit` (enroll 5/60s، confirm 10/60s، disable 10/60s، recovery 5/60s، verify 20/60s، dev-totp 30/60s).
- **`dev-totp`** معطّل في الإنتاج (`NODE_ENV=production` → 403).
- **Audit**: كل MFA transition (`ENROLL/CONFIRM/DISABLE/RECOVERY_REGEN/VERIFY_OK/VERIFY_FAILED`) يكتب في `audit_logs`.

### Privacy Engine
- `GET /api/privacy/me|consents` + `PUT /api/privacy/consents` (grant/revoke + history).
- `POST /api/privacy/export` → `buildUserExport` (بيانات مملوكة للمستخدم فقط، بلا secrets) + سطر `data_export_requests`.
- `POST /api/privacy/deletion` → deactivate فوري + مراحل `REQUESTED → DEACTIVATED → RETENTION/REVIEW → ELIGIBLE → ANONYMIZED/DELETED/REJECTED`.
- Admin: `GET /api/admin/privacy/deletions?stage=` + `PATCH .../:id` (ADMIN/SUPER_ADMIN).
- **ترتيب Middleware على الحساسة**: `rateLimit → requireAuth → validateBody → handler` (rate limit يعمل أيضاً على الـ unauthenticated).
- Privacy routes **لا** تستخدم blanket `use('*', requireAuth)` — auth صريح لكل مسار.

### Rate-limit (test-only mechanism)
- `resetRateLimitStore()` مصدَّر من `middleware/rate-limit.ts` **للاختبار فقط** — إنتاجية `rateLimit()` لم تتغير.
- اختبار burst: 5 POST deletion متتالي من IP ثابت `198.51.100.x` → `[200, 401, 429, 429, 429]` (rate limit قبل auth).

### اختبارات PHASE 17 (17 اختبار — `tests/security-privacy.test.ts`)
1. Security headers على كل استجابة.
2. TOTP deterministic unit.
3. Recovery codes salted + unique salt + round-trip.
4. Legacy unsalted digests verification (backward compat).
5. enroll → confirm → status enabled.
6. verify endpoint يعتمد TOTP صحيح ويرفض غير صحيح.
7. recovery codes عبر verify endpoint.
8. **HTTP responses لا تسرّب secret/hashes/raw**.
9. **Recovery codes single-use** (ثاني استخدام يفشل).
10. disable يتطلب TOTP صحيحاً ويُطفئ mfaEnabled.
11. consent grant + revocation history.
12. user export ownership-bound بلا secrets.
13. export request row + audit trail.
14. deletion request → deactivates (stage DEACTIVATED).
15. admin advance → ELIGIBLE + audit.
16. rate-limit burst (rate limit قبل auth).
17. admin deletion listing + stage filter.

**ملاحظات إغلاق**:
- لا تغيير في `isActive` semantics — عطّل الحساب فقط في deletion request.
- لا حاجة إلى migration جديدة للـ salted recovery (آلية التخزين في column موجود).
- `packages/server/.env` مستثنى من git (`.gitignore`) — لا secrets في الريبو.

---

## ✅ حالة معتمدة رسمياً — Backend Verified 106/106 (2026-09-15)

**الغرض**: تثبيت نقطة تحقق رسمية بعد توفير PostgreSQL 17 وتشغيل الاختبارات بالكامل على قاعدة البيانات الأصلية.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ شُغّل بنجاح: **PostgreSQL 17.11 (Debian 17.11-0+deb13u1)** على `localhost:5432` |
| **قاعدة البيانات** | ✅ شُغّلت قاعدة البيانات الأصلية `/workspace/pgdata` (بدون initdb، بدون migrations يدوية) |
| **الاتصال** | ✅ `pg_isready` = `accepting connections` · `SELECT 1` = `1` |
| **قواعد البيانات الموجودة** | `postgres`, `wasit_dev`, `wasit_test` |
| **`npm run typecheck` (server)** | ✅ نجح — `tsc --noEmit` بلا أخطاء (exit 0) |
| **`npm test` (server)** | ✅ نجح — **11/11 Test Files · 106/106 Tests Passed · 0 Failed · Exit Code 0** |
| **مدة الاختبارات** | 12.70s (transform 718ms, setup 0ms, collect 8.23s, tests 18.41s, env 2ms, prepare 788ms) |

**ملفات الاختبار الـ 11**: `vertical-slice`, `inventory`, `verification-trust`, `messaging`, `payment-fee-policy`, `ads`, `admin-access`, `ai-core`, `analytics`, `phase14-agents`, `phase15-ads-ai`.

**الطريقة**:
- التثبيت: `postgresql-17` + `postgresql-client-17` (رسمية من مستودعات Debian trixie) — الإصدار المطابق للنسخة المحفوظة.
- التشغيل: `sudo -u postgres pg_ctl -D /workspace/pgdata -o "-c config_file=/etc/postgresql/17/main/postgresql.conf -c data_directory=/workspace/pgdata" start` (استرداد تلقائي آمن لإغلاق سابق غير نظيف).
- الأذونات: `sudo chmod 0750 /workspace/pgdata` (كانت `drwxrws---` → أصبحت `drwxr-s---` = 2750، قبلها PostgreSQL بعد التعديل).
- نسخة إنقاذ إضافية (لا تُرفع): `/workspace/pgdata-rescue-COPY-20260915T134904Z`.
- الاختبارات: `cd packages/server && npm test` — تُعيد بناء `wasit_test` تلقائياً (migrations + seed) ثم تشغّل 106 اختباراً عبر API حقيقي.

**ملاحظة تشغيلية مهمة**: عند كل إعادة إنشاء Runtime/Container ستحتاج إلى إعادة تثبيت `postgresql-17` (لا يتضمّنه الجذر) ثم تشغيل القاعدة على `/workspace/pgdata` بالطريقة أعلاه — انظر `AGENTS.md`.

---

## ✅ حالة معتمدة رسمياً — Backend Verified 106/106 (2026-09-15)

**الغرض**: تثبيت نقطة تحقق رسمية بعد توفير PostgreSQL 17 وتشغيل الاختبارات بالكامل على قاعدة البيانات الأصلية.

| البند | النتيجة |
| --- | --- |
| **PostgreSQL** | ✅ شُغّل بنجاح: **PostgreSQL 17.11 (Debian 17.11-0+deb13u1)** على `localhost:5432` |
| **قاعدة البيانات** | ✅ شُغّلت قاعدة البيانات الأصلية `/workspace/pgdata` (بدون initdb، بدون migrations يدوية) |
| **الاتصال** | ✅ `pg_isready` = `accepting connections` · `SELECT 1` = `1` |
| **قواعد البيانات الموجودة** | `postgres`, `wasit_dev`, `wasit_test` |
| **`npm run typecheck` (server)** | ✅ نجح — `tsc --noEmit` بلا أخطاء (exit 0) |
| **`npm test` (server)** | ✅ نجح — **11/11 Test Files · 106/106 Tests Passed · 0 Failed · Exit Code 0** |
| **مدة الاختبارات** | 12.70s (transform 718ms, setup 0ms, collect 8.23s, tests 18.41s, env 2ms, prepare 788ms) |

**ملفات الاختبار الـ 11**: `vertical-slice`, `inventory`, `verification-trust`, `messaging`, `payment-fee-policy`, `ads`, `admin-access`, `ai-core`, `analytics`, `phase14-agents`, `phase15-ads-ai`.

**الطريقة**: 
- التثبيت: `postgresql-17` + `postgresql-client-17` (رسمية من مستودعات Debian trixie) — الإصدار المطابق للنسخة المحفوظة.
- التشغيل: `sudo -u postgres pg_ctl -D /workspace/pgdata -o "-c config_file=/etc/postgresql/17/main/postgresql.conf -c data_directory=/workspace/pgdata" start` (استرداد تلقائي آمن لإغلاق سابق غير نظيف).
- الأذونات: `sudo chmod 0750 /workspace/pgdata` (كانت `drwxrws---` → أصبحت `drwxr-s---` = 2750، قبلها PostgreSQL بعد التعديل).
- نسخة إنقاذ إضافية (لا تُرفع): `/workspace/pgdata-rescue-COPY-20260915T134904Z`.
- الاختبارات: `cd packages/server && npm test` — تُعيد بناء `wasit_test` تلقائياً (migrations + seed) ثم تشغّل 106 اختباراً عبر API حقيقي.

**ملاحظة تشغيلية مهمة**: عند كل إعادة إنشاء Runtime/Container ستحتاج إلى إعادة تثبيت `postgresql-17` (لا يتضمّنه الجذر) ثم تشغيل القاعدة على `/workspace/pgdata` بالطريقة أعلاه — انظر `AGENTS.md`.

---

## ✅ تعديل جديد — Homepage Redesign (2026-09-15) — مُلتزم `15feaf3`

**الهدف**: إعادة تصميم الصفحة الرئيسية فقط وفق الهوية الجديدة **LE WASSIT**.

| البند | النتيجة |
| --- | --- |
| **الاسم الفرنسي الرسمي في الواجهة** | `LE WASSIT` + `BUSINESS GLOBAL` (أسفل الشعار) في ar/fr/en/zh (مفاتيح `brand.name`/`brand.sub`) |
| **حرف W كبير كعنصر هوية** | مكوّن `WMonogram` (SVG بتدرج أزرق-رمادي) مستخدم في: الهيدر، ووترمارك كبير في Hero، قسم À propos |
| **الألوان** | Blue-Gray كامل (`wasit-50..900`) في `tailwind.config.js` — حلّ محل teal؛ أبيض/رمادي فاتح للخلفيات؛ indigo كـ accent |
| **البنية** | Hero (split: نص + رسم SVG لشبكة عالمية `GlobalNetwork`)، شريط بحث (وظيفة حقيقية)، trust bar وصفي (بلا أرقام وهمية)، Solutions، Markets (رابط صفحات حقيقية)، Categories/Latest Products/Trusted Suppliers (بيانات حقيقية من DB)، À propos، Ressources، CTA + Contact |
| **PublicLayout** | هيدر/فوتر جديدان (nav فرنسي: Accueil/À propos/Solutions/Marchés/Ressources/Contact + قائمة موبايل ☰)؛ الفوتر يحافظ على كل الوظائف (suppliers/merchants/companies/categories) |
| **إزالة الـ stats الوهمي** | أُزيلت بطاقات الأرقام "—" التي كانت تقرأ `adminStats` (401 للزوار) — لا أرقام وهمية |
| **Teal leaks** | ProductCard/Spinner/Badge تحوّلت إلى `wasit` blue-gray |
| **index.html** | العنوان `LE WASSIT — Business Global` + meta description |
| **التحقق** | Web Typecheck ✅ · Web Build ✅ · FR ✅ · AR RTL ✅ · EN ✅ · ZH keys ✅ (45/45 في كل لغة) · Home Search E2E ✅ ("olive" → 6 منتجات/1 مورد/1 فئة) · Backend `ready+connected` ✅ |

**ملاحظة**: HomePage أصبحت ملفوفة بـ `PublicLayout` (كانت سابقاً بلا هيدر/فوتر). لا تغييرات Backend/DB في هذا التعديل.

---

# CHECKPOINT — WASIT BUSINESS GLOBAL

> **التاريخ**: 2026-09-14 (21:57 UTC) — **MASTER CHECKPOINT**
> **الفرع**: `feat/messaging-notifications`
> **مرجع الـ commit**: `checkpoint-master-2026-09-14` (tag) — `chore: create master project checkpoint`؛ أساسه `f520d2e9…` (Phase 14)
>
> **الغرض**: تثبيت الحالة الرسمية بعد إكمال **Phase 13 (AI Core + AI Agents + AI Dashboard Integration)** ثم **Phase 14 (Specialized AI Agents — executors متخصصة)** ثم تقدّم **Phase 15 (Advertising + AI Ads)**.

---

## 1. النطاق المثبَّت في هذا الـ Checkpoint

| المجال | الحالة |
| --- | --- |
| **حماية PostgreSQL (Persistence)** | ✅ PGDATA على Persistent Volume `/workspace/pgdata` (لا يضيع عند إعادة إنشاء Runtime/Container) |
| **Backup / Restore** | ✅ `scripts/backup-db.sh` + `scripts/restore-db.sh` + نسخ احتياطية في `backups/` |
| **AI Provider Abstraction** | ✅ `src/lib/ai/provider.ts` — `local-heuristic` (افتراضي) / `noop` / OpenAI-compatible / Anthropic — اختيار المزود من env فقط، نحن لا نجعل مزوداً Hardcoded |
| **Model Routing** | ✅ `src/lib/ai/routing.ts` — capability→model policy (قابل للتعديل من DB) + RBAC-aware (غير الإداريين ينزلون للـ default model) + fallback لـ local-heuristic |
| **AI Runtime** | ✅ `src/lib/ai/runtime.ts` — resolve→budget→call→cost→record→usage (end-to-end) |
| **Cost Control + Usage** | ✅ `src/lib/ai/cost-control.ts` — budgets per user, limits, token/cost usage + `ai_budgets/ai_usage` في DB |
| **Endpoints / Consumption** | ✅ `src/lib/ai/endpoints.ts` — `runMarketAnalysis`, `runRecommendations`, `runSupplierRecommendations`, `runPriceIntelligence` — حقيقية (DB-backed) |
| **Self Endpoints** | ✅ `src/lib/ai/self-endpoints.ts` — `runSmartSearch`, `runSalesIntelligence`, `myActivity` |
| **Product Agent** | ✅ `src/modules/ai/service.ts` — `analyzeProduct` (تحليل listing حقيقي) |
| **Specialized Agents (Phase 13 catalog)** | ✅ `src/modules/ai/agents.ts` — كتالوج 11 وكيلاً (`agent_registry` auto-seed) + تنفيذ tasks (gated بموافقة بشرية لـ 6) + audit + notifications |
| **Phase 14 — Specialized Executors** | ✅ **جديد** `src/modules/ai/executors.ts` — منفّذ DB-backed خاص لكل وكيل من الـ11 (بدلاً من executor عام واحد)؛ الـ `createAgentTask`/`decideAgentTask` يوجهان إليه |
| **AI Routes API** | ✅ `src/modules/ai/routes.ts` — 20+ endpoint محمية بـ `AI_USE` / `AI_MANAGE` / `ADMIN_AI` + validation + audit |
| **RBAC** | ✅ `AI_USE` ممنوح لـ CUSTOMER + `AI_MANAGE`/`ADMIN_AI` للإدارة فقط؛ الـ executors تُفرض capabilities لكل وكيل |
| **Public health** | ✅ `/api/health/ai` عام (لا يحمل بيانات حساسة) |
| **Web — API layer** | ✅ `packages/web/src/lib/api.ts` — دوال AI كاملة (status, models, budget, activity, run, smart features, agents, create task, my tasks) |
| **Web — DashboardAI (مرتبط)** | ✅ `DashboardAIPage` في `DashboardBusinessPages.tsx` — inputs حقيقية لكل وكيل + عرض structured results + marketingVideos (معاينة/تنزيل) |
| **i18n** | ✅ مفاتيح AI كاملة في ar/en/fr/zh + مفاتيح الفيديو (`ai.videos.*`) |
| **الفحوص** | ✅ Server Typecheck / **94/94 Tests** (منها Phase 14 20/20، Phase 15 5/5) / Web Typecheck / Web Build كلها PASS |

## 2. قاعدة البيانات

| القاعدة | migrations | جداول | seed | ملاحظات |
| --- | --- | --- | --- | --- |
| `wasit_dev` | 0000→0004 | **74** | (present؟ لا — schema مؤكد؛ seed Data غير ممتلئة حالياً ولا نعمل عليه الآن) | `ai_models` = 3 نماذج active؛ `agent_registry` = 11 (auto-seed) |
| `wasit_test` | 0000→0004 | **74** | — (يعيد بناءه vitest عند كل تشغيل) | اتصال وتطبيق migrations سليم |

**أدوار/وصول**: `wasit` (SUPERUSER+CREATEDB)؛ `DATABASE_URL` في `packages/server/.env` — **لا تُرفع أبداً**.

## 3. أدوات الاستعادة

- إعادة تشغيل PG بعد إعادة إنشاء الحاوية:
  ```bash
  sudo pg_ctlcluster 17 main start
  # إن لزم إعادة تعيين data_directory:
  sudo sed -i "s|data_directory = '.*'|data_directory = '/workspace/pgdata'|" /etc/postgresql/17/main/postgresql.conf
  ```
- نسخة كاملة: `./scripts/backup-db.sh`
- استعادة: `./scripts/restore-db.sh ./backups/<stamp>/ [--with-test]`

## 4. الحالة الوظيفية للمنصة

- ✅ Phases 0–12 مكتملة: Auth+RBAC، Categories/Products، Search، Orders+Commission 4% مُقسَّمة 2%+2% (Policy Engine)+Ledger، Inventory، Messaging/Notifications، Verification+Trust، Risk، Disputes، Advertising.
- ✅ **Phase 13 (AI Core + AI Agents + AI Dashboard Integration) مكتملة**: provider/routing/runtime/cost-control + consumption (market analysis, recommendations, smart search, supplier recs, price/sales intelligence, product analysis) + 11 agents + RBAC + واجهة Dashboard حقيقية.
- ✅ **Phase 14 (Specialized AI Agents — executors متخصصة)**: `src/modules/ai/executors.ts` يستبدل الـ `executeLocalAdvice` العام بمنفّذ DB-backed خاص لكل وكيل من الـ11:
  - `sales-agent` → KPI مبيعات/period + leads + recent orders
  - `marketing-agent` → نشر products + top categories/brands + **marketingVideos** (عقد معاينة/تنزيل) + campaign suggestion
  - `ads-agent` → campaigns/ad events (impressions/clicks/conversions/CTR) + recommendation
  - `product-agent` → تحليل منتج حقيقي (variants/images/inventory/completeness) عبر productId
  - `support-agent` → threads/unread messages + recommendation للرد
  - `analytics-agent` → snapshot كامل (users/products/orders/gmv/avg basket/topProducts/dailyKpis)
  - `market-research-agent` → avg price + categories + total order value
  - `b2b-agent` → matching suppliers↔merchants/companies (مع إشارة verified)
  - `risk-agent` → risk profiles/events + severe posture
  - `dispute-assistant` → open disputes + recent dispute messages + recommendation
  - `development-agent` → snapshot نمو (users/products/orders/campaigns/daily KPIs) + nextSteps
- ✅ **94/94 اختباراً ناجحاً** (10 files؛ منها Phase 14 20/20، AI Core 13/13، Phase 15 5/5).
- ✅ **E2E (curl)**: `/api/health/ai` عام يعمل؛ تسجيل/دخول CUSTOMER → agents (11)؛ marketing تعيد marketingVideos ببيانات حقيقية بعد إدراج منتجات؛ product-agent يعيد completeness لمنتج حقيقي؛ ads-agent يُرفض بـ 403 لغير المخوّل (RBAC)؛ sales-agent gated → ADMIN يوافق عبر HTTP → `approved` + result.

## 5. ملاحظات / قرارات معلّقة

- `wasit_dev` تحتوي الـ schema (74) وليس بيانات seed كاملة حالياً — عند الحاجة للتطوير الـlive نعيد تشغيل `db:seed` + `db:seed:demo` بعد إذن منفصل (لا نلمسه الآن).
- **Phase 14 — Video Generation Pipeline**: `marketingVideos` في وقتنا الحالي يمثل **عقداً** (contract) — كل فيديو يعيد `previewable: true` / `downloadable: true` / `mimeType: 'video/mp4'` مع `mediaUrl: null`. عند إدراج Media Generation/Storage فعلي لاحقاً يُملأ `mediaUrl` (بالضبط كأصل قابل للمعاينة والتنزيل داخل المنصة). لا ندّعي أن توليد الفيديو الفعلي اكتمل.
- Phase 14 تدفع `runAIFeature` لكل task لأغراض **usage/cost/audit**، بينما النتيجة structured DB-backed تعتمد على `local-heuristic` (إلا عند تفعيل مزود خارجي في env).
- الـ provider الافتراضي في البيئة هو `local-heuristic` (تحليلي حقيقي بلا LLM إلا عند ضبط `AI_PROVIDER`+`AI_API_KEY`). لا يوجد Fake: بدون مفتاح يعمل deterministic engine، ومع مفتاح يعمل LLM فعلي.
- أي `DECISION REQUIRED` جديد يُسجَّل في `docs/ARCHITECTURE_DECISIONS.md`.

## 6. التالي

1. **MASTER CHECKPOINT 2026-09-14**: تحديث CHECKPOINT.md + AGENTS.md (Phase 15 موثّقة).
2. Commit مرجعي: `chore: create master project checkpoint` (يشمل التغييرات غير الملتزمة لـ Phase 15 — لا حذف).
3. إنشاء `WASIT_BUSINESS_GLOBAL_MASTER_CHECKPOINT_2026-09-14.zip` (بدون `.env`/secrets؛ يتضمن `.env.example`).
4. إنشاء `WASIT_BUSINESS_GLOBAL_ADVANCED_STATUS_REPORT_2026-09-14.md`.

---

## ✅ PRICE COMPARISON ENGINE — وحدة كاملة ومتحقَّقة (2026-09-22)

**الهدف**: سدّ أول فجوة وظيفية موثّقة (B10 في `docs/PRODUCTION_GAP_LIST.md`) — «مقارنة أسعار/موردين» على `/price-comparison?query=` (مذكورة في `UI_SCREEN_MAP.md`). الصفحة السابقة كانت **قائمة منتجات مسطّحة** مرتّبة بالسعر (`DashboardComparisonPage`)، أي لا مقارنة فعلية.

### ما تغيّر (لا migration، لا جدول جديد)
- **Backend وحدة جديدة** `packages/server/src/modules/comparison/{service,routes}.ts` مربوطة في `app.ts` على `GET /api/price-comparison` (عام) و`GET /api/price-comparison/categories`.
  - تجميع **نفس المنتج** حسب `barcode` وإن غاب فالاسم المُطبَّع (lower/trim/collapse whitespace) — `sku` فردي ولا يصلح للتجميع عبر بائعين.
  - **عزل العملة إلزامي**: العملة جزء من مفتاح المجموعة — لا تُدمج أسعار بعملات مختلفة ولا يُدّعى أنها قابلة للمقارنة.
  - كل مجموعة: `sellerCount`/`offerCount`/`lowestPrice`/`highestPrice`/`priceSpread`؛ كل عرض: `isLowestPrice` + `priceDeltaFromLowest`، مرتبة تصاعديًا.
  - بيانات البائع من جداول `suppliers`/`merchants`/`companies` بـjoin محمي بالنوع (`and seller_type=`)، مع `verified`/`countryId`/`logoUrl`.
  - **`availability` نطاق تقريبي فقط** (IN_STOCK/LOW_STOCK/OUT_OF_STOCK/UNKNOWN) من المخزون مقابل عتبة الانخفاض — **لا تُسرَّب كمية المخزون** في استجابة عامة.
  - فلترة بالبحث/الفئة/الدولة/العملة + `comparableOnly` (افتراضيًا مجموعات فيها بائعان+) + ترقيم.
- **Frontend**: صفحة عامة جديدة `/price-comparison` (`PriceComparisonPage.tsx`) — بحث + فلتر فئة + بطاقة لكل منتج (اسم مُعرّب، بائع/نوعه/موثّق، سعر، وسم «الأقل سعرًا»، فرق السعر، الحد الأدنى، التوفر، رابط المنتج) بتصميم RTL ومفاتيح i18n جديدة في ar/fr/en/zh. ربط في `PublicHeader` (سطح المكتب + الجوال) وفي `AppSidebar` (CUSTOMER/MERCHANT/COMPANY/SUPPLIER). `DashboardComparisonPage` أصبحت تستدعي المحرك الحقيقي بدل القائمة المسطّحة.
- **بيانات Demo إضافية (إضافية وإيدمبوتنت)**: بذرة `seed-demo.ts` تضيف منتجين قابلين للمقارنة (زيت زيتون 1ل + تمر دقلة نور 5كغ) — نفس الباركود من بائعين مختلفين بأسعار مختلفة، عبر `createProduct` نفسه (لا إدراج مباشر).

### التحقق الفعلي
- `price-comparison.test.ts` — **9/9** (عام بلا مصادقة؛ تجميع باركود ببائعين + ترتيب سعر/فرق؛ عدم دمج عملات؛ نطاق توفر بلا كمية؛ إخفاء غير المنشور؛ منع تسريب حقول خاصّة؛ فلترة/ترقيم؛ 422 عملة غير صالحة؛ الفئات).
- `e2e/price-comparison.spec.ts` — **6/6** من الواجهة الحقيقية (رابط الرئيسية؛ مقارنة حقيقية مرتّبة؛ فتح المنتج؛ حالة فراغ؛ تحديث URL بالفلترة؛ داشبورد التاجر).
- الحزمة الكاملة: `npm test -w @wasit/server` ⇒ **50 ملف / 517 اختبار ناجح**؛ E2E التراجعية (`marketplace` + `navigation-audit` + `functional-audit`) ⇒ **57/57**؛ typecheck server+web ⇒ **0 أخطاء**؛ build الويب ⇒ **PASS**.
- لا مساس بـ `89e68d7` (Marketing Video) ولا بسياسة العمولة 4% = 2%+2%؛ لا `db reset/drop/push`.

### الملفات
- `packages/server/src/modules/comparison/service.ts` (جديد)
- `packages/server/src/modules/comparison/routes.ts` (جديد)
- `packages/server/src/app.ts` (ربط المسار)
- `packages/server/src/scripts/seed-demo.ts` (عروض قابلة للمقارنة)
- `packages/server/tests/price-comparison.test.ts` (جديد)
- `packages/web/src/pages/PriceComparisonPage.tsx` (جديد)
- `packages/web/src/App.tsx`، `components/layouts/PublicLayout.tsx`، `components/layouts/AppSidebar.tsx`، `pages/DashboardInventoryPages.tsx`، `lib/api.ts`، `lib/types.ts`، `lib/i18n.ts`
- `e2e/price-comparison.spec.ts` (جديد)

### القرار التالي
- **متابعة أولويات `docs/PRODUCTION_GAP_LIST.md`**: لا فجوة Critical متبقية؛ البنود الباقية بنية خارجية (E1/E4/E5) أو مواصفة مستقبلية (AI Copilot). لا Module جديد حتى أمر منفصل.

---

## ✅ ORDER LIFECYCLE — إتمام دورة حياة الطلب من الواجهة (2026-09-22)

**الهدف**: سدّ الفجوة الوظيفية الداخلية التالية — كانت صفحة تفاصيل الطلب للبائع/المشتري تعرض الحالة كنص فقط بلا أي أزرار إجراء، فلا يمكن للبائع تقديم الطلب (PENDING→…→COMPLETED) ولا للمشتري الإلغاء، رغم وجود مسار الـAPI `PATCH /api/orders/:id/status` كاملًا في الخادم.

### ما تغيّر
- **الخادم — `packages/server/src/modules/orders/service.ts`**: `getOrder` يُثري الاستجابة بحقول يحتاجها الـUI:
  - `seller: { id, type, name }` — اسم الكيان البائع من `suppliers`/`merchants`/`companies` (join محمي بـunion، بلا تسريب حقول).
  - `viewerRole: 'SELLER' | 'BUYER' | 'NONE'` — يحسب ملكية المشاهد للطلب لتبني الواجهة أزرارها دون إعادة اشتقاق الملكية في العميل.
- **الواجهة — `packages/web/src/pages/DashboardOrdersPage.tsx`**:
  - بطاقة «الإجراءات» في تفاصيل الطلب: أزرار انتقالات الحالة حسب الدور (`allowedOrderActions` تعكس قواعد الخادم)، مع حالة انتظار، ورسائل نجاح/خطأ (`order-action-success` / `order-action-error`)، و`order-no-actions` عند انعدام أي انتقال.
  - قائمة الطلبات: الحالة تُعرض مترجَمة (`order.status.*`) بدل رمز إنجليزي خام.
- **الأنواع/الـAPI/i18n**: `OrderStatus` + `seller`/`viewerRole` في `types.ts`؛ `api.updateOrderStatus`؛ مفاتيح دورة الحياة وكل الحالات في `ar/en/fr/zh`.

### إصلاح bug حقيقي مكتشف أثناء الاختبار (لا إخفاء للخطأ)
- **الأصل**: نموذج إنشاء المنتج يرسل `nameAr: ''` عند ترك الحقل فارغًا، وكان الخادم يخزّنه `''` بدل `NULL` (`input.nameAr ?? null`). النتيجة: بطاقات «المفضلة/المحفوظ» في مكتبة العميل تعرض **رابطًا بلا نص** (لأن `p.nameAr ?? p.name` يعتبر `''` قيمة موجودة)، فلا يرى المستخدم اسم المنتج.
- **الإصلاح**: `blankToNull` في `createProduct` (تخزين الفراغ كـ`NULL`)، مع تقوية `resolveEntity` في `customer-library` (`p.nameAr?.trim() || p.name`) للصفوف القديمة.
- **تحقق فعلي**: إنشاء منتج بـ`nameAr:''` ⇒ صار `name_ar IS NULL` في القاعدة، وعاد العنوان للظهور في المكتبة.

### الاختبار الحقيقي
- **`e2e/order-lifecycle.spec.ts` (جديد، 2/2)**: من الواجهة الحقيقية — البائع يدفع طلبًا فعليًا PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED→COMPLETED بالضغط على الأزرار، والتحقق من الحالة **من الـAPI** لا من النص؛ ثم اختفاء الأزرار عند COMPLETED. والمشتري يلغي طلبًا معلّقًا من صفحته.
  - المواصفة تُنشئ منتجها الخاص وتُؤرشفه بعد الاختبار حتى لا تلوّث سوق الديمو المشترك.
- **حزمة الخادم**: 50 ملف / **517 اختبار ناجح**.
- **حزمة E2E كاملة**: **136/136 ناجح** (شملت functional-audit لكل الواجهات: CUSTOMER/MERCHANT/ADMIN/AI/ADS/MARKETING VIDEO/SUBSCRIPTIONS/MESSAGING/NOTIFICATIONS/SEO/RBAC/DISPUTES/PAYMENTS/PRIVACY/OBSERVABILITY).
- **typecheck** (server+web): 0 أخطاء. **build** الويب: PASS.

### الملفات
- `packages/server/src/modules/orders/service.ts`، `packages/server/src/modules/products/service.ts`، `packages/server/src/modules/customer-library/service.ts`
- `packages/web/src/lib/{api,types,i18n}.ts`، `packages/web/src/pages/DashboardOrdersPage.tsx`
- `e2e/order-lifecycle.spec.ts` (جديد)

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا تغيير في سياسة العمولة 4% (2%+2%)؛ لا مساس بـMarketing Video عند `89e68d7`؛ لا تعطيل أزرار لإخفاء أخطاء؛ لا Mock.

---

## ✅ UNIT ECONOMICS UI — إظهار CAC/LTV/هامش المساهمة للمدير (2026-09-23)

**الهدف**: سدّ الفجوة الوظيفية الداخلية التالية — فجوة **B9** كانت مغلقة خلفيًّا (`GET /api/admin/analytics/unit-economics` و`/cohorts` كاملان ومختبران، بصلاحية `ADMIN_ANALYTICS` وAudit)، لكن **لا شيء في الواجهة كان يستدعيهما**. أي أن مؤشرات CAC/LTV/هامش المساهمة والأفواج كانت محسوبة من بيانات حقيقية في الخادم لكنها **غير مرئية للمدير إطلاقًا** (Backend موجود / UI غائب).

### ما تغيّر (لا migration، لا جدول جديد، لا تغيير في الحسابات)
- **الواجهة — `packages/web/src/pages/AdminPages.tsx`**: قسمان جديدان في صفحة `/admin/analytics`:
  - بطاقة «اقتصاديات الوحدة» (`data-testid="admin-unit-economics"`): CAC، القيمة المحققة للعميل (LTV realized)، القيمة المتوقعة (LTV projected) معلّمة صراحةً بأنها **ليست حقيقة**، نسبة LTV/CAC، هامش المساهمة، إجمالي الهامش، الهامش لكل طلب، الإنفاق التسويقي، الطلبات المدفوعة، و**الافتراضات** (أشهر الاستبقاء وطلبات/شهر) المعروضة من `assumptions` نفسها، مع قائمة `basedOn` القابلة للفتح.
  - بطاقة «أفواج الاكتساب» (`data-testid="admin-cohorts"`): جدول شهري (شهر، عملاء جدد، GMV، الهامش) من `/cohorts` مع حالة فراغ.
  - تُجلب عبر `Promise.all` مع بقية تحليلات الأدمن؛ أي فشل يظهر في `ErrorState` بدل عرض أصفار مضللة.
- **الأنواع/الـAPI/i18n**: `UnitEconomics` + `CohortRow` + `UnitEconomicsAssumptions` في `lib/types.ts`؛ `api.adminAnalyticsUnitEconomics(params)` و`api.adminAnalyticsCohorts(params)`؛ مفاتيح i18n جديدة في **ar/fr/en/zh**.
- **لا أرقام وهمية ولا قيم ثابتة**: كل قيمة تُعرض من نفس الحمولة الحقيقية التي يعيدها الخادم.

### الاختبار الحقيقي من الواجهة
- **`e2e/admin-unit-economics.spec.ts` (جديد، 3/3)**: يقرأ نفس الحمولة `unit-economics`/`cohorts` التي تستهلكها الصفحة ويقارن الـDOM بها — CAC/LTV المحقق/المتوقع/نسبة LTV/النافذة/العملة/الافتراضات/صفوف الأفواج؛ ثم التحقق أن نافذة 7 أيام تختلف عن 30؛ ثم أن جلسة العميل تُرفض بـ**403** من مسار الأدمن (RBAC).
- **حزمة الخادم**: 50 ملف / **517 اختبار ناجح**.
- **حزمة E2E كاملة**: **139/139 ناجح** (كانت 136؛ +3 للوحدة الجديدة) — لا كسر في أي مواصفة قائمة.
- **typecheck** (server+web): 0 أخطاء. **build** الويب: PASS.
- **Browser smoke حقيقي** (admin@wasit.tn): الصفحة تعرض CAC `0,000 DT` (عملاء جدد: 1)، LTV محقق `16 723,860 DT`، متوقع `20 068,632 DT`، نسبة LTV/CAC `—` (لأن الإنفاق التسويقي صفر — عرض صريح لا خطأ)، هامش مساهمة `6.00%`، وفوج `2026-09`.

### الملفات
- `packages/web/src/pages/AdminPages.tsx`، `packages/web/src/lib/{api,types,i18n}.ts`
- `e2e/admin-unit-economics.spec.ts` (جديد)

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا تغيير في سياسة العمولة 4% (2%+2%)؛ لا مساس بـMarketing Video `89e68d7` ولا بـPrice Comparison/Order Lifecycle؛ لا Mock؛ لا تعطيل أزرار؛ RBAC والصلاحيات كما هي؛ RTL وar/fr/en/zh محفوظة.

### القرار التالي
- **لا فجوة Critical داخلية متبقية موثّقة**. البنود الباقية بنية خارجية (E1/E4/E5) أو مواصفة مستقبلية غير مُقنَّنة (AI Copilot). أُرشَّح للمراجعة لاحقًا (ليست Critical): صفحات لوحة العرض الثابتة (`/dashboard/finance`, `/dashboard/reports`, `/dashboard/sales`, وقوائم `DashboardListPage`) — بعضها يعرض `—`/فراغ حيث تتقاطع مع بيانات الأدمن، لكنها شاشات مخطَّطة في `UI_SCREEN_MAP.md` بلا كيان/مصدر بيانات محدد بعد؛ تحتاج قرار نطاق قبل التنفيذ.

---

## ✅ ADMIN USER SUSPEND/REACTIVATE — إيقاف/تفعيل الحساب من الواجهة (2026-09-24)

**الهدف**: الفجوة الداخلية الحقيقية التالية بعد B9. مسار الخادم `PATCH /api/admin/users/:id/status` (بصلاحية ADMIN/SUPER_ADMIN + Audit `ADMIN.USER_STATUS`) وعميل الواجهة `api.adminSetUserStatus` كانا **كاملين ومختبرين خلفيًّا**، لكن صفحة `/admin/users` كانت تعرض حالة التفعيل (`isActive`) كنصّ **للقراءة فقط** — فلا يملك المدير أي وسيلة لإيقاف حساب ضار أو إعادة تنشيطه من الواجهة (Backend موجود / UI غائب). هذه فجوة وظيفية أضيق وأكثر أمانًا من صفحات `/dashboard/sales|finance|reports` التي تحتاج قرار نطاق/مصدر بيانات (لا كيان بائع في `revenue_accounts`).

### ما تغيّر (لا migration، لا تغيير خلفي)
- **الواجهة — `packages/web/src/pages/AdminPages.tsx`** (`AdminUsersPage`): عمود «إجراءات» جديد بزر واحد يبدّل الحالة:
  - حساب نشط → **إيقاف الحساب** (أحمر)؛ حساب معطّل → **إعادة التنشيط** (أخضر).
  - `api.adminSetUserStatus(id, isActive)` ثم تحديث متفائل للصف + إعادة تحميل من الـAPI (مصدر الحقيقة)، مع `busyId` لحالة الانتظار ورسالة نجاح (`admin-users-notice`) و`ErrorState` عند الفشل.
  - `data-testid` للصف (`admin-user-status-<id>`) والزر (`admin-user-toggle-<id>`) لدعم الاختبارات الحقيقية.
- **i18n**: مفاتيح `admin.users.suspend/activate/suspended/activated` في **ar/fr/en/zh**.

### الاختبار الحقيقي
- **`e2e/admin-user-status.spec.ts` (جديد، 3/3)**: ينشئ حساب اختبار معزولًا لكل تشغيل (لا يمسّ مستخدمي الديمو)، ثم **من الواجهة**: يضغط «إيقاف الحساب» → يتحقق أن `GET /api/admin/users` يعيد `isActive=false`، وأن **الدخول يفشل 403 فعليًا** (`Account disabled`، معزولًا عن بوابة توثيق البريد بـ`allowUnverifiedEmail`)، ثم يضغط «إعادة التنشيط» → الدخول يعود 200؛ حالة ثانية تُثبت كتابة `ADMIN.USER_STATUS` في `GET /api/admin/audit-logs`؛ حالة ثالثة تُثبت أن جلسة العميل تُرفض **403**.
- **حزمة الخادم**: 50 ملف / **517 اختبار ناجح**.
- **حزمة E2E كاملة**: **142/142 ناجح** (كانت 139؛ +3) — لا كسر في أي مواصفة قائمة.
- **typecheck** (server+web): 0 أخطاء. **build** الويب: PASS.
- **Browser smoke حقيقي** (admin@wasit.tn): صفحة `/admin/users` تعرض عمود «إجراءات»؛ صفوف «معطّل» تُظهر «إعادة التنشيط» وصفوف «نشط» تُظهر «إيقاف الحساب» — الأزرار تفاعلية والحالة صحيحة.

### الملفات
- `packages/web/src/pages/AdminPages.tsx`، `packages/web/src/lib/i18n.ts`
- `e2e/admin-user-status.spec.ts` (جديد)

### القيود المُحترمة
لا migration/`db reset/drop/push` (لا تغيير خلفي إطلاقًا)؛ لا تغيير في سياسة العمولة 4% (2%+2%)؛ لا مساس بـMarketing Video `89e68d7` ولا B9 ولا Price Comparison/Order Lifecycle؛ لا Mock (اختبار ضد الخادم الحقيقي)؛ لا تعطيل أزرار؛ RBAC كما هو؛ RTL وar/fr/en/zh محفوظة.

### القرار التالي
- **لا فجوة Critical داخلية متبقية موثّقة.** الفجوات الداخلية المتبقية غير الحرجة تحتاج **قرار نطاق** قبل التنفيذ (لا تخمين): صفحات لوحة العرض الثابتة (`/dashboard/sales|finance|reports` وقوائم `DashboardListPage`) — `revenue_accounts` مستوى منصة بلا بُعد بائع، ويجب تحديد هل نضيف scoping جديد أم نعيد تعريف الشاشة، وهو تغيير في نموذج البيانات لا يصلح «فجوة صغيرة».

---

## ✅ SESSION REVOCATION — إنهاء الجلسات من الواجهة (2026-09-24)

**الهدف**: فجوة داخلية حقيقية ثانية. `api.revokeSession` و`POST /api/auth/sessions/revoke` كانا موجودين منذ البداية لكن **لا شيء في الواجهة يستدعيهما**: `/dashboard/security` كانت تسرد الجلسات (IP/تاريخ/انتهاء/متصفح) في جدول **للقراءة فقط** — فمستخدم يلاحظ جهازًا مجهولًا لا يملك أي وسيلة لإنهاء جلسته. ذات نمط الفجوة: Backend كامل / UI غائب.

### ما تغيّر
- **الخادم — `modules/auth/service.ts`**:
  - `listSessions(db, userId, currentTokenHash?)`: تُرجع الآن `isCurrent` (مقارنة هاش الكوكي بجلسة كل صف)، وتُخفي الجلسات **المُلغاة والمنتهية** (`revokedAt IS NULL AND expiresAt > now`) بدل سرد كل السجل التاريخي.
  - `revokeSession`: تُرجع `tokenHash` للجلسة المُلغاة أو `null` إن لم تُوجد/لم تكن مملوكة.
- **الخادم — `modules/auth/routes.ts`**:
  - `GET /api/auth/sessions` يمرّر `hashToken(cookie)` للتمييز بدقة.
  - `POST /api/auth/sessions/revoke`: **404** لجلسة غير موجودة أو غير مملوكة (بدل النجاح الصامت)، و**مسح كوكي الجلسة** إذا كان المستخدم يُلغي جلسته الحالية، وإرجاع `revokedCurrent`.
- **الواجهة — `pages/DashboardSimplePages.tsx`** (`DashboardSecurityPage`): عمود «إجراءات» بزر `session-revoke-<id>` («إنهاء الجلسة» / «إنهاء الجلسة الحالية»)، وسم `(الجهاز الحالي)`، حالة انتظار، رسالة نجاح (`security-sessions-notice`)، و`ErrorState` عند الفشل.
- **i18n**: `security.currentSession/revokeSession/logoutThisDevice/sessionRevoked` في ar/fr/en/zh.

### الاختبار الحقيقي
- **`e2e/security-sessions.spec.ts` (جديد، 2/2)**: ينشئ جلسة ثانية مستقلة (context منفصل) لنفس الحساب، ثم **من الواجهة** يضغط إنهاء الجلسة → يتحقق أن الجلسة الثانية تُرفض **401** بينما جلسة الواجهة تبقى **200**؛ وحالة ثانية تُثبت أن مستخدمًا لا يستطيع إلغاء جلسة حساب آخر (**404**) وأن جلسة الطرف الآخر تبقى سليمة.
- **حزمة الخادم**: 50 ملف / **517 اختبار ناجح**.
- **حزمة E2E كاملة**: **144/144 ناجح** (كانت 142؛ +2).
- **typecheck**: 0 أخطاء. **build** الويب: PASS.
- **Browser smoke حقيقي**: `/dashboard/security` يعرض عمود «إجراءات» ووسم «(الجهاز الحالي)» على جلسة المتصفح الحالية مع زر «إنهاء الجلسة الحالية»، وأزرار «إنهاء الجلسة» لباقي الجلسات — الصفحة تُخفي المُلغاة/المنتهية.

**ملاحظة إصلاح regression**: تسمية الزر كانت «تسجيل الخروج من هذا الجهاز» فتسبّبت في strict-mode collision مع زر الشريط الجانبي في `e2e/mfa.spec.ts` (regex `/تسجيل الخروج|Sign out/`). أُعيدت التسمية إلى «إنهاء الجلسة الحالية» → 144/144 خضراء.

### الملفات
- `packages/server/src/modules/auth/service.ts`، `packages/server/src/modules/auth/routes.ts`
- `packages/web/src/pages/DashboardSimplePages.tsx`، `packages/web/src/lib/api.ts`، `packages/web/src/lib/i18n.ts`
- `e2e/security-sessions.spec.ts` (جديد)

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا تغيير في سياسة العمولة 4%؛ لا مساس بـMarketing Video `89e68d7` ولا B9/B10/B11؛ لا Mock؛ لا تعطيل أزرار؛ RBAC كما هو (لا يلغي المستخدم إلا جلساته)؛ ar/fr/en/zh وRTL محفوظة.


---

## ✅ ADMIN PRODUCT REACTIVATE — إعادة تنشيط منتج (2026-09-24)

**الهدف**: فجوة داخلية ثالثة من نمط «إجراء أحادي الاتجاه في الواجهة». `/admin/products` كانت تعرض زر **إيقاف** فقط للمنتجات غير الموقوفة (`p.status !== 'SUSPENDED'`): لحظة إيقاف منتج يختفي الزر، فلا توجد أي وسيلة لإعادته إلى ACTIVE من الواجهة — مع أن `PATCH /api/products/:id/status` يدعم `ACTIVE` أصلًا. النتيجة: منتج موقوف بالخطأ = غير قابل للتشغيل حتى من الأدمن.

### ما تغيّر
- **`pages/AdminPages.tsx`** (`AdminProductsPage`): `suspend(id)` → `setStatus(id, status)`؛ المُوقوف يحصل على زر **«إعادة التنشيط»** (`admin-product-reactivate-<id>`) يستدعي `api.adminSetProductStatus(id,'ACTIVE')`، وغير المُوقوف على زر **«إيقاف»** (`admin-product-suspend-<id>`). الصف موسوم `data-testid="admin-product-<id>"` وعمود الإجراءات بعنوان `common.actions`.
- **`lib/api.ts`**: `adminSetProductStatus(id, status)` جديدة على `PATCH /api/products/:id/status` (المسار الموجود الداعم لـACTIVE) بجانب `adminSuspendProduct`.
- **i18n**: إعادة استعمال مفتاح موجود `admin.users.activate` («إعادة التنشيط»/Reactivate/...)، فلا مفاتيح جديدة.

### الاختبار الحقيقي
- **`e2e/functional-audit.spec.ts`**: حالة «admin product table … suspend one» توسّعت لتُثبت الدورة كاملة على **نفس الصف** (مُحدَّد بالـtestid): ACTIVE → إيقاف → SUSPENDED ظاهرة → إعادة تنشيط → ACTIVE ظاهرة. (كانت تُثبت الإيقاف فقط.)
- **حزمة E2E كاملة**: **144/144 ناجح**. **typecheck**: 0. **build** الويب: PASS.
- **Browser smoke حقيقي**: `/admin/products` (سجل أدمن) يعرض عمود «إجراءات» بزرّي الإيقاف/إعادة التنشيط حسب حالة كل صف.

### إصلاح هشاشة اختبار (root cause حقيقي)
- `admin-ai.spec.ts` «requests tab reflects a real AI invocation» كان يقارن **طول القائمة** (`limit=200`) قبل/بعد، وهي مشبعة بسبب تكرار التشغيل — فلا يمكن أن تزيد. أُعيد كتابته ليؤكد ظهور **معرّف الطلب الجديد** (`admin-ai-request-<id>`) في الصف الأول، وهو تحقق حقيقي ولا يعتمد على نافذة 200.
- كما أن `e2e/global-setup.ts` كان يفشل عند استنفاد محدّد `forgot-password` (5/5دقائق) بعد تشغيلات متكررة؛ أُعيد تشغيل الخادم تحت إدارة Playwright بمُحدّدات E2E المرفوعة (`RATE_LIMIT_*_MAX=500`) وهذا سلوك بيئة اختبار لا خطأ منتج.

### الملفات
- `packages/web/src/pages/AdminPages.tsx`، `packages/web/src/lib/api.ts`
- `e2e/functional-audit.spec.ts`، `e2e/admin-ai.spec.ts`

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا تغيير في سياسة العمولة 4%؛ لا مساس بـMarketing Video `89e68d7` ولا B9/B10/B11/B12؛ لا Mock؛ لا تعطيل أزرار؛ RBAC كما هو؛ ar/fr/en/zh وRTL محفوظة.



---

## ✅ ADS CAMPAIGN STATE MACHINE — إصلاح أزرار الحملات + حرس إيقاف المنتج (2026-09-25)

**الهدف**: متابعة نمط «الإجراء أحادي الاتجاه» في الواجهة. عند فحص صفحة الإعلانات وُجد خطآن حقيقيان:

### 1) أزرار الحملة لا تحترم آلة الحالة (root cause)
كان الزر الأول يعتمد `disabled={cp.status === 'ACTIVE'}` بدل إظهاره بشرط `DRAFT` فقط، وزر **«استئناف»** كان يظهر لأي حالة غير `DRAFT` (`cp.status !== 'DRAFT'`). الخادم يمنع `ACTIVE` من `COMPLETED`/`CANCELLED` بـ**409**، فكانت الواجهة تعرض زرًا يفشل دائمًا.
- **الإصلاح (`pages/DashboardBusinessPages.tsx`)**: إظهار الأزرار حسب آلة الحالة الفعلية:
  - `DRAFT` → تفعيل + إلغاء
  - `ACTIVE` → إيقاف مؤقت + إنهاء
  - `PAUSED` → استئناف + إلغاء + إنهاء
  - `COMPLETED`/`CANCELLED` → بلا أزرار انتقال.
- إضافة `testId` لبطاقة الحملة (`ads-campaign-<id>`) وأزرارها (`ads-activate/pause/resume/cancel/end-<id>`) للتحقق الحقيقي من الواجهة.

### 2) البائع كان قادرًا على رفع إيقاف الأدمن عن منتجه (ثغرة صلاحيات)
`PATCH /api/products/:id/status` كان يسمح لأي بائع مالك بالانتقال من `SUSPENDED` إلى `ACTIVE`، أي أن إجراء الإنفاذ الإداري **قابل للعكس من الطرف الذي فُرض عليه**. كما أن واجهة البائع `DashboardProductsPage` كانت تعرض زرّ **«نشر»** على صفوف `SUSPENDED` فيفشل بعد الإصلاح.
- **الخادم (`modules/products/routes.ts`)**: لغير الأدمن، منع تغيير الحالة إذا كان المنتج `SUSPENDED` → **403** («لا يُعاد تنشيط منتج موقوف إلا من قِبل مسؤول»). البائع يبقى قادرًا على تبديل `ACTIVE↔INACTIVE` لمنتجه غير الموقوف.
- **الواجهة (`pages/DashboardProductsPage.tsx`)**: صف `SUSPENDED` يعرض إشعارًا (`product-suspended-<id>`) بدل زر النشر؛ `testId` على زر الحالة.
- **i18n**: `product.suspendedNotice` في ar/fr/en/zh.

### الاختبار الحقيقي
- **`packages/server/tests/product-suspension.test.ts` (جديد)**: بائع يبدّل منتجه INACTIVE↔ACTIVE (200) → أدمن يوقف (200) → البائع يحاول ACTIVE ⇒ **403** والحالة تبقى `SUSPENDED` في DB → الأدمن يعيد التنشيط ⇒ 200 و`ACTIVE`.
- **`e2e/functional-audit.spec.ts`**: حالة جديدة تسجّل الدخول كتاجر، توقف أحد منتجاته فعليًا عبر جلسة أدمن منفصلة، ثم من الواجهة تؤكد ظهور إشعار الإيقاف و**غياب أي زر** في الصف (لا زر يكذب على المستخدم).
- **`e2e/ads.spec.ts`**: توسّع ليجتاز آلة الحالة كاملة من الواجهة: DRAFT→ACTIVE→PAUSED→ACTIVE→COMPLETED، والتأكد أن زر الاستئناف **لا يظهر** بعد الإنهاء.
- **حزمة الخادم**: 51 ملف / **518 اختبار ناجح** (+1).
- **حزمة E2E كاملة**: **145/145 ناجح** (كانت 144؛ +1 صافي).
- **typecheck**: 0 أخطاء. **build**: PASS.

### الملفات
- `packages/server/src/modules/products/routes.ts`، `packages/server/tests/product-suspension.test.ts` (جديد)
- `packages/web/src/pages/DashboardBusinessPages.tsx`، `packages/web/src/pages/DashboardProductsPage.tsx`، `packages/web/src/lib/i18n.ts`
- `e2e/ads.spec.ts`، `e2e/functional-audit.spec.ts`

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ لا مساس بـMarketing Video `89e68d7` ولا F4 ولا G/H/I/J ولا E2–E5؛ لا Mock؛ لا تعطيل أزرار لإخفاء الأخطاء (بل تصحيح المنطق)؛ RBAC كما هو (أُضيف حرس لا يُوسّع صلاحيات)؛ ar/fr/en/zh وRTL محفوظة.

**ملاحظة تشغيل**: تشغيل Playwright أثناء وجود خوادم dev يدوية على المنفذين 3000/5173 يجعل `reuseExistingServer` يتبنّاها، فتسقط ~15 حالة (rate limits الإنتاجية + `BACKUP_HEARTBEAT_FILE` غائب) — ليست أخطاء منتج. أوقف الخوادم اليدوية قبل `npx playwright test`.

---

## ✅ ADMIN ADVERTISING DESK + إصلاح حرس الكتابة على الحملات (2026-09-20)

**الهدف**: سدّ الفجوة الداخلية التالية بعد E5 — شاشة إعلانات الأدمن. كانت صلاحية `ADMIN_ADS` و`GET /api/admin/ads/summary` موجودتين ومُختبرتين على الخادم، ودالة العميل `adminAdsSummary()` موجودة، لكن **لا صفحة `/admin/ads` ولا مدخل تنقّل ولا أي مستهلك للواجهة** ⇒ المسار كان مكتملًا من الخادم ومقطوعًا من المستخدم.

### 1) السبب الجذري الحقيقي الأهم: الأدمن كان محجوبًا عن تعديل حملات الآخرين
كانت `getMyCampaign` و`getCampaignStats` و`listMyCampaigns` تمنح `CAMPAIGN_MANAGE` (ADMIN/SUPER_ADMIN) نطاقًا عبر كل المعلنين، بينما `updateCampaign` و`addCreative` تستدعيان `assertOwnAdvertiser` **دون فحص الدور**. أثبت الاختبار الحقيقي أن `PATCH /api/ads/campaigns/:id` يعيد **403** للأدمن على حملة تاجر. أي أن الإشراف الإداري كان **مستحيلًا بنيويًا**، وليس مجرد افتقاد واجهة.
- **الإصلاح (`modules/ads/service.ts`)**: تمرير `actorRoles` إلى `updateCampaign`/`addCreative`؛ يُعفى من `assertOwnAdvertiser` من يملك `PERMISSIONS.CAMPAIGN_MANAGE`، تمامًا كما في مسارات القراءة. غير المالك غير الأدمن يبقى **403** (مُختبَر).

### 2) عقد خادم جديد بلا migration
`GET /api/admin/ads/campaigns` (ADMIN فقط) يعيد كل الحملات مع حلّ `advertiser_id` متعدد الأنواع (supplier/merchant/company) إلى **اسم المعلن وبريد المالك** عبر `union all` + `left join users` — دون أي تغيير مخطط.

### 3) شاشة `/admin/ads`
- `pages/AdminAdsPage.tsx`: KPIs من الصلاحية الحية، جدول عبر كل المعلنين، وأزرار إشراف تُبنى من **آلة الحالة الفعلية** (DRAFT→ACTIVE/CANCELLED، ACTIVE→PAUSED/COMPLETED، PAUSED→ACTIVE/COMPLETED/CANCELLED، COMPLETED/CANCELLED بلا انتقال) — لا زر يفشل دائمًا.
- `App.tsx` مسار `/admin/ads` محروس بـ`AdminOnly`؛ مدخل تنقّل في `AppSidebar`؛ `adminAdsCampaigns()` في `lib/api.ts`؛ أنواع `AdminAdSummary`/`AdminCampaignRow`؛ مفاتيح i18n في ar/fr/en/zh.

### الاختبار الحقيقي
- **`packages/server/tests/phase15-ads-ai.test.ts` (+3)**: قائمة الأدمن عبر المعلنين مع اسم/بريد المالك و**403 لغير الأدمن**؛ أدمن يوقف ثم يستأنف حملة تاجر (200 + `isActive` يتبدّل)؛ معلن آخر يبقى **403**.
- **`e2e/admin-ads.spec.ts` (جديد، 3 حالات)**: يفتح المكتب من الشريط الجانبي ويتحقق أن KPIs تساوي حمولة الخادم الحية؛ ينشئ حملة DRAFT بجلسة التاجر ثم **من الواجهة** يفعّل→يوقف→ينهي ويتحقق من `status`/`isActive` في الخادم؛ ويثبت **403** لغير الأدمن (بسياق Playwright معزول حتى لا يُسجَّل خروج الجلسة الإدارية المشتركة).
- **`e2e/functional-audit.spec.ts`**: أُضيف `/admin/ads` إلى قائمة صفحات الأدمن.
- **حزمة الخادم**: 51 ملف / **522 اختبار ناجح** (+4).
- **حزمة E2E كاملة**: **152/152 ناجح** (كانت 148؛ +4 صافي).
- **typecheck**: 0 أخطاء. **build**: PASS (server + web).

### الملفات
- `packages/server/src/modules/ads/service.ts`، `packages/server/src/modules/ads/routes.ts`، `packages/server/src/modules/admin/routes.ts`، `packages/server/tests/phase15-ads-ai.test.ts`
- `packages/web/src/pages/AdminAdsPage.tsx` (جديد)، `packages/web/src/App.tsx`، `packages/web/src/components/layouts/AppSidebar.tsx`، `packages/web/src/lib/api.ts`، `packages/web/src/lib/types.ts`، `packages/web/src/lib/i18n.ts`
- `e2e/admin-ads.spec.ts` (جديد)، `e2e/functional-audit.spec.ts`

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ لا مساس بـMarketing Video `89e68d7`؛ لا Mock؛ لم تُعطّل أزرار لإخفاء أخطاء؛ RBAC لم يُوسَّع (أُضيف فحص دور يطابق مسارات القراءة القائمة)؛ ar/fr/en/zh وRTL محفوظة.

## ✅ تشخيص وإصلاح حقيقي: "أُنشئ الحساب ولا أستطيع تسجيل الدخول" من Public HTTPS (2026-09-24)

**العرض**: حساب يُنشأ عبر الواجهة بنجاح، ثم يُرفض تسجيل الدخول بـ `EMAIL_NOT_VERIFIED` رغم أن التسجيل أعاد `requiresEmailVerification:false`. أي أن وعد الـdemo «سجّل ثم ادخل مباشرة» كان **كاذبًا لحسابات موجودة مسبقًا**.

### 1) التشخيص الحقيقي (لا افتراض أن المشكلة في المستخدم/المتصفح)
بعد استنفاد كل المسارات الآلية التي **نجحت** (تسجيل جديد + دخول، جميع الأدوار، جميع حسابات البذرة، الجميع يصل إلى `/dashboard`)، أُعيد إنتاج الحالة التي يمر بها المستخدم الحقيقي: **حساب محفوظ بـ`email_verified=false`**. النتيجة من الخادم العام:
```
POST /api/auth/login -> 403 {"code":"EMAIL_NOT_VERIFIED","message":"Please verify your email before logging in"}
```
- **السبب الجذري**: التنازل في وضع الـdemo كان يُطبَّق **عند التسجيل فقط** (`registerUser` يخزّن الحساب موثّقًا)، بينما بوابة الدخول `loginUser` (`service.ts:409`) تظل تفرض `!user.emailVerified`. فكل حساب سُبق إنشاؤه قبل وجود هذا التنازل (أو وُجد في البذرة غير موثّق) **محجوب نهائيًا** — ولا يوجد صندوق بريد في الـdemo لإكمال التحقق. هذا يفسّر تمامًا لماذا نجحت اختباراتي السابقة (حسابات جديدة) وفشل المستخدم الحقيقي (حساب قديم غير موثّق).
- `emailVerified` يُفرض في مكان واحد فقط (بوابة الدخول)؛ فلا بوابات أخرى تحتاج تغييرًا.

### 2) الإصلاح (سبب جذري، لا إخفاء)
في `loginUser`: عند بقاء الحساب غير موثّق **داخل الـdemo فقط** (`demoEmailVerificationSkipped()`، وهي `false` إلزاميًا في الإنتاج)، يُطبَّع السجل `emailVerified=true` ثم يُسمح بالدخول. بهذا يطابق الدخول ما يفعله التسجيل (حساب demo موثّق) بدل حالة نصف-موثّقة تُربك بقية المنصة (Trust Engine / Verification). الإنتاج بلا تغيير: البوابة ترفض بـ403.

### 3) الاختبار الحقيقي
- **اختبار خدمة جديد** (`demo-email-verification.test.ts`): ينشئ حسابًا تحت التحقق الإلزامي (فيُحفظ `email_verified=false`)، يثبت رفض الدخول 403، ثم يثبت أن تنازل الـdemo يسمح بالدخول **ويطبّع الصف** إلى `email_verified=true` و`/api/auth/me` يعيد `emailVerified:true`.
- **إعادة إنتاج عامة ثم تحقق**: نفس الحساب المحجوب أعاد `200 success` بعد الإصلاح، وقاعدة البيانات أظهرت `email_verified=t`.
- **حزمة الخادم**: 54 ملف / **565 اختبار ناجح** (بيئة نظيفة عبر `env -i`).
- **E2E كاملة (demo)**: **196/196 ناجح** — 7.1م (التشغيل الأول أخفق 189 بسبب تسرّب متغيرات `.env.demo` إلى الجلسة: `CORS_ORIGIN` العام + `wasit_demo`؛ أُعيد بعد `reset`).
- **E2E الوضع الافتراضي (تحقق إلزامي)**: **9/9 ناجح** (auth + demo-registration + mfa).
- **typecheck**: 0 أخطاء. **build**: PASS (server + web).
- **Browser Functional Smoke Test حقيقي على Public HTTPS** (Pixel 5): 6/6 — الصفحة العامة 200؛ `customer1@wasit.tn`→dashboard؛ `admin@wasit.tn`→admin؛ زائر جديد يسجّل ويدخل ويظهر بريده باللوحة؛ **والحساب غير الموثّق سابقًا يدخل من الواجهة**.

### 4) جدول الوظائف المُختبرة من الواجهة
| الميزة | اختُبرت من الواجهة | النتيجة | السبب الجذري عند الفشل | الإصلاح | حالة الاختبار |
|---|---|---|---|---|---|
| دخول حساب بذرة (customer/admin) | نعم | PASS | — | — | PASS |
| تسجيل زائر جديد | نعم | PASS | — | — | PASS |
| دخول مباشر بعد التسجيل (حساب جديد) | نعم | PASS | — | — | PASS |
| **دخول حساب محفوظ غير موثّق (الحالة الواقعية)** | نعم | **403 ثم PASS** | التنازل مطبَّق عند التسجيل فقط والدخول يفرض التحقق | تطبيع `emailVerified` عند الدخول في الـdemo فقط | PASS |
| تسجيل خروج فعلي (إبطال الجلسة) | نعم | PASS | — | — | PASS |
| إعادة الدخول بعد الخروج | نعم | PASS | — | — | PASS |
| صفحات الأدوار (dashboard/admin) | نعم | PASS | — | — | PASS |

### الملفات
- `packages/server/src/modules/auth/service.ts` (بوابة الدخول)
- `packages/server/tests/demo-email-verification.test.ts` (+حالة)

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا حذف بيانات اختبار ضرورية؛ سياسة العمولة 4% (2%+2%) دون تغيير؛ لا مساس بـMarketing Video `89e68d7`؛ لا Mock؛ الإنتاج لم يتغيّر (البوابة تبقى صارمة)؛ RBAC/CORS/security hardening مجمّدة.

## 🔎 تشخيص حساب بعينه: `rhimiimed18@gmail.com` — ROOT CAUSE ليس في الكود (2026-09-24)

**السؤال**: لماذا يعيد تسجيل الدخول لهذا الحساب على Public HTTPS: `Invalid credentials`؟

### ما نُفّذ فعليًا (خطوة بخطوة)
1. **فحص Demo DB**: الاستعلام المطبّع `lower(trim(email))` عن `rhimiimed18@gmail.com` أعاد **0 صفوف**. لا وجود للحساب في `wasit_demo` (ولا تطابق قريب `%rhimi%`/`%imed18%`). لا يوجد أي حساب `@gmail.com` قبل إضافة فحص — أي **0** حساب gmail في الـdemo قبل اختباري.
2. **هل الـDB يستهدف فعلًا ما تخدمه الواجهة؟** أُثبت بالتتبّع: عملية الـAPI العامة تحمل `DATABASE_URL=…/wasit_demo`، و`POST /api/auth/register` عبر الرابط العام يُنشئ الصف في `wasit_demo` فورًا (تحقّق بپrobe). إذًا العلاقة سليمة والـAPI يكتب في `wasit_demo`.
3. **تحقق كلمة المرور داخليًا** (بلا كشف أي سر): الاستعلام المطبّع أعاد 0 صفوف ⇒ `loginUser` يأخذ فرع `row.length === 0` الذي ينفّذ `verifyPassword` على **هاش وهمي ثابت** (لموازنة التوقيت) ثم يرمي `ApiError.unauthorized('Invalid credentials')`. أي **لا تتم مقارنة أي hash مخزّن** لأنه لا يوجد صف أصلًا. السبب ليس كلمة مرور ولا hash — بل **غياب الحساب**.
4. **login الحقيقي من الواجهة على Public HTTPS**: `401 /api/auth/login` → `Invalid credentials` → البقاء على `/login`. (نفس المسار المتوقّع تمامًا لحساب غير موجود.)
5. **التتبع الكامل**: frontend payload → public proxy → API → user lookup (**0 rows**) → password verification (وهمي) → email verification (لا يُبلَّغ) → session (لا يُنشأ). نقطة الفشل = **user lookup**.
6. **لماذا الحساب غير موجود؟** بيئة الـdemo رخوة/مؤقتة: عنقود PostgreSQL نفسه أُنشئ اليوم (`/var/lib/postgresql/17/main` بتاريخ 24 Sep 05:06)، وأقدم حساب في `wasit_demo` أُنشئ 05:35 — أي أن الـDB أُعيد بناؤه/بُذر خلال جلسة سابقة. فالحساب إمّا لم يُسجَّل أبدًا في `wasit_demo`، أو سُجّل في بيئة أخرى (أو قبل إعادة بناء الـDB). صفر أثر في `audit_logs` باسمه، وصفر حسابات `@gmail.com` — ما يؤكد **لم يُسجَّل قط في قاعدة الـdemo هذه**.

### الحكم
- **ROOT CAUSE**: الحساب غير موجود في قاعدة بيانات الـdemo التي يخدمها الرابط العام. `Invalid credentials` من فرع "المستخدم غير موجود" (0 rows) — **ليس** عدم تطابق كلمة مرور ولا مشكلة في الكود.
- **لم يُغيّر أي كود** لتلبية هذا الطلب: مسار المصادقة نفسه سليم ومُثبت من الواجهة (تسجيل→دخول→لوحة→خروج→دخول ثانٍ = PASS)، ولا حاجة لأي bypass.
- **لماذا كانت فحوصي السابقة PASS؟** لأنها استخدمت حسابات موجودة/جديدة؛ هذه الحالة الواقعية هي **حساب غير موجود**، لذا أظهرت `Invalid credentials` لا خطأ آخر.

### ما أوصي به للمستخدم
الحساب غير موجود في الـdemo ولن يعمل أي login به حتى يُسجَّل من جديد من الرابط العام:
1. افتح `https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev/register`.
2. أنشئ الحساب (كلمة المرور التي تريدها) — سيصبح صالحًا فورًا (`requiresEmailVerification:false`).
3. سجّل الدخول. أو استخدم حساب بذرة موثّقًا: `customer1@wasit.tn` / `merchantA@wasit.tn` / `admin@wasit.tn` بكلمة `Passw0rd!2026`.

> ملاحظة تحذيرية: أثناء تشخيصي ظهر في مخرجات طرفية ملف `meta.json` لجلسة أخرى يحتوي قيَم أسرار (توكنات)؛ لم أستخدمها ولا أعدت طباعتها، وأوقفت البحث في مسار `.conversations`. لا صلة لذلك بهذا التشخيص.

### التحقق النهائي (بواباتي)
- **server tests**: 54 ملف / **565/565** ناجح (بيئة نظيفة).
- **E2E (demo)**: **196/196** ناجح (7.4م).
- **E2E الافتراضي (تحقق إلزامي)**: **9/9** ناجح.
- **typecheck**: 0 أخطاء. **build**: PASS (server + web).
- **Public HTTPS**: root=200، api=200؛ تسجيل+دخول+لوحة+خروج+دخول ثانٍ = **PASS**؛ الحساب المذكور = **FAIL** لأنه غير موجود (المتوقع).

### جدول
| الميزة | اختُبرت من الواجهة | النتيجة | السبب الجذري عند الفشل | الإصلاح | حالة الاختبار |
|---|---|---|---|---|---|
| login بحساب `rhimiimed18@gmail.com` | نعم (Public HTTPS) | **FAIL** | الحساب غير موجود في `wasit_demo` (0 rows ⇒ فرع USER_NOT_FOUND) | لا إصلاح كود؛ يجب تسجيل الحساب من جديد (بيانات مستخدم لا كود) | FAIL (متوقع) |
| register + login + dashboard + logout + login ثانٍ | نعم | PASS | — | — | PASS |
| Production email verification | — | لم تُمس | — | — | PASS (9/9) |
| Demo-only behavior | نعم | PASS | — | — | PASS |
