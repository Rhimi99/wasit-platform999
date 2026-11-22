# AI-FIRST COMPLETION 05 — واجهات تشغيل الفيديو وشركاء B2B + سياسة احتفاظ مصنَّفة + جدولة موثوقة

**التاريخ:** 2026-11-20 · **الفرع:** `ai-first-completion`
**السابق:** `AI-FIRST-COMPLETION-04` (تسليم فيديو الوكيل + مطابقة B2B بالموافقة)

---

## 1. النطاق

| المهمة | ما نُفِّذ |
| --- | --- |
| 1. واجهة إنتاج الفيديو | صفحة `/dashboard/agent-video` تشغّل `marketing-video-agent` حقيقةً: اختيار منتج مملوك، لغة/جمهور/نمط/مدة، ثم مراحل حقيقية ومعاينة وتنزيل |
| 2. واجهة شركاء B2B | صفحة `/dashboard/partners` بموافقة صريحة (`B2B_PARTNER_DISCOVERY`) واقتراحات من بيانات حقيقية بلا بيانات اتصال |
| 3. تنزيل الفيديو | عبر المسار المصادَق `GET /api/ai/tasks/:id/video` فقط — لا يُرسل `storageKey` إلى الواجهة |
| 4. الاحتفاظ | اختبار 7 أيام / مسودة 30 يومًا / معتمد **لا يُحذف تلقائيًا**، والغير مُصنَّف يُحفظ |
| 5. الجدولة | systemd timer أو cron يستدعي `scripts/agent-video-purge.sh` — لا مؤقت داخل عملية Node |

**لم تُمنح أي صلاحية جديدة**، ولم تُعدَّل سياسات العمولة أو الرسوم أو الأدوار.

---

## 2. واجهة إنتاج الفيديو (`/dashboard/agent-video`)

- المنتجات تأتي من `GET /api/products/mine` (المالك فقط)، والاختيار إلزامي.
- المدة محصورة بين `MARKETING_VIDEO_DURATION.min` و`max` (35–120) من `@wasit/shared`، فلا تُرسل قيمة خارج النطاق.
- المهمة تُنشأ عبر `POST /api/ai/agents/marketing-video-agent/tasks` ثم تُقرأ بـ`GET /api/ai/tasks/:id`.
- **بوابة بشرية**: الوكيل `requiresHumanApproval: true`، فالحالة الأولى `awaiting_approval`. الواجهة تتوقف عن الاستقصاء وتشرح أن مشرفًا يجب أن يوافق، مع زر تحديث.
- بعد الموافقة تُعرض المراحل كما نفّذها المنفّذ فعلاً: `precheck_renderer → render → store → probe → decode` بزمن كل خطوة، وتفصيل الفشل عند الفشل.
- الحالة النهائية للوكيل المُعتمَد هي `approved` (لا `succeeded`)؛ الواجهة تعاملها كمكتملة.
- المعاينة `<video>` من نفس المسار المصادَق (يدعم `Range`)، والتنزيل عبر `?download=1` (`attachment`).
- يُعرض للفنان: المدة، الترميز، الأبعاد، الحجم، ونتيجة التحقق — لا `storageKey` ولا مسار ملف.

## 3. واجهة شركاء B2B (`/dashboard/partners`)

- الموافقة تُقرأ وتُكتب عبر `GET/PUT /api/privacy/consents` بنوع `B2B_PARTNER_DISCOVERY` (نفس مسار الخصوصية، لا مسار موازٍ).
- الاقتراحات من `b2b-agent` (مبوَّبة بموافقة بشرية أيضًا): النوع، الاسم التجاري، الدولة، التوثيق، عدد الإعلانات، الدرجة والأسباب.
- **لا بيانات اتصال**: لا بريد/هاتف/عنوان/معرّف تواصل، ولا إرسال رسائل أو إنشاء علاقات تلقائيًا — منصوص عليه في الواجهة نفسها.
- سحب الموافقة يمسح النتائج فورًا ويمنع الظهور في اقتراحات الآخرين.

---

## 4. سياسة الاحتفاظ (تصنيف من قاعدة البيانات، لا من اسم الملف)

`purgeAgentVideos(db, { testDays, draftDays })` في `modules/ai/agent-videos.ts`:

| الصنف | كيف يُحدَّد | المدة | عند الانتهاء |
| --- | --- | --- | --- |
| `TEST` | `input.renderTest === true` أو `input.mode === 'test'` أو المالك `system` | 7 أيام (`AGENT_VIDEO_TEST_RETENTION_DAYS`) | يُحذف |
| `DRAFT` | مهمة حقيقية بلا `approvedAt` | 30 يومًا (`AGENT_VIDEO_DRAFT_RETENTION_DAYS`) | يُحذف |
| `APPROVED` | `agent_tasks.approved_at` غير فارغ | بلا حد | **لا يُحذف تلقائيًا** |
| `UNKNOWN` | لا مهمة، مفتاح لا يطابق التخطيط، مالك لا يطابق `requested_by`، أو مهمة غير منتهية | — | **يُحفظ** (لا حذف بلا دليل) |

- التحقق من الملكية: مقطع المسار `agent-videos/<owner>/<taskId>-<hash>.mp4` يجب أن يطابق `requested_by`.
- الحالة: لا يُحذف ملف مهمة ما زالت `queued/running/awaiting_approval`.
- `media_assets` وسجلات التدقيق خارج النطاق تمامًا (لا يُمشى إلا `agent-videos/`)، والاختبارات تُثبت بقاءها.
- الجرد غير المتاح (مخزن غير محلي) ⇒ لا حذف، خطأ مُبلَّغ.
- التشغيل يكتب سطر تدقيق `AI.AGENT_VIDEO_PURGED` فقط عند حذف شيء، وبعددٍ إجمالي بلا معرّفات ملفات.

---

## 5. الجدولة الموثوقة

لا مؤقت داخل العملية: إعادة التشغيل تُسقطه، وتعدّد النسخ يُكرّره.

| الملف | الدور |
| --- | --- |
| `scripts/agent-video-purge.sh` | نقطة الدخول: `flock -n` (تشغيل واحد)، تحميل `.env` عند الحاجة، سطر JSON واحد في السجل، رمز خروج = رمز الأداة |
| `scripts/deploy/wasit-agent-video-purge.service` + `.timer` | systemd: يوميًا 03:15 UTC، `Persistent=true`، `TimeoutStartSec=900` |
| `scripts/deploy/agent-video-purge.cron` | بديل cron عند غياب systemd (`/etc/cron.d/wasit-agent-video-purge`) |

التثبيت (نظام systemd):

```bash
sudo cp scripts/deploy/wasit-agent-video-purge.service scripts/deploy/wasit-agent-video-purge.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wasit-agent-video-purge.timer
systemctl list-timers wasit-agent-video-purge.timer
```

يدويًا (تشخيص):

```bash
DATABASE_URL=... MEDIA_STORAGE_DIR=... ./scripts/agent-video-purge.sh --dry-run
```

**تحقّق فعلي في هذه البيئة**: شُغّل السكربت مرتين على قاعدة اختبار وملف اختباري عمره 10 أيام —
الدورة الأولى `deleted=1 bytesFreed=2048`، الثانية `deleted=0 scanned=0`، وسطرا JSON في السجل.
حاوية التطوير لا تحتوي `cron`/`systemctl`، لذا التثبيت الفعلي مسؤولية مضيف النشر.

---

## 6. الإثبات

| النوع | النتيجة |
| --- | --- |
| TypeScript (server) | `npx tsc --noEmit` = 0 أخطاء |
| TypeScript (web) | `npx tsc --noEmit` = 0 أخطاء |
| بناء الويب | `npm run build -w @wasit/web` ناجح |
| اختبارات الاحتفاظ | `tests/agent-video-retention.test.ts` — 6/6 (تصنيف، حدود، مجهول، تدقيق، تكرارية، نوافذ صريحة) |
| E2E حقيقي | `e2e/agent-surfaces.spec.ts` — 6/6 على Desktop Chrome وPixel 7 |
| ملف حقيقي | `ffprobe`: `h264` · 720×1280 · 35.000s · 105,416 bytes |

مسار E2E: دخول تاجر حقيقي → إنشاء مهمة → توقف عند بوابة الموافقة → موافقة مشرف حقيقي
(`admin@wasit.tn`) → رندر فعلي (2.4s) → معاينة `<video>` جاهزة → تنزيل 200 `video/mp4`
`attachment` → التأكد من غياب `agent-videos/` في HTML.

---

## 7. ملاحظة على ترحيل بيانات الاعتماد

`e2e/global-setup.ts` كان يفترض كلمة المرور المنشورة `Passw0rd!2026`، فتُفشل كل المواصفات بعد
تدوير DEMO-SEC-03. صار يقرأ `DEMO_ACCOUNT_PASSWORD_<SLUG>` / `DEMO_STAFF_PASSWORD_<SLUG>` مع
الرجوع إلى الافتراضي التطويري فقط. لا كلمة مرور منشورة في الكود تعمل على بيئة مُدوَّرة.
