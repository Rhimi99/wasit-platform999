# AI-04 — إدارة آمنة لمزوّدي الذكاء الاصطناعي

> الحالة: مكتمل ومُتحقَّق. المرجع المعماري: `AD-056` في `ARCHITECTURE_DECISIONS.md`.

## المشكلة

كان إعداد المزوّد محصورًا في متغيّرات البيئة (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`):

- مزوّد واحد لكل نشر — لا OpenAI وAnthropic معًا ولا بديل عند تعطّل أحدهما.
- لا مسار إداري: لا تفعيل/تعطيل، لا تدوير مفتاح، لا اختبار اتصال، لا معرفة أي وكيل استهلك أي مزوّد.
- أي مفتاح في الكود أو القاعدة يعني تسريبًا عند أي نسخة احتياطية.

## ما بُني

| الطبقة | الملف | الدور |
| --- | --- | --- |
| Schema | `src/db/schema/ai_providers.ts` + Migration `0042_ai_providers.sql` | صف لكل (بيئة، مزوّد)؛ إضافية بحتة |
| Secret box | `src/lib/ai/secret-box.ts` | AES-256-GCM بمفتاح رئيسي خارج القاعدة |
| Config service | `src/lib/ai/provider-config.ts` | الكتالوج، السلسلة، الكتابة، الاختبار، الاستخدام |
| Routing | `src/lib/ai/routing.ts` | يستهلك السلسلة بدل مزوّد البيئة الواحد |
| Runtime | `src/lib/ai/runtime.ts` | يستخدم السلسلة عند غياب مزوّد صريح |
| Admin API | `src/modules/admin/ai-provider-routes.ts` | `/api/admin/ai/providers/*` |
| UI | `packages/web/src/components/AiProvidersPanel.tsx` + تبويب «المزوّدون» | إدارة كاملة بحالات تحميل/فراغ/خطأ/نجاح |
| Tests | `tests/afc09-ai-providers.test.ts` | 23 حالة على قاعدة حقيقية |

## نموذج السرّ

```
AI_SECRET_ENCRYPTION_KEY (env, 32B base64)   ← لا يُخزَّن في القاعدة
        │
        ├── seal(secret, aad="test:openai:v1") → "v1:iv:tag:ciphertext"
        │                                        ↑ يُخزَّن في ai_providers.secret_ciphertext
        └── fingerprint = sha256(secret)[:16]   ← للمقارنة فقط، ليس عكسيًا
```

- لا مسار يقرأ المفتاح ويعيده. الاستجابة تحمل `keyState: {present, source, envVar, fingerprint, updatedAt}`.
- بديل بلا تخزين: `keySource = ENV` + `keyEnvVar` (اسم المتغيّر فقط).
- غياب المفتاح الرئيسي ⇒ `409 SECRET_STORAGE_DISABLED` ولا كتابة — فشل مغلق.
- `aad` يمنع نقل حزمة مشفّرة من بيئة إلى أخرى داخل نفس القاعدة.
- التدقيق `AI_PROVIDER.SECRET_SET/SECRET_REMOVED/UPDATED/TESTED` يحمل البصمة والوصف، لا القيمة.

## المسارات

| الطريقة | المسار | الغرض |
| --- | --- | --- |
| GET | `/api/admin/ai/providers` | القائمة المقنّعة + حالة التخزين + هل الاختبار الحيّ مسموح |
| GET | `/api/admin/ai/providers/-readiness` | أي مزوّد سيخدم الآن، الافتراضي والبديل |
| GET | `/api/admin/ai/providers/:key` | تفصيل + استخدام 30 يومًا |
| PATCH | `/api/admin/ai/providers/:key` | `enabled`, `model`, `baseUrl`, `keyEnvVar`, `role` |
| PUT | `/api/admin/ai/providers/:key/secret` | تخزين/تدوير مفتاح (كتابة فقط) |
| DELETE | `/api/admin/ai/providers/:key/secret` | حذف المفتاح المخزَّن |
| POST | `/api/admin/ai/providers/:key/test` | `{ mode: 'CONFIG' \| 'LIVE' }` |
| GET | `/api/admin/ai/providers/:key/usage?days=` | نماذج/طلبات/رموز/تكلفة/وكلاء من صفوف حقيقية |

كلها محمية بـ`requireAuth` + `AI_MANAGE` أو `ADMIN_AI`، ومصادَقة على كل تغيير.

## سلسلة المزوّدين

```
default (مفعّل + مفتاح) → fallback (مفعّل + مفتاح) → local-heuristic
```

- `noop` محجوب في الإنتاج بنيويًا.
- المزوّد البديل يخدم **نموذجه** بسعره: لا يُرسل `claude-sonnet-4` إلى OpenAI.
- لا مفتاح لأي مزوّد ⇒ المنصة تعمل على المحرك المحلي بتكلفة صفر (اختبار صريح).
- صف لم يلمسه مسؤول يبقى فعّالًا إن سمّته البيئة (`AI_PROVIDER`) — توافق خلفي كامل.

## الاختبار والحدود

- `CONFIG`: بلا أي اتصال شبكي (مُثبت: عدّاد طلبات خادم وهمي = 0).
- `LIVE`: يتطلب `AI_PROVIDER_ALLOW_LIVE_TEST=true`، وإلا `409` قبل أي محاولة.
- الحمولة ثابتة: `{"messages":[{"role":"user","content":"ping"}],"max_tokens":1}` — لا مطالبة نظام ولا بيانات عملاء.
- الفشل يُسجَّل كـ`FAILED` مع رمز الحالة فقط، بلا جسم استجابة المزوّد.

## SSRF

`baseUrl` يجب أن يكون `https:` ومضيفه في `AI_PROVIDER_ALLOWED_HOSTS` أو مضيف مزوّد رسمي؛
`http://` مسموح فقط لـ loopback في غير الإنتاج (اختبار محلي). لا وصول لشبكة داخلية.

## عزل الوكلاء

`ai_providers` في `HARD_DENY_TABLES`: أي استعلام من وكيل يُرفض. قراءة المنصة للسلسلة
تمرّ عبر `platformDb()` (رمز على المقبض المُقيَّد) لأن تسجيل المزوّد بنية منصة لا بيانات وكيل.
الاختبار يثبت الأمرين معًا: استعلام الوكيل مرفوض، والسلسلة تُحلّ داخله دون تسريب.

## متغيّرات البيئة الجديدة

| المتغيّر | الافتراضي | الغرض |
| --- | --- | --- |
| `AI_CONFIG_ENVIRONMENT` | `NODE_ENV` | نطاق صفوف الإعداد (فصل البيئات) |
| `AI_SECRET_ENCRYPTION_KEY` | — | مفتاح رئيسي 32B base64؛ غيابه يعطّل التخزين فقط |
| `AI_PROVIDER_ALLOW_LIVE_TEST` | `false` | السماح بفحص مدفوع صريح |
| `AI_PROVIDER_ALLOWED_HOSTS` | — | قائمة مضيفين مفصولة بفواصل لنقاط نهاية مخصّصة |

## `DECISION REQUIRED`

1. مالك `AI_SECRET_ENCRYPTION_KEY` في الإنتاج ودورة تدويرها (KMS مقابل ملف بيئة).
2. السماح بمزوّد متوافق OpenAI داخل الشبكة (self-hosted) عبر `AI_PROVIDER_ALLOWED_HOSTS`.
3. سقف تكلفة الاختبار الحيّ لكل مزوّد/شهر.
