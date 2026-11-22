# PR-10 — تفضيلات الإشعارات (Notification Preferences)

**الحالة:** `IN_PROGRESS` — السطح (Backend + الواجهة) مُنفَّذ ومُتحقَّق باختبارات تكامل حقيقية؛
**اختبار E2E في المتصفح مكتوب ولم يُشغَّل بعد** (يحتاج قاعدة `wasit_dev` + تنزيل متصفحات Playwright،
وكلاهما تغيير بيئي يحتاج موافقة صريحة). لا يُدَّعى إغلاق قبل تشغيله.

**التاريخ:** 2026-11-22 · **الفرع:** `pr-10-notification-preferences`

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
(`requireAuth` + `MESSAGE_READ_OWN`) الذي يملكه كل دور مسجَّل، والمستخدم يقرأ ويكتب **تفضيلاته فقط**
(`ctx.user.id`، لا معرّف من العميل).

## 3. ما لم يُنفَّذ — صراحةً

### 3.1 التطبيق على التسليم: `DECISION REQUIRED`

التفضيلات تُخزَّن وتُقرأ، لكن **مسارات الإرسال لا تستشيرها بعد**. السبب ليس تقنياً:
تحديد الفئات التي **يجوز إسكاتها** قرار منتج/امتثال (هل يجوز إسكات إشعار فشل دفع؟ نزاع؟ مخزون؟).
لم يُخترع القرار. أُضيفت `isEnabled(matrix, channel, category)` كـseam مُختبَر، فربط التسليم
لاحقاً = تعديل موضع نداء واحد لا إعادة كتابة.

**المطلوب:** قرار مالك المنتج بقائمة الفئات الإلزامية (غير القابلة للإسكات) وبقائمة القابلة للإسكات،
ثم ربط `createNotification`/طبقة التسليم بـ`isEnabled`. حتى ذلك الحين: الواجهة تقول «حُفظت اختياراتك»
ولا تدّعي تغيير التسليم (نصّ التذييل يوضح ذلك).

### 3.2 E2E

`e2e/notification-preferences.spec.ts` مكتوب (3 حالات: عرض المصفوفة، الحفظ والبقاء بعد إعادة التحميل
مع استعادة حالة الحساب المشترك، ورفض فئة مجهولة عبر fetch داخل الصفحة بالجلسة الحقيقية).
**لم يُشغَّل**: يحتاج `wasit_dev` (غير موجودة في هذه البيئة؛ الموجود `wasit_test` فقط على `127.0.0.1:5434`)
ومتصفحات Playwright غير المنزّلة. إنشاء قاعدة وتشغيل seed تغيير بيئي مقيَّد بموافقة صريحة.

## 4. الاختبارات المُشغَّلة

```
packages/server: npx vitest run tests/pr10-notification-preferences.test.ts
→ 11/11 passed
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

الحالات كلها عبر `createApp()` الحقيقي: مسارات، middleware، جلسة بكوكي حقيقي، PostgreSQL حقيقي.
لا mocks ولا حقن مباشر في الخدمة.

**Typecheck:** `packages/server` = 0 أخطاء · `packages/web` = 0 أخطاء · `npm run build -w @wasit/web` = ناجح.

## 5. الملفات

| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/notifications/preferences.ts` | **جديد** — المفردات، القراءة، الكتابة الذرّية، التدقيق، `isEnabled` |
| `packages/server/src/modules/notifications/routes.ts` | `GET/PUT /preferences` + مخطط zod |
| `packages/server/tests/pr10-notification-preferences.test.ts` | **جديد** — 11 اختباراً |
| `packages/web/src/lib/types.ts` | `NotificationChannel/Category/PreferenceRow/Matrix/Input` |
| `packages/web/src/lib/api.ts` | `notificationPreferences()` / `updateNotificationPreferences()` |
| `packages/web/src/pages/DashboardSimplePages.tsx` | بطاقة التفضيلات في `/dashboard/settings` |
| `packages/web/src/lib/i18n.ts` | 18 مفتاحاً × 4 لغات |
| `e2e/notification-preferences.spec.ts` | **جديد** — 3 حالات (لم تُشغَّل) |

**لا ترحيل، لا seed، لا تغيير مخطّط، لا تغيير صلاحيات، لا مساس بمسارات المال.**
