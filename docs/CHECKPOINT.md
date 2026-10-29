# CHECKPOINT — WASIT BUSINESS GLOBAL

آخر تحديث: **2026-10-29**

## Milestone PS-08A — منع تأكيد الطلب قبل إثبات الدفع (مغلق)

- **الفجوة**: كان `PATCH /api/orders/:id/status` يقبل `status='CONFIRMED'` دون أي فحص على `paymentStatus`. أي طلب غير مدفوع (حتى قبل إنشاء نيّة دفع) كان يمكن تأكيده، ما **يحوّل الحجز إلى بيع** ويخصم المخزون مقابل مالٍ لم يصل. (كانت التسوية `confirmSettlement` مُقادة بالدفع، أمّا التأكيد فلم يكن.)
- **الإصلاح**: بوابة مال في `modules/orders/service.ts:updateOrderStatus` — يُرفض `CONFIRMED` بـ**409 `CONFLICT`** ما لم يكن `orders.payment_status = 'PAID'`. و`PAID` لا يُكتب إلا من نواة الدفع (`applyPaymentSucceeded`) عن دليل موثَّق (webhook موقَّع، أو إتمام المكتب اليدوي لنيّة حقيقية — وهو نفسه مرفوض خارج الوضع التجريبي). لا يُشترط `paymentStatus` لأي انتقال آخر (`PROCESSING/SHIPPED/DELIVERED/COMPLETED/CANCELLED` تبقى كما هي).
- **الحماية**: الفحص **قبل** أي أثر جانبي على المخزون، فالتأكيد المرفوض لا يخصم كمية ولا يحرّر حجزًا ولا يكتب تدقيق تغيير حالة.
- **الاختبارات**: `packages/server/tests/order-confirmation-gate.test.ts` — **7 حالات** (رفض غير المدفوع بلا نيّة، رفض النيّة `PENDING`، نجاح المؤكَّد المدفوع + خصم المخزون، لا حركة مخزون/تدقيق عند الرفض، عدم تجاوز البوابة بأي دور، بقاء مسار العرض التوضيحي `complete-manual → PAID → CONFIRMED`، وبقاء `CANCELLED` بلا قيد دفع). حُدِّث `inventory.test.ts` (يدفع الطلب قبل التأكيد عبر النواة الحقيقية) و`e2e/order-lifecycle.spec.ts` (+حالة رفض 409، ودفع الطلب قبل تقدّم البائع).
- **التحقق**: حزمة الخادم **1074/1077** (3 متخطّاة)، `typecheck` (server+web) نظيف، و`e2e/order-lifecycle.spec.ts` (3/3) و`e2e/manual-payment.spec.ts` + `e2e/dispute-refund.spec.ts` (5/5) خضراء.

## Milestone N7 — استيراد ملفات المطابقة المالية (الملحق أ.5-1 — مغلق)

- **الفجوة**: تغذيات المطابقة كانت تُدخَل يدويًا كـJSON فقط (`POST /api/admin/finance/reconciliation/import`)؛ لا استيراد ملف. (كانت آخر بنود أ.5-1 المفتوحة.)
- **المحلّل النقي**: `packages/server/src/modules/reconciliation/file-import.ts` — `parseReconciliationFile()` يقبل **`.csv`/`.tsv`/`.json`** (UTF-8، ≤1 ميجابايت، ≤5000 صف)، مع RFC-4180 (اقتباس/`CRLF`/`BOM`)، تحقّق ترويسة/أعمدة (مطلوب/مجهول/مكرّر)، أرقام غير سالبة، مراجع فريدة غير صيغية، وعملة ISO. **أي سطر مخالف يرفض الملف بالكامل**.
- **الخدمة**: `previewReconciliationFile()` (لا يكتب) و`importReconciliationFile()` — كلاهما يمرّ بـ`importReconciliationFeed` نفسه (نفس checksum/idempotency ونفس حفظ `MISMATCH`). الجانب الدفتري **لا يُقبل من ملف**.
- **المسارات**: `POST /reconciliation/preview-file` و`POST /reconciliation/import-file` (multipart، حقل `file`؛ `source`/`currencyCode` في query)، بصلاحية `commission:manage`/`payment:read`.
- **الواجهة**: `AdminFinancePage.tsx` — منتقي ملف + معاينة + استيراد وملخّص، ومفاتيح `adminFinance.reconFile*` في ar/en/fr/zh.
- **التوثيق**: `docs/RECONCILIATION_FILE_IMPORT.md` (الصيغ/الحدود/الأعمدة/الرفض/Idempotency/الأثر)، وتحديث `API_SPECIFICATION.md` و`MASTER_GAP_AUDIT.md` (إغلاق أ.5-1).
- **التحقق**: `reconciliation-file-import.test.ts` — **33 حالة** (محلّل نقي + مسارات حقيقية: 401/403، معاينة بلا كتابة، idempotency، `MISMATCH` محفوظ، رفض التكرار/تهريب عمود). الخادم **1067/1070** (87 ملفًا، 3 متخطّاة) و`typecheck` نظيف.

## Milestone N6 — إصلاح مفتاح i18n المفقود `common.date` (zh)

- **الفجوة**: قاموس `zh` في `packages/web/src/lib/i18n.ts` كان ينقصه `'common.date'` الموجود في ar/en/fr.
- **الإصلاح**: أُضيف `'common.date': '日期'` بين `common.search`/`common.status` مطابقًا لبقية اللغات، مع اختبار **`packages/server/tests/i18n-locale-parity.test.ts`** (3 حالات؛ يفشل 3/3 عند غياب المفتاح ويمرّ عند وجوده).
- **التحقق**: `typecheck` = 0، وحزمة الخادم كاملة نظيفة. Commit `b48372e`.

## Milestone M8 — Role-scoped Customer/Partner Directories (6 أسطح) + إصلاح أعطال الواجهة الحقيقية

### الأسطح الستة المطلوبة وكيف تُبنى من بيانات حقيقية
دليل الأطراف يُشتق من **جدول الطلبات الفعلي** (`orders`) وأسماء الكيانات/المستخدمين، بلا صفوف وهمية:

| السطح | الدور | المصدر الحقيقي | Endpoint |
| --- | --- | --- | --- |
| Merchant → Customers | MERCHANT | مشترو `CUSTOMER` ممن لديهم طلبات على كيانات التاجر | `GET /api/directory/buyers?buyerType=CUSTOMER` |
| Merchant → Suppliers | MERCHANT | الموردون الذين اشترى منهم التاجر فعليًا | `GET /api/directory/my/suppliers` |
| Supplier → Buyers | SUPPLIER | كل الأطراف التي اشترت من كيانات المورد | `GET /api/directory/buyers` |
| Supplier → Merchants | SUPPLIER | مشترو `MERCHANT` من كيانات المورد | `GET /api/directory/buyers?buyerType=MERCHANT` |
| Company → Suppliers | COMPANY | الموردون الذين اشترت منهم الشركة | `GET /api/directory/my/suppliers` |
| Company → Buyers | COMPANY | الأطراف التي اشترت من كيانات الشركة | `GET /api/directory/buyers` |

### الفجوات الجذرية التي أصلحها هذا الميلستون (وُجدت من الواجهة، لا من HTTP 200)

**1) سطح «Supplier → Merchants» كان مربوطًا بقائمة تجار عامة، وليس بمشترين حقيقيين.**
كان `DashboardMerchantsListPage` يستدعي `GET /api/directory/merchants` (دليل تجار المنصة العام) — أي أنه لا يعرض أي علاقة شراء واقعية مع كيانات المورد. أُعيد ربطه إلى جدول المشترين المُرشَّح بـ`buyerType=MERCHANT`، وهو نفس مصدر الطلبات الحقيقي المستخدم في باقي الأسطح.
- **الإصلاح**: `DashboardMerchantsListPage` ⇒ `BuyerTable buyerType="MERCHANT"` + مفاتيح i18n جديدة `directory.merchantBuyers*` في ar/fr/en/zh (استُبدلت `directory.merchants*` العامة).

**2) `buyerType` كان مفقودًا من مصدر البيانات التجريبي ⇒ كل الأسطح المُرشَّحة فارغة.**
أُضيف `seedDirectoryRelationships(ctx)` إلى `seed-demo.ts`، ويُنشئ علاقات حقيقية عبر `createProduct` + `createOrder` (وليس INSERT يدويًا): تاجر←عميل، مورد←عميل/تاجر/شركة، شركة←عميل/تاجر. المُعرِّف `DIR-REL-*` يجعل الإعادة idempotent (يُعيد استخدام الصف القائم بدل التكرار).

**3) limiter الـ`forgot-password` لم يكن قابلًا للضبط من البيئة (عطل E2E حقيقي).**
بينما `login`/`register`/`deletion` كلها تقرأ `RATE_LIMIT_*_MAX`، كان المُحدِّد مثبّتًا `max: 5/300s`. النتيجة: مع تشغيلات E2E المتكرّرة يُستنفَد الحدّ، فيفشل `restorePassword` في مواصفة استعادة كلمة المرور **بصمت** ويبقى حساب `companya@wasit.tn` على كلمة المرور المؤقتة — فتنهار لاحقًا كل مواصفة تُسجّل الدخول به (401). هذا سبب مركّب حقيقي، لا مجرد تقلّب اختبار.
- **الإصلاح**: `forgotRateMax = Number(process.env.RATE_LIMIT_FORGOT_MAX ?? 5)` وتمريره إلى `rateLimit`؛ وإضافة `RATE_LIMIT_FORGOT_MAX: '500'` في `playwright.config.ts` (بيئة E2E فقط، والافتراضي الإنتاجي 5 كما هو).
- **إصلاح مانع للصمت**: `restorePassword` صار يتوقّع ظهور رمز الاستعادة (`await expect(tokenEl).toBeVisible()`) بدل `return` صامت — فأي فشل استعادة يصبح **فشلًا صريحًا** لا تلويثًا صامتًا للـfixture.

**4) اختبار `admin-ads` الأول كان يفترض وجود حملات من تشغيلات سابقة.**
على قاعدة نظيفة يكون الجدول فارغًا فعليًا، فيفشل `admin-ads-table`. صار الاختبار **يُنشئ حملة حقيقية أولًا** بجلسة التاجر ثم يتحقق من ظهور صفّها بالعنوان في مكتب الأدمن — إثبات ذاتي بلا اعتماد على حالة محيطة.

### الإثبات (UI → API → DB → UI)
- **`e2e/directory.spec.ts` (جديد، 7 حالات)**: تفتح كل سطح من الواجهة وتتحقق من صفوف حقيقية، وتُطابق العدد المعروض مع `pagination.total` الحيّ، وتُثبت الفلترة بالبحث، و`buyerType=MERCHANT` لا يُعيد إلا تجارًا، وعميل بلا كيانات يرى حالة فراغ صريحة (عزل نطاق). الجلسات تُبنى عبر `POST /api/auth/login` الحقيقي لكل اختبار بدل حالة تخزين مشتركة (لأن مواصفة الاستعادة تُبطل جلسات الحساب فعليًا).
- **`/admin/trust` و`/admin/risk` (حالتان جديدتان)**: كانتا مُغطّاتين بفحص «العنوان يظهر» فقط — وهو بالضبط ما لا يكفي. أُضيف اختباران يشغّلان العمليات الحقيقية: الزبون يُنشئ لقطة ثقة من صفحته (`POST /api/trust/me/recompute`) ثم الأدمن يُعيد الاحتساب من الصف ويُتحقق أن اللقطة استُمرّت في `GET /api/admin/trust`؛ وفي المخاطر يُنفَّذ «إعادة تقييم» من الصف ويُتحقق من `lastEvaluatedAt` في `GET /api/admin/risk/profiles`.
  - ملاحظة مهمة: جدول الثقة **فارغ بطبيعته** على قاعدة نظيفة (اللقطات تُكتب فقط عند إعادة احتساب المستخدم لنفسه)، لذلك الاختبار يُنشئ اللقطة أولًا بدل افتراض وجودها — وهذا سلوك صحيح لا فجوة.
- **HARNESS**: أُصلح `restorePassword` و`global-setup` ليكونا حاسمين.
- **النتائج**: **Full E2E 190/190** — **Server 546/546** (52 ملفًا) — **Typecheck** (server+web) و**Build** (server+web) نظيفان.
- **يُثبت الإصلاح**: تشغيل الحزمة كاملة بعد إصلاح الحدّ ⇒ **190/190 ناجح** (صفر سقوط في `directory` و`admin-ads`)، وحسابات الديمو تبقى على `Passw0rd!2026` بعده. (قبل الإصلاح كانت النتائج 185/188 ثم 186/188 مع سقوط متكرّر في `directory`.)

### الملفات
- `packages/server/src/modules/directory/{service,routes}.ts` (جديد)، `packages/server/src/app.ts`، `packages/server/src/modules/auth/routes.ts`، `packages/server/src/scripts/seed-demo.ts`، `packages/server/tests/directory.test.ts` (جديد)
- `packages/web/src/pages/DashboardListPages.tsx`، `App.tsx`، `AppSidebar.tsx`، `lib/api.ts`، `lib/types.ts`، `lib/i18n.ts`
- `e2e/directory.spec.ts` (جديد)، `e2e/functional-audit.spec.ts` (اختبارا trust/risk)، `e2e/auth.spec.ts`، `e2e/admin-ads.spec.ts`، `playwright.config.ts`

### القيود المُحترمة
لا migration/`db reset/drop/push`؛ لا تغيير في `buyerType` enum ولا مخطط قاعدة البيانات؛ العمولة **4% = 2%+2%** دون مساس؛ Marketing Video Agent (89e68d7) دون مساس؛ لا Mock؛ لا تعطيل أزرار لإخفاء أخطاء؛ RBAC ونطاق الملكية من نفس مصدر الطلبات الحقيقي؛ ar/fr/en/zh وRTL محفوظة.

## Milestone M7 — AI Budget (Target, Period) Identity Fixed From the UI

### الفجوة
`POST /api/admin/ai/budgets` كان يبحث عن الصف القائم بـ**الهدف فقط** (`userId` أو `roleTarget`) ويتجاهل `period`:

```ts
.where(body.userId ? eq(aiBudgets.userId, body.userId) : eq(aiBudgets.roleTarget ?? '___', body.roleTarget ?? '___'))
```

بينما **محرّك التنفيذ** (`resolveLimit` في `lib/ai/cost-control.ts`) يقرأ الميزانيات بـ`eq(aiBudgets.period, period)` — أي أن الميزانيات اليومية والشهرية مُفترض أن **تتعايش** لنفس الهدف. النتيجة: حفظ ميزانية `DAILY` لهدفٍ ما ثم حفظ ميزانية `MONTHLY` لنفس الهدف كان **يستبدل الصف الأول نفسه**، فيضيع سقف الدَّورة الأولى بصمت. عُثر عليها بالتحقق من الواجهة: حفظ `SUPPLIER/DAILY(maxRequests=111)` ثم `SUPPLIER/MONTHLY(222)` أنتج **صفًا واحدًا** `MONTHLY/222` فقط.

### السبب الجذري
هوية الصف في الـupsert (`target` وحده) لا تطابق هوية التنفيذ (`target` + `period`). لا يوجد unique index على `ai_budgets` يفرض أحدهما، فمرّ الخطأ بصمت.

### الإصلاح (كود إنتاج، جراحي)
- `packages/server/src/modules/admin/ai-routes.ts`: مطابقة الصف القائم صارت `and(targetMatch, eq(aiBudgets.period, body.period))` (استُخدم `and` المستورد أصلًا) — فتتعايش DAILY وMONTHLY، ويبقى الحفظ لنفس `(target, period)` **تحديثًا في المكان** (بلا تكرار).

### الإثبات (UI → API → DB/response → UI)
`e2e/admin-ai.spec.ts` — حالة جديدة **«DAILY and MONTHLY budgets for the same target coexist»**:
- حفظ `ROLE/ADMIN/DAILY(maxRequests=5001)` ثم `ROLE/ADMIN/MONTHLY(5002)` **من نموذج الواجهة**.
- `GET /api/admin/ai/budgets` يُعيد **صفّين** بقيمتيهما الصحيحتين.
- الواجهة تعرض الصفّين معًا (`admin-ai-budget-<id>` يحوي `DAILY`/`5001` و`MONTHLY`/`5002`).
- إعادة حفظ `DAILY` بقيمة جديدة ⇒ تحديث في المكان: العدد يبقى **2** و`DAILY` تصبح `5003` و`MONTHLY` تبقى `5002`.

### فحوص أخرى (لا فجوة، إثبات)
- `/dashboard/trust` زر **إعادة احتساب الدرجة** (صفر e2e سابقًا): من الواجهة ⇒ `POST /api/trust/me/recompute` **200**، الدرجة تُعرض `65`، وسجل `/api/trust/me/history` **0 → 1**، والصف يظهر في الجدول — handler→route→service→DB→UI سليم (لا تغيير).
- `/dashboard/messages`: فتح محادثة غير مقروءة من الواجهة ⇒ `unreadCount` **1 → 0** عبر `GET /api/messages` (بلا تغيير).

### التحقق
- **Full E2E: 181/181** (6.3m) — **server 534/534** (51 ملفًا) — **Typecheck** (server+web) و**Build** (server+web) نظيفان.
- لا migrations ولا DB reset/drop/push. العمولة **4% = 2%+2%**، وMarketing Video Agent (89e68d7) وسياسة المدة 35–120ث بلا مساس.

## Milestone M6 — Admin Desk Controls Proven From the UI

### الفجوة
آخر عناصر التحكّم المتبقّية من المسح الآلي لكل `data-testid` تفاعلي مقابل مراجع `e2e/*.spec.ts`:
- أزرار `admin-ai-refresh` / `admin-obs-refresh` / `admin-reports-refresh` / `admin-privacy-refresh` / `admin-sub-refresh` كلها موصولة بـ`load()` الذي يعمل عند mount، لكن **لا اختبار نقرها بعد تغيير حقيقي من طرف آخر** — فلا إثبات أنها تُعيد القراءة فعلًا (كان `admin-ads-refresh` الوحيد المُثبَت، M5).
- `comparison-category-select` و`admin-ai-model-cancel` بلا إثبات وظيفي.

### الإصلاح
لا تغيير في كود الإنتاج — كل الأزرار صحيحة؛ الفجوة كانت في الإثبات. أُضيفت حالات E2E حقيقية (UI → API → DB/response → UI) لكل عنصر:

| العنصر | الإثبات |
| --- | --- |
| `admin-ai-refresh` | طلب AI حقيقي من جلسة مشترٍ بعد الرندر ⇒ النقر يُقدّم الصف الجديد ويطابق أحدث صف من `/api/admin/ai/requests?limit=1` |
| `admin-obs-refresh` | 5 طلبات HTTP من طرف آخر ⇒ `admin-obs-kpi-requests` يزيد (الصفحة لا تُpoll) |
| `admin-reports-refresh` | تقرير يُنشأ من جلسة `admin2` بعد فتح الصفحة ⇒ النقر يزيد الصفوف ويُظهر الكود |
| `admin-privacy-refresh` | طلب حذف حقيقي بعد فتح الصفحة ⇒ النقر يزيد الطابور ويُظهر `admin-privacy-row-<id>` |
| `admin-sub-refresh` | اشتراك حقيقي بعد استقرار التحميل الأولي ⇒ الصف غير موجود قبل النقر وموجود بعده |
| `admin-ai-model-cancel` | تعديل ثم Cancel ⇒ النموذج يُصفَّر **والخادم يحتفظ بالاسم الأصلي** (لا كتابة) |
| `comparison-category-select` | اختيار تصنيفين: URL + `comparison-count` يطابقان `pagination.total`، والتصنيف الفارغ يُظهر empty state |

**قاعدة مدة الفيديو**: مؤكَّدة **35–120 ثانية** (شاملة)، والافتراضي **60 ثانية**. الواجهة تثبت `min=35`/`max=120`، وAPI يرفض 34/121/4/300 بـ**422**. المدة تُقاس فعليًا من bytes الـMP4 الناتج وتُخزَّن القيمة المقاسة، ويُرفض أي asset خارج النافذة قبل أن يصبح READY.

**إصلاح عرض ثانوي**: `e2e/marketplace.spec.ts` (MOQ) يتنقّل بين صفحات السوق حتى 12 بدل الصفحة الأولى — نفس انجراف القائمة الموثَّق في M5.

### التحقق
- **Full E2E**: **179/179** (7.2m). **الخادم**: **531/531** (51 ملفًا). **Typecheck** و**Build** (server + web) نظيفان.
- لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** والـMarketing Video Agent بلا مساس.

## Milestone M5 — Merchant Inventory Archived-Row actions + E2E listing drift

### الفجوة (اكتُشفت أثناء تحقق M4)
`/dashboard/inventory` تُدرِج المنتجات المؤرشفة (ARCHIVED) ضمن الجدول (مقصود: التاريخ يبقى مرئيًا)، لكنها كانت تعرض لها أزرار **إضافة/خصم/إعدادات** المخزون. الخادم يرفضها عن قصد بـ**409** (`adjustMyStock`: «Product is archived — stock cannot be modified»)، فكان المستخدم يرى أزرارًا تفشل دائمًا. ظهر ذلك كفشل `e2e/rbac.spec.ts` الذي كان ينقر الصف الأول (صار صفًا مؤرشفًا).

### السبب الجذري
الواجهة لا تقرأ `productStatus` العائد فعلًا من `listMyInventory`؛ ومنطق الزر لا يميّز ARCHIVED.

### الإصلاح
- بلا أي تغيير في الخادم أو قواعد العمل: `DashboardInventoryPages` تُخفي أزرار تعديل المخزون للصفوف المؤرشفة وتُظهر إشعار `inventory-archived-<id>` («منتج مؤرشف — لا يمكن تعديل مخزونه»)، وزر «الحركات» يبقى متاحًا للقراءة. مفتاح `inventory.archivedNotice` في ar/en (fr/zh عبر fallback).
- `e2e/helpers.ts`: `placeOrderViaUi` صار يتنقّل بين صفحات السوق (حتى 12) بدل الاعتماد على الصفحة الأولى. السبب: كل تشغيل لـ`functional-audit` يُنشئ منتجًا ACTIVE بمخزون صفر؛ والقائمة مرتّبة newest-first، فكانت تتكدّس في الصفحة الأولى (12 عنصرًا) فتفشل حالات الشراء عبر الواجهة على قاعدة معاد استخدامها.
- `e2e/rbac.spec.ts`: الحالة تستهدف صفًا قابلًا للتعديل فعليًا بدل الصف الأول.

### التحقق
- **Full E2E**: **167/167** (6.1m). **الخادم**: **531/531** (51 ملفًا). **Typecheck** و**Build** (server + web) نظيفان.
- **Browser Functional Smoke حقيقي** (Playwright/Chromium على الخادم والواجهة الحقيقيين، PostgreSQL حقيقي): `auth` + `marketplace` + `rbac` + `library` + `messages` + `notifications` = **31/31**.
- **جلسة يدوية من المتصفح** (تاجر `merchanta@wasit.tn`): `/dashboard/inventory` تُظهر للصفوف المؤرشفة «منتج مؤرشف — لا يمكن تعديل مخزونه» بلا أزرار مخزون، ولا تزال تعرض «الحركات»؛ ودفعة مخزون فعلية على `MER-OO-1L-004` من الواجهة رفعت الكمية **42 → 47**، وأثبتت القراءة من القاعدة سجل حركة `PURCHASE +5` — أي handler→API→DB→انعكاس على الواجهة.
- ملاحظة: `business-numbers.test.ts` «does not collide…» اختبار احتمالي قد يفشل عشوائيًا (~4% عند 500k سحب من 36^8)؛ ليس من هذا التغيير، ويثبت 3/3 عند الإعادة.
- لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** والـMarketing Video Agent بلا مساس.

## Milestone M4 — Admin Expire-Lapsed Subscriptions Proven From the UI

### الفجوة
`admin-sub-expire` في `/admin/subscriptions` (تبويب dunning) موجود وموصول بـ`POST /api/subscriptions/admin/expire-lapsed` → `expireLapsedSubscriptions()`، لكن **لا اختبار نقر الزر ولا استدعى المسار إطلاقًا**: كانت الخدمة مغطّاة بوحدة `subscriptions-collection.test.ts` فقط، فمسار handler→route→service→DB→انعكاس على الواجهة غير مُثبَت. (اكتُشفت بمسح آلي لكل عناصر `data-testid` التفاعلية في `pages/*.tsx` مقابل مراجع `e2e/*.spec.ts`.)

### ما بُني
- `e2e/admin-subscriptions.spec.ts` (+1 حالة): مشترك حقيقي عبر API، ثم `expireSubscriptionInDb()` تقادم اشتراكًا حقيقيًا بنفس نمط تقادم نافذة retention في `admin-privacy.spec.ts` (الزمن لا يُسافَر إليه من الواجهة)، ثم فتح `/admin/subscriptions` (يظهر ACTIVE) ⇒ dunning ⇒ `admin-sub-expire` ⇒ `expect.poll` يثبت `EXPIRED` في القاعدة ⇒ صف الكشف يظهر EXPIRED.

### التحقق
- **Full E2E**: **167/167** (كانت 166). **الخادم**: **531/531**. **Typecheck** و**Build** (server + web) نظيفان.
- لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** والـMarketing Video Agent بلا مساس.

## Milestone M3 — Merchant Order Lifecycle (Pass) + Admin Appeal Review Proven From the UI

### الفجوتان المرشّحتان بعد M2
1. **Merchant order status / order lifecycle — Pass (تغطية قائمة).** فُحص المسار كاملًا: `DashboardOrderDetailPage` يبني الأزرار من `allowedOrderActions()` (تسلسل البائع PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED→COMPLETED + إلغاء، وإلغاء المشتري قبل التأكيد) ويستدعي `api.updateOrderStatus` → `PATCH /api/orders/:id/status` → `updateOrderStatus()`. التغطية موجودة فعلًا من الواجهة في `e2e/order-lifecycle.spec.ts` (حالتان تنقران `order-action-<next>` عبر التسلسل كاملًا ثم تثبّتان `COMPLETED`/`CANCELLED` من الـAPI، وتتحقّقان من ظهور `order-no-actions`). لا فجوة — لم يُمسّ شيء.
2. **مراجعة الاستئناف الإداري (Appeal Review) — فجوة تغطية حقيقية.** نموذج الاستئناف للمستخدم (`appeal-submit`) وزرّا المراجعة الإدارية (`appeal-accept`/`appeal-reject`) موجودة ومربوطة، لكن **لا اختبار نقر أيًّا منها**: `e2e/disputes.spec.ts` كان يرفع الاستئناف عبر `page.request.post('/api/disputes/:id/appeals')` ويؤكّد فقط **رفض التنحّي 403** ثم يفحص نصّ القائمة. المسار الموجب (handler → route → service → DB → انعكاس على الواجهتين) لم يُثبَت إطلاقًا.

### العائق البنيوي (قاعدة داخل الـspec، لا يُلتفّ عليها)
قاعدة التنحّي (A4): `decidedBy === actorId` ⇒ صاحب القرار الأصلي **لا يستطيع** مراجعة استئناف قراره. في بيئة الديمو كان `admin@wasit.tn` (SUPER_ADMIN) هو من يبتّ كل النزاعات، ولا يوجد مسار منتجي يمنح دور Staff آخر — لذا كان المسار الموجب غير قابل للإثبات. الحل: بذرة مستخدم Staff ثانٍ في مُبذّر الديمو (بنفس نمط `admin@wasit.tn` القائم) — **بيانات اختبار/تطوير لا ميزة منتج**.

### ما بُني
- `seed-demo.ts`: مستخدم `admin2@wasit.tn` بدور ADMIN (idempotent عبر `ensureDevUser` + `assignRoleDirect`).
- `e2e/global-setup.ts` + `e2e/helpers.ts`: جلسة `admin2` في fixtures الأدوار.
- `AdminEnginesPages.tsx`: `data-testid="admin-appeal-note"` فقط (بلا تغيير منطق).
- `e2e/disputes.spec.ts` (+1 حالة): دورة استئناف كاملة **من الواجهة**: المشتري يفتح نزاعه ويرفع الاستئناف عبر `appeal-submit` ⇒ يظهر PENDING؛ المراجع الثاني يفتح `/admin/disputes` ويقبل عبر `admin-appeal-note` + `appeal-accept` ⇒ `expect.poll` يثبت القاعدة (`ACCEPTED/E2E: appeal upheld.` + النزاع عاد `UNDER_REVIEW`) ⇒ المشتري يرى «مقبول» + ملاحظة القرار.

### التحقق
- **Full E2E**: **166/166** (كانت 165). **الخادم**: **531/531**. **Typecheck** و**Build** (server + web) نظيفان.
- لا migrations ولا reset/drop/push. العمولة **4% = 2%+2%** والـMarketing Video Agent بلا مساس.

## Milestone M2 — Admin Dispute Lifecycle + Ledger Reflection Proven From the UI (اختبار وظيفي)

### الفجوة في التغطية (قدرة موجودة لكن غير مُثبَتة من الواجهة)
تحقّقنا أولًا من ثلاث فجوات مرشّحة بالدليل قبل أي تغيير:

1. **Dispute lifecycle — فجوة حقيقية.** أزرار `/admin/disputes` (تحديث الحالة، البتّ، الإسناد، مراجعة الاستئناف) كانت موجودة ومربوطة بمعالِجات سليمة، لكن **لا اختبار واحد كان ينقرها**: كل قرار في `e2e/disputes.spec.ts` كان يُنفَّذ عبر `admin.request.post('/api/admin/disputes/:id/decide')` مباشرة. أي أن مسار الواجهة (handler → API → service → DB → انعكاس على صفحة العميل) لم يكن مُثبَتًا إطلاقًا، ولو كان الـhandler مربوطًا بمسار خاطئ أو لو بقي تفاصيل النزاع قديمًا لشُحن بلا كشف.
2. **Admin Ledger posting — ليست فجوة قدرة.** لا يوجد مسار كتابة إداري للـledger، عن قصد: `transaction_ledger` يُلحق فقط من `orders/service.ts` (قيدا العمولة + قيمة الصفقة عند إنشاء الطلب) و`payments/service.ts` (التسوية/الاسترداد). اختراع «post entry» إداري سيكون ميزة جديدة يمسّ النموذج المالي المجمّد. الفجوة الحقيقية الوحيدة هي أن **صفحة `/admin/ledger` لم يُثبَت قط من الواجهة أنها تعرض الصفوف الحقيقية المكتوبة في القاعدة**.
3. **Commission Policy edits — ليست فجوة قدرة.** لا مسار إداري ولا واجهة لتعديل `commission_policies` (الكتابة فقط في `seed.ts`، والقراءة فقط في `lib/commission.ts`). بناؤها خارج النطاق ويهدّد سياسة 4% = 2% بائع + 2% مشتري المجمّدة. سُجّلت كخارج نطاق، بلا اختراع قدرة.

### ما بُني
- **`data-testid` فقط، بلا تغيير منطق**: صف النزاع `admin-dispute-<id>`؛ عناصر التحكم `admin-dispute-status-select`/`admin-dispute-status-note`/`admin-dispute-status-submit`، `admin-dispute-decision-select`/`admin-dispute-decision-note`/`admin-dispute-decide-submit`؛ وصفوف الـledger `admin-ledger-<entryType>-<direction>`.
- لا تغيير على أي معالِج أو مسار أو خدمة. الوظائف التي كانت تعمل لم تُمسّ.

### التحقق (Functional Audit حقيقي من الواجهة)
- **`e2e/disputes.spec.ts` (+1 حالة)**: من واجهة الأدمن حصرًا — فتح النزاع من الصف بالـtestid، تقديم الحالة إلى `UNDER_REVIEW` عبر القائمة والنقر، ثم البتّ `IN_FAVOR_OF_BUYER` من الزر؛ ثم `expect.poll` على `GET /api/admin/disputes/:id` يثبت أن **القاعدة** تحمل `DECIDED/IN_FAVOR_OF_BUYER/<note>` (حالة ثابتة لا حالة واجهة)؛ ثم فتح العميل نزاعه من `/dashboard/disputes` ورؤية القرار وملاحظته معروضين.
- **`e2e/functional-audit.spec.ts` (+1 حالة)**: إنشاء طلب حقيقي من الواجهة ⇒ قراءة `GET /api/admin/ledger` ⇒ فتح `/admin/ledger` والتأكد أن عدد صفوف `COMMISSION/DEBIT` المعروضة **يساوي** ما يعيده الـAPI (انعكاس حقيقي لا fixture).
- **Full E2E**: **165/165** (كانت 163). **الخادم**: **531/531** (51 ملفًا). **Typecheck** (server + web) و**Build** (server + web) = نظيف.
- الفحص أثبت أن الفجوتين **تغطية لا وظيفة**: الحالتان الجديدتان تمرّان دون أي إصلاح منطقي.

### البيئة
- لا migrations ولا schema جديد، ولا reset/drop/push.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**. لا مسار تعديل عمولة إداري (قرار مقصود موثَّق).
- **Marketing Video Agent (89e68d7)** وB18/B19/B20/M1 بلا مساس.

## Milestone M — Merchant Product Editing (B20 — مكتمل)

### الفجوة الحقيقية (قدرة جوهرية غائبة)
`PATCH /api/products/:id` كان **مذكورًا في `API_SPECIFICATION.md` لكنه غير موجود إطلاقًا** في الخادم (لا مسار ولا دالة خدمة)، وبالتالي لا واجهة تعديل: `DashboardProductsPage` كان يعرض زر الحالة (نشر/إلغاء) فقط. أي أن التاجر يستطيع **إنشاء** منتج لكنه **لا يستطيع تعديله أبدًا** — لا اسم، ولا سعر، ولا فئة، ولا وصف. هذا بند صريح في قائمة الوظائف المطلوبة للتاجر («تعديل منتج»)، وهو فجوة نموذجية من نوع «القدرة موجودة في العقد/التوثيق فقط».

### ما بُني
- **الخدمة**: `updateProduct(db, id, input, ctx)` في `modules/products/service.ts` — تعديل جزئي آمن: يتحقق من وجود المنتج (404)، يمنع فئة مجهولة (422)، يعيد توليد `slug` عند تغيير الاسم، يحوّل الحقول الفارغة إلى NULL (لا سلسلة فراغ)، ويضبط السعر عبر `assertNonNegative`+`toDecimal`، ويكتب Audit `PRODUCT.UPDATE` بقيم before/after.
- **حدود متعمّدة**: الهوية (seller/SKU/currency) والمخزون **غير قابلة للتعديل** من هنا — تغييرها يعيد ترميز تاريخ الطلبات أو ينقل مخزونًا بين مالكين بصمت؛ المخزون يبقى في وحدة الجرد.
- **المسار**: `PATCH /api/products/:id` (requireAuth + `updateProductSchema` مع `.refine` يرفض جسمًا فارغًا 422). غير المالك ⇒ 403، وإلا 401، وتعديل منتج `SUSPENDED` ⇒ 403 (لا يرفع البائع إنفاذًا إداريًا بنفس منطق زر الحالة).
- **الواجهة**: `EditProductModal` في `DashboardProductsPage` — زر «تعديل» (`product-edit-<id>`) يفتح نموذجًا (`product-edit-form`) مُعبّأً من `GET /api/products/:id`، يحفظ عبر `PATCH`، ثم يُعيد تحميل القائمة فيرى المستخدم القيم الجديدة. الزر مخفي للمنتج الموقوف. مفاتيح i18n `common.edit` (موجود) و`form.editProduct` في **ar/fr/en/zh**.

### التحقق (Functional Audit حقيقي من الواجهة)
- **`product-suspension.test.ts` (+3 حالات)**: تعديل المالك للاسم/السعر/MOQ/النية/الوصف ⇒ يُقرأ فعليًا من `GET /api/products/:id` و`slug` يعاد توليده؛ رفض 422 (جسم فارغ/فئة مجهولة/سعر سالب/اسم قصير) مع بقاء القيمة القديمة؛ و403 لتاجر آخر + 401 لغير مصادق + 403 بعد الإيقاف الإداري مع ثبات الحقول في القاعدة.
- **`e2e/functional-audit.spec.ts` (+1 حالة)**: من واجهة التاجر — فتح النموذج من الزر، التأكد أنه **مُعبّأ** (ليس فارغًا)، تعديل الاسم والسعر، الحفظ، ظهور القيم الجديدة في الجدول **وفي صفحة تفاصيل المنتج** (`/products/:id`) — أي أن التعديل ثابت لا مجرد حالة واجهة.
- **الخادم**: **531/531** (51 ملفًا). **Full E2E**: **162/162**.
- **Typecheck** (server + web) و**Build** (server + web) = نظيف.

### البيئة
- لا migrations ولا schema جديد (كل الأعمدة موجودة)، ولا reset/drop/push.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** وB18/B19 بلا مساس.

## Milestone M1 — Verification Round Trip Proven From the UI (اختبار وظيفي)

### الفجوة في التغطية (قدرة موجودة لكن غير مُثبَتة من الواجهة)
مسار `/dashboard/verification` (تعبئة طلب) و`/admin/verification` (بت/رفض) كانا يعملان خلفيًا لكن **لم يكن هناك أي اختبار يقود الدورة كاملة من واجهة المستخدم**، وأزرار المراجعة في كشف الأدمن **بلا `data-testid`** فكان من المستحيل تثبيت القرار على صف معيّن. أضفنا `verification-submit` في صفحة المستخدم و`admin-verification-<id>` / `admin-verification-approve-<id>` / `admin-verification-reject-<id>` في الكشف، ثم اختبار E2E يقود: تسجيل حساب حقيقي → توثيق البريد عبر مسار التوكن الفعلي → دخول → إرسال طلب تحقق → موافقة الأدمن من الصف → **ظهور «تمت الموافقة» في صفحة المستخدم نفسها** (لا مجرد HTTP 200). الاختبار يسجّل حسابًا جديدًا في كل تشغيل حتى لا يعتمد على حالة قديمة مدقّقة.

## Milestone L — Agent Task Results Visible to the Requester (B19 — مكتمل)

### الفجوة الحقيقية (حلقة مقطوعة: الخادم يحسب، الواجهة لا تُظهر)
وكلاء الذكاء الذين `requiresHumanApproval=true` (sales/ads/b2b/risk/dispute/development) يُنشئون مهمة بحالة `awaiting_approval`، ثم يعتمدها مشرف عبر `POST /api/ai/tasks/:id/approve` فيُنفَّذ الوكيل ويُخزَّن `result` في `ai_agent_tasks`. المشكلة أن **صفحة التاجر `/dashboard/ai` لم تكن تقرأ المهام إطلاقًا**: `loadAll()` كانت تجلب `aiStatus/aiMyBudget/aiModels/aiAgents/aiActivity` فقط، و`aiActivity` يعرض **استدعاءات LLM الخام** (`ai_requests`) لا المهام. فبعد الاعتماد يظهر للتاجر «لا يوجد نشاط بعد» رغم أن النتيجة موجودة في القاعدة — أي أن `api.aiMyTasks()` كان **بلا مستهلك في الواجهة** (أحد الـ16 طريقة API بلا قارئ التي رصدها تدقيق ما بعد B18). أثبت الفحص وقت التشغيل أن `GET /api/ai/tasks` يعيد المهمة `approved` مع `result` كامل، والواجهة تعرض لا شيء.

### ما بُني
- **قسم «مهام الوكلاء»** في `DashboardBusinessPages.tsx` (`DashboardAIPage`): `loadAll()` تجلب `api.aiMyTasks()` ضمن نفس `Promise.all`، وتُعرض المهام بحالة ملوّنة (approved/معتمد أخضر، awaiting_approval كهرماني، rejected/failed أحمر) مع الزمن والنتيجة.
- **عرض النتيجة**: `parseResultData()` يفكّ `result` سواء وصل كائنًا أو نصًا JSON (صفوف أقدم)، ويُعرض داخل `<pre data-testid="ai-task-result">` بعينه — لا placeholder.
- **صف بمعرّف ثابت** `data-testid="ai-task-<id>"` للاختبار الوظيفي؛ وتحديث القائمة تلقائيًا بعد `runAgent` عبر `loadAll()` القائمة.
- **التوطين**: مفاتيح `ai.tasks.*` و`ai.task.status.*` في **ar/en/fr/zh** الأربعة (بما فيها `awaiting_approval`/`queued`/`running`) — لا نصوص مضمّنة.

### التحقق (Functional Audit حقيقي من الواجهة)
- **من المتصفح**: التاجر ينفّذ Sales Agent من الزر ⇒ تظهر صف «قيد الموافقة»؛ المشرف يعتمد ⇒ بعد إعادة التحميل يظهر الصف «معتمد» مع `result` (KPIs حقيقية: `commission: 646.0000` = 4% من `16150`، ما يؤكد بقاء سياسة العمولة سليمة).
- **`e2e/admin-ai.spec.ts` (+1 حالة)**: يختبر الحلقة كاملة من واجهة التاجر: تنفيذ الوكيل من الزر ⇒ ظهور صف الانتظار ⇒ اعتماد بجلسة admin مستقلة (`playwright.request` بلا إفساد جلسة التاجر) ⇒ إعادة التحميل ⇒ ظهور الحالة «معتمد» و`ai-task-result` مرئي، ثم مطابقة الحمولة المعروضة بـ`GET /api/ai/tasks/:id`.
- **الخادم**: الحزمة الكاملة **528/528** (51 ملفًا).
- **Full E2E**: **161/161** ناجحة (كانت 160 قبل الحالة الجديدة) — شُغّلت بخوادم Playwright الخاصة (بحدود معدّل E2E المرتفعة) بعد إيقاف خوادم التطوير اليدوية.
- **Typecheck** (server + web) و**Build** (server + web) = نظيف.

### البيئة
- لا migrations ولا schema جديد، ولا reset/drop/push. أُعيد تشغيل PostgreSQL 17 محليًا (الكتلة كانت مفقودة) ثم `db:migrate` + `db:seed` + `db:seed:demo` من مسارات المشروع نفسها.
- الـ18 فشلًا التي ظهرت أول الأمر في الحزمة الكاملة (auth/payments/admin-*) كانت **بيئية لا وظيفية**: السبب أن Playwright كان **يعيد استخدام خادمي التطوير اليدويين** (`reuseExistingServer`) وهما بلا حدود المعدّل المرتفعة التي يضبطها `playwright.config.ts`، فيقع 429 أثناء السويت. عند إيقافهما وتشغيل السويت بخوادم Playwright ⇒ **161/161**.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس. B18 غير مُعاد فتحه.

## Milestone K — Ad Placement Targeting + Ad Telemetry Attribution (B18 — مكتمل)

### الفجوة الحقيقية
محرّك الإعلانات كان **يعرض نفس الحملات في كل المواضع**: `servePlacement()` كانت تُرشّح بـ`status=ACTIVE` و`isActive` والنافذة الزمنية فقط، ولا تقرأ `adUnits` إطلاقًا، فلا يوجد أي مفهوم لـ«موضع» (MARKETPLACE / PRODUCT_DETAILS / SEARCH). كما أن `recordAdEvent` كانت تُسقط `userId` و`ipHash` (تكتب `null` دائمًا)، فحدث الظهور/النقر بلا إسناد — أي أن CTR وبيانات الإسناد كانت صفرًا بنيويًا. وأخيرًا كانت الواجهة **لا تعرض أي إعلان**: لا مكوّن يستدعي `api.servedAds()`، فالـAPI كان بلا مستهلك.

### ما بُني
- **`campaignTargetsPlacement(adUnits, placement)`** في `modules/ads/service.ts`: الحملة مؤهّلة للموضع إذا كان `adUnits.placements` يسمّيه. **الحملات بلا مواضع تبقى غير مقيَّدة** فتُخدم في كل المواضع — توافق رجعي للحملات المنشأة قبل وجود المواضع (لا كسر بيانات).
- **`servePlacement`** تُرشّح الآن بالموضع عبر `!opts.placement || campaignTargetsPlacement(...)`، وتُعيد **إبداعًا واحدًا لكل حملة** (`orderBy(createdAt desc).limit(1)` بدل `limit(3)`) فلا يتكرّر نفس المُعلن في أكثر من خانة.
- **`GET /api/ads/served?placement=…`** يقبل الموضع؛ و**`POST /api/ads/events`** صار `optionalAuth`: الظهور والنقر قياس صفحات عامة (مجهول)، أما **CONVERSION فتشترط جلسة** (401) لأنها تستهلك الميزانية وتحرّك المال.
- **الإسناد**: `recordAdEvent` تستخدم `input.userId ?? ctx.actorId`، و`ipHash` يُحسب من `ctx.ipAddress` عبر `hashToken` — **يُخزَّن الهاش فقط، لا العنوان الخام**.
- **`AdSlot.tsx`** (جديد): مكوّن يجلب الإعلانات لموضع ويعرضها كبطاقات «إعلان مميّز»، ويسجّل **IMPRESSION** مرة واحدة لكل إبداع (حماية بـ`Set` عبر `useRef`) بـ`sessionId` مجهول للزيارة مخزّن في `sessionStorage`.
- **إصلاح فقدان النقر**: النقر يفتح `target="_blank"` فيُلغي `fetch` الجاري فيضيع الـCLICK. أُبدل بـ`navigator.sendBeacon` (يُصفّ الطلب في المتصفح ويبقى بعد الـunload) مع الإبقاء على `fetch` كـfallback.
- **الربط في الواجهة**: `<AdSlot>` في `MarketplacePage` (`MARKETPLACE`) و`ProductDetailsPage` (`PRODUCT_DETAILS`) و`SearchPage` (`SEARCH`).
- **نموذج الحملة**: `AD_PLACEMENTS` + صناديق اختيار المواضع في `DashboardBusinessPages`، و`api.createCampaign` يقبل `adUnits`. مفاتيح i18n جديدة (`ads.sponsored`, `ads.sponsoredBadge`, `ads.form.placements`, `ads.form.placementsHint`).

### التحقق (Functional Audit حقيقي من الواجهة، لا HTTP 200 فقط)
- **من الواجهة عبر المتصفح**: إنشاء حملة بموضع `MARKETPLACE` → القاعدة تُظهر `ad_units={"placements":["MARKETPLACE"]}` و`status=ACTIVE`؛ وحملة `PRODUCT_DETAILS` تُخزَّن بحالة `DRAFT`.
- **`e2e/ads.spec.ts` (+2 حالات، 4/4)**: (1) حملة بلا مواضع تُخدم في `MARKETPLACE`، ثم إعادة استهدافها إلى `SEARCH` ⇒ تُخدم في `SEARCH` **ولا** تُخدم في `MARKETPLACE` (تغيير فعلي في الخدمة، مُثبَت بـ`expect.poll` بعد إضافة إبداع من الواجهة). (2) منتقي المواضع يُخزِّن `PRODUCT_DETAILS` ويُقرأ من تفاصيل الحملة.
- **الخادم**: `ads.test.ts` **15/15**؛ الحزمة الكاملة **528/528** (51 ملفًا).
- **Full E2E**: **160/160** (كان 158 قبل الإضافتين).
- **Typecheck** (server + web) و**Build** (server prod-bundle + web) = نظيف.

### البيئة (بدون reset/drop)
- لا reset/drop/push ولا migrations جديدة (`ad_units` و`campaigns` موجودان).
- فشلان في `payments.spec.ts` ظهرا أول الأمر وعُزلا كـ**سابقين للتغيير**: أُثبت بإخفاء التغييرات (`git stash`) أن الفشل نفسه يقع على الشجرة النظيفة. السبب بيئي: خادم dev مُعاد استخدامه بلا حدود E2E المرتفعة (`RATE_LIMIT_LOGIN_MAX`) ⇒ 429. عند تشغيل Playwright بخوادمه الخاصة (بعد إيقاف خوادم التطوير) ⇒ **160/160**.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس.

## Milestone J — Automatic Data-Retention Window Execution: جدولة الحذف آليًا بعد انتهاء نافذة الاستبقاء (مكتمل)

### الهدف
إغلاق آخر بند متبقٍّ في PHASE 17 صراحةً في `docs/DEVELOPMENT_ROADMAP.md` (الأولويات القادمة، البند 7): «Data deletion execution (anonymization) ✅ منجزة ومختبرة؛ **بقي جدولتها آليًا بعد انتهاء نافذة الاستبقاء**». كانت النافذة (`data_deletion_requests.retention_until`) تُحسب من Policy Engine وتُخزَّن وقت الطلب، وتُستخدم كبوابة لمسار `ANONYMIZED` اليدوي فقط — **لا شيء يتحرّك عند انتهائها**، فيبقى الطلب `DEACTIVATED` إلى الأبد حتى يتذكّر إنسان التاريخ. نُفِّذ مشغّل زمني حقيقي (بلا schema، بلا migrations، بلا قيم مثبّتة).

### ما بُني
- **`packages/server/src/modules/privacy/service.ts` → `advanceDueDeletionRetentions(db)`**: تمرير كل طلب انتهت نافذته مرحلة واحدة لكل تشغيل: `DEACTIVATED → RETENTION → ELIGIBLE`. **الموعد النهائي هو البوابة**، فالطلبات داخل نافذتها (بما فيها الجديدة) لا تُلمس. لا يُنفّذ `ANONYMIZED` إطلاقًا: مسح الـPII لا رجعة فيه ويبقى قرار مشغّل مُراجَعًا ومُدقَّقًا.
- **أمان التزامن**: كل انتقال يحدّث بشرط المرحلة في `WHERE` (`id = ? AND stage = ?`) ⇒ عامل ثانٍ أو تحريك يدوي متزامن يؤثّر 0 صفوف (لا lost update، لا قفزة مرحلة). يُدقَّق الصف الذي انتقل فعلًا فقط، بفاعل نظامي `actorId: null` و`metadata.automated=true`.
- **`POST /api/admin/privacy/deletions/retention-sweep`** (`ADMIN`/`SUPER_ADMIN`): تشغيل نفس المهمة عند الطلب، ليصبح السلوك الزمني قابلًا للملاحظة والاختبار من داخل المنتج لا في عمل خلفي فقط.
- **`packages/server/src/lib/scheduler.ts`**: إضافة `runRetentionSweep()` إلى `tick()` (الافتراضي 60 دقيقة مع rollover/expiry). المهمة متقاربة idempotent، فتكرارها من نسخة أخرى no-op.
- **الواجهة**: `packages/web/src/pages/AdminPrivacyPage.tsx` زر `admin-privacy-run-sweep` + `api.adminRunRetentionSweep()` + نوع `RetentionSweepResult` + مفاتيح `adminPrivacy.runSweep/sweepDone/sweepNone` في ar/en/fr/zh، مع إعادة تحميل القائمة بعد التشغيل وإظهار رسالة صريحة.

### أخطاء حقيقية اكتُشفت وأُصلحت (السبب الجذري، لا إخفاء الخطأ)
1. **عدم وجود محرّك زمني إطلاقًا**: `retention_until` كان مخزّنًا بلا أي قارئ سوى بوابة `ANONYMIZED` اليدوية؛ لا scheduler ولا مسار ولا واجهة تتحرّك عند انتهائه (تأكيد بـ `grep`: لا `advanceDue*` في المستودع). أُضيف الفحص + الـroute + الـscheduler.
2. **عيب تصميمي كشفه الاختبار**: النسخة الأولى كانت تحرّك `DEACTIVATED→RETENTION` فور انتهاء النافذة و`RETENTION→ELIGIBLE` في نفس اللحظة ⇒ مرحلة `RETENTION` تدوم tickًا واحدًا بلا معنى. الاختبار (`is idempotent…`) فشل فعليًا وأظهر التعارض. صُحِّح التصميم إلى **انتقال واحد لكل تشغيل ببوابة الموعد النهائي** بحيث تظل النافذة مقياسًا حقيقيًا لمدة الاستبقاء.
3. **`inArray` مفقود بعد التعديل**: كشفه `tsc` (`Cannot find name 'inArray'`) وأُصلح.

### الاختبارات والتحقق
- جديد: `packages/server/tests/privacy-retention-sweep.test.ts` — **7/7**: تمرير المستحقّ (`DEACTIVATED→RETENTION` و`RETENTION→ELIGIBLE`)، عدم لمس `RETENTION` بنافذة مستقبلية، **تقارب** (مرحلة لكل تشغيل ثم توقّف عند `ELIGIBLE`)، عدم التمرير مرتين في التشغيل الواحد، **عدم التجهيل التلقائي** وبقاء الـPII سليمًا + Audit نظامي واحد لكل طلب، الـroute للأدمن 200، وRBAC (غير أدمن ⇒ 401/403).
- جديد في `e2e/admin-privacy.spec.ts` (من الواجهة): زر الفحص يمرّر طلبًا مستحقًّا ويُظهر النتيجة في الجدول (مع تحقّق خادمي)، والفحص **لا يجهّل** طلبًا أبدًا (3 تشغيلات ⇒ يتوقف عند `ELIGIBLE`)، و`retention-sweep` = **403** للتاجر. (يُجعل الطلب مستحقًّا بكتابة الموعد في الماضي عبر `pg` — لا يمكن السفر بالزمن من الواجهة — والتحقق النهائي من حالة الخادم الحقيقية، بلا mocks.)
- **Server**: 48 ملفًا / **489/489** (482 + 7 جديد).
- **Full E2E**: **127/127** (125 + 2 جديد).
- **Typecheck** (server + web) و**Build** (server prod-bundle + web) = نظيف.

### البيئة (بدون reset/drop)
- لا reset/drop/push. لا migrations جديدة — العمود والجدول موجودان مسبقًا.
- `wasit_dev`/`wasit_test` قائمتان من الجلسة السابقة؛ الفحص الخادمي يستخدم fixture يُنشأ داخل الاختبار حصرًا.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس.
- `ANONYMIZED` يبقى قرارًا بشريًا (لا أتمتة لمسح الـPII).

## Milestone I — Admin Privacy / Data-Deletion Desk: لوحة الخصوصية وحذف البيانات داخل لوحة الأدمن (مكتمل)

### الهدف
سدّ فجوة "قدرة خلفية بلا واجهة" التالية بعد Milestone H. كل مسارات `/api/admin/privacy/*` (‏`GET /deletions`، ‏`PATCH /deletions/:id`) كانت منفّذة ومختبرة خادميًا (`security-privacy.test.ts`) لكن **لا صفحة أدمن واحدة تستدعيها**، ولا يوجد أي عميل API في الويب يقرأ قائمة طلبات الحذف أو يحرّك مراحلها. بُنيت لوحة `/admin/privacy` تعمل على الخادم الحقيقي فقط — بلا schema ولا migrations ولا قيم مثبّتة.

### ما بُني
- **`packages/server/src/modules/privacy/service.ts`**: إثراء `listDeletionRequests(db, stage?)` ليُرجع بيانات العرض الحقيقية (‏`requestId`, `userId`, `userEmail`, `stage`, `reason`, `retentionUntil`, `accountActive`, `createdAt`) عبر join مع `users` وترتيب `desc(createdAt)` — بدلًا من الصفوف الخام وحدها.
- **`packages/web/src/lib/types.ts`**: أنواع `DeletionStage`, `DeletionRequestRow`.
- **`packages/web/src/lib/api.ts`**: `adminDeletionRequests({ stage })` و`adminAdvanceDeletion(requestId, stage, { legalHoldOverride })`.
- **`packages/web/src/pages/AdminPrivacyPage.tsx`**: KPIs حية لكل مرحلة، تصفية بالمرحلة تُعيد الجلب من الخادم، جدول الطلبات مع أزرار تحريك المرحلة، وتأكيد قبل تجاوز الاستبقاء القانوني.
- **الربط**: مسار `/admin/privacy` في `App.tsx` (AdminOnly)، رابط `admin.privacy` في `AdminSidebar`، ترجمات كاملة ar/en/fr/zh (24 مفتاحًا × 4).

### أخطاء حقيقية اكتُشفت وأُصلحت (السبب الجذري، لا إخفاء الخطأ)
1. **شكل استجابة الخادم**: `GET /api/admin/privacy/deletions` يُرجع `data` كـ**مصفوفة مباشرة**، لا `{ items: [...] }`. الواجهة كانت تقرأ `res.data?.items` ⇒ اللوحة تعرض "لا توجد طلبات حذف" دائمًا رغم وجود الصفوف في قاعدة البيانات (تأكيد بـ SQL: 5 صفوف `DEACTIVATED`). أُصلح العميل والأنواع لتقرأ المصفوفة مباشرة.
2. **محدِّد معدّل الحذف يعمل قبل المصادقة**: `rateLimit({ windowSeconds: 300, max: 2, keyPrefix: 'privacy-deletion' })` يُمفتَح على IP قبل `requireAuth`، فسويت يرفع عدة طلبات حذف حقيقية يُصطدم بـ429 (نجاح زائف/فشل غير سببي). جُعل الحد قابلًا للتجاوز بالبيئة `RATE_LIMIT_DELETION_MAX` بنفس نمط `RATE_LIMIT_LOGIN_MAX`/`RATE_LIMIT_REGISTER_MAX` — **القيمة الافتراضية للإنتاج 2 كما هي**، ويُرفع فقط في `playwright.config.ts` لعملية E2E.

### الاختبارات والتحقق
- جديد: `e2e/admin-privacy.spec.ts` — **6/6**:
  1. فتح اللوحة من الشريط الجانبي + ظهور الطلب الحقيقي ببريد الحساب الحقيقي + مطابقة KPI للمخزون الحيّ من الـAPI.
  2. تحريك الطلب من الواجهة ⇒ التحقق من الاستمرارية خادميًا + أثر Audit (`PRIVACY.DELETION_STAGE`).
  3. التصفية بالمرحلة ⇒ عدد الصفوف يطابق استجابة `?stage=REVIEW`.
  4. الرفض ⇒ `accountActive=true` خادميًا **+ تسجيل دخول حقيقي ينجح** (إثبات أن الحساب صار قابلًا للاستخدام، لا مجرد قراءة علم).
  5. التجهيل ⇒ `PRIVACY.LEGAL_HOLD_OVERRIDE` + `PRIVACY.DELETION_ANONYMIZED` في Audit، وبقاء صف الطلب بعد مسح الـPII.
  6. RBAC: تاجر ⇒ صفحة Forbidden + **403** على `GET` و`PATCH`.
- `/admin/privacy` أُضيف إلى قائمة أسطح الأدمن في `e2e/functional-audit.spec.ts`.
- **Full E2E**: **125/125** (118 سابقًا + 7 جديد).
- **Server**: 47 ملفًا / **482/482**.
- **Typecheck** (server + web) و**Build** (server prod-bundle + web) = نظيف.

### البيئة (بدون reset/drop)
- الحاوية أُعيد إنشاؤها فلم تكن Postgres مثبّتة/قائمة، ولم تكن Playwright browsers مثبّتة. أُعيد التركيب والتشغيل (`pg_ctlcluster 17 main start`)، وأُنشئ دور `wasit` وقاعدتا `wasit_dev`/`wasit_test` **من الصفر** (لم تكن موجودة)، ثم `db:migrate` + `seed`، ثم `npx playwright install chromium`. **لا** DB reset/drop/push لأي بيانات قائمة.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس.
- لا migrations جديدة (اللوحة تقرأ schema قائمًا فقط).

## Milestone H — Admin Observability UI: لوحة المراقبة التشغيلية داخل لوحة الأدمن (مكتمل)

### الهدف
سدّ فجوة "قدرة خلفية بلا واجهة" التالية بعد Milestone G. كل مسارات `/api/admin/observability/*` (المؤشرات، اللوج المركزي، سجل التنبيهات، وتقييم التنبيهات الفوري) كانت منفّذة ومختبرة خادميًا (C2، AD-039، `observability.test.ts` 23 حالة) لكن **لا صفحة أدمن واحدة تستدعيها**. بُنيت لوحة `/admin/observability` بتبويبات تعمل على الخادم الحقيقي فقط — بلا schema ولا migrations ولا قيم مثبّتة.

### ما بُني
- **`packages/web/src/pages/AdminObservabilityPage.tsx`**: 4 تبويبات — نظرة عامة / المؤشرات / اللوج / التنبيهات:
  - **نظرة عامة**: KPIs حية (`wasit_http_requests_total`, `wasit_http_errors_total`, عدد التنبيهات المشتعلة، `wasit_db_up`)، قناة التنبيه (`alertStatus`)، آخر تقييم، شارات التنبيهات المشتعلة، وجدول كمون p50/p95/p99 من الهيستوغرام.
  - **المؤشرات**: جداول العدّادات والمقاييس اللحظية والهيستوغرامات من `metrics.snapshot()` مباشرة.
  - **اللوج**: `recentLogs` مع تصفية حقيقية حسب المستوى (`?level=`) والتطبيق يعيد الجلب من الخادم.
  - **التنبيهات**: `alertEvents` من قاعدة البيانات + زر **تقييم الآن** (`POST /alerts/evaluate`) الذي يُنتج انتقالات ويُدوَّن في Audit.
- **طبقة API/الأنواع**: `adminObservabilityMetrics`, `adminObservabilityLogs`, `adminObservabilityAlerts`, `adminEvaluateAlerts` + أنواع `ObservabilityDashboard`, `ObservabilityMetricsSnapshot`, `ObservabilityLogRecord`, `AlertEventRow`, `AlertEvaluationResult`.
- **الربط**: مسار `/admin/observability` في `App.tsx` (AdminOnly)، رابط في `ADMIN_NAV`، ترجمات كاملة ar/en/fr/zh (44 مفتاحًا × 4).

### ملاحظة تشخيصية (فرق عن الاعتماد على HTTP 200)
- أسماء المؤشرات الحقيقية هي `wasit_http_requests_total` / `wasit_http_errors_total` / `wasit_db_up`، وليست بأسماء مختصرة — قُرئت من `lib/observability/metrics.ts` لا من التخمين.
- مؤشر `wasit_db_up` يُضبط فقط عند تقييم التنبيهات (‏`alerts.ts`)، لذا يعتمد عليه اختبار القائمة على `wasit_uptime_seconds` المضمون بدلًا منه.

### الاختبارات والتحقق
- جديد: `e2e/admin-observability.spec.ts` — **5/5**: فتح اللوحة من الشريط الجانبي ومطابقة KPI للمخزون الحيّ، تقييم التنبيهات من الواجهة + التحقق من أثر Audit خادميًا (`OBSERVABILITY.ALERTS_EVALUATED`)، تصفية اللوج حسب المستوى ومطابقتها لاستجابة الـAPI، شارات التنبيهات المشتعلة، وRBAC (تاجر ⇒ Forbidden + 403 على كل مسارات observability).
- `/admin/observability` أُضيف إلى قائمة أسطح الأدمن في `e2e/functional-audit.spec.ts`.
- **إصلاح خطأ كامن حقيقي** في `e2e/admin-subscriptions.spec.ts`: الاختبار الأول كان يفترض "بيانات اشتراكات مزروعة"، بينما `seed.ts`/`seed-demo.ts` **لا تُنشئ أي اشتراك** — فينجح فقط إذا سبقه تشغيل آخر أنشأ اشتراكًا (نجاح زائف/اعتماد على ترتيب). صار يُنشئ اشتراكًا حقيقيًا قبل فتح الصفحة (نفس مساعد الملف).
- **Full E2E على قاعدة نظيفة (بعد TRUNCATE لجدول subscriptions)**: **118/118**.
- **Server**: 47 ملفًا / **482/482**.
- **Typecheck** (server + web) و**Build** (server prod-bundle + web) = نظيف.

### البيئة (بدون reset/drop)
- الحاوية أُعيد إنشاؤها فلم تكن Postgres مثبّتة/قائمة. أُعيد التركيب والتشغيل (`pg_ctlcluster 17 main start`)، وأُنشئ دور `wasit` وقاعدتا `wasit_dev`/`wasit_test` **من الصفر** (لم تكن موجودة)، ثم `db:migrate` + `seed` + `seed-demo`. **لا** DB reset/drop/push لأي بيانات قائمة.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس.
- لا migrations جديدة (اللوحة تقرأ schema قائمًا فقط).

## Milestone G.1 — إغلاق تذبذب E2E: إصلاح سببي جذري (الجلسة السابقة — مكتمل)

### الهدف
اختفاء "تذبذب" اختبارات الطلب (`payments`/`marketplace`/`disputes`/`functional-audit`) الذي كان يظهر بشكل عشوائي في اختبار مختلف كل تشغيل. المطلوب سبب حقيقي لا إخفاء خطأ.

### السببان الجذريان (لا علاقة للـHTTP 200)
1. **تصادم أرقام المستندات ⇒ 500 على `POST /api/orders`**:
   - `packages/server/src/lib/ids.ts › generateBusinessNumber` كان يبني اللاحقة من عدّاد داخل العملية (`counter.c` يعود إلى 0 مع كل إعادة تشغيل) + `Math.random()*1296` فقط.
   - بادئة التاريخ `YYMMDD` ثابتة لكل مستندات اليوم، فالفضاء الفعلي للتفرد ≈ 1296 قيمة لكل إعادة تشغيل.
   - إعادة تشغيل الخادم في كل تشغيل E2E تُعيد العدّاد ⇒ إعادة إصدار `TXN-…`/`ORD-…` مستخدمة سابقًا ⇒ `duplicate key value violates unique constraint "transactions_tx_number_idx"` ⇒ **500 Internal server error** في الواجهة.
   - **الإصلاح**: لاحقة عشوائية 8 محارف من CSPRNG (`randomInt`) — `36^8 ≈ 2.8e12` لكل يوم — مع الحفاظ على نفس الصيغة المقروءة والطول (`TXN-YYMMDD-XXXXXXXX` ≤ 40 حرفًا كحد العمود). حُذف `baseN`/`counter` الميتان.
2. **سباق تحميل جلسة المصادقة في مساعد E2E**:
   - `e2e/helpers.ts › placeOrderViaUi` كان يفحص `isVisible()` فورًا بعد الانتقال لصفحة المنتج. `auth-context` يُهيّئ الجلسة المحفوظة **بشكل غير متزامن**، وقبل اكتمالها تعرض `ProductDetailsPage` زر "اطلب" من فئة الزائر (يشير إلى `/login`) أو لا تعرضه أصلًا حسب توقيت الرسم.
   - النتيجة: النقر يذهب لـ`/login` (أو لا يجد الرابط) ⇒ لا يُنشأ طلب إطلاقًا، ويظهر الخطأ المضلّل "No in-stock product".
   - **الإصلاح**: انتظار ظهور رابط الهيدر للمستخدم المسجّل (`لوحة التحكم`/`Dashboard`) ثم `waitFor({state:'visible'})` على زر الطلب فعلًا، بدلًا من الفحص اللحظي. أُبقيت تشخيصات غنية عند فشل كل المنتجات.

### الاختبارات والتحقق
- جديد: `packages/server/tests/unit/business-numbers.test.ts` — 3 حالات (تفرد 100k رسمة، تفرد 500k على نفس اليوم، الصيغة والطول). **نجحت**.
- `payments.spec.ts`: **10/10** تشغيل متتالٍ (كان يفشل في ~2‑3 من كل 10 قبل الإصلاح).
- **Full E2E**: **112/112 × 3 تشغيلات متتالية** نظيفة.
- **Server**: 47 ملفًا / **482/482**.
- **Typecheck** (server + web) و**Build** (server + web) = نظيف.

### خارج النطاق / غير مُتغيّر
- العمولة كما هي **4% = 2% بائع + 2% مشتري**.
- **Marketing Video Agent (89e68d7)** بلا مساس.
- لا DB reset/drop/push، ولا migrations، ولا حذف بيانات اختبار.

## Milestone G — Admin AI Governance UI: لوحة حوكمة الذكاء الاصطناعي داخل لوحة الأدمن (هذه الجلسة — مكتمل)

### الهدف
سدّ فجوة "قدرة خلفية بلا واجهة" في وحدة الذكاء الاصطناعي: كل مسارات `/api/admin/ai/*` (الاستخدام، الطلبات، النماذج، الميزانيات، الوكلاء، المهام + اعتماد/رفض المهام الحساسة) كانت منفّذة ومختبرة خادميًا، لكن **لا صفحة ولا استدعاء واحد من الواجهة**. بُنيت لوحة `/admin/ai` بتبويبات تعمل على الخادم الحقيقي فقط — بلا schema ولا migrations ولا قيم مثبّتة. القاعدة `3198171` كأساس.

### التنقيح (Recon) قبل التنفيذ
- `grep` على `packages/web/src` يُظهر **صفر** استخدام لـ`/admin/ai` (لا `api.*`، لا صفحة، لا route، لا nav) — بينما الصفحة/المسارات موجودة في `modules/admin/ai-routes.ts` ومحمية بـ`AI_MANAGE`/`ADMIN_AI` (يملكها ADMIN وSUPER_ADMIN).
- بوابة الاعتماد البشري (`requiresHumanApproval`) للوكلاء الحساسين (sales/ads/b2b/risk/dispute/development) قدرة عمل حقيقية لم يكن للأدمن أي طريق إليها إلا استدعاء API خام.
- فحص `AdminAnalyticsPage` وadmin observability: الأول موجود ويقرأ مساراته (لا فجوة)، والثاني وحدة مستقلة خارج نطاق هذه الجلسة (سُجّل كفجوة متبقية أدناه).

### ما نُفّذ
- **الواجهة (صفحة جديدة)**: `AdminAiPage.tsx` — ستة تبويبات: نظرة عامة، الطلبات، النماذج، الميزانيات، الوكلاء، المهام.
  - نظرة عامة: بطاقات KPI (طلبات/مستخدمون مميّزون/رموز إدخال/إخراج/كلفة) + نافذة الاستخدام، كلها من `GET /admin/ai/usage` مباشرة.
  - الطلبات: جدول من `GET /admin/ai/requests` + شارة حالة لكل صف.
  - النماذج: كتالوج `GET /admin/ai/models` بأسعار الإدخال/الإخراج لكل 1k.
  - الميزانيات: `GET /admin/ai/budgets` (الهدف، الدورة، الحدود، الحالة).
  - الوكلاء: `GET /admin/ai/agents` مع تمييز "يتطلب اعتمادًا بشريًا" مقابل "تلقائي".
  - المهام: `GET /admin/ai/tasks` + عدّاد "بانتظار الاعتماد"، وأزرار **اعتماد/رفض** تظهر فقط عندما `status === 'awaiting_approval'` وتستدعي `POST /api/ai/tasks/:id/approve|reject` ثم تُعيد التحميل من الخادم.
  - كل عملية عرض رسالة نجاح/خطأ عبر `ErrorState`/شريط حالة — لا إخفاء أخطاء ولا تعطيل أزرار للتغطية.
- **التسجيل**: مسار `/admin/ai` داخل `AdminOnly` في `App.tsx` + عنصر `admin.aiGovernance` في `ADMIN_NAV`.
- **طبقة API/الأنواع**: `adminAiUsage`, `adminAiRequests`, `adminAiBudgets`, `adminUpsertAiBudget`, `adminAiModels`, `adminUpsertAiModel`, `adminAiAgents`, `adminAiTasks`, `decideAgentTask` + أنواع `AiAdminUsage`, `AiAdminModel`, `AiAdminBudget`, `AiAdminRequestRow`, `AgentRegistryRow`, `AgentTaskRow`, `AgentTaskDecision`.
- **إصلاح سبب حقيقي (لا إخفاء)**: مسار `GET /admin/ai/agents` كان يقرأ جدول `agent_registry` مباشرة، بينما التهيئة (`ensureAgentRegistrySeeded`) تحدث فقط في المسار الموجّه للمستخدم `/api/ai/agents`. على قاعدة لم يستدعِ فيها أي مستخدم وكيلًا، **تبويب الوكلاء يظهر فارغًا**. أُضيفت `listRegistryAgents()` في `modules/ai/agents.ts` (تُهيّئ ثم تقرأ) واستُخدمت في المسار الإداري — فأصبح الكتالوج مضمونًا دائمًا.
- **التوطين**: مفاتيح `adminAi.*` + `admin.aiGovernance` في `ar/en/fr/zh` (لا نصوص داخل المكوّن، وسقوط آمن للعربية كما هو نمط الملف).

### الاختبارات والتحقق
- **Server**: `tests/admin-ai.test.ts` — **14 حالة**: 401 لكل مسار إداري، 403 لـCUSTOMER وMERCHANT، عقد `/usage` (كل الحقول)، كتالوج النماذج (بما فيه `local-heuristic`)، سجل الوكلاء مع علم الاعتماد، **regression**: المسار الإداري يُهيّئ ويُعيد الكتالوج كاملًا بعد `DELETE FROM agent_registry`، مجموعات `{items:[]}`، فلترة المهام بـstatus/agentKey، upsert ميزانية + Audit + 422 بلا هدف، ودورة اعتماد/رفض كاملة لمهمة مُبوَّبة + 409 عند إعادة القرار. الإجمالي **479/479 — 46 ملفًا**.
- **E2E**: `e2e/admin-ai.spec.ts` — **6/6** على Postgres حقيقي: فتح اللوحة من الشريط الجانبي ومطابقة KPI لحمولة `/usage` الحيّة + تبويبات النماذج/الوكلاء، ظهور مهمة `sales-agent` المُبوَّبة في الطابور واعتمادها من الواجهة ثم التحقق خادميًا وظهورها `approved`، رفض مهمة `b2b-agent`، ظهور ميزانية أُنشئت عبر العقد نفسه، ظهور صف في تبويب الطلبات بعد استدعاء AI حقيقي، وRBAC (تاجر: Forbidden في الواجهة + 403 لكل مسارات admin AI).
- **Browser Functional Smoke**: أُضيف `/admin/ai` إلى قائمة `ADMIN_PAGES` في `e2e/functional-audit.spec.ts` (وأُضيف `/admin/subscriptions` المفقود من القائمة سابقًا) ليغطي التدقيق الوظيفي العام اللوحة تلقائيًا.
- **إجمالي E2E**: **112/112** ناجحة.
- **Typecheck** (server + web) = 0 أخطاء، **Build** (server + web) = نظيف.

### خارج النطاق / غير مُتغيّر
- **العمولة كما هي**: 4% = 2% بائع + 2% مشتري.
- **Marketing Video Agent (89e68d7)**: بلا مساس — لا regression.
- لا DB reset/drop/push، ولا migrations، ولا حذف بيانات اختبار ضرورية.
- **فجوة متبقية (لم تُبنَ هذه الجلسة)**: لوحة admin observability (`/api/admin/observability/{metrics,logs,alerts,evaluate}`) لا تزال بلا واجهة — مرشّح الجلسة القادمة.

### جدول التدقيق الوظيفي (Admin AI Governance UI)

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Admin nav → AI desk | ✅ رابط الشريط الجانبي `/admin/ai` | ✅ PASS | لا Route ولا عنصر nav ولا صفحة | `AdminAiPage` + مسار داخل AdminOnly + `admin.aiGovernance` | E2E + server |
| Overview KPIs (usage window/totals) | ✅ تبويب نظرة عامة | ✅ PASS | لا استدعاء لـ`/admin/ai/usage` من الواجهة | ربط البطاقات بحمولة `/usage` الحيّة | E2E + server |
| Requests feed | ✅ تبويب الطلبات | ✅ PASS | لا واجهة لـ`/admin/ai/requests` | جدول من الخادم + شارة حالة | E2E + server |
| Models catalogue | ✅ تبويب النماذج | ✅ PASS | لا واجهة للكتالوج | جدول من `/admin/ai/models` بأسعار/1k | E2E + server |
| Budgets list | ✅ تبويب الميزانيات | ✅ PASS | لا واجهة للميزانيات | جدول من `/admin/ai/budgets` | E2E + server |
| Agents registry (+approval gate) | ✅ تبويب الوكلاء | ✅ PASS | المسار الإداري كان يقرأ الجدول بلا تهيئة ⇒ فارغ | `listRegistryAgents()` تُهيّئ ثم تقرأ | E2E + server (regression) |
| Tasks queue + pending count | ✅ تبويب المهام | ✅ PASS | لا واجهة للمهام | جدول `/admin/ai/tasks` + عدّاد awaiting | E2E + server |
| Approve gated agent task | ✅ زر اعتماد | ✅ PASS | لا واجهة تستدعي مسار الاعتماد | `POST /api/ai/tasks/:id/approve` + reload | E2E + server |
| Reject gated agent task | ✅ زر رفض | ✅ PASS | لا واجهة تستدعي مسار الرفض | `POST /api/ai/tasks/:id/reject` + reload | E2E + server |
| RBAC (merchant/customer blocked) | ✅ `/admin/ai` + APIs | ✅ PASS | — | AdminOnly + `AI_MANAGE`/`ADMIN_AI` خادميًا | E2E + server |

## Milestone F — Admin Subscriptions UI: لوحة إدارة الاشتراكات داخل لوحة الأدمن (جلسة سابقة — مكتمل)

### الهدف
بناء واجهة إدارة اشتراكات داخل Admin Dashboard وربطها الكامل بخدمة الاشتراكات القائمة (`SUBSCRIPTION_MANAGE` = ADMIN/SUPER_ADMIN). لا schema ولا migrations جديدة (لم يُثبَت أي احتياج)؛ قاعدة `5732916` كأساس.

### التنقيح (Recon) قبل التنفيذ
- المسارات الخلفية موجودة ومختبرة سابقًا (`adminListPlans`, `setPlanActive`, `adminListSubscriptions`, `adminListInvoices`, `listPendingInvoices`, `collectInvoicePayment`, `rollover`, `expire-lapsed`) لكن **لا صفحة أدمن تستدعيها** — كانت قدرة خلفية بلا واجهة (ناقص حسب Definition of Done).
- `ADMIN_NAV` في `AppSidebar.tsx` لا يحوي اشتراكات، و`App.tsx` لا يسجّل `/admin/subscriptions`.

### ما نُفّذ
- **الخادم (إثراء العقد للواجهة بلا تغيير schema)**: `adminListSubscriptions` و`adminListInvoices` صارا يُنضّمان (`leftJoin`) إلى `users` و`subscription_plans` ويُعيدان `userEmail`/`userName`، و`planCode`/`planName`، و`status`/`billingCycle`/`autoRenew`/`startsAt`/`endsAt`/`cancelledAt`/`paidAt`/`dueAt`/`externalRef`. أنواع جديدة `AdminSubscriptionView`/`AdminInvoiceView` في `modules/subscriptions/types.ts`. المستخدم/الخطة لم يكونا ظاهرين في الواجهة سابقًا (كان userId/planCode فقط).
- **الواجهة (صفحة جديدة)**: `AdminSubscriptionPages.tsx` — `AdminSubscriptionsPage` بأربعة تبويبات: الاشتراكات، الخطط، الفواتير، التحصيل والمتابعة (Dunning).
  - الخطط: بطاقات بأسماء/أسعار شهرية وسنوية من الخادم (بلا قيم مثبّتة) + زر تفعيل/تعطيل (`PATCH /admin/plans/:id/active`) يظهر/يختفي حسب `isActive`.
  - الاشتراكات: جدول (المستخدم، الخطة، الحالة، البداية/النهاية، التجديد التلقائي، دورة الفوترة).
  - الفواتير: جدول (الرقم، المستخدم، المبلغ، الحالة، الاستحقاق/الدفع) + زر تحصيل للـPENDING (`POST /admin/invoices/:id/collect`).
  - Dunning: قائمة الفواتير المعلّقة (`/admin/invoices/pending`) + تشغيل التجديد (`POST /admin/rollover`) وتشغيل إنهاء المنتهية (`POST /admin/expire-lapsed`).
  - كل زر يعرض رسالة نجاح/خطأ، ويُعيد التحميل من الخادم — لا إخفاء للأخطاء ولا أزرار معطّلة للتغطية.
- **التسجيل**: مسار `/admin/subscriptions` داخل `AdminOnly` في `App.tsx`، وعنصر `admin.subscriptions` في `ADMIN_NAV`.
- **طبقة API/الأنواع**: `adminSubscriptionPlans`, `adminSetPlanActive`, `adminSubscriptions`, `adminSubscriptionInvoices`, `adminPendingSubscriptionInvoices`, `adminCollectSubscriptionInvoice`, `adminRunSubscriptionRollover`, `adminExpireLapsedSubscriptions` + أنواع `AdminSubscription`, `AdminSubscriptionInvoice`, `CollectResult`, `RolloverResult`, `ExpireLapsedResult`.
- **التوطين**: مفاتيح `adminSub.*` + `admin.subscriptions` + `common.active/inactive` في `ar/en/fr/zh`.

### الاختبارات والتحقق
- **Server**: **465/465 — 45 ملف**. حالة جديدة في `subscriptions.test.ts` تتحقّق من عقد الواجهة: صف الاشتراك يحمل بريد المالك و`planCode`/`planName`، وصف الفاتورة يحمل بريد المالك وحالة PENDING، وظهورها في قائمة dunning.
- **E2E**: `e2e/admin-subscriptions.spec.ts` — **6/6**: فتح اللوحة من الشريط الجانبي وقراءة خطط/اشتراكات/فواتير حقيقية، مطابقة السعر المعروض لـ`Intl` مقابل `priceMonthly` من الخادم (لا ثابت)، تفعيل/تعطيل خطة والتحقق من الأثر خادميًا ثم الاسترجاع، ظهور اشتراك عميل حقيقي وفاتورته، تحصيل فاتورة PENDING ⇒ PAID في الواجهة والخادم، ظهور قائمة dunning وتشغيل التجديد، وRBAC (تاجر محجوب UI + 403 API).
- **إجمالي E2E**: **104/104** (شمل payments/auth السابقة — كانت تفشل سابقًا فقط لأن سيرفرًا يدويًا رُفع بلا `RATE_LIMIT_LOGIN_MAX`؛ عند تشغيل Playwright يدير الخوادم بإعداداته تمرّ كلها).
- **Typecheck** (server + web) = 0، **Build** (server + web) = نظيف.

### خارج النطاق / غير مُتغيّر
- **العمولة كما هي**: 4% = 2% بائع + 2% مشتري.
- **Marketing Video Agent (89e68d7)**: بلا مساس — لا regression.
- لا DB reset/drop/push، ولا migrations، ولا حذف بيانات اختبار ضرورية.

### جدول التدقيق الوظيفي (Admin Subscriptions UI)

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Admin nav → subscriptions desk | ✅ رابط الشريط الجانبي `/admin/subscriptions` | ✅ PASS | المسار غير مسجّل في App.tsx ولا في ADMIN_NAV | تسجيل Route داخل AdminOnly + عنصر nav | E2E + server |
| Plans tab renders live prices | ✅ تبويب الخطط | ✅ PASS | بطاقات بلا مصدر بيانات | قراءة `GET /admin/plans` وعرض السعر من الخادم | E2E |
| Activate/deactivate plan | ✅ زر تفعيل/تعطيل | ✅ PASS | لا واجهة تستدعي `setPlanActive` | `PATCH /admin/plans/:id/active` + reload | E2E + server |
| Subscriptions list (user/plan/status) | ✅ تبويب الاشتراكات | ✅ PASS | `adminListSubscriptions` كان يُعيد userId/planCode فقط | `leftJoin users/plans` + حقول عرض | E2E + server |
| Invoices list (owner/amount/status) | ✅ تبويب الفواتير | ✅ PASS | `adminListInvoices` كان بلا مالك | `leftJoin subscriptions/users` + حقول عرض | E2E + server |
| Collect pending invoice | ✅ زر تحصيل | ✅ PASS | لا واجهة تستدعي مسار التحصيل | `POST /admin/invoices/:id/collect` (manual provider) ثم التحقق PAID | E2E + server |
| Dunning pending queue | ✅ تبويب Dunning | ✅ PASS | لا واجهة لقائمة dunning | `GET /admin/invoices/pending` | E2E + server |
| Run renewal rollover | ✅ زر تشغيل التجديد | ✅ PASS | لا واجهة للمسار | `POST /admin/rollover` | E2E + server |
| Expire lapsed subscriptions | ✅ زر إنهاء المنتهية | ✅ PASS | لا واجهة للمسار | `POST /admin/expire-lapsed` | E2E |
| RBAC (merchant blocked) | ✅ `/admin/subscriptions` + API | ✅ PASS | — | AdminOnly + `SUBSCRIPTION_MANAGE` خادميًا | E2E |

## Milestone E — Subscription UI Integration: ربط صفحة الاشتراكات بالـBackend الحقيقي (جلسة سابقة — مكتمل)

### الهدف
ربط `DashboardSubscriptionsPage` بالكامل بخدمة الاشتراكات القائمة، وإزالة كل الأسعار/البيانات المثبّتة في الواجهة. لا تغيير على schema ولا migrations (لم يُثبَت أي احتياج).

### ما نُفّذ
- **طبقة أنواع/API في الواجهة**: أُضيفت أنواع الاشتراك (`PlanTarget`, `SubscriptionStatus`, `BillingCycle`, أنواع العرض) في `lib/types.ts`، ودوال `api` (`listSubscriptionPlans`, `mySubscription`, `mySubscriptionInvoices`, `subscribeToPlan`, `changeSubscriptionPlan`, `cancelSubscription`, `paySubscriptionInvoice`) في `lib/api.ts`.
- **RBAC**: `subscriptions.manage` و`subscription.own` مع ربط الأدوار في `lib/rbac.ts`.
- **الصفحة**: أُعيدت كتابة `DashboardSubscriptionsPage` لتقرأ الخطط/الاشتراك/الفواتير من الخادم، مع تبديل MONTHLY/YEARLY، واشترك/غيّر/ألغِ/ادفع، وشعار «خطتك الحالية»، وجدول فواتير — كل الأرقام من الـAPI. الأسعار المثبّتة (`19`/`99`) حُذفت.
- **التوطين**: مفاتيح `sub.*` في `ar/fr/en/zh`، وحُذفت **56** مفتاحًا ميتًا خاصًا بشكل الخطط المثبّت سابقًا (تحقّقنا أن لا مرجع باقٍ لها).
- **الخادم**: `service.ts` يرمي `ApiError.notFound(...)` بدل `Error` العادية ⇒ استجابات 4xx نظيفة بدل 500.

### الاختبارات والتحقق
- **Server suite**: **464/464 — 45 ملف** (زادت 7 حالات جديدة لعقد الواجهة في `subscriptions.test.ts`).
- **Typecheck** (server + web) = 0، **Build** (server + web) = نظيف.
- **E2E وظيفي جديد**: `SUBSCRIPTIONS — live catalog, subscribe, change, cancel` يقود الواجهة فعليًا (سعر مُطابق للـBackend شهريًا/سنويًا، اشتراك، ظهور الفاتورة، تغيير خطة، إلغاء) ويؤكد الأثر عبر الـAPI الحيّ. **`functional-audit.spec.ts` = 42/42**، و`navigation-audit` + `rbac` = 14/14.

### إصلاح جنبي حقيقي (Test isolation — ليس في المنتج)
`tests/revenue.test.ts` كان يجمّع `transaction_ledger`/`invoices`/`ai_usage` على مستوى الجدول كله بعملة `TND`، وبقية الملفات تترك صفوف COMMISSION حقيقية ⇒ الاختبار كان يعتمد على ترتيب تشغيل الملفات. أُعيد إنتاجه على `master` النظيف (فشل ثابت تسلسليًا) ثم أُصلح بعزل كل حالة على عملة خاصة (`ZLC`/`ZIN`/`ZAT`/`ZAU`/`ZOR`/`ZOC`) فيصبح الاستعلام المقيّد بالعملة حاويًا لصفوفه فقط.

### خارج النطاق / غير مُتغيّر
- **العمولة كما هي**: 4% = 2% بائع + 2% مشتري.
- **Marketing Video Agent (89e68d7)**: بلا مساس — لا regression.
- لا DB reset/drop/push، ولا حذف بيانات اختبار ضرورية.

### جدول التدقيق الوظيفي (Subscription UI Integration)

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Subscription plan catalog | ✅ `/dashboard/subscriptions` | ✅ PASS | أسعار مثبّتة في الواجهة | قراءة `GET /api/subscriptions/plans` | E2E + server |
| Monthly/Yearly toggle | ✅ زرّان | ✅ PASS | — | يعرض سعر الخادم المخزَّن | E2E |
| Subscribe | ✅ زر اشترك | ✅ PASS | — | `POST /api/subscriptions/subscribe` + reload | E2E + server |
| Change plan | ✅ زر تغيير الخطة | ✅ PASS | — | `PATCH /api/subscriptions/me/plan` | E2E + server |
| Cancel | ✅ زر إلغاء + تأكيد | ✅ PASS | — | `POST /api/subscriptions/me/cancel` | E2E + server |
| Current-plan badge | ✅ | ✅ PASS | — | `planId === subscription.planId` | E2E |
| Invoices table | ✅ | ✅ PASS | — | `GET /api/subscriptions/me/invoices` | E2E + server |
| Pay invoice | ✅ زر دفع | ✅ PASS | — | `POST /me/invoices/:id/pay` | server |
| Unknown plan error | — | ✅ PASS | `Error` عادية ⇒ 500 | `ApiError.notFound` | server |
| Plan grid (admin surface) | ✅ صفحة التاجر | ✅ PASS | — | — | E2E |

## Milestone D — Performance/Scale: Load + Index + Caching (هذه الجلسة — مكتمل)

### الهدف
إغلاق فجوات الأداء D1/D2/D3 في `docs/PRODUCTION_GAP_LIST.md`: لا دليل سلوك تحت الحمل (D1)، لا مراجعة EXPLAIN للفهارس (D2)، ولا طبقة cache للقراءات الساخنة (D3).

### ما نُفّذ
- **D1 — Load harness:** `lib/perf/load-runner.ts` (بلا اعتماديات خارجية) + `scripts/load-smoke.ts` + سكربت `npm run load:smoke`. يقود الخادم الحقيقي عبر HTTP ويفشل إن تجاوز p95 الميزانية.
  - **النتيجة الفعلية (CACHE_ENABLED=true):** 7 سيناريوهات، 0% أخطاء، p95 بين 4ms و21ms (geo.countries 11ms، geo.languages 7ms، categories.list 8ms، products.list 21ms، search.all 18ms، seo.sitemap 4ms، health.ready 7ms).
  - **القياس المقابل (CACHE_ENABLED=false):** geo.countries p95 23ms (3595→1349 rps)، geo.languages 13ms (5039→1987 rps)، categories.list 12ms (4405→2233 rps)، seo.sitemap 12ms (4594→1050 rps). الـcache يضاعف الإنتاجية على القراءات الثابتة — تأثير مقيس لا مُدّعى.
- **D2 — Indexes:** فهارس مركّبة مطابقة لأنماط «فلترة + ترتيب» الحقيقية: `products_public_created_idx`، `products_public_category_created_idx`، `orders_buyer_created_idx`، `orders_seller_created_idx`، `notifications_user_created_idx`، `messages_thread_created_idx`، `invoices_status_due_idx`.
  - Migration إضافية فقط (بلا drop/reset/push) وطُبّقت على `wasit_dev`.
  - **إثبات بالـEXPLAIN:** أداة دائمة `scripts/explain-hot-queries.ts` (تُشغَّل بـ`--synth=N`). عند 20 ألف صف مُصنَّع داخل معاملة **تُرجَع دائمًا (ROLLBACK)** — فلا تتغيّر قاعدة البيانات — يختار المُخطِّط الفهرس المركّب في كل الاستعلامات الساخنة: `products.public_list` 0.033ms، `products.public_by_category` 0.018ms، `orders.by_buyer` 0.022ms، `orders.by_seller` 0.018ms، `notifications.list` 0.024ms، `invoices.pending_due` 0.029ms، `audit.recent` 0.036ms.
  - ملاحظة منهجية: `notifications.unread_count` يظهر Seq Scan عندما تكون كل الصفوف غير مقروءة (لا فائدة من الفهرس)، وبعد جعل المرشّح انتقائيًا يستخدم `notifications_read_idx` (2.1ms) — سلوك مُخطِّط صحيح لا فجوة فهرس.
- **D3 — Read cache:** `cached()` على قراءات geo/categories/seo مع invalidation عند الكتابة، و`readCacheStatus()` مكشوفة عبر `/api/health/channels`.

### الاختبارات
- `tests/unit/load-runner.test.ts` (7)، `tests/unit/read-cache.test.ts` (7)، `tests/read-cache.test.ts` (9).
- الحزمة الكاملة: **45 ملف / 457 اختبار — كلها خضراء**؛ `npm run typecheck` (server + web) = 0؛ `npm run build` نظيف.
- **E2E حقيقي عبر الواجهة: 97/97** (`npx playwright test`) — بلا mocks، على Postgres حقيقي.

### إصلاح انحدار حقيقي (Functional)
`MESSAGING — opens an existing thread, sends a message and sees it renders` كان يفشل: **السبب الجذري** أن `seed-demo.ts` لم يُنشئ أي محادثة إطلاقًا، فصفحة الرسائل فارغة لكل الحسابات التجريبية — وهو عينًا عَرَض «الواجهة تفتح لكن الوظائف لا تعمل».
- **الإصلاح (بيانات، لا إخفاء خطأ):** أنشأنا محادثة تجريبية عبر `openDirectThread` + `sendMessage` الحقيقيين (عميل ↔ مورّد) داخل الـseeder، بشرط عدم وجود محادثة سابقة (idempotent، بلا حذف بيانات).
- **إعادة الاختبار من الواجهة:** المحادثة تظهر، وكتابة رسالة والضغط على «إرسال» تُظهر الرسالة فعليًا — ✓ 1 passed (514ms) وسجلّات الخادم `POST /api/messages/:threadId/messages → 201` ثم `GET` → 200.

### خارج النطاق
- ميزانية p95 حاليًا على مجموعة بيانات صغيرة (منتجات 6، طلبات 1)؛ الفهارس مُثبَتة بـEXPLAIN عند 20 ألف صف لكن قياس الحمل على بيانات ضخمة مؤجّل.

## Milestone C-1 — نموذج العمولة: 4% منقسمة 2% بائع + 2% مشتري (هذا الجلسة — مكتمل)

### الهدف
تعديل نموذج Wasit الأساسي من «3% على البائع فقط» إلى **4% من قيمة المعاملة، منقسمة 2% بائع + 2% مشتري**، بلا عمولة Wasit أساسية إضافية. رسوم مزوّد الدفع تبقى **منفصلة وغير متغيرة**.

### ما نُفّذ
- **محرك العمولة** (`lib/commission.ts`): يقرأ `rate`/`seller_rate`/`buyer_rate` من سياسة `commission_policies` فقط، ويعيد `totalAmount = sellerAmount + buyerAmount`. لا نسبة افتراضية في الكود؛ غياب سياسة مطابقة يفشل مغلقًا بـ`COMMISSION_POLICY_MISSING` (422).
- **Migration `0021_commission_split_data.sql`** (إضافية غير مدمِّرة): تُحوّل صف `BASE` الشكلي القديم (`3%` بائع فقط) إلى `rate=0.04, seller_rate=0.02, buyer_rate=0.02`؛ السياسات المخصّصة من الأدمن لا تُمس؛ الطلبات التاريخية تحتفظ بأرقامها؛ `buyer_commission` افتراضيًا `0` للصفوف القديمة.
- **محرك الطلب** (`modules/orders/service.ts`): يخزّن `orders.commission` = **الإجمالي 4%**، و`buyerCommission` = حصة المشتري (2%)، ويُسجّل قيدين في الـledger (SELLER وBUYER). `grandTotal` = قيمة البنود + حصة المشتري. قيد `TRANSACTION_VALUE` يبقى بقيمة البنود (لا تُدمج حصة المشتري في رصيد البائع).
- **منع الازدواج**: كل تجميعات العمولة/الإيراد صارت `sum(commission)` وحده (analytics، unit-economics، KPI الوكيل، daily-kpis) — لأن `commission` يحمل الإجمالي أصلًا. `commission + buyer_commission` لم يُستخدم في أي تجميع. وحصة البائع (`commissionAsSeller`) تُحسب `sum(commission - buyer_commission)` (2%) لتظهر في بطاقة لوحة التاجر كحصة البائع لا الإجمالي.
- **الواجهة وi18n**: جداول الأدمن للطلبات/المعاملات تعرض عمودَي حصة البائع/المشتري والإجمالي (`grandTotal`)؛ بطاقة دخل البائع في لوحة التاجر تعرض `sellerCommission`؛ مفاتيح ar/en/fr/zh مُحدَّثة (`order.commission` = إجمالي، وإضافة `order.sellerCommission`/`order.buyerCommission`).
- **التوثيق**: `ARCHITECTURE.md`، `ARCHITECTURE_DECISIONS.md` (AD-006 مُعاد كتابته + AD-042 جديد)، `REVENUE_MODEL.md`، `e2e/marketplace.spec.ts`.

### الاختبارات
- الحزمة الكاملة للخادم: **41 ملف / 421 اختبار — كلها خضراء** (بما فيها `vertical-slice`، `payments`، `analytics`، `unit-economics`، `revenue`، `commission`).
- `tests/analytics.test.ts` صار يتحقق صراحةً أن مجموع قيود COMMISSION في الـledger = عمولة الطلب الإجمالية (حرس ضد الازدواج).
- `npm run typecheck` (server + web) يمر بلا أخطاء.

### خارج النطاق / قرارات مطلوبة
- كشف الاسترداد حاليًا `min(قيمة الطلب الفرعية, refund_amount)` — لا يعيد حصة عمولة المشتري. إن طُلب احتسابها في الاستردادات فهذا قرار تجاري/محاسبي (Decision Required).

## Milestone C4 — MFA UI E2E: تحدي فعلي عند الدخول + واجهة كاملة (الجلسة السابقة — مكتمل)

### الهدف
إغلاق الفجوة C4 في `docs/PRODUCTION_GAP_LIST.md`: كان MFA "جاهزية backend" فقط — `enroll/confirm/disable/verify/status` موجودة، لكن **الدخول لا يتحدّى إطلاقًا**، فلا يوجد ما يُلزم المستخدم بالعامل الثاني، و**لا واجهة** لإدارة MFA. المطلوب: تحدي حقيقي عند الدخول + واجهة + E2E عبر الواجهة.

### المكوّنات
- `db/schema/auth.ts` — جدول `mfaChallenges` (`id`, `userId`, `tokenHash`, `attempts` افتراضي 0, `expiresAt`, `consumedAt`, `ipAddress`, `userAgent`, `createdAt` + فهرسان)؛ migration `0019_big_lockheed.sql` إضافية.
- `lib/env.ts` — `MFA_CHALLENGE_TTL_MINUTES` (افتراضي 5) و`MFA_CHALLENGE_MAX_ATTEMPTS` (افتراضي 5).
- `modules/auth/service.ts` — `loginUser` يعيد اتحادًا مميّزًا: `mfa_required` (يحمل `challengeToken` بلا أي كوكي) أو `success`؛ `completeMfaLogin` يستهلك التحدي (أحادي الاستخدام) ويؤكد TOTP أو رمز استرداد ثم يُصدر الجلسة عبر `issueSession` المشتركة. تحديث `users.mfaEnabled=false` يُبطل التحدي فورًا (فحص حالة الحساب).
- `modules/auth/routes.ts` — `/login` يعالج `mfa_required`، ومسار `/mfa/challenge` الجديد (rate-limit + Audit `AUTH.MFA_CHALLENGE_ISSUED/FAILED` + `AUTH.LOGIN`).
- الواجهة: `lib/types.ts` اتحاد `LoginResponse` بـ`mfaRequired`، `lib/api.ts` (`login`/`mfaChallenge`)، خطوة ثانية في `LoginPage`، وبطاقة `MfaCard` في `DashboardSecurityPage` (enroll/confirm/regenerate/disable) مع `testId` على `Card`/`Badge`، ومفاتيح i18n ar/en/fr.
- توافق رجعي: شكل الاستجابة المسطّح (`id/email/emailVerified/roles`) بقي كما هو مع إضافة `mfaRequired` فقط.

### التحقق
- `mfa-login-challenge.test.ts` — 10/10 (تحدي عند الدخول بلا جلسة، TOTP صحيح/خاطئ، رمز استرداد، أحادية الاستخدام، العدّاد، انتهاء الصلاحية، تعطيل الحساب).
- `e2e/mfa.spec.ts` — 2/2: (1) enroll→confirm→خروج→دخول يطالب بالعامل الثاني→verify→regenerate→disable→دخول بلا تحدٍّ؛ (2) رمز خاطئ يُرفض و`GET /api/auth/me` = 401. **كل الـE2E: 54/54**.
- الحزمة الكاملة للخادم: **41 ملف / 418 اختبار**؛ `tsc --noEmit` للخادم والواجهة = 0؛ `build:prod` (esbuild) نظيف.
- Smoke على `dist-bundle/index.cjs` تحت `NODE_ENV=production` مع Postgres حقيقي: login→enroll→confirm→logout→login(`mfaRequired:true`, بلا كوكي)→challenge(200 + جلسة)→me(200)→إعادة استخدام التحدي 401→رمز خاطئ 401→regenerate(10 أكواد)→disable→login بلا تحدٍّ. مسارات `dev/*` تُعيد 404 في production كما هو مقصود.

### القرار
تحدي MFA صفٌّ مستقل أحادي الاستخدام، لا flag داخل الجلسة — لا تُوجد جلسة قبل العامل الثاني. مسجَّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-041).

## Milestone C3 — Privacy/Consent موسّع + سياسات البلد (جلسة سابقة — مكتمل)

### الهدف
إغلاق الفجوة C3 في `docs/PRODUCTION_GAP_LIST.md`: كانت تغطية الخصوصية محصورة في `security-privacy.test.ts`، وقواعد الاحتفاظ بالبيانات **ثابتة في الكود** (`defaultRetentionDays: 90`, `preserves`, `legalHoldFinanciallyRequired`) داخل `modules/privacy/service.ts` — خرق مباشر للقاعدة #29 (لا قواعد تجارية/دولية مكتوبة في الكود).

### المكوّنات
- `db/schema/engine.ts` — `policyScopeEnum` يضم الآن `'PRIVACY'` (migration `0018_wise_typhoid_mary.sql`: `ALTER TYPE ... ADD VALUE`).
- `modules/privacy/service.ts` — `resolveRetentionForUser(db, userId)`: يحلّ القاعدة عبر `resolveMergedPolicy` (scope `PRIVACY`, code `DATA_RETENTION`) من دولة المستخدم (من `profiles.countryId`) ثم العالمي؛ يُسجّل غياب صف الدولة في `countryPolicyGaps` كـ`DECISION_REQUIRED` (لا اختراع مدة قانونية) ويغلقها عند وجود تجاوز. `createDeletionRequest` يخزّن الحلّ (المدة، `preserves`، `policySource/id/version`، `countryCode`) في `data_deletion_requests.retentionPolicy` و`retentionUntil`.
- `lib/country-policy-gaps.ts` — أنواع scope تشمل `PRIVACY`.
- `modules/admin/policy-routes.ts` — `GET/PUT /api/admin/policies/retention` و`GET .../retention/resolved` (`admin:policies` + Audit who/what/old/new/when/reason + رفع `version`).
- `scripts/seed.ts` — صف `DATA_RETENTION` عالمي (`defaultRetentionDays: 90` كقيمة seed لا كود).
- ثوابت مقصودة البقاء: مجموعة السجلات المالية/التدقيقية المحفوظة إلزاميًا (`transaction_ledger`, `audit_logs`, `disputes`, `orders`, `invoices`) — التزام بنيوي لا سياسة؛ الدولة تضيف إليها عبر `preserves`.
- الواجهة: بطاقة سياسة الاحتفاظ في `pages/AdminPolicyPages.tsx` + `api.adminRetentionPolicies/saveAdminRetentionPolicy` + مفاتيح i18n (ar/en/fr).

### التحقق
- `npx tsc --noEmit` (server + web) = 0؛ بناء الويب نظيف؛ `build:prod` نظيف.
- **408/408 اختبار** (40 ملف، منها `privacy-retention-policy.test.ts` بـ9 حالات: seed/global resolve، window مخزّن من السياسة، gap ثم تجاوز دولة يحلّه، تغيير المدة لدولة فقط، 422/403/401، القوائم/resolved، تدقيق + bump نسخة، consent append-only).

### القرار
- قواعد الاحتفاظ سياسةُ Country في Policy Engine، والغياب `Decision Required`. مسجَّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-040).

## Milestone C2 — Observability / Tracing (جلسة سابقة — مكتمل)

### الهدف
إغلاق الفجوة C2 في `docs/PRODUCTION_GAP_LIST.md`: كان التشخيص محصورًا في `traceId` داخل `core`/`errors` بلا مؤشرات ولا لوج مركزي ولا تنبيه، فيصعب تشخيص الإنتاج. المطلوب: tracing موزّع + metrics + logging مركزي + alerting، مع ظهور `trace_id` في اللوج والاستجابة.

### المكوّنات (خادم، `src/lib/observability/`)
- `trace.ts` — سياق W3C Trace Context: تبنّي `traceparent` الوارد (مع رفض الشكل الخاطئ/الإصدار ff/المعرّفات الصفرية) أو `x-trace-id` المجرّد أو توليد معرّف؛ `spanId` جديد لكل قفزة؛ `formatTraceparent`/`outboundTraceparent` للانتشار.
- `metrics.ts` — سجل Prometheus داخلي (counters/gauges/histograms) مع quantiles بالاستيفاء الخطي و`renderPrometheus`/`snapshot`.
- `logger.ts` — سطر JSON واحد على stdout + حلقة محدودة (200) + تنقيح مفاتيح الأسرار + فلترة بالمستوى.
- `alert-port.ts`/`notify.ts`/`resolve-notifier.ts`/`alerts.ts` — محرك قواعد (`database_down`/`http_error_ratio`/`http_p95_latency`/`rate_limit_rejections`/`alert_scheduler_stale`) بانتقالات FIRING/RESOLVED فقط، ومنفذ إشعار (`log` افتراضي، `webhook`).
- `middleware/observability.ts` — بديل `logger()` في Hono: سطر لوج واحد + عدّاد/هيستوغرام لكل طلب مع وسم route منخفض الكاردينالية (تطبيع UUID/hex/أرقام → `:id`/`:n`).
- `middleware/core.ts` — يحمل `TraceInfo` (traceId/spanId/parentId/flags) ويعيد `X-Trace-Id`؛ `middleware/errors.ts` و`lib/audit.ts` و`middleware/rate-limit.ts` تزيد عدّاداتها.
- جدول `alert_events` (`schema/observability.ts` + migration `0017_unusual_mephistopheles.sql` إضافية) — انتقالات فقط.
- `GET /metrics` (جذر، Prometheus) + مسارات admin `GET .../observability/{metrics,logs,alerts}` و`POST .../alerts/evaluate` (`admin:system` + Audit).
- الـscheduler يشغّل تقييم التنبيهات عند `OBS_ALERTS_ENABLED=true`؛ `GET /api/health/channels` يعرض حالة الـnotifier.

### التحقق
- `npx tsc --noEmit` = 0؛ **399/399 اختبار** (39 ملف، منها `observability.test.ts` بـ23 حالة).
- `build:prod` نظيف، وE2E حقيقي عبر `dist-bundle/index.cjs` مع Postgres: `traceparent` وارد ⇒ نفس `X-Trace-Id` في الاستجابة، `/metrics`=200 بمؤشرات حقيقية، `db_up=1` بعد tick، admin بلا جلسة=401، ومع جلسة admin: metrics/logs/alerts/evaluate=200 + Audit.

### القرار
- لا منصة خارجية ولا OpenTelemetry كامل؛ طبقات trace/metrics/log/alert على stdout + `/metrics` قابلة للربط بأي منصة. مسجَّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-039).

## Milestone C1 — Distributed Rate-Limit Store (جلسة سابقة — مكتمل)

### الهدف
إغلاق الفجوة C1 في `docs/PRODUCTION_GAP_LIST.md`: كان حدّ المعدل خريطةً داخل ذاكرة كل عملية، فبتشغيل أكثر من نسخة API تتضاعف الحدود الفعلية وتصبح غير فعّالة.

### المكوّنات (خادم)
- طبقة مخزن جديدة `src/lib/rate-limit/`: `port.ts` (العقد)، `memory.ts`، `postgres.ts`، `resolve.ts`.
- جدول `rate_limit_counters` (`schema/rate_limit.ts` + migration `0016_breezy_lester.sql` إضافية) — عدّادات فقط، بلا PII.
- `middleware/rate-limit.ts` يفوّض للمخزن؛ الموضوع `user:<id>` للمصادَق و`ip:<ip>` للمجهول.
- purge دوري في `lib/scheduler.ts` + مسار `POST /api/admin/rate-limits/purge` (`admin:system` + Audit).
- `GET /api/health/channels` يعرض `rateLimit.{store,durable}`.

### التحقق
- `npx tsc --noEmit` = 0؛ **376/376 اختبار** (38 ملف، منها `rate-limit.test.ts` بـ12 حالة).
- `build:prod` نظيف، وE2E حقيقي عبر `dist-bundle/index.cjs` مع `RATE_LIMIT_STORE=postgres`: burst → `200×5 ثم 429×2`، `durable:true`، وثبات العدّاد عبر إعادة تشغيل العملية.

### القرار
- **لا Redis** (Postgres كافٍ، العقد يسمح بإضافته لاحقًا). مسجَّل في `docs/ARCHITECTURE_DECISIONS.md` (AD-038).

## Milestone B1 — SEO (هذا الجلسة — مكتمل)

### الهدف
اكتشاف العام (المنتجات/الموردين/الشركات/التصنيفات/الأسواق) عبر محركات البحث: sitemap ديناميكي + robots + canonical + JSON-LD، دون كشف أي سطح خاص.

### المكوّنات (خادم)
- وحدة جديدة `src/modules/seo/`:
  - `service.ts` — `buildSitemap` (رئيسية/سوق/موردون/تجّار/شركات/تصنيفات + منتجات `ACTIVE` **منشورة** + موردون/شركات/تجّار `is_active` + أسواق البلدان النشطة؛ سقف 5000؛ `lastmod` حيث توفّر)، `renderSitemapIndex` (XML مُهرَّب)، `renderRobots` (Allow للعام، Disallow لـ `/admin`/`/dashboard`/`/onboarding`/`/checkout`/auth/`/search`/`/api/`)، ودوال بناء الروابط.
  - `jsonld.ts` — `productJsonLd` (schema.org Product + Offer، يُرفض غير ACTIVE/غير منشور)، `supplierJsonLd`/`companyJsonLd`/`merchantJsonLd` (Organization/Store، تُرفض غير النشطة)، `categoryJsonLd` (CollectionPage، يُرفض غير النشط)، `countryJsonLd` (Place، يُرفض غير النشط).
  - `routes.ts` — `seoRoutes` مركّبة على الجذر (`/sitemap.xml`, `/robots.txt`, بلا مصادقة، بيانات عامة فقط) و`seoApiRoutes` على `/api/seo` (`GET /structured-data/:type/:id`؛ 404 لغير العام، 422 لنوع غير معروف).
- `app.ts`: `app.route('/', seoRoutes)` و`app.route('/api/seo', seoApiRoutes)`.

### المكوّنات (واجهة)
- مكوّن `SeoHead` يزامن `title`/`description`/Open Graph/`canonical`/`robots`/JSON-LD.
- ربطه بـ: Home (JSON-LD Organization)، Marketplace (noindex عند الفلاتر/الترقيم)، Search (noindex)، Product (Product JSON-LD)، Suppliers، Merchants، Companies، Categories.
- صفحتان جديدتان: `/categories/:slug` و`/markets/:code` (بيانات حقيقية + canonical + JSON-LD).
- `vite.config.ts`: وسيط الجذر لـ `/sitemap.xml` و`/robots.txt` (مثل `/api`).

### النتائج
- ✅ **272/272** اختبار خادم — 30 ملفًا (كان 262/29).
- ✅ **49/49** اختبار E2E (كان 44/44).
- ✅ بناء Web (tsc + vite) وبناء الخادم يمرّان.
- ✅ Docs: `PRODUCTION_GAP_LIST.md` (B1 → ✅).

## Milestone B6 — Favorites / Saved / Search History (مكتمل)

### الهدف
تفعيل جداول `favorites`/`saved_items`/`search_history` التي كانت موجودة دون استخدام، كميزة كاملة (UI → API → DB → RBAC → Tests).

### المكوّنات
- وحدة خادم جديدة `modules/customer-library` مركّبة على `/api/library`:
  - المفضلة: `GET/POST /favorites`، `DELETE /favorites/:entityType/:entityId` (idempotent عند الإضافة).
  - المحفوظات: `GET/POST /saved` (تحديث الملاحظات عند إعادة الحفظ)، `DELETE /saved/:itemType/:itemId`.
  - سجل البحث: `GET/POST /search-history`، `DELETE /search-history` (مسح)، `DELETE /search-history/:id` (يملكه المستخدم فقط)، تشذيب تلقائي عند 200 سجل/مستخدم.
  - تحقّق من وجود الكيان قبل الحفظ (404 بنيوي)، وإثراء العرض بالعنوان/Slug مع علم `available`.
- صلاحيات جديدة في `@wasit/shared`: `favorite:manage`، `saved:manage`، `search:history:manage` — مُمنوحة صراحةً للأدوار (CUSTOMER/MERCHANT/SUPPLIER/COMPANY/MARKETER/ADMIN؛ SUPER_ADMIN شامل).
- `GET /api/search` صار يستخدم `optionalAuth` ويسجّل بحث المستخدم المصادَق (best-effort، لا يكسر البحث).
- الواجهة: صفحة `/dashboard/library` بثلاث تبويبات، أزرار مفضلة/حفظ على صفحة المنتج، عنصر تنقّل في الشريط الجانبي، مفاتيح i18n (ar/en/fr).

### النتائج
- ✅ **262/262** اختبار خادم — 29 ملفًا (كان 248/28).
- ✅ **44/44** اختبار E2E (كان 39/39).
- ✅ Docs: `PRODUCTION_GAP_LIST.md` (B5 و B6 → ✅).

## Milestone B5 — Geo Testing (مكتمل)

### الهدف
إغلاق فجوة مخاطرة التوسّع: تغطية geo module (15 route) باختبارات حقيقية ضد PostgreSQL.

### المكوّنات
- `tests/geo.test.ts` — **16 حالة** تغطي:
  - **countries**: القائمة تُظهر النشط فقط + ترقيم؛ بحث عبر الاسم العربي/الإنجليزي؛ الجلب `:id` و`by-code` (حالة أحرف غير حساسة)؛ إخفاء غير النشط بـ 404 بنيوي `NOT_FOUND`؛ id مجهول → 404.
  - **regions**: حسب الدولة + ترقيم + بحث؛ الجلب id؛ إخفاء غير النشط.
  - **cities**: حسب المنطقة وحسب الدولة (join)؛ بحث؛ الجلب id؛ إخفاء غير النشط.
  - **currencies**: الترتيب حسب code؛ قواعد TND (decimals=3، symbol د.ت)؛ by-code/`id`؛ مجهول → 404.
  - **languages**: ترتيب sortOrder (العربية أولًا)؛ `isRtl` للعربية؛ by-code/id؛ مجهول → 404.
  - **exchange-rates**: فلترة `fromCode`/`toCode` مع تطبيع الحالة؛ قائمة فارغة مقبولة.
- fixtures (بلد/منطقة/مدينة غير نشطة + سعر صرف) تُنظَّف بعد السويت.

### النتائج
- ✅ **248/248** اختبار خادم — 28 ملفًا (كان 232/27).
- ✅ Docs: `PRODUCTION_GAP_LIST.md` (B5 → ✅).

## Milestone B4 — Country Generalization (مكتمل)

### الهدف
إغلاق فجوة التوسّع: بلد ثانٍ + قواعد محلية + تفعيل من Admin، دون إعادة بناء الـ Core ودون أي `'TN'` hardcoded.

### المكوّنات
- **Seed**: `FR` (EUR، `fr`، region IDF) كسوق candidate غير مفعّل؛ `TN` يبقى المفعّل الوحيد.
- **Admin** (`modules/admin/country-routes.ts`، صلاحية `admin:policies`):
  - `GET /api/admin/countries` — كل الدول (نشطة/مرشحة) بحالتها وعملتها ولغتها و`activatedAt`.
  - `PUT /api/admin/countries/:id/activation` — تفعيل/إيقاف مع `reason` إلزامي، تعيين `activatedAt` عند أول تفعيل، وAudit `COUNTRY.ACTIVATED`/`COUNTRY.DEACTIVATED` (before/after/reason).
- **Web**: قسم "الأسواق والدول" في `/admin/policies` يعرض الدول وزرّ التفعيل/الإيقاف مع حقل السبب + i18n (ar/en/fr).
- **ملاحظة**: تفعيل السوق قرار تجاري/قانوني؛ الآلية فقط هي ما بُني، ولا قواعد قانونية لكل بلد (`country_policy_gaps` من A5 تبقى DECISION_REQUIRED حتى تُعرَّف).

### الاختبارات
- `tests/country-activation.test.ts` — **6 حالات**: القائمة تُظهر المرشّح، التفعيل يضبط `is_active`/`activated_at` + Audit، دولة مجهولة → 404 `NOT_FOUND` بنيوي، سبب قصير → 422، SUPPORT/anon → 403/401، الإيقاف يعيد الحالة + Audit.

### النتائج
- ✅ **232/232** اختبار خادم — 27 ملفًا (كان 226/26).
- ✅ **39/39** E2E (كان 38/38).
- ✅ `tsc` (server + web) و`vite build` نظيفان.
- ✅ Docs: `PRODUCTION_GAP_LIST.md` (B4 → ✅).

## Milestone A5 — Per-Country Dispute Policy (مكتمل)

### الهدف
تحميل قواعد النزاع من `policies` حسب `countryId` مع fallback عالمي — آلية DB-driven بلا أي `if (country === 'TN')`. الوثيقة المرجعية لا تحدد مددًا أو إجراءات قانونية لكل بلد، لذا لم يُختَرع أي منها (تُسجَّل كـ DECISION_REQUIRED).

### المكوّنات
- **Policy Engine** (`lib/policy-engine.ts`): `resolvePolicy` (صف الدولة يتغلب على العالمي)، `resolveMergedPolicy` (دمج: الحقول الناقصة تُورَّث من العالمي، والقيم `undefined/null` لا تمسح قيمة عالمية)، `upsertCountryPolicy` (إنشاء/تحديث مع رفع الإصدار).
- **Country resolver** (`lib/country.ts`): `resolveOrderCountry` يستنتج الدولة من كيان البائع (supplier/merchant/company) ثم من ملف المشتري — لا hardcode.
- **Gap tracker** (`lib/country-policy-gaps.ts`): جدول `country_policy_gaps` (migration `0011_glorious_toxin`) يسجّل `DECISION_REQUIRED` عند دولة بلا سياسة محلية، ويوسمها `RESOLVED` عند إضافتها.
- **Dispute service**: `getDisputePolicyForOrder` يُرجع `{ rules, source: 'COUNTRY'|'GLOBAL', countryId, countryCode, policyId, version }`؛ `resolveAppealRules` صار country-aware؛ `DisputeDetail` يحمل `countryId/countryCode/policySource`.
- **API**: `GET /api/disputes/policies` (متوافق للخلف: بلا orderId يعيد `{rules}`؛ مع `orderId` يعيد السياق القُطري). `GET/PUT /api/admin/policies/dispute` + `GET /api/admin/policies/dispute/resolved` (صلاحية `admin:policies`، Audit لكل تغيير).
- **Web**: صفحة `/admin/policies` (عرض السياسات + الفجوات المفتوحة + محرر قواعد لكل دولة) + مفتاح sidebar + i18n (ar/en/fr).
- **Seed**: أُضيفت `FR` كسوق candidate غير مفعّل (مع منطقة) لإثبات الطبقات — تفعيله قرار تجاري/قانوني.

### القرارات
- **Country → Global layering** مع تسجيل فجوة عند غياب السياسة المحلية بدل اختراع قواعد (AD-020، AD-013).
- **عقد متوافق للخلف** لـ `/api/disputes/policies` كي لا ينكسر A4 (AD-021).
- **لا Wallet ولا حركة مالية** — السياسة تؤثر فقط على القرار/النافذة الزمنية.

### الاختبارات
- `tests/dispute-country-policy.test.ts` — **8 حالات**: fallback عالمي + تسجيل gap، تغلب سياسة الدولة + `source=COUNTRY`، عقد `?orderId=`، رفض استئناف خارج نافذة الدولة (FR=1 يوم) بينما العالمي = 7، منع غير الأدمن (403) من endpoints السياسة، إنشاء/تحديث يرفع الإصدار ويحل gap ويسجّل Audit، تحقق payload (422)، قائمة السياسات + الفجوات.
- `tests/disputes.test.ts` — A4 مُصحَّح ليطابق الصف العالمي (`isNull(countryId)`) ويظل ناجحًا (10 حالات).

### النتائج
- ✅ **226/226** اختبار خادم — 26 ملفًا (كان 218/25).
- ✅ **38/38** E2E (الـ 35 القائمة + 3 حالات في `e2e/policies.spec.ts`).
- ✅ `tsc` (server + web) و`vite build` نظيفان.
- ✅ Docs محدّثة: `PRODUCTION_GAP_LIST.md` (A5 → ✅) و`ARCHITECTURE_DECISIONS.md` (AD-020..022).

## Milestone A4 — Dispute Appeal (مكتمل)

### الهدف
تفعيل حق الاستئناف على قرار النزاع. الجدول `dispute_appeals` كان موجودًا ومستوردًا لكن بلا مسار أو خدمة (A4 كان ❌ في gap list).

### المكوّنات
- **Schema**: توسيع `dispute_appeals` بـ `decision_note`/`decided_at`/`updated_at` + فهرس `status` (migration `0010_brief_absorbing_man`، مطبَّق عبر `drizzle-kit migrate` — لا DDL يدوي).
- **Service** (`modules/disputes/service.ts`):
  - `createDisputeAppeal` — للأطراف على الطلب فقط؛ مسموح فقط للنزاع `DECIDED`/`CLOSED` مع `appealAllowed=true`؛ dedupe لاستئناف `PENDING`؛ نافذة زمنية و`maxAppeals` مقروءة من سياسة `DISPUTE_RESOLUTION`.
  - `listDisputeAppeals` — يخضع لنفس `requireDisputeAccessOrThrow` (طرف أو مشغّل).
  - `reviewDisputeAppeal` — قبول يعيد فتح النزاع (`UNDER_REVIEW`) ويعطّل `appealAllowed`؛ رفض يترك القرار قائمًا؛ **تنحّي** من أصدر القرار الأصلي (403).
  - أحداث `APPEALED`/`REOPENED`، وaudit `DISPUTE.APPEAL.CREATED`/`DISPUTE.APPEAL.REVIEWED`/`DISPUTE.REOPENED`، وإشعارات للمُسند إليه وللمستأنف.
- **API**: `GET/POST /api/disputes/:id/appeals` (مستخدم)، `GET /api/admin/disputes/:id/appeals` و`POST /api/admin/disputes/:id/appeals/:appealId/review` (مشغّل؛ الصلاحيات الحالية `DISPUTE_REVIEW`/`DISPUTE_MANAGE` — لا تغيير في RBAC).
- **Web**: بطاقة الاستئنافات + نموذج رفع الاستئناف في `DashboardDisputesPage`، وبطاقة مراجعة الاستئناف في `AdminDisputesPage`، ومفاتيح i18n بالعربية/الفرنسية/الإنجليزية/الصينية.

### القرارات
- **لا استئناف من الموظفين**: حق الاستئناف مملوك لأطراف الطلب فقط، منعًا لتضارب المصالح (الموظفون يراجعون).
- **حدود الاستئناف من Policy** لا من الكود: العتبات الافتراضية (7 أيام، استئناف واحد) تُقرأ من `DISPUTE_RESOLUTION` مع fallback آمن إن غابت السياسة.
- الاستئنافات لا تُنشئ Wallet ولا حركة مالية — إعادة فتح النزاع فقط.

### الاختبارات
- `tests/disputes.test.ts` — **10 حالات**: إنشاء استئناف + ظهوره (detail/list/audit/event)، منع غير الطرف (403) ومنعه من القراءة، رفض نزاع غير مبتوت (409)، منع الاستئناف المكرر أثناء PENDING، احتساب `maxAppeals`، نافذة الاستئناف المنتهية، `appealAllowed=false`، قبول يعيد الفتح + إشعار، تنحّي صاحب القرار (403) ثم قبول من مراجع آخر، تحقّق payload (422)، جلسة مطلوبة (401)، عقد سياسة الاستئناف.
- `e2e/disputes.spec.ts` — **3 حالات** (Playwright، API حقيقي + PostgreSQL).

### النتائج
- ✅ **218/218** اختبار خادم — 25 ملفًا (كان 208/24).
- ✅ **35/35** E2E (كان 32/32).
- ✅ `tsc` (server + web) و`vite build` نظيفان.
- ✅ Docs محدّثة: `PRODUCTION_GAP_LIST.md` (A4 → ✅).

## Milestone 1 — Payment Kernel (مكتمل)

### المكوّنات
- **Provider Abstraction**: `packages/server/src/lib/payments/providers.ts` — واجهة `PaymentProviderPort` مع `manual` (offline/اختباري) و`stripe`-style HMAC، قابلة للتبديل دون لمس الخدمات. `mapEventType()` يطبّع أحداث المزوّد الداخلية.
- **Intents**: `POST /api/payments/orders/:orderId/intent` — idempotent حسب `idempotencyKey`؛ إعادة المفتاح تُعيد الـ intent نفسه ولا تُنشئ ثانيًا. الجدول `payment_intents` (migration `0008`).
- **Webhooks**: `POST /api/payment-webhooks` (خارج الجلسة، موقّع HMAC) — طبّع الحدث، idempotency عبر `(provider, event_id)`، تحديث حالة الطلب/الدفع، وتسجيل audit.
- **Refunds**: `POST /api/payments/orders/:id/refunds` بصلاحية `refund:manage` — idempotency، منع over-refund، وقيد `REFUND` مقابل في Transaction Ledger. القراءة (`GET /orders/:id`, `GET /orders/:id/refunds`) مسموحة لطرفي الطلب (buyer/seller) عبر `assertOrderAccess`، وللمشغّلين عبر `payment:read`.
- **UI**: `CheckoutPage.tsx` يُنشئ الطلب ثم يطلب الـ intent، ويعرض حالة الدفع (`payment.status`) من الـ API.

### الإصلاحات الجذرية في هذه الجلسة
- **DB migration drift**: قاعدة `wasit_dev` كانت متأخرة عن الـ journal بـ migration `0008` (8 صفوف journal مقابل 10 في `wasit_test`)، فكانت جداول الدفع غير موجودة → `500 relation "payment_intents" does not exist`. أُصلح بتشغيل الـ migrator الحقيقي (`drizzle-kit migrate`)، وأزيل أي DDL يدوي مطبَّق سابقًا. الآن dev عند 10/10 migrations مطابقًا للاختبار.
- **Authorization bug**: `GET /api/payments/orders/:id` كان مقيَّدًا بـ `payment:read` (صلاحية مشغّلين فقط) فيُرفض المشتري على طلبه الخاص بـ 403، رغم أن الـ service يتحقق من الملكية. نُقل التقييد إلى ownership-scoped access في الـ service.
- **E2E flakiness / fixture determinism**: الـ demo seeder idempotent ويحافظ على المخزون المستهلك، فتتراكم الطلبات حتى ينفد المخزون. أُضيف `SEED_RESET_STOCK=1` (يُستخدم في `e2e/global-setup.ts` فقط) لإعادة مخزون المنتجات التجريبية قبل كل دورة، وأُدخل مساعد `placeOrderViaUi` مشتركًا في `e2e/helpers.ts` يختار منتجًا يقبل الطلب.
- **`refund.succeeded` mapping**: كان يُطابَق كنجاح دفع عام لأن `"succeed"` substring؛ نُقل فرع refund قبل الفرع العام.

### النتائج
- ✅ **208/208** اختبار خادم (`packages/server`) — 24 ملفًا.
- ✅ **33/33** E2E (Playwright) — دورتان متتاليتان متطابقتان بعد إصلاح الـ fixture.
- ✅ `npm run build` (server + web) ناجح؛ `tsc --noEmit` نظيف.
- ✅ Docs محدّثة: `PRODUCTION_GAP_LIST.md` (A1/A2/A3 → ✅).

### ملاحظة نموذج الإيراد
لا Wallet. WASIT لا يحتفظ بأرصدة. الـ Ledger يسجّل فقط (value/commission/fees/refund/settlement/status). العمولة 4% (2% بائع + 2% مشتري) تأتي من Commission/Policy Engine — ليست hardcoded.

## الوضع الحالي

- الخادم يعمل على `http://localhost:3000` (Development)
- الواجهة تعمل على `http://localhost:5173` (Vite dev, proxy `/api` → 3000)
- البنية: Monorepo (server + web)
- قاعدة البيانات: PostgreSQL `wasit_dev` + قاعدة اختبار `wasit_test`
- `tsc` (typecheck server) — **ناجح (0 خطأ)**
- `tsc` (typecheck web) — **ناجح (0 خطأ)**
- الاختبارات التكاملية (vitest ضد `wasit_test`) — **56/56 ناجحة** (حتى PHASE 12: 45 سابقة + 11 جديدة للإعلانات) — آخر تحديث في قسم PHASE 12 أدناه
- البناء الإنتاجي للويب (`npm run build`) — **ناجح**

## وحدة Messaging & Communication (هذا الجلسة — مكتملة)

### Backend (`packages/server/src/modules/messaging/` + `notifications/`)
- محرك محادثات حقيقي على PostgreSQL: `threads`, `thread_participants`, `messages` (+ `status`/`read_at` via migration `0002`)
- مسارات API:
  - `GET /api/messages` — قائمة المحادثات مع `unreadCount`, `lastMessage`, `participants`, بحث (`?q=`) + pagination
  - `POST /api/messages` — فتح محادثة مباشرة بين مستخدمين + إرسال أول رسالة
  - `GET /api/messages/:threadId` — تفاصيل المحادثة + الرسائل + تعليم القراءة تلقائياً (read receipt)
  - `POST /api/messages/:threadId/messages` — إرسال رسالة (SENT → DELIVERED → READ)
  - `POST /api/messages/:threadId/read` — تعليم المحادثة مقروءة
  - `GET /api/messages/search?q=` — بحث في المحادثات والرسائل (ILike، يدعم العربية)
  - `GET /api/notifications` + `/unread-count` + `POST /:id/read` + `/read-all`
- RBAC: `MESSAGE_SEND` + `MESSAGE_READ_OWN` (ممنوحة لكل الأدوار في `@wasit/shared`)
- الملكية (Ownership): غير المشارك يحصل 403 على القراءة/الإرسال في محادثة ليست له
- Validation (zod): رسالة فارغة/ضخمة مرفوضة (422)، الإرسال لنفسك مرفوض، مستخدم غير موجود → 404
- كل إرسال/إنشاء محادثة يُسجَّل في Audit: `MESSAGING.THREAD_CREATE`, `MESSAGING.MESSAGE_SEND`
- إشعارات فورية داخل المنصة عند كل رسالة جديدة (`MESSAGE.NEW`)

### Frontend
- `DashboardMessagesPage.tsx` — واجهة رسائل كاملة (RTL، رفين: قائمة محادثات + محادثة)، بحث مباشر، شارات غير مقروء، فقاعات مرسلة/مستلمة مع إيصال قراءة ✓/✓✓، صندوق إرسال (Enter للإرسال)، نافذة محادثة جديدة
- `NotificationsBell.tsx` — جرس إشعارات في `TopHeader` مع عداد غير مقروء + قائمة منسدلة + تحديد الكل كمقروء + رابط للرسائل
- i18n كاملة (ar/fr/en/zh) مع إزالة `messages.roadmap` ووضع مفاتيح حقيقية

### Integration Tests (`tests/messaging.test.ts` — 10 اختبار)
فتح محادثة + إشعار، unread/read status، منع المشارك غير المصرّح (403) قراءة/إرسال، منع الرسالة لنفسك، مستخدم غير موجود (404)، validation، auth (401)، بحث مع ملكية، إشعارات (قائمة/read-all)، منع كشف إشعارات الآخرين.

### التحقق المباشر (Live E2E على الخادم)
- curl: عميل → فتح محادثة مع مورد (عربي) → قائمة الطرفين مع unread صحيح → المورد يقرأ فيتحول status=READ → رد المورد يعيد unread للعميل → بحث عربي "قهوة" يجد الرسالة → إشعارات MESSAGE.NEW
- المتصفح (customer1): فتح لوحة الرسائل → المحادثة تظهر باسم المورد + آخر رسالة + عداد غير مقروء 1 → فتح المحادثة → رسالة المورد status READ → كتابة رسالة عربية جديدة → تظهر SENT فوراً → بحث "قهوة" يصفّي للخيط الصحيح → جرس الإشعارات يعرض "1" → mark-all → صفر → محادثة جديدة مع merchantA تُنشأ فعلياً في DB وإشعار غير مقروء يصل merchantA

### Checkpoint ZIP (2026-09-13)
- الأرشيف: `WASIT_BUSINESS_GLOBAL_CHECKPOINT_MESSAGING.zip` — في جذر المشروع
- يُستبعد منه: `node_modules`, `.env` (الأسرار), `dist`, `*.zip`، `.git`
- يُوزَّع عبر `python3 -m http.server 12000` ثم `https://work-1-qpzssfljriaoounj.prod-runtime.all-hands.dev/WASIT_BUSINESS_GLOBAL_CHECKPOINT_MESSAGING.zip`
- Commit الـ checkpoint: `188ca71` — `feat: complete messaging & notifications module`
- **Push إلى GitHub**: غير ممكن بهذا الـ token (صلاحيات محدودة — `403 resource not accessible` / `push denied`). النية موثقة: إنشاء مستودع `wasit-business-global` والدفع عليه. لا remote مُعرّف حاليًا — ينفَّذ بمجرد توفر token بصلاحية `repo`.

## وحدة Inventory (هذا الجلسة — مكتملة)

### Backend (`packages/server/src/modules/inventory/` + `lib/inventory-engine.ts`)
- سجلات مخزون على مستوى المنتج + المتغير (product/variant) مع `quantity`, `reservedQuantity`, `lowStockThreshold`
- حركات ذرّية عبر `applyStockMovement`: `RESERVATION`, `RELEASE`, `SALE`, `PURCHASE`, `ADJUSTMENT`, `RETURN`
- مسارات API:
  - `GET /api/inventory` — قائمة مع filters (`LOW_STOCK`/`OUT_OF_STOCK`/`IN_STOCK`) + بحث + pagination
  - `GET /api/inventory/:id` — تفاصيل صنف + `availableQuantity` + `lowStock` + `outOfStock`
  - `POST /api/inventory/:id/adjust` — تعديل كمية (+/−) مع `movementType` و`reason`
  - `PATCH /api/inventory/:id` — ضبط `quantity`/`reservedQuantity`/`lowStockThreshold`
  - `GET /api/inventory/:id/movements` — سجل الحركات
- RBAC: `INVENTORY_READ`/`INVENTORY_UPDATE`/`INVENTORY_MOVEMENT_CREATE` (#blocked for CUSTOMER → 403)
- الملكية: `resolveOwnedSellerId` — يجد entity المورد/التاجر/الشركة المملوكة للمستخدم
- كل تعديل يُسجَّل في Audit: `INVENTORY.ADJUST` مع before/after

### Frontend (`packages/web/src/pages/DashboardInventoryPages.tsx`)
- لوحة كاملة عربية/RT L: KPIs (إجمالي/متوفر/منخفض/نفد), جدول مخزون, فلاتر, بحث, pagination
- نوافذ تعديل (إضافة/خصم/إعدادات), سجل حركات, شارات المخزون المنخفض, صفحة مقارنة الأسعار
- ترجمة i18n (ar/en/fr/zh)

### Integration Tests (`tests/inventory.test.ts` — 11 اختبار)
قائمة، بحث، pagination, adjust, set, variants, منع وصول غير المالك, سجل الحركات.

### إصلاحات أُثبتت بالاختبارات
1. **ملكية الطلبات**: `getOrder`/`updateOrderStatus`/`listMyOrders` كانت تقارن seller entity ID بالمستخدم مباشرة → أضيف `ownedSellerIds()` — يحل 403 للموردين
2. **دلالات الإلغاء**: الطلب PENDING (لم يُنفَّذ) → `releaseReservation` (بدل `restoreStockForCancelledOrder` الذي كان يخصم مرتين). الطلب المنفَّذ → استعادة + ledger return

### Migration `0001`
- فهارس فريدة جزئية على `inventory_items` (product+variant) لمنع تكرار سجلات المخزون

### Seed Backfill (`seed-demo.ts`)
- يُرجع المخزون للمنتجات الموجودة مسبقًا بدون سجلات مخزون عبر `ensureInventoryItem` + تعبئة الكميات من التعريفات
- متحقق: `supplierA` → SUP-OO-5L-001 (qty 400, thr 40), SUP-DT-10K-002 (qty 120, thr 20)

### التحقق المباشر (Live E2E على الخادم)
- تسجيل مورد → إنشاء منتج `initialQuantity:50` → سطر المخزون يُنشأ تلقائياً
- طلب عميل كمية 4 → **reserved 4, available 46**
- تأكيد المورد → qty 46, reserved 0
- طلب ثانٍ كمية 6 → reserved 6 → إلغاء → **reserved 0, qty بدون تغيير 46**
- تعديل `+5` → qty 51; سجل الحركات يعرض 5 أحداث
- عميل → `/api/inventory` → **403 FORBIDDEN**
- المتصفح: تسجيل دخول مورد → خصم 10 بملاحظة عربية "جرد دوري" → الصف يصبح 110 → نافذة الحركات تعرض `SALE −10`

### Checkpoint ZIP (2026-09-13)
- الأرشيف: `WASIT_BUSINESS_GLOBAL_CHECKPOINT_INVENTORY.zip` (260KB، 144 ملف) — في جذر المشروع
- يُستبعد منه: `node_modules`, `.env` (الأسرار), `dist`, `*.zip`، `.git`
- يُشغَّل للتحميل عبر: `python3 -m http.server 12000` ثم `https://work-1-qpzssfljriaoounj.prod-runtime.all-hands.dev/WASIT_BUSINESS_GLOBAL_CHECKPOINT_INVENTORY.zip`
- Commit الـ checkpoint: `a165bfa` — `feat: complete inventory module`

### متغيرات Env جديدة
- `RATE_LIMIT_REGISTER_MAX` (افتراضي 10), `RATE_LIMIT_LOGIN_MAX` (افتراضي 15) — مرفوعة في `vitest.config.ts` لتجنب 429 في الاختبارات

## التحقق الفعلي من Admin (هذا الجلسة)

1. **مصادقة (Authentication)**
   - مستخدم غير مسجل → `401` على كل `/api/admin/*`
   - تسجيل دخول عميل → `roles: ["CUSTOMER"]` بعد إصلاح خلل الدور اليتيم
   - تسجيل دخول Admin → `roles: ["ADMIN","SUPER_ADMIN","CUSTOMER"]`
   - مستخدم معطَّل → `403 "Account disabled"`
2. **Admin Users**
   - `GET /api/admin/users` → 200 مع 5 مستخدمين حقيقيين من DB
   - `PATCH /api/admin/users/:id/status` → 200 يعطّل/يفعّل فعلياً (login بعد التعطيل فشل بـ403)
   - الحالة تُسجَّل في Audit: `ADMIN.USER_STATUS` مع actorId
3. **Transaction Ledger**
   - `GET /api/admin/ledger` → 200: إدخالات حقيقية (TRANSACTION_VALUE 16150 دائن، COMMISSION 484.5 مدين، PAYMENT_FEE 323 مدين)
3.5. **صلحت خلل عرض** في الويب: كانت الواجهة تقرأ `referenceType` بينما الـ API يعيد `entryType` — أضفت مفاتيح i18n `ledger.entry.*` وأظهرت الترجمة
4. **Audit Logs**
   - `GET /api/admin/audit-logs` → 200: سجلات حقيقية (AUTH.LOGIN, ADMIN.USER_STATUS, ORDER.CREATE, PRODUCT.CREATE, SUPPLIER/MERCHANT/COMPANY.CREATE, AUTH.REGISTER)
5. **RBAC & Permissions**
   - Admin → 200 على كل مسارات admin السبعة
   - Customer → `403` على كل مسارات admin
   - واجهة الويب: Customer يرى "Forbidden: Admin area" عند زيارة `/admin`
6. **KPIs**
   - `/api/admin/stats` → `{users:5, products:6, orders:1, gmv:16150}` — مطابق لعدّات DB المباشرة
7. **أكواد الخطأ**
   - `401` (غير مصدّق)، `403` (ممنوع/معطّل)، `404` (مورد غير موجود)، `409` (بريد مكرر)، `422` (validation)

## ما تم إنجازه (مؤخراً)

1. **إصلاح معالجة الأخطاء**: استبدال errorHandlerMiddleware بالتقاط `app.onError`
   - أخطاء HTTP الصحيحة تعود الآن برموزها (403 بدل 500، 409 بدل 500، 422...)
   - `traceId` يتضمن لكل استجابة خطأ
2. **RBAC فعلي على الكيانات التجارية**:
   - `POST /api/suppliers` → `requireRole('SUPPLIER')`
   - `POST /api/merchants` → `requireRole('MERCHANT')`
   - `POST /api/companies` → `requireRole('COMPANY')`
   - متحقق live: CUSTOMER → 403، الأدوار الصحيحة → 201
3. **وحدة Admin كاملة** (`/api/admin`):
   - `requireAuth + requireRole('ADMIN', 'SUPER_ADMIN')` على كل المسار
   - مسارات: `/stats`, `/users`, `/users/:id/status`, `/orders`, `/transactions`, `/ledger`, `/products`, `/audit-logs`
   - Audit على تغيير حالة المستخدم
   - متحققة live: ADMIN → 200، CUSTOMER → 403
4. **اختبارات البنية التحتية**:
   - `tests/setup.ts` يعيد إنشاء قاعدة اختبار + يجري migrations + seeder تلقائياً
   - `tests/vertical-slice.test.ts` — اختبارات E2E (Register, Login, RBAC, Product, Search, Order, Commission, Ledger, Audit, MOQ, 401, وأمان إنشاء المستخدم)
   - `tests/admin-access.test.ts` — اختبار Admin شامل (الوصول للـ7 مسارات، حظر CUSTOMER، سجل AUDIT عند تغيير الحالة)
5. **إصلاح خلل `registerUser`** (أولوية النزاهة):
   - كان يُدخل المستخدم قبل التحقق من وجود الدور → مستخدم يتيم بدون role عند فشل seed
   - الآن يتم حل الدور قبل الإدخال → فشل عند عدم وجود الدور لا يترك سجلاً مكسوراً
   - أُضيف اختبار انحدار "never creates an orphan user"
6. **فصل tsconfig**:
   - `tsconfig.json` (typecheck شامل مع tests، noEmit)
   - `tsconfig.build.json` (build من src فقط)
   - build script → `tsc -p tsconfig.build.json`

## الاعتماديات المعتمدة

- `hono@4.13.7` (param `'id'` يمكن أن يعيد `string | undefined` — استُخدم `!`)
- `@wasit/shared` (PERMISSIONS / PermissionKey / ApiError / userHasAnyRole)
- `drizzle-orm` (eq, and, asc, sql)
- `argon2` (hashing)
- `zod` (validation)
- `decimal.js` (حسابات دقيقة)

## البيانات المرجعية (Seed)

- العمولة الأساسية: سياسة `BASE` 4% (2% بائع + 2% مشتري) في جدول `commission_policies` (`rate/seller_rate/buyer_rate`) — **ليست Hardcoded**
- الخطط: `CUSTOMER_FREE`, `SMALL_MERCHANT` (19 TND/شهر), `COMPANY` (99 TND), `PRO_MAX` (299 TND)
- سياسة `ANTI_FEE_EVASION` مُثبتة
- دول/مناطق/مدن/عملات/لغات: Tunisia seed من الـ seeder

## مستخدمو الاختبار (Dev / Demo Seed)

كلمة المرور للجميع: `Passw0rd!2026`

| الدور | البريد | ملاحظة |
| --- | --- | --- |
| CUSTOMER | `customer1@wasit.tn` | عميل عادي |
| SUPPLIER | `suppliera@wasit.tn` | لديها مورد/منتجات |
| MERCHANT | `merchanta@wasit.tn` | لديها تاجر/منتجات |
| COMPANY | `companya@wasit.tn` | لديها شركة/منتجات |
| ADMIN/SUPER_ADMIN | `admin@wasit.tn` | SUDO — كل صلاحيات admin |

## المطلوب Next (بحسب PHASES المتبقية)

- PHASE 10: Risk Engine (RiskEvents API) — **أُنجز** ضمن PHASE 9 (إدارة فقط)
- PHASE 11: Disputes — **أُنجز** ضمن PHASE 9
- PHASE 12: Advertising
- PHASE 13: AI Core
- PHASE 14: Subscriptions billing
- PHASE 16: Analytics
- PHASE 17-21: Security audit + E2E كامل + Perf + Staging + Production

## PHASE 9 — Verification + Trust (المُنجز)

### Backend
- **Verification Engine** (`packages/server/src/modules/verification/`)
  - `GET /api/verification/me` — حالة التحقق الحالية (المستوى/البريد/الهاتف/الطلب النشط/الخطوة التالية)
  - `GET /api/verification/policies` — سياسات التحقق من Policy Engine (قابلة للتعديل حسب الدولة)
  - `POST /api/verification/requests` — تقديم طلب تحقق (BASIC/VERIFIED/BUSINESS_VERIFIED/INTERNATIONAL_VERIFIED)
  - `GET /api/verification/requests` — طلباتي
  - Admin: `GET /api/admin/verification/requests` + `POST /api/admin/verification/requests/:id/review` (APPROVED/REJECTED + ملاحظات + Audit + إشعار)
  - عند APPROVED تتحقق الشروط من Policy (مثال: BASIC → emailVerified + phoneVerified) وترفع مستوى المستخدم
- **Trust Engine** (`packages/server/src/modules/trust/`)
  - `GET /api/trust/me` — آخر درجة + تفسير + عدد السجل
  - `GET /api/trust/me/history` — السجل
  - `POST /api/trust/me/recompute` — إعادة احتساب (عوامل: عمر الحساب، البريد، الهاتف، مستوى التحقق، المعاملات الناجحة، النزاعات، الشكاوى، اكتمال الملف التجاري → درجة 0..100 قابلة للتفسير)
  - Admin: `GET /api/admin/trust` + `POST /api/admin/trust/:userId/recompute`
  - `trust-engine.ts` يستخدم `inArray(sellerId, ownedSellerIds)` لحلّ كيانات البيع المملوكة (`src/lib/seller-ownership.ts`) بدل `eq(sellerId, userId)`
- **Risk Engine** (`packages/server/src/modules/risk/`) — إدارة فقط:
  - `GET /api/admin/risk/profiles` + `GET /api/admin/risk/profiles/:userId` + `POST .../reassess`
  - `GET /api/admin/risk/events` — الأحداث + مستوى المخاطر + Reason Codes + الإجراء الموصى به
  - منفصل عن Trust Engine تماماً
- **Dispute Center** (`packages/server/src/modules/disputes/`)
  - `POST /api/disputes` (يتحقق من مشاركة الطرف عبر `isOrderParticipant`)، `GET /api/disputes`، `GET /api/disputes/:id`
  - `POST /api/disputes/:id/messages` + `POST /api/disputes/:id/evidence`
  - `GET /api/disputes/policies` — قواعد قابلة للتعديل حسب الدولة من Policy Engine
  - Admin: assign / update status / decide + سجل أحداث (CREATED, MESSAGE_ADDED, EVIDENCE_ADDED, ASSIGNED, STATUS_CHANGED, DECIDED, APPEAL_REQUESTED) + إشعارات
  - إصلاحان: `isOrderParticipant` عند عدم امتلاك كيان بيع (تجنّب SQL فارغ + Fallback `seller_id = userId`)؛ `listMyDisputes` تشمل Orders ذات `seller_id = userId`
- **Permissions جديدة**: `VERIFICATION_READ/SUBMIT/REVIEW`, `TRUST_READ/RECOMPUTE`, `RISK_READ/REASSESS`, `DISPUTE_OPEN/READ/MESSAGE/DECIDE/ASSIGN` + منحها للأدوار (ADMIN/SUPER_ADMIN/SUPPORT/RISK/DISPUTE)
- Migration `0003_redundant_golden_guardian.sql`: جدول `dispute_events` + `disputes.assigned_to_id`/`assigned_at` (مُطبَّقة على بيئة التطوير)

### Web
- `DashboardTrustPage` — بطاقة الدرجة + التفسير + السجل + إعادة الاحتساب (live)
- `DashboardVerificationPage` — المستويات + النموذج + الطلبات + السياسات (live)
- `DashboardDisputesPage` — القائمة + التفاصيل + الرسائل + الأدلة + الأحداث (live)
- Admin: `AdminVerificationPage` (مراجعة/موافقة/رفض)، `AdminTrustPage`، `AdminRiskPage`، `AdminDisputesPage` (assign/status/decide)
- `StaffOnly` guard للصفحات الإدارية الخاصة بالمحركات (ADMIN/SUPER_ADMIN/SUPPORT/RISK/DISPUTE) + روابط في الشريط الجانبي
- ترجمات كاملة ar/en (fr/zh عبر fallback)

### الاختبارات
- `tests/verification-trust.test.ts` — 10 اختبارات (Policies, my status, submit BASIC, admin approve→level BASIC, trust recompute+history, risk role check alone denied, dispute create/list/staff decide, outsider 403, evidence/messages/events)
- المجموعة الكاملة: **43/43 اجتياز** — typecheck نظيف (server + web) — `vite build` ناجح
- Live E2E (curl + متصفح): register→verify→submit→approve→recompute→dispute→decide→عرض في لوحات الويب بأربع شاشات

## إصلاح الرسوم المالية (Fee Policy Engine — هذا الجلسة)

**المشكلة:** `orders/service.ts` كان يحسب رسوم الدفع بـ `itemsTotal.mul('0.02')` (Hardcoded 2%) وعمولة احتياطية `'0.03'` في الكود — وهذا ينتهك القاعدة "لا نسب مالية Hardcoded".

**الإصلاح (الحد الأدنى):**
- أُضيفت دالة `getPaymentFeeRate()` تقرأ سياسة الرسوم من جدول `payment_fee_policies` (سياسات قابلة للإدارة من Admin عبر DB، مثل العمولة).
- استُبدل `'0.02'` بـ `percentRate + flatFee` من السياسة (مثال: 2% = `0.02` + `0`).
- أُزيل الاحتياطي المالي من الكود إطلاقًا؛ محرك العمولة يفشل مغلقًا (`COMMISSION_POLICY_MISSING`) عند عدم مطابقة أي سياسة. الافتراضي 4% (2%+2%) يعيش فقط في DB (seed).
- تمت إضافة `paymentFeePolicyId` إلى استجابة `createOrder` و Audit (`feePolicyId`).
- `seed.ts` يُدخل الآن سياسة رسوم دفع افتراضية (`WASIT Default Processing Fee` — 2%) إن لم توجد.

**الاختبارات:**
- `tests/payment-fee-policy.test.ts` (2 اختبار): إدراج سياسة `1.5%+0.5` → الطلب يحسب `2.0000` ويُرجع policyId؛ إعادة السياسة للافتراضي 2% → الطلب يحسب `2.0000` وتظل العمولة 3% من seed.
- المجموعة الكاملة: **45/45 ناجحة** — `tsc` نظيف (server+web) — build ناجح.

## PHASE 12 — Advertising Engine (هذا الجلسة — مكتملة)

### Backend (`packages/server/src/modules/ads/` — `service.ts` + `routes.ts`)
- محرك إعلانات حقيقي على الجداول الموجودة في migrations: `campaigns`, `ad_creatives`, `ad_events`
- مسارات API (مربوطة في `app.ts` عبر `/api/ads`):
  - `POST /api/ads/campaigns` — إنشاء حملة (Validation zod: advertiserType enum, budget عدد عشري موجب، تواريخ صحيحة)
  - `GET /api/ads/campaigns` — قائمة حملاتي (Owner isolation) مع فلاتر status + pagination
  - `GET /api/ads/campaigns/:id` — تفاصيل + creatives (من يملك entity فقط أو Admin)
  - `PATCH /api/ads/campaigns/:id` — تحديث (الحالة عبر `DRAFT→ACTIVE→PAUSED→COMPLETED/CANCELLED` محكوم بقواعد انتقال)
  - `POST /api/ads/campaigns/:id/creatives` — إضافة creative (BANNER/TEXT/VIDEO) بعد التحقق من الملكية
  - `GET /api/ads/campaigns/:id/stats` — إحصائيات (impressions/clicks/conversions/ctr/cpc/spent)
  - `POST /api/ads/events` — تسجيل أحداث (IMPRESSION/CLICK/CONVERSION) — يتطلب حملة ACTIVE (خلاف ذلك 409) + خصم تكلفة التحويل من `spent`
  - `GET /api/ads/served` — موضع العرض العام (يعيد creatives للحملات النشطة فقط — بدون auth حسب التصميم)
  - `GET /api/ads/my-advertisers` — entities المملوكة للمستخدم (للواجهة)
- RBAC: `AD_CREATE`, `AD_MANAGE`, `CAMPAIGN_CREATE`, `CAMPAIGN_MANAGE`, `ADMIN_ADS` — الأدوار MERCHANT/SUPPLIER/COMPANY/MARKETER تملك الإنشاء؛ CUSTOMER ممنوع (403)
- Ownership: `assertOwnAdvertiser` يمنع الإنشاء/الإدارة على entity لا يملكها المستخدم
- Audit: إنشاء/تحديث حملة و creative تُسجَّل عبر `writeAudit` (الإجراءات `ADS.CAMPAIGN_CREATE`, `ADS.CAMPAIGN_UPDATE`, `ADS.CREATIVE_CREATE`, `ADS.EVENT_RECORDED`)
- إصلاح أثناء التطوير: `getMyCampaign` كان يعتمد على `owned = await assertOwnAdvertiser(...).catch(() => null)` — وبما أن `assertOwnAdvertiser` تُرجع `undefined` عند النجاح فكان `!undefined === true` يمنع حتى المالك؛ الحل `await assertOwnAdvertiser(...)` مباشرة ليرمي 403 من الدالة نفسها عند عدم الملكية

### Web (ربط واجهة حقيقي — لا Mockup)
- `DashboardAdsPage` استُبدل الـ Placeholder بواجهة كاملة (RTL، العربية افتراضية):
  - نموذج إنشاء حملة (الجهة المعلنة من `my-advertisers`، الأهداف، الميزانية)
  - قائمة حملاتي مع Badge الحالة + المنصرف/الميزانية
  - تفاصيل عند فتح الحملة: إحصائيات live من `/stats` + أزرار إدارة الحالة (Activate/Pause/Resume/Cancel/End)
  - نموذج إضافة creative لكل حملة
  - قسم "الجهات المعلنة المملوكة"
- `lib/api.ts`: دوال `listCampaigns/getCampaign/createCampaign/updateCampaign/addCreative/campaignStats/servedAds/myAdvertisers`
- `lib/types.ts`: `CampaignSummary/CampaignDetail/CampaignStats/CampaignListResponse/AdCreativeRow/ServedAdRow`
- i18n كاملة (ar/fr/en + zh fallback) — أزيل الاعتماد على `ads.roadmap` placeholder

### الاختبارات (`tests/ads.test.ts` — 11 اختبار)
401 للحملات بلا جلسة، 403 لـ CUSTOMER، إنشاء حملة SUPPLIER (ملكية entity)، رفض entity لا يملكها المستخدم، عزل قوائم الحملات بين حسابين، إضافة creatives وظهورها في التفاصيل، منع الوصول لحملة غير مملوكة (403)، تفعيل + serve + أحداث (impression/click/conversion) + استمرارها في DB + stats مع spent=1.0000، رفض أحداث لحملة غير ACTIVE (409)، الكشف عن حملات مستخدم، منع انتقال حالة غير صالح.

### التحقق الحي (Live E2E على `wasit_dev` + متصفح)
- curl: تسجيل الدخول `supplierA` → `my-advertisers` تعيد المورد → إنشاء حملة → إضافة creative → تفعيل → `served` (عام) يعيد الإعلان → أحداث 201 → stats (impressions=1/clicks=1/conversions=1, spent=0.5000)
- المتصفح: دخول `supplierA` → `/dashboard/ads` → الحملة "Campagne Live E2E" تظهر (ACTIVE, المنصرف 0.5/150) → فتح الحملة يعرض الإحصائيات live والأزرار.

## PHASE 18 — Full Testing (E2E)

### أمر التشغيل
```bash
npm run test:e2e          # Playwright، يشغّل server + web تلقائياً ضد wasit_dev
```

### البنية (لا Mocks)
- `playwright.config.ts` — `globalSetup` + `webServer` (server + vite)، `workers: 1`، baseURL = الويب مع proxy `/api`.
- `e2e/global-setup.ts` — يشغّل `db:seed:demo` (idempotent، لا drop)، ثم يسجّل الدخول لكل دور عبر `POST /api/auth/login` الحقيقي ويحفظ `storageState` في `e2e/.auth/` (git-ignored).
  - **Self-healing**: إذا فشل دخول دور بـ 401 (مثلاً بعد تشغيل اختبار استعادة كلمة المرور)، يصلح كلمة المرور عبر مسار forgot/reset الحقيقي — لا تعديل يدوي على البيانات.
- `e2e/helpers.ts` — `DEMO_USERS`، `DEMO_PASSWORD`، `storageFor(role)`، `loginViaUi`.

### التغطية (28/28 ناجحة — 3 دورات متتالية متطابقة)
| الملف | ما يُثبته |
|---|---|
| `auth.spec.ts` (5) | رفض بيانات دخول خاطئة بخطأ accessible؛ دخول CUSTOMER مُهيّأ؛ forgot→reset→login→إرجاع كلمة المرور؛ ثبات الجلسة عبر reload |
| `marketplace.spec.ts` | Home→Marketplace→بحث→تفاصيل منتج→Checkout→إنشاء طلب→تفاصيل الطلب مع **عمولة السيرفر 180,000 DT** (4% من 4500، تُقرأ من الـ API الحقيقي)؛ رفض طلب أقل من MOQ من الـ backend |
| `rbac.spec.ts` | CUSTOMER ممنوع من `/admin` ومن `/api/inventory`؛ الطلبات غير المصادقة 401؛ SUPPLIER/MERCHANT dashboards؛ **إضافة مخزون تُحدّث الحركة server-side** (+2؛ قبل/بعد من جدول حقيقي)؛ ADMIN يقرأ users/orders/ledger/audit؛ **Ledger يعرض قيد العمولة**؛ **Audit يعرض ORDER.CREATE**؛ حساب ADMIN هو SUPER_ADMIN |
| `ads.spec.ts` | SUPPLIER ينشئ حملة → تظهر في القائمة و`GET /api/ads/campaigns` يعيدها؛ CUSTOMER يُرفض 403 (RBAC server-side) |

### الإصلاحات في هذه المرحلة
- **عقد الطلب**: `api.createOrder` كان مُعلَّماً `{ id: string }` بينما الـ Backend يعيد `{ orderId, orderNumber, itemsTotal, commission, paymentFee, grandTotal, currencyCode, transactionId }` — `CheckoutPage` كان يقرأ `res.id` (undefined) فلا يظهر النجاح أبداً. صُحّح العقد في `packages/web/src/lib/api.ts` + `CheckoutPage.tsx`.
- اختبار استعادة كلمة المرور يستخدم حساب `companyA` (غير مُستخدم في اختبارات الدوران) ويعيد كلمة المرور في `finally` عبر انتظار استجابة الـ API الفعلية (`waitForResponse`)، مع self-healing في global-setup كطبقة حماية إضافية.
- إضافة `test-results/`, `playwright-report/`, `e2e/.auth/` إلى `.gitignore` (تحتوي cookies الجلسات).

### الوضع
- ✅ **195/195 اختبار وحدة/تكامل** (`npm test`) ناجحة.
- ✅ **28/28 E2E** (Playwright) ناجحة، قابلة للإعادة دون تراكم بيانات.
- ✅ `tsc` typecheck (server + web) — 0 خطأ.
- ✅ 19 ملف spec للوحدة.

## ملاحظات البنّاء

- لا Wallet. WASIT لا يحتفظ برصيد المستخدمين.
- لا يمكن تغيير النموذج التجاري (العمولة 4% = 2% بائع + 2% مشتري) من الكود.
- أي تغيير تجاري محتمل هو من Policy Engine (Admin) مسجل في Audit.
- قاعدة البيانات والـ schemas مطابقة لمتطلبات الوثيقة المرجعية.

## Milestone — Payment Kernel متعدد المزوّدين + تكاملات تونس

- **Port موسّع** (`lib/payments/port.ts`): `PaymentMethod{type, scheme}`، `ProviderCapability`، `getStatus?`، `requiresStatusRecheck?`، `supportedMethods()`. يظل العقد الوحيد؛ لا يتسرّب شيء خاص بمزوّد خارجه.
- **Visa/Mastercard**: ليست مزوّدين — تُنمذج كـ`scheme` داخل `CARD`، والقبول عبر Gateway/Acquirer (AD-024). `MOBILE_WALLET` تحمل `D17`/`FLOUCI_WALLET`.
- **Flouci adapter** (`lib/payments/flouci.ts`) حسب `docs.flouci.com`: `generate_payment`، `verify_payment/{id}`، `refund_payment`، auth `Bearer <PUBLIC>:<PRIVATE>`، المبالغ بالمليم. `accept_card=false` لمسار المحفظة.
- **ClicToPay adapter** (`lib/payments/clictopay.ts`) حسب العقد العام: `register.do` (المبلغ minor units، `currency=788` لـTND) + `getOrderStatus.do`. Refund غير موثّق → يُرفض بوضوح ولا يُختَرع endpoint. الـhost والاعتمادات من SPS/البنك.
- **D17/e-Dinar**: لا API عام → `DECISION REQUIRED` (AD-027)، بلا تكامل مخترع.
- **Webhook آمن**: للمزوّدين بلا توقيع موثّق تُعاد قراءة الحالة من المزوّد (`getStatus`) ويُطابَق المبلغ مع الـintent قبل أي side-effect (AD-025).
- **Method selection**: `POST /orders/:id/intent` يقبل `method`، يتحقق أن المزوّد النشط يدعمها فعليًا، ويخزّنها على الـintent. `GET /api/payments/methods` يعرض كل المزوّدين مع `available`/`reason` دون كشف أي مفتاح (AD-026).
- **DB**: migration `0012_payment_multi_method.sql` (إضافة `method`/`scheme` لـ`payment_intents` — additive فقط).
- **الواجهة**: `CheckoutPage` يجلب القنوات المتاحة ويعرض محدّد وسيلة الدفع؛ مفاتيح i18n ar/fr/en/zh.
- **الاختبارات**: `tests/payment-adapters.test.ts` (16 وحدة، ضد خادم HTTP محلي يحاكي العقود الموثّقة)، `tests/payment-methods.test.ts` (9 تكامل عبر الـservice الحقيقي + DB)، e2e المدفوعات (6) — تشمل محاكاة مزوّد غير موقّع، رفض callback مزيّف بمبلغ مختلف، وidempotency.
- **النتيجة**: 297/297 اختبار خادم، 51/51 E2E، typecheck/build نظيفان.

## Milestone — CI/CD + حاويات إنتاجية (Phase 20/21)

- **كان فارغًا**: `.github/workflows/` + لا Dockerfile/compose، وكان `npm run start` (tsc dist) **غير قابل للتشغيل فعلًا** (ESM بلا امتدادات + `@wasit/shared` كمصدر TS).
- **إنتاج الخادم**: `build:prod` عبر esbuild → `dist-bundle/{index,seed,seed-demo}.cjs` (CJS، `argon2` external). سبب عدم سلوك مسار إعادة كتابة `tsc` موثّق في AD-028.
- **صورة API** (`Dockerfile`): 3 مراحل، إنتاج فقط في runtime، `USER node`، `HEALTHCHECK` على `/api/health/ready`، وأصول migrations + drizzle-kit للتطبيق.
- **صورة الويب** (`Dockerfile.web` + `deploy/nginx.conf`): SPA ثابت + proxy لـ`/api` و`/sitemap.xml` و`/robots.txt` (نفس الأصل → الكوكي يبقى same-origin كما في dev).
- **Compose**: db (غير منشورة للمضيف) + api + web على 8080؛ `JWT_SECRET` إلزامي بلا افتراضي؛ مفاتيح الدفع من البيئة فقط.
- **خطوة الإصدار** (AD-029): `migrate → seed → serve` داخل الحاوية. اكتُشف عمليًا أن قاعدة بلا بذر المرجع تفشل التسجيل بـ`Role CUSTOMER not seeded` (500)، لذا البذر جزء من الإصدار (idempotent).
- **التحقق الفعلي**: build ناجح؛ ثلاث حاويات healthy؛ `/api/health/ready` عبر nginx=200؛ SPA=200؛ robots عبر proxy؛ تسجيل 201 → تفعيل البريد → دخول 200 → `GET /api/payments/methods` 200 (يعرض noop/manual/flouci/clictopay مع available/reason).
- **CI**: `.github/workflows/ci.yml` — `static` + `test` + `e2e` على `postgres:16` حقيقية؛ `npm rebuild argon2`؛ رفع `playwright-report` عند الفشل؛ `concurrency` لإلغاء التشغيلات المتقادمة (AD-030).
- **إضافة**: `esbuild@^0.24` في `packages/server` devDeps، سكربتات `build:prod`/`start:prod`/`seed:prod`/`typecheck` الجذرية، و`.dockerignore`.
- **متبقٍ للفئات E/D**: staging مستضاف، WAL/جدولة backup، load testing، caching. (Redis rate-limit موزّع ✅ مُغلق في C1 عبر مخزن Postgres قابل للتبديل — AD-038؛ tracing/metrics/logging/alerting ✅ مُغلق في C2 عبر طبقات داخلية + `/metrics` — AD-039.)

## Milestone — توصيل جدولة تجديد الاشتراكات (Phase 14)

- **كان**: `rolloverDueSubscriptions` موجود لكن **غير موصول بأي route أو cron** — أي أن التجديد التلقائي لم يكن يحدث أبدًا في بيئة حقيقية رغم وجود الاختبار.
- **Idempotency حقيقية**: التمديد صار تحديثًا شرطيًا على `(id, status=ACTIVE, endsAt=<القيمة المقروءة>)` — عامل واحد فقط يربح (optimistic lock)، والباقي يُحصى `skipped`. يمنع ازدواج التمديد وازدواج الفاتورة عند التزامن أو إعادة التشغيل.
- **العقد**: `rolloverDueSubscriptions(db): { renewed, skipped, renewedIds }` بدل `number`.
- **Route إداري**: `POST /api/subscriptions/admin/rollover` (يحتاج `SUBSCRIPTION_MANAGE`)، يُسجّل في Audit `SUBSCRIPTION.ROLLOVER_RUN` فقط عند وجود تجديد فعلي.
- **Scheduler**: `src/lib/scheduler.ts` + `SCHEDULER_ENABLED` (افتراضي `false` حتى لا تعمل وظائف خلفية في الاختبارات) و`SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES`. يفشل الوظيفة بهدوء دون إسقاط العملية، `timer.unref()`، وإيقاف نظيف على SIGTERM/SIGINT. compose يفعّله (`true`) لأنه نشر أحادي.
- **الاختبارات**: 298/298 خادم (كان 297). اختبار route يثبت: تشغيل يستدعي الخدمة، التشغيل الثاني `renewed=0`، Audit مسجّل، ورفض MERCHANT بـ403. اختبار الخدمة يثبت عدم ازدواج الفاتورة عند تشغيلين.

## Milestone — توصيل بريد المعاملات (Phase 17 / B2)

- **كان**: التسجيل يُنشئ توكن تحقق في `email_verification_tokens` ثم **لا يُرسله أحد**؛ فلا يمكن لأي مستخدم جديد تفعيل بريده والدخول. نفس الشيء لإعادة تعيين كلمة المرور (كان التوكن يُعاد في JSON للتطوير فقط).
- **Port نظيف**: `lib/mail/port.ts` (نفس فلسفة `payments/port.ts`) + `SmtpMailTransport` (nodemailer؛ vendor-neutral: أي مزوّد يتكلم SMTP) + `LogMailTransport` (بديل بلا شبكة يطبع سطرًا مُقنَّعًا).
- **الحل حسب `MAIL_TRANSPORT`**: `smtp` للإرسال الحقيقي، `log` للتطوير/CI. أي قيمة غير معروفة تعود إلى `log` حتى لا يُعطّل خطأ مطبعي التسجيل. `resetMailTransport()` كـtest seam.
- **قوالب**: `buildVerificationEmail` / `buildPasswordResetEmail` بـar/fr/en (fallback للعربية) مع نص + HTML.
- **`sendMail` لا يُسقط الطلب أبدًا**: فشل SMTP يُسجَّل `MAIL.FAILED` في Audit (مع الناقل والخطأ)، والإرسال الناجح يُسجَّل `MAIL.SENT` — فلا يفقد المستخدم حسابه بسبب انقطاع مؤقت، ويبقى أثر دائم لإعادة الإرسال.
- **مسار dev**: `POST /api/auth/dev/verification-link` (404 في production، بنفس rate-limit التسجيل) يعيد رابطًا مبنيًا بالتوكن الحقيقي؛ و`issueEmailVerificationToken` يُبطل أي توكن سابق فلا يعمل إلا الأحدث.
- **الخصوصية**: `/forgot-password` لم يعد يفرّق بين بريد موجود وغير موجود (لا `data` عند عدم وجود الحساب) — لا oracle لتعداد الحسابات.
- **الاختبارات**: `mail.test.ts` — 9 حالات (resolution/status/templates/ar-fallback/التسجيل يُسجّل `MAIL.SENT` + dev link يتحقق + توكن مزوّر يُرفض + forgot موحّد). الإجمالي 307/307 (33 ملفًا). `nodemailer@6` مضمّن في bundle الـesbuild.

## Milestone — تنفيذ الحذف الفعلي (Anonymization) — Phase 17 / B3

- **كان**: `ANONYMIZED` مجرد قيمة في enum؛ `advanceDeletionStage` كان يحدّث العمود فقط ولا يمسّ أي PII. أي أن "الحذف" لم يكن يحدث فعلًا.
- **`lib/anonymize.ts`**: يستبدل البريد بـ`anon-<hash>@anonymized.invalid` (فريد وغير قابل للعكس)، والهاتف/الاسم/الكنية بـnull، و`passwordHash` بـ`ANONYMIZED` غير الصالح كـargon2، ويعطّل الحساب (`isActive=false`, `isLocked=true`, `emailVerified=false`)، ويُصفّر `profiles` و`supplier_contacts`. **الصف يبقى** لأن ledger/الصفقات/النزاعات تشير إليه.
- **حماية retention**: طلب `ANONYMIZED` أثناء نافذة استبقاء مفتوحة يُرفض 422 (`RETENTION_WINDOW_OPEN`)؛ `legalHoldOverride: true` يسمح مع تسجيل `PRIVACY.LEGAL_HOLD_OVERRIDE` في Audit. بعد انتهاء النافذة يعمل بدون override.
- **الإثبات**: عمود `anonymization_log` (migration `0013`) يحفظ قائمة الحقول المُستبدلة + من + متى، مع `PRIVACY.DELETION_ANONYMIZED` في Audit. لا يُخزَّن أي PII قديم.
- **الاختبارات**: حالتان جديدتان في `security-privacy.test.ts` — رفض 422 ثم override ينجح ويُدقّق، الصف محفوظ والبريد مُستبدل، و`argon2.verify` يفشل على القيمة الجديدة؛ وحالة انتهاء النافذة. الإجمالي 309/309.

## Milestone — كشف تجاوز العمولة (Anti-Fee-Evasion) — Phase 10 / C5

- **كان**: نموذج الإيراد الأساسي (عمولة 3% قديمًا) قابل للتجاوز بنقل الصفقة خارج المنصة عبر المحادثات، ولا يوجد أي كشف.
- **`lib/fee-evasion.ts`**: محرّك إشارات بقواعد صريحة — رقم هاتف، بريد، قناة خارجية (WhatsApp/Telegram/…)، طريقة دفع مباشر (Western Union/حوالة/كاش)، وعبارة "خارج الوسيط/بدون عمولة". يدعم العربية والفرنسية/الإنجليزية. قاعدة واحدة تُنتج إشارة واحدة كحد أقصى كي لا تضخّم رسالة طويلة الدرجة.
- **الربط**: عند `sendMessage` تُفحص الرسالة؛ إن ظهرت إشارات يُسجَّل `risk_events` بنوع `FEE_EVASION_SIGNAL` + قيد Audit `MESSAGING.FEE_EVASION_SIGNAL`، ويُرفع `risk_profiles` بوزن محدود (سقف 30). لا حجب تلقائي ولا عقوبة — القرار لمحرّك المخاطر/فريق المخاطر المنفصل.
- **الخصوصية (مبدأ أساسي)**: يُخزَّن **رموز الإشارات فقط** (`signalCodes`) و`threadId`/`messageId`، ولا يُخزَّن نص الرسالة ولا الرقم/الرابط المطابق. الاختبار يتحقق أن `details` المُخزَّن لا يحتوي الرقم الخام ولا نص الرسالة.
- **الاختبارات**: `fee-evasion.test.ts` — 10 حالات: 7 وحدات (عربي/إنجليزي لكل قاعدة، رسالة عمل عادية لا تُعلَّم، عدم تكرار نفس القاعدة) + 3 تكامل (تسجيل risk event ورفع الدرجة دون تسريب، رسالة نظيفة لا تُنشئ حدثًا، لا أعمدة مراقبة إضافية على الرسالة). الإجمالي 319/319.

## Milestone — تحصيل فواتير الاشتراك عبر مزوّد الدفع (Phase 14 / B7)

- **كان**: `rolloverDueSubscriptions` يُصدر فاتورة PENDING كل دورة، لكن **لا يوجد أي مسار يجعلها PAID** — أي أن إيراد الاشتراكات لم يكن يُحصَّل فعلًا، ولا دورة انتهاء/إلغاء.
- **قاعدة حاكمة**: لا يُعلَّم أي invoice مدفوعًا مباشرة من caller. كل تحصيل يمر عبر **منفذ مزوّد الدفع** (`lib/payments/port.ts`) — الـmanual للتحصيل المكتبي، وأي مزوّد حقيقي عبر webhook. لم يُضَف مزوّد جديد.
- **إعادة استخدام صحيحة**: `payment_intents` صار يقبل `subscription_id` (بديل nullable لـ`order_id`) مع فهرس، و**لم يُخلط** إيراد الاشتراك في `transactions`/`transaction_ledger` (تلك order-scoped وتُغذّي GMV) — الفاتورة PAID + `paidAt` + `externalRef` هي السجل المالي للاشتراك.
- **المسار الكامل**: Subscription → PENDING invoice → `startInvoicePayment` (intent عبر المزوّد، idempotent بـ`subinv_<invoiceId>`) → `POST /me/invoices/:id/pay` (checkout URL) أو `POST /admin/invoices/:id/collect` (desk, `isOperator`) → webhook (`PAYMENT_SUCCEEDED`/`FAILED`) → `applyInvoicePaymentSucceeded/Failed` → invoice PAID/FAILED + subscription ACTIVE (تمديد)/PAST_DUE.
- **التوجيه في الـwebhook**: `intentTarget()` يفرّق بين intent طلب وintent فاتورة؛ دفاع بعمق يمنع تسوية intent اشتراك كطلب. التوقيع يُتحقق أولًا، و(replay) بنفس `eventId` لا يُطبّق الأثر مرتين.
- **Idempotency مزدوجة**: `startInvoicePayment` يعيد نفس الـintent لنفس المفتاح؛ و`applyInvoicePaymentSucceeded` تحديث شرطي على `(invoice, status=PENDING)` — عامل واحد يربح. `collectInvoicePayment` يفحص حالة الفاتورة **قبل** إعادة استخدام الـintent فيرفض 409 على المدفوع مسبقًا.
- **الدورة**: `expireLapsedSubscriptions` — ملغى بعد `endsAt` → EXPIRED؛ PAST_DUE بعد grace (14 يوم) → EXPIRED + `autoRenew=false`. السcheduler يشغّل rollover ثم expiry كل دورة.
- **الترقية**: migration `0014` آمنة/إضافية فقط (`order_id`/`transaction_id` يصيران nullable، إضافة `subscription_id` + فهرس). لا drop ولا حذف بيانات.
- **الاختبارات**: `subscriptions-collection.test.ts` — 18 حالة: إنشاء intent + Audit، إعادة استخدام idempotent، رفض 403 لفاتورة الغير، تحصيل كامل + تمديد + Audit، 409 عند التكرار، قائمة dunning، تسوية عبر webhook موقّع (نجاح/فشل)، replay لا يمدّد مرتين، توقيع مزوّر يُرفض، دورة الانتهاء الثلاثية، وRBAC للمسارين. الإجمالي **337/337** (35 ملفًا)، typecheck ناجح.

## Milestone — Dispute App: فتح النزاع من الواجهة (Phase 11 / B8)

- **كان**: `api.createDispute` موجود في طبقة الـAPI لكن **لا مكوّن يستدعيه** — أي أن قدرة "إنشاء نزاع" لم تكن متاحة إطلاقًا لمستخدم الواجهة، وكان النزاع لا يُفتح إلا عبر استدعاء API مباشر. هذا يُصنّف Mockup/ناقص لا مكتملًا حسب Definition of Done (UI ↔ API ↔ Backend ↔ Tests).
- **النموذج**: بطاقة "إنشاء نزاع" أعلى صفحة `/dashboard/disputes` — قائمة طلبات حقيقية من `GET /api/orders` (لا إدخال معرّف يدوي)، قائمة أسباب محصورة (NOT_RECEIVED/NOT_AS_DESCRIBED/DAMAGED/WRONG_ITEM/LATE_DELIVERY/QUALITY_ISSUE/OTHER)، ووصف بحد أدنى 10 أحرف (مطابق لقيد الخادم).
- **الربط الكامل**: `POST /api/disputes` → عند النجاح تُعاد تحميل القائمة ويُفتح النزاع الجديد في لوحة التفاصيل فورًا، فيرى المستخدم رقم النزاع `DSP-…` وحالته OPEN. الخطأ يُعرض بـ`ErrorState` بلا ابتلاع.
- **التوطين**: نصوص جديدة عبر مفاتيح فقط (`disputes.create.selectOrder/selectReason/noOrders` + `disputes.reason.*`) في ar/en، مع سقوط آمن للعربية في fr/zh كما هو نمط الملف — لا نص داخل المكوّن.
- **الاختبار**: حالة E2E جديدة — العميل يسجّل الدخول، يمر بمسار الطلب الفعلي، يفتح `/dashboard/disputes`، يملأ النموذج بأزرار `data-testid`، ويؤكد ظهوره ثم وجوده OPEN في `GET /api/disputes`. كان الفشل الأول strict-mode (نمط `DSP-` يتكرر بين التشغيلات) فصار التأكيد على وصف فريد يحوي معرّف الطلب. **52/52 E2E** ناجحة، typecheck للخادم والواجهة 0 أخطاء، migration `0014` طُبِّق فعليًا على `wasit_dev` وقاعدة الاختبار.

## Milestone — Unit Economics: CAC / LTV / Contribution Margin (Phase 16 / B9)

- **الفجوة**: طبقة التحليلات كانت تعرض overview/retention/conversion فقط؛ لا CAC ولا LTV ولا هامش مساهمة، فلا يمكن قياس كلفة اكتساب العميل مقابل قيمته. (كانت الفجوة رقم 4 في ترتيب `DEVELOPMENT_ROADMAP.md`.)
- **المصدر الحقيقي الوحيد**: لا قيم ثابتة ولا Mock. `newCustomers` = عدد المشترين الذين **أول** طلب لهم (بهذه العملة) وقع داخل النافذة (استعلام cohort بـ`min(created_at)`). `marketingSpend` = مجموع `revenue_accounts` حيث `line_type='COST'` و`category='MARKETING'` داخل النافذة وبالعملة نفسها. `grossMarginTotal` = `Σ(commission + payment_fee)` من `orders`.
- **المعادلات**: `cac = spend ÷ newCustomers` (null إن لا cohort)، `ltvRealized = arpu = margin ÷ customersWithOrders`، `ltvProjected = (margin ÷ paidOrders) × ordersPerMonth × retentionMonths`، `ltvCacRatio = ltvRealized ÷ cac` (null إن كان CAC غائبًا/صفرًا)، `contributionMarginPct = margin ÷ GMV × 100`. كلها Decimal مع `ROUND_HALF_UP` لأربع منازل.
- **الصدق التحليلي**: `ltvRealized` رقم محقَّق قابل للتدقيق، أما `ltvProjected` فنموذج صريح تُعاد افتراضاته في `assumptions` ولا يُقدَّم كحقيقة؛ و`basedOn` يوثّق المصادر والقيود (نطاق عملة واحدة، وأن `campaigns.spent` إيراد إعلاني لا تكلفة اكتساب).
- **العزل**: الوحدة تفحص عملة واحدة فقط ولا تُصرّف بين العملات (لا Exchange Rate Engine)، تمامًا كسياسة `revenue/service.ts`.
- **الواجهة البرمجية**: `GET /api/admin/analytics/unit-economics` (query: currency/windowDays/retentionMonths/ordersPerMonth بتحقق صارم → 422 بـ`fieldErrors`) و`GET /api/admin/analytics/cohorts`؛ كلاهما بصلاحية `ADMIN_ANALYTICS` (ADMIN/SUPER_ADMIN) وAudit `ANALYTICS.UNIT_ECONOMICS_READ`.
- **الاختبارات**: `unit-economics.test.ts` — 10 حالات: الحساب النقي (CAC/ARPU/LTV محقَّق/مُقدّر/نسبة/هامش)، تقريب HALF_UP، القيم الصفرية وغياب cohort (null لا قسمة على صفر)، عزل العملة (صفوف عملة أخرى لا تدخل مجموعًا ولا تُنشئ cohort)، استبعاد spend الأقدم من النافذة، cohorts شهرية، و401/403/422/200+Audit عبر `createApp()` الحقيقي. للعزل تُستخدم عملة اصطناعية بدل `DELETE FROM orders` حمايةً لبيانات بقية الملفات.
- **التحقق**: الخادم **347/347** (36 ملفًا)، `typecheck` للخادم والواجهة نظيف، و`vite build` للواجهة ناجح (78 module).

## Milestone — سدّ فجوة SMS / التحقق بالهاتف (Phase 17 / B2 — إغلاق)

- **الفجوة**: كان بريد المعاملات حقيقيًا (`lib/mail/`)، لكن **SMS غير موجود إطلاقًا** — جدول `phone_verification_tokens` غائب، و`users.phone` لم يكن يُكتب عند التسجيل، و`phoneVerified` لا يصبح true عبر أي مسار. أي أن المستويات الأولى من Verification Engine تعتمد على إشارة غير قابلة للإنتاج.
- **Port موازٍ للبريد**: `lib/sms/port.ts` (`SmsTransport`/`SmsMessage`) + `HttpSmsTransport` (POST JSON إلى بوابة قابلة للضبط: URL، auth scheme `none|bearer|basic`، وأسماء حقول `to/text/from`) + `LogSmsTransport` (بدون شبكة) + `resolveSmsTransport()` حسب `SMS_TRANSPORT` (`log` افتراضيًا، وأي قيمة غير معروفة تعود إلى `log`) + `resetSmsTransport()` كـtest seam. لا بروتوكول SMS موحّد، لذلك **الـPort هو الضمانة** بأن تبديل المزوّد لا يمسّ مسار التحقق ولا الـroutes ولا الـAudit.
- **استيعاب القواعد**: `sendSms` يكتب `SMS.SENT`/`SMS.FAILED` في Audit ولا يُسقط الطلب عند فشل البوابة. **لا يُخزَّن نص الرسالة ولا الرقم الكامل** — فقط الرقم مُقنَّعًا عبر `maskPhone` — لأن النص يحوي كود التحقق. `HttpSmsTransport` يعتبر أي non-2xx فشلًا ويُرفعه ليُسجَّل، مع timeout.
- **التسجيل**: يقبل `phone` اختياريًا؛ `normalizePhone` يزيل المسافات/الأقواس ويتحقق من صيغة `+?digits` (6–20) وإلا 422. يُخزَّن الرقم مُطبَّعًا.
- **المسار الكامل**: `POST /api/auth/phone/send` (auth، rate-limit 5/دقيقة) → كود 6 أرقام عبر `generateOtpCode`، **يُخزَّن hash فقط** في `phone_verification_tokens`، ويُبطل أي كود سابق → `POST /api/auth/phone/verify` (rate-limit 10/دقيقة) ⇒ `phone_verified=true` + Audit `AUTH.PHONE_VERIFIED`. `attempts` يمنع تخمين الكود: كل خطأ يزيد العدّاد، والكود يُرفض عند بلوغ `PHONE_VERIFY_MAX_ATTEMPTS` (افتراضي 5).
- **إصلاح كامن**: `generateOtpCode` كان يسحب رقمًا عشوائيًا للتحقق من النطاق ورقمًا آخر للقيمة، فيمكن أن يُخرج كودًا من 5 أرقام ترفضه بوابة `z.string().length(6)`. أُعيد كتابته لسحب واحد مع `padStart(6,'0')`. (كانت دالة غير مستخدمة سابقًا، فظهر خللها الآن.)
- **Health**: `GET /api/health/channels` يعرض `mail`/`sms` (transport/available) بلا أي أسرار — يؤكد أن التنفيذ يملك قناة حقيقية قبل الاعتماد عليها.
- **Migration**: `0015` إضافية فقط (`CREATE TABLE phone_verification_tokens` + فهرسان)؛ طُبِّقت على `wasit_dev` وقاعدة الاختبار.
- **التحقق**: `sms.test.ts` — 17 حالة (resolve/status/masking/templates + E2E حقيقي على DB: send+Audit دون تسريب الرقم، قبول via dev seam، كود خاطئ×5، shape خاطئ 422، 401 غير مصادق، resend يُبطل القديم، 422 بعد التحقق، `/api/health/channels`). الإجمالي **364/364** (37 ملفًا)، `typecheck` نظيف، حزمة esbuild تُبنى وتُشغَّل تحت Node العادي، وE2E يدوي عبر الحزمة على Postgres الحقيقي: register(phone)→send→dev code→verify ⇒ `phone_verified=t` و`token_hash` فقط في القاعدة.
## Milestone — Marketing Video Generation Pipeline حقيقي (Phase 13 / Media)

- **الفجوة**: `marketingVideos` في Marketing Agent كان **عقداً فقط** — `mediaUrl: null` مع `previewable/downloadable`، بلا توليد أو تخزين فعلي (الفجوة رقم 5 في التقرير المرجعي).
- **Media Port (provider-agnostic)**: `lib/media/port.ts` يحدد `MediaStorage`، و`lib/media/video-types.ts` يحدد `VideoGenerationProvider`. التسجيل مركزي في `lib/media/resolve.ts` حسب `MEDIA_STORAGE` و`VIDEO_PROVIDER` — لا SDK مزوّد يُستورد في الطبقات العليا، تماماً مثل منافذ payments/AI.
- **التخزين الخاص**: `LocalMediaStorage` يكتب تحت `MEDIA_STORAGE_DIR` (افتراضي `.wasit-media/`) بمفاتيح مبهمة، **لا ملفات ثابتة عامة**. التحقق من المفاتيح صار **لكل مقطع** فيسمح بالمفاتيح المتداخلة (`videos/<uuid>.mp4`) ويمنع أي تسرب مسار. يدعم `getRange` لطلبات HTTP Range (معاينة الفيديو داخل الصفحة).
- **محرّك التوليد**: `StructuralVideoProvider` يُنتج **MP4 حقيقياً** (H.264/yuv420p/faststart، 720×1280، 25fps) عبر ffmpeg + libass، مع تشكيل عربي صحيح عبر خط Noto Sans Arabic المُجمَّع. الستايلات الأربعة (MODERN/MINIMAL/BOLD/ELEGANT) والجمهور (B2B/B2C) والمدة تُبنى في مشهد من 4 شرائح. `NoopVideoProvider` يفشل بصوت عالٍ للتعطيل الصريح.
- **الروابط الموقّعة**: `lib/media/tokens.ts` — توكن قصير العمر (`MEDIA_DOWNLOAD_TTL_SECONDS`، افتراضي 900ث) يربط الأصل بمالكه. **المفتاح وحده لا يكفي للقراءة**؛ توكن غير صالح/منتهٍ ⇒ 401.
- **الحوكمة**: التوليد يمرّ بصلاحية `media:upload` (RBAC حقيقي في الخادم، لا إخفاء زر). الملكية عبر `assertSellerOwnership` (المنتج يجب أن يخصّ كيان المستخدم) أو Admin، والمنتج يجب أن يكون **ACTIVE** وإلّا 422 `PRODUCT_NOT_ACTIVE`. كل render يُسجَّل في `ai_requests` (`MARKETING_VIDEO`) ويُجمَّع في `ai_usage` عبر AI Cost Control — لا تجاوز للـ budget.
- **الـ API**: `POST /api/media/marketing-videos` (201 + أصل READY)، `GET /api/media/assets`، `GET /api/media/assets/:id`، `DELETE /api/media/assets/:id` (حذف ناعم DELETED مع إبقاء السجل للـ Audit)، `GET /api/media/assets/:id/content` (توكن + Range). إضافةً `GET /api/products/mine` لقائمة منتجات الكيانات المملوكة.
- **الـ Agent**: Marketing Agent يعرض الآن `marketingVideos` حقيقية بروابط موقّعة (`mediaUrl`/`downloadUrl`) من `listRecentMarketingVideos()` — لا روابط مُلفَّقة، وعند غياب الفيديوهات يعيد قائمة فارغة + تلميح.
- **الواجهة**: `DashboardVideoStudioPage` (`/dashboard/video-studio`) — اختيار منتج، لغة/جمهور/نمط/مدة، توليد، معاينة `<video>` داخلية، تنزيل، حذف، ومكتبة وسائط حقيقية. Nav مُقيّد بـ`media.use`. التوطين عبر مفاتيح `studio.*` في ar/fr/en/zh (لا نصوص داخل المكوّن).
- **Health/Ops**: `GET /api/health/channels` يعرض `media.storage` و`media.video` (id/available/reason/async) بلا أسرار. `.wasit-media/` في `.gitignore`.
- **الاختبارات**: `tests/marketing-video.test.ts` — 13 حالة: 401 غير مصادق، 403 لـCUSTOMER (RBAC)، 403 لمنتج تاجر آخر، 422 لمنتج غير ACTIVE، **MP4 حقيقي** (تحقق ftyp + حفظ DB + ظهور في المكتبة)، تشكيل عربي، عزل بين المستخدمين، توكن غير صالح، حذف ناعم، تعرّض Agent للوسائط الحقيقية، و`/mine` (ملكية/فارغ/401).
- **التحقق**: الخادم **434/434** (42 ملفاً)، typecheck للخادم والواجهة نظيف، و`vite build` للواجهة ناجح.
