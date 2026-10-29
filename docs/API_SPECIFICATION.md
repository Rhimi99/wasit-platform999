# API SPECIFICATION — WASIT BUSINESS GLOBAL

كل المسارات تحت `/api`. الاستجابة الموحدة:

```json
{ "success": true, "data": ... }
{ "success": false, "error": { "code": "...", "message": "...", "fieldErrors"?: [...], "traceId"?: "..." } }
```

رموز HTTP: 200/201/400/401/403/404/409/422/429/500.

## المصادقة (`/api/auth`)

| Method | Path | الوصف | صلاحية |
| --- | --- | --- | --- |
| POST | `/register` | إنشاء حساب (role افتراضي CUSTOMER؛ يمنع SUPER_ADMIN؛ يقبل `phone` اختياريًا ويُطبّعه) | عام |
| POST | `/login` | تسجيل دخول (cookie أو Bearer)؛ حساب مُفعَّل عليه MFA يعيد `mfaRequired:true` + `challengeToken` بلا أي جلسة | عام |
| POST | `/logout` | إنهاء جلسة | مصادق |
| GET | `/me` | الحساب الحالي والأدوار | مصادق |
| POST | `/mfa/enroll` | بدء تفعيل المصادقة الثنائية (سر + QR URI + أكواد استرداد، الحالة `enabled=false`) | مصادق |
| POST | `/mfa/confirm` | تأكيد كود TOTP لإتمام التفعيل | مصادق |
| POST | `/mfa/disable` | تعطيل MFA (يلزم كود TOTP صالح) | مصادق |
| POST | `/mfa/challenge` | إتمام الدخول بعد التحدي (`challengeToken` + TOTP أو رمز استرداد) ⇒ إصدار الجلسة | عام (تحدي) |
| GET | `/mfa/status` | حالة MFA للحساب الحالي | مصادق |
| POST | `/mfa/recovery-codes` | إعادة توليد أكواد الاسترداد (يلزم TOTP) | مصادق |
| POST | `/mfa/verify` | تحقق مباشر من كود TOTP/استرداد للحساب | مصادق |
| POST | `/mfa/dev-totp` | كود TOTP للاختبار (404 في production) | dev |
| POST | `/verify-email/:token` | توثيق البريد | token |
| POST | `/forgot-password` | إرسال إعادة تعيين | عام |
| POST | `/reset-password/:token` | تعيين كلمة مرور | token |
| POST | `/phone/send` | إرسال كود تحقق بالهاتف (6 أرقام، TTL قابل للضبط) | مصادق |
| POST | `/phone/verify` | تأكيد كود الهاتف ⇒ `phone_verified=true` | مصادق |
| POST | `/dev/verification-link` | توكن توثيق بريد للاختبار (404 في production) | dev |
| POST | `/dev/phone-code` | كود هاتف صريح للاختبار (404 في production) | dev |

## الصحة (`/api/health`)

- `GET /live` — الوليف
- `GET /ready` — جاهزية DB
- `GET /channels` — حالة قنوات البريد/SMS ومخزن حدّ المعدل (`rateLimit.store`/`rateLimit.durable`) وإشعار التنبيهات (`observability.alerts.notifier`) بلا أي أسرار

## الملاحظة والتتبع (Observability)

- **Trace**: تُتبنّى ترويسة `traceparent` الواردة (أو `x-trace-id` مجرّد من 32 hex) وإلا يُولَّد معرّف جديد؛ تُعاد `X-Trace-Id` في كل استجابة، ويحمل كل خطأ `traceId`. `traceparent` الصادر للانتشار المستقبلي عبر `outboundTraceparent()`.
- `GET /metrics` (جذر، خارج `/api`) — Prometheus؛ يلزم `METRICS_ENABLED=true`، و`Authorization: Bearer $METRICS_TOKEN` إذا ضُبط التوكن؛ وإلا يُقيّد على شبكة السحب. يعيد 404 عند التعطيل و401 عند توكن خاطئ.
- `GET /api/admin/observability/metrics` — لقطة counters/gauges/histograms + التنبيهات الجارية + آخر تقييم + الـnotifier (يتطلب `admin:system`).
- `GET /api/admin/observability/logs?level=&limit=` — آخر السجلات المخزّنة (بحد أقصى 200، وتحقق صارم ⇒ 422).
- `GET /api/admin/observability/alerts?status=&since=&limit=` — سجل `alert_events` مع حالة التنبيهات الجارية.
- `POST /api/admin/observability/alerts/evaluate` — تشغيل تقييم القواعد فورًا (يُدقَّق `OBSERVABILITY.ALERTS_EVALUATED`).
- الانتقالات FIRING/RESOLVED تُدقَّق (`OBSERVABILITY.ALERT_FIRED`/`OBSERVABILITY.ALERT_RESOLVED`) وتُدفع عبر منفذ الإشعار (`OBS_ALERT_NOTIFY=log|webhook`).

## حدّ المعدل (Rate Limiting)

- المخزن يُختار بـ`RATE_LIMIT_STORE` (`memory` افتراضيًا، `postgres` للمشاركة بين النسخ).
- الموضوع: `user:<id>` للطلب المصادَق، `ip:<ip>` للمجهول.
- `POST /api/admin/rate-limits/purge` — حذف الدلاء المنتهية (يتطلب `admin:system`، يُدقَّق `RATE_LIMIT.PURGE_RUN`)

## الفئات (`/api/categories`)

- `GET /` — قائمة نشطة (sortOrder)
- `GET /:id` — تفاصيل
- `POST /` — إنشاء (يتطلب `PRODUCT_MANAGE`)
- (PATCH/DELETE قيد التوسيع)

## المنتجات (`/api/products`)

- `GET /` — قائمة (filter حسب seller/category/status/ق)
- `GET /mine` — منتجات الكيانات التي يملكها المستخدم الحالي (Auth) — كل الحالات
- `GET /:id` — تفاصيل + images/variants/category
- `POST /` — إنشاء (sellerId, sellerType, sku, categoryId, name, basePrice, currencyCode, moq, quantity)
- `PATCH /:id` — تعديل الحقول الوصفية/التجارية (name/nameAr/nameFr/description/brand/barcode/categoryId/basePrice/moq/unit/purchaseIntent). **مالك الكيان فقط** (403 لغيره، 401 لغير مصادق)، ويمنع 403 تعديل منتج موقوف إداريًا. الهوية (seller/SKU/currency) والمخزون غير قابلة للتعديل هنا؛ حقول فارغة تُخزَّن NULL، وتُعاد تسمية `slug`. Audit `PRODUCT.UPDATE`. جسم فارغ/فئة مجهولة/سعر سالب ⇒ 422. `PATCH /:id/status` لنشر/إلغاء النشر.
- (حذف المنتج الناعم/الأرشفة قيد الإكمال)

## الموردون (`/api/suppliers`)

- `GET /` — قائمة عامة (q, countryId, verified)
- `GET /:id` — ملف
- `POST /` — **يتطلب دور SUPPLIER** (409 إن وُجد ملف مسبقاً)
- `PATCH /:id` — تحديث (مقيد بالمالك)

## التجار (`/api/merchants`) و الشركات (`/api/companies`)

- `GET /` — قوائم عامة
- `GET /:id` — ملف
- `POST /` — **يتطلب MERCHANT / COMPANY**
- `PATCH /:id` — تحديث (مقيد بالمالك)

## البحث (`/api/search`)

- `GET /?q=...&page=&pageSize=` — بحث موحّد يرجع نتائج `{type, count, items}` لفئات: products/suppliers/merchants/companies/categories
- `optionalAuth`: البحث متاح للزوار؛ وعند وجود جلسة يُسجَّل البحث تلقائياً في سجل بحث المستخدم (best-effort، لا يُفشل البحث).

## مكتبة العميل (`/api/library`) — Auth مطلوب (صلاحية خاصة بكل قسم)

- المفضلة (`favorite:manage`): `GET /favorites?entityType=&page=&pageSize=` (مُثرى بـ title/slug/available)، `POST /favorites` `{entityType, entityId}` (idempotent)، `DELETE /favorites/:entityType/:entityId`
- المحفوظات (`saved:manage`): `GET /saved?itemType=&page=&pageSize=`، `POST /saved` `{itemType, itemId, notes?}` (إعادة الحفظ تُحدّث الملاحظات)، `DELETE /saved/:itemType/:itemId`
- سجل البحث (`search:history:manage`): `GET /search-history`، `POST /search-history` `{query, filters?, resultsCount?}`، `DELETE /search-history` (مسح الكل)، `DELETE /search-history/:id` (يملكه المستخدم فقط)
- `entityType`/`itemType` ∈ `PRODUCT | SUPPLIER | MERCHANT | COMPANY`
- Validation: كيان غير موجود → **404 NOT_FOUND**؛ نوع غير معروف → **422**؛ استعلام بحث فارغ → **422**
- عزل: كل البيانات مربوطة بـ `userId` من الجلسة؛ سجل بحث مستخدم آخر → **404** (لا يكشف الوجود)

## SEO (`/sitemap.xml`, `/robots.txt`, `/api/seo`) — عام بلا مصادقة

Crawler-facing surfaces: no auth, expose only already-public catalog data.

- `GET /sitemap.xml` — ديناميكي: الصفحات العامة الثابتة (رئيسية/سوق/موردون/تجّار/شركات/تصنيفات) + كل منتج `ACTIVE` **منشور** + موردون/شركات/تجّار `is_active` + أسواق البلدان النشطة. سقف 5000 URL، XML مُهرَّب، `Cache-Control: public, max-age=3600`. **لا يتضمّن** أي مسار خاص (`/admin`, `/dashboard`, `/checkout`, auth, `/search`).
- `GET /robots.txt` — `Allow` للأسطح العامة، `Disallow` لـ `/admin`, `/dashboard`, `/onboarding`, `/checkout`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/search`, `/api/`، مع مؤشر `Sitemap`.
- `GET /api/seo/structured-data/:type/:id` — JSON-LD:
  - `type` ∈ `PRODUCT | SUPPLIER | COMPANY | MERCHANT | CATEGORY | COUNTRY`
  - PRODUCT → schema.org `Product` + `Offer` (غير `ACTIVE`/غير منشور → **404**)؛ SUPPLIER/COMPANY → `Organization`؛ MERCHANT → `Store`؛ CATEGORY → `CollectionPage` (يُبحث بالـ slug)؛ COUNTRY → `Place` (يُبحث بالكود؛ غير نشط → **404**)
  - كيان غير موجود/غير عام → **404 NOT_FOUND**؛ نوع غير معروف → **422 VALIDATION_ERROR**

## الطلبات (`/api/orders`)

- `GET /` — طلباتي (browser)
- `GET /:id` — تفاصيل (مالك/بائع)
- `POST /` — إنشاء (buyerId, buyerType, items[{productId, quantity}]) — يتحقق من: وجود المنتج، الحالة ACTIVE، MOQ، المخزون؛ يحسب العمولة من السياسة ورسوم الدفع، ينشئ transaction + ledger + audit
- `PATCH /:id/status` — تحديث حالة (مقيد بمالك الصفقة أو بائع/مشتر). **`CONFIRMED` يتطلّب `paymentStatus='PAID'`** وإلا **409 `CONFLICT`** — التأكيد يحوّل الحجز إلى بيع، فلا يُسمح به قبل إثبات الدفع (webhook موقَّع أو إتمام `manual` لنيّة حقيقية). بقية الانتقالات بلا قيد دفع.

## المعاملات (`/api/transactions`)

- (مسارات إدارية عبر `/api/admin` حالياً؛ API مستقل قيد التوسع)

## الإدارة (`/api/admin`) — **ADMIN or SUPER_ADMIN حصراً**

- `GET /stats` — KPIs (users, products, orders, gmv)
- `GET /users` — قائمة مستخدمين (آخر 100)
- `PATCH /users/:id/status` — تفعيل/تعطيل (مع Audit)
- `GET /orders` — قائمة طلبات
- `GET /transactions` — قائمة معاملات
- `GET /ledger` — سجل الحركات
- `GET /products` — قائمة منتجات
- `GET /audit-logs` — سجل المراجعة
- Trade vetting (`/api/admin/trade`) — `ADMIN/SUPER_ADMIN` + صلاحية لكل نوع (`SUPPLIER|MERCHANT|COMPANY` `_LIST`/`_UPDATE`):
  - `GET /trade/{suppliers,merchants,companies}?q=&verified=&isActive=&page=&pageSize=` — قائمة كيانات البيع (تشمل غير النشطة، بخلاف الدليل العام) مع `kind` موحّد واسم مُطبَّع
  - `PATCH /trade/{suppliers,merchants,companies}/:id` — `{verified?, isActive?}` (واحد على الأقل؛ 422 خلاف ذلك، 404 لغير الموجود)؛ يُدقَّق `TRADE.VERIFIED|UNVERIFIED|SUSPENDED|REACTIVATED|STATUS_UNCHANGED` مع before/after وينعكس على `directory`/`search`/`sitemap`
- Policies (`admin:policies`):
  - `GET /policies/dispute` + `PUT /policies/dispute` + `GET /policies/dispute/resolved` — قواعد النزاع العامة/لكل دولة
  - `GET /policies/retention` + `PUT /policies/retention` + `GET /policies/retention/resolved` — قواعد الاحتفاظ بالبيانات (`PRIVACY/DATA_RETENTION`): `defaultRetentionDays`, `legalHoldFinanciallyRequired`, `preserves`. التجاهز لكل دولة؛ غياب صف الدولة يُسجَّل `DECISION_REQUIRED` ويُحلّ عند الإضافة. كل تعديل Audit (who/what/old/new/when/reason) ويرفع `version`.

## الخصوصية (`/api/privacy`) — Auth مطلوب

- `GET /consents` / `PUT /consents` — إدارة الموافقات (`consentType`, `granted`) وسجل append-only في `consentEvents`
- `POST /export` — توليد تصدير بيانات المستخدم (ملكية صارمة، بلا أسرار) + صف `dataExportRequests`
- `POST /deletion` — طلب حذف: يعطّل الحساب (`DEACTIVATED`) ويخزّن `retentionPolicy` المحلولة من Policy Engine (المدة، `preserves`، `policySource/id/version`، `countryCode`) + `retentionUntil`
- `GET /deletion` — حالة طلب الحذف الحالي
- Admin (`admin:privacy`): `GET /admin/privacy/deletions` (فلترة stage) و`PATCH /admin/privacy/deletions/:id` (تقدّم staged؛ `ANONYMIZED` يتطلب انتهاء نافذة الاحتفاظ أو `legalHoldOverride`)

## الرسائل (`/api/messages`) — Auth مطلوب (أي مستخدم مسجل)

- `GET /` — قائمة محادثاتي: `items[]` (كل عنصر: `id, subject, participants, unreadCount, lastMessage, updatedAt`), مؤيد بـ `?q= بحث , ?page=`
- `POST /` — فتح محادثة مباشرة: `{ participantUserId, subject?, body }` → `{ threadId, messageId }`
- `GET /:threadId` — تفاصيل المحادثة + كل الرسائل (يعلم القراءة تلقائياً read receipt)
- `POST /:threadId/messages` — إرسال رسالة `{ body, messageType? }`
- `POST /:threadId/read` — تعليم المحادثة مقروءة
- `GET /search?q=` — بحث في المحادثات والرسائل
- الملكية: غير المشارك → **403 FORBIDDEN**
- Validation: رسالة فارغة/أكبر من 5000 → **422**؛ الإرسال لنفسك → **422**؛ مستخدم غير موجود → **404**
- Audit: `MESSAGING.THREAD_CREATE`, `MESSAGING.MESSAGE_SEND`

## الإشعارات (`/api/notifications`) — Auth مطلوب

- `GET /` — قائمة إشعاراتي مع `unreadCount`
- `GET /unread-count` — عدد غير المقروء
- `POST /:id/read` — تعليم إشعار مقروء
- `POST /read-all` — تعليم الكل مقروء

## التحقق (`/api/verification`) — Auth مطلوب (PERMISSIONS.VERIFICATION_READ)

- `GET /me` — حالة التحقق الحالية (المستوى `currentLevel`/البريد/الهاتف/الطلب النشط/الخطوة التالية)
- `GET /policies` — سياسات التحقق من Policy Engine (قابلة للتعديل حسب الدولة)
- `GET /requests` — طلباتي
- `POST /requests` — تقديم طلب تحقق (`targetLevel`: BASIC|VERIFIED|BUSINESS_VERIFIED|INTERNATIONAL_VERIFIED + documentType/docRef)
- `POST /admin/verification/requests` (Admin) — قائمة كل الطلبات
- `POST /admin/verification/requests/:id/review` (Admin) — `{decision: APPROVED|REJECTED, notes?}` + Audit + إشعار

## الثقة (`/api/trust`) — Auth مطلوب (PERMISSIONS.TRUST_READ)

- `GET /me` — آخر درجة (`score` 0..100 + `level` LOW|MEDIUM|HIGH + العوامل + `summary` قابل للتفسير)
- `GET /me/history` — تاريخ الدرجات
- `POST /me/recompute` — إعادة احتساب (عوامل موثقة في Trust Engine، منفصل عن Risk)
- Admin: `GET /admin/trust` (قائمة)، `POST /admin/trust/:userId/recompute`

## المخاطر (`/api/risk`) — Staff فقط (RISK/ADMIN/SUPER_ADMIN، PERMISSIONS.RISK_READ)

- `GET /admin/risk/profiles` — كل ملفات المخاطر
- `GET /admin/risk/profiles/:userId` — ملف مستخدم
- `POST /admin/risk/profiles/:userId/reassess` — إعادة التقييم
- `GET /admin/risk/events` — أحداث + مستوى خطر + Reason Codes + إجراء موصى به
- منفصل عن Trust Engine تماماً (Trust = استحقاق/تاريخ، Risk = احتيال/شذوذ)

## مركز النزاعات (`/api/disputes`) — Auth مطلوب

- `POST /` — فتح نزاع على طلب (`orderId` + `reasonCode` + `description`)؛ يتحقق `isOrderParticipant`
- `GET /` — نزاعاتي (مشترك أو من فتحها)
- `GET /:id` — التفاصيل (أحداث/رسائل/أدلة) — المشاركون والموظفون فقط
- `POST /:id/messages` — رسالة (مشارك/موظف)
- `POST /:id/evidence` — إرفاق دليل (`fileRef`, `description`, `contentType`)
- `GET /policies` — قواعد النزاع من Policy Engine (قابلة للتعديل حسب الدولة)
- `GET /:id/appeals` — استئنافات النزاع (المشاركون والموظفون فقط)
- `POST /:id/appeals` — رفع استئناف (`reason`) — **أطراف الطلب فقط**؛ النزاع لازمه `DECIDED`/`CLOSED` مع `appealAllowed=true`؛ استئناف `PENDING` واحد كحد أقصى؛ ضمن نافذة `appealWindowDays` وبسقف `maxAppeals` من سياسة `DISPUTE_RESOLUTION`
- Admin (DISPUTE/ADMIN/SUPER_ADMIN):
  - `GET /admin/disputes` — كل النزاعات
  - `POST /admin/disputes/:id/assign` — إسناد إلى موظف (`reviewerUserId`)
  - `POST /admin/disputes/:id/status` — تغيير الحالة
  - `POST /admin/disputes/:id/decide` — `{decision: IN_FAVOR_OF_BUYER|IN_FAVOR_OF_SELLER|REJECTED|REFUND_ISSUED, note?}`
  - `GET /admin/disputes/:id/appeals` — استئنافات النزاع للمراجعة
  - `POST /admin/disputes/:id/appeals/:appealId/review` — `{status: ACCEPTED|REJECTED, note?}` — `ACCEPTED` يعيد فتح النزاع (`UNDER_REVIEW`) ويعطّل المزيد من الاستئنافات؛ من أصدر القرار الأصلي **متنحٍّ** (403)
  - كل إجراء يُسجَّل حدثاً (`dispute_events`) + إشعار + Audit

## الدفع (`/api/payments`) — Auth مطلوب

- `GET /methods` — قدرات المزوّدين: `{ active, providers: [{ id, functional, available, methods: [{ method: {type, scheme?}, available, reason? }] }] }`. يُرجع كل المزوّدين المعروفين مع `available=false` وسبب واضح عند غياب الاعتمادات — لا يُخفى مزوّد ولا يُزيَّف توفّره.
- `POST /orders/:orderId/intent` — `{ idempotencyKey?, method?: {type: CARD|MOBILE_WALLET, scheme?: VISA|MASTERCARD|CIB|D17|FLOUCI_WALLET} }`. يتحقق أن المزوّد النشط يدعم method المطلوبة فعليًا (وإلا 422/503)، ويُخزّن `method`+`scheme` على الـintent، ويُرجع `{ intent, checkoutUrl, reused }`. يعيد نفس الـintent عند إعادة نفس `idempotencyKey`.
- `GET /orders/:orderId` — `{ intent, payment }` — مقصور على أطراف الطلب (أو `payment:read`).
- `GET /orders/:orderId/refunds` — قائمة الاستردادات.
- `POST /orders/:orderId/refunds` — `{ amount?, reason?, idempotencyKey? }` (صلاحية `REFUND_MANAGE`)؛ يمنع الاسترداد الزائد (422).
- Webhooks: `POST /api/payment-webhooks` (غير مصادق، HMAC للـmanual/open-checkout). للمزوّدين بلا توقيع موثّق (Flouci/ClicToPay) تُعاد قراءة الحالة من المزوّد ويُطابَق المبلغ قبل أي side-effect.

> تفاصيل المزوّدين والتوجيه: `docs/PAYMENT_PROVIDERS.md`.

## الوسائط / الفيديو التسويقي (`/api/media`) — Auth مطلوب

- `POST /marketing-videos` — توليد فيديو تسويقي حقيقي لمنتج. Body: `productId` (إلزامي)،
  `title?`، `language?` (`ar|fr|en|zh`)، `audience?` (`B2B|B2C`)، `style?`
  (`MODERN|MINIMAL|BOLD|ELEGANT`)، `durationSeconds?` (**35–120 ثانية شاملة؛ الافتراضي 60**؛
  أي قيمة خارج النافذة تُرفض بـ422)، `campaignId?`.
  صلاحية `media:upload`؛ المنتج يجب أن يخصّ كيان المستخدم (أو Admin) وأن يكون **ACTIVE**.
  يعيد 201 بأصل `READY` مع `previewUrl`/`downloadUrl` موقّعين. **المدة المُخزَّنة تُقاس فعليًا من
  bytes الـMP4 الناتج (`moov/mvhd`) لا من قيمة الطلب؛ وإن خرجت المدة الفعلية عن 35–120 يُرفض
  الأصل ولا يُصبح READY.** يُسجَّل في AI Cost Control.
- `GET /assets` — مكتبة وسائط المالك (filters: `kind`, `productId`, `limit`)
- `GET /assets/:id` — تفاصيل أصل مملوك (أو Admin)
- `DELETE /assets/:id` — حذف ناعم (DELETED) مع إبقاء السجل للـ Audit
- `GET /assets/:id/content?token=…` — بث/تنزيل الأصل برابط موقّع قصير العمر + دعم Range
  (`MEDIA_DOWNLOAD_TTL_SECONDS`). لا ملفات ثابتة عامة.

## المالية الإدارية (`/api/admin/finance`) — `commission:manage` أو `payment:read`

| Method | Path | الوصف |
|---|---|---|
| GET | `/api/admin/finance/payout-providers` | كتالوج مسارات Payout المتاحة |
| POST | `/api/admin/finance/settlements/confirm` | تأكيد تسوية من دليل المزوّد (idempotent) |
| POST | `/api/admin/finance/payouts` | إنشاء Payout (يبدأ `CREATED`) |
| GET | `/api/admin/finance/payouts` | قائمة Payout بترقيم صفحات (افتراضي 20، سقف 100) |
| GET | `/api/admin/finance/payouts/:id` | قراءة Payout |
| POST | `/api/admin/finance/payouts/:id/dispatch` | إرسال Payout للمسار (يصل `PROCESSING` فقط) |
| POST | `/api/admin/finance/payouts/:id/sync` | إعادة فحص Payout مع المسار |
| POST | `/api/admin/finance/reconciliation/import` | استيراد تغذية مطابقة كـJSON (provider/bank/ledger) |
| POST | `/api/admin/finance/reconciliation/preview-file` | **معاينة** ملف مطابقة (لا تكتب شيئًا) |
| POST | `/api/admin/finance/reconciliation/import-file` | استيراد ملف مطابقة (CSV/TSV/JSON) |
| POST | `/api/admin/finance/receipts` | تسجيل وصول عمولة WASIT من دليل مستقل |

**استيراد ملفات المطابقة** (الملحق أ.5-1): يُرسل الملف كـ`multipart/form-data` تحت الحقل `file`، مع `source=PROVIDER|BANK` و`currencyCode` في سلسلة الاستعلام (`importKey`/`providerId` اختياريان للاستيراد). التفاصيل الكاملة في `docs/RECONCILIATION_FILE_IMPORT.md`.

## بقية الوحدات (Routes تحت التطوير)

`/users`, `/ads`, `/ai`, `/analytics`, `/geo`, `/policies`, `/subscriptions`, `/subscriptions/plans`, `/refunds`, `/commissions`

## تحصيل فواتير الاشتراك (`/api/subscriptions`)

كل التحصيل يمر عبر منفذ مزوّد الدفع (`lib/payments/port.ts`) — لا يُعلَّم invoice مدفوعًا مباشرة.

| Method | Path | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/api/subscriptions/plans` | auth | كتالوج الخطط النشطة |
| GET | `/api/subscriptions/me` | auth | اشتراك المستخدم الحالي |
| POST | `/api/subscriptions` | `subscription:create` | إنشاء اشتراك |
| POST | `/api/subscriptions/:id/cancel` | `subscription:cancel` | إلغاء (يبقى فعّالًا حتى `endsAt`) |
| GET | `/api/subscriptions/me/invoices` | `subscription:read:own` | فواتير المستخدم |
| POST | `/api/subscriptions/me/invoices/:id/pay` | `subscription:read:own` | بدء الدفع عبر المزوّد (يعيد `checkoutUrl`)، idempotent، 403 لفاتورة الغير |
| POST | `/api/subscriptions/admin/invoices/:id/collect` | `subscription:manage` | تسوية مكتبية عبر المزوّد (`isOperator`) |
| GET | `/api/subscriptions/admin/invoices/pending` | `subscription:manage` | قائمة التحصيل (dunning) |
| POST | `/api/subscriptions/admin/invoices/:id/expire-lapsed` | `subscription:manage` | إنهاء الاشتراكات المنقضية |
| POST | `/api/subscriptions/admin/rollover` | `subscription:manage` | تجديد الاشتراكات المستحقة (idempotent) |

التسوية الإلكترونية تأتي عبر webhook الدفع: `intentTarget()` يوجّه الحدث إلى `applyInvoicePaymentSucceeded`/`applyInvoicePaymentFailed`. الحالات: invoice `PENDING→PAID` (تمديد الفترة) أو `PENDING→FAILED` (الاشتراك `PAST_DUE`، ثم EXPIRED بعد grace). إيراد الاشتراك على صف الفاتورة فقط — لا يُخلط في `transactions`/GMV.

## التحليلات والعائد (`/api/admin/analytics`) — `ADMIN_ANALYTICS`

كل الأرقام مجمّعة من جداول حقيقية (orders / transaction_ledger / invoices / ai_usage / revenue_accounts)، ومحصورة بعملة واحدة (لا صرف عملات). كل قراءة تُقيَّد بـ Audit.

| Method | Path | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/api/admin/analytics/overview` | `admin:analytics` | KPIs المنصّة (مستخدمون/GMV/عمولة/مخزون/حملات) |
| GET | `/api/admin/analytics/retention` | `admin:analytics` | نشط/جديد/جلسات (30d/90d) |
| GET | `/api/admin/analytics/conversion` | `admin:analytics` | تحويل الطلبات المدفوعة + AOV |
| GET | `/api/admin/analytics/revenue-breakdown` | `admin:analytics` | تفصيل الإيراد من الـLedger |
| GET | `/api/admin/analytics/unit-economics` | `admin:analytics` | **CAC / LTV / Contribution Margin** (انظر أدناه) — Audit `ANALYTICS.UNIT_ECONOMICS_READ` |
| GET | `/api/admin/analytics/cohorts` | `admin:analytics` | Cohorts شهرية للعملاء الجدد (GMV/هامش محقَّق) |
| GET | `/api/admin/analytics/daily-kpis` | `admin:analytics` | آخر KPIs اليومية |
| POST | `/api/admin/analytics/daily-kpis/rollup` | `admin:analytics` | حساب rollup اليوم من بيانات حقيقية |
| GET/POST | `/api/admin/analytics/reports` | `admin:analytics` | تقارير محفوظة |
| GET | `/api/admin/analytics/users/:userId/overview` | `admin:analytics` | تحليلات مستخدم معيّن |

### Unit Economics (`GET /api/admin/analytics/unit-economics`)

Query: `currency` (ISO-3، افتراضي TND)، `windowDays` (1–365، افتراضي 30)، `retentionMonths` (0–120، افتراضي 12)، `ordersPerMonth` (0–1000، افتراضي 1). أي قيمة خارجية → 422 بـ`fieldErrors`.

المعادلات (Decimal، تقريب HALF_UP إلى 4 منازل):
- `cac = marketingSpend ÷ newCustomers` (null إن لا cohort) — `marketingSpend` = مجموع `revenue_accounts` حيث `line_type=COST` و`category=MARKETING` داخل النافذة وبالعملة؛ `newCustomers` = عدد المشترين الذين **أول** طلب لهم (بهذه العملة) داخل النافذة.
- `ltvRealized = arpu = Σ(commission + payment_fee) ÷ customersWithOrders` (هامش محقَّق فعليًا).
- `ltvProjected = (grossMarginTotal ÷ paidOrders) × ordersPerMonth × retentionMonths` — نموذج صريح يُعاد في `assumptions` وليس حقيقة.
- `ltvCacRatio = ltvRealized ÷ cac` (null إن كان CAC غائبًا/صفرًا).
- `contributionMarginPct = Σ(commission + payment_fee) ÷ GMV × 100`.

`basedOn` يُعيد مصادر البيانات والقيود (نطاق عملة واحدة، أن `ltvProjected` تقديري، وأن ميزانيات المعلنين ليست تكلفة اكتساب).

## توثيق المعلمات

- Pagination: `page` (1-based), `pageSize` (default 20, max 100)
- التوطين: `Accept-Language: ar|fr|en`
- العملة: كود ISO 3 (مثل TND) — النصوص المعروضة/الحواشي قابلة للتكوين عبر Currency Engine

## مباشرة التوثيق

- الكود المصدري هو المرجع للتفاصيل (`src/modules/<name>/routes.ts` + `service.ts`).