# AI-FIRST COMPLETION 02 — اعتماد القرارات وإكمال الوكلاء التنفيذيين

**التاريخ:** 2026-11-22 · **الفرع:** `ai-first-completion` · **الأساس:** `master` @ `1363682`
**السابق:** `AI-FIRST-COMPLETION-01` (commit `8078408`)

## 1. القرارات المعتمدة وطريقة تنفيذها

| القرار | التنفيذ في هذه المهمة |
| --- | --- |
| (1) الوكلاء ذوو `requiresPlatformScope` يبقون ADMIN/SUPER_ADMIN فقط حتى تُنفَّذ فلترة صفية حقيقية وتُختبر — دون توسيع صلاحيات أو تغيير `ROLE_PERMISSIONS` | لم يُضف أي صلاحية ولم يُعدَّل `shared/rbac.ts`. بُوِّب وكيل واحد كان يعلن `scope: 'platform'` بلا تفعيل (`market-research-agent`)، وأُضيفت **فلترة صفية حقيقية** لوكيل الدعم بدل حرمان العملاء منه. الاختبارات تثبت الرفض قبل كتابة أي مهمة. |
| (2) إصلاحات Platform Maintenance & Repair تُسلَّم عبر فرع مستقل + PR، مع تقرير واختبارات وخطة تراجع، وموافقة المدير العام إلزامية قبل التطبيق | أُضيف `buildRepairPackage` إلى `diagnostics.ts`: ينتج اسم الفرع، عنوان PR، ونص PR كامل (سبب، أدلة، اختبارات، تحقق، تراجع، بوابات الموافقة) — **بلا diff**، وحالة الموافقة `NOT_RECORDED`. أي تطبيق فعلي يبقى خارج الوكيل. |

## 2. وكيل الفيديو التسويقي: من «إعلان» إلى تخطيط حقيقي

### 2.1 ما تغيّر

- `marketing-video-agent` صار `executable: true` مع منفّذ `execMarketingVideoAgent` وإجراء تنفيذي واحد `plan_video`
  (مضاف إلى `EXECUTOR_ACTION` — البوابة الموثوقة `requireAction` تمنحه فقط لأنه مُعلن في `capabilities`).
- العقد `AGENT_SCOPE_CONTRACTS['marketing-video-agent']` = `products, media_assets, suppliers, merchants, companies`
  (قراءة فقط، بلا `audit_logs` — وهو سبب بنيوي لعدم قدرة أي وكيل على إنتاج الفيديو).
- الكتالوج: **14 منفّذاً / 6 مُعلنين فقط / 20 متخصصة + مشرف = 21 هوية**.

### 2.2 ما يفعله المنفّذ فعلاً (لا Mock)

يقرأ المنتج الحقيقي من PostgreSQL (مع تحقق الملكية عبر `assertSellerOwnership`)، ويُعيد:

- `product`: id/name/price/currency/status/sellerType — من الصف الحقيقي.
- `plan`: 4 شرائح موقوتة (`planRenderSlides` — نفس الدالة التي يستخدمها الرندر)، نص الشريحة، السيناريو،
  الستوري بورد، قائمة الأصول، وتسليم `mp4/h264`.
- `readiness`: `provider: 'structural'`، `available` من فحص ffmpeg/ffprobe الحقيقي، `externalServices: false`.
- `renderRequest`: `POST /api/media/marketing-videos` مع body جاهز للتنفيذ (`productId, language, audience, style, durationSeconds`).
- `publish`: `available: false` — لا منفّذ نشر.

### 2.3 ما لا يفعله — ولماذا

| القدرة | الحالة | السبب |
| --- | --- | --- |
| `render_video` | `requiresApproval` بلا منفّذ | الرندر يكتب `media_assets` + `audit_logs`؛ A2 يمنع الوكلاء من كتابة التدقيق ⇒ لا يمكن أن يكون أثراً وكيلياً. يبقى في وحدة الوسائط تحت ملكية المالك. |
| `publish_video` | `requiresApproval` بلا منفّذ | نشر خارجي = قرار مالك + اعتماد بشري. |
| إنفاق | لا | `maxCostUsdPerRun: 2` عبر `runAIFeature` فقط. |

### 2.4 إثبات أن الفيديو حقيقي (ليس امتداد `.mp4`)

`src/scripts/render-test-video.ts` يرندر فعلياً ثم يفحص الملف بـ ffprobe ويفكّ ترميزه كاملاً.
التقرير المحفوظ: `docs/evidence/ai/marketing-video-2026-11-22T09-02-18-931Z.json`.

| القياس | القيمة |
| --- | --- |
| الملف | `backups/media/wasit-marketing-video-2026-11-22T09-02-18-931Z.mp4` (98,155 بايت) |
| sha256 | `3f4416f225cc2d1c51e64e10b57acf634bcdd2933a2e65186ad4078215cf6e9f` |
| المدة (moov) / (ffprobe) | 35.000s / 35.000s |
| الترميز | h264 High, yuv420p, 720×1280, 25/1 fps, 875 إطاراً |
| فك الترميز الكامل | نجح بلا أخطاء (`ffmpeg -f null -`) |
| نص مرسوم فعلاً | 2.40% و5.75% بكسلات غير خلفية في إطارين (7,312/7,633 لوناً) |
| الخط العربي مستخدم فعلاً | استبدال الخط بخط غير موجود غيّر 6.39% من بكسلات الإطار ⇒ libass يستعمل `Noto Sans Arabic` وليس بديلاً |
| مواد خارجية | صفر: خلفية lavfi مولّدة، نصوص WASIT، خط Noto Sans Arabic (SIL OFL 1.1) + DejaVu |

**اختبارات الوكيل:** `tests/ai-video-agent.test.ts` (5) عبر دورة حياة حقيقية (طلب → موافقة معتمد آخر → تنفيذ)
+ `tests/unit/ai-video-plan.test.ts` (5) + اختبار «التسليم قابل للتنفيذ» الذي يرندر فعلياً 35 ثانية ويقيس المدة.

## 3. حزمة الإصلاح المستقلة (القرار 2)

`buildRepairPackage(cluster, proposal, now)` تُنتج:

| الحقل | القيمة |
| --- | --- |
| `branch` | `ai-repair/<family-slug>` (مثال `ai-repair/insufficient-stock`) |
| `baseBranch` | `master` |
| `prTitle` | `fix(ai-repair): <FAMILY> — <signature>` |
| `prBody` | الأدلة (عدد الحوادث، الوكلاء، أنواع المهام، التوقيع)، الملفات المرشحة، الاختبارات المقترحة، خطوات التحقق، **خطة التراجع**، وبوابات الموافقة |
| `approvalStatus` | `NOT_RECORDED` — الوكيل لا يسجّل موافقة |
| `approvalsRequired` | `code.apply_patch`, `code.merge` |
| `delivery` | `{ appliedBy: 'human', mergeBlockedUntilApproval: true }` |
| `blocked` | `isolated_tests`, `apply_patch` (خطوات لا ينفّذها الوكيل) |

**لا diff ولا patch مطبّق.** الوكيل يقرأ `agent_tasks/agent_runs` فقط، ولا يكتب في المستودع.
يظهر الحقل في نتيجة `development-agent` تحت `repairPackage` مع `rootCauseAnalysis` و`patchProposals`.

## 4. تدقيق باقي الوكلاء (20 متخصصة)

### 4.1 الفجوتان اللتان أُغلقتا

**(أ) `market-research-agent` — إعلان بلا تفعيل.** كان يعلن `scope: 'platform'` ويقرأ كل الموردين/المنتجات/الطلبات،
لكن `requiresPlatformScope` لم يكن مضبوطاً ⇒ أي عميل بـ`ai:use` يرى مجاميع المنصة. الآن مضبوط، والاختبار يثبت
الرفض لخمسة أدوار غير إدارية.

**(ب) `support-agent` — تسريب محتوى رسائل.** كان يُعيد آخر الرسائل غير المقروءة **على مستوى المنصة**
(`senderId` + أول 120 حرفاً من النص) لأي طالب. أُضيفت فلترة صفية حقيقية بدل حرمان العملاء:

- غير الموظفين: `threads.participant_ids @> [requesterId]`، والرسائل محصورة في خيوط المشارك،
  وعدّاد المستخدمين النشطين `null` (معلومة إدارية).
- أطقم الدعم (`ADMIN`/`SUPER_ADMIN`/`SUPPORT`): العرض الكامل + `dataScope: 'platform'`.
- الاختبارات: `tests/ai-support-scope.test.ts` (3) — عميل يرى خيوطه فقط، طقم دعم يرى الكل، ولا تسريب عبر العدّاد.

### 4.2 فجوة مفتوحة واحدة (تحتاج قراراً — لم تُعالج هنا)

خمسة وكلاء يعلنون `scope: 'own'` أو لا يعلنون شيئاً بينما تُعيد منفّذاتهم **مجاميع على مستوى المنصة**
(بلا هوية أطراف): `sales-agent`, `marketing-agent`, `product-agent`, `b2b-agent`, `finance-agent`,
`outreach-acquisition-agent`. المخرجات أرقام/توصيات لا صفوف مستخدمين (لا تُسرّب محتوى)، لكنها تكشف
مؤشرات أعمال المنصة لغير الإداريين. الحل الصحيح هو فلترة صفية لكل وكيل (كما فُعل للدعم) — **قرار مطلوب**
من المدير العام: أيهما أولاً، أم تقييدها مؤقتاً كما في القرار (1).

### 4.3 الستة المُعلنون فقط (بلا منفّذ، برفض صريح)

`payment-settlement-agent`, `compliance-agent`, `supplier-agent`, `merchant-agent`,
`customer-intelligence-agent`, `operations-agent` — كلها ترفض `AGENT_NOT_EXECUTABLE` قبل كتابة أي مهمة،
والمشرف يرفض بـ`SUPERVISOR_NOT_RUNNABLE`، والـCopilot لا يُسند إلى وكيل غير قابل للتنفيذ.

## 5. الاختبارات

| الأمر | النتيجة |
| --- | --- |
| `npx tsc --noEmit` | 0 أخطاء |
| `npx vitest run` (كامل) | 163 ملفاً · 2,085 اختباراً — بعد إصلاح اختبارات العقد الثلاثة |
| الجديد | `ai-video-agent` (5), `unit/ai-video-plan` (5), `ai-support-scope` (3), حزمة الإصلاح في `ai-maintenance-rootcause` (+4) |

## 6. خطة التراجع

1. **وكيل الفيديو:** إرجاع `executable: false` + حذف مفتاحه من `EXECUTOR_ACTION` + حذف العقد ⇒ يعود مرفوضاً
   بـ`AGENT_NOT_EXECUTABLE` (الاختبارات القديمة موجودة في تاريخ `ai-arch-align`).
2. **فلترة الدعم:** حذف `threadScope`/`messageScope` يُعيد العرض الكامل — لكنه يُعيد التسريب، لذا التراجع
   المقبول هو تقييد الوكيل بالإدارة (`requiresPlatformScope: true`) بدلاً من ذلك.
3. **`market-research`:** إزالة `requiresPlatformScope` تُعيد الوصول للعملاء وتُعيد الفجوة — لا يُنصح.
4. **حزمة الإصلاح:** حقل `repairPackage` إضافي في مخرجات JSON؛ حذفه لا يغيّر أي مسار تنفيذ.
5. لا migrations ولا تغيير في `ROLE_PERMISSIONS` ولا في المخطط ⇒ التراجع كودي بحت.
