# AI ARCHITECTURE — WASIT BUSINESS GLOBAL (WASIT AI CORE)

## 1. المبدأ

طبقة AI مستقلة، **Provider-agnostic**، مقيدة بميزانية وبصلاحيات المستخدم.

## 2. WASIT AI CORE (استعدادات)

| الخدمة | الوصف | الحالة |
| --- | --- | --- |
| Product Recommendations | توصية منتجات | Schema (aiRequests) + تصميم |
| Smart Search | بحث ذكي (تتمة البحث النصي) | قابل للإضافة فوق Search Engine |
| Market Analysis | تحليل سوق | تصميم |
| Customer Assistant | مساعد عميل | تصميم |
| Supplier Recommendations | توصيات موردين | تصميم |
| Product Analysis | تحليل منتجات | تصميم |
| Price Intelligence | ذكاء أسعار (مصدر Price Comparison) | تصميم |
| Sales Intelligence | ذكاء مبيعات | تصميم |
| Admin Intelligence | مؤشرات إدارية | تصميم |
| Risk Analysis | تحليل خطر (يدعم Risk Engine) | تصميم |
| Dispute Assistant | مساعد نزاعات | تصميم |
| Advertising Assistant | مساعد إعلانات | تصميم |

## 3. AI AGENTS

Agents قابلة للإضافة أفقيًا (Sales, Marketing, Ads, Product, Support, Analytics, Market Research, B2B, Risk, Dispute, Development).

**ضابط إلزامي**: كل Agent يرث دور المستخدم/المتصل — **لا يتجاوز صلاحياته**. أي Tool يتحقق عبر RBAC قبل التنفيذ. تتمة تفاصيل الأدوار في `docs/PERMISSIONS_MATRIX.md`.

## 4. AI COST CONTROL LAYER

| بند | آلية |
| --- | --- |
| AI Budget | جدول `aiBudgets` (per month/scope) |
| Token Usage | `aiRequests` (input/output tokens) + `aiUsage` (مجمّع) |
| Model Routing | `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY` عبر env (Selection قابلة للتبديل) |
| Request Limits | لكل مستخدم/أدمن في حدود الاشتراك (`limits.aiPerDay` في SubscriptionPlans) |
| Cost Tracking | إجمالي مبلغ/عملة في aiRequests |
| User Limits / Admin Limits | حدود لكل دور (DB) |

## 5. قابلية تغيير المزود

- لا استيراد SDK لأي مزود داخل Services.
- واجهة `AiProvider` (generate, embed) تجريدية؛ التطبيقات عبر Env.
- Default: `noop`/`mock` لتطوير دون تكلفة — لا تكلفة فعلياً حتى إعداد مفتاح.

## 6. أخلاقيات/أمان

- النظام لا ينفذ أي تغيير مالي/تسويقي دون إذن المستخدم صاحب الصلاحية.
- Audit لكافة طلبات AI (من/ماذا/تكلفة).
- أنماط الإساءة (طلب كثير) → AI Budgets + Rate Limit.

## 7. توليد الفيديو التسويقي (Marketing Video Generation)

أول قدرة **توليد وسائط حقيقية** في AI CORE، منفّذة End-to-End:

| الطبقة | الواجهة | الملف |
| --- | --- | --- |
| منفذ التوليد | `VideoGenerationProvider` | `lib/media/video-types.ts` |
| المحرّك الافتراضي | `StructuralVideoProvider` (MP4 حقيقي عبر ffmpeg+libass) | `lib/media/video-provider.ts` |
| التعطيل | `NoopVideoProvider` (يفشل بصوت عالٍ) | `lib/media/video-provider.ts` |
| منفذ التخزين | `MediaStorage` | `lib/media/port.ts` |
| التخزين الخاص | `LocalMediaStorage` | `lib/media/local-storage.ts` |
| روابط موقّعة | `signDownloadToken`/`verifyDownloadToken` | `lib/media/tokens.ts` |
| التسجيل | `resolveMediaStorage`/`resolveVideoProvider`/`describeMediaProviders` | `lib/media/resolve.ts` |

- **Provider-agnostic**: لا SDK مزوّد يُستورد خارج `resolve.ts`. إضافة مزوّد generative
  خارجي (async) لاحقاً = تطبيق الواجهة + سطر في `resolve.ts`، دون لمس الخدمة/الـroutes/الواجهة.
  الواجهة تحمل `isAsync` جاهزاً للمزوّدين الذين يعيدون job id ويكملون لاحقاً.
- **محكوم بالميزانية**: كل render يمرّ عبر `assertWithinBudget` + `recordAiRequest`
  (`requestType = MARKETING_VIDEO`) + `upsertAiUsage`، فلا يمكن لتوليد الفيديو تجاوز AI Cost Control.
- **لا يتجاوز الصلاحيات**: التوليد يتطلب `media:upload`؛ الملكية تُفحص على كيان البيع؛
  المنتج يجب أن يكون ACTIVE. Marketing Agent **قراءة/توصية فقط** ولا ينشئ وسائط بنفسه —
  يعرض فقط الفيديوهات التي ولّدها صاحب الحساب (بروابط موقّعة).
- **خصوصية**: الأصول تُخزَّن خاصة وتُقدَّم فقط عبر روابط موقّعة قصيرة العمر — لا كشف ثابت.