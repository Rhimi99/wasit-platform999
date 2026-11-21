# AI-ARCH-ALIGN-01 — توحيد الهيكل الرسمي للمنظومة الذكية مع المنصة

**التاريخ:** 2026-11-20 · **الفرع:** `master` · **الحالة:** مُنفَّذ ومُتحقَّق منه (بانتظار الاعتماد)

## 1. المشكلة

المنظومة الذكية كانت موزّعة على أربع طبقات بلا تعريف واحد موحّد:

1. `modules/ai/catalogue.ts` — 20 وكيلاً بلا تمييز بين «الوكيل الرسمي» و«الوكيل الوظيفي الداخلي».
2. `modules/ai/executors.ts` — 11 منفّذاً حقيقياً فقط، بلا إعلان صريح عن البقية.
3. `modules/ai/planner.ts` + `dispatcher.ts` — طبقة تنسيق (Copilot) موثّقة كأنها «مواصفة غير منفَّذة».
4. `modules/media/*` — قدرة توليد فيديو تسويقي حقيقية بلا هوية وكيل مقابلة.

النتيجة: الهيكل المُعلن (12 وكيلاً رسمياً) لم يكن موجوداً في الكود كتعريف قابل للفحص، وكان يمكن
للمنسّق أن يخطّط خطوة لوكيل لا يملك منفّذاً ثم تفشل عند الإرسال فقط.

## 2. الهيكل الرسمي (مصدر واحد للحقيقة)

`CORE_SPECIALIST_KEYS` في `packages/server/src/modules/ai/catalogue.ts` هو التعريف الرسمي،
وكل وكيل يحمل `tier` صريحاً:

| # | الوكيل (key) | Tier | منفّذ حقيقي؟ |
| --- | --- | --- | --- |
| 1 | `sales-agent` | CORE_SPECIALIST | نعم |
| 2 | `marketing-agent` | CORE_SPECIALIST | نعم |
| 3 | `ads-agent` | CORE_SPECIALIST | نعم (موافقة بشرية) |
| 4 | `product-agent` | CORE_SPECIALIST | نعم |
| 5 | `support-agent` | CORE_SPECIALIST | نعم |
| 6 | `analytics-agent` | CORE_SPECIALIST | نعم |
| 7 | `market-research-agent` | CORE_SPECIALIST | نعم |
| 8 | `b2b-agent` | CORE_SPECIALIST | نعم |
| 9 | `risk-agent` | CORE_SPECIALIST | نعم (موافقة بشرية) |
| 10 | `dispute-assistant` | CORE_SPECIALIST | نعم (موافقة بشرية) |
| 11 | `development-agent` | CORE_SPECIALIST | نعم (موافقة بشرية) |
| 12 | `marketing-video-agent` | CORE_SPECIALIST | **لا — هوية فقط** |

الوكلاء الداعمون (`SUPPORTING`، ليسوا من الاثني عشر ولا يُعرضون كرسميين):
`finance-agent`, `payment-settlement-agent`, `compliance-agent`, `supplier-agent`,
`merchant-agent`, `customer-intelligence-agent`, `operations-agent`, `outreach-acquisition-agent`.

طبقة الحوكمة (`GOVERNANCE`): `wasit-copilot` (تنسيق) و`agent-supervisor` (رقابة).
لا أحدهما وكيلاً متخصصاً ولا يقبلان إسناد مهام.

`catalogueIntegrity()` يفحص الاتجاهين: كل مفتاح رسمي موجود بـ`CORE_SPECIALIST`، ولا يوجد
`CORE_SPECIALIST` خارج القائمة، ولا مفاتيح مكرّرة، ولا Copilot داخل كتالوج الوكلاء.

## 3. تصنيف الحالة (State taxonomy)

| الحالة | المعنى | كيف تُفحص |
| --- | --- | --- |
| **مُعلن** (declared) | هوية + عقد (مهمة، قدرات، أدوات، حدود، أهداف) | صف في الكتالوج |
| **قابل للتنفيذ** (executable) | يوجد فرع حقيقي في `executeAgentTask` | `executable: true` + `EXECUTABLE_AGENT_KEYS` |
| **مُسجَّل** (registered) | صف في `agent_registry` (هوية لا سلطة) | `ensureAgentRegistrySeeded` |
| **مُوجَّه** (routable) | يقبل خطوة في خطة | `agentRunRefusal(spec) === null` |
| **مُعرَّض** (exposed) | له مسار API/واجهة | `routes.ts` / `admin/ai-routes.ts` |

`executable` هو الخاصية الحاكمة: التسجيل لا يمنح تشغيلاً، والكتالوج لا يمنح تشغيلاً،
والخطة لا تتجاوز `agentRunRefusal`.

## 4. ما تغيّر في الكود

| الملف | التغيير |
| --- | --- |
| `src/lib/ai/types.ts` | `AgentTier` + حقل `tier` في `AgentDefinition` |
| `src/modules/ai/catalogue.ts` | `CORE_SPECIALIST_KEYS` · `coreSpecialistAgents()` · `supportingAgents()` · `governanceAgents()` · `catalogueIntegrity()` · وكيل الفيديو · `video.publish`/`video.render_paid` كإجراءات حساسة |
| `src/modules/ai/planner.ts` | رفض أي خطوة تستهدف وكيلاً غير قابل للتنفيذ **وقت التخطيط** (لا كتابة صف تشغيل) |
| `src/modules/admin/ai-routes.ts` | `POST /api/admin/ai/agent-runs` — إنشاء خطة (PLANNING فقط، بلا إرسال) |

## 5. الحدود التي لم تُكسر

- **لا توسيع صلاحيات**: وكيل الفيديو `permissionsRequired: ['ai:use']` فقط، و`scope: 'own'`.
- **لا مسار تنفيذ جديد**: كل إرسال يبقى عبر `dispatchStep → createAgentTask`.
- **لا تعديل مالي**: لا عمولة، لا محفظة، لا تسوية.
- **لا نشر خارجي**: `video.publish` إجراء حساس يتطلب موافقة بشرية، ولا منفّذ يملكه اليوم.
- **الكتالوج بيانات لا سلوك**: إضافة صف لا تمنح قدرة تنفيذ.

## 6. اختبارات الإثبات

| الملف | العدد | يثبت |
| --- | --- | --- |
| `tests/unit/ai-arch-align.test.ts` | 17 | الاثنا عشر، الـtiers، عدم التكرار، عقد الفيديو، `catalogueIntegrity` |
| `tests/ai-arch-align-copilot.test.ts` | 12 | الخطة عبر HTTP، رفض غير القابل للتنفيذ/المشرف/Copilot، عدم كتابة صف عند الرفض، 403/401، Kill Switch، ثبات `agent_key` عند الإرسال |
| `tests/ai023-dispatch.test.ts` | 22 | مسار الإرسال والفشل والتعاقب بعد تشديد المخطِّط |
| `tests/ai0231-reliability.test.ts` | 16 | تعافي التشغيل وإغلاقه بعد التشديد |

## 7. فجوات مُعلنة (ليست تنفيذاً ناقصاً مخفياً)

1. **منفّذ وكيل الفيديو غير موجود**: القدرة الفعلية موجودة في `modules/media/*` (رندر + تخزين خاص +
   روابط موقّعة) ويشغّلها صاحب الحساب عبر API الوسائط. ربطها كمنفّذ وكيل يحتاج قراراً تجارياً
   (حدود تكلفة، ملكية الأصول، الموافقة على النشر) — مسجّل كـ`DECISION REQUIRED` في AD-049.
2. **Copilot لا يفكّك الأهداف**: الخطة تأتي من المتصل كخطوات؛ لا يوجد LLM Planner.
3. **اختيار الوكيل ليس آلياً**: الاختيار قرار المتصل؛ الكود يتحقق من الأهلية فقط.
4. **لا واجهة ويب للتنسيق**: المسار الإداري متاح، والواجهة لم تُبنَ.

## 8. إعادة الإنتاج

```bash
cd packages/server
npx tsc --noEmit                      # 0
TEST_DATABASE_URL=...wasit_test npx vitest run tests/unit/ai-arch-align.test.ts tests/ai-arch-align-copilot.test.ts
```
