# B2B-01 — دورة حياة طلب عرض السعر (RFQ) والعروض والتفاوض

> حالة: **المرحلة 1 + المرحلة 2 + المرحلة 3 مكتملة ومتحققة** (كود + اختبارات حقيقية على PostgreSQL + متصفح حقيقي + توثيق).
> المرحلة 3 هنا = **مقارنة العروض + انتهاء الصلاحية الموثوق**. أما «قبول عرض ← طلب حقيقي» فهي المرحلة 4 **ولم تبدأ** ولم تُلمس عمدًا.

## 1. النموذج

| الكيان | الدور | ما لا يفعله |
| --- | --- | --- |
| `rfqs` | مستند تفاوض تنشئه **شركة** مشترية | لا يحمل مالًا ولا مخزونًا |
| `rfq_items` | بنود مطلوبة (منتج كتالوج أو نص حر) | لا تُسعَّر إلا في عرض البائع |
| `rfq_recipients` | دعوة بائع محدَّد + حالتها | لا تُنشأ بعد `SEND` |
| `rfq_quotes` | إصدارات عرض البائع (rev 1..N) | لا تُعدَّل بعد الإرسال |
| `rfq_quote_lines` | بنود العرض (سعر وحدة × كمية) | لا تُعدَّل ولا تُحذف إطلاقًا |
| `rfq_events` | سجل زمني append-only للمشاركين | لا يُعدَّل ولا يُحذف |

**لا محفظة، لا دفتر قيود، لا دفع.** العرض يُسعَّر ويُقارَن، ولا يصبح طلبًا إلا في المرحلة 3 عبر `createOrder` الموجود.

## 2. آلة حالات RFQ

```
DRAFT ──send──▶ OPEN ──cancel──▶ CANCELLED (نهائي)
  │               │──expire (كسول)──▶ EXPIRED (نهائي)
  └──cancel──▶ CANCELLED
                  └──(المرحلة 3)──▶ AWARDED ──▶ CLOSED
```

- `DRAFT` لا يقبل عروضًا ولا يعرفه البائعون إطلاقًا.
- `EXPIRED` و`CANCELLED` و`CLOSED` نهائية: لا إحياء، ولا تمديد لـ`expires_at` (غير قابل للكتابة عبر الـAPI).
- الانتقالات معرّفة في `modules/rfq/lifecycle.ts` ومفروضة عبر `assertRfqTransition`؛ أي محاولة أخرى ⇒ `409`.

## 3. آلة حالات الدعوة (`rfq_recipients`)

```
INVITED ──first read──▶ VIEWED ──quote──▶ QUOTED ──withdraw──▶ WITHDRAWN ──quote──▶ QUOTED
   │                        │                 ▲
   └──decline──▶ DECLINED ◀─┘                 └──revise── QUOTED (rev +1)
                   (نهائي: لا اقتباس بعد الرفض)
```

- `VIEWED` يُكتب مرة واحدة عند أول قراءة للبائع (تحديث محروس على `INVITED`)، فلا حدث مكرر.
- `DECLINED` نهائي. البائع الذي لديه عرض حيّ **لا** يرفض الدعوة؛ عليه سحب عرضه أولًا.
- `WITHDRAWN` يمكنه العودة إلى `QUOTED` (إعادة دخول بإصدار جديد).

## 4. آلة حالات العرض (`rfq_quotes`)

```
SUBMITTED ──revise──▶ SUPERSEDED (نهائي)
    │──withdraw (البائع)──▶ WITHDRAWN (نهائي)
    │──reject (المشتري + سبب إلزامي)──▶ REJECTED (نهائي)
    │──validity lapsed──▶ EXPIRED (نهائي)
    └──(المرحلة 3)──▶ ACCEPTED (نهائي)
```

**كل ما ليس `SUBMITTED` نهائي.** لذلك:

- الإصدار القديم لا يمكن سحبه ولا رفضه (409)، ولا توجد أي مسار `PATCH/PUT/DELETE` على العروض أو السجل.
- عند إصدار جديد، الإصدار السابق **الحيّ** يصبح `SUPERSEDED`؛ أما `REJECTED`/`WITHDRAWN` فيبقى على حاله (القرار المُسجَّل حقيقة) ويُربط الإصدار الجديد بـ`supersedes_id`.

### حُرّاس قاعدة البيانات (migration `0046_rfq_lifecycle`)

| الحارس | الأثر |
| --- | --- |
| `rfq_events_no_rewrite` | `UPDATE/DELETE` على السجل الزمني ⇒ استثناء |
| `rfq_quote_lines_no_rewrite` | تعديل/حذف بنود عرض ⇒ استثناء |
| `rfq_quotes_frozen_terms` | تغيير `items_total`/`currency_code`/`revision`/`valid_until`/`seller_*`/`supersedes_id` ⇒ استثناء |
| `rfq_quotes_terminal_status` | إعادة فتح حالة نهائية ⇒ استثناء |
| `rfq_quotes_no_delete` | حذف عرض ⇒ استثناء |

السبب: قاعدة في الخدمة يمكن أن ينساها مسار لاحق؛ التريغر لا يُنسى.

## 5. الانتهاء (مسار طلب + مهمة دورية)

المنطق كله في وحدة واحدة: `modules/rfq/expiry.ts`. مسار الطلب والمهمة الدورية يستدعيان نفس الدالتين، فلا يمكن أن تختلف دلالة «انتهى» بين القراءة والخلفية.

**أ. تقييم عند كل وصول (Lazy)** — `expireRfqIfDue` و`expireLapsedQuotes`:

- `expires_at` للطلب و`valid_until` للعرض يُقيَّمان قبل أي قرار أو إسقاط.
- التحديث عبارة SQL واحدة محروسة (`where status='OPEN' and expires_at <= now() returning id`)، لذا تحت قراءات متزامنة **واحد فقط** يفوز ويكتب حدث `EXPIRED` واحد بـ`actorType='SYSTEM'` و`actorUserId=null`.
- `expireRfqIfDue` يعيد `{ rfq, transitioned }`: `transitioned=true` للفائز وحده. هذا ما يجعل عدّادات المهمة الدورية صادقة (الخاسر في السباق يرى `EXPIRED` لكنه لا يعُدّها Transition ولا يكتب حدثًا).
- بعد الانتهاء: لا اقتباس، لا إصدار جديد، لا رفض، لا رفض دعوة. **السحب يبقى مسموحًا** لأنه إزالة عرض لا إنشاء التزام.

**ب. مهمة دورية (Sweep)** — `runRfqExpirySweep(db, { batchSize, maxBatches })`:

| الخاصية | كيف تُنفَّذ (لا تُفترض) |
| --- | --- |
| تكرار آمن | الفحص شرطي (`status='OPEN'`) فالجولة الثانية تجد صفرًا وتعيد `{0,0}` |
| تزامن آمن | كل انتقال هو الـUPDATE المحروس أعلاه؛ لا يستطيع إلا واحد أن يكتبه |
| لا أحداث مكررة | الحدث يُكتب **داخل نفس المعاملة** وللفائز فقط (`transitioned`) |
| لا تغيير لسجل محسوم | المسند `status='OPEN'` و`quote_status='SUBMITTED'` يستثني `AWARDED`/`CANCELLED`/`EXPIRED` و`REJECTED`/`WITHDRAWN`/`SUPERSEDED` من العبارة نفسها |
| بلا حذف | لا `DELETE` في الوحدة إطلاقًا |
| بلا إشعار خارجي | `notifications` صفوف داخلية فقط؛ لا بريد/SMS/Webhook |
| محدود | `batchSize` (افتراضي 100) و`maxBatches` (افتراضي 20) ويعيد `truncated` عند بلوغ السقف |
| مسجَّل | `payload = { scope, expiresAt\|validUntil, reason, fromStatus }` — `RESPONSE_WINDOW_LAPSED` للطلب و`QUOTE_VALIDITY_LAPSED` للعرض |

- الترتيب `order by expires_at` ودفعاته: عاملان يأخذان الصفوف بالترتيب نفسه ⇒ لا تعارض أقفال.
- **التوصيل**: `RFQ_EXPIRY_SWEEP_ENABLED` (افتراضي `false`)، `RFQ_EXPIRY_SWEEP_INTERVAL_MINUTES` (5)، `RFQ_EXPIRY_SWEEP_BATCH_SIZE` (100) في `lib/env.ts` ← `startScheduler()` (`lib/scheduler.ts`) ← `src/index.ts`. الوظيفة نفسها قابلة للاستدعاء من cron خارجي.
- **الفهارس** (migration `0047`، إضافية فقط): `rfqs_open_expires_idx (expires_at) where status='OPEN'` و`rfq_quotes_live_expiry_idx (valid_until) where quote_status='SUBMITTED'`.
- `expireIfDue` الخاص بالمرحلة 2 أُزيل و`recordEvent` نُقل إلى `modules/rfq/events.ts` — لا نسختين من القاعدة نفسها.

## 6. واجهة الـAPI

كل المسارات تحت `/api/rfqs`، وكلها `requireAuth` + صلاحية + تحقق `zod .strict()` + `Audit`.

| Method | المسار | الصلاحية | ملاحظات |
| --- | --- | --- | --- |
| POST | `/api/rfqs` | `rfq:create` | ينشئ `DRAFT` للشركة المملوكة للمستدعي فقط |
| GET | `/api/rfqs` | `rfq:read:own` | طلبات شركة المستدعي |
| GET | `/api/rfqs/inbox` | `rfq:read:own` | دعوات البائع (تُفرَّغ عند سحب الموافقة) |
| GET | `/api/rfqs/:id` | `rfq:read:own` | أول قراءة للبائع ⇒ `VIEWED` |
| POST | `/api/rfqs/:id/send` | `rfq:create` | يتطلب `acknowledgeDisclosure:true` وموافقة كل بائع |
| POST | `/api/rfqs/:id/cancel` | `rfq:create` | `DRAFT`/`OPEN` فقط |
| POST | `/api/rfqs/:id/decline` | `rfq:quote` | بائع مدعو، دعوة غير مجابة |
| POST | `/api/rfqs/:id/quotes` | `rfq:quote` | إصدار جديد (rev +1)، حد الجولات من السياسة |
| GET | `/api/rfqs/:id/quotes` | `rfq:read:own` | المشتري: أحدث إصدار لكل بائع · البائع: عرضه فقط |
| POST | `/api/rfqs/:id/quotes/:quoteId/withdraw` | `rfq:quote` | عرض حيّ للبائع نفسه فقط |
| POST | `/api/rfqs/:id/quotes/:quoteId/reject` | `rfq:decide` | المشتري، `reason` إلزامي (≥3) |
| GET | `/api/rfqs/:id/quotes/:quoteId/revisions` | `rfq:read:own` | سلسلة الإصدارات كاملة (المشتري أو صاحبها) |
| GET | `/api/rfqs/:id/comparison` | `rfq:read:own` | **مقارنة للقراءة فقط**؛ المشتري: كل البائعين · البائع: عرضه وحده (`scope: OWN`) |
| GET | `/api/rfqs/:id/timeline` | `rfq:read:own` | مُرشَّح بالرؤية لكل طرف |

### عقد الاستجابات

- `quote`: `{ id, sellerId, sellerType, revision, status, currencyCode, itemsTotal, leadTimeDays, paymentTerms, notes, validUntil, submittedAt, decidedAt, decisionReason, withdrawnAt, withdrawalReason, expiredAt, lines[] }`.
- `recipient`: `{ sellerId, sellerType, sellerName, status, invitedAt, viewedAt, respondedAt, declinedAt, declineReason }`.
- `timeline entry`: `{ id, eventType, actorType, quoteId, quoteRevision, payload, createdAt }`.
- `comparison`: `{ rfq:{id,rfqNumber,title,currencyCode,status,neededBy,expiresAt,acceptsQuotes}, scope:'ALL'|'OWN', items[], rows[], excluded[], summary, generatedAt }` — `rows[]` بأحدث مراجعة صالحة فقط، وكل سطر يحمل `requestedQuantity` و`quotedQuantity` و`unitPrice` و`lineTotal` و`targetDelta`؛ `excluded[]` بسبب صريح.
- لا `userId`، لا `email`، لا `phone`، ولا أي حقل دفع في أي إسقاط (الإسقاطات تُبنى حقلاً حقلاً، لا بـ`spread`).

## 7. ما يرفضه الخادم صراحةً

| المحاولة | النتيجة |
| --- | --- |
| بائع غير مدعو يقرأ/يقتبس/يراجع | `404` (لا `403`: لا يُكشف وجود الطلب) |
| بائع يسحب/يقرأ إصدارات عرض بائع آخر | `404` |
| سحب أو رفض إصدار `SUPERSEDED` | `409` |
| إصدار جديد بعد انتهاء صلاحية العرض | `409` |
| إرسال بلا إقرار الإفصاح | `422` (`DISCLOSURE_NOT_ACKNOWLEDGED`) |
| دعوة بائع بلا `RFQ_PARTICIPATION` (ولو كان `B2B_PARTNER_DISCOVERY`) | `409` |
| عملة عرض ≠ عملة الطلب | `409` |
| تجاوز `maxRounds` | `409` |
| رفض بلا سبب (أو سبب < 3) | `422` |
| إلغاء بعد الإلغاء / اقتباس بعد الإلغاء أو الانتهاء | `409` |
| `buyerCompanyId`/`sellerId`/`recipientStatus` في الجسم | `422` (`.strict()`) — الهوية من الجلسة فقط |
| `PATCH/DELETE` على العروض أو السجل | `404/405` (لا مسار) + تريغر يمنعها في القاعدة |

## 8. الإشعارات

كلها **داخلية** في جدول `notifications` (لا بريد، لا SMS):

| النوع | المستلم |
| --- | --- |
| `RFQ_INVITATION` | كل بائع مدعو |
| `RFQ_QUOTE_RECEIVED` | المشتري |
| `RFQ_QUOTE_WITHDRAWN` | المشتري |
| `RFQ_QUOTE_REJECTED` | البائع صاحب العرض |
| `RFQ_INVITATION_DECLINED` | المشتري |
| `RFQ_QUOTE_EXPIRED` | البائع |
| `RFQ_CANCELLED` / `RFQ_EXPIRED` | المشتري + البائعون |

`data` يحمل `{ rfqId, quoteId? }` فقط، والنص يحمل رقم الطلب — لا بريد ولا هاتف ولا `userId` (مُثبَت باختبار).

## 9. الأحداث والتدقيق

| الحدث (`rfq_events`) | الفاعل | الرؤية | يحمل |
| --- | --- | --- | --- |
| `CREATED` | المشتري | المشتري | عدد البنود |
| `SENT` | المشتري | الطرفان | عدد المدعوين، `expiresAt` |
| `VIEWED` | البائع | الطرفان + البائع المعني | نوع البائع |
| `RECIPIENT_DECLINED` | البائع | الطرفان + البائع المعني | السبب |
| `QUOTE_SUBMITTED`/`QUOTE_REVISED` | البائع | الطرفان + البائع المعني | `revision`، `itemsTotal`، `quoteId` |
| `QUOTE_WITHDRAWN` | البائع | الطرفان + البائع المعني | `revision`، السبب |
| `QUOTE_REJECTED` | المشتري | الطرفان + البائع المعني | `revision`، السبب |
| `CANCELLED` | المشتري | الطرفان | السبب |
| `EXPIRED` | `SYSTEM` | الطرفان | `scope` + `expiresAt`/`validUntil` + `reason` + `fromStatus` (+ `revision` للعرض) |

وفي `audit_logs`: `RFQ.CREATED`, `RFQ.SENT`, `RFQ.CANCELLED`, `RFQ.EXPIRED`, `RFQ.QUOTE_SUBMITTED`, `RFQ.QUOTE_REVISED`, `RFQ.QUOTE_WITHDRAWN`, `RFQ.QUOTE_REJECTED`, `RFQ.INVITATION_DECLINED` — مع الفاعل وIP/UA و`before/after`.

## 10. السياسة (Policy Engine)

`B2B/RFQ_TERMS`: `quoteValidityDays` (1..365)، `maxRounds` (1..20)، `maxRecipientsPerRfq` (1..50)، `maxItemsPerRfq` (1..200)، `responseWindowDays` (1..180).
تُقرأ عند الإنشاء وعند الإرسال وتُثبَّت في الصف، فلا يغيّر تعديل السياسة لاحقًا طلبًا جاريًا. غياب الصف ⇒ القيم الافتراضية المحافظة في `modules/rfq/policy.ts` (لا Hardcode في المسارات).

## 11. واجهة الويب

| المسار | الصفحة | من يراها |
| --- | --- | --- |
| `/dashboard/rfqs` | `DashboardRfqListPage` — قائمة طلبات الشركة + نموذج الإنشاء (بنود ديناميكية) | COMPANY (`rfq.buy`) |
| `/dashboard/rfqs/:id` | `DashboardRfqDetailPage` — لوحة المشتري أو لوحة البائع حسب ما يعيده الخادم | المشاركون |
| `/dashboard/rfq-inbox` | `DashboardRfqInboxPage` — الدعوات الواردة | MERCHANT · SUPPLIER · COMPANY (`rfq.sell`) |

- **الملف**: `packages/web/src/pages/DashboardRfqPages.tsx` · الأنواع في `lib/types.ts` · العملاء في `lib/api.ts` · المفاتيح في `lib/i18n.ts` (ar/fr/en/zh، 131 مفتاحًا لكل لغة).
- **لوحة المشتري**: إرسال الدعوات (بحث في دليل المورّدين + إقرار الإفصاح)، جدول الدعوات وحالتها مع سبب الاعتذار، العروض مع الإجمالي و`rev` والمدة وصلاحية العرض، **الإصدارات**، الرفض بسبب إلزامي، الإلغاء بسبب اختياري.
- **لوحة البائع**: حالة دعوتي، نموذج عرض (سعر وحدة لكل بند + مدة + شروط دفع + ملاحظات)، إعادة الإرسال كإصدار جديد، السحب (للعرض الحيّ فقط)، الاعتذار بسبب.
- **لوحة المقارنة** (`ComparisonPanel` داخل لوحة المشتري): زر «مقارنة العروض» يجلب `GET /:id/comparison` ويعرض ترتيبًا جاهزًا من الخادم — الإجمالي، مدة التوريد، صلاحية العرض، الشروط والملاحظات، ومصفوفة سعر الوحدة لكل بند، وقائمة **العروض المستبعدة بسببها**. الواجهة **لا تفرز ولا تجمع** أي رقم بنفسها.
- **السجل الزمني** ظاهر للطرفين مع نوع الحدث والإصدار.
- **ممنوعات في الواجهة**: لا تحسب أي إجمالي (تقرأ `lineTotal` من الخادم)، ولا ترسل `buyerCompanyId`/`sellerId`، ولا تعرض البريد/الهاتف. زر لا يظهر ≠ صلاحية: كل مسار محمي في الخادم.
- **i18n**: `rfq.*` + `rfq.status.*` + `rfq.event.*` في الأربع لغات، مع RTL للعربية (اختُبر في متصفح حقيقي بالعربية والفرنسية والإنجليزية والصينية).

## 12. الإثبات

| الملف | الحالات |
| --- | --- |
| `tests/b2b01b-lifecycle-unit.test.ts` | 8 |
| `tests/b2b01b-rfq-lifecycle.test.ts` | 22 |
| `tests/b2b01-rfq-isolation.test.ts` (المرحلة 1) | 24 |
| `tests/b2b01c-comparison-expiry.test.ts` (المرحلة 3) | 21 |

فحوص المرحلة 3 تحديدًا: مقارنة ثلاثة عروض (إجمالي/وحدة/كمية/عملة/مدة/صلاحية/شروط/حالة/إصدار) · اختلاف مدد التوريد · استبعاد المراجعات القديمة كـ`SUPERSEDED` · استبعاد المنتهي/المسحوب/المرفوض بأسبابها · منع خلط العملات وعدم دخولها في أي إحصاء · عزل المورّد (`scope: OWN`، ولا يظهر إجمالي منافسه في الـpayload) · 404 لغير المشارك ولشركة أخرى و401 للمجهول · `RFQ_NOT_OPEN` بعد الإلغاء · رفض كمية مختلفة (422) · «المقارنة لا تكتب» (طلبات/ledger/payments/settlements/عروض) · الانتهاء مرة واحدة مع `reason` و`expiresAt` · الجولة الثانية صفر · خمس جولات متزامنة ⇒ 3 طلبات/3 عروض بلا تكرار · الاحتفاظ بـ`AWARDED`/`CANCELLED`/`EXPIRED` وبالعروض المحسومة · عدم إحياء طلب منتهٍ · دفعات محدودة بـ`maxBatches` · عدم تغيير أي بيانات مالية.

وبالمتصفح (`scripts/ui-rfq-check.mjs` — 38 فحصًا ضد API حقيقي وPostgres حقيقي، بلا أي mock): إنشاء طلب من النموذج · ظهور البنود · لوحة الإرسال في `DRAFT` واختفاؤها بعد الإرسال · صندوق البائع · تقديم عرض ثم إعادة إرساله كإصدار جديد · رفض المشتري بسبب وقراءة البائع له · الإصدارات · الاعتذار عن الدعوة · الإلغاء · قفل التفاوض بعد الإلغاء · لوحة المقارنة (الترتيب، أفضل سعر، مصفوفة أسعار الوحدة، استبعاد المراجعة القديمة) · عرض النصوص بالعربية والفرنسية والإنجليزية والصينية · صفر أخطاء JavaScript في الصفحة.

## 13. المرحلة 4 (غير مبدوءة)

قبول عرض (`ACCEPTED` + `rfq.status='AWARDED'`) ← إنشاء طلب عبر `createOrder` (عمولة من السياسة، هوية COMPANY) ← `CLOSED`.
لا يوجد اليوم أي مسار يكتب `ACCEPTED` أو `AWARDED`؛ الحالة معلنة في آلة الحالات فقط لتكون المرحلة 4 امتدادًا لا إعادة كتابة. المرحلة 3 أضافت **قراءة** فقط: لا قبول ولا تحويل ولا كتابة مالية.
