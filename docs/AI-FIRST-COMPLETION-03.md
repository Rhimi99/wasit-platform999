# AI-FIRST COMPLETION 03 — إغلاق فجوات نطاق البيانات + وكيل فيديو يُنتج فيديو فعلياً

**التاريخ:** 2026-11-22 · **الفرع:** `ai-first-completion` · **الأساس:** `7aa9953` (فوق `8078408`، فوق `master` @ `1363682`)
**السابق:** `AI-FIRST-COMPLETION-02`

---

## 1. الأولوية الأولى — نطاق بيانات الوكلاء الستة

### 1.1 ما كان مكسوراً فعلاً (فحص الاستعلامات لا التسمية)

| الوكيل | ما كان يقرأه الاستعلام | المشكلة |
| --- | --- | --- |
| `sales-agent` | `orders` كل المستأجرين + عدد كل الموردين/التجار/الشركات + متوسط الثقة العام | عميل يرى GMV وطلبات المنصة، ويستنتج حجم أعمالها |
| `marketing-agent` | كل `products` المنشورة + تصنيفاتها وماركاتها | تاجر يرى كتالوج منافسيه بالاسم |
| `product-agent` | `pickProduct` **بلا مالك** — وبلا `productId` يختار أول منتج في المنصة | تحليل منتج غيره، وكشف وجود معرّف منتج لغيره |
| `b2b-agent` | أسماء ومُعرّفات كل الموردين/التجار/الشركات | دفتر عناوين كامل للمنصة لأي حامل `ai:use` |
| `finance-agent` | إيراد/تكلفة/عمولة المنصة | **كان محكوماً بالفعل** بـ`requiresPlatformScope` |
| `outreach-acquisition-agent` | أسواق/فرص/شرائح المنصة | **كان محكوماً بالفعل** بـ`requiresPlatformScope` |

### 1.2 السياسة المطبَّقة

| الوكيل | القرار | التنفيذ | النتيجة |
| --- | --- | --- | --- |
| `sales-agent` | فلترة صفية | `orderScope`: `orders.buyer_id = requester` **أو** `orders.seller_id ∈ ملكه` **أو** `exists(order_items.seller_id ∈ ملكه)` (الطلب الأب متعدد البائعين) · `productScope` للمنتجات · عدّاد الموردين/التجار/الشركات ومتوسط الثقة العام **للطاقم فقط** | `dataScope: 'own'`، والأرقام المنصّية `null` |
| `marketing-agent` | فلترة صفية | كل استعلامات المنتجات/التصنيفات/الماركات مقيّدة بـ`products.seller_id ∈ ملكه` | لا يظهر كتالوج غيره |
| `product-agent` | فلترة صفية + منع كشف الوجود | `pickProduct` يقبل مرشّح الملكية، وبلا `productId` يختار من كتالوجه فقط. منتج غيره ⇒ `PRODUCT_NOT_AVAILABLE` **بلا** اسم/SKU (نفس الرد لغير الموجود: لا oracle) | لا تسريب ولا استدلال |
| `b2b-agent` | **تقييد إلى ADMIN/SUPER_ADMIN** | `requiresPlatformScope: true` في الكتالوج + رفض مستقل داخل المنفّذ `SCOPE_REQUIRED` | مطابقة الشركاء تسمّي أطرافاً أخرى؛ لا فلترة صفية تحفظ الفائدة ⇒ قرار السياسة (3) |
| `finance-agent` | ADMIN/SUPER_ADMIN | كان مضبوطاً؛ أُثبت باختبار | 5 أدوار مرفوضة قبل كتابة أي صف |
| `outreach-acquisition-agent` | ADMIN/SUPER_ADMIN | كان مضبوطاً؛ أُثبت باختبار | 5 أدوار مرفوضة قبل كتابة أي صف |

**لم يُغيَّر `ROLE_PERMISSIONS` ولا أُضيفت صلاحية.** الوحيد الذي تغيّر هو **نطاق بيانات** (تضييق) عبر راية موجودة أصلاً.

### 1.3 كيف تُحسب الملكية

`resolveRequesterScope()` تقرأ `suppliers.user_id` / `merchants.user_id` / `companies.user_id` فقط
(لا `db.execute` — A2 يرفض SQL الخام داخل تشغيل وكيل)، وتعيد `sellerIds`. الأدوار المنصّية
(`ADMIN`, `SUPER_ADMIN`) تتجاوز الفلتر وتبقى على العرض الكامل. أي دور آخر — بما فيه `SUPPORT` —
يُفلتر صفياً ولا يحصل على أرقام المنصة.

عقود A2: أُضيفت `suppliers`/`merchants`/`companies` إلى عقود `marketing-agent` و`product-agent`
**لغرض تحديد الملكية فقط**، و`order_items` إلى عقد `sales-agent`. `seller_orders` ممنوع منيع
(`HARD_DENY_TABLES` — سجل مالي)، فاستُخدمت سطور الطلب بدلاً منه.

### 1.4 الاختبارات الإلزامية — `tests/ai-agent-data-scope.test.ts` (15)

| الشرط المطلوب | الاختبار | النتيجة |
| --- | --- | --- |
| عميل A لا يقرأ بيانات عميل B | طلبان لعميلين مختلفين ⇒ `kpi.orders=1`، `gmv` لطلبه فقط، و`recentOrders` لا تحوي طلب B | ✅ |
| تاجر A لا يقرأ بيانات تاجر B | طلبان لبائعَين ⇒ GMV = طلب A فقط | ✅ |
| شركة A لا تقرأ بيانات شركة B | لقطة تسويق: `published=1`، ولا اسم/ماركة B في أي حقل | ✅ |
| المستخدم العادي لا يرى مؤشرات المنصة | `kpi.suppliers/merchants/companies = null`, `leadsPotential = null` | ✅ |
| ADMIN/SUPER_ADMIN يحتفظان بالوصول | `dataScope: 'platform'` + أعداد منصّية + `finance-agent` يعمل | ✅ |
| الرفض قبل إنشاء سجل مهمة | `b2b`/`finance`/`outreach` × 5 أدوار: عدد صفوف `agent_tasks` قبل = بعد | ✅ |
| Audit وmetrics بلا تسريب | `AI.AGENT_RUN_REFUSED` بـ`code=PLATFORM_SCOPE_REQUIRED` بلا بيانات، و`agent_metrics{outcome=blocked, errorCode=PLATFORM_SCOPE_REQUIRED}` لصاحب الطلب فقط | ✅ |
| منتج الغير | `PRODUCT_NOT_AVAILABLE` بلا اسم/SKU، ونفس الرد لغير الموجود | ✅ |

---

## 2. الأولوية الثانية — وكيل الفيديو يُنتج فيديو داخل دورة المهمة

### 2.1 ما تغيّر

المنفّذ `execMarketingVideoAgent` صار **يرندر فعلياً** بعد التخطيط، افتراضياً (`render !== false`):

| الخطوة | ماذا تفعل | القياس في تشغيل حقيقي |
| --- | --- | --- |
| `precheck_renderer` | فحص ffmpeg + الخطوط قبل أي عمل (لا رندر بلا أدوات) | 0ms · `ffmpeg present, fonts Noto Sans Arabic/DejaVu Sans` |
| `render` | `StructuralVideoProvider` (ffmpeg + libass) — محلي، بلا خدمات مدفوعة | 2,929ms |
| `store` | `LocalMediaStorage.put` بمفتاح `agent-videos/<requester>/<taskId>-<sha12>.mp4` (مفاتيح مُتحقَّقة، ومنع خروج المسار مضمون في الدرايفر) | 1ms |
| `probe` | `ffprobe` للقرص: codec/الأبعاد/fps/عدد الإطارات/المدة | 71ms |
| `decode` | `ffmpeg -f null -` — فك ترميز كامل | 534ms |

ثم فحوص القبول: `codec=h264` · `720×1280` · المدة داخل 35–120 ومطابقة للمطلوب ±0.5s ·
مدة حاوية MP4 = مدة ffprobe ±0.5s · حجم المخزَّن = حجم البايتات · `decode.ok`.
أي فحص فاشل ⇒ `render.status='FAILED'` + `failedChecks` (والملف لا يُعلن `verified`).

### 2.2 إثبات من مهمة وكيل حقيقية (لا سكربت منفصل)

مهمة `marketing-video-agent` لمنتج حقيقي «Extra Virgin Olive Oil 1L» بلغة **العربية** ومدة 45s،
أنشأها المالك ثم وافق عليها مسؤول منفصل:

```json
{"taskStatus":"approved","error":null,
 "render":{"status":"READY","provider":"structural"},
 "video":{"storageKey":"agent-videos/8a02c279-…/22e62d9b-…-ddc766399415.mp4",
          "bytes":167185,"sha256":"ddc766399415a02f277e644b27b2a50879e459484c1b07bf168a8da50b7d23d4",
          "durationSeconds":45,"codec":"h264","width":720,"height":1280,"frameRate":"25/1",
          "frames":1125,"containerDurationSeconds":45,
          "decode":{"ok":true,"detail":"full decode completed with no errors"},
          "verified":true,"language":"ar",
          "fonts":{"arabic":"Noto Sans Arabic","latin":"DejaVu Sans"}},
 "plan":{"slides":["جديد على وسيط\nزيت زيتون بكر ممتاز 1 لتر","Cold-pressed in Sfax, harvested 2026.",
                  "24.5000 TND\n…","للعملاء\nاطلب الآن عبر وسيط"]},
 "renders":true,"writesPlatformRows":false}
```

النص العربي مُرسَم فعلاً في الشرائح (الخط `Noto Sans Arabic`)، والمدة 45.000s، والفك الكامل نجح.

### 2.3 الضوابط الملتزم بها

| الضابط | الحالة |
| --- | --- |
| لا نشر تلقائي | `publish.available=false` · `video.publish` بلا منفّذ |
| لا خدمات مدفوعة / لا شراء أصول أو خطوط | `externalServices:false`, `paidServices:false`؛ ffmpeg + خط Noto OFL موجودان محلياً |
| لا مواد مجهولة الملكية | المنتج يُقرأ بملكية محققة؛ الخطوط مرخّصة (SIL OFL 1.1 / DejaVu) |
| لا تجاوز A2 / لا كتابة `audit_logs` أو `media_assets` | الاختبار يقيس عدد صفوف `media_assets` قبل/بعد ⇒ متساوٍ · `writesPlatformRows:false` |
| لا كتابة جداول المنصة لتسهيل الرندر | لا صف يُكتب: الملف على القرص + البيانات في `agent_tasks.result` |
| لا تغيير صلاحيات أو مخطط | لا migration، لا RBAC، لا جدول جديد |
| تسجيل الخطوات والأخطاء | `steps[]` (خطوة/نجاح/ms/تفصيل) + `render.error` + `failedChecks[]` |

**قرار مطلوب (مُسجَّل، غير منفَّذ):** الملف الناتج غير قابل للتنزيل عبر API لأنه لا يوجد صف
`media_assets` (الوكيل ممنوع من كتابته). من يريد ملفاً قابلاً للتنزيل يستخدم
`POST /api/media/marketing-videos` (مالك/إداري، مُدقَّق). إن أراد المدير العام تنزيل مخرجات الوكيل
مباشرة، فالقرار المطلوب: هل يُنشئ الـrunner (لا الوكيل) صف `media_assets` بعد تحقق المالك؟
غير منفّذ هنا لأنه يتطلب كتابة صف منصة لمجرد الربط — وهو ممنوع بهذه المهمة.

---

## 3. الأولوية الثالثة — مصفوفة الوكلاء بعد الإصلاح (20 متخصصاً + مشرف + Copilot)

**الرموز:** ✅ تنفيذ حقيقي · 🟡 تخطيط فقط · ⛔ محجوب (بلا منفّذ) · 🔒 إداري فقط

### 3.1 الاثنا عشر الأساسيون (CORE_SPECIALIST)

| # | الوكيل | التنفيذ | نطاق البيانات | الصلاحيات | الذاكرة | اختبارات الوظيفة | الموانع المتبقية |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `sales-agent` | ✅ (بموافقة) | **صفّي**: طلباتي/مبيعاتي + منتجاتي + ثقتي؛ أرقام المنصة `null` | `ai:use` | ✅ | phase14 · data-scope · r1 | لا `leadsPotential` لغير الطاقم (مقصود) |
| 2 | `marketing-agent` | ✅ | **صفّي**: منتجاتي/تصنيفاتي/ماركاتي | `ai:use` | ✅ | phase14 · data-scope | — |
| 3 | `ads-agent` | ✅ (بموافقة) | 🔒 منصة | `ai:use`+`ad:create` | ✅ | phase14 · platform-scope | الحملات المدفوعة بلا منفّذ |
| 4 | `product-agent` | ✅ | **صفّي**: منتجي فقط، ورفض منتج الغير بلا كشف وجوده | `ai:use` | ✅ | phase14 · data-scope | — |
| 5 | `support-agent` | ✅ | **صفّي**: خيوطي فقط (طقم الدعم يرى الكل) | `ai:use` | ✅ | ai-support-scope (3) | لا إرسال تلقائي |
| 6 | `analytics-agent` | ✅ | 🔒 منصة | `ai:use`+`analytics:read:own` | ✅ | phase14 · platform-scope | — |
| 7 | `market-research-agent` | ✅ | 🔒 منصة (مفعَّل في COMPLETION-02) | `ai:use` | ✅ | phase14 · platform-scope | — |
| 8 | `b2b-agent` | ✅ (بموافقة) | 🔒 منصة (**جديد في COMPLETION-03**) | `ai:use` | ✅ | phase14 · data-scope | مطابقة الشركاء تحتاج قرار واجهة للعملاء |
| 9 | `risk-agent` | ✅ (بموافقة) | 🔒 منصة | `risk:read` | ✅ | phase14 · platform-scope | — |
| 10 | `dispute-assistant` | ✅ (بموافقة) | 🔒 منصة | `dispute:read` | ✅ | phase14 · platform-scope | لا قرار نزاع آلي |
| 11 | `development-agent` | ✅ | 🔒 منصة | `ai:use` | ✅ | rootcause (15+6) | `apply_patch`/`merge` بلا منفّذ (AD-050) |
| 12 | `marketing-video-agent` | ✅ **تخطيط + رندر + تحقق** | صفّي (منتجه) | `ai:use` (بموافقة) | ✅ | ai-video-agent (6) · unit/ai-video-plan (5) | النشر محجوب · التنزيل عبر API غير متاح |

### 3.2 الثمانية الداعمون (SUPPORTING)

| # | الوكيل | التنفيذ | نطاق البيانات | الصلاحيات | الذاكرة | الاختبارات | الموانع |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | `finance-agent` | ✅ | 🔒 منصة | `ai:use`+`revenue:read` | ✅ | ai-agent-merge-01 · data-scope | — |
| 14 | `payment-settlement-agent` | ⛔ | — | `ai:use`+`order:read` | — | unit/ai-reg01 (رفض) | بلا منفّذ: تسوية الأموال ليست وكيلية |
| 15 | `compliance-agent` | ⛔ | 🔒 | `ai:use`+`order:read` | — | unit/ai-reg01 | بلا منفّذ (قرار قانوني) |
| 16 | `supplier-agent` | ⛔ | — | `ai:use` | — | unit/ai-reg01 | بلا منفّذ |
| 17 | `merchant-agent` | ⛔ | — | `ai:use` | — | unit/ai-reg01 | بلا منفّذ |
| 18 | `customer-intelligence-agent` | ⛔ | — | `ai:use`+`analytics:read:own` | — | unit/ai-reg01 | بلا منفّذ |
| 19 | `operations-agent` | ⛔ | 🔒 | `ai:use` | — | unit/ai-reg01 | بلا منفّذ |
| 20 | `outreach-acquisition-agent` | ✅ (بموافقة) | 🔒 منصة | `ai:use` | ✅ | ai-agent-merge-01 · data-scope | الإرسال/الحملات المدفوعة بلا منفّذ |

### 3.3 الحوكمة

| الهوية | الحالة | ملاحظة |
| --- | --- | --- |
| `agent-supervisor` | 🟡 إشراف فقط | يرفض كخطوة تنفيذ `SUPERVISOR_NOT_RUNNABLE` |
| `ai-copilot` | 🟡 تنسيق فقط | يُخطّط عبر `POST /api/admin/ai/agent-runs` ولا ينفّذ بنفسه |

**لا حُذفت هوية ولا ذاكرة ولا سجل سابق.** الأعداد: 21 وكيلاً في الكتالوج (20 + مشرف) · قابلون للتنفيذ **14** ·
مُعلنون فقط **6** · `requiresPlatformScope` **11** (بعد b2b).

---

## 4. الاختبارات والتحقق

| الأمر | النتيجة |
| --- | --- |
| `npx tsc --noEmit` | 0 أخطاء |
| `tests/ai-agent-data-scope.test.ts` (جديد) | 15/15 |
| `tests/ai-video-agent.test.ts` | 6/6 (منها رندر حقيقي 45s و60s) |
| حزمة الوكلاء (13 ملفاً) | 171/171 |
| `tests/ai-met01-agent-metrics.test.ts` (بعد إصلاح العزل) | 18/18 |
| الحزمة الكاملة | 164 ملفاً · 2,101 اختباراً · exit 0 |

### 4.1 إصلاح عزل الاختبارات (لم يُضعف أي تحقق)

`ai-met01-agent-metrics` كان يعدّ أحداثاً **عالمية** في `agent_metrics`، فصار يفشل عندما يشغّل ملف
متوازٍ وكلاء (`b2b`/`finance`/`outreach` تسجّل `blocked` عند الرفض). أُصلح العزل **بمفاتيح وكيل فريدة**
لكل اختبار (`it-iso-*`, `it-cost-*`, `it-backfill-*`) بدل مفاتيح إنتاجية مشتركة:

- «عزل الوكلاء» صار يثبت أن التقرير المفلتر بمفتاح لا يحوي إلا أحداث ذلك المفتاح (`distinctOwners = 1`).
- «التكلفة غير متاحة» ما زال يثبت `status='unavailable'` بلا اختراع صفر.
- «إعادة البناء idempotent» ما زال يثبت `skipped ≥ 1` وأن المهمة لها صف قياس واحد فقط بعد تشغيلين
  (`second.inserted` لم يبقَ صفراً بالضرورة لأنه يلتقط مهام ملفات أخرى — وهو ما كان يسبب الفشل الكاذب).

كذلك صار مُعتمِد مهام الاختبار `ADMIN` بدل `SUPER_ADMIN` في `ai-agent-data-scope`، لأن
`super-admin-bootstrap` يتحقق من وجود مالك منصة واحد.

## 5. التراجع

1. **sales/marketing/product**: حذف `resolveRequesterScope` من المنفّذ يعيد العرض المنصّي — تراجع مقبول تقنياً، **مرفوض أمنياً**؛ البديل الصحيح تقييد الوكيل بـ`requiresPlatformScope`.
2. **b2b**: إزالة `requiresPlatformScope` تعيد دفتر العناوين — لا يُنصح.
3. **الفيديو**: `render: false` يُعيد سلوك التخطيط فقط لكل استدعاء؛ وحذف كتلة الرندر يعيد المنفّذ السابق.
4. **`lib/media/verify.ts`** ملف جديد معزول — حذفه لا يمس أي مسار آخر.
5. لا migrations ولا تغيير RBAC ⇒ التراجع كودي بحت.

## 6. قرارات مطلوبة (لم تُنفَّذ)

1. **تنزيل مخرجات الفيديو**: إنشاء صف `media_assets` من الـrunner (لا الوكيل) بعد تحقق الملكية، أم الاكتفاء بمسار الوسائط.
2. **مطابقة B2B للعملاء**: واجهة «شركاء مقترحون» بموافقة بشرية (بدل دفتر العناوين الكامل).
3. **سياسة الاحتفاظ بملفات `agent-videos/`**: الحذف بعد N يوماً أم الأرشفة في `backups/media/`.
