# AI-RATE-LIMIT-01 — حدود معدل مركزية لواجهات الذكاء الاصطناعي

> الحالة: منفَّذ ومُختبَر — `packages/server/tests/ai-rate-limit-01.test.ts` (19 حالة) + الحزم المرتبطة.
> القرار المعماري: AD-063 في `docs/ARCHITECTURE_DECISIONS.md`.

## 1. ما كانت عليه الحماية قبل المهمة (بالإثبات)

| المسار | الحد قبل | الملاحظة |
| --- | --- | --- |
| `/api/*` | 300/60ث لكل هوية | backstop عام |
| `/api/ai/*` | 60/60ث لكل مستخدم + 300/60ث لكل IP | سقف **واحد** لكل الواجهات |
| `/api/admin/ai/*` | **لا شيء** (فقط backstop العام 300/60ث) | إدارة المزوّدين/الميزانيات/الإنفاق كانت الأضعف حماية |
| `/api/search/*` | 120/60ث لكل IP | خارج النطاق |
| `/api/media/marketing-videos` | 6/60ث لكل مستخدم | خارج النطاق |

الفجوات الفعلية: سقف واحد لا يفرّق بين قراءة الحالة (رخيصة) واستدعاء مزوّد مدفوع؛ ولوحة `/api/admin/ai` — التي تفعّل مزوّدًا وتضبط سقف الإنفاق وتشغّل الوكلاء — لم يكن لها حدّ خاص بها إطلاقًا.

## 2. التصميم: تصنيف واحد مركزي

السياسة كلها في ملف واحد: `src/lib/rate-limit/ai-policy.ts`. لا يوجد `rateLimit()` مكتوب يدويًا في أي راوتر AI؛ `app.ts` يركّب الجدول مرة واحدة.

| الفئة | ما تغطيه | الافتراضي | مدفوع؟ | عند تعطل المخزن |
| --- | --- | --- | --- | --- |
| `ai.read` | كل GET تحت `/api/ai/*` (status, models, agents, tasks, activity, budgets/me, memory, voice-capabilities, فيديو المهمة) | **120/60ث** | لا | Fail-open |
| `ai.feature` | `POST /api/ai/{run, smart-search, recommendations, market-analysis, supplier-recommendations, price-intelligence, sales-intelligence, ads-recommendations, analyze/product}` | **30/60ث** | نعم | Fail-closed (503) |
| `ai.agent` | `POST /api/ai/agents/:key/tasks`, `POST /api/ai/tasks/:id/{approve,reject}` | **15/60ث** | نعم | Fail-closed |
| `ai.memory` | `POST/PATCH/DELETE /api/ai/memory*` | **60/60ث** | لا | Fail-open |
| `ai.admin.read` | كل GET تحت `/api/admin/ai/*` | **120/60ث** | لا | Fail-open |
| `ai.admin.control` | POST/PUT/PATCH/DELETE تحت `/api/admin/ai/*` (ميزانيات، نماذج، حدود إنفاق، guard، kill-switch، runs، purge، backfill) | **30/60ث** | نعم | Fail-closed |
| `ai.provider` | كتابة/حذف مفتاح، تعديل إعداد، واختبار اتصال حقيقي تحت `/api/admin/ai/providers/*` | **10/60ث** | نعم | Fail-closed |
| backstop | `/api/ai/*` و`/api/admin/ai/*` لكل IP | `RATE_LIMIT_AI_IP_MAX` (300/60ث) | — | Fail-closed |

كل قيمة قابلة للتهيئة (الجدول في §7). `RATE_LIMIT_AI_MAX` يبقى موجودًا كـ**مفتاح رئيسي** يعلو على كل الفئات عند ضبطه صراحةً (سلوك ما قبل المهمة، تستخدمه `sec0114` و`afc09`).

**لماذا هذه الأرقام**: الاستدعاء المدفوع أغلى بمرتبتين من القراءة، والقراءة المتكررة جزء طبيعي من الواجهة (polling). الفصل يمنع الحالتين معًا: سقف واحد ضيق يكسر الواجهة، وسقف واحد واسع يترك المال بلا حدّ. كل رقم مُوثَّق هنا وفي `env.ts`؛ لا ثابت صامت.

## 3. الهوية ومنع التزوير

- المستخدم المسجّل يُحسب على `user:<id>` المستخرج من الجلسة على الخادم (`loadAuthUser`) — **لا** من أي header يرسله العميل. اختبار: `x-user-id`/`x-wasit-user` متغيّرة على كل طلب لا تحرّك الدلو.
- المجهول (أو الـbackstop) يُحسب على عنوان الـsocket عبر `resolveClientIp`: `X-Forwarded-For` يُهمَل كليًا إلا إذا أتى الطلب من proxy مُعلَن في `TRUSTED_PROXY_CIDRS` مع `TRUSTED_PROXY_HOPS>0`. بلا إعداد، العنوان الحقيقي فقط هو المفتاح، ومن لا عنوان له يشارك دلو `ip:unknown` (fail-closed) بدل الحصول على دلو جديد لكل طلب.
- لا يوجد أي مسار API لتغيير الحدود: القيم من env فقط، فلا يستطيع وكيل ولا مستخدم توسيع حمايته.

## 4. عقد الرفض

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
{"success":false,"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded", ...}}
```

- الرمز `RATE_LIMITED` ثابت (موجود في `ApiError.tooManyRequests`).
- `Retry-After` = طول النافذة بالثواني (حدّ أعلى آمن؛ لا يكشف عدّادًا داخليًا).
- لا يُعاد أي مفتاح دلو أو عنوان أو اسم مخزن في الجسم أو الترويسات.
- المقياس `wasit_rate_limit_rejections_total{prefix}` يفصل الفئات عن بعضها.

## 5. التزامن وتعدد النسخ

- **التزامن**: العدّاد الذرّي (`ON CONFLICT DO UPDATE` في `PostgresRateLimitStore`، أو عدّاد عملية واحدة في `MemoryRateLimitStore`) يجعل `count` تصاعديًا بلا lost updates. اختبار: 25 طلبًا متوازيًا بسقف 5 ⇒ **5 ناجحة و20 مرفوضة بالضبط**.
- **تعدد النسخ**: مع `RATE_LIMIT_STORE=postgres` كل النسخ تتشارك `rate_limit_counters` ⇒ الحد الكلي = الحد المعلن، لا N×الحد. ومع المخزن المحلي، كل نسخة تمنح السقف كاملًا؛ لذلك:
  - `AI_RATE_LIMIT_REQUIRE_DURABLE` (افتراضيه **مفعّل في production**) يجعل الفئات المدفوعة ترد **503** إذا كان المخزن محليًا، بدل أن تبدو محمية وهي ليست كذلك.
  - `AI_RATE_LIMIT_ALLOW_MEMORY_STORE=true` استثناء صريح لنسخة واحدة، موثّق، ويُسجَّل في السجل عند الاستخدام.
- **تعطل المخزن**: الفئات المدفوعة (`ai.feature`, `ai.agent`, `ai.admin.control`, `ai.provider`) ترد **503** — لا نداء مزوّد ولا صرف. الفئات المحلية الآمنة (`ai.read`, `ai.memory`, `ai.admin.read`) تمرّ مع تسجيل خطأ ومقياس `wasit_rate_limit_store_errors_total{prefix,mode}`, لأن تعطل قاعدة البيانات يعطّلها أصلًا، وإسقاطها كلها لا يضيف أمانًا.

## 6. العلاقة بـAI-SPEND-GUARD-01

الحدّان مستقلان ومتكاملان: هذا الحدّ يحدّ **عدد** الطلبات، وذاك يحدّ **المال**. لا يتجاوز أحدهما الآخر ولا يلتفّ عليه:

- الحارس يُفحص داخل `runAIFeature`/`updateProviderConfig` كما هو؛ الحدّ لا يستبدله.
- اختبار صريح: تحت الحدّ المسموح، `PATCH /api/admin/ai/providers/openai {enabled:true}` بلا سقوف GLOBAL يبقى **409 `SPEND_GUARD_REQUIRED`**.
- المحرّك المحلي (`local-heuristic`) يبقى يعمل تحت الحدّ (اختبار `POST /api/ai/run` ⇒ 200).

## 7. التهيئة

| المتغيّر | الافتراضي | الغرض |
| --- | --- | --- |
| `AI_RATE_LIMIT_READ_MAX` | 120 | قراءات `/api/ai` |
| `AI_RATE_LIMIT_FEATURE_MAX` | 30 | استدعاءات الميزات المدفوعة |
| `AI_RATE_LIMIT_AGENT_MAX` | 15 | إنشاء مهام الوكلاء واعتمادها |
| `AI_RATE_LIMIT_MEMORY_MAX` | 60 | كتابة ذاكرة الوكيل |
| `AI_RATE_LIMIT_ADMIN_READ_MAX` | 120 | قراءات لوحة الإدارة |
| `AI_RATE_LIMIT_ADMIN_CONTROL_MAX` | 30 | كتابات لوحة الإدارة |
| `AI_RATE_LIMIT_PROVIDER_MAX` | 10 | إعداد المزوّدين والفحص الحقيقي |
| `AI_RATE_LIMIT_ADMIN_MULTIPLIER` | 3 | مضاعف محدود لفئات الإدارة للموظفين |
| `AI_RATE_LIMIT_REQUIRE_DURABLE` | مفعّل في production | اشتراط مخزن مشترك للفئات المدفوعة |
| `AI_RATE_LIMIT_ALLOW_MEMORY_STORE` | `false` | استثناء صريح لنسخة واحدة |
| `RATE_LIMIT_AI_MAX` | غير مضبوط | مفتاح رئيسي يعلو على كل الفئات |
| `RATE_LIMIT_AI_IP_MAX` | 300 | backstop لكل IP |
| `RATE_LIMIT_AI_WINDOW_SECONDS` | 60 | طول النافذة |

**الاستثناءات الإدارية**: الموظفون (`ADMIN`/`SUPER_ADMIN`) يحصلون على `×3` على **فئتي الإدارة فقط** (`ai.admin.read`, `ai.admin.control`) لأن مهام التدقيق والصيانة تُصدر دفعات؛ ولا يحصلون على أي مضاعف على `ai.feature`/`ai.agent`/`ai.provider` — أي على ما يصرف فعلًا. لا يوجد أي `exemptPaths` لواجهات AI.

## 8. ضمان التغطية

اختبار بنيوي يقرأ `app.routes` ويؤكد أن **كل** مسار غير-GET تحت `/api/ai` و`/api/admin/ai` مطابق لقاعدة في الجدول. أي راوتر AI جديد يُضاف غدًا بلا فئة يُفشل هذا الاختبار بدل أن يُشحن بلا حدّ.

## 9. الإثبات

`tests/ai-rate-limit-01.test.ts` — **19/19**:

1. الطلبات ضمن الحد تمرّ. 2. الطلب الزائد 429 + `RATE_LIMITED` + `Retry-After`. 3. عزل الحدود بين المستخدمين. 4. `ai.feature` أضيق من `ai.read` وبدلوين منفصلين. 5. `ai.agent` فئة مستقلة. 6. `ai.provider` أضيق من `ai.admin.control`. 7. حدود إدارة الإنفاق (بما فيها `PUT /spend/guard`). 8. تزوير الهوية عبر headers لا يحرّك الدلو. 9. backstop لكل IP عبر حسابات مختلفة. 10. 25 طلبًا متوازيًا ⇒ 5 فقط تمرّ. 11. Fail-closed للفئات المدفوعة عند تعطل المخزن. 12. Fail-open للقراءات عند تعطل المخزن. 13. رفض المخزن المحلي عند اشتراط المشترك. 14. تغطية كل المسارات. 15. الموظف لا يفلت من حدّ الميزات. 16. مضاعف الإدارة محدود (4 من 5). 17. لا يُخزَّن أي نص طلب في جدول العدّادات. 18. الحارس يبقى 409 بلا سقوف. 19. المحرّك المحلي يعمل.

+ الحزم المرتبطة: `sec0114-rate-limit-resource` 16/16، `rate-limit` 12/12، `ai-spend-guard` 17/17، `afc09-ai-providers` 23/23، `afc10-ai-spend`، `ai-core`، `admin-ai`، `phase14-agents`.

## 10. القرارات — **مغلقة في AI-RATE-LIMIT-HARDENING-01**

1. ~~هل تُخفَّض افتراضيات `ai.feature`/`ai.agent`؟~~ **لا** — بقيت 30/15/10، ومنهج القياس موثَّق في `docs/AI-RATE-LIMIT-HARDENING-01.md §7`.
2. ~~هل يُشترط `RATE_LIMIT_STORE=postgres` في staging؟~~ **نعم** — staging يرفض الإقلاع على مخزن محلي.
3. ~~هل يُسمح بتجاوز `AI_RATE_LIMIT_REQUIRE_DURABLE` في الإنتاج؟~~ **لا** — `ALLOW_MEMORY_STORE` و`REQUIRE_DURABLE=false` يرفضان الإقلاع في production وstaging.
