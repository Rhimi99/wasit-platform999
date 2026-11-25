# PR-10 — تفضيلات الإشعارات (Notification Preferences)

**الحالة:** `COMPLETED` — السطح (Backend + الواجهة) مُنفَّذ ومُتحقَّق باختبارات تكامل حقيقية،
و**E2E في متصفح حقيقي شُغِّل ونجح 9/9** على قاعدة معزولة (2026-11-25).
**لا يُعلَن `COMPLETE_VERIFIED`**: سياسة الفئات الإلزامية ما زالت `DECISION REQUIRED` (§3.1)،
وثلاثة عيوب اكتُشفت أثناء التحقّق وسُجّلت (§6) — اثنان منها خارج نطاق PR-10 ولم يُصلَحا.

**التاريخ:** 2026-11-22 (تنفيذ) · 2026-11-25 (تحقّق E2E) · **الفرع:** `pr-10-notification-preferences`

---

## 1. الفجوة كما هي في السجل

> `notification_preferences` جدول موجود في المخطّط بلا أي مسار أو واجهة.
> الاختبارات المطلوبة: `GET/PUT + E2E`.

الجدول موجود منذ الترحيل `0000` (`db/schema/messaging.ts`) بأعمدة
`id, user_id, channel, category, enabled, updated_at`، ولم يكن له قارئ ولا كاتب:
لا يستطيع المستخدم أن يقول ما يريد استلامه، ولا يستطيع أي مسار أن يقرأ ذلك.

## 2. ما نُفِّذ

### 2.1 المفردات (Vocabulary) — `modules/notifications/preferences.ts`

| العنصر | القيمة | لماذا |
| --- | --- | --- |
| القنوات | `IN_APP`, `EMAIL`, `SMS` | القنوات التي تُسلِّم عليها المنصّة فعلاً؛ لم تُضَف قناة غير موجودة (`PUSH` مثلاً) |
| الفئات | `MESSAGE, ORDER, PAYMENT, REFUND, DISPUTE, INVENTORY, VERIFICATION, RISK, AI, PAYOUT` | مشتقّة من أنواع الإشعارات المكتوبة في الكود فعلاً |
| `categoryOfNotificationType()` | `DISPUTE.STATUS → DISPUTE` · `INVENTORY_LOW_STOCK → INVENTORY` · `payout.completed → PAYOUT` · غير المعروف → `null` | ربط صريح بدل تخمين صامت |

قائمة الفئات **صريحة** لا مشتقّة آلياً: نوع إشعار جديد لا يخلق فئة لا يملك المستخدم إعداداً لها.
اختبار يثبّت أن **كل** نوع يكتبه الكود اليوم يُسقَط على فئة معروفة.

### 2.2 القراءة — `GET /api/notifications/preferences`

يعيد مصفوفة كاملة (كل قناة × كل فئة) مع القيمة **الفعّالة**:

- صف مخزَّن ⇒ قيمته و`explicit: true` و`updatedAt`.
- لا صف ⇒ `enabled: true` و`explicit: false`.

الافتراضي «مفعّل» دائماً: الصمت فعل مقصود لا نتيجة صف ناقص.
العميل لا يحتاج أن يعرف الافتراضيات — الخادم هو مرجعها.

### 2.3 الكتابة — `PUT /api/notifications/preferences`

- Body: `{ preferences: [{ channel, category, enabled }] }` — دفعة واحدة (1..30 عنصراً).
- رفض `422` مع `fieldErrors` لـ: قناة مجهولة، فئة مجهولة، قائمة فارغة، تكرار نفس الزوج.
- **لا تكرار في الجدول:** الجدول بلا قيد فريد، وهذه المهمة لا تضيف ترحيلاً، لذا يُسلسَل الزوج
  بـ`pg_advisory_xact_lock(hashtext('notif-pref:<user>:<channel>:<category>'))` داخل معاملة
  قبل القراءة‑ثم‑الكتابة. طلبان متزامنان لنفس الزوج ينتظر أحدهما الآخر بدل أن يُدرِجا صفّين.
- **Audit:** `NOTIFICATION.PREFERENCES_UPDATED` بهوية المستخدم، مع `before/after` للصفوف التي
  تغيّرت فعلاً فقط (لا يُسجَّل ما لم يتغيّر).

### 2.4 الواجهة — `/dashboard/settings`

بطاقة «تفضيلات الإشعارات» داخل صفحة الإعدادات (التي كانت بطاقة نصّية فقط):

- جدول: الفئات صفوفاً والقنوات أعمدة، بمفاتيح i18n في **ar/en/fr/zh**.
- التعديل محلي (draft)، وزر الحفظ يُرسل **تغييرات فقط** في طلب واحد، ويُعطَّل حين لا تغيير.
- حالات: تحميل، خطأ (رسالة الخادم)، حفظ ناجح (`role="status"`).
- الاختبارات تعتمد على `data-testid` ثابتة: `notification-preferences`,
  `notification-preferences-save`, `notification-preferences-saved`, `notif-pref-<CHANNEL>-<CATEGORY>`.

### 2.5 الصلاحيات

لا تغيير في RBAC. المساران تحت نفس حارس الموجّه القائم
(`requireAuth` + `MESSAGE_READ_OWN`)، والمستخدم يقرأ ويكتب **تفضيلاته فقط**
(`ctx.user.id`، لا معرّف من العميل).

**تصحيح (2026-11-25):** العبارة السابقة «الذي يملكه كل دور مسجَّل» **غير صحيحة** وقد أُثبت ذلك بطلب حقيقي:
`CUSTOMER`/`SUPPLIER`/`MERCHANT`/`COMPANY`/`SUPPORT`/`DISPUTE`/`ADMIN`/`SUPER_ADMIN` ⇒ **200**،
لكن **`MARKETER` و`RISK` ⇒ 403** لأنهما لا يحملان `MESSAGE_READ_OWN` (لا يحملان أي صلاحية رسائل).
الأثر: موظّف بهذين الدورين يرى بطاقة خطأ في `/dashboard/settings` ولا يستطيع ضبط تفضيلاته.
هذا **سلوك قائم قبل PR-10** (نفس الحارس على `/api/notifications` كلها)، ولم يُعدَّل هنا:
الإصلاح قرار RBAC ⇒ `GAP_REGISTER` البند `RBAC-NOTIF-01`.

## 3. ما لم يُنفَّذ — صراحةً

### 3.1 التطبيق على التسليم: `DECISION REQUIRED`

التفضيلات تُخزَّن وتُقرأ، لكن **مسارات الإرسال لا تستشيرها بعد**. السبب ليس تقنياً:
تحديد الفئات التي **يجوز إسكاتها** قرار منتج/امتثال (هل يجوز إسكات إشعار فشل دفع؟ نزاع؟ مخزون؟).
لم يُخترع القرار. أُضيفت `isEnabled(matrix, channel, category)` كـseam مُختبَر، فربط التسليم
لاحقاً = تعديل موضع نداء واحد لا إعادة كتابة.

**المطلوب:** قرار مالك المنتج بقائمة الفئات الإلزامية (غير القابلة للإسكات) وبقائمة القابلة للإسكات،
ثم ربط `createNotification`/طبقة التسليم بـ`isEnabled`. حتى ذلك الحين: الواجهة تقول «حُفظت اختياراتك»
ولا تدّعي تغيير التسليم (نصّ التذييل يوضح ذلك).

### 3.2 E2E — شُغِّل ونجح (2026-11-25)

`e2e/notification-preferences.spec.ts` — **9 حالات، 9/9 ناجحة** في Chromium حقيقي، بلا mock وبلا اعتراض شبكة:

| # | الحالة | ما يُثبته |
| --- | --- | --- |
| 1 | عرض المصفوفة | 30 مفتاحاً ظاهرة، وزر الحفظ معطّل بلا تغيير |
| 2 | الحفظ + إعادة التحميل | الاختيار يبقى بعد `reload`، ثم يُستعاد حساب العرض المشترك |
| 3 | فئة مجهولة | `422` عبر `fetch` داخل الصفحة بالجلسة الحقيقية |
| 4 | حساب جديد | 30 مفتاحاً **مفعّلاً** و`explicit:false` للجميع، و`mandatoryCategories` فارغة |
| 5 | تغيير خلية واحدة | فرق المصفوفة قبل/بعد = **خلية واحدة** فقط، والـ29 الأخرى كما هي |
| 6 | عزل مستخدمين | إسكات عند المستخدم أ لا يظهر عند المستخدم ب (واجهة + API) |
| 7 | زائر | `GET` ⇒ 401 و`PUT` ⇒ 401 بلا جلسة |
| 8 | أربع لغات | `ar/en/fr/zh`: عنوان البطاقة + تسمية صف مترجمة، و`dir=rtl` للعربية و`ltr` لغيرها |
| 9 | هاتف 390×844 | 30 مفتاحاً، لا تمرير أفقي للصفحة، الوصول لعمود SMS ممكن، الحفظ يبقى بعد التحميل |

**كيف شُغِّل (قاعدة معزولة، لا مساس بـ`wasit_dev` ولا بالديمو):**

```
# قاعدة E2E مؤقتة على عنقود PostgreSQL منفصل
DATABASE_URL=postgresql://…@127.0.0.1:5434/wasit_pr10_e2e
  npx drizzle-kit migrate  &&  npx tsx src/scripts/seed.ts
DATABASE_URL=<نفسه> E2E_API_URL=http://localhost:3100 E2E_WEB_URL=http://localhost:5199   npx playwright test e2e/notification-preferences.spec.ts
→ 9 passed (11.1s) · exit 0
```

`globalSetup` زرع حسابات الديمو عبر `db:seed:demo` **داخل القاعدة المعزولة** (نفس منطق الإنتاج، لا mocks).
الحسابات الجديدة التي تُنشئها الحالات 4–6 و9 مسماة `pr10-*` وتبقى في قاعدة الاختبار المؤقتة فقط.

**عيوب اكتُشفت في أول تشغيل فعلي للاختبار (لم يكن قد شُغِّل قبل ذلك) وأُصلحت هنا:**

1. محدّد المفاتيح كان `[data-testid^="notif-pref-"] input[type="checkbox"]` — وهو يبحث عن `input`
   **داخل** عنصر يحمل الـtestid، بينما الـtestid على `<input>` نفسه ⇒ كان يعيد 0 بدل 30.
2. `request.newContext()` **يرث** `storageState` من `test.use`، فكان «الزائر» في الحالة 7 يُرسل كوكي
   العميل ويحصل على 200. صُحِّح بتمرير `storageState: { cookies: [], origins: [] }` صراحةً.
3. تمرير أفقي بـ`scrollLeft` لا يحترم اتجاه RTL، فكان يقيس العمود الأخير خارج الشاشة؛ استُبدل بـ
   `scrollIntoViewIfNeeded()` الذي يتبع اتجاه الكتابة.

## 4. الاختبارات المُشغَّلة

```
packages/server: npx vitest run tests/pr10-notification-preferences.test.ts
→ 12/12 passed            (11 سابقاً + حالة التزامن الجديدة)

packages/server: npx vitest run tests/pr10-notification-preferences.test.ts \
    tests/messaging.test.ts tests/disputes.test.ts tests/verification-trust.test.ts \
    tests/inventory.test.ts tests/ai-sup02-escalations.test.ts
→ 6 ملفات · 81/81 ناجحة · exit 0      (لا تراجع في الوحدات التي تُصدر إشعارات)

packages/server: npx vitest run   (الحزمة الكاملة على فرع هذه المهمة — 2026-11-22)
→ 158 ملفاً · 2053/2053 ناجحة · exit 0

packages/server: npx vitest run   (الحزمة الكاملة بعد إضافة حالة التزامن — 2026-11-25)
→ 158 ملفاً · 2054/2054 ناجحة · exit 0   (+1 = الحالة 12)

e2e: npx playwright test e2e/notification-preferences.spec.ts
→ 9/9 ناجحة · exit 0

Typecheck: server 0 أخطاء · web 0 أخطاء · npm run build -w @wasit/web ناجح (2026-11-25)
```

| # | الحالة |
| --- | --- |
| 1 | كل نوع إشعار يكتبه الكود يُسقَط على فئة معروفة |
| 2 | صف غائب = مفعّل، وإسكات قناة لا يمسّ قناة أخرى |
| 3 | زائر ⇒ 401 |
| 4 | المصفوفة الكاملة (10×3) بكل شيء مفعّل و`explicit=false` |
| 5 | حفظ اختيار ⇒ `explicit=true` + `updatedAt` + يبقى بعد قراءة ثانية |
| 6 | ثلاث كتابات متتالية لنفس الزوج ⇒ صف واحد فقط بالقيمة الأخيرة |
| 7 | صف تدقيق `NOTIFICATION.PREFERENCES_UPDATED` بمعرّف الفاعل |
| 8 | فئة مجهولة ⇒ 422 بلا أي كتابة |
| 9 | قناة مجهولة ⇒ 422 |
| 10 | قائمة فارغة ⇒ 422 وزوج مكرّر ⇒ 422 |
| 11 | عزل المستخدمين: تفضيل مستخدم لا يظهر لمستخدم آخر |
| 12 | **تزامن:** 4 طلبات `PUT` متزامنة لنفس الزوج ⇒ صف واحد فقط، والقيمة المخزَّنة = القيمة المخدومة |

الحالات كلها عبر `createApp()` الحقيقي: مسارات، middleware، جلسة بكوكي حقيقي، PostgreSQL حقيقي.
لا mocks ولا حقن مباشر في الخدمة.

**Typecheck:** `packages/server` = 0 أخطاء · `packages/web` = 0 أخطاء · `npm run build -w @wasit/web` = ناجح.

## 5. الملفات

| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/notifications/preferences.ts` | **جديد** — المفردات، القراءة، الكتابة الذرّية، التدقيق، `isEnabled` |
| `packages/server/src/modules/notifications/routes.ts` | `GET/PUT /preferences` + مخطط zod |
| `packages/server/tests/pr10-notification-preferences.test.ts` | **جديد** — 12 اختباراً (منها تزامن الكتابة) |
| `packages/web/src/lib/types.ts` | `NotificationChannel/Category/PreferenceRow/Matrix/Input` |
| `packages/web/src/lib/api.ts` | `notificationPreferences()` / `updateNotificationPreferences()` |
| `packages/web/src/pages/DashboardSimplePages.tsx` | بطاقة التفضيلات في `/dashboard/settings` |
| `packages/web/src/lib/i18n.ts` | 18 مفتاحاً × 4 لغات |
| `e2e/notification-preferences.spec.ts` | **جديد** — 9 حالات، **شُغِّلت 9/9** (2026-11-25) |

**لا ترحيل، لا seed، لا تغيير مخطّط، لا تغيير صلاحيات، لا مساس بمسارات المال.**

---

## 6. نتائج التحقّق — ثلاثة عيوب، واحد منها في PR-10

| # | العيب | النطاق | الحالة |
| --- | --- | --- | --- |
| 1 | **محدّد E2E خاطئ** في الاختبار المكتوب سابقاً (`[data-testid^="notif-pref-"] input[type="checkbox"]` يعيد 0 لأن الـtestid على `<input>` نفسه) | PR-10 (اختبار فقط) | **أُصلح** — أول تشغيل فعلي كشفه |
| 2 | **`MARKETER` و`RISK` ⇒ 403** على `/api/notifications/preferences` (لا يحملان `MESSAGE_READ_OWN`) | RBAC قائم قبل PR-10 | **لم يُصلَح** — قرار RBAC، سُجِّل `RBAC-NOTIF-01` |
| 3 | **هيكل لوحة التحكّم غير متجاوب على الهاتف**: `AppSidebar` بعرض ثابت `w-60` (240px) بلا نقطة كسر، فعلى شاشة 390px يبقى للمحتوى 150px والبطاقة 68px (الجدول 181px ⇒ نافذة تمرير ضيّقة) | هيكل عام لكل صفحات `/dashboard` | **لم يُصلَح** — تغيير واسع، سُجِّل `UI-MOBILE-01` |

**قياسات الهاتف (390×844، مقاسة في المتصفح لا مقدَّرة):** `aside = 240px` · `main = 150px` ·
`card = 68px` · `table scrollWidth = 181` مقابل `clientWidth = 68` · `document.scrollWidth = 390` (لا تمرير للصفحة).
الوظيفة سليمة (كل الخلايا قابلة للوصول والتمرير والحفظ)، لكن **القراءة البصرية غير مقبولة** — لذا الحالة 9
تسمّى «works at a phone viewport» ولا تدّعي جاهزية تصميم الهاتف.

**لقطة الإثبات:** `test-results/pr10-phone-settings.png` (مُولَّدة عند التشغيل، خارج git).
