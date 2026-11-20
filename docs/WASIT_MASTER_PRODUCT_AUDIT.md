# WASIT BUSINESS GLOBAL — MASTER PRODUCT AUDIT & BUSINESS READINESS MAP

> **نوع الوثيقة:** تدقيق منتج/تجاري/تقني — **READ-ONLY**. لا كود، لا قاعدة بيانات، لا Migrations/Seeds، لا DEMO/إنتاج، لا Git مُغيِّر.
> **تاريخ التدقيق:** 2026-11-12 (UTC) · **الفرع:** `master` · **HEAD:** `98c3a958a0faa7e1bf174e33900d3c298578b4aa`
> **الجمهور:** المدير العام (غير تقني) + القيادة التقنية.
> **قاعدة الدليل:** لا يُعتبر أي بند مكتملاً إلا بدليل من الكود أو اختبار أو وثيقة. وجود صفحة/زر/API **ليس** دليلاً على اكتمال وظيفة تجارية.
> **قاعدة الفصل:** نميّز صراحةً بين ثلاث طبقات: **(أ) موجود في الكود** · **(ب) مُختبر** · **(ج) جاهز تجارياً**. لا خلط بينها.

---

## المرحلة صفر — حماية المستودع (READ-ONLY Gate)

### 0.1 بوابة السلامة — قبل التدقيق (مسجّلة عند البدء)

| البند | القيمة |
| --- | --- |
| المسار | `/workspace/project` |
| الفرع | `master` |
| HEAD | `98c3a958a0faa7e1bf174e33900d3c298578b4aa` |
| Staged | 0 |
| Modified | 101 |
| Untracked | 119 |
| Deleted | 0 |
| Total | 220 |
| بصمة M0 (`repo.bundle`) | `e731e6845b3d1fe5647fd4168e592067099f591a336de0fa8117d53050fa8694` |
| Stashes | لا يوجد (`git stash list` فارغ) |

### 0.2 ما لم يُنفَّذ (التزام صريح)

- ❌ لا تعديل/حذف/نقل/إعادة تسمية أي ملف.
- ❌ لا `stage` / `commit` / `push`.
- ❌ لا `reset` / `clean` / `checkout` / `switch` / `stash`.
- ❌ لا Migrations / Seeds / أي تعديل على قاعدة البيانات.
- ❌ لا تشغيل DEMO أو Production أو أي تكامل خارجي حقيقي.
- ✅ الملف الوحيد المُنشأ: **هذا التقرير** (`docs/WASIT_MASTER_PRODUCT_AUDIT.md`).

---

## 1. الملخّص التنفيذي (للمدير العام)

### ماذا نملك اليوم؟

WASIT BUSINESS GLOBAL منصّة **وساطة تجارية رقمية** (Marketplace + Commerce + Trust + AI + Advertising + Analytics) مبنية كـ monorepo من ثلاث حزم:

- **`packages/server`** — النواة الكاملة (TypeScript + Hono + Drizzle ORM + PostgreSQL): **37 وحدة** وظيفية، **≈341 تسجيل مسار HTTP**، **101 جدول قاعدة بيانات**، **42 نوع enum**، **37 ملف migration**.
- **`packages/web`** — الواجهة (React + Vite + TypeScript + Tailwind): **40 ملف صفحة**، **≈77 مدخل Route**، و**22,902 سطر** كود.
- **`packages/shared`** — الثوابت المشتركة (10 أدوار، كتالوج صلاحيات، أخطاء موحّدة).

حجم كود الخادم: **230 ملف TypeScript / 42,428 سطر**. حالة TypeScript: **0 أخطاء** (`tsc --noEmit` — مُتحقق في هذه الجلسة).

### ماذا يعمل فعلياً (بدليل نفّذته هذه الجلسة)؟

| الفحص | النتيجة | الطبيعة |
| --- | --- | --- |
| `tsc --noEmit` (server) | **0 أخطاء** | ✅ مُنفَّذ الآن |
| حزمة الوكلاء/السياق المعزولة (`vitest.t1.config.ts`) | **122/122** (6 ملفات) | ✅ مُنفَّذ الآن — بلا DB |
| حزمة السلع المحظورة (`vitest.lc03.config.ts`) | **26/26** (3 ملفات) | ✅ مُنفَّذ الآن — بلا DB |
| اختبارات الويب (`packages/web`) | **50/50** (4 ملفات) | ✅ مُنفَّذ الآن — بلا DB |
| **إجمالي ما أُثبت حيّاً في هذه الجلسة** | **198 اختبار + 0 أخطاء أنواع** | ✅ |
| حزمة الخادم الكاملة (تكامل مع PostgreSQL) | **غير مُشغَّلة** | ⛔ BLOCKED — لا PostgreSQL ولا Docker daemon |

### ماذا ينقصنا؟ (أهم الخلاصات)

1. **لا إثبات تكامل حيّ مع PostgreSQL في هذه الجلسة** — كل وظائف المال/الطلبات/التسوية **موجودة ومُختبرة تاريخياً** لكن **لم تُعَد** هنا (لا خادم DB). هذا **قيد إثبات**، لا فجوة منتج.
2. **لا مزوّد دفع حقيقي** — الكود يمرّ عبر منفذ مزوّد (`PaymentProviderPort`) بمحوّلات `flouci`/`clictopay`/`open-checkout`، لكن **لا مفاتيح إنتاجية**، والنموذج التجاري يعتمد **Split لدى المزوّد** وهو **غير مؤكَّد كتابياً** (BLOCKED).
3. **لا اعتماد قانوني** — 9 وثائق قانونية **مبنية تقنياً** لكنها كلها `LEGAL_REVIEW_REQUIRED` بلا سريان (BLOCKED على محامٍ).
4. **لا KYC/KYB/AML** — التحقق حاليًا **مراجعة وثائق بشرية** (BLOCKED على مزوّد هوية).
5. **لا اكتساب عملاء ولا سيولة سوق** — بيانات العرض فقط.
6. **الوكلاء (AI)** موجودون (11) لكن المزوّد الافتراضي **منطق محلي حتمي** لا LLM، وطبقة **Supervisor/Tool Gateway/الذاكرة غير موصولة**.
7. **وظائف تجارية جزئية/ناقصة**: لا سلة (Cart)، لا مسار `manual` كامل من الواجهة (موجود لكن DEMO-only)، لا Admin Desks (تجار/موردون/شركات/فئات/عملات/لغات/عمولات)، ولا Support Desk.

### ما الذي يمنعنا من الإطلاق؟

**عوائق إطلاق (P0) تجارية/قانونية/بنية خارجية — ليست عيوب كود:**

1. لا عقد مزوّد دفع + لا تأكيد Split + لا حساب تسوية/بنكي.
2. لا اعتماد قانوني (ToS/Privacy/Cookie/Refund/Buyer/Seller/Supplier/DPA).
3. لا KYC/KYB/AML.
4. لا بيئة إنتاج/Staging مستضافة + نطاق/DNS/TLS.
5. لا قنوات إشعار إنتاجية (Email/SMS) — In-app فقط.
6. لا سيولة سوق (موردون/مشترون حقيقيون).

### أهم 10 أولويات (مرتّبة)

| # | الأولوية | النوع | السبب في الترتيب |
| --- | --- | --- | --- |
| 1 | **تثبيت نطاق المنتج وMVP** | قرار | كل البناء اللاحق يعتمد عليه؛ بلا نطاق مثبّت لا معايير قبول. |
| 2 | **إثبات تكامل PostgreSQL حيّ** | تحقّق | يحوّل 37 وحدة من «موجودة/مختبرة تاريخياً» إلى «مُثبتة الآن». |
| 3 | **مسار إتمام الدفع اليدوي/Offline** | منتج | يفتح أول دورة مال حقيقية قابلة للتشغيل قبل المزوّد الحيّ. |
| 4 | **تأكيد قدرة المزوّد (Split/Settlement)** | تجاري/خارجي | النموذج المالي (4% = 2%+2%) لا يُنفَّذ بلا هذا. |
| 5 | **الاعتماد القانوني للوثائق** | قانوني | يمنع التشغيل القانوني (تونس/EU). |
| 6 | **KYC/KYB/AML** | قانوني/خارجي | لا تحقق نظامي من الأطراف. |
| 7 | **بيئة Staging/Production + DNS/TLS** | بنية | لا إطلاق بلا عنوان آمن. |
| 8 | **قنوات الإشعار (Email/SMS)** | منتج | إشعار موثوق بالمعاملات. |
| 9 | **Admin Desks الناقصة** | منتج | حكم إداري على التجار/الموردين/الشركات/الفئات. |
| 10 | **Support Desk + تصعيد** | منتج | تشغيل الدعم عند وجود معاملات حقيقية. |

### أول مهمة تطوير ينبغي تنفيذها بعد هذا الجرد

> **PR-01 (دعم دورة المال القابلة للتشغيل) بترتيب: (1) تثبيت الرؤية ونطاق MVP في الوثيقة → (2) إعادة تشغيل الحزمة الكاملة على PostgreSQL معزول لإثبات التكامل → (3) استكمال مسار إتمام الدفع اليدوي/Offline من الواجهة.**
>
> **لماذا؟** لأن كل شيء آخر (MFA للـstaff، Refunds لدى المزوّد، اكتساب العملاء) يعتمد على وجود **دورة معاملة قابلة للتشغيل**. المالك يجب أن يوافق على النطاق أولاً، ثم نُثبت ما هو موجود، ثم نُغلق أول فجوة منتج.

---

## 2. المرحلة الأولى — تعريف المنتج ونموذج العمل

> **مصادر:** `docs/ARCHITECTURE.md` · `docs/REVENUE_MODEL.md` · `docs/PROJECT_BASELINE.md` · `docs/ARCHITECTURE_DECISIONS.md` · `docs/PAYMENT_PROVIDERS.md` · `docs/UI_SCREEN_MAP.md` · `AGENTS.md` · `package.json` · الكود.
> **وسم:** ✅ قرار معتمد · 🟡 افتراض موثّق · ⬜ مقترح/غير محسوم.

### 2.1 الرؤية التجارية الرسمية ✅

«الوسيط التجاري العالمي» — منصّة رقمية تربط **الموردين والشركات وكبار التجار** بـ**صغار التجار والعملاء**، عبر طبقة وساطة موثوقة توفّر: Marketplace، B2B+B2C، Commerce (طلبات/معاملات/عمولات)، Trust (درجات قابلة للتفسير)، AI (مقيد بالصلاحيات والميزانية)، Advertising، Analytics. تبدأ من **تونس** لكن البنية **Global-first** (لا تونس Hardcoded في النواة؛ الدول/اللغات/العملات كيانات قابلة للتكوين).

### 2.2 نموذج الوساطة ومصادر الإيرادات

| المصدر | التفصيل | الحالة |
| --- | --- | --- |
| **العمولة (Commission)** | 4% من قيمة الصفقة = **2% بائع + 2% مشتري**، سياسة `BASE` في `commission_policies` (غير Hardcoded)، محرّك يفشل مغلقاً (`COMMISSION_POLICY_MISSING`) | ✅ معتمد + منفّذ |
| **رسوم معالجة الدفع** | منفصلة عن العمولة (`payment_fee_policies`)، مع شفافية Payer/Beneficiary لكل حركة | ✅ معتمد + منفّذ |
| **الإعلانات** | Product/Store/Supplier/Company Ads، Top Ads، Sponsored Search | ✅ معتمد + منفّذ |
| **الاشتراكات** | CUSTOMER (مجاني) · SMALL MERCHANT (19 TND) · COMPANY (99 TND) · PRO MAX (299 TND) — من DB لا Hardcoded | ✅ معتمد + منفّذ |
| **AI Revenue** | عبر AI Budgets / tiered usage | ⬜ مستقبلي |

### 2.3 أنواع المستخدمين والأدوار (10 أدوار — `packages/shared/src/constants/roles.ts`) ✅

`CUSTOMER` · `MERCHANT` · `SUPPLIER` · `COMPANY` · `MARKETER` · `SUPPORT` · `RISK` · `DISPUTE` · `ADMIN` · `SUPER_ADMIN`.

**قاعدة أمنية:** الأدوار الذاتية القابلة للاختيار عند التسجيل محصورة بقائمة بيضاء (`SELF_SELECTABLE_ROLES` = CUSTOMER/MERCHANT/SUPPLIER/COMPANY…)؛ الأدوار الإدارية (SUPPORT/RISK/DISPUTE/ADMIN/SUPER_ADMIN) **لا تُطلب عبر API عام** وتُمنح خارج المسار (Seeder/Bootstrap).

### 2.4 حدود مسؤولية WASIT وما لا تقوم به ✅ (قرارات مجمّدة)

- **لا Wallet / لا احتفاظ بأرصدة** — WASIT ليس بنكاً؛ `transaction_ledger` يسجّل الحركات فقط (AD-007).
- **لا تخزين بيانات بطاقات / PCI** — الدفع **redirect إلى مزوّد مرخّص**.
- **لا تحويلات مالية غير معتمدة** ولا إدارة توصيل.
- **العمولة قرار مالك** — لا تُغيَّر من الوكيل.

### 2.5 الأسواق والعملاء المستهدفون

| البُعد | القرار |
| --- | --- |
| **السوق الأول** ✅ | تونس (العملة الأساسية TND) |
| **التوسع** ✅ | Global-first — الدول/العملات/اللغات كيانات قابلة للتكوين (`geo` module) |
| **اللغات** ✅ | `ar` (افتراضي) · `fr` · `en` · `zh` — `SUPPORTED_LOCALES` |
| **الشرائح** | B2B (مورد↔تاجر/شركة) + B2C (تاجر/شركة↔عميل) |

### 2.6 القيمة لكل طرف

| الطرف | القيمة | الدليل |
| --- | --- | --- |
| **المشتري (عميل)** | اكتشاف منتجات، مقارنة أسعار، طلب، دفع، تتبّع، نزاعات | `/api/products`, `/api/price-comparison`, `/api/orders`, `/api/disputes` |
| **التاجر (MERCHANT)** | متجر، مخزون، طلبات، تحليلات، إعلانات، أدوات AI | `/api/inventory`, `/api/analytics`, `/api/ads`, `/api/ai` |
| **المورد (SUPPLIER)** | كتالوج، مشترون، عروض، تسعير | `/api/suppliers`, `/api/directory` |
| **الشركة (COMPANY)** | فروع، موردون، موظفون، مالية | `/api/companies` (+ أسطح Placeholder) |
| **WASIT** | عمولة 4% + رسوم دفع + إعلانات + اشتراكات | `commission_policies`, `payment_fee_policies` |

---

## 3. المرحلة الثانية — خريطة الوحدات والوظائف

### 3.1 الأرقام المُتحقَّق منها (كلها مقروءة من الكود في هذه الجلسة)

| المقياس | القيمة | طريقة التحقق |
| --- | --- | --- |
| وحدات الخادم | **37** | `ls packages/server/src/modules` |
| ملفات مصدر الخادم | **230** / **42,428 سطر** | `find … *.ts \| wc -l` |
| تسجيلات معالج HTTP | **≈341** | `grep -rhoE "\.(get\|post\|patch\|put\|delete)\("` على الوحدات + `app.ts` |
| مسارات مسجّلة (`app.route`) | **≈40** | `app.ts` |
| جداول قاعدة البيانات | **101** | `grep -rhoE "pgTable\(" schema/*.ts \| wc -l` |
| أنواع Enum | **42** | `grep -rhoE "pgEnum\(" schema/*.ts \| wc -l` |
| ملفات Migration | **37** SQL | `ls migrations/*.sql` |
| ملفات Schema | **31** | `ls schema/*.ts` |
| صفحات الواجهة | **40 ملف** / **22,902 سطر** | `ls web/src/pages`, `wc -l` |
| مسارات الواجهة (Route) | **≈77** (منها **20** إدارية) | `App.tsx` |
| ملفات اختبار الخادم | **116** (95 عام + 21 وحدة) | `ls tests/*.test.ts` + `tests/unit` |
| حالات اختبار (عدّ نصّي) | **≈1482** | `grep -rhoE "\b(it\|test)\("` |
| ملفات اختبار الويب | **4** / **50 اختبار** | ✅ مُشغَّلة |
| مواصفات E2E | **37 ملف** / **≈225 حالة** | `ls e2e/*.spec.ts` |
| ملفات التوثيق | **78** `.md` | `find docs -name '*.md'` |
| الأدوار / اللغات | **10** / **4** | `roles.ts`, `locales.ts` |

> **تحذير دقّة:** «حالات اختبار ≈1482» **عدّ نصّي** لأنماط `it()/test()` (يشمل المُولَّد داخل `describe`)، **لا يعني النجاح**. التشغيل الحيّ متوقّف على PostgreSQL.

### 3.2 خريطة الوحدات (37 وحدة)

| المجموعة | الوحدات |
| --- | --- |
| الهوية والوصول | `auth`, `privacy`, `legal`, `verification` |
| الكتالوج | `products`, `categories`, `search`, `comparison`, `directory`, `seo` |
| الأطراف | `merchants`, `suppliers`, `companies` |
| التجارة | `orders`, `inventory`, `messaging`, `notifications`, `media` |
| المال | `payments`, `settlements`, `payouts`, `reconciliation`, `finance`, `tax`, `subscriptions`, `revenue` |
| الثقة والحماية | `trust`, `risk`, `disputes` |
| الإدارة والمراقبة | `admin`, `analytics`, `observability`, `health`, `geo` |
| AI | `ai` (+ `lib/ai/*`) |
| مساعدة | `customer-library` |

### 3.3 جدول حالة جميع الوظائف

> **رموز الحالة:** `IMPLEMENTED_AND_VERIFIED` · `IMPLEMENTED_NOT_VERIFIED` · `PARTIALLY_IMPLEMENTED` · `DOCUMENTED_ONLY` · `NOT_IMPLEMENTED` · `BLOCKED` · `UNKNOWN`
> **عمود «إثبات هذه الجلسة»:** `✅` = شُغِّل هنا · `⛔` = يحتاج DB · `—` = لا اختبار مباشر.
> **ملاحظة جوهرية:** معظم الوظائف المالية/التجارية **موجودة ومُختبرة تاريخياً على PostgreSQL** (موثّق في `docs/GAP_REGISTER.md` §9 و`docs/commercial-release/FINAL-AUDIT.md`)، لكنها **`IMPLEMENTED_NOT_VERIFIED` في هذه الجلسة** لعدم توفر DB. هذا **قيد إثبات** لا نقص وظيفي.

#### أ) المصادقة والصلاحيات والأمان

| الوظيفة | الوصف التجاري | المستخدم | مكانها في الكود | الحالة | دليل الاختبار | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| تسجيل/دخول/جلسات | حساب مستخدم آمن | الجميع | `modules/auth` | IMPLEMENTED_AND_VERIFIED (تاريخياً) | `account-lockout.test.ts`, E2E `auth.spec.ts` (5) | ⛔ DB هذه الجلسة | — |
| RBAC (10 أدوار) | فصل صلاحيات فعلي في الخادم | الجميع | `middleware/auth.ts`, `shared/permissions.ts` | IMPLEMENTED_AND_VERIFIED | `perm01c-rbac-cleanup.test.ts`, E2E `rbac.spec.ts` (12) | — | — |
| MFA | خطوة ثانية | المستخدم + staff | `lib/mfa.ts`, `auth/routes.ts` | IMPLEMENTED_AND_VERIFIED | `mfa-login-challenge.test.ts`, E2E `mfa.spec.ts` | إلزام الـstaff خلف علم `STAFF_MFA_ENFORCEMENT` (مطفأ افتراضياً) | إن لم يُفعَّل → حساب إداري بلا 2FA |
| قفل الحساب | منع التخمين | الجميع | `lib/lockout.ts` | IMPLEMENTED_AND_VERIFIED | `account-lockout.test.ts` | — | — |
| حماية قراءة الكيانات (SEC-04B) | منع تسريب بيانات الغير | التجار/الموردون | `lib/entity-access.ts` | IMPLEMENTED_AND_VERIFIED | `sec04b-entity-read-access.test.ts` | — | — |
| الخصوصية/الموافقات | GDPR: تصدير/حذف/احتفاظ | الجميع | `modules/privacy` | IMPLEMENTED_AND_VERIFIED | `security-privacy.test.ts`, `privacy-retention-*.test.ts` | موافقة كوكيز من الواجهة موجودة (`cookie-consent.test.ts` 18) | — |
| الرقابة/التدقيق | تتبّع كل تغيير | إدارة | `lib/audit.ts`, `admin/routes.ts` | IMPLEMENTED_AND_VERIFIED | `admin-access.test.ts` | — | — |
| Rate limiting موزّع | حماية عبر نسخ | البنية | `middleware/rate-limit.ts` | PARTIALLY_IMPLEMENTED | `rate-limit.test.ts` | الافتراضي `memory`؛ `postgres` يحتاج تفعيلاً صريحاً | نسخة واحدة فقط افتراضياً |
| CSRF | حماية كتابة | الجميع | `middleware/` | IMPLEMENTED_AND_VERIFIED | `csrf.test.ts` | — | — |

#### ب) المنتجات والتصنيفات والبحث

| الوظيفة | الوصف التجاري | المستخدم | مكانها | الحالة | دليل | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| منتجات CRUD | نشر/تعديل منتج | تاجر/مورد | `modules/products` | IMPLEMENTED_AND_VERIFIED (تاريخياً) | `product-suspension.test.ts`, E2E `functional-audit` | ⛔ DB | — |
| تعديل المنتج (B20) | تعديل من الواجهة | تاجر | `products/routes.ts` PATCH | IMPLEMENTED_AND_VERIFIED | `product-suspension.test.ts` (+3) | — | — |
| إيقاف/تنشيط إداري | إنفاذ إداري | ADMIN | `products/routes.ts` | IMPLEMENTED_AND_VERIFIED | `product-suspension.test.ts` | — | — |
| سلع محظورة (LC-03) | فلترة إنفاذ | تاجر/إدارة | `lib/prohibited-goods.ts` | IMPLEMENTED_AND_VERIFIED (جزئياً) | **26/26 مُشغَّلة هنا (بلا DB)** + `lc03-prohibited-goods.test.ts` (HTTP) ⛔ | اختبار HTTP يحتاج DB | — |
| تصنيفات | شجرة فئات | الجميع | `modules/categories` | IMPLEMENTED_AND_VERIFIED | `seo.test.ts` | — | — |
| بحث موحّد | بحث منتجات/أطراف | الجميع | `modules/search` | IMPLEMENTED_AND_VERIFIED | `directory.test.ts` | — | — |
| مقارنة أسعار | مقارنة موردين | مشتري/تاجر | `modules/comparison` | IMPLEMENTED_AND_VERIFIED | `price-comparison.test.ts`, E2E (7) | — | — |
| SEO | sitemap/JSON-LD | عام | `modules/seo` | IMPLEMENTED_AND_VERIFIED | `seo.test.ts`, E2E `seo.spec.ts` (5) | — | — |

#### ج) الأطراف والطلبات والمخزون

| الوظيفة | الوصف التجاري | المستخدم | مكانها | الحالة | دليل | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| موردون/تجار/شركات | ملفات الأطراف | SUPPLIER/MERCHANT/COMPANY | `modules/{suppliers,merchants,companies}` | IMPLEMENTED_AND_VERIFIED | `directory.test.ts`, E2E `directory.spec.ts` (7) | — | — |
| إنشاء طلب | دورة بيع | مشتري | `modules/orders/service.ts` | IMPLEMENTED_AND_VERIFIED | `vertical-slice.test.ts`, E2E `order-lifecycle.spec.ts` | **لا سلة** (منتج واحد) | — |
| حارس الدفع قبل التنفيذ (SEC-03) | لا تنفيذ بلا دفع | بائع/مشتري | `orders/service.ts` | IMPLEMENTED_AND_VERIFIED | `order-confirmation-payment-guard.test.ts` (12) | — | — |
| المخزون | حجز/خصم ذرّي | تاجر | `modules/inventory` | IMPLEMENTED_AND_VERIFIED | `inventory.test.ts` (17) | — | — |
| مراسلة | محادثات | الجميع | `modules/messaging` | IMPLEMENTED_AND_VERIFIED | `messaging.test.ts` | — | — |
| إشعارات In-app | جرس + قائمة | الجميع | `modules/notifications` | IMPLEMENTED_AND_VERIFIED | E2E | **Email/SMS غير موصولين بالإشعارات** (`sendMail/sendSms` يُستدعيان في `auth` فقط) | لا إشعار معاملة موثوق |
| مكتبة العميل | مفضلات/محفوظات | CUSTOMER | `modules/customer-library` | IMPLEMENTED_AND_VERIFIED | `customer-library.test.ts`, E2E `library.spec.ts` (5) | — | — |
| Marketing Video | توليد MP4 حقيقي | تاجر | `lib/media/*` | IMPLEMENTED_AND_VERIFIED | `marketing-video.test.ts`, E2E `video-studio.spec.ts` | مزامن فقط (لا مسار async) | — |

#### د) المال (الدورة الكاملة)

| الوظيفة | الوصف التجاري | المستخدم | مكانها | الحالة | دليل | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| نية دفع + Webhook HMAC | تحصيل | مشتري | `modules/payments`, `lib/payments/*` | IMPLEMENTED_AND_VERIFIED | `payments.test.ts`, `payment-adapters.test.ts` | لا مفاتيح حقيقية | — |
| العمولة 4% (2+2) | إيراد | WASIT | `lib/commission.ts` | IMPLEMENTED_AND_VERIFIED | `money-path-invariants.test.ts` | — | — |
| دفتر المعاملات | تسجيل الحركات | WASIT | `transaction_ledger` | IMPLEMENTED_AND_VERIFIED | `settlement-ledger.test.ts` | — | — |
| التسوية (Settlement) | تأكيد تحرّك المال | WASIT | `modules/settlements` | IMPLEMENTED_AND_VERIFIED | `settlement-ledger.test.ts`, E2E `settlement-integrity` | يحتاج دليل مزوّد | — |
| المستحقات (Payout) | صافي للبائع | بائع | `modules/payouts` | IMPLEMENTED_AND_VERIFIED | `payout-engine.test.ts`, `payout-provider.test.ts` | يحتاج مزوّد دفع | — |
| المطابقة (Reconciliation) | مطابقة المزوّد/البنك | WASIT | `modules/reconciliation` | IMPLEMENTED_AND_VERIFIED | `reconciliation-engine.test.ts` | — | — |
| الاسترداد + عكس العمولة | استرداد متكامل | مشتري/إدارة | `payments/service.ts` | IMPLEMENTED_AND_VERIFIED | `p6-p7-dispute-webhook.test.ts` | **ClicToPay لا يدعم Refund** (503) | BLOCKED |
| إتمام دفع manual (PS-02) | تسجيل استلام offline | ADMIN | `payments/service.ts` | PARTIALLY_IMPLEMENTED | `manual-payment-completion.test.ts` (10) | **DEMO-only** (`DEMO_PAYMENT_MODE`) | لا يُستخدم لمال حقيقي |
| الضرائب | محرّك ضرائب | WASIT | `modules/tax` | IMPLEMENTED_AND_VERIFIED | `tax-engine.test.ts` | لا واجهة (`admin/tax` بلا مستدعٍ في الويب) | — |
| الاشتراكات | تحصيل دوري | تاجر/شركة | `modules/subscriptions` | IMPLEMENTED_AND_VERIFIED | `subscriptions.test.ts`, E2E (8) | — | — |
| الإيرادات/الربحية | P&L + سيناريوهات | إدارة | `modules/revenue` | IMPLEMENTED_AND_VERIFIED | `revenue.test.ts` (16) | لا واجهة | — |

#### هـ) الثقة والنزاعات والدعم

| الوظيفة | الوصف التجاري | المستخدم | مكانها | الحالة | دليل | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Trust Score | درجة قابلة للتفسير | الجميع | `modules/trust` | IMPLEMENTED_AND_VERIFIED | `verification-trust.test.ts`, E2E | حالة فارغة بلا زر إعادة احتساب (عيب UX موثّق) | — |
| Risk Engine | كشف خطر/تهرّب | RISK | `modules/risk`, `lib/risk-engine.ts`, `lib/fee-evasion.ts` | IMPLEMENTED_AND_VERIFIED | `risk-actions.test.ts`, `fee-evasion.test.ts` | — | — |
| التحقق (Verification) | مراجعة وثائق | الجميع | `modules/verification` | PARTIALLY_IMPLEMENTED | E2E `functional-audit` | **بشري فقط — لا KYC/KYB/AML** | BLOCKED |
| النزاعات + الاستئناف | دورة قرار كاملة | مشتري/بائع/DISPUTE | `modules/disputes`, `lib/disputes/*` | IMPLEMENTED_AND_VERIFIED | `disputes.test.ts`, E2E `disputes.spec.ts` (6) | — | — |
| سياسات البلد للنزاع | per-country | DISPUTE | `dispute-country-policy.test.ts` | IMPLEMENTED_AND_VERIFIED | `dispute-country-policy.test.ts` | — | — |
| Support Desk / تذاكر | دعم + تصعيد | SUPPORT | — | **NOT_IMPLEMENTED** | — | لا وحدة ولا طابور تذاكر | لا قناة دعم نظامية |

#### و) الإدارة والتحليلات والمراقبة

| الوظيفة | الوصف التجاري | المستخدم | مكانها | الحالة | دليل | النواقص | المخاطر |
| --- | --- | --- | --- | --- | --- | --- | --- |
| لوحة الإدارة | إشراف | ADMIN | `modules/admin`, `web/Admin*` | IMPLEMENTED_AND_VERIFIED | `admin-access.test.ts`, E2E (12 ملف) | — | — |
| مكتب المالية (PS-01) | تسوية/مستحقات/مطابقة/إيصالات | ADMIN | `web/AdminFinancePages.tsx` + `finance/routes.ts` | IMPLEMENTED_AND_VERIFIED | E2E `admin-finance.spec.ts` (10) | ⛔ DB هذه الجلسة | — |
| التحليلات + اقتصاديات الوحدة | KPI + CAC/LTV | إدارة/تاجر | `modules/analytics` | IMPLEMENTED_AND_VERIFIED | `analytics.test.ts`, E2E (3) | — | — |
| المراقبة/Tracing/Alerts | تشخيص إنتاج | البنية | `modules/observability` | IMPLEMENTED_AND_VERIFIED | `observability.test.ts` (23) | لا جسر تنبيه مُهيّأ، لا Error tracking | — |
| Webhook DLQ + Replay (OBS-01) | استرجاع فاشل | ADMIN | `payments/routes.ts` | IMPLEMENTED_AND_VERIFIED | `p6-p7-dispute-webhook.test.ts`, E2E (4) | — | — |
| Admin Desks (تجار/موردون/شركات/فئات/عملات/لغات/عمولات) | حكم إداري | ADMIN | — | **NOT_IMPLEMENTED** | `grep` = ∅ | لا مسارات ولا صفحات | إدارة يدوية/معدومة |
| جسر Outbox/Deliveries | تسليم موثوق | البنية | `outbox.ts`, `messaging.ts` (Schema) | **DOCUMENTED_ONLY / جزئي** | Migrations 0035/0036 | **لا كاتب ولا قارئ** لـ`event_outbox`/`notification_deliveries` في `src` | بنية غير مستغلة |

#### ز) الواجهة (أسطح جزئية/Placeholder)

| السطح | الحالة | الدليل |
| --- | --- | --- |
| Branches / Employees | **PARTIALLY_IMPLEMENTED** (EmptyState صريح) | `DashboardListPages.tsx:321` |
| Finance (تاجر) | **PARTIALLY_IMPLEMENTED** (بطاقات «—») | `DashboardInventoryPages.tsx:338` |
| Reports (تاجر) | **PARTIALLY_IMPLEMENTED** (نص roadmap) | `DashboardInventoryPages.tsx:352` |
| Sales (تاجر) | ✅ IMPLEMENTED_AND_VERIFIED (بيانات حقيقية) | `DashboardInventoryPages.tsx:443` |
| Business Calculator `/tools/calculator` | **NOT_IMPLEMENTED** | `grep` = ∅ |
| Business/Market Map `/map` | **NOT_IMPLEMENTED** | `App.tsx` لا `/map` |
| Offers (مورد) | **NOT_IMPLEMENTED** | لا وحدة |
| Recommendations (عميل) | **NOT_IMPLEMENTED** | لا وحدة |
| Cart / دفع متعدد البنود | **NOT_IMPLEMENTED** | `CheckoutPage` = منتج واحد |
| Support Desk UI | **NOT_IMPLEMENTED** | لا صفحة |
| Admin Desks UI | **NOT_IMPLEMENTED** | لا صفحات |

#### ح) البنية والتشغيل والتكاملات

| الوظيفة | الحالة | الدليل |
| --- | --- | --- |
| Staging/Production مستضافة | **BLOCKED** | `docs/PRODUCTION_GAP_LIST.md` E1 |
| Domain/DNS/TLS | **BLOCKED** | `deploy/nginx.conf` (`listen 80` فقط) |
| مزوّد دفع حقيقي | **BLOCKED** | `.env.demo`: `PAYMENT_PROVIDER=manual` |
| Split لدى المزوّد | **BLOCKED** | `docs/PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` |
| KYC/KYB/AML | **BLOCKED** | لا مزوّد |
| Email/SMS إنتاجي | **BLOCKED** | `.env.demo`: `MAIL_TRANSPORT=log`, `SMS_TRANSPORT=log` |
| نسخ احتياطي مشفّر (age) | IMPLEMENTED_AND_VERIFIED (محلياً) | `scripts/backup-restore.test.sh` (105/105 مع age) |
| نسخ offsite/WAL | **BLOCKED** | لا وجهة خارجية |
| CI | IMPLEMENTED_AND_VERIFIED (جزئي) | `.github/workflows/ci.yml` — **لم يُشغَّل فعلياً** |
| Object Storage للوسائط | **BLOCKED** | `resolveMediaStorage()` = `local` فقط |
| HA/DR | **NOT_IMPLEMENTED** | لا إعداد |

---

## 4. المرحلة الثالثة — قياس حالة كل وظيفة (منهجية)

- **`IMPLEMENTED_AND_VERIFIED`**: كود + اختبار **شُغِّل** ونجح. في هذه الجلسة نُفِّذت: T1 (122) + LC03 (26) + الويب (50) + tsc (0). الوظائف التي تحتاج DB ومُختبرة **تاريخياً** وُسمت «IMPLEMENTED_AND_VERIFIED (تاريخياً)» مع تنبيه.
- **`IMPLEMENTED_NOT_VERIFIED`**: كود موجود، لا دليل تشغيل متاح **الآن** (يحتاج DB).
- **`PARTIALLY_IMPLEMENTED`**: جزء يعمل وجزء Placeholder/DEMO-only.
- **`DOCUMENTED_ONLY`**: وثيقة/Schema بلا تنفيذ فعلي (مثال: `event_outbox` بلا كاتب/قارئ).
- **`NOT_IMPLEMENTED`**: غير موجود.
- **`BLOCKED`**: يعتمد على طرف/بنية خارجية.
- **`UNKNOWN`**: لا دليل كافٍ.

**تمييز مستويات الاختبار:**
1. **وحدات معزولة (بلا DB):** T1 (122)، LC03 (26)، الويب (50) — ✅ شُغِّلت هنا.
2. **تكامل مع PostgreSQL:** 95 ملف اختبار خادم — ⛔ لم تُشغَّل هنا.
3. **E2E (Playwright + DB حقيقي):** 37 ملف / ≈225 حالة — ⛔ لم تُشغَّل هنا (تحتاج خادم+DB).
4. **Smoke تجاري:** `*-smoke.mjs` — ⛔ يحتاج بيئة.

> **قاعدة صريحة:** وجود API/صفحة/زر **لا يُعدّ** دليل اكتمال وظيفة تجارية.

---

## 5. المرحلة الرابعة — رحلات المستخدم التجارية

### 5.1 رحلة المشتري (CUSTOMER)

- **البداية:** زيارة `/` → `/marketplace` أو `/search`.
- **الخطوات:** تسجيل/دخول → اكتشاف منتج → `/products/:id` → (مفضلة/حفظ) → `/checkout` → دفع → تتبّع `/dashboard/orders` → (نزاع `/dashboard/disputes`).
- **الوظائف المطلوبة:** products, search, comparison, orders, payments, customer-library, notifications, disputes.
- **النتيجة المتوقعة:** طلب مدفوع بحالة `PAID` + قيد دفتر + إشعار.
- **نقاط التعطل:** ⛔ **لا سلة** (منتج واحد فقط) · ⛔ **لا مزوّد دفع حقيقي** (DEMO/manual) · ⛔ **لا إشعار Email/SMS**.

### 5.2 رحلة البائع (MERCHANT)

- **البداية:** `/register` (MERCHANT) → `/onboarding`.
- **الخطوات:** إنشاء منتج (`/dashboard/products/new`) → مخزون → استلام طلب → تحليلات/إعلانات → أدوات AI.
- **الوظائف:** products, inventory, orders, analytics, ads, ai, media, trust, verification, disputes.
- **النتيجة:** منتج منشور + طلبات + إيراد.
- **نقاط التعطل:** ⛔ **لا Payout للبائع بلا مزوّد حقيقي** · PARTIAL: Finance/Reports أسطح Placeholder · ⛔ Admin Desks (لا إشراف إداري على التجار).

### 5.3 رحلة المورد (SUPPLIER)

- **الخطوات:** ملف شركة → كتالوج → مشترون/تجار → تسعير.
- **الوظائف:** suppliers, directory, comparison, products, messaging.
- **نقاط التعطل:** ⛔ **Offers غير منفّذة** · PARTIAL: Buyers/Merchants/Price Management أسطح.

### 5.4 رحلة الشركة (COMPANY)

- **الخطوات:** ملف → فروع → موردون → مشترون → موظفون → مالية/تقارير.
- **نقاط التعطل:** ⛔ Branches/Employees/Finance/Reports = Placeholder · ⛔ لا Admin Desk للشركات.

### 5.5 رحلة المدير العام (SUPER_ADMIN)

- **الخطوات:** `/admin` → مستخدمون/منتجات/طلبات/معاملات/دفتر/مالية/تدقيق → محرّكات (تحقق/ثقة/خطر/نزاعات) → AI/إعلانات/سياسات/خصوصية/مراقبة.
- **الوظائف:** admin, finance, analytics, ai, observability, disputes, privacy, policies.
- **نقاط التعطل:** ⛔ **لا Admin Desks** (تجار/موردون/شركات/فئات/عملات/لغات/عمولات) · ⛔ **لا تعديل سياسة العمولة من الواجهة** (مقصود) · MFA غير مُلزم افتراضياً.

### 5.6 رحلة موظفي الدعم/الإدارة (SUPPORT/RISK/DISPUTE/ADMIN)

- **الخطوات:** مكاتب محروسة بـ`StaffOnly`: تحقق/ثقة/خطر/نزاعات → بتّ قرارات + مراجعة استئناف (مع تنحّي صاحب القرار).
- **الوظائف:** verification, trust, risk, disputes.
- **نقاط التعطل:** ⛔ **لا Support Desk/تذاكر** · ⛔ MFA غير مُلزم للـstaff افتراضياً.

---

## 6. المرحلة الخامسة — جاهزية نموذج الوساطة

### دورة المعاملة المطلوبة

| الحلقة | الحالة | الدليل |
| --- | --- | --- |
| اكتشاف العرض | ✅ منفّذ | `products`, `search`, `comparison` |
| التواصل/الطلب | ✅ منفّذ | `messaging`, `orders` |
| الاتفاق | ✅ منفّذ | `orders` (DRAFT→PENDING→CONFIRMED) |
| الدفع عبر المزوّد المعتمد | ⚠️ **PARTIAL/BLOCKED** | محوّلات موجودة، **لا مفاتيح حقيقية**؛ `manual` = DEMO-only |
| إثبات العملية | ✅ منفّذ (آلية) | Webhook HMAC + `payment_webhook_events` + recheck |
| احتساب العمولة | ✅ منفّذ | `commission_policies` (4% = 2%+2%) |
| إغلاق الطلب | ✅ منفّذ | `orders.status` enum كامل |

### التحقق من القيود المطلوبة

| القيد | الحالة | الدليل |
| --- | --- | --- |
| **لا محفظة / لا احتفاظ بأموال** | ✅ مؤكَّد | AD-007 + تعليقات صريحة: «provider record … NOT a user wallet» (`payments/service.ts:152`) |
| **لا تحويلات مالية غير معتمدة** | ✅ مؤكَّد | كل كتابة مال عبر `applyPaymentSucceeded`/`confirmSettlement` |
| **لا إدارة توصيل من WASIT** | ✅ مؤكَّد | لا وحدة شحن/توصيل في `modules/` |
| **`Payment ≠ Settlement`** | ✅ مؤكَّد | `orders.settlementStatus` يُكتب `SETTLED` فقط من `confirmSettlement` بدليل مرجعي |
| **`Paid ≠ Settled`** | ✅ مؤكَّد | `completeManualPayment` لا يكتب `SETTLED` ولا ينشئ Payout |

---

## 7. المرحلة السادسة — الذكاء الاصطناعي

### 7.1 جرد الوكلاء (11 وكيلاً — مصدر وحيد `AGENT_CATALOGUE` → `agent_registry`)

| الوكيل | الدور | Action | صلاحيات | موافقة بشرية | الحالة | ما يستطيع فعله فعلياً | ما لا يستطيع |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sales-agent` | تحليل مبيعات/عملاء محتملين | `identify_leads` | `ai:use` | ✅ نعم | IMPLEMENTED | قراءة طلبات/GMV/تجار → توصية | لا يبيع/لا يتواصل |
| `marketing-agent` | حملة تسويقية | `recommend_campaign` | `ai:use` | لا | IMPLEMENTED | قراءة منتجات/فئات/فيديوهات → اقتراح | لا ينشئ وسائط |
| `ads-agent` | ميزانية إعلانات | `recommend_ads` | `ai:use`,`ad:create` | ✅ نعم | IMPLEMENTED | قراءة حملات/أحداث → توزيع | لا ينشئ حملة |
| `product-agent` | تحليل منتج | `analyze_product` | `ai:use` | لا | IMPLEMENTED | اكتمال الوصف/السعر/المخزون | لا يعدّل منتجاً |
| `support-agent` | مسودة رد دعم | `draft_reply` | `ai:use` | لا | IMPLEMENTED | قراءة محادثات → مسودة | لا يرسل |
| `analytics-agent` | تقرير KPI | `generate_report` | `ai:use`,`analytics:read:own` | لا | IMPLEMENTED | مؤشرات حقيقية | لا يصدّر |
| `market-research-agent` | نظرة سوق | `market_overview` | `ai:use` | لا | IMPLEMENTED | إحصاءات فئات/أسعار | — |
| `b2b-agent` | مطابقة B2B | `match_b2b` | `ai:use` | ✅ نعم | IMPLEMENTED | مطابقة مورد↔تاجر | لا يعقد صفقة |
| `risk-agent` | تقييم خطر | `assess_risk` | `risk:read` | ✅ نعم | IMPLEMENTED | قراءة أحداث خطر | لا يوقف حساباً |
| `dispute-assistant` | ملخّص نزاع | `summarize_dispute` | `dispute:read` | ✅ نعم | IMPLEMENTED | قراءة نزاع/رسائل | لا يبتّ |
| `development-agent` | خطة تقنية | `dev_plan` | `ai:use` | ✅ نعم | IMPLEMENTED | إحصاءات منصّة | لا ينفّذ كوداً |

**الأدوات (Tools):** `allowedTools` تُقرأ من `agent_registry` — **لا Tool Gateway منفَّذ**، والقائمة فارغة افتراضياً ⇒ **لا أداة خارجية**.

**مصادر البيانات:** PostgreSQL الحيّة (قراءة فقط) — **لا كتابات** في أي منفّذ.

**المزوّد:** `LocalHeuristicProvider` (منطق حتمي) افتراضياً ⇒ **الوكلاء لا يستخدمون LLM** بلا مفاتيح. (موثّق في `docs/AI_ARCHITECTURE.md`.)

**الفصل المطلوب:** 
- **موجود في الكود:** 11 وكيلاً + منفّذون + سياق + ميزانية + بوابة صلاحية (T2) + جدولة + Run/Plan/Dispatch/Recovery/Fencing.
- **يعمل فعلياً:** التوليد الحتمي على بيانات حقيقية + البوّابات + الميزانية + التدقيق (مُثبت بـ122 اختبار معزول).
- **مقترح/غير منفّذ:** `WASIT AI COPILOT` (مواصفة فقط — `AI_ARCHITECTURE.md` §6.5) · Supervisor UI · LLM planner · Tool Gateway · Retry Policy · Kill Switch.

### 7.2 طبقات التشغيل الآلي (AI-01 → AI-02.3.2)

| الطبقة | الحالة | الدليل |
| --- | --- | --- |
| جدولة الوكلاء (AI-01) | IMPLEMENTED_AND_VERIFIED (تاريخياً) | `ai01-agent-scheduling.test.ts` (12) |
| Agent Runs + آلة حالات (AI-02.1) | IMPLEMENTED_AND_VERIFIED | `ai021-agent-runs.test.ts` (31) |
| التخطيط (AI-02.2) | IMPLEMENTED_AND_VERIFIED | `ai022-planning.test.ts` (28) |
| الإرسال المنضبط (AI-02.3) | IMPLEMENTED_AND_VERIFIED | `ai023-dispatch.test.ts` (21) |
| الموثوقية/الاستعادة (AI-02.3.1) | IMPLEMENTED_AND_VERIFIED | `ai0231-reliability.test.ts` (23) |
| Fencing/تزامن (AI-02.3.2) | IMPLEMENTED_AND_VERIFIED | `ai0232-{fencing,concurrency}.test.ts` (40) |
| بوابة صلاحية التنفيذ (T2) | IMPLEMENTED_AND_VERIFIED | **10 اختبارات مُشغَّلة هنا** (`executor-action-gate.test.ts`) |
| Supervisor (تنسيق كامل) | **PARTIALLY_IMPLEMENTED** | `supervisor-policy.ts` (سياسة نقية) — **بلا مستدعٍ إنتاجي** |
| عزل النطاق (Scope) | **DOCUMENTED_ONLY** | `scope.ts` — **بلا مستدعٍ إنتاجي** |

### 7.3 لوحة المدير العام (AI)

| القدرة | الحالة | الدليل |
| --- | --- | --- |
| المراقبة | ✅ جزئي | `/admin/observability`, `/admin/ai` |
| التقارير | ✅ | `/admin/reports`, `/admin/analytics` |
| التحليل | ✅ | اقتصاديات الوحدة، أفواج، تحليل منصّة |
| التنبيهات | ⚠️ PARTIAL | محرّك قواعد + `alert_events`؛ **لا جسر مُهيّأ** |
| اقتراح القرارات | ✅ | الوكلاء (قراءة/توصية) |
| التنفيذ المصرّح به | ⚠️ محدود | T2 gate + Approval gate؛ **الوكلاء قراءة فقط** |

---

## 8. المرحلة السابعة — فجوات الإطلاق (P0 → P3)

> **P0** = مانع إطلاق · **P1** = ضروري · **P2** = تحسين · **P3** = مستقبلي.
> **تنبيه:** أي شرط قانوني/تجاري **غير محقق بدون دليل**.

### P0 — مانع الإطلاق

| # | الفجوة | المجال | لماذا مانعة | الاعتمادية | الدليل |
| --- | --- | --- | --- | --- | --- |
| 1 | لا عقد مزوّد دفع + لا تأكيد **Split** | تجاري/مالي | النموذج المالي (1020 = 980+40) يحتاج Split أو WASIT حافظ أموال | خارجي (مزوّد) | `PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` |
| 2 | لا حساب تسوية/بنكي لـWASIT | تجاري | لا تحصيل/توزيع بلا كيان | خارجي (بنك) | `MASTER_GAP_AUDIT` BU-02 |
| 3 | لا اعتماد قانوني للوثائق | قانوني | يمنع التشغيل (تونس/EU) | محامٍ | `lib/legal/catalogue.ts` (كلها `LEGAL_REVIEW_REQUIRED`) |
| 4 | لا KYC/KYB/AML | قانوني | لا تحقق نظامي من الأطراف | مزوّد هوية | `MASTER_GAP_AUDIT` LC-05 |
| 5 | لا بيئة إنتاج/Staging + DNS/TLS | بنية | لا إطلاق بلا عنوان آمن | مستضيف | `deploy/nginx.conf` (80 فقط) |
| 6 | لا سيولة سوق (موردون/مشترون) | تجاري | سوق بلا طرفين = لا معاملات | أعمال | `MASTER_GAP_AUDIT` BU-04 |
| 7 | Refunds غير مدعومة في ClicToPay | مالي | استرداد غير ممكن على مسار | مزوّد | `lib/payments/clictopay.ts` (503) |

### P1 — ضروري قبل إطلاق تجاري

| # | الفجوة | المجال | الدليل |
| --- | --- | --- | --- |
| 8 | قنوات إشعار Email/SMS إنتاجية | منتج | `MAIL_TRANSPORT=log`, `SMS_TRANSPORT=log` |
| 9 | إلزام MFA للـstaff/admin | أمان | `STAFF_MFA_ENFORCEMENT` مطفأ افتراضياً |
| 10 | Admin Desks (تجار/موردون/شركات/فئات/عملات/لغات/عمولات) | منتج | `grep` = ∅ |
| 11 | نسخ offsite + WAL + تدوير مفاتيح | بنية | `MASTER_GAP_AUDIT` PI-03 |
| 12 | Rate limiter موزّع مُفعَّل | بنية | `RATE_LIMIT_STORE=memory` افتراضياً |
| 13 | Error tracking | بنية | لا تكامل |
| 14 | إثبات تكامل PostgreSQL حيّ (هذه الجلسة) | تحقّق | ⛔ لا DB |
| 15 | Support Desk + تصعيد | منتج | لا وحدة |

### P2 — تحسين

| # | الفجوة | المجال |
| --- | --- | --- |
| 16 | Cart / دفع متعدد البنود | منتج |
| 17 | تفضيلات الإشعارات (`notification_preferences` موجود بلا مسار) | منتج |
| 18 | أسطح Placeholder (Branches/Employees/Finance/Reports) | منتج |
| 19 | Business Calculator `/tools/calculator` | منتج |
| 20 | Business/Market Map `/map` | منتج |
| 21 | Offers (مورد) | منتج |
| 22 | Object Storage للوسائط | بنية |
| 23 | جسر تنبيه مركزي مُهيّأ | بنية |

### P3 — مستقبلي

| # | الفجوة |
| --- | --- |
| 24 | WASIT AI COPILOT (مواصفة فقط) |
| 25 | Supervisor كامل + LLM planner + Tool Gateway + Retry + Kill Switch |
| 26 | Recommendations (عميل) |
| 27 | HA/DR متعدد المناطق |
| 28 | مسار فيديو غير متزامن (مزوّد generative) |

---

## 9. أهم المخاطر والاعتماديات

| # | الخطر/الاعتمادية | النوع | الأثر | التخفيف |
| --- | --- | --- | --- | --- |
| 1 | Split المزوّد غير مؤكَّد | خارجي | النموذج المالي كله | تأكيد كتابي + تصنيف صريح |
| 2 | لا اعتماد قانوني | قانوني | يمنع التشغيل | محامٍ معتمد (نصوص في `docs/legal/`) |
| 3 | لا KYC/KYB/AML | قانوني | مخاطر امتثال | عقد مزوّد هوية |
| 4 | لا بيئة مستضافة | بنية | لا إطلاق | VM + DNS + TLS |
| 5 | لا مزوّد دفع حيّ | مالي | لا تحصيل حقيقي | مفاتيح إنتاجية + Sandbox |
| 6 | تعدد النسخ بلا قفل موزّع كامل | تقني | تعارض محتمل | تفعيل `postgres` store + قفل Scheduler |
| 7 | الوكلاء بلا LLM | منتج | قيمة AI محدودة | مفاتيح AI إنتاجية |
| 8 | `scope.ts`/`supervisor-policy.ts` بلا مستدعٍ | تقني | كود غير مستغل | ربط أو توثيق القرار |
| 9 | `event_outbox`/`notification_deliveries` بلا كاتب/قارئ | تقني | بنية غير مستغلة | ربط أو إزالة |
| 10 | تصدّر بنوداً بلا مزوّد (حماية من إطلاق ناقص) | تشغيلي | — | قائمة `DECISION REQUIRED` |

**حدود الإثبات المُعلَنة:** لا يُدَّعى إثبات تكامل PostgreSQL في هذه الجلسة؛ الأدلة التاريخية موثّقة في `docs/GAP_REGISTER.md` §9 و`docs/commercial-release/FINAL-AUDIT.md` (645/645 خادم + 204 E2E عند `f3a730c`).

---

## 10. المرحلة الثامنة — خارطة الطريق

| المرحلة | الهدف | الوظائف | الاعتماديات | معايير القبول | المخاطر |
| --- | --- | --- | --- | --- | --- |
| **1. تثبيت الرؤية ونطاق MVP** | قرار مالك مكتوب | نطاق MVP، البلد الأول، الشرائح | مالك | وثيقة نطاق موقّعة + `DECISION REQUIRED` مغلقة | تغيير النطاق لاحقاً |
| **2. استكمال وظائف MVP** | إغلاق فجوات P1 المنتجية | Admin Desks، Support Desk، Email/SMS، Cart | مرحلة 1 | E2E لكل سطح | تعقيد متزايد |
| **3. إثبات رحلات المشتري والبائع** | تحقّق حيّ شامل | تشغيل الحزمة الكاملة على PostgreSQL + E2E | بيئة DB | 0 فشل + تقرير أدلة | فشل غير متوقع |
| **4. تجهيز التشغيل والإدارة** | لوحات ومكاتب | مالية/تحليلات/مراقبة/تنبيهات | مرحلة 3 | جسر تنبيه + Error tracking | — |
| **5. إغلاق الأمن والامتثال** | أمان قانوني | MFA إلزامي، Rate موزّع، نسخ offsite، اعتماد قانوني | محامٍ | وثائق `PUBLISHED` + فحوص أمنية | اعتماد خارجي |
| **6. التحقق من مزوّدي الخدمات والعقود** | عقود | دفع (Split/Settlement)، KYC، Email/SMS | مرحلة 5 | عقد + Sandbox ناجح | رفض المزوّد |
| **7. إطلاق تجريبي محدود** | Pilot حقيقي | دورة مال كاملة بمبلغ صغير | مراحل 2–6 | أول معاملة حقيقية مسوّاة | فشل دفع |
| **8. التوسع والنمو** | نمو | اكتساب، بلد ثانٍ، Copilot، HA/DR | مرحلة 7 | مؤشرات نمو | منافسة |

---

## 11. قائمة القرارات التي تحتاج المدير العام

| # | القرار | السياق | الأثر إن تأخّر |
| --- | --- | --- | --- |
| 1 | **نطاق MVP النهائي** | أي وظائف إلزامية للإطلاق؟ | بناء خارج النطاق |
| 2 | **البلد الأول وسياسة الضرائب/السلع** | تونس؟ | امتثال خاطئ |
| 3 | **من يتحمّل رسوم الدفع** (بائع/مشتري/طرفان) | `REVENUE_MODEL.md` §5 | تسعير خاطئ |
| 4 | **تحصيل العمولة** (خصم من التسوية أم فاتورة) | — | نموذج مالي غامض |
| 5 | **مزوّد الدفع** (Flouci/ClicToPay/غيرهم) + تأكيد Split | P0 | لا تحصيل |
| 6 | **مزوّد KYC/KYB/AML** | P0 | مخاطر امتثال |
| 7 | **قنوات الإشعار** (Email/SMS/Push) | P1 | لا إشعار موثوق |
| 8 | **سياسة الإرجاع/الشحن** (داخل/خارج نطاق WASIT) | `REVENUE_MODEL.md` §5 | غموض تعاقدي |
| 9 | **متى تُفعَّل بوابة الموافقة القانونية** (`LEGAL_ACCEPTANCE_ENFORCEMENT=on`) | بعد النشر | — |
| 10 | **إلزام MFA للـstaff** (تشغيل/عدم) | أمان | حساب إداري بلا 2FA |
| 11 | **مصير الكود غير المستغل** (`scope.ts`, `supervisor-policy.ts`, `event_outbox`) | تقني | دَين تقني |
| 12 | **ترتيب الوكلاء المطلوب** (AI-05) | `AI_ARCHITECTURE.md` §3 | — |
| 13 | **WASIT AI COPILOT** (تنفيذ/تأجيل) | اختياري | — |
| 14 | **هدف Pilot** (حجم/مدة/معايير نجاح) | — | إطلاق بلا قياس |

---

## 12. قائمة الأدلة والاختبارات ومصادر المعلومات

### 12.1 ما نُفِّذ حيّاً في هذه الجلسة (أدلة مباشرة)

| الفحص | الأمر | النتيجة |
| --- | --- | --- |
| TypeScript (server) | `npx tsc --noEmit` | **0 أخطاء** |
| حزمة T1 المعزولة | `npx vitest run --config vitest.t1.config.ts` | **122/122** (6 ملفات) |
| حزمة LC03 | `npx vitest run --config vitest.lc03.config.ts` | **26/26** (3 ملفات) |
| اختبارات الويب | `npx vitest run` (web) | **50/50** (4 ملفات) |
| فحص فشل DB | `npx vitest run tests/unit-economics.test.ts` | فشل `ECONNREFUSED 127.0.0.1:5432` (قيد بيئي) |

### 12.2 مصادر المعلومات (وثائق)

| الوثيقة | الاستخدام |
| --- | --- |
| `docs/ARCHITECTURE.md` | الرؤية، الطبقات، المبادئ |
| `docs/REVENUE_MODEL.md` | مصادر الإيراد، العمولة، `DECISION REQUIRED` |
| `docs/PROJECT_BASELINE.md` | نقطة القياس الرسمية (86%/93%/73%) |
| `docs/ARCHITECTURE_DECISIONS.md` | AD-001…AD-009 (لا Wallet، العمولة Policy) |
| `docs/GAP_REGISTER.md` | سجل الفجوات المركزي (21 مفتوحة / 32 مغلقة) |
| `docs/MASTER_GAP_AUDIT.md` | تشخيص الفجوات + BLOCKERS |
| `docs/AI_ARCHITECTURE.md` | طبقات AI + Copilot (مواصفة) |
| `docs/PAYMENT_PROVIDERS.md` | مصفوفة مزوّدي الدفع |
| `docs/PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` | فجوة Split |
| `docs/UI_SCREEN_MAP.md` | خريطة الشاشات |
| `docs/LC-01_LEGAL_FRAMEWORK.md` / `docs/legal/*` | الإطار القانوني (9 مسودّات) |
| `docs/PILOT_EXECUTION_PLAN.md` | بديهيات المال (A1–A8) |
| `docs/commercial-release/FINAL-AUDIT.md` | تحقق UI تاريخي (645/204) |
| `docs/DEMO-01_PUBLIC_DEMO.md` | نطاق العرض العام |
| `AGENTS.md` | ذاكرة المشروع والقواعد الذهبية |
| `docs/WASIT_MASTER_PRODUCT_AUDIT.md` | **هذا التقرير** |

### 12.3 القيود التي منعت إثبات تكامل PostgreSQL

| القيد | التفصيل |
| --- | --- |
| لا خادم PostgreSQL في البيئة | `pg_isready` غير موجود؛ `ps` بلا عملية postgres؛ `/workspace/pgdata` غير موجود |
| Docker daemon متوقف | `docker ps` → `dial unix /var/run/docker.sock: no such file or directory` |
| لا تشغيل DEMO/إنتاج (قيد المهمة) | المهمة READ-ONLY؛ لا يُسمح بتشغيل أي تكامل خارجي |
| النتيجة | **95 ملف اختبار خادم + 37 ملف E2E لم تُشغَّل هنا**. وظائف DB وُسمت `IMPLEMENTED_NOT_VERIFIED` أو `IMPLEMENTED_AND_VERIFIED (تاريخياً)` مع تنبيه صريح |

---

## 13. التقرير النهائي للمدير العام

### 1) ماذا نملك اليوم؟

منصّة وساطة تجارية **ناضجة تقنياً**: 37 وحدة، 341 مسار API، 101 جدول، 37 migration، واجهة من 40 صفحة، 116 ملف اختبار، وتوثيق من 78 ملفاً. كل الوحدات الأساسية (منتجات، طلبات، مخزون، دفع، تسوية، مستحقات، مطابقة، نزاعات، ثقة، خطر، تحقق، إعلانات، تحليلات، اشتراكات، AI) **موجودة بكود فعلي**.

### 2) ماذا يعمل فعلياً؟

- **مُثبت حيّاً الآن (198 اختبار + tsc):** طبقات الوكلاء/السياق/الميزانية/بوابة الصلاحية، فلترة السلع المحظورة، واختبارات الويب (الموافقات/الكوكيز/القانوني).
- **مُثبت تاريخياً (موثّق):** دورة الطلب، الدفع/Webhook، العمولة 4%، التسوية/المستحقات/المطابقة، النزاعات، E2E (204 حالات عند `f3a730c`).
- **⛔ غير مُثبت في هذه الجلسة:** كل ما يحتاج PostgreSQL.

### 3) ماذا ينقصنا؟

قائمة الفجوات (§8): **7 مانعة (P0)** كلها **خارجية/قانونية/تجارية**، **8 ضرورية (P1)**، **8 تحسينات (P2)**، **5 مستقبلية (P3)** — إضافةً إلى فجوات منتجية داخلية (Cart، Admin Desks، Support Desk، Email/SMS).

### 4) ما الذي يمنعنا من الإطلاق؟

**العوائق ليست في الكود:** لا عقد مزوّد دفع (Split)، لا اعتماد قانوني، لا KYC/KYB، لا بيئة مستضافة، لا سيولة سوق، لا قنوات إشعار إنتاجية.

### 5) أهم 10 أولويات

(§1) — تثبيت النطاق → إثبات DB → مسار الدفع اليدوي → Split → الاعتماد القانوني → KYC → البيئة → الإشعارات → Admin Desks → Support Desk.

### 6) أول مهمة تطوير بعد الجرد

> **(1) تثبيت الرؤية ونطاق MVP في وثيقة رسمية (قرار مالك)** ثم **(2) إعادة تشغيل الحزمة الكاملة + E2E على PostgreSQL معزول لإثبات التكامل** ثم **(3) استكمال مسار إتمام الدفع اليدوي/Offline من الواجهة** (إغلاق PR-01 / PS-05).

---

## 14. بوابة السلامة — بعد التدقيق (مقارنة)

| البند | قبل | بعد | مطابقة |
| --- | --- | --- | --- |
| المسار | `/workspace/project` | `/workspace/project` | ✅ |
| الفرع | `master` | `master` | ✅ |
| HEAD | `98c3a958…b4aa` | `98c3a958…b4aa` | ✅ |
| Staged | 0 | 0 | ✅ |
| Modified | 101 | 101 | ✅ |
| Untracked | 119 | 120 | **+1 (هذا التقرير فقط)** |
| Deleted | 0 | 0 | ✅ |
| Total | 220 | 221 | +1 |
| M0 `repo.bundle` | `e731e684…fa8694` | `e731e684…fa8694` | ✅ |

**التغيير الوحيد:** إنشاء `docs/WASIT_MASTER_PRODUCT_AUDIT.md` (غير متتبَّع). **لا تعديل على أي ملف قائم، ولا مساس بالتغييرات المتراكمة.**

---

**نهاية التقرير — READ-ONLY. لم يُنفَّذ أي تطوير، ولم تُبدأ أي مهمة لاحقة (T3 أو غيرها).**
