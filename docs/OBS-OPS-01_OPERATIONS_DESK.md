# OBS-OPS-01 — مكتب العمليات للمدير العام (Operations Desk)

**التاريخ:** 2026-11-21 · **الفرع:** `master` · **النوع:** ميزة Backend + Web + اختبارات.

> **القيد الحاكم:** لا بناء منظومة مراقبة ثانية. كل رقم في هذه الشاشة مأخوذ من نظام قائم
> (`metrics`, `alerts`, `AI-MET-01`, `AI-SUP-02`, الجدولة، سجل الإشعارات). المهمة سدّت
> **ثقوب عرض** فقط — لا مصدر حقيقة جديد.

---

## 1. الجرد (ما كان موجوداً فعلاً قبل المهمة)

| المجال | ما وُجد في الكود | الفجوة الفعلية |
| --- | --- | --- |
| مقاييس HTTP | `lib/observability/metrics.ts` (counters/gauges/histograms) + `GET /metrics` | لا تجميع لصفحة واحدة؛ الأرقام موجودة لكن موزّعة |
| تنبيهات | `lib/observability/alerts.ts` (قواعد + انتقالات) + `alert_events` + `GET /alerts` + `POST /alerts/evaluate` | **لا إقرار ولا إغلاق يدوي**؛ لا فصل بين تنبيهات المنصة وحالات المشرف |
| صحة المنصة | `GET /api/health/{live,ready,channels}` (db, mail, sms, rate-limit, backup) | لا لقطة تشغيلية موحّدة؛ لا نسبة أخطاء/أبطأ مسار |
| جدولة خلفية | `lib/scheduler.ts` (10 مهام) — كل مهمة تبتلع خطأها وتكتب سطر لوج فقط | **لا حالة لكل مهمة** (آخر تشغيل/مدة/فشل متتالٍ) — فشل صامت |
| وكلاء AI | `modules/ai/metrics.ts` + `agent-metrics.ts` + `/api/admin/ai/{metrics,agents,tasks,supervisor/overview}` | الأرقام موجودة لكن لا تجميع GM؛ لا رؤية للمتعثر/المرفوض في شاشة واحدة |
| تصعيدات المشرف | `modules/ai/escalations.ts` + مسارات `GET/POST /api/admin/ai/escalations*` كاملة | **لا واجهة إطلاقاً** — صفر `escalation` في `packages/web` قبل هذه المهمة |
| إشعارات | جدول `notification_deliveries` + `notification` service | **لا مسار إداري ولا واجهة** لفشل التسليم |
| نسخ احتياطي | `backupStatus()` داخل `health/routes.ts` + قاعدة `backup_stale` | منطق محلي غير قابل لإعادة الاستخدام |

---

## 2. ما أُضيف (فقط ما كان ناقصاً)

### 2.1 Backend

| الملف | الإضافة |
| --- | --- |
| `src/lib/observability/job-registry.ts` (جديد) | سجل داخل العملية لكل دورة مهمة: `lastRunAt`, `lastDurationMs`, `lastOutcome`, `consecutiveFailures`, `totalFailures`, `lastError` + `trackJob()` + `schedulerInfo()` |
| `src/lib/scheduler.ts` | كل مهمة من العشر تُغلَّف بـ`trackJob` وتُرجع `ok/failed/skipped`؛ `markSchedulerStarted/Stopped` |
| `src/lib/observability/backup-status.ts` (جديد) | استخراج `backupStatus()` من مسار الصحة ليشترك فيه `/health/channels` واللقطة |
| `src/modules/observability/operations.ts` (جديد) | `buildOperationsSnapshot(db)` — قراءة واحدة، 16 استعلاماً متوازياً، بلا كتابة |
| `src/modules/observability/routes.ts` | `GET /operations` · `POST /alerts/:id/acknowledge` · `POST /alerts/:id/resolve` · `scope=platform|supervisor|all` على `GET /alerts` |

**دلالات القرارات (مقصودة):**

- **الإقرار ليس إغلاقاً:** الصف يبقى `FIRING`؛ يُسجَّل `details.ack = {by, at, note}` + Audit
  `OBSERVABILITY.ALERT_ACKNOWLEDGED`. تنبيه مُقَرّ لا يُقرأ أبداً كحالة سليمة.
- **الإغلاق اليدوي ليس كتم صوت:** يُرفض بـ409 إذا كانت القاعدة ما تزال مشتعلة في العملية
  (`firingAlerts()`)، ويُرفض بلا سبب (422). الغرض: تنظيف صفوف بقيت بعد إعادة تشغيل أو قاعدة أُزيلت.
- **فصل دورة الحياة:** `supervisor.*` (تصعيدات) تُرفض على مسارات التنبيهات بـ409 وتُدار عبر
  `escalations/:id/{acknowledge,resolve}` — لا مسار يغلق حالة يتابعها مسار آخر.

### 2.2 الواجهة

- تبويب **`operations`** جديد (أول تبويب) في `/admin/observability` عبر `components/OperationsPanel.tsx`:
  - 8 مؤشرات: DB، نسبة الأخطاء، p95، عمر النسخة الاحتياطية، «بحاجة إلى قرار»، مهام متعثرة، دورات نشطة، نجاح الوكلاء 24س.
  - **لوحة التصعيدات**: قائمة OPEN + `إقرار` + `إغلاق بسبب` + `مسح الآن` (تستدعي مسارات `admin/ai/escalations` القائمة).
  - **جدول المهام الخلفية**: آخر تشغيل/مدة/نتيجة/فشل متتالٍ/آخر خطأ.
  - **الوكلاء**: كتالوج + سجل + أكثر الوكلاء فشلاً + التكلفة لكل عملة + تغطية القياس.
  - **تسليم الإشعارات**: توزيع الحالات + آخر 10 إخفاقات.
  - **«ما لا يمكن قياسه الآن»**: يعرض `unavailable[]` حرفياً بدل صفر مضلّل.
  - **أحدث أحداث المراقبة** (Audit `OBSERVABILITY.*`).
- تبويب `alerts`: أزرار `إقرار` و`إغلاق` لكل صف `FIRING`.
- `api.ts`: `adminObservabilityOperations`, `adminAcknowledgeAlert`, `adminResolveAlert`,
  `adminEscalations`, `adminAcknowledgeEscalation`, `adminResolveEscalation`, `adminScanEscalations`.
- i18n: **62 مفتاحاً** في `ar/en/fr/zh`.

---

## 3. الإثبات

| الاختبار | العدد | يثبت |
| --- | --- | --- |
| `tests/obs-operations.test.ts` | **11/11** | RBAC (401/403) · لقطة حقيقية (DB up، عدّاد الطلبات، كتالوج، notifier) · مهمة متعثرة + تصعيد مفتوح يظهران · فصل `scope` · إقرار يحفظ FIRING ويكتب Audit · رفض 409 لإقرار صف مغلق/تصعيد · 404 لمجهول · إغلاق يتطلب سبباً (422) ويكتب Audit · منع إغلاق قاعدة مشتعلة (409 + الصف لم يتغيّر) · سلوك سجل المهام (مدة/فشل متتالٍ/تصفير) |
| `tests/observability.test.ts` (تراجع) | **26/26** | لم يُكسر أي عقد قائم (المقاييس/اللوج/التنبيهات/المُشعِر) |
| `npx tsc --noEmit` (server) | 0 أخطاء | — |
| `npx tsc --noEmit` (web) | 0 أخطاء | — |
| `npm run build -w @wasit/web` | نجح | الصفحة تُبنى |

**البيئة:** PostgreSQL 17 معزول على `127.0.0.1:5434`، قاعدة `wasit_test` فقط، عبر
`TEST_DATABASE_URL` الصريح وحرّاس `tests/test-db-guard.ts`. لم تُلمس `wasit_dev` ولا `wasit_demo`.

---

## 4. حدود مُعلنة (لا يُدَّعى أكثر منها)

1. **سجل المهام داخل العملية** (`GAP-OPS-01`): بعد إعادة تشغيل يبدأ فارغاً. اللقطة تعوّض جزئياً
   بطوابع DB (`alertsLastEvaluatedAt`, `escalationsLastScanAt`, `supervisorLastCycleAt`)، لكن لا تجميع
   عبر عدة نسخ (multi-instance).
2. **إشعارات: عرض فقط** (`GAP-OPS-02`): لا إعادة محاولة/إعادة إرسال من المكتب.
3. **`buildSupervisorOverview` تُستدعى داخل اللقطة**: تكلفتها تتناسب مع عدد الدورات الحيّة
   (استعلامات لكل دورة). مقبولة لصفحة إدارية، لا لمسار ساخن.
4. **مقاييس HTTP تراكمية منذ الإقلاع** (ليست نافذة زمنية) — الواجهة لا تدّعي غير ذلك؛ نافذة الـ24 ساعة
   تنطبق على الوكلاء/التكلفة/الإشعارات فقط.
