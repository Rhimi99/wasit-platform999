# OBS-01 — WEBHOOK FAILURE RECOVERY (BOUNDED RETRY · IDEMPOTENCY · DLQ)

تاريخ: 2026-11-20 · الحالة: **IMPLEMENTED + VERIFIED** (PostgreSQL 17 معزول `wasit_test` على `127.0.0.1:5434`) · Commit مستقل

مرجع: `docs/GAP_REGISTER.md` §2 (OBS-01) · `docs/OBS-01_WEBHOOK_FAILURES_REPLAY.md` (مكتب المشغّل السابق) ·
`docs/MONEY_PATH_INVARIANTS.md` (قاعدة Payment ≠ Settlement) · `docs/ARCHITECTURE_DECISIONS.md`.

---

## 1. المشكلة قبل التنفيذ

مكتب المشغّل (2026-11-06) جعل الفشل **مرئيًا** وأتاح `replay` يدويًا، لكن **محرّك المعالجة نفسه**
بقي بلا ضوابط كافية:

| النقص | الأثر قبل الإصلاح |
| --- | --- |
| لا تصنيف للفشل | كل خطأ يُعامَل بنفس الطريقة: خطأ دائم (409/422) يستهلك 5 محاولات بلا فائدة قبل DLQ |
| لا backoff | كل تسليم من المزوّد يُعيد المحاولة فورًا — لا فاصل زمني متزايد بين المحاولات |
| تزامن غير محكوم | تسليمان متزامنان لنفس الحدث يمكن أن يدخلا مسار التطبيق معًا (الفحص `status` ثم التطبيق ليس ذرّيًا) ⇒ خطر تطبيق مزدوج |
| لا سجل محاولات | `attempts`/`lastError` حقول على الصف فقط؛ لا تاريخ لكل محاولة (متى؟ ماذا؟ هل جُدولت؟) |
| replay بلا سقف | `replay` يعيد العدّاد إلى 0 بلا حد ⇒ يمكن تحويل حدث معطوب إلى حلقة إعادة تشغيل لا نهائية |
| لا تفريق «ينتظر المحاولة» عن «استُنفد» | الواجهة تعرض `FAILED` فقط، ولا تعرف متى المحاولة القادمة |

## 2. مبدأ التصميم

1. **المزوّد هو محرّك إعادة المحاولة، لا مؤقّت داخلي.** WASIT لا تعيد تطبيق أثر مالي من تلقاء نفسها؛
   عند وصول تسليم جديد لحدث فاشل يُسمح بالمحاولة **فقط** إذا انقضت نافذة الـbackoff وبقي في الميزانية.
   هذا يمنع أي عملية خلفية من تحريك المال، ويُبقي المزوّد مصدر الحقيقة للتسليم.
2. **المطابقة قبل المال.** لا يصل أي حدث إلى مسار التطبيق إلا بعد امتلاك claim ذرّي حصري.
3. **الفشل الدائم لا يُعاد.** التصنيف يقرّر: `TRANSIENT` فقط قابل لإعادة المحاولة.
4. **الحالة النهائية ظاهرة ومحفوظة.** `DEAD_LETTERED` صف باقٍ (لا يُحذف) + Audit + سجل محاولات.
5. **الإعادة اليدوية لا تُطبّق شيئًا.** تُعيد الصف إلى `RECEIVED` فقط؛ التسليم التالي يطبّق عبر المسار المحروس.

## 3. تصنيف الفشل (`lib/payments/webhook-retry.ts`)

| التصنيف | أمثلة | قابل لإعادة المحاولة؟ |
| --- | --- | --- |
| `TRANSIENT` | `NOT_FOUND` (intent/order لم يُنشأ بعد)، `SERVICE_UNAVAILABLE`، `RATE_LIMITED`، 5xx، خطأ DB/شبكة غير معروف | ✅ نعم (ضمن الميزانية) |
| `CONFLICT` | `CONFLICT`/`INVALID_OPERATION` (مبلغ/عملة غير مطابقين، intent بلا transaction) | ❌ لا — إنسان يفحص |
| `PERMANENT` | `VALIDATION_ERROR`/`VALIDATION_FAILED`، 4xx أخرى | ❌ لا |
| `CAPABILITY` | مزوّد لا يملك `settlementEvidence` ويحاول ادّعاء تسوية | ❌ لا |
| `STALE` | حدث متأخر يعيد الحالة إلى الوراء (مثل `payment.failed` بعد نجاح) | ❌ لا — يُسجَّل `PROCESSED` ولا يُطبَّق |

الخطأ غير المعروف يُصنَّف `TRANSIENT` افتراضيًا (خطأ بنية تحتية أكثر احتمالًا)، والميزانية تحدّه.

## 4. سياسة إعادة المحاولة (bounded + exponential backoff)

```
delay(attempt) = min(baseDelayMs × factor^(attempt-1), maxDelayMs)
nextAttemptAt  = now + delay(attempt)
```

| الإعداد (Env) | الافتراضي | المعنى |
| --- | --- | --- |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | `5` | سقف المحاولات قبل DLQ (1..50) |
| `WEBHOOK_RETRY_BASE_DELAY_MS` | `30000` | مهلة المحاولة الثانية |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | `3600000` | سقف النمو الأسي |
| `WEBHOOK_CLAIM_LEASE_MS` | `60000` | مدة حصرية للـclaim قبل أن يجوز استلامه من عملية أخرى |
| `WEBHOOK_REPLAY_MAX` | `3` | عدد مرات `replay` المسموحة للحدث الواحد |

`factor = 2` ثابت في الكود. مثال بالمعدلات الافتراضية: 30s → 60s → 120s → 240s ثم DLQ عند المحاولة الخامسة.

**متى يُسدَّل الحدث (DLQ)؟** عند بلوغ السقف، أو فورًا إذا كان التصنيف غير قابل لإعادة المحاولة
(`CONFLICT`/`PERMANENT`/`CAPABILITY`).

## 5. المطابقة ومنع المعالجة المزدوجة

- **مفتاح idempotency**: الفهرس الفريد `payment_webhook_events_provider_event_idx (provider, event_id)` —
  الإدراج `ON CONFLICT DO NOTHING` هو بوّابة المطابقة.
- **claim ذرّي**: الإدراج يحمل `claim_token` + `claimed_at` مباشرة (لا فجوة بين الإدراج والحيازة)،
  وللحدث الموجود يُستعمل `UPDATE … WHERE status IN ('RECEIVED','FAILED') AND (claim_token IS NULL OR claimed_at < now() - lease)
  AND (next_attempt_at IS NULL OR next_attempt_at <= now()) RETURNING …` فيُفلح واحد فقط.
- **الخاسر يُقرّ ولا يُطبّق**: `inProgress: true` (تسليم متزامن) أو `duplicate: true` (PROCESSED) أو
  `retryScheduled: true` (لم يحن الـbackoff) أو `deadLettered: true`.
- **lease** يضمن أن عملية تعطّلت في منتصف التطبيق لا تُقفل الحدث للأبد؛ تسليم لاحق بعد انقضاء المهلة يستلمه.

## 6. الأحداث المتأخرة (stale)

الحارس الحالي (monotonic money states) بقي كما هو، وأُضيف إليه **تسجيل صريح**:
`failure_class = STALE` + صف محاولة `outcome = STALE`، والحالة `PROCESSED` كي لا يُعاد أبدًا.

## 7. الحالة النهائية (Dead Letter) وإعادة التشغيل

- `DEAD_LETTERED`: صف باقٍ + `dead_lettered_at` + Audit `PAYMENT.WEBHOOK_DEAD_LETTERED`
  بفاعل `SYSTEM` (`actorId = NULL`) — الفشل ليس فعل إنسان.
- `POST /api/payments/webhook-failures/:id/replay` (REFUND_MANAGE):
  - يعمل فقط على `DEAD_LETTERED`، وإلا **404**؛
  - **سقف** `WEBHOOK_REPLAY_MAX`: بعد استنفاده **409**؛
  - يصفّر `attempts`، يمسح `failure_class`/`first_failed_at`، يضبط `next_attempt_at = now`،
    ويزيد `replay_count`؛
  - يسجّل صف محاولة `REPLAY` + Audit `PAYMENT.WEBHOOK_REPLAY` بهوية المشغّل و`metadata.replayCount`.
  - **لا يُطبّق أي أثر مالي** — التسليم التالي من المزوّد هو من يطبّق.

## 8. Audit trail لكل محاولة

جدول `payment_webhook_attempts` (Migration `0041_flimsy_winter_soldier`):

| العمود | المعنى |
| --- | --- |
| `attempt_number` | رقم المحاولة (0 = replay) |
| `outcome` | `SUCCESS` / `FAILURE` / `STALE` / `REPLAY` |
| `failure_class` | تصنيف الفشل |
| `error_message` | آخر خطأ (مقصوص 2000 حرف) |
| `retry_scheduled` | هل جُدولت محاولة تالية؟ |
| `next_attempt_at` | موعدها |
| `duration_ms` | زمن المحاولة |

التسليمات المكرّرة التي لا تصل إلى مسار التطبيق **ليست محاولات** ولا تُسجَّل (تفادي تضخيم السجل).

## 9. الرؤية الإدارية

| المسار | الصلاحية | الاستجابة |
| --- | --- | --- |
| `GET /api/payments/webhook-failures` | `REFUND_MANAGE` | `items[]` + `meta{total,limit,offset}` — أصبح كل صف يحمل `failureClass`, `nextAttemptAt`, `firstFailedAt`, `replayCount` |
| `GET /api/payments/webhook-failures/:id/attempts` | `REFUND_MANAGE` | سجل المحاولات (بدون payload/توقيع) |
| `POST /api/payments/webhook-failures/:id/replay` | `REFUND_MANAGE` | 200 / 404 / 409 (سقف) |

الواجهة (`/admin/observability` → تبويب `webhooks`) أُضيف لها عمودا **تصنيف الفشل** و**المحاولة القادمة**
وعدّاد `replay ×n`، بمفاتيح i18n في ar/en/fr/zh. لا تُعرض `payload` ولا التوقيع.

## 10. حماية الأموال (بدون أي تغيير في القواعد)

- **لا كاتب جديد لـ`SETTLED`**: `applySettlementConfirmed` وحده، كما كان.
- تأكيد الدفع ما زال لا يكتب `SETTLED` (Payment ≠ Settlement).
- لا تغيير في العمولة/الرسوم/Ledger/Payout/Refund rules.
- لا مزوّد دفع حقيقي مُفعَّل؛ الاختبارات على `manual` + `DEMO_PAYMENT_MODE=true`.
- **لا حلقة خلفية تحرّك المال**: إعادة المحاولة تحدث فقط عند تسليم مزوّد جديد وبعد انقضاء الـbackoff.

## 11. الملفات

**جديدة (3)**
| الملف | الغرض |
| --- | --- |
| `packages/server/src/lib/payments/webhook-retry.ts` | التصنيف + الـbackoff + حدود السياسة (وحدة نقية) |
| `packages/server/tests/unit/webhook-retry-policy.test.ts` | 14 اختبار وحدة |
| `packages/server/tests/obs01-webhook-recovery.test.ts` | 13 اختبار تكامل |

**معدّلة (9)**
| الملف | التغيير |
| --- | --- |
| `packages/server/src/db/schema/payments_extras.ts` | أعمدة `failure_class`/`next_attempt_at`/`claim_token`/`claimed_at`/`first_failed_at`/`replay_count` + جدول `payment_webhook_attempts` + فهرس retry |
| `packages/server/src/db/migrations/0041_flimsy_winter_soldier.sql` (+ snapshot/journal) | Migration إضافية فقط (لا DROP) |
| `packages/server/src/lib/env.ts` | 5 إعدادات OBS-01 |
| `packages/server/src/modules/payments/service.ts` | claim ذرّي، تصنيف، backoff، سجل محاولات، سقف replay |
| `packages/server/src/modules/payments/routes.ts` | مسار `attempts` + معالجة 409 لسقف replay |
| `packages/server/tests/p6-p7-dispute-webhook.test.ts` | اختبارات إعادة المحاولة صارت تُقدّم نافذة الـbackoff (سلوك المزوّد الحقيقي) — نفس التوكيدات |
| `packages/web/src/lib/types.ts` | حقول DTO الجديدة |
| `packages/web/src/pages/AdminObservabilityPage.tsx` | عمودا التصنيف والمحاولة القادمة + عدّاد replay |
| `packages/web/src/lib/i18n.ts` | مفتاحان في 4 لغات |

## 12. الاختبارات والنتائج (تشغيل فعلي)

البيئة: PostgreSQL 17.12 على `127.0.0.1:5434`، قاعدة `wasit_test` فقط، عبر `TEST_DATABASE_URL` الصريح
وحرّاس `tests/test-db-guard.ts` (لا fallback، ولا `DROP` خارج `wasit_test`).

| الحزمة | الأمر | النتيجة |
| --- | --- | --- |
| وحدة السياسة | `vitest run tests/unit/webhook-retry-policy.test.ts` | **14/14 ✅** |
| تكامل OBS-01 | `vitest run tests/obs01-webhook-recovery.test.ts` | **13/13 ✅** |
| تراجع الـwebhooks | `vitest run tests/p6-p7-dispute-webhook.test.ts` | **19/19 ✅** |
| الحزمة الكاملة | `vitest run --no-file-parallelism` | **1873/1873 ✅ (143 ملفًا، 0 متخطّاة، exit 0)** |
| Typecheck (server) | `tsc -p tsconfig.json --noEmit` | **0 أخطاء** |
| Typecheck + Build (web) | `tsc --noEmit` / `vite build` | **0 أخطاء** · 112 module |

الحالات المغطاة في التكامل: تصنيف `TRANSIENT` + جدولة backoff، رفض المحاولة قبل انقضاء النافذة،
نمو المهلة أسيًا، النجاح بعد المحاولة، DLQ فوري لـ`CONFLICT` (محاولة واحدة) + Audit `SYSTEM`،
تطبيق تسليمات متزامنة **مرة واحدة** (5 متزامنة ⇒ نجاح واحد)، حجز الـclaim (`inProgress`) واستلامه بعد
انتهاء المهلة، `STALE` بلا تطبيق، DLQ بعد استنفاد الميزانية، سجل المحاولات والصلاحيات (ADMIN 200 /
SUPPORT 403 / زائر 401 / 404)، سقف replay (200×3 ثم 409) وصفّ `REPLAY` في السجل.

> **شفافية التشغيل:** جرى تشغيل الحزمة الكاملة ثلاث مرات.
> (1) متوازيًا: الملف الوحيد الذي أخفق هو `marketing-video.test.ts` لأن ثنائية `ffmpeg-static` لم تكن
> منزّلة في الحاوية (عيب بيئي سابق، غير مرتبط بـOBS-01)؛ نُزّلت بـ`node node_modules/ffmpeg-static/install.js`.
> (2) متوازيًا بعد ذلك: الملف الوحيد الذي أخفق هو `a1-kill-switch.test.ts` لأنه يحسب صفوف `ai_requests`
> عالميًا فيتأثر بملفات تعمل بالتوازي على القاعدة المشتركة (يمرّ منفردًا **13/13**).
> (3) **تسلسليًا** (`--no-file-parallelism`) — وهو التشغيل المعتمد: **143/143 ملفًا · 1873/1873 اختبارًا ·
> 0 متخطّاة · exit 0**. لا علاقة لأي من الإخفاقين بكود OBS-01.

## 13. المخاطر والقيود المتبقية

1. **الاعتماد على تسليم المزوّد**: حدث `FAILED` لا يُعاد إلا عند تسليم جديد. هذا قرار مقصود (لا محرّك
   خلفي يحرّك المال)، لكنه يعني أن مزوّدًا يتوقف عن التسليم يُبقي الحدث `FAILED` حتى تدخّل المشغّل.
2. **lease 60s**: عملية تُعطَّل بين claim والتطبيق تُتيح إعادة المحاولة بعد 60s؛ لا محاولة تُحتسب في
   هذه الحالة (العداد يزيد عند الفشل المُسجَّل فقط).
3. **`replay_count` سقف تشغيلي** لا حماية تشفيرية: مشغّل يملك `REFUND_MANAGE` يمكنه تعديل الصف يدويًا في
   قاعدة البيانات؛ الحماية الحقيقية هي Audit + المطابقة على مستوى intent.
4. **إعادة تطبيق `applyPaymentSucceeded`** محمية بـ(أ) المطابقة على الحدث، (ب) فحص `intent.status === 'SUCCEEDED'`
   داخل الدالة. لكن الدالة نفسها ليست داخل transaction واحد؛ الحماية من التزامن تأتي من الـclaim.
5. **لا UI لسجل المحاولات** بعد (متاح عبر API)؛ أُبقي النطاق ضيقًا في هذه المهمة.
6. **لم يُشغَّل E2E متصفح** في هذه المهمة (لا حاجة: التغيير خادمي بالدرجة الأولى، وواجهة الأعمدة مبنية).

## 14. ما لم يُفعل (حفاظًا على النطاق)

- لا تغيير في قواعد الأموال/Ledger/Settlement/العمولة.
- لا تفعيل مزوّد دفع حقيقي.
- لا `DROP`/إعادة كتابة بيانات؛ الـMigration إضافية فقط.
- لا عمل على OBS-02 أو أي مهمة أخرى.
