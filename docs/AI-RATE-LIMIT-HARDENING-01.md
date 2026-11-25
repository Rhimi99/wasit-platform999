# AI-RATE-LIMIT-HARDENING-01 — إغلاق قرارات AD-063

> الحالة: منفَّذ ومُختبَر — `packages/server/tests/ai-rate-limit-hardening-01.test.ts` (28 حالة).
> يغلق البنود الثلاثة `DECISION REQUIRED` في AD-063. لا Migration، لا تغيير RBAC، لا لمس لأي مزوّد مدفوع.

## 1. ما كان عليه الحال بعد AI-RATE-LIMIT-01 (39de50b)

| الطبقة | production | staging | local (dev/test) |
| --- | --- | --- | --- |
| اختيار المخزن | `RATE_LIMIT_STORE` غير المضبوط = `memory` **بصمت** | نفس الشيء | `memory` |
| `AI_RATE_LIMIT_ALLOW_MEMORY_STORE=true` | كان يسمح بمخزن محلي | كان يسمح | مسموح |
| `AI_RATE_LIMIT_REQUIRE_DURABLE=false` | كان يُبطل الاشتراط | كان يُبطله | مسموح |
| فشل المخزن عند الإقلاع | لا فحص | لا فحص | لا فحص |
| الحالة على health | `{store,durable}` بلا «هل هو مطلوب/جاهز» | نفس الشيء | نفس الشيء |

ثلاث فجوات حقيقية: **تحوّل صامت** إلى مخزن محلي عند خطأ إملائي في `RATE_LIMIT_STORE`، و**إمكانية إبطال** الاشتراط بمتغيّر، و**غياب فحص إقلاع** يجعل نسخة بلا عدّادات مشتركة تخدم حركة المرور.

## 2. ما نُفِّذ

### أ) قاعدة واحدة، بوّابتان مستقلّتان

`src/lib/rate-limit/policy.ts` (ملف نقي بلا استيرادات):

- `deploymentTier(nodeEnv)` → `production` | `staging` | `local`.
- `durableStoreRequired(config)` → **true** في production وstaging دائمًا، مهما كانت الأعلام؛ محليًا يتبع `AI_RATE_LIMIT_REQUIRE_DURABLE` (و`ALLOW_MEMORY_STORE` يُبطله محليًا فقط).
- `rateLimitConfigViolations(config)` → قائمة أسباب رفض الإقلاع.

**البوابة الأولى — الإقلاع** (`src/lib/rate-limit/boot.ts` → `assertRateLimitConfigOrExit()`، يُستدعى في `src/index.ts` قبل `serve()`): إن كانت البيئة منشورة والمخزن ليس `postgres`، أو `AI_RATE_LIMIT_ALLOW_MEMORY_STORE=true`، أو `AI_RATE_LIMIT_REQUIRE_DURABLE=false` ⇒ `console.error` + `process.exit(1)`.

> **لماذا ليس داخل `env.ts`؟** كل أدوات المشغّل (CLI تغيير كلمة المرور، الـmigrations، السكربتات) تستورد `env.ts` ولا تقدّم حركة مرور ولا تملك عدّادات. وضع الرفض هناك أسقط `gm-access-04/05` فعليًا (كشفته المجموعة الكاملة)، فحُصر الرفض في العملية التي تخدم HTTP. القاعدة نفسها تبقى مفحوصة في اختبار الإقلاع الحقيقي عبر `src/index.ts`.

**البوابة الثانية — التشغيل** (`src/lib/rate-limit/resolve.ts`): لا يمكن **بناء** مخزن محلي في بيئة منشورة حتى لو تغيّر كائن `env` بعد الإقلاع؛ `resolveRateLimitStore` و`setRateLimitStore` يرميان خطأً صريحًا. لا يوجد أي مسار يُرجع `MemoryRateLimitStore` بصمت.

### ب) جاهزية المخزن: إقلاع + health

`src/lib/rate-limit/readiness.ts` → `checkRateLimitStoreReadiness(db)` يعيد:

```json
{ "store": "postgres", "durable": true, "required": true, "ready": true }
```

- `probe()` جديد على عقد `RateLimitStore`: قراءة فقط (`SELECT 1 FROM rate_limit_counters LIMIT 1`) — تُثبت وجود الجدول ووصول الاتصال بلا كتابة صفوف ولا استهلاك دلو.
- **عند الإقلاع** (`src/index.ts`): `assertRateLimitConfigOrExit()` ثم `checkRateLimitStoreReadiness(db)` قبل `serve()`؛ إذا لم يكن أيّهما سليمًا ⇒ `process.exit(1)` مع سجل واضح. لا يبدأ الخادم أصلًا.
- **`GET /api/health/ready`**: يضيف فحص المخزن؛ غير الجاهز ⇒ **503** (كي لا يدخل الـload balancer نسخة بلا عدّادات مشتركة).
- **`GET /api/health/channels`**: `rateLimit: {store, durable, required, ready}`.
- التفاصيل (`detail`) عبارة ثابتة (`counter store unreachable` / `a shared counter store is required in this environment`) — **لا رسالة سائق** قد تحمل مضيفًا أو DSN.

### ج) الحدود الافتراضية — لم تُخفَّض

بقيت كما هي بلا تغيير: `ai.read 120` · `ai.feature 30` · `ai.agent 15` · `ai.memory 60` · `ai.admin.read 120` · `ai.admin.control 30` · `ai.provider 10`. اختبار صريح يثبّت هذه القيم كي لا يخفضها أحد لاحقًا بلا قرار موثّق.

## 3. المصفوفة الناتجة

| الحالة | production | staging | local |
| --- | --- | --- | --- |
| `RATE_LIMIT_STORE=memory` | **رفض إقلاع** | **رفض إقلاع** | مسموح |
| `RATE_LIMIT_STORE` غير مضبوط (الافتراضي `memory`) | **رفض إقلاع** | **رفض إقلاع** | مسموح |
| `AI_RATE_LIMIT_ALLOW_MEMORY_STORE=true` | **رفض إقلاع** حتى مع `postgres` | **رفض إقلاع** | يسمح محليًا |
| `AI_RATE_LIMIT_REQUIRE_DURABLE=false` | **رفض إقلاع** | **رفض إقلاع** | يسمح محليًا |
| `postgres` لكن الجدول/الاتصال غير متاح | **رفض إقلاع** + `/ready` = 503 | نفس الشيء | `/ready` = 503 |
| مخزن محلي يُحقن وقت التشغيل | **يرمي خطأً** | **يرمي خطأً** | مسموح (اختبارات) |

## 4. ما لم يتغيّر

- **AI-SPEND-GUARD-01**: الحارس يُفحص كما هو؛ اختبار على المخزن المشترك يؤكد بقاء `409 SPEND_GUARD_REQUIRED`.
- **AI-RATE-LIMIT-01**: الفئات والسقوف وعقد 429 كما هي؛ اختبار يؤكد أن `ALLOW_MEMORY_STORE=true` **لا يوسّع** أي سقف.
- **RBAC وصلاحيات الوكلاء**: لا تعديل.
- **المدفوعات/المزوّدون**: لا اتصال ولا تغيير؛ الاختبارات تستخدم المزوّد المحلي أو مسارات ترفض قبل أي نداء.
- **قاعدة البيانات**: لا Migration. `rate_limit_counters` موجود من `0016`، و`probe` قراءة فقط.

## 5. الإثبات (28/28)

**قاعدة (7)**: تصنيف البيئات، قبول المشترك، رفض المحلي في production وstaging، رفض علم السماح، رفض تعطيل الاشتراط، تسامح المحلي، و«مشترك دائمًا» عبر 12 توليفة أعلام.

**إقلاع حقيقي عبر عملية ابن (7)**: تشغيل `tests/fixtures/boot-env-probe.ts` (يستورد `lib/env.ts` كما يفعل الخادم) وقراءة **رمز الخروج**:
1. production + memory + allow=true ⇒ exit 1 + رسالة صريحة. 2. staging + memory ⇒ exit 1. 3. production + postgres + allow=true ⇒ exit 1. 4. production + postgres + require=false ⇒ exit 1. 5. production + postgres ⇒ exit 0 + `BOOTED`. 6. test + memory + allow=true ⇒ exit 0 (**البيئة المحلية المعزولة لا تتعطّل**). 7. تشغيل `src/index.ts` الحقيقي بـproduction + postgres + `DATABASE_URL` إلى منفذ مغلق ⇒ exit 1، سجل `refusing to start: rate-limit store is not usable`، **ولا** `wasit api listening`، **ولا** سلسلة الاتصال في السجل.

**بوابة التشغيل (3)**: بناء مخزن محلي في بيئة منشورة يرمي؛ حقن مخزن محلي يرمي؛ `rateLimitStoreRequired()`/`requireDurableAiStore()` = true مهما كانت الأعلام.

**الجاهزية (5)**: مخزن مشترك سليم ⇒ ready؛ `probe` فاشل ⇒ `ready:false` + `detail` ثابت بلا تسريب رسالة السائق (المضيف وكلمة المرور غير موجودين في المخرَج)؛ بيئة منشورة بمخزن محلي ⇒ `ready:false` + `required:true`؛ `/api/health/ready` و`/api/health/channels` يعرضان الحالة؛ المحلي يبقى ready على المخزن المحلي.

**المخزن المشترك تحت التزامن (3)**: نسختان تتشاركان العدّاد (1,2,3)؛ 50 زيادة متوازية عبر نسختين ⇒ 50 قيمة متمايزة (لا lost update)؛ 25 طلبًا متوازيًا على التطبيق بسقف 5 ⇒ 5 ناجحة و20 مرفوضة.

**لا تجاوز (2)** + **الافتراضيات (1)**.

## 6. الأثر التشغيلي

- `docker-compose.yml`: الافتراضي صار `RATE_LIMIT_STORE=postgres` (Postgres خدمة في الملف أصلًا) — وإلا لرفض الـcompose الإقلاع.
- `.env.demo` (مستثنى من Git): صار `RATE_LIMIT_STORE=postgres`. **أي نسخة staging قائمة يجب أن تضبط هذا المتغيّر قبل النشر وإلا سترفض الإقلاع** — وهذا هو المقصود: فشل واضح بدل حماية وهمية.
- `docs/DEPLOYMENT.md` و`docs/commercial-release/03-ENVIRONMENT-REFERENCE.md` حُدِّثا.
- المتغيّران `AI_RATE_LIMIT_ALLOW_MEMORY_STORE` و`AI_RATE_LIMIT_REQUIRE_DURABLE` بقيا موجودين لكنهما محليّان فقط؛ لا يُضاف متغيّر جديد.

## 7. منهج قياس الحدود (القرار المتبقّي، بلا أرقام مُختلقة)

لا تُخفَّض `ai.feature`/`ai.agent`/`ai.provider` قبل قياس إنتاجي حقيقي. المنهج المطلوب:

1. **المصدر**: `ai_requests` (نوع الطلب، المزوّد، التكلفة، المستخدم، الوقت) + `audit_logs` لأحداث الإدارة + `rate_limit_counters` لرصد الرفض (أو مقياس `wasit_rate_limit_rejections_total{prefix}` عبر `/metrics`).
2. **المدة**: ≥ 30 يومًا متصلة تغطي ذروة شهرية واحدة على الأقل.
3. **المؤشرات لكل فئة**: عدد الطلبات/المستخدم/اليوم (p50, p95, p99, max)، ذروة الساعة، عدد المستخدمين الذين يتجاوزون كل عتبة مقترحة، نسبة 429 الحالية، والتكلفة لكل طلب وكل مستخدم.
4. **عتبة القرار**: يُخفَّض السقف فقط إذا كان p99 للاستخدام الشرعي < 50% من السقف الحالي **و** كان الرفض الحالي < 0.1% من الطلبات. غير ذلك يبقى كما هو.
5. **التوثيق**: تُسجَّل الأرقام الخام ومصدرها وتاريخ السحب في AD جديدة، ثم تُعدَّل الافتراضيات في `env.ts` + `ai-policy.ts` + الاختبار المثبِّت لها.

## 8. `DECISION REQUIRED` المتبقّي

لا شيء من قرارات AD-063 الثلاثة. يبقى بند واحد مفتوح بطبيعته: **معايرة الأرقام** وفق §7 — قرار لاحق مبني على بيانات إنتاج، لا على تقدير.
