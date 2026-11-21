# AI-AGENT-MERGE-01 — دمج الاختصاصات وتطوير منظومة WASIT AI

**الحالة:** مُنفَّذ ومُتحقَّق · **التاريخ:** 2026-11-20 · **القرار:** AD-050
**النطاق:** `packages/server/src/modules/ai/{catalogue,agent-scope,executors}.ts` + الاختبارات + الوثائق

## 1. قيود المدير العام (عقد غير قابل للتفاوض)

| القيد | كيف يُفرض في الكود | الاختبار |
| --- | --- | --- |
| لا استبدال أي وكيل | المفاتيح الـ21 كما هي، والمفاتيح الرسمية الاثنا عشر في `CORE_SPECIALIST_KEYS` بلا تغيير | `unit/ai-agent-merge-01` §identity |
| لا حذف أي وكيل | `AGENT_CATALOGUE` = 21 وكيلاً قبل وبعد | نفسه |
| لا فقدان وظيفة أو ذاكرة أو سجل أو مهمة | لا حذف جدول ولا عمود؛ `taskTypes` القديمة محفوظة (`outreach.run_cycle`, `finance.reconcile`, `dev.plan_change`)؛ `agent_tasks`/`agent_runs`/`agent_run_steps` تُقرأ ولا تُمسح | `ai-agent-merge-01` (تكامل) |
| دمج الاختصاصات المتداخلة | ثلاث هويات أُعيد توجيهها دون تغيير المفتاح | §2 |
| تطوير الوكلاء الموجودين | ثلاثة منفّذين جديدين على بيانات حقيقية | §3 |
| الحفاظ على الهيكل الرسمي | 12 CORE + 8 داعمين + طبقة حوكمة | `unit/ai-arch-align` |

**الأرقام:** الوكلاء 21 (بلا تغيير) · القابلون للتنفيذ 11 → **13** · غير القابلين 10 → 8 (منهم المشرف).

## 2. خريطة الدمج (قبل → بعد)

| المفتاح (ثابت) | قبل | بعد | لماذا ليس وكيلاً جديداً |
| --- | --- | --- | --- |
| `outreach-acquisition-agent` | Outreach & Acquisition | **Global Growth & Acquisition** | نفس الجمهور ونفس البيانات (موردون/تجار/شركات/منتجات)؛ التوسع العالمي هو تعميم للاستقطاب لا اختصاص مختلف |
| `finance-agent` | Finance (تلخيص) | **Finance & Cost Accounting** | نفس المجال المالي؛ أُضيف حساب التكلفة والمساهمة بدل إنشاء وكيل محاسبة ثانٍ |
| `development-agent` | Development (خطط) | **Platform Maintenance & Repair** | نفس الاختصاص الهندسي؛ أُضيف التشخيص والإصلاح بدل وكيل «صيانة» منفصل |
| `marketing-video-agent` | مُعلن فقط | مُعلن فقط (بلا تغيير) | الإنتاج يعمل في `lib/media/*`؛ الربط يحتاج قرارات GM (AD-049) |

لم تُدمج أي هوية **داخل** أخرى: لا وكيل اختفى، ولا اختصاص انتقل بين وكيلين.

## 3. ما صار كل وكيل يفعله فعلاً

### 3.1 Global Growth & Acquisition Agent (`outreach-acquisition-agent`)

- **المنفّذ:** `execGrowthAgent` — إجراء `discover_markets`.
- **يقرأ:** `countries`, `suppliers`, `merchants`, `companies`, `products`, `categories` (عبر عقد A2).
- **ينتج:** ترتيب أسواق (نقاط من العمق التوريدي + عمق الكتالوج)، أولويات `EXPAND`/`SEED`/`MONITOR`،
  فرص مؤهلة مع دليل رقمي، شرائح (فئات) بعدد المنتجات المنشورة، ومسودات رسائل بثلاث لغات (`DRAFT_ONLY`).
- **لا يفعل:** لا إرسال، لا حملات مدفوعة، لا شراء بيانات. `outreach.send` و`growth.paid_campaign`
  في `approvalActions` ومضافتان إلى `SENSITIVE_ACTIONS`، **ولا يوجد منفّذ لهما إطلاقاً**.
- **البوابة:** `requiresHumanApproval: true` — المهمة تبقى `awaiting_approval` حتى يوافق GM آخر.

### 3.2 Finance & Cost Accounting Agent (`finance-agent`)

- **المنفّذ:** `execFinanceAgent` — إجراء `report_pnl`.
- **يقرأ:** `orders` (العمولة ورسوم الدفع المسجّلة على كل طلب)، `campaigns` (الإنفاق)، `ai_requests` (التكلفة الفعلية).
- **ينتج:** إيراد لكل عملة (GMV، عمولة، رسوم، مستحقة مقابل محصّلة مقابل مسوّاة)، تكلفة AI لكل نوع طلب
  ولكل وكيل (`AGENT:<key>`)، إنفاق إعلاني، ومساهمة محسوبة أو `null` مع سبب.
- **قاعدة صارمة:** لا خلط عملات. إن غابت تكلفة بعملة الإيراد تُعاد `value: null` و`reason: COST_DATA_MISSING`،
  ولا يُختلق رقم. كل سطر يحمل `source` و`estimated`.
- **لا يفعل:** لا يقرأ `transaction_ledger` ولا `commission_policies` (محجوبان عن كل الوكلاء)،
  ولا يحرّك أموالاً: `finance.payout`/`finance.refund`/`commission.change` إعلانات فقط بلا منفّذ.
- **البوابة:** `requiresHumanApproval: false` لأن كل قدرة قراءة بحتة، والعقد `readOnly: true`.

### 3.3 Platform Maintenance & Repair Agent (`development-agent`)

- **المنفّذ:** `execDevelopmentAgent` — إجراء `diagnose_platform`.
- **يقرأ:** `agent_tasks`, `agent_runs`, `agent_run_steps` (حالة طبقة الوكلاء) + عدّادات المنصة.
- **ينتج:** `health` (نسبة الفشل، تعثّر >30 دقيقة، خطوات فاشلة/تُعاد)، `findings` مرتّبة بالخطورة مع دليل
  و`repairProtocol` (لا تعديل، لا موافقة ذاتية، تسليم = diff + tests + report).
- **لا يفعل:** لا يعدّل ملفات ولا قاعدة بيانات. `code.apply_patch` و`code.merge` (و`prod.deploy`/`prod.migrate`)
  في `approvalActions` ومضافة إلى `SENSITIVE_ACTIONS`، **ولا منفّذ لها**.
- **البوابة:** التشخيص تلقائي (`requiresHumanApproval: false`)، والإصلاح مستحيل بلا GM.

## 4. الضوابط (لم تُوسَّع أي سلطة)

| الضابط | الحالة |
| --- | --- |
| الصلاحيات | `permissionsRequired` لم يتغيّر لأي وكيل (تحقّق آلي بمقارنة snapshot) |
| عقد النطاق A2 | 13 عقداً = 13 وكيلاً قابلاً للتنفيذ؛ المالية بلا ledger/policies، والنمو بلا جداول داخلية |
| الجداول المحجوبة | `transaction_ledger`, `commission_policies`, `audit_logs`, `alert_events`, `payouts`, `users`… تبقى مرفوضة |
| Tool Gateway | `allowedTools` للمالية لم تعد تعلن `finance.read_ledger` (أداة غير قابلة للخدمة) |
| الأفعال الحساسة | أُضيفت `code.apply_patch`, `code.merge`, `growth.paid_campaign` |
| الموافقة الذاتية | ممنوعة كما هي؛ الاختبار يعتمد موافقة SUPER_ADMIN آخر |

## 5. الاختبارات

| الملف | الحالات | يثبت |
| --- | --- | --- |
| `tests/unit/ai-agent-merge-01.test.ts` | 14 | الهوية، الأثمان، الصلاحيات، بوابات الموافقة، عقود النطاق، منع الأفعال غير المعلنة |
| `tests/ai-agent-merge-01.test.ts` | 5 | تشغيل حقيقي على PostgreSQL: النمو يرتّب أسواقاً حقيقية ولا يرسل؛ المالية تطابق استعلاماً مستقلاً؛ الصيانة ترى فشلاً حقيقياً ولا تغيّر شيئاً |
| `tests/unit/ai-reg01-agent-layer.test.ts` | محدّث | 13 قابلاً للتنفيذ، 7 معلنة فقط |
| `tests/ai-reg01-agent-layer.test.ts` | محدّث | نفس الشيء عبر HTTP (`counts`) |
| `tests/phase14-agents.test.ts` | محدّث | قائمة المنفّذين الـ13 |
| `tests/r1-agent-catalogue.test.ts` | محدّث | لا وكيل معلن بلا عقد، ولا وكيل قابل للتنفيذ بلا عقد |
| `tests/a2-agent-scope.test.ts` | محدّث | السجل الحيّ يغطي كل عقد (زرع صريح، لا اعتماد على ترتيب الملفات) |
| `tests/r2-tool-gateway.test.ts` | محدّث | ثابت «الأداة غير المربوطة لا تُمنح» على وكيل التسوية |

## 6. ما لم يُنفَّذ عن قصد

- **إرسال خارجي**: لا بريد/SMS/واتساب، ولا شراء حملات. يحتاج قرار GM (قناة، هوية، سقف، إلغاء اشتراك).
- **تعديل الكود آلياً**: `apply_patch` بلا منفّذ. يحتاج قرار GM (فرع، مراجعة، CI، تراجع).
- **قراءة الـledger**: محجوبة بنيوياً؛ المحاسبة تُبنى من `orders` التي تحمل العمولة المسجّلة.
- **ربط وكيل الفيديو**: كما هو في AD-049 (سقف تكلفة، ملكية أصول، سياسة نشر).

القرارات المفتوحة مسجّلة في `docs/ARCHITECTURE_DECISIONS.md` (AD-050) و`docs/GAP_REGISTER.md` (§30).
