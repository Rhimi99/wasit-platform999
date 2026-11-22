# AI-FIRST COMPLETION 04 — تشغيل الوكلاء الستة المتبقّين + مطابقة B2B بالموافقة + تسليم فيديو الوكيل + مصفوفة المراجعة

**التاريخ:** 2026-11-20 · **الفرع:** `ai-first-completion`
**السابق:** `AI-FIRST-COMPLETION-03` (نطاق بيانات الوكلاء + وكيل فيديو يُنتج فيديو)

---

## 1. الحالة قبل هذه المرحلة

| البند | الحالة |
| --- | --- |
| وكلاء مُنفَّذون فعلياً | 14 من 20 |
| وكلاء معلنون بلا منفّذ | 6: `payment-settlement-agent`, `compliance-agent`, `supplier-agent`, `merchant-agent`, `customer-intelligence-agent`, `operations-agent` |
| `b2b-agent` | يعمل، لكنه محصور بـ`ADMIN`/`SUPER_ADMIN` (AFC-03) — لا فائدة للمستأجرين |
| فيديو الوكيل | يُكتب إلى مخزن الوسائط ويُعاد `storageKey` فقط — **لا مسار تنزيل**، ولا سياسة احتفاظ |
| وكيل التطوير | تشخيص + حزم إصلاح (branch/PR body) — لا PR حقيقي (AD-050) |

---

## 2. الوكلاء الستة — منفّذون حقيقيون

كل منفّذ يقرأ PostgreSQL عبر استعلامات مُهيكلة (لا `db.execute` خام — A2 يرفضه)، ويمرّ عبر
`runAIFeature` لأغراض الاستهلاك/التكلفة/التدقيق، ويعيد `readOnly: true`.

| الوكيل | الإجراء | ما يقرأه | ما يُخرجه | الحارس |
| --- | --- | --- | --- | --- |
| `payment-settlement-agent` | `monitor_settlement` | `orders` (payment/settlement/refund state) | توزيع الحالات، مبالغ، `anomalies` (مدفوع بلا تسوية 48h، غير مدفوع متأخر، استرداد معلّق)، `moneyMovement: false`, `blindSpots` | `requiresPlatformScope` + رفض داخل المنفّذ |
| `compliance-agent` | `check` | `suppliers/merchants/companies` (verified)، `risk_profiles`, `risk_events`, `disputes`, `country_policy_gaps` | `findings[]` بأدلة و`nextStep`، `findingsOnly: true` | `requiresPlatformScope` |
| `supplier-agent` | `onboard` | `suppliers`, `products`, `trust_scores` | درجة اكتمال 0–100، الحقول الناقصة، `nextSteps`, الثقة، التحقّق | ملكية المستأجر (`userId`)؛ الطاقم قد يمرّر `entityId` |
| `merchant-agent` | `onboard` | `merchants`, `products`, `trust_scores` | نفس البنية | نفس الحارس |
| `customer-intelligence-agent` | `segment` | `orders` (مقيّدة بـ`orderScope`) | شرائح RFM (NEW/REPEAT/LOYAL/CHAMPION/AT_RISK/DORMANT)، إيراد ونصيب، `customerRef` مُجزَّأ (SHA-256، 10 hex)، `pii: 'masked'` | فلترة صفية بملكية البائع/المشتري |
| `operations-agent` | `health_check` | `orders`, `agent_tasks`, `agent_runs`, `inventory_items`, `messages` | `healthScore` 0–100، `blockers[]` بأنواع، عدّادات الطابور والوكيل والمخزون والدعم | `requiresPlatformScope` |

**عقود A2**: أُضيف عقد لكل وكيل (`AGENT_SCOPE_CONTRACTS`) بقائمة جداول دنيا، فصار العدد **20** عقداً
لعشرين وكيلاً قابلاً للتنفيذ. أي جدول خارج العقد يُرفض وقت التشغيل.

**لم تُمنح أي صلاحية جديدة.** `permissionsRequired` بقيت كما هي في الكتالوج؛ التغيير الوحيد هو
`executable: true` للستة.

---

## 3. `b2b-agent` — اقتراحات مقيّدة بالموافقة (تغيير سياسة مقصود)

### 3.1 القاعدة الجديدة

1. **الموافقة هي الفلتر الصفّي**: لا يظهر مستأجر كشريك محتمل إلا إذا كان صاحب الكيان يحمل
   `B2B_PARTNER_DISCOVERY = granted` في جدول `consents` (نوع مُضاف إلى `CONSENT_TYPES`).
2. **الطالب نفسه يحتاج الموافقة**: بدونها يُرفض التشغيل بـ`CONSENT_REQUIRED` مع `howToGrant`
   (`PUT /api/privacy/consents`).
3. **اللقطة تُحسب في طبقة الخدمة**: `consents` ممنوع منيع على كل وكيل (`HARD_DENY_TABLES`)،
   فـ`createAgentTask` تحسب `resolvePartnerConsent()` وتحقنها في `input.__partnerConsent`.
   أي `__partnerConsent` يرسله العميل **يُحذف** قبل الحقن (مُثبت باختبار).
4. **المنفّذ يضيّق ولا يوسّع**: يتقاطع مع اللقطة فقط، ويستبعد كيانات الطالب، ويقبل الأدوار
   التكميلية (مورّد↔تاجر/شركة، تاجر↔مورّد/شركة…).
5. **لا بيانات اتصال**: لا بريد/هاتف/معرّف كيان خام؛ `partnerRef` = SHA-256 مقطوع، والاسم التجاري
   فقط (نفس ما يُعرض في كتالوج عام).
6. **الأسباب مرفقة**: كل اقتراح يحمل `reasons[]` (دور تكميلي، نفس الدولة، موثَّق، كتالوج منشور)
   و`score` 0–100 محسوب من الأوزان نفسها.

### 3.2 تغيير الراية

`requiresPlatformScope` لـ`b2b-agent`: `true` → **`false`**.
السبب: كان التقييد إلى الطاقم لأن «لا فلترة صفية تحفظ الفائدة» (AFC-03). الموافقة صارت فلترة
صفية حقيقية، فصار المستأجر مؤهلاً. **هذا تغيير في ضمان أمني قائم**، وقد حُدِّثت الاختبارات التي
تثبته: `ai-platform-scope.test.ts` و`ai-agent-data-scope.test.ts` تنقلان عيّنة «الرفض قبل كتابة
صف» إلى `compliance-agent` (لا يزال منصّياً)، ويُثبت الاختبار الجديد أن `b2b` يرفض بدون موافقة
وأنه لا يرى إلا الموافقين.

---

## 4. تسليم فيديو الوكيل — مسار تنزيل + احتفاظ

| البند | التنفيذ |
| --- | --- |
| العنوان | `GET /api/ai/tasks/:taskId/video` — **بالمعرّف المهمة لا بمفتاح التخزين** |
| الملكية | صاحب المهمة (`agent_tasks.requested_by`) أو `ADMIN`/`SUPER_ADMIN`؛ غير ذلك **404** (لا oracle على وجود المعرّف) |
| المصدر | مفتاح الكائن يُقرأ من `result.advice.video.storageKey` المخزّن، فلا يمكن طلب كائن عشوائي |
| النقل | `Content-Type: video/mp4`, `Accept-Ranges: bytes`, دعم `Range` ⇒ **206** + `Content-Range`، و`?download=1` ⇒ `attachment` |
| الكاش | `private, no-store` + `X-Content-Type-Options: nosniff` |
| التدقيق | `AI.AGENT_VIDEO_DOWNLOADED` (entity `AGENT_TASK`, bytes/range/sha256) |
| الاحتفاظ | `AGENT_VIDEO_RETENTION_DAYS` (افتراضي 7) + `purgeAgentVideos()` + `npx tsx src/scripts/purge-agent-videos.ts [--days N] [--dry-run]` |
| نطاق الحذف | `agent-videos/` فقط داخل مخزن الوسائط — لا يلمس كائنات `media_assets` أبداً |
| لا نشر تلقائي | `publish.available = false` كما هو؛ الملف لا يُخدَم من مجلد عام |

---

## 5. وكيل التطوير — حزم إصلاح لا PR آلي

التحقق من `diagnostics.ts` و`execDevelopmentAgent`:

- التشخيص حقيقي: `analyseFailures` على `agent_tasks.error` و`agent_runs`/`agent_run_steps`.
- الحزمة (`buildRepairPackage`) تحمل: `branch` (`ai-repair/<family>`)، `prTitle`، `prBody` كامل
  (What/Evidence/Blast radius/Tests/Verification/Rollback/Approval)، `approvalsRequired`
  (`code.apply_patch`, `code.merge`)، `blocked[]`، `rollback`.
- **لا إنشاء PR آلي**: الوكيل لا يملك كتابة المستودع (AD-050)، وإعطاؤه توكن GitHub داخل الخادم
  توسيع صلاحيات غير مطلوب. التسليم = حزمة مراجعة + موافقة بشرية، وهذا ما تثبته الاختبارات.

**`DECISION REQUIRED`**: هل يُفتح PR آلي من الوكيل (توكن محدود النطاق + مستودع هدف + مراجعة
إلزامية)، أم تبقى الحزمة يدوية؟ مسجّل في AD-051.

---

## 6. مصفوفة المراجعة النهائية (20 وكيلاً)

| # | الوكيل | قابل للتنفيذ | نطاق | بوابة موافقة | يقرأ بيانات مستأجرين آخرين؟ | الإجراء |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `sales-agent` | ✅ | ملكية | لا | لا (فلترة صفية) | `identify_leads` |
| 2 | `marketing-agent` | ✅ | ملكية | لا | لا | `recommend_campaign` |
| 3 | `marketing-video-agent` | ✅ | ملكية | لا | لا | `plan_video` |
| 4 | `product-agent` | ✅ | ملكية | لا | لا | `analyze_listing` |
| 5 | `support-agent` | ✅ | ملكية | لا | لا | `draft_reply` |
| 6 | `analytics-agent` | ✅ | منصة | لا | نعم (تجميعات) | `generate_report` |
| 7 | `market-research-agent` | ✅ | منصة | لا | نعم (تجميعات) | `market_overview` |
| 8 | `b2b-agent` | ✅ | **موافقة** | لا | فقط الموافقون، بلا اتصال | `match_b2b` |
| 9 | `risk-agent` | ✅ | منصة | ✅ | نعم (ملفات مخاطر) | `assess_risk` |
| 10 | `dispute-assistant` | ✅ | منصة | ✅ | نعم (نزاعات) | `summarize_dispute` |
| 11 | `development-agent` | ✅ | منصة | ✅ | نعم (أخطاء الوكلاء) | `dev_plan` |
| 12 | `finance-agent` | ✅ | منصة | لا | نعم (تجميعات) | `report_pnl` |
| 13 | `outreach-acquisition-agent` | ✅ | منصة | لا | نعم (تجميعات) | `discover_markets` |
| 14 | `payment-settlement-agent` | ✅ (جديد) | منصة | ✅ | نعم (حالات دفع) — لا جداول أموال | `monitor_settlement` |
| 15 | `compliance-agent` | ✅ (جديد) | منصة | ✅ | نعم (امتثال) — findings فقط | `check` |
| 16 | `supplier-agent` | ✅ (جديد) | ملكية | لا | لا | `onboard` |
| 17 | `merchant-agent` | ✅ (جديد) | ملكية | لا | لا | `onboard` |
| 18 | `customer-intelligence-agent` | ✅ (جديد) | ملكية | لا | لا (هويات مُجزَّأة) | `segment` |
| 19 | `operations-agent` | ✅ (جديد) | منصة | لا | نعم (تشغيلي) | `health_check` |
| 20 | `agent-supervisor` | ❌ (تنسيق لا تنفيذ) | — | — | — | — |

**لا وكيل يكتب**: كل المنفّذين `readOnly`، وكل كتابة تمرّ عبر خدمة + تدقيق.

---

## 7. الاختبارات

| الملف | الحالات | ماذا تثبت |
| --- | --- | --- |
| `tests/ai-first-04.test.ts` | 11 | الستة يعملون فعلياً؛ رفض غير الطاقم للثلاثة المنصّيين؛ ملكية المورّد؛ رفض `ENTITY_NOT_FOUND`؛ شرائح حقيقية + إخفاء هوية المشتري؛ `CONSENT_REQUIRED`؛ الاقتراحات للموافقين فقط + لا اتصال + أسباب؛ حذف اللقطة المزوّرة |
| `tests/agent-video-download.test.ts` | 6 | تنزيل المالك 200 + تدقيق؛ `Range` ⇒ 206؛ غريب ⇒ 404؛ الطاقم ⇒ 200 `attachment`؛ مجهول ⇒ 401؛ الحذف بالاحتفاظ يحذف القديم ويبقي الجديد |
| `tests/ai-reg01-agent-layer.test.ts` | 7 | الكتالوج 20/20 قابل للتنفيذ |
| `tests/phase14-agents.test.ts` | 20 | كل وكيل يعيد بنيته المتخصّصة |
| `tests/r1-agent-catalogue.test.ts` | 27 | لا سلطة تنفيذ جديدة؛ 20 عقد A2 |
| `tests/a2-agent-scope.test.ts` | 10 | كل وكيل قابل للتنفيذ له عقد |
| `tests/ai-agent-data-scope.test.ts` | 15 | حدود المستأجر + الرفض قبل الكتابة |
| `tests/ai-platform-scope.test.ts` | 9 | قائمة الوكلاء المنصّيين (بعد إضافة `payment-settlement-agent` وإخراج `b2b-agent`) |

---

## 8. ما لم يُنفَّذ (بصراحة)

1. **PR آلي من وكيل التطوير** — يحتاج قراراً (AD-051) وتوكناً محدود النطاق.
2. **واجهة ويب** لمشغّل الفيديو الجديد أو لموافقة B2B (الـAPI جاهز؛ الواجهة خطوة تالية).
3. **جدولة الحذف** — السكربت جاهز لكن لم يُربط بمؤقّت داخلي؛ يُشغَّل من مجدول النشر.
4. **`payment-settlement-agent` لا يرى webhooks/payouts/ledger** — ممنوعة معمارياً على كل وكيل؛
   التقرير يعلن هذه النقطة في `blindSpots` بدل الإيحاء بتغطية كاملة.
