# GAP REGISTER — WASIT BUSINESS GLOBAL

> **سجل متابعة مركزي موحّد.** يدمج `MASTER_GAP_AUDIT.md` و`PRODUCTION_GAP_LIST.md`
> و`PERMISSIONS_MATRIX.md` و`UI_SCREEN_MAP.md`، ويتحقّق من كل بند مقابل **الكود الفعلي**
> لا مقابل الوثائق. كل صف مُعاد التحقق منه بتاريخ 2026-11-04.
>
> **الأساس**: فرع `master` عند `e43dee4017d2848e37d03d13025a33890adb483f`.
>
> **قاعدة الإغلاق**: لا يُغلق أي بند إلا بدليل من الكود **و** اختبار ناجح يُثبته.
> وجود واجهة أو صلاحية في RBAC أو ملف Backend **لا يكفي** لإغلاق بند.
>
> **تحديث DOC-GAP-01 (2026-11-05):** تصحيح وتوحيد الأرقام (خطوط أساس الاختبارات، عدد الفجوات المفتوحة/المغلقة، مواءمة أرقام الصلاحيات 50/60). **توثيقي بحت**: لا كود، لا اختبارات، ولا تغيير لأي حالة فجوة. التفاصيل في **§10**.
>
> **إغلاق M1.9.0-A2 (DOC-A2-CLOSE — 2026-11-07):** إغلاق مهمة التحقّق الحيّ المعزول لسلسلة الترحيلات 0029–0036 بوصفها **CLOSED / VERIFIED**، مع تسجيل **حدود الإثبات** بدقّة. **لا تغيير في حالة أي فجوة قائمة** (لا كود، لا Migration، لا Schema، لا Snapshot). أُضيفت **فجوتان جديدتان مفتوحتان** (`GAP-A2-01` و`GAP-A2-02`) في **§11**، فارتفعت «المفتوحة» **22 → 24** وبقيت «المغلقة» **25**. التفاصيل في **§11** و`docs/M1.9.0-A1_MIGRATION_CHAIN.md` §9.

### خطوط أساس الاختبارات (متعدّدة المصادر — لا تُخلط)

| # | القيمة | المصدر | الطريقة | الطبيعة |
| --- | --- | --- | --- | --- |
| A | 69 ملف / **780** اختبار | هذا السجل §9 (2026-11-04) | تشغيل حيّ على Postgres 16 | **تاريخي** — تحقّق حيّ وقت الإعداد |
| B | **73** ملف / **843** حالة | عدّ نصّي (DOC-GAP-01، 2026-11-05) | `grep -rhoE "\b(it\|test)\(" packages/server/tests` (62 في `tests/` + 11 في `tests/unit/`) | **عدّ من الملفات** — لا يعني النجاح |
| C | **852** اختبار ناجح / 73 ملف | تشغيل PERM-01C (2026-11-04) | `vitest run` على الحزمة الكاملة | **تاريخي** — تشغيل فعلي |
| D | 784 / 796 / 814 / 829 / **852** | سجل التنفيذ §9 (SEC-01/02 → PERM-01C) | تشغيلات متتالية على Postgres 16 | **تاريخي** — كل رقم للحزمة عند تلك المهمة |

> **فارق B مقابل C (843 مقابل 852):** `843` عدّ نصّي لأنماط `it()/test()` في الملفات (بما فيها الحالات المُولَّدة داخل `describe`)، بينما `852` عدد الاختبارات التي **نفّذها** `vitest` فعلاً (يشمل توسيع `it.each` وعدّ حالات إضافية). كلاهما صحيح **بمصدرين مختلفين**؛ لا يُستبدل أحدهما بالآخر. **لم يُعَد تشغيل أي اختبار في DOC-GAP-01.**
>
> **NOT_VERIFIED / HISTORICAL_EVIDENCE_ONLY:** كل نتائج النجاح أعلاه (A, C, D) تاريخية من جلسات سابقة، ولم تُعَد في DOC-GAP-01.

الحالات: `PENDING` · `IN_PROGRESS` · `BLOCKED` · `COMPLETED`
الخطورة: `CRITICAL` · `HIGH` · `MEDIUM` · `LOW` — الأولوية: `P0` · `P1` · `P2` · `P3`

---

## 1. ملخّص الوضع

| المحور | العدد |
| --- | --- |
| بنود مفتوحة (PENDING/BLOCKED/IN_PROGRESS + GAP-A2-01/02) | 19 |
| بنود مُغلقة فعلياً (COMPLETED/COMPLETE_VERIFIED) | 43 |
| فجوات كاذبة مُستبعدة | 6 |
| بنود تحتاج طرفاً خارجياً (عقود/بنية) | 10 |
| بنود في السجل المرجعي بلا صف تفصيلي هنا (`LC-08`) | 1 |

> **تصحيح عدّ (WASIT-EXECUTION-012.1 — 2026-11-08):** أُعيد حساب الأعداد **من صفوف الفجوات الفعلية** (§2–§5 + §6 + §11 + §12)، فتبيّن أن العدّاد السابق (18 مفتوحة / 30 مغلقة) كان **متأخّراً عن السجل**. الأرقام الصحيحة: **المفتوحة = 21** و**المغلقة = 32** (المجموع 53 معرّفاً مميّزاً). التسوية:
> - **`SEC-011.4`** أُضيف `COMPLETE_VERIFIED` في §12 دون تحديث العدّاد ⇒ المغلقة +1.
> - **`SEC-XFF-01`** كان يُحتسب خطأً ضمن «المفتوحة» رغم كونه مغلقاً ⇒ المفتوحة −1.
> - **`SEC-03`** مغلق في §2 لكنه كان **غائباً من §6** ⇒ (أُضيف الآن إلى §6؛ لا أثر على الإجمالي).
> - جدول §6 يحوي فعلياً **33** صفاً = **31** معرّفاً مميّزاً (لا 30 كما في الترويسة؛ `PS-01`/`PS-02` لهما صفّان: نجمة وخلفية)، منها **14** معرّفاً **غير موجود** في §2–§5 (`PERM-01A-UI`, `PERM-01B-UI`, `PERM-01C`, `PS-04*`, `B1/B2/B7/B10/B12/B14`, `C1/C2/C4/C5`) ⇒ المغلقة +14 فوق §2–§5.
> - الحساب: مغلقة §2–§5 = **17** + مغلقة §6 حصراً = **14** + `SEC-011.4` = **32**؛ مفتوحة §2–§5 = **19** + `GAP-A2-01/02` = **21**.
> **لم تُغيَّر أي حالة فجوة بهذا التصحيح (توثيقي بحت).**

> **تحديث DOC-A2-CLOSE (2026-11-07):** «المفتوحة» **22 → 24** بإضافة فجوتي التحقّق `GAP-A2-01`
> و`GAP-A2-02` (انظر §11). «المغلقة» تبقى **25** (لم تُغلق أي فجوة قائمة). «الخارجية» تبقى **10**.

> **فصل `LC-08` عن `SEC-XFF-01` (WASIT-EXECUTION-012.1 — 2026-11-08):** `LC-08` (من `MASTER_GAP_AUDIT.md`) هو فجوة **وثائق امتثال (DPA/PCI/compliance)** وليست فجوة أمنية للـproxy. كان `SEC-XFF-01` موسوماً خطأً بـ`(LC-08)` في §2/§9؛ أُزيل الوسم. **`LC-08` تبقى مفتوحة/غير مُغلقة** (لا دليل خاص بها في هذا السجل؛ لم تُغيَّر حالتها). `SEC-XFF-01` مغلقة بأدلّتها الخاصة (`client-ip.test.ts` 32/32) — الإغلاق لا يُنسب إلى `LC-08`.

> **إغلاق LC-06 (WASIT-EXECUTION-003 — 2026-11-07):** صف LC-06 في §5 انتقل من **`PENDING`** إلى **`COMPLETE_VERIFIED`** بعد نجاح التحقق المتكامل فعلياً على PostgreSQL مؤقتة معزولة. لأن الصف كان مُحتسباً ضمن «المفتوحة»، فإن **«المفتوحة» تنخفض 23 → 22** و**«المغلقة» ترتفع 25 → 26**. (كان قد سبق ذلك إغلاق مرحلي `IMPLEMENTED` بعد التوسيع، ثم أُكمل التحقق هنا.) لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-06).

> **تنفيذ LC-07 دون إغلاق (WASIT-EXECUTION-004 — 2026-11-07):** صف LC-07 في §5 انتقل من **`PENDING`** إلى **`IMPLEMENTED_UNVERIFIED`** (تنفيذ كامل + اختبارات بلا DB ناجحة، لكن التحقق المتكامل يحتاج PostgreSQL ولم يُشغَّل بلا إذن). **الأثر على العدّ:** يبقى LC-07 **محتسباً ضمن «المفتوحة»** (تعريف «المفتوحة» صار `PENDING/BLOCKED/IMPLEMENTED_UNVERIFIED` + فجوتَي A2) → **«المفتوحة» تبقى 22** و**«المغلقة» تبقى 26**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-07).

> **مراجعة LC-07 الأمنية (WASIT-EXECUTION-004.1 — 2026-11-07):** مراجعة مركّزة بلا DB/Docker/Git. أُصلحت 3 نقاط: (1) تصفير `failed_login_attempts` صار **بعد اكتمال المصادقة كاملة** لا عند صحة كلمة المرور؛ (2) حماية MFA صارت مستقلة (عدّاد التحدّي ذرّي، وفشل TOTP لا يمسّ عدّاد كلمة المرور)؛ (3) موازنة زمن الاستجابة (مسار «حساب غير موجود/مقفل» كان ~0ms بينما كلمة المرور الخاطئة ~25ms، والهاش الوهمي كان `m=65536` ~114ms مقابل `m=19456` ~25ms) عبر `DUMMY_ARGON2_HASH` بمعاملات مطابقة + قياس مُعلن. **الأثر على العدّ:** بلا تغيير (LC-07 تبقى مفتوحة، 22/26). التفاصيل: §5 (صف LC-07) و§9.

> **إغلاق LC-07 (WASIT-EXECUTION-004.2 — 2026-11-07):** صف LC-07 في §5 انتقل من **`IMPLEMENTED_UNVERIFIED`** إلى **`COMPLETE_VERIFIED`** بعد نجاح التحقق المتكامل فعلياً على PostgreSQL مؤقتة معزولة: `tests/account-lockout.test.ts` **19/19** ✅ + الحزمة الكاملة للخادم **1161/1161** (96 ملف) ✅ + `tests/unit` **90/90** ✅ + `staff-mfa-enforcement`(17)/`staff-mfa-login`(13)/`mfa-login-challenge`(10)/`csrf`(17)/`secret-scan`(3) ✅ + TypeScript (server+web) نظيف ✅. لأن الصف كان مُحتسباً ضمن «المفتوحة»، فإن **«المفتوحة» تنخفض 22 → 21** و**«المغلقة» ترتفع 26 → 27**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-07) و§6 و§9.

> **إغلاق SEC-CSRF-01 (WASIT-EXECUTION-005 — 2026-11-07):** صف SEC-CSRF-01 في §2 انتقل من **`IMPLEMENTED`** إلى **`COMPLETE_VERIFIED`** بعد التحقق المعزول (بلا DB/Docker): `tests/csrf.test.ts` **21/21** ✅ + `tests/cors.test.ts` **4/4** ✅ + `secret-scan.test.ts` **3/3** + `staff-mfa-enforcement.test.ts` **17/17** (تراجع) ✅ + TypeScript (server+web) نظيف ✅. غُطّيت حالات الفحص الـ12 المطلوبة، ومنها ما كان ناقصاً: كل الطرق الأربع (PUT)، فرض وضع `auto` الافتراضي في production عبر التطبيق الحقيقي، عدم استثناء المسارات الحسّاسة، وترتيب CORS→CSRF→routes. **الملاحظة:** هذه الفجوة لم تكن مُدرجة بالاسم في تفصيل عدّ «المفتوحة»، لكنها كانت هي البند الإضافي المُحتسب (كانت «المفتوحة» 21 = 20 بنداً مُدرجاً + SEC-CSRF-01). لأنها كانت محتسبة ضمن «المفتوحة»، فإن **«المفتوحة» تنخفض 21 → 20** و**«المغلقة» ترتفع 27 → 28**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §2 (صف SEC-CSRF-01) و§6 و§9.

> **إغلاق PERM-01 (WASIT-EXECUTION-006 — 2026-11-07):** صف PERM-01 (المتبقّي) في §2 انتقل إلى **`COMPLETE_VERIFIED`** بعد حسم السؤالين بقرار «أقل صلاحية» موثّق ومُختبَر (معزول بلا DB): **`revenue:read` → لا يُمنح لـADMIN** (المنع هو السياسة المقصودة والمُوثَّقة والمُتحقَّقة حياً: `docs/management/guide.html` §8 يثبت أن `/api/revenue/report` يردّ ADMIN بـ403 وSUPER_ADMIN بـ200، وأن الفرق الحقيقي ADMIN↔SUPER_ADMIN هو بالضبط `/api/revenue/*`؛ ولا واجهة لهذا المسار). **`report:read` → ليست فجوة**: لا مسار يستخدمها، ومكتب التقارير (`/api/admin/analytics/reports`) محروس عمداً بـ`admin:reports` الذي يملكه ADMIN (PERM-01C R2)؛ تُوثَّق كصلاحية «ميتة/مُسمّاة خطأً» (قرار إزالتها مهمة تنظيف منفصلة). **لا تغيير صلاحيات ولا كود إنتاج.** الاختبارات: `tests/perm01-admin-revenue-report.test.ts` **17/17** ✅ (معزول بلا DB) + تراجع csrf(21)/cors(4)/secret-scan(3)/staff-mfa-enforcement(17) + Typecheck (server+web) نظيف. **الأثر على العدّ:** PERM-01 كانت مُدرجة ضمن «المفتوحة» (كانت 20)، فإن **«المفتوحة» تنخفض 20 → 19** و**«المغلقة» ترتفع 28 → 29**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §2 (صف PERM-01) و§6 و§9.

> **إغلاق LC-02 (WASIT-EXECUTION-007 → 007.3 — 2026-11-07):** نُفِّذت واجهة موافقة الكوكيز كاملة + **بوّابة فعلية** على التتبّع التسويقي (`AdSlot`)، ثم أُغلقت بعد تحقّق متصفّح حقيقي كامل. كشف E2E في 007.2 عيباً (سحب `marketing` لا يحذف `wasit.adSession` من sessionStorage لأن `persist()` كان يمرّر localStorage فقط)، وأُصلح في 007.3 بتمرير `getSessionStorage()` أيضاً إلى `applyConsentTransition` — **بإثبات الضرورة** (الحالة الثامنة تفشل بلا الإصلاح وتنجح معه). **الأدلة:** 34/34 اختبار وحدة معزول (بلا DB/DOM) + Typecheck + Build ✅ + **E2E متصفّح بلا DB 8/8** (`playwright.cookie.config.ts`، بلا PostgreSQL/Docker/DEMO). الجزء القانوني (نصّ سياسة الكوكيز/الأساس القانوني) يبقى **اعتماداً خارجياً مفتوحاً تحت LC-01**، ولا يُدَّعى امتثال قانوني كامل. **الأثر على العدّ:** LC-02 كانت ضمن «المفتوحة» → **«المفتوحة» تنخفض 19 → 18** و**«المغلقة» ترتفع 29 → 30**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-02) و§6 و§9 و`docs/LC-02_COOKIE_CONSENT.md`.

> **تنفيذ LC-03 دون إغلاق (WASIT-EXECUTION-008 — 2026-11-07):** صف LC-03 في §5 انتقل من **`PENDING`** إلى **`IMPLEMENTED_UNVERIFIED`**. نُفِّذ مصنّف سلع محظورة/مقيّدة مركزي (`lib/prohibited-goods.ts`) + نقطة إنفاذ واحدة في الخدمة (`enforceListingPolicy` داخل `createProduct`/`updateProduct`/`updateProductStatus`) + بوّابة مراجعة بشرية (`catalog:compliance:review`) — **بلا Migration** (العلامة في `products.tags` غير المستخدَم + `audit_logs`). **الأدلة المُشغَّلة:** `tests/lc03-{prohibited-goods-policy,enforcement,review-authorization}.test.ts` **26/26 ✅** معزولة بلا DB/Docker (مصنّف صرف + خدمة حقيقية على `DB` وهمي + RBAC) + Typecheck (server+web) نظيف. **غير مُشغَّل:** `tests/lc03-prohibited-goods.test.ts` (4 حالات HTTP حقيقية على PostgreSQL) — لم يُشغَّل لعدم توفّر PostgreSQL/Docker وبلا تصريح. **الأثر على العدّ:** يبقى LC-03 **محتسباً ضمن «المفتوحة»** (تعريفها يشمل `IMPLEMENTED_UNVERIFIED`) → **«المفتوحة» تبقى 18** و**«المغلقة» تبقى 30**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-03) و§9 و`docs/LC-03_PROHIBITED_GOODS.md`.

> **إغلاق LC-03 (WASIT-EXECUTION-008.1 — 2026-11-07):** صف LC-03 في §5 انتقل من **`IMPLEMENTED_UNVERIFIED`** إلى **`COMPLETE_VERIFIED`** بعد نجاح التحقق المتكامل فعلياً على **PostgreSQL 16 مؤقتة معزولة** (`wasit-lc03-pg`، `postgres:16-alpine`، منفذ loopback `127.0.0.1:55433` فقط، قاعدة `wasit_test` فارغة، بيانات اصطناعية، بلا اتصال بـ DEMO/production — لا شيء على 5432). **الأدلة:** `tests/lc03-prohibited-goods.test.ts` **4/4 ✅** (رفض المحظور عبر HTTP بلا إدراج + حفظ المقيّد كمسودّة غير منشورة + منع النشر دون مراجعة مخوّلة + نجاح قرار المراجعة البشرية) + `tests/lc03-{prohibited-goods-policy,enforcement,review-authorization}.test.ts` **26/26 ✅** (بلا DB، بلا Regression) + TypeScript (server+web) نظيف ✅. ثم **حُذفت** الحاوية والصورة والـvolume والـdaemon المؤقت ومجلداته؛ لا موارد متبقّية، ولا شيء على 5432، وDEMO/production لم تُلمسا. **M0:** أُعيد حساب `sha256(repo.bundle)` فعلياً = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، العدّات قبل/بعد متطابقة (78/71/0). **الأثر على العدّ:** LC-03 كانت مُحتسبة ضمن «المفتوحة» → **«المفتوحة» تنخفض 19 → 18** و**«المغلقة» ترتفع 29 → 30**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-03) و§6 و§9 و`docs/LC-03_PROHIBITED_GOODS.md`.

> **جاهزية LC-01 التقنية دون إغلاق (WASIT-EXECUTION-010 — 2026-11-07):** نُفِّذت البنية التقنية لوثائق LC-01 (كتالوج 9 وثائق بحالة `LEGAL_REVIEW_REQUIRED` وإصدارات · تسجيل موافقة **على إصدار** · أسطح عامة للمنشور فقط · سطح موافقات المستخدم · صفحة `/legal` ورابط التذييل · **حق التصحيح**). **الأدلة:** `packages/server/tests/lc01-legal-framework.test.ts` **18/18 ✅** (تكامل HTTP+DB: عدم كشف المسودّة 404، رفض الإقرار على غير المنشور 409، تثبيت الإصدار + تدقيق + سجل موافقة، إعادة الطلب عند رفع الإصدار، التصحيح + منع تغيير البريد/التحقّق، فصل الموافقات) + الحزمة الكاملة للخادم **1267/1267 ✅** (107 ملف) + الويب **35/35 ✅** (3 ملفات) + Typecheck (server+web) نظيف. **بلا Migration** (يُعاد استخدام `consents`/`consent_events`/`audit_logs`). **الأثر على العدّ:** LC-01 تبقى **مفتوحة** لأن جوهر الفجوة (النصّ القانوني **المنشور والمعتمد**) لم يُنجَز — لا يجوز اختراع نصّ قانوني ولا ادّعاء امتثال. ⇒ **«المفتوحة» تبقى 18** و**«المغلقة» تبقى 30**، ولا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §5 (صف LC-01) و§9 و`docs/legal/`.

> **إغلاق PR-05 (WASIT-EXECUTION-014 — 2026-11-03):** صف PR-05 في §4 انتقل من **`PENDING`** إلى **`COMPLETE_VERIFIED`**. نُفِّذت صفحة الحاسبة على `/tools/calculator` + منطق صرف معزول `lib/business-calculator.ts` يعكس نموذج رسوم الطلب (عمولة البائع والمشتري على المجموع، رسوم الدفع على البائع، `sellerNet = المجموع − عمولة البائع − رسوم الدفع`، `buyerTotal = المجموع + عمولة المشتري`)، بنسب افتراضية قابلة للتعديل وموسومة كسياسة القاعدة (لا ادّعاء بأنها السياسة الحيّة). **الأدلة:** `packages/web/tests/business-calculator.test.ts` **10/10** معزول (بلا DB/DOM: نموذج المال + الرفض + عقد الترجمة) + `e2e/business-calculator.spec.ts` **4/4** متصفّح حقيقي بلا DB (`playwright.tools.config.ts`) + Typecheck الويب نظيف + Build ناجح. **بلا Migration/Seed/DB، بلا تغيير على أي مسار قائم.** **الأثر على العدّ:** PR-05 كانت ضمن «المفتوحة» → **«المفتوحة» تنخفض 21 → 20** و**«المغلقة» ترتفع 32 → 33**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10).

> **دمج سلسلة M2 (الطلبات الفرعية/المدفوعات/الاسترداد) في العدّاد (M2.4-CLOSE — 2026-11-16):** سلسلة **M2** (§13–§19) كانت مُوثَّقة بصفوفها وأدلّتها في هذا السجل لكنها **لم تكن مُحتسبة في جدول §1** (خلاف §11/§12 اللذين أُدرجا). أُدرجت الآن **صراحةً** لتطابق العدّاد الحالات الفعلية. البنود المغلقة المُضافة = **5**: `M2.1-CANCEL-INV`, `M2.1-PARENT-STATUS` (كلاهما `COMPLETE_VERIFIED` في §13)، `M2.2-PAYOUT-SUBORDER` (§14)، `M2.3-SUBORDER-SETTLEMENT` (§15)، و**`M2.4-REFUND-SUBORDER` (§16–§19 — أُغلق في هذه الجولة)**. البند المفتوح المُضاف = **1**: `M2.5-TX-SELLER-ATTRIBUTION` (§13، `OPEN`). ⇒ **«المغلقة» 33 → 38** و**«المفتوحة» 20 → 21**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). لا صف فجوة قديم حُذف أو غُيِّر.

> **إغلاق M2.5-TX-SELLER-ATTRIBUTION (M2.5-T3 — 2026-11-16):** الصف في §13 انتقل من **`IN_PROGRESS`** إلى **`CLOSED`** بعد اكتمال T1 (تصميم) + T2 (تنفيذ طبقة الإسناد + 14/14) + T3 (تدقيق اتساق حالة الدفع + 4 اختبارات إضافية ⇒ 18/18). البند كان **مُحتسباً ضمن «المفتوحة»** ⇒ **«المفتوحة» تنخفض 21 → 20** و**«المغلقة» ترتفع 38 → 39**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10). التفاصيل: §13 (الصف) و§22 (سجل الإغلاق).

**تفصيل العدّ (تحقّق آلي، محدّث M2.5-T3 — 2026-11-16):**

- **المفتوحة = 20:** P0 → 2 (PS-03, PS-06) · P1 → 4 (AI-02 `IN_PROGRESS`؛ AI-03, AI-04, AI-05) · P2 → 6 (PR-01, PR-02, PR-03, PR-06, PR-10, PR-11) · P3 → 6 (LC-01, LC-04, LC-05, PI-03, PI-05, PI-09) · فجوتا التحقّق → 2 (GAP-A2-01, GAP-A2-02). (المجموع 2+4+6+6+2 = **20**.) منها **5 `BLOCKED`**: PS-03, PS-06, LC-01, LC-05, PI-03.
  > **`LC-04`** تُحتسب **مرّة واحدة** هنا (صياغتها القانونية مفتوحة) رغم أن **تكاملها المالي `COMPLETE_VERIFIED`**؛ لذلك لا تُحتسب في «المغلقة» تجنّباً للعدّ المزدوج.
  > **سلسلة M2 (§13–§19):** صارت مُدرجة في العدّاد صراحةً اعتباراً من M2.4-CLOSE — مغلقة (4): `M2.1-CANCEL-INV`, `M2.1-PARENT-STATUS`, `M2.2-PAYOUT-SUBORDER`, `M2.3-SUBORDER-SETTLEMENT`؛ مفتوحة (1): `M2.5-TX-SELLER-ATTRIBUTION` (أُغلقت في M2.5-T3 — انظر §22).
- **المغلقة = 41:** §2 (12) — SEC-01, SEC-02, **SEC-03**, SEC-04B, **SEC-XFF-01**, PERM-01A, PERM-01B, **PERM-01 (المتبقّي: سياسة `revenue:read`/`report:read` لـADMIN)**, **SEC-CSRF-01**, PS-01, PS-02, OBS-01 · §3 (3) — AI-01, AI-06, AI-07 · §4 (1) — **PR-05** · §5 (4) — LC-02, LC-03, LC-06, LC-07 · §6 حصراً (14) — PERM-01A-UI, PERM-01B-UI, PERM-01C, `PS-04*`, B1, B2, B7, B10, B12, B14, C1, C2, C4, C5 · §12 (1) — **SEC-011.4** · **سلسلة M2 (6)** — `M2.1-CANCEL-INV`, `M2.1-PARENT-STATUS`, `M2.2-PAYOUT-SUBORDER`, `M2.3-SUBORDER-SETTLEMENT`, `M2.4-REFUND-SUBORDER` (§13–§20)، **`M2.5-TX-SELLER-ATTRIBUTION`** (§13 + §21–§22). (المجموع 12+3+1+4+14+1+6 = **41**.)
- **الفجوات الكاذبة = 6:** نقاط §7 (قائمة).
- **الخارجية = 10:** معرّفات §8 بعد فكّ الصيغ المركّبة: `PS-03`, `PS-06`, `LC-01`, `LC-03`, `LC-04`, `LC-05`, `PI-03`, `PI-09`, `BU-01`, `BU-02` (زائد `BU-04`، وهو معرّف بلا صف تفصيلي في المستودع).
- **إضافة DOC-A2-CLOSE (2026-11-07):** «المفتوحة» **22 → 24** بفجوتَي التحقّق `GAP-A2-01` و`GAP-A2-02` (§11)؛ لم تُغلق ولم تُفتح أي فجوة قائمة أخرى.

> **تصحيح DOC-GAP-01:** كان الملخّص يذكر (20/20/8/9). الأرقام الصحيحة هي (26/20/6/9) كما هو مبيّن أعلاه. أُضيفت أرقام المعرّفات (`PERM-01A/B/C` و`SEC-01/02/03`) كصفوف مكتملة في §2 — فصارت «المفتوحة» 26 لا 20، والصفوف المكتملة في §2 هي SEC-01/02/03 وPERM-01A/B (5 صفوف).

> **إغلاق SEC-04B (DOC-SEC04B-CLOSE — 2026-11-05):** صف SEC-04B في §2 انتقل من **IN_PROGRESS** إلى **COMPLETED** بعد اجتياز اختباراته فعلياً (PostgreSQL 16 معزول، **12/12**). لأن الصف لم يكن مُحتسباً ضمن «المفتوحة (26)» (كان `IN_PROGRESS` لا `PENDING/BLOCKED`)، فإن **«المفتوحة» تبقى 26** و**«المغلقة» ترتفع 20 → 21**. التفاصيل: `docs/SEC-04B_ENTITY_READ_ACCESS.md`.

> **بدء PS-01 (PS-01-IMPLEMENT — 2026-11-06):** صف PS-01 في §2 انتقل من **PENDING** إلى **IN_PROGRESS**: سطح `/admin/finance` مُنفَّذ (5 تبويبات، 8 دوال api، i18n ar/fr/en/zh، مسار محروس ADMIN/SUPER_ADMIN) + 11 حالة E2E مكتوبة، لكن **التشغيل الفعلي متوقّف** (لا PostgreSQL/daemon Docker). لأن الصف صار `IN_PROGRESS` لا `PENDING/BLOCKED`، فإن **«المفتوحة» تنخفض 26 → 25** و**«المغلقة» تبقى 21** (لم يُدَّعِ نجاح تشغيلي). التفاصيل: `docs/PS-01_ADMIN_FINANCE_DESK.md`.

> **إغلاق PS-01 (DOC-PS01-CLOSE — 2026-11-06):** صف PS-01 في §2 انتقل من **IN_PROGRESS** إلى **COMPLETED** بعد نجاح التحقق الحي بإذن صريح: PostgreSQL 16 في حاوية مؤقتة معزولة (`wasit-ps01-pg`، قاعدة `wasit_test` فقط). **Backend:** `npx vitest run tests/finance-routes.test.ts` → **16 passed / 0 failed / 0 skipped**. **E2E:** `npm run test:e2e -- e2e/admin-finance.spec.ts` → **10 passed / 0 failed / 0 skipped**. **الإجمالي: 26 passed / 0 failed.** أُثبت أن `dispatch`/`sync` لم يحوّلا الدفعة إلى `COMPLETED` دون إثبات تحويل خارجي (dispatch → `PROCESSING` فقط، وsync لم يفرض `COMPLETED`). لأن الصف لم يكن مُحتسباً في «المفتوحة (25)» (كان `IN_PROGRESS`)، فإن **«المفتوحة» تبقى 25** و**«المغلقة» ترتفع 21 → 22**. التفاصيل: `docs/PS-01_ADMIN_FINANCE_DESK.md` + `e2e/admin-finance.spec.ts` + `packages/web/src/pages/AdminFinancePages.tsx`.

> **إغلاق PS-02 (DOC-PS02-CLOSE — 2026-11-06):** صف PS-02 في §2 انتقل من **`IN_PROGRESS`** إلى **`COMPLETED`** بعد نجاح التحقق الحيّ بإذن محدود: PostgreSQL 16 في حاوية مؤقتة معزولة (`wasit-ps02-pg`، `127.0.0.1:5432`، قاعدة `wasit_test` فقط، `DEMO_PAYMENT_MODE=true`، مزوّد `manual`). **Backend:** `npx vitest run tests/manual-payment-completion.test.ts` → **10/10**؛ **بوّابات بلا DB** `manual-payment-completion-guard.test.ts` → **4/4**؛ **E2E** `npx playwright test e2e/manual-payment-completion.spec.ts` → **5/5**؛ **تراجع PS-01:** `finance-routes.test.ts` **16/16** + `admin-finance.spec.ts` **10/10**. **الإجمالي: 45 passed / 0 failed / 0 skipped.** أُثبت: إتمام manual → intent/payment/order إلى PAID مع بقاء `settlementStatus=PENDING` وقيد الدفتر غير `SETTLED`؛ رفض 503 خارج DEMO، 409 لمزوّد غير `manual`، 422 بلا مرجع، 403/401 لغير الإداري؛ idempotency (`alreadyPaid`)؛ Audit `PAYMENT.MANUAL_COMPLETED`؛ ولا Settlement/Payout تلقائي. الحاوية حُذفت والمنفذ 5432 حُرِّر، وأُعيد Docker إلى حالته السابقة (متوقف). إصلاحان في الـspec فقط (توقّع `PENDING` بدل `UNPAID`، وإضافة خطوة البحث قبل النقر) — بلا تغيير كود منتج. لأن الصف كان `IN_PROGRESS` (غير مُحتسب في «المفتوحة»)، فإن **«المفتوحة» تنخفض 25 → 24** و**«المغلقة» ترتفع 22 → 23**. التفاصيل: `docs/PS-02_MANUAL_PAYMENT_COMPLETION.md`.

> **إغلاق AI-01 (DOC-AI01-CLOSE — 2026-11-06):** صف AI-01 في §3 انتقل من **PENDING** إلى **`COMPLETED`** بعد بناء نظام تنفيذ مجدول حقيقي (لا `setInterval` ينادي الوكلاء مباشرة). **البنية:** جدول `agent_schedules` (ترحيل `0027_melodic_lifeguard.sql`) + `modules/ai/scheduling.ts` + وظيفة `runAgentSchedules` داخل `lib/scheduler.ts` (مُطفأة افتراضياً عبر `AI_AGENT_SCHEDULER_ENABLED=false`) + مسارات `/api/admin/ai/agent-schedules` (GET/POST/GET:id/PATCH/DELETE) محروسة بنفس `AI_MANAGE|ADMIN_AI`. **ضمانات:** المطالبة بالعقد ذرّية (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` + lease) → تنفيذ واحد فقط عبر النسخ؛ بوابة الموافقة **fail-closed** (رفض 409 عند الإنشاء + تجاوز وقت التشغيل مع تدقيق)؛ بوابة ميزانية قبل إنشاء المهمة (رفض 429 + تدقيق)؛ تدقيق بهوية `SYSTEM` (`audit_logs.actor_type` جديد) مع إبقاء المهمة منسوبة لمنشئها. **الاختبارات:** `ai01-agent-scheduling.test.ts` **12/12** (يشمل سباق مطالبة حقيقي بنسختين) + الحزمة الكاملة **899/899** (77 ملفاً). **التحقّق الحيّ:** PostgreSQL 16 معزول (`wasit-ai01-pg`، `wasit_test`/`wasit_dev`) + نسختان تعملان معاً بجدولة دقيقة واحدة → `claimed=1` لواحدة و`claimed=0` للأخرى، وتدقيق `AI.AGENT_TASK_SCHEDULED` بـ`actor_type=SYSTEM`. الحاوية حُذفت وأُعيد Docker إلى حالته السابقة (متوقف). لأن الصف كان `PENDING` (مُحتسب في «المفتوحة»)، فإن **«المفتوحة» تنخفض 24 → 23** و**«المغلقة» ترتفع 24 → 25**. التفاصيل: `docs/AI-01_AGENT_SCHEDULING.md`.

> **حاسمو ما قبل Supervisor (AI-02.P0 — 2026-11-06):** إغلاق ثلاث تبعيات حرجة كشفها جرد AI-02، **دون** تغيير حالة فجوة AI-02 نفسها (تبقى `PENDING`). (1) **حسم `actorType`:** لا تضارب — سجل `AI.AGENT_TASK_SCHEDULED` يُكتب بـ`actorType='SYSTEM'` و`actorId=null` مع `metadata.createdBy`/`metadata.scheduleId`؛ **لا تغيير كود**. (2) **منع الموافقة الذاتية:** حارس Backend في `decideAgentTask` (`modules/ai/agents.ts`) — الطالب لا يعتمد طلبه (`403`) ويشمل `SUPER_ADMIN`؛ سحب الطالب لطلبه مسموح. (3) **جرد الوكلاء:** 11 وكيلاً مسجّلاً بمصدر وحيد (`AGENT_CATALOGUE`→`agent_registry`) ولكل وكيل منفّذ حقيقي (`executors.ts`)؛ لا «تعريف بلا تنفيذ». **الاختبارات:** `ai02p0-approval-guard.test.ts` **5/5** + الحزمة الكاملة **904/904** (78 ملفاً)؛ Typecheck نظيف. التفاصيل: `docs/AI-02P0_PRE_SUPERVISOR_BLOCKERS.md`.

> **إغلاق AI-02.1 (DOC-AI021 — 2026-11-06):** المرحلة التأسيسية الأولى من AI-02 اكتملت: نموذج `agent_runs` + `agent_run_steps` (ترحيل `0028_keen_gunslinger`)، آلة حالات مركزية (11 حالة تشغيل + 10 حالات خطوة) مع انتقالات قانونية ودوال تحقق ترفض الانتقالات غير القانونية وإحياء الحالات النهائية، وحماية الإكمال والتبعيات الدائرية. **الاختبارات:** `ai021-agent-runs.test.ts` **31/31** + تراجع AI **66/66** + الحزمة الكاملة **935/935** (79 ملفاً)؛ Typecheck نظيف؛ تحقّق حيّ على PostgreSQL 16 معزول (FK + 3 CHECKs + فهارس فريدة + نوعا ENUM). **AI-02 نفسها تنتقل PENDING → IN_PROGRESS** (لأن AI-02.2 وما بعدها ما زالت مؤجّلة) → **«المفتوحة» تنخفض 23 → 22** و«المغلقة» تبقى 25. التفاصيل: `docs/AI-02.1_AGENT_RUNS_STATE_MACHINE.md`.

> **إغلاق AI-02.2 (DOC-AI022 — 2026-11-06):** طبقة التخطيط اكتملت: خدمة `modules/ai/planner.ts` تحوّل هدفاً + خطوات مقترحة إلى خطة محفوظة في `agent_runs`/`agent_run_steps` بحالة `PLANNING`. **التحقق:** وكيل مسجّل ونشط، مفاتيح فريدة، مدخلات صالحة، حدود حجم (25 خطوة / 16KB)، صلاحيات الطالب، ميزانية؛ **الترتيب:** طوبولوجي حتمي (أولوية ثم مفتاح) لا تتجاوزه التبعية، مع إعادة استخدام `assertValidDependencies` وإعادة الفحص لكل خطة. **الحدود:** لا تنفيذ، لا Executor، لا `dispatchStep`، لا `DISPATCHING`/`RUNNING`، والإنشاء ليس موافقة. **الاختبارات:** `ai022-planning.test.ts` **28/28** + تراجع AI **97/97** + الحزمة الكاملة **963/963** (80 ملفاً)؛ Typecheck نظيف. **AI-02 تبقى IN_PROGRESS** (الإرسال/التنفيذ لاحقاً) → العدّات دون تغيير (22 مفتوحة / 25 مغلقة). التفاصيل: `docs/AI-02.2_PLANNING_DEPENDENCY_RESOLUTION.md`.

> **إغلاق AI-02.3 (DOC-AI023 — 2026-11-06):** طبقة الإرسال والتنفيذ المنضبط اكتملت: خدمة `modules/ai/dispatcher.ts` تُرسل خطوة صالحة إلى نظام المهام الحالي عبر `createAgentTask`/`decideAgentTask` (لا Executor مباشر، لا نظام مهام موازٍ). **الربط:** `__runId`/`__stepId` داخل `agent_tasks.input` (jsonb) — **بلا Migration** (لا عمود/جدول جديد). **منع التكرار:** مطالبة ذرّية `UPDATE ... WHERE status IN ('PENDING','READY') RETURNING` (فائز واحد عند التزامن) + فحص مهمة قائمة بنفس `__stepId` + رفض الحالات النهائية/`RUNNING`. **التبعيات:** لا إرسال قبل نجاح كل التبعيات؛ عند الفشل تُعلَّم التابعة `SKIPPED` بشكل متعدٍّ. **الموافقات:** `approveRunStep` (موافق ≠ الطالب، AI-02.P0) ثم جسر عبر Approval Engine. **الإكمال:** `reconcileRun` يغلق الخطة `COMPLETED`/`PARTIALLY_COMPLETED`/`FAILED` وفق آلة الحالات. **حدود:** لا Retry/Tool Gateway/Kill Switch/واجهة Supervisor، ولا توسيع صلاحيات. **الاختبارات:** `ai023-dispatch.test.ts` **21/21** + مجموعة AI **125/125** + الحزمة الكاملة **984/984** (81 ملفاً)؛ Typecheck نظيف. **AI-02 تبقى IN_PROGRESS** → العدّات دون تغيير (22 مفتوحة / 25 مغلقة). التفاصيل: `docs/AI-02.3_CONTROLLED_EXECUTION.md`.

> **إغلاق AI-02.3.1 (DOC-AI0231 — 2026-11-06):** موثوقية التنفيذ والاستعادة. **المزامنة:** `syncStepFromTask` تقارن خطوة `RUNNING` بمهمتها المرتبطة (`input.__stepId`): `succeeded` بشرط وجود نتيجة → `SUCCEEDED`، `failed`/`rejected` → `FAILED`، و`queued`/`running`/`awaiting_approval`/مجهول → **لا إجراء** (لا إعادة إرسال، لا اختراع نتيجة). **الاستعادة:** `recoverStuckSteps` تكتشف الخطوات العالقة `RUNNING` بعد مهلة `AI_AGENT_RUN_STEP_STUCK_SECONDS`، وتطالب بها **ذرّياً** (`UPDATE ... WHERE status='RUNNING' AND updated_at < now()-lease`) فلا تعالجها عمليتا Recovery؛ الخطوة بلا مهمة → `FAILED` (لا إنشاء بديل). **الذرّية:** أُبقيت المطالبة الذرّية ككاتب وحيد، وسُدّت نافذة الانقطاع بالاستعادة الـidempotent بدل معاملة زائفة (لأن `createAgentTask` ينفّذ متزامناً) — **بلا Migration**. **السياسة:** لا Retry؛ `maxAttempts=1` مفروض في `dispatchStep`؛ `FAILED` تُسجَّل ولا تتحوّل نجاحاً. **الصلاحيات:** لا مساس بـAI-02.P0 ولا بتوسيع صلاحيات الوكلاء. **إصلاح:** `reconcileRun` يمرّ الآن عبر الحالات القانونية عند إغلاق خطة ما زالت `PLANNING` (نافذة انقطاع). **الاختبارات:** `ai0231-reliability.test.ts` **23/23** + الحزمة الكاملة **1007/1007** (82 ملفاً)؛ Typecheck نظيف. **AI-02 تبقى IN_PROGRESS** → العدّات دون تغيير (22 مفتوحة / 25 مغلقة). التفاصيل: `docs/AI-02.3.1_EXECUTION_RELIABILITY_RECOVERY.md`.

> **إغلاق AI-02.3.2 (DOC-AI0232 — 2026-11-06):** الـFencing وأمان التزامن بين Dispatch وRecovery. **المشكلة:** بين المطالبة (RUNNING) وإنشاء المهمة/كتابة النتيجة نافذة؛ قد تُغلق Recovery الخطوة `FAILED` ثم يكتب Dispatch قديم فوق القرار أو ينشئ مهمة بعد فقدان الملكية. **الـFencing token:** `attempt_count` يُزاد ذرّياً عند المطالبة ويُعاد للفائز كـtoken؛ كل كتابة نتيجة تمرّ عبر `fencedStepWrite` بشرط `id=? AND status='RUNNING' AND attempt_count=<token>` → كتابة قديمة = no-op (تُسجَّل `AI.AGENT_RUN_STEP_WRITE_REJECTED`). **حماية الخدمة:** `createAgentTask(..., fencing)` يتحقق من الملكية ويُدرج المهمة **في معاملة واحدة**، و**لا يوسّع صلاحيات** (الوكيل الحساس يبقى `awaiting_approval`). **إصلاح ترتيب القفل:** `UPDATE` الملكية يُنفَّذ **قبل** فحص التكرار ليعمل كقفل صف — يمنع **مهمتين نشطتين** للخطوة نفسها تحت `READ COMMITTED` (كان فحص-then-إدراج غير ذرّي؛ أُثبت باختبار تزامن حقيقي فشل قبل الإصلاح ونجح بعده). **تعدد Server:** الضمان على مستوى قاعدة البيانات لا Mutex. **Recovery:** الإيجار يمنع معالجة خطوة تملك مطالبة صالحة؛ لا تصنيف مبكر `FAILED`. **حارس العملية:** `createInFlightGuard()` (تحرير في `finally`). **السجلات:** كل دورة Recovery (حتى الفارغة) بـ`correlationId`/`status`/عدّادات/`durationMs`، وأخطاء الخطوات معزولة. **AUTO_DISPATCH:** أُزيل (إعداد ميّت). **بلا Migration.** **الاختبارات:** `ai0232-fencing.test.ts` **30/30** + `ai0232-concurrency.test.ts` **10/10** (تزامن حقيقي متعدد الاتصالات) + الحزمة الكاملة **1047/1047** (84 ملفاً)؛ Typecheck نظيف. **AI-02 تبقى IN_PROGRESS** → العدّات دون تغيير (22 مفتوحة / 25 مغلقة). التفاصيل: `docs/AI-02.3.2_FENCING_CONCURRENCY_RECOVERY_SAFETY.md`.

> **إغلاق AI-02.3.2 نهائياً (DOC-AI0232-CLOSE — 2026-11-06):** أُغلق الجزء **`CLOSED`** بعد تدقيق نهائي مستقل (9/9 VERIFIED) وضبط دقّة الصياغة التوثيقية (`git diff --check` نظيف). **القيد الصريح المحفوظ:** تم اختبار التزامن عبر **اتصالين/جلستين مستقلتين بقاعدة PostgreSQL**، ولم يُختبر بعد تشغيل **عمليتَي Node Server مستقلتين فعلياً**؛ الضمان مُثبت على مستوى قاعدة البيانات (أقفال الصفوف + شروط `UPDATE`) لا على مستوى عمليتين منفصلتين. **توثيقي بحت: لا كود/اختبار/Migration.** **AI-02 كاملة تبقى `IN_PROGRESS`** → العدّات دون تغيير (22 مفتوحة / 25 مغلقة). التفاصيل: `docs/AI-02.3.2_FENCING_CONCURRENCY_RECOVERY_SAFETY.md`.

> **LC-06 — فرض MFA على الطاقم الداخلي (WASIT-EXECUTION-003 — إغلاق موثّق 2026-11-07):** صف LC-06 في §5 انتقل إلى **`COMPLETE_VERIFIED`**. **توسيع النطاق:** أثناء حسم النطاق تبيّن أن حصر الحارس على `/api/{admin,verification,trust,risk,disputes}/*` **يترك ثغرات** — دور `SUPPORT` يصل `/api/orders`, و`ADMIN/SUPER_ADMIN` يصل `/api/revenue/report` (لا حارس `/api/admin/*` عليه)، ومكاتب أخرى (`tax`, `finance`, `observability`, `payments`) تصلها أدوار الطاقم دون حارس MFA. **الإصلاح النهائي:** حارس **واحد** `requireStaffMfa` (`middleware/mfa.ts` + `isExemptFromStaffMfa`) مربوط على كامل سطح **`/api/*`** (`app.use('/api/*', requireStaffMfa())` بعد CSRF وقبل كل المسارات) — لا قائمة مسارات قابلة للانحراف. الموظّف (أحد `STAFF_ROLES` الخمسة) بلا عامل ثانٍ يُرفض على **كل** سطح طاقم: `/api/admin`, المكاتب, **`/api/revenue`**, والمسارات المختلطة (`orders/payments/subscriptions/ai/media/analytics/tax/finance/observability/…`). الحارس **لا يقيّد إلا أدوار الطاقم الخمسة** → العملاء/التجار/الموردون/الشركات/المسوّقون **غير متأثرين**. **الاستثناءات:** `/api/auth` و`/api/health` فقط، والمطابقة دقيقة أو بفاصل `/` (`/api/authz` غير مستثنى). **الترتيب مُثبَت** باختبار على جدول مسارات `createApp()` الحقيقي (كان الخلل السابق أن `route` ثم `use` لا يفعّل الحارس). **تسجيل الدخول/الجلسة:** تسجيل دخول الموظّف بلا عامل يعيد `staff_enrollment_required` بلا كوكي جلسة، ويُفتح عبر `/mfa/staff-enroll` ثم `/mfa/staff-confirm` بعد TOTP صالح فقط. **الفحص حيّ لكل طلب** فلا يُتجاوَز بجلسة قديمة، **ولا تجاوز لـ `SUPER_ADMIN`**. **السياسة:** `STAFF_MFA_ENFORCEMENT=auto|on|off` (`auto` = production فقط).
>
> **أدلة التحقق المتكامل (PostgreSQL مؤقتة معزولة — WASIT-EXECUTION-003):** أُنشئت حاوية مؤقتة `wasit-lc06-pg` (`postgres:16-alpine`, منفذ loopback `127.0.0.1:55432`, قاعدة `wasit_test` فارغة، volume مجهول مرتبط بالحاوية فقط) — لا اتصال بـ DEMO/التطوير/الإنتاج، ولا إعادة استخدام أي حاوية/قاعدة موجودة. شُغّلت migrations + seed تلقائياً عبر `globalSetup` على قاعدة الاختبار المؤقتة **فقط**. **`staff-mfa-login.test.ts`: 13/13 ✅** (رفض دخول موظف بلا MFA، لا جلسة قبل التسجيل، قبول TOTP صالح، رفض TOTP خاطئ، رفض الجلسة القديمة بعد التفعيل، لا تجاوز SUPER_ADMIN، حماية `/api/revenue/report` بجلسة حيّة، رفض `/api/orders` و`/api/admin/users` للطاقم، عدم تعطيل عميل مسجّل على مسار مختلط، انتهاء صلاحية رمز التسجيل). **الحزمة الكاملة للخادم: 92 ملف / 1126 اختبار ✅** (لا فشل). **TypeScript (server+web): نظيف ✅.** ثم **حُذفت** الحاوية والـvolume المجهول والصورة وسجلّ dockerd المؤقت، وتوقّف الـdaemon الذي شُغّل للمهمة؛ تحقّق عدم بقاء أي مورد. **M0:** sha256 مطابق. **Git:** HEAD `a5391a5…` بلا تغيير، staged=0. **العدّات:** «المفتوحة» 24 → 23 → **22** في جدول §1 (اغلاق مرحلة `IMPLEMENTED` ثم `COMPLETE_VERIFIED`)، «المغلقة» 25 → **26**. التفاصيل: §5 (صف LC-06) + `docs/SECURITY_MODEL.md` + `packages/server/.env.example`.

---

## 2. الفجوات المفتوحة — P0 (أمن ومال وسلامة)

> **ملاحظة DOC-GAP-01:** هذا القسم يحمل **الصفوف المكتملة** (SEC-01/02/03، SEC-04B، PERM-01A/B، PS-01، PS-02، OBS-01) بجانب المفتوحة، لإبقاء سجل كل فجوة P0 في مكان واحد. المفتوحة فعلاً هنا هي: **PS-03, PS-06** (اثنان؛ PS-01 وPS-02 وOBS-01 صارت `COMPLETED`) — أمّا المكتملة فمُدرجة أيضاً في §6. «المفتوحة = 22» في §1 تُحتسب من البنود بحالة PENDING/BLOCKED فقط.

| ID | المجال | وصف النقص | الخطورة | الأولوية | الاعتماديات | الحالة | الاختبارات المطلوبة | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **PERM-01A** | Security/RBAC | الحارس العام `adminRoutes.use('*', requireRole('ADMIN','SUPER_ADMIN'))` كان يُطبَّق على **كل** `/api/admin/*` (بما فيها المكاتب المختصة verification/trust/risk/disputes المثبّتة كتطبيق شقيق على نفس البادئة)، فيمنع `SUPPORT`/`RISK`/`DISPUTE` من الوصول إلى مكاتبهم رغم أن الواجهة (`StaffOnly`) تعرضها لهم وتُعلن أن الخادم يفرض الصلاحيات الدقيقة. النتيجة: تناقض UI↔Backend + روابط معطّلة (403 دائماً). | HIGH | P0 | — | **COMPLETED** | SUPPORT→200 على trust/disputes و403 على verification/risk؛ RISK→200 على risk/trust و403 على verification/disputes؛ DISPUTE→200 على disputes و403 على البقية؛ كل دور مختص→403 على كل مسار إداري عام؛ CUSTOMER→403؛ الزائر→401؛ ADMIN/SUPER_ADMIN→200 على كل شيء؛ الإجراءات الضيّقة داخل المكتب (assign/decide/recompute/review) تبقى 403 لغير الحامل | ✅ `perm01a-staff-desk-access.test.ts` 18/18 + الحزمة الكاملة 814/814 (71 ملف) + Typecheck نظيف |
| **PERM-01B** | Security/RBAC | تناقض صلاحيات المخزون: `ADMIN` لم يكن يملك أي صلاحية مخزون (لا قراءة ولا كتابة) بينما الواجهة تُظهر له رابط «المخزون»؛ و`inventory.manage` (ميزة الواجهة) كانت تُمنح لـADMIN/SUPER_ADMIN رغم غياب أي صلاحية خادم. كذلك كانت كل مسارات `/api/inventory` خلف حارس واحد (قراءة أو كتابة) فلا سبيل لفصل القراءة عن الكتابة. | HIGH | P0 | — | **COMPLETED** | ADMIN→200 على قراءة قائمة/عنصر/حركات المخزون و403 على adjust/PATCH؛ SUPER_ADMIN→200 قراءة و403 تعديل (لا يتجاوز الملكية)؛ SUPPORT/CUSTOMER/زائر→403/401 على كل شيء؛ التاجر→200 قراءة وتعديل ضمن ملكيته و404 لمخزون تاجر آخر؛ منتجات: التاجر ينشر/يعدّل ضمن ملكيته فقط (403 للغير)، ADMIN ينشر/يعدّل أي منتج، SUPPORT/CUSTOMER→403 | ✅ `perm01b-inventory-product-permissions.test.ts` 15/15 + الحزمة الكاملة 829/829 (72 ملف) + Typecheck نظيف + إثبات فشل 3 حالات على الكود القديم |
| **SEC-01** | Security/RBAC | `products/routes.ts` (HEAD، الأسطر 115,131,153) كانت تعامل دور `SUPPORT` كمسؤول: يستطيع إيقاف/تعديل أي منتج لأي بائع، ونشر منتج **باسم بائع آخر**، و**رفع إيقاف إداري** فرضه ADMIN. `SUPPORT` لا يملك أي `PRODUCT_*` كتابة في RBAC. (الإصلاح: `hasProductManageAuthority` في السطر 77، مطبَّقة في 128/144/166.) | CRITICAL | P0 | — | **COMPLETED** | وحدة: SUPPORT→403 على PATCH status / PATCH /:id / POST للغير؛ ADMIN→200؛ إعادة تنشيط الإيقاف الإداري لـSUPPORT→403 | ✅ `product-suspension.test.ts` — 8/8 ناجحة؛ والحزمة الكاملة 784/784 |
| **SEC-02** | Security/Products | `POST /api/products` كان يسمح لأي مشرف بنشر منتج تحت `sellerId` لا يملكه دون أي تحقّق ملكية (تزوير كتالوج). | HIGH | P0 | SEC-01 | **COMPLETED** | SUPPORT→403 للنشر باسم الغير؛ ADMIN/SUPER_ADMIN مسموحان (تفويض إداري) | ✅ نفس اختبار SEC-01 (لا صف مُدسّ في DB) |
| **SEC-03** | Security/Orders | `PATCH /api/orders/:id/status` كان ينقل الطلب إلى `CONFIRMED` ويخصم المخزون دون أي تحقّق من الدفع. **الإصلاح منفّذ ومُتحقَّق حياً**: حارس `assertPaymentConfirmedForOrder` في `orders/service.ts` يمنع كل حالات التنفيذ (CONFIRMED/PROCESSING/SHIPPED/DELIVERED/COMPLETED) قبل الدفع، ويتحقّق من `paymentStatus=PAID` **و** intent `SUCCEEDED` **و** payment `PAID` مرتبطين بالطلب نفسه بالمبلغ والعملة، مع انتقال ذرّي داخل transaction (rollback عند فشل خصم المخزون) يمنع تكرار الخصم. | HIGH | P0 | — | **COMPLETED** | البائع/المشتري → 409 لطلب غير مدفوع/PENDING/FAILED؛ دفع لطلب آخر لا يفتح هذا؛ مبلغ/عملة غير متطابقين → 409؛ تأكيدان متزامنان → خصم واحد؛ فشل خصم → rollback؛ webhook مكرّر → تطبيق واحد | ✅ `order-confirmation-payment-guard.test.ts` 12/12 + `inventory.test.ts` 17/17 + المدفوعات/المسار المالي 58/58 + الحزمة الكاملة 796/796 (Postgres 16 حيّ) + E2E 207/207 (منها `order-lifecycle` + `payments`) |
| **SEC-04B** | Security/Entities | قراءة الكيانات (`GET /api/{suppliers,merchants,companies}` و`/:id`) كانت **بلا أي حارس** وتُرجع كل أعمدة الصف عبر `select()`: `userId` (المالك)، `isActive`، الطوابع الزمنية، و`contacts` (بريد/هاتف شخص الاتصال)، و`taxId`/`registrationNumber` للشركات — لكل زائر بلا تسجيل وللكيانات **غير النشطة** أيضاً. (SEC-04A: 1 CRITICAL + 2 HIGH + 4 MEDIUM.) | CRITICAL | P0 | — | **COMPLETED** | إسقاط عام موحّد (`*_PUBLIC_FIELDS`) يستبعد `userId/isActive/timestamps`؛ `contacts` و`taxId/registrationNumber` للمالك (`userId`) أو الموظف (`user:read`) فقط؛ 404 لغير النشط (200 للمالك/الموظف)؛ حجب `contactEmail/contactPhone` عن غير الموظف في الدليل | ✅ `sec04b-entity-read-access.test.ts` **12/12** (PostgreSQL 16 معزول) + ثوابت ساكنة (39 فحصاً ناجحاً) + Typecheck نظيف (server+web) + `docs/SEC-04B_ENTITY_READ_ACCESS.md` |
| **PS-01** | Payment/Settlement | لا واجهة (UI) لأي عملية من: تأكيد تسوية، إنشاء/إرسال دفعة، مواءمة، إيصال. الـBackend موجود لكن غير قابل للاستخدام التشغيلي. | HIGH | P0 | — | **COMPLETED** | E2E: من `/admin/finance` تأكيد تسوية بمرجع + رفض بلا مرجع | ✅ سطح `/admin/finance` مُنفَّذ (5 تبويبات: settlement/payouts/reconciliation/receipts/providers) + 8 دوال api مطابقة + i18n (ar/fr/en/zh) + مسار محروس ADMIN/SUPER_ADMIN؛ Typecheck + Build (server+web) نظيفان؛ **تحقّق حيّ على PostgreSQL 16 معزول (`wasit_test`)**: Backend `finance-routes.test.ts` **16/16**، E2E `admin-finance.spec.ts` **10/10** — الإجمالي **26 passed / 0 failed / 0 skipped**؛ `dispatch`/`sync` لا يُكملان الدفعة (`COMPLETED`) دون إثبات تحويل خارجي. الملفات: `docs/PS-01_ADMIN_FINANCE_DESK.md` + `e2e/admin-finance.spec.ts` + `packages/web/src/pages/AdminFinancePages.tsx` |
| **PS-02** | Payment/Settlement | لا «settlement desk» لإتمام دفع `manual`/offline من الواجهة. | MEDIUM | P0 | PS-01 | **COMPLETED** | E2E: intent manual → إتمام من الواجهة → PAID | ✅ مكتب إتمام دفع يدوي (DEMO فقط) في تبويب `/admin/finance`: `completeManualPayment` يعيد استخدام `applyPaymentSucceeded` نفسه (لا كاتب جديد)؛ بوّابات مغلقة (503 خارج DEMO، 409 لمزوّد غير `manual`، 422 بلا مرجع)؛ مسار محروس ADMIN/SUPER_ADMIN؛ Audit `PAYMENT.MANUAL_COMPLETED`؛ تأكيد قبل الفعل في الواجهة. الملفات: `docs/PS-02_MANUAL_PAYMENT_COMPLETION.md` + `packages/server/tests/manual-payment-completion{,-guard}.test.ts` + `e2e/manual-payment-completion.spec.ts`. **تحقّق حيّ (PostgreSQL 16 معزول `wasit_test`): Backend 10/10 + بوّابات 4/4 + E2E 5/5 + تراجع PS-01 (finance-routes 16/16, admin-finance E2E 10/10) = 45 passed / 0 failed / 0 skipped** |
| **PS-03** | Payment/Settlement | قدرة **Split** لدى مزوّد الدفع (iPay/ClicToPay/Flouci) غير مؤكَّدة وغير موثَّقة: لا endpoint منشور للـsplit/sub-merchant، والنموذج المالي (1020 = 980 + 40) يحتاج split أو WASIT كحامل أموال. | CRITICAL | P0 | مزوّد | BLOCKED | — | يحتاج تأكيداً كتابياً موثقاً من المزوّد + تصنيف صريح `Split supported` أو `Provider capability gap` |
| **PS-06** | Payment/Settlement | لا مسار استرداد لـClicToPay: `clictopay.refund()` يرفض العملية بـ**503** عمداً (لا endpoint استرداد موثَّق علناً). | HIGH | P0 | مزوّد | BLOCKED | — | يحتاج توثيقاً رسمياً/عقداً من SPS/ClicToPay يحدّد آلية الاسترداد (لا اختراع endpoint) |
| **OBS-01** | Security/Observability | `/api/payments/webhook-failures` و`/:id/replay` كانا موجودين بلا سطح إداري ولا توثيق للمشغّل. | MEDIUM | P0 | — | **COMPLETED** | E2E: فشل webhook يظهر + replay يعمل | ✅ تبويب `webhooks` في `/admin/observability` + ترقيم (offset/total) + تأكيد قبل الفعل + Audit بالهوية؛ Backend `p6-p7-dispute-webhook.test.ts` **19/19** + الحزمة الكاملة **887/887**؛ E2E `admin-webhook-failures.spec.ts` **4/4** + الحزمة الكاملة **226 passed / 8 skipped** — تحقّق حيّ على PostgreSQL 16 معزول (`wasit_test`). **تحديث 2026-11-20 (OBS-01-RECOVERY):** محرّك استعادة خادمي كامل — تصنيف الفشل (TRANSIENT/CONFLICT/PERMANENT/CAPABILITY/STALE)، backoff أسي محدود (`WEBHOOK_RETRY_*`)، claim ذرّي بـlease يمنع التطبيق المزدوج تحت التزامن، سجل `payment_webhook_attempts` لكل محاولة، سقف `replay` (`WEBHOOK_REPLAY_MAX`) + Audit، ومسار `GET /webhook-failures/:id/attempts`. الاختبارات: وحدة **14/14** + تكامل **13/13** + تراجع الـwebhooks **19/19** على PostgreSQL 17 معزول (`wasit_test`، `127.0.0.1:5434`)؛ التفاصيل: `docs/OBS-01_WEBHOOK_RECOVERY.md` |
| **SEC-CSRF-01** | Security/API | لا حماية CSRF لمركزية: الطلبات المُغيِّرة للحالة (POST/PUT/PATCH/DELETE) التي تحمل كوكي الجلسة (`wasit_session`، `SameSite=Lax`) تُنفَّذ دون التحقق من `Origin`/`Referer`، فيمكن لموقع خارجي إرغام متصفح المستخدم المصادَق على إرسال طلب كتابة (كوكي `Lax` لا يمنع POST/PUT/PATCH/DELETE عبر fetch/no-cors، ويُرسَل عبر top-level navigations GET فقط). | HIGH | P1 | — | **COMPLETE_VERIFIED** | رفض Origin غير موثوق على طلب يحمل الكوكي؛ قبول same-origin؛ عدم المساس بطلبات بلا كوكي (توكن/webhooks)؛ سلامة GET/HEAD/OPTIONS؛ استمرار CORS/RBAC | ✅ `middleware/csrf.ts` (مركزي، بلا مسارات مستثناة؛ بعد CORS وقبل routing) + `CSRF_PROTECTION` في `env.ts` + ربطه في `app.ts`؛ **تحقق معزول بلا DB/Docker (WASIT-EXECUTION-005):** `packages/server/tests/csrf.test.ts` **21/21** ✅ (يشمل: الطرق الأربع POST/PUT/PATCH/DELETE، `null` origin، Referer أجنبي/مطابق، رفض مغلق بلا origin مع الكوكي، عدم المساس بطلبات بلا كوكي، سلامة GET/HEAD/OPTIONS، inert في off/auto-dev، فرض `auto` الافتراضي في production عبر التطبيق الحقيقي، عدم استثناء المسارات الحسّاسة، وترتيب CORS→CSRF→routes) + `cors.test.ts` **4/4** (تراجع) + `secret-scan.test.ts` **3/3** + `staff-mfa-enforcement.test.ts` **17/17** (تراجع) + Typecheck (server+web) نظيف ✅ |
| **PERM-01** | Security/RBAC | تناسق مصفوفة RBAC: `ADMIN` يملك صلاحيات إدارية واسعة لكنه **يفتقد** `revenue:read` (يحرسها `/api/revenue/report|scenarios`) و`report:read`، وهما وظيفتان «إداريتان متوقّعتان» ظاهرياً — قرار غير موثّق (كان موثّقاً كمفتوح في `FULL_PROJECT_COVERAGE_AUDIT.md` §6.2). | MEDIUM | P2 | — | **COMPLETE_VERIFIED** | حسم القرار بأقل صلاحية: `revenue:read` **لا يُمنح لـADMIN** (منع مقصود ومُوثَّق ومُتحقَّق حياً — `docs/management/guide.html` §8؛ الفرق ADMIN↔SUPER_ADMIN هو بالضبط `/api/revenue/*`)؛ `report:read` **ليست فجوة** (لا مسار يستهلكها؛ مكتب التقارير محروس بـ`admin:reports` الذي يملكه ADMIN). لا تغيير صلاحيات/كود. | ✅ `packages/server/tests/perm01-admin-revenue-report.test.ts` **17/17** (معزول بلا DB: مصفوفة RBAC، منع ADMIN على report/scenarios/scenario، منع غير الطاقم على الإدارة، عدم التسريب عبر endpoint بديل، التحقق لكل طلب، عدم التجاوز بتغيير الدور) + تراجع `csrf`(21)/`cors`(4)/`secret-scan`(3)/`staff-mfa-enforcement`(17) + Typecheck (server+web) نظيف ✅ |
| **SEC-XFF-01** | Security/Edge & API | **تزوير `X-Forwarded-For`/`X-Real-IP` ⇒ تجاوز حدّ المعدّل:** `core.ts` و`rate-limit.ts` كانا يأخذان عنوان العميل من **أول** قيمة في XFF الوارد (أو X-Real-IP) بلا أي قائمة وكلاء موثوقين أو `TRUST_PROXY`. أي عميل **مجهول** يرسل `X-Forwarded-For: <عشوائي>` لكل طلب فيحصل على مفتاح `ip:<عشوائي>` مختلف → **تجاوز كامل لحدّ المعدّل** على المسارات الحسّاسة (تسجيل/دخول/OTP/إعادة تعيين كلمة المرور)، فيصير الحدّ الفعلي بلا معنى. (المستخدم المصادَق كان يُقيَّد بـ`user:<id>` سليماً؛ والخلل في مسار المجهول.) | HIGH | P0 | — | **COMPLETE_VERIFIED** | وحدتان مركزيتان (`lib/net/client-ip.ts` + `lib/net/cidr.ts`): الافتراضي `TRUSTED_PROXY_HOPS=0` ⇒ **العنوان هو مقبس TCP الحقيقي** (`@hono/node-server` `getConnInfo`) وترويسات Forwarded تُهمَل؛ **الثقة صريحة فقط** عبر `TRUSTED_PROXY_CIDRS` (قائمة شبكات CIDR، فارغة افتراضياً — **لا ثقة ضمنية** بـloopback/RFC1918/ULA)، وتُمنح فقط إن طابق عنوان المقبس شبكةً في القائمة **مع** `TRUSTED_PROXY_HOPS>0`، ثم يُقرأ العنوان من سلسلة XFF **من اليمين لليسار**؛ السلسلة الناقصة/المشوّهة تُرفض (بلا تخمين)؛ X-Real-IP لا يُقبل من عميل مباشر؛ **fail-closed** عند تعذّر العنوان (مفتاح `ip:unknown` مشترك)؛ توحيد صيغة IPv4-mapped IPv6 في مفتاح واحد؛ مفاتيح `user:<id>` وكل الحدود الحالية دون تغيير؛ المدخلات المشوّهة في القائمة تُهمَل مع تحذير (ليست trust-all). | ✅ `packages/server/tests/client-ip.test.ts` **32/32** (نقي بلا DB: حرفية IP، ثقة صريحة فقط، CIDR/الحدود/العائلات، IPv4-mapped، تحليل XFF؛ حقن مقبس TCP عبر `app.request(path, init, env)` = نفس مسار `getConnInfo`: XFF/X-Real-IP مزوّفان لا يغيّران العنوان؛ وكيل مُدرَج 1/2 قفزة يقرأ العنوان من السلسلة يميناً؛ وكيل خاص **غير** مُدرَج لا يُوثق؛ قائمة فارغة = لا ثقة؛ CIDR وحده بلا hops = لا ثقة؛ سلسلة ناقصة/مشوّهة/غائبة ⇒ رفض؛ 429 عند الحدّ مع XFF متغيّر (خلف وكيل مُدرَج وخلف نظير غير مُدرَج)؛ عزل النظائر؛ fail-closed؛ `user:<id>`؛ عدم تسريب IP في جسم 429) + تراجع `rate-limit`(12)/`p6-p7`(19)/`sms`/`mfa-login-challenge`/`marketing-video`/`price-comparison`/`directory`/`security-privacy`/`csrf`(21)/`cors`(4) + الحزمة الكاملة للخادم + Typecheck (server+web) نظيف ✅ |

---

## 3. فجوات P1 (منظومة الذكاء الاصطناعي) — مفتوحة ومُغلقة

> **AFC-08 (2026-11-22):** أُغلق `AI-03` — ربط فتح النزاع وتعيين المراجع بإنشاء مهمة `dispute-assistant` تلقائية مملوكة للمراجع البشري. **الأثر على العدّ:** «المفتوحة» 20 → **19** و«المغلقة» 42 → **43**. التفاصيل: `docs/AFC-08_DISPUTE_ASSISTANT_AUTOMATION.md` وAD-055.
>
> **AFC-07 (2026-11-20):** أُضيف `AI-10` وأُغلق فورًا — `dispute-assistant` كان «قابلًا للتنفيذ» بلا أن يقرأ نزاعًا: `input.disputeId` مُهمَل، وآخر 5 رسائل تُجمع من كل النزاعات، والتوصية جملة ثابتة. أُعيد بناء التنفيذ على نزاع واحد (أدلة + أحداث + استئنافات + مبلغ + مهل ومسارات من لقطة السياسة) مع وضع `triage` بلا أي نص رسالة. **الأثر على العدّ:** «المفتوحة» تبقى 20 و«المغلقة» 41 → **42**. التفاصيل: `docs/AI-FIRST-COMPLETION-07.md` وAD-054.

> **AI-FIRST COMPLETION (2026-11-22):** أُغلقت `AI-06` (تحليل السبب + patch proposal لوكيل الصيانة) و`AI-07` (فرض `requiresPlatformScope` — ثغرة قراءة عابرة للمستأجرين). المصفوفة الكاملة للوكلاء الـ21 + Copilot: `docs/AI-FIRST-COMPLETION-01.md`.

| ID | المجال | وصف النقص | الخطورة | الأولوية | الاعتماديات | الحالة | الاختبارات المطلوبة | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **AI-01** | AI/Automation | الوكلاء طلب-استجابة فقط: لا scheduler، لا تشغيل دوري/مستقل. 11 وكيلاً مسجّلين، لكن لا تنفيذ مجدول. | HIGH | P1 | — | **COMPLETED** | تشغيل مجدول لمهمة وكيل + Audit + حدود الميزانية | ✅ جدول `agent_schedules` (ترحيل `0027`) + `modules/ai/scheduling.ts` + وظيفة `runAgentSchedules` في `lib/scheduler.ts` (مُطفأة افتراضياً) + مسارات `/api/admin/ai/agent-schedules`؛ المطالبة الذرّية بالعقد (`FOR UPDATE SKIP LOCKED`) تمنع التنفيذ المزدوج عبر النسخ؛ بوابة الموافقة fail-closed + حدود الميزانية + تدقيق بهوية `SYSTEM`. Backend `ai01-agent-scheduling.test.ts` **12/12** + الحزمة الكاملة **899/899** + تحقّق حيّ (نسختان متزامنتان، تنفيذ واحد فقط) |
| **AI-02** | AI/Automation | لا `Agent Supervisor` للقيادة والتنسيق. **ملاحظة مصدر**: الطلب آتٍ من تعليمات سابقة وليس موثّقاً في `AI_ARCHITECTURE.md` — يلزم تثبيته في الوثيقة أولاً. **التقدّم:** AI-02.1 (نموذج Agent Runs + آلة الحالات)، AI-02.2 (التخطيط والتحقق من التبعيات)، AI-02.3 (الإرسال والتنفيذ المنضبط)، AI-02.3.1 (الموثوقية والاستعادة)، AI-02.3.2 (الـFencing وأمان التزامن)، و**AI-02.S1 (Supervisor + Retry Policy)** مُغلقة؛ LLM planner وTool Gateway وKill Switch وواجهة Supervisor الكاملة ما زالت مؤجّلة. | HIGH | P1 | AI-01 | **IN_PROGRESS** | Supervisor يوزّع مهمة على وكيل متخصّص ويسجّل التتبّع | ✅ AI-02.S1: `modules/ai/supervisor.ts` + `retry-policy.ts` + مسارا `/api/admin/ai/supervisor/*`؛ اختبارات `ai024-supervisor` (**17/17**) + `ai024-supervisor-routes` (**7/7**) + `unit/retry-policy` (**10/10**) + تراجع AI-02 (**158/158**). التفاصيل: `docs/AI-02.S1_SUPERVISOR_RETRY.md` |
| **AI-03** | AI/Automation | توجيه النزاعات/الدعم تلقائياً إلى Agent غير موصول بطابور؛ `dispute-assistant`/`support-agent` تشغيلهما يدوي. **مُغلق (2026-11-22):** فتح النزاع يسجّل طلبًا (`PENDING_NO_REVIEWER`) ولا ينشئ مهمة بمالك وهمي؛ تعيين مراجع مخوّل (ADMIN/SUPER_ADMIN يحمل `dispute:read`) ينشئ **مهمة واحدة** مملوكة له باسمه عبر `createAgentTask` الحقيقي، بدورة تعيين `reviewer@assigned_at` + `dedupe_key` + فهرس فريد للمهام المفتوحة. المراجع غير المخوّل لا ينشئ شيئًا (سبب مُدقّق)، إعادة الإسناد تلغي مهمة الدورة السابقة وتنشئ أخرى، والتنفيذ يرفض إن لم يعد النزاع مُسندًا لمالك المهمة. لا Migration، لا صلاحية جديدة، ولا قرار آلي أو تغيير حالة أو أثر مالي. | MEDIUM | P1 | AI-02 | **COMPLETED** | فتح نزاع → مهمة وكيل تلقائية + Approval gate | `tests/afc08-dispute-assistant-automation.test.ts` (12) · `docs/AFC-08_DISPUTE_ASSISTANT_AUTOMATION.md` · AD-055 |
| **AI-04** | AI/Ops | لا سطح إداري لتفعيل مزوّد AI وضبط مفاتيحه وفق إعدادات آمنة (الحالي: متغيّر بيئة فقط، الافتراضي `local-heuristic`). | MEDIUM | P1 | — | PENDING | اختبار إعداد المزوّد + عدم كشف المفتاح | اختبار أمني |
| **AI-05** | AI/Agents | ترتيب تنفيذ الوكلاء المطلوب في تعليمات سابقة (Supervisor ثم Product/Marketing/Support/Customer-Intelligence ثم Outreach) **غير موثّق في المستودع**: `AI_ARCHITECTURE.md` §3 يسرد 11 وكيلاً بترتيب محايد. يلزم تثبيت الترتيب المطلوب في الوثيقة ثم مواءمة `AGENT_CATALOGUE` معه. | MEDIUM | P1 | AI-02 | PENDING | تثبيت الترتيب + مواءمة الكتالوج + اختبار | اختبار |
| **AI-06** | AI/Agents | وكيل الصيانة كان يشخّص بلا تحليل سبب: `suggestedRepair` نصّ ثابت يطلب من الإنسان «تجميع الأعطال حسب الوكيل ورمز الخطأ». **مُغلق (2026-11-22):** تجميع حتمي حسب بصمة الخطأ (11 عائلة) + فرضية وثقة وأدلة + `patchProposals` (ملفات موجودة فعلاً في الريبو، اختبارات، تحقّق، rollback) + `reviewReport` بحالة كل خطوة. اختبارات معزولة وتطبيق patch يبقيان محجوبين بنيوياً (AD-050) ومصرَّحاً بهما في المخرجات. | HIGH | P1 | — | **COMPLETED** | تجميع + patch + تقرير + لا كتابة | `modules/ai/diagnostics.ts` + 17 اختباراً (`tests/unit/ai-maintenance-rootcause.test.ts`, `tests/ai-maintenance-rootcause.test.ts`) · `docs/AI-FIRST-COMPLETION-01.md` §4.1 |
| **AI-07** | AI/Security | `requiresPlatformScope: true` معلن على 9 وكلاء و**غير مفروض في أي مكان**: A2 يحدّ الجداول لا الصفوف، فعميل يحمل `ai:use` شغّل وكيل الصيانة وقرأ رسائل أخطاء مهام مستخدمين آخرين وعدّادات المنصة، وشغّل وكيل النمو وكشف كل الموردين/التجار/الشركات. **مُغلق (2026-11-22):** الفرض في `createAgentTask` (`ADMIN`/`SUPER_ADMIN` فقط) مع Audit `AI.AGENT_RUN_REFUSED`/`PLATFORM_SCOPE_REQUIRED` وmetric `blocked` ورفض **قبل** كتابة أي صف مهمة. لا صلاحية جديدة ولا تغيير في `ROLE_PERMISSIONS`. | HIGH | P1 | — | **COMPLETED** | رفض 5 أدوار + Audit + صفر صفوف مكتوبة | `tests/ai-platform-scope.test.ts` (9) · `docs/AI-FIRST-COMPLETION-01.md` §4.2 |
| **AI-08** | AI/Security | **تسريب محتوى رسائل عبر وكيل الدعم + إعلان نطاق بلا تفعيل:** `execSupportAgent` أعاد آخر الرسائل غير المقروءة **على مستوى المنصة** (`senderId` + 120 حرفاً من النص) لأي حامل `ai:use` — عميل يقرأ رسائل غيره. و`market-research-agent` كان يعلن `scope: 'platform'` ويقرأ كل الموردين/المنتجات/الطلبات بلا `requiresPlatformScope`. **مُغلق (2026-11-22):** فلترة صفية حقيقية للدعم (`threads.participant_ids @> [requesterId]` + حصر الرسائل في خيوط المشارك، و`activeUsers = null` لغير الموظفين، وأطقم الدعم تحتفظ بالعرض الكامل) + تفعيل `requiresPlatformScope` على `market-research-agent`. لا صلاحية جديدة ولا تغيير في `ROLE_PERMISSIONS`. | HIGH | P1 | — | **COMPLETED** | عميل يرى خيوطه فقط · 5 أدوار تُرفض على market-research · صفر صفوف مكتوبة | `tests/ai-support-scope.test.ts` (3) · `tests/ai-platform-scope.test.ts` (10) · `docs/AI-FIRST-COMPLETION-02.md` §4.1 |
| **AI-09** | AI/Security | **ستة وكلاء يعلنون `own`/بلا نطاق ويقرؤون صفوف كل المستأجرين:** `sales-agent` (كل الطلبات + أعداد الموردين/التجار/الشركات + متوسط الثقة العام)، `marketing-agent` (كل المنتجات/التصنيفات/الماركات)، `product-agent` (`pickProduct` بلا مالك، ويختار أول منتج في المنصة بلا `productId`)، `b2b-agent` (أسماء ومُعرّفات كل الأطراف)، `finance-agent` و`outreach-acquisition-agent` (مؤشرات منصة). **مُغلق (2026-11-22):** فلترة صفية حقيقية للأول (ملكية عبر `suppliers/merchants/companies.user_id` + `orders.buyer_id` + `order_items.seller_id`)، ورفض منتج الغير بلا كشف وجوده، وتقييد `b2b` إلى `ADMIN`/`SUPER_ADMIN` (لا فلترة تحفظ الفائدة)، وإثبات أن `finance`/`outreach` مقيّدان. أرقام المنصة (`suppliers/merchants/companies`, `leadsPotential`) صارت `null` لغير الطاقم. لا صلاحية جديدة ولا تغيير في `ROLE_PERMISSIONS`. | HIGH | P1 | — | **COMPLETED** | عميل A ≠ عميل B · تاجر A ≠ تاجر B · شركة A ≠ شركة B · 5 أدوار مرفوضة قبل أي صف · Audit+metric بلا تسريب | `tests/ai-agent-data-scope.test.ts` (15) · `docs/AI-FIRST-COMPLETION-03.md` §1 |
| **AI-10** | AI/Agents | **`dispute-assistant` لم يكن يلخّص نزاعًا:** التنفيذ يتجاهل `input.disputeId` ويعيد قائمة كل النزاعات المفتوحة، ويجمع آخر 5 رسائل من **كل** النزاعات في مخرج واحد (يُخزَّن في `agent_tasks.result`)، ويعيد جملة ثابتة كتوصية — بلا أدلة ولا أحداث ولا مهل ولا أثر مالي. **مُغلق (2026-11-20):** وضعان صريحان (`summary` لنزاع واحد / `triage` بلا أي نص رسالة)، قراءة `dispute_evidence`+`dispute_events`+`dispute_appeals`+`orders` مقيدة بـ`disputeId`، ولقطة سياسة `__disputePolicy` تُحقن في طبقة الخدمة (بلا كتابة `country_policy_gaps`) ويُسقَط أي قيمة من الطالب. الوكيل لا يقرر (`decisionAuthority: HUMAN`) والأثر المالي لا يُخترع (`SPLIT` = `DECISION_REQUIRED`). لا Migration ولا صلاحية جديدة. | HIGH | P1 | — | **COMPLETED** | نزاعان A/B: مخرج A لا يحتوي محتوى B · لا كتابة أي صف · CUSTOMER/SUPPORT مرفوضان قبل الكتابة · نزاع غير موجود ⇒ `failed` بلا لخّص | `tests/unit/dispute-summary.test.ts` (23) · `tests/ai-dispute-assistant.test.ts` (12) · `docs/AI-FIRST-COMPLETION-07.md` §3 · AD-054 |
---

## 4. الفجوات المفتوحة — P2 (الوظائف التجارية)

| ID | المجال | وصف النقص | الخطورة | الأولوية | الاعتماديات | الحالة | الاختبارات المطلوبة | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **PR-02** | Product/Admin | لا Admin Desks لـMerchants/Suppliers/Companies/Categories/Currencies/Languages/Commissions (`grep admin/merchants` = ∅). | HIGH | P2 | — | PENDING | مسارات + صفحة + RBAC + E2E | E2E |
| **PR-10** | Product | جدول `notification_preferences` موجود في المخطّط بلا أي مسار أو واجهة (تفضيلات الإشعارات). | MEDIUM | P2 | — | PENDING | GET/PUT + E2E | E2E |
| **PR-11** | Product | لا Support Desk/طابور تذاكر وتصعيد. | MEDIUM | P2 | AI-03 | PENDING | تذكرة + تصعيد + E2E | E2E |
| **PR-01** | Product | لا Cart دائم/دفع متعدد البنود (`CheckoutPage` = منتج واحد). | MEDIUM | P2 | — | PENDING | سلة + دفع متعدد + E2E | E2E |
| **PR-05** | Product | `/tools/calculator` غير منفَّذ. **أُغلق:** صفحة `BusinessCalculatorPage` على `/tools/calculator` (واجهة عامة) + منطق صرف `lib/business-calculator.ts` يعكس نموذج رسوم الطلب (عمولة البائع على المجموع، عمولة المشتري تُضاف لإجمالي المشتري، رسوم الدفع على البائع، `sellerNet = المجموع − عمولة البائع − رسوم الدفع`)، بنسب افتراضية قابلة للتعديل موسومة كسياسة القاعدة. | LOW | P2 | — | **COMPLETE_VERIFIED** | صفحة + اختبار | ✅ `packages/web/src/lib/business-calculator.ts` + `packages/web/src/pages/BusinessCalculatorPage.tsx` + `packages/web/src/{App.tsx,components/layouts/PublicLayout.tsx,lib/i18n.ts}` + `packages/web/tests/business-calculator.test.ts` (**10/10** معزول بلا DB/DOM) + `e2e/business-calculator.spec.ts` (**4/4** متصفّح حقيقي بلا DB عبر `playwright.tools.config.ts`) |
| **PR-06** | Product | `/map` (Business/Market Map) غير منفَّذ. | LOW | P2 | — | PENDING | صفحة + اختبار | E2E |
| **PR-03** | Product | أسطح Placeholder: Branches، Employees بلا Backend. | LOW | P2 | — | PENDING | قرار: تنفيذ أو إزالة | — |

---

## 5. الفجوات المفتوحة — P3 (الجاهزية القانونية/الإنتاجية)

| ID | المجال | وصف النقص | الخطورة | الأولوية | الاعتماديات | الحالة | الاختبارات المطلوبة | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **LC-01** | Compliance | لا ToS/Privacy/Cookie Policy (نصّ أو صفحات). يمنع التشغيل القانوني. **تنفيذ WASIT-EXECUTION-010 (جاهزية تقنية):** كتالوج وثائق قانونية (9 وثائق، إصدارات، حالة نشر) `lib/legal/catalogue.ts` + تسجيل الموافقة **على إصدار محدّد** وكشف إعادة الموافقة (`privacy/service.ts`) + أسطح عامة للمنشور فقط (`GET /api/public/legal/documents[/:code]`) + سطح المستخدم (`GET/POST /api/legal/acceptances`) + صفحة `/legal` + رابط التذييل + **حق التصحيح** `PATCH /api/privacy/me` (حقول مُدرجة بيضاء، بلا بريد/تحقّق). **تنفيذ WASIT-EXECUTION-010.1 (بنية الموافقة + بوابة إلزامية):** `GET /api/legal/acceptances/history` (سجل المستخدم) + مخطط قبول **صارم** يرفض تزوير الهوية (422) + `listLegalAcceptances` + **بوّابة إلزامية** `requireLegalAcceptance()` مثبّتة على كل `/api`، **مطفأة افتراضياً** (`LEGAL_ACCEPTANCE_ENFORCEMENT=off`) ولا تحجب إلا عند وجود وثيقة **منشورة وسارية** + صفحة `/dashboard/legal` (واجهة قبول متعددة اللغات) + `LEGAL_ACCEPTANCE_REQUIRED` + `docs/LC-01.1_LEGAL_CONSENT_INFRASTRUCTURE.md` و`docs/LC-01_LEGAL_INFO_REQUIRED.md`. **يبقى مفتوحاً:** النصّ القانوني **المنشور والمعتمد** (كل الوثائق تبدأ `LEGAL_REVIEW_REQUIRED` بلا سريان ⇒ لا ظهور ولا إقرار). المسودّات في `docs/legal/`. | CRITICAL | P3 | قانوني (اعتماد خارجي) | BLOCKED (النصّ المعتمد) / البنية التقنية: COMPLETE_VERIFIED | صفحات + اختبار + اعتماد | يحتاج صياغة قانونية معتمدة |
| **LC-02** | Compliance | **أُغلقت (WASIT-EXECUTION-007.3).** كان: لا banner/UI لموافقة الكوكيز/GDPR (الـAPI `PUT /api/privacy/consents` موجود). **الآن:** واجهة موافقة كاملة (banner + نافذة إعدادات + رابط دائم) بأربع فئات، مع **بوّابة فعلية** على تتبّع الإعلانات (`AdSlot` لا يجلب/يعرض/يُرسل حدثاً تسويقياً قبل موافقة `marketing`)، تخزين على العميل بإصدار سياسة وانتهاء، سحب يوقف التتبّع ويحذف معرّفه، ولا مساس بالكوكيز الضرورية. **التحقّق:** 34/34 اختبار وحدة معزول (بلا DB/DOM) + Typecheck + Build ✅ + **E2E متصفّح حقيقي بلا DB 8/8** (`playwright.cookie.config.ts` + اعتراض `/api`، Chromium النظام). أُصلح عيب 007.2 (سحب `marketing` لم يكن يحذف `wasit.adSession` من sessionStorage) بتمرير `getSessionStorage()` أيضاً إلى `applyConsentTransition` في `persist()`، مع 5 حالات وحدة جديدة. أُثبتت الضرورة بإعادة الحالة: الحالة الثامنة تفشل بلا الإصلاح وتنجح معه. الجزء القانوني (نصّ السياسة) يبقى خارجياً تحت LC-01. | HIGH | P3 | LC-01 (للنصّ القانوني فقط) | **COMPLETE_VERIFIED** (تقنياً) | banner + E2E موافقة | ✅ `packages/web/src/lib/{cookie-consent.ts,consent-context.tsx}` + `packages/web/src/components/CookieConsent.tsx` + `packages/web/src/components/AdSlot.tsx` + i18n (ar/en/fr/zh) + `packages/web/tests/{cookie-consent,consent-enforcement}.test.ts` (**29/29** معزول بلا DB/DOM) + `e2e/cookie-consent.spec.ts` (**8/8 شُغِّلت بلا DB**) + `playwright.cookie.config.ts` + `docs/LC-02_COOKIE_CONSENT.md` |
| **LC-03** | Compliance | لا سياسة سلع محظورة (محتوى/إنفاذ). **أُغلقت (WASIT-EXECUTION-008/008.1).** **التنفيذ:** مصنّف مركزي (`lib/prohibited-goods.ts`) بقواعد `PROHIBITED/RESTRICTED/ALLOWED` + تطبيع مقاوم للتحايل (حالة/تشكيل/أشكال عربية/مسافات) + مطابقة كلمة كاملة؛ **نقطة إنفاذ واحدة** في الخدمة (`enforceListingPolicy` داخل `createProduct`/`updateProduct`/`updateProductStatus`): محظور → رفض 422 بلا كتابة، مقيّد → مسودّة غير منشورة لا تُنشر إلا بمراجعة بشرية (`catalog:compliance:review`، غير ممنوحة لأي وكيل AI)، وإعادة تصنيف الناتج عند التعديل. **بلا Migration** (العلامة في `products.tags` غير المستخدَم + `audit_logs`). | HIGH | P3 | LC-01 (للنصّ القانوني فقط) | **COMPLETE_VERIFIED** | قائمة + فلترة + اختبار | ✅ `packages/server/src/lib/prohibited-goods.ts` + `packages/server/src/modules/products/{service,routes}.ts` + `packages/shared/src/errors/api-error.ts` + `packages/shared/src/constants/{permissions,rbac}.ts` + `packages/server/tests/lc03-{prohibited-goods-policy,enforcement,review-authorization}.test.ts` (**26/26** معزول بلا DB) + `packages/server/tests/lc03-prohibited-goods.test.ts` (**4/4** على PostgreSQL 16 مؤقتة معزولة `wasit-lc03-pg`) + `docs/LC-03_PROHIBITED_GOODS.md` |
| **LC-04** | Compliance | لا Refund/Dispute Policy ولا Merchant/Buyer Terms عامة (الموجود سياسات داخلية). **إصلاح WASIT-EXECUTION-009.1 (محور التكامل المالي):** الـRefund لم يعد يُعتبر ناجحاً بلا **إثبات خارجي موثوق** — فصل الطلب عن الإتمام، كاتب إتمام وحيد `completeRefundWithEvidence`، مسند ثقة `canProveRefund` يرفض مزوّدي العرض، ورفض webhook `REFUND_SUCCEEDED` من مزوّد غير قادر. **يبقى مفتوحاً:** صياغة Refund/Dispute Policy وMerchant/Buyer Terms **المنشورة** (اعتماد قانوني تحت LC-01). | HIGH | P3 | LC-01 | PENDING (التكامل المالي: COMPLETE_VERIFIED؛ الصياغة القانونية: مفتوحة) | صفحات + اختبار | E2E |
| **LC-05** | Compliance | لا KYC/KYB/AML/sanctions؛ التحقق مراجعة وثائق بشرية. | HIGH | P3 | عقد مزوّد | BLOCKED | — | يحتاج عقد مزوّد هوية |
| **LC-06** | Security | MFA غير مُلزم لأدوار الموظّفين/المديرين (اختياري لكل مستخدم). **الإصلاح (WASIT-EXECUTION-002/003):** فرض إلزامي على أدوار الطاقم الداخلي (`SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN`) عبر حارس **واحد على كامل `/api/*`** — الموظّف بلا عامل ثانٍ يُرفض على كل سطح طاقم (admin + المكاتب + revenue + المسارات المختلطة) ولا يحصل على جلسة؛ تسجيل دخول الموظّف يعيد تحدّي تسجيل إلزامي (`staff_enrollment_required`) ويُفتح عبر `/mfa/staff-enroll` + `/mfa/staff-confirm`؛ الفحص يُقرأ حياً لكل طلب فلا يُتجاوَز بجلسة قديمة، ولا استثناء لـ SUPER_ADMIN. | HIGH | P3 | — | **COMPLETE_VERIFIED** | فرض MFA على الأدوار الحسّاسة + اختبار | ✅ `middleware/mfa.ts` (`requireStaffMfa` + `isExemptFromStaffMfa`) مربوط `app.use('/api/*', …)` في `app.ts` (بعد CSRF، قبل كل المسارات؛ `/api/auth`+`/api/health` مستثنيان فقط)؛ `STAFF_ROLES`/`isStaffRole` في `@wasit/shared`؛ `STAFF_MFA_ENFORCEMENT` في `env.ts`؛ تدفّق تسجيل إلزامي في `auth/service.ts`+`routes.ts`+واجهة `LoginPage`. **تحقق متكامل على PostgreSQL مؤقتة معزولة:** `staff-mfa-login.test.ts` **13/13** ✅ + الحزمة الكاملة للخادم **1126/1126** (92 ملف) ✅ + `staff-mfa-enforcement.test.ts` **17/17** (بلا DB) + `unit/mfa.test.ts` **8/8** + `csrf.test.ts` **17/17**؛ Typecheck (server+web) نظيف؛ الموارد المؤقتة حُذفت بالكامل |
| **LC-07** | Security | لا قفل حساب بعد فشل دخول متكرر (فقط rate-limit لكل IP). حقل `is_locked` موجود بلا كاتب آلي. **الإصلاح (WASIT-EXECUTION-004/004.1):** قفل مؤقت تلقائي الانتهاء بعد `MAX_LOGIN_ATTEMPTS` (5) كلمة مرور خاطئة متتالية لمدة `LOCKOUT_MINUTES` (15)؛ تطبيق ذرّي (`UPDATE` شرطي واحد)؛ رسالة موحّدة `Invalid credentials` (401) بلا كشف وجود/حالة الحساب؛ يغطّي الطاقم وSUPER_ADMIN بلا استثناء؛ لا يُتجاوَز عبر MFA؛ تدقيق `AUTH.ACCOUNT_LOCKED`/`AUTH.ACCOUNT_UNLOCKED` بلا أسرار. **مراجعة 004.1 (تحصين MFA + التوقيت):** التصفير صار **بعد اكتمال المصادقة كاملةً** (كلمة المرور + العامل الثاني) لا عند صحة كلمة المرور؛ **فشل TOTP لا يمسّ عدّاد كلمة المرور** (حماية مستقلة عبر عدّاد التحدّي)؛ زيادة `attempts` للتحدّي صارت **ذرّية** (`attempts + 1` في SQL)؛ وموازنة زمن الاستجابة لمسارات (حساب غير موجود/مقفل/معطّل) عبر تحقّق argon2 بمعاملات مطابقة (`DUMMY_ARGON2_HASH`) — يُقاس ولا يُدّعى. | MEDIUM | P3 | — | **COMPLETE_VERIFIED** | عدّاد + قفل + اختبار | ✅ `lib/lockout.ts` (سياسة صرفة) + `lib/security.ts` (`DUMMY_ARGON2_HASH`) + `registerFailedLogin`/`clearFailedLogin` في `auth/service.ts` (تصفير بعد المصادقة الكاملة في `loginUser`/`completeMfaLogin`/`completeStaffMfaEnrollment`)؛ `MAX_LOGIN_ATTEMPTS`/`LOCKOUT_MINUTES` في `env.ts`+`.env.example`؛ **اختبارات بلا DB:** `unit/lockout-policy` **7/7** + `unit/security-timing` **3/3** (يطابق المعاملات + يقيس الزمن) + `unit/account-lockout-flow` **6/6** (تدفّق حقيقي بـDB وهمي + spy) = **16/16**؛ كل `tests/unit` **90/90**؛ وعيّنة بلا DB **65/65** (بلا تراجع LC-06/CSRF)؛ Typecheck (server) نظيف. **تحقّق متكامل على PostgreSQL 16 مؤقتة معزولة (`wasit-lc07-pg`، `wasit_test`، منفذ `127.0.0.1:55440`):** `tests/account-lockout.test.ts` **19/19** ✅ (عدّ/تصفير/قفل/رفض أثناء القفل/انتهاء تلقائي/تزامن/طاقم وSUPER_ADMIN/عدم تجاوز MFA/عدم تعطيل العملاء والتجار/عدم كشف الوجود/تدقيق بلا أسرار/تفاعل MFA/انتهاء التحدّي وعدم إعادة استخدامه/الحدّ الذرّي/التوقيت) + الحزمة الكاملة للخادم **1161/1161** (96 ملف) ✅ + Typecheck (server+web) نظيف ✅؛ الموارد المؤقتة حُذفت بالكامل → **`COMPLETE_VERIFIED`** |
| **PI-03** | Infra | النسخ الاحتياطي محلي فقط: لا تشفير ولا نقل offsite ولا WAL streaming. | HIGH | P3 | بنية خارجية | BLOCKED | — | يحتاج وجهة خارجية |
| **PI-05** | Infra | لا Error tracking (Sentry/Datadog). | MEDIUM | P3 | مزوّد | PENDING | تكامل + اختبار | — |
| **PI-09** | Infra | لا مفاتيح AI إنتاجية (الافتراضي `local-heuristic`). | MEDIUM | P3 | AI-04 | PENDING | إعداد المزوّد + اختبار | — |

---

> **إغلاق محور LC-04 المالي (DOC-LC04-009.1 — 2026-11-07):** فجوة LC-04 لها وجهان: **التكامل المالي للـRefund** (تقني) و**صياغة Refund/Dispute Policy وMerchant/Buyer Terms المنشورة** (قانوني). هذا العمل أغلق **الوجه التقني فقط** (`COMPLETE_VERIFIED`: لا نجاح مالي بلا إثبات خارجي — 11/11 معزول + الحزمة الكاملة 1223/1223). الوجه **القانوني** يبقى **مفتوحاً** تحت LC-01. لذا صف LC-04 في §5 يبقى **PENDING** و**العدّات لا تتغيّر** («المفتوحة» تبقى 18، «المغلقة» تبقى 30). التفاصيل: `docs/LC-04_REFUND_FINANCIAL_INTEGRITY.md`.

## 6. البنود المُغلقة فعلياً (COMPLETED) — مع دليل

> **العدّ:** **33** صفاً (بلا صف `—`) = **31** معرّفاً مميّزاً؛ منها **18** مطابق لمغلقة §2–§5 (يشمل **PR-05** في §4، أُغلق بـWASIT-EXECUTION-014) و**14** حصراً به و**1** بنداً إضافياً (`SEC-011.4` في §12) ⇒ إجمالي «المغلقة» = **33**. أُضيف `SEC-03` و`SEC-XFF-01` (كانا مغلقين في §2 وغائبين عن هذا الجدول — تصحيح WASIT-EXECUTION-012.1). أرقام «الحزمة الكاملة» في هذا القسم وهذه الوثيقة **تاريخية** (تشغيلات 2026-11-04) — لم تُعَد في DOC-GAP-01، عدا SEC-04B الذي أُغلق بتشغيل فعلي (2026-11-05)، وPS-01 (2026-11-06)، وPS-02 (2026-11-06: 45/45)، وAI-01 (2026-11-06: 12/12 + حزمة 899/899)، و**LC-06 (2026-11-07: 13/13 + حزمة 1126/1126)**، و**PR-05 (2026-11-03: 10/10 وحدة + 4/4 E2E بلا DB)**. انظر جدول خطوط الأساس أعلى الملف.

| ID | البند | دليل الإغلاق |
| --- | --- | --- |
| **SEC-01** | صلاحيات المنتجات مستمدّة من RBAC (`product:manage`) لا من قائمة أدوار مكتوبة يدوياً؛ `SUPPORT` لم يعد مسؤولاً تلقائياً | `products/routes.ts` (`hasProductManageAuthority`) + `product-suspension.test.ts` (4 حالات جديدة) |
| **SEC-02** | لا يمكن نشر منتج باسم بائع آخر لغير حامل `product:manage` | نفس الاختبار: SUPPORT→403، ADMIN/SUPER_ADMIN→201، ولا صف مُدسّ في DB |
| **SEC-03** | تأكيد الطلب (`CONFIRMED`) يتطلّب دفعاً مؤكَّداً قبل خصم المخزون (`assertPaymentConfirmedForOrder`) | `orders/service.ts` (`assertPaymentConfirmedForOrder`) + `order-confirmation-payment-guard.test.ts` |
| **SEC-XFF-01** | تزوير `X-Forwarded-For`/`X-Real-IP` لا يتجاوز حدّ المعدّل: العنوان من مقبس TCP الحقيقي، والثقة صريحة فقط عبر `TRUSTED_PROXY_CIDRS`، fail-closed عند التعذّر | `lib/net/client-ip.ts` + `lib/net/cidr.ts` + `tests/client-ip.test.ts` (**32/32**) + `docs/…` (WASIT-EXECUTION-011.2/011.3) |
| **SEC-04B** | حماية قراءة الكيانات: إسقاط عام موحّد (`*_PUBLIC_FIELDS`) يستبعد `userId/isActive/timestamps`؛ `contacts` و`taxId/registrationNumber` للمالك (`userId`) أو الموظف (`user:read`) فقط؛ 404 لغير النشط (200 للمالك/الموظف)؛ حجب `contactEmail/contactPhone` عن غير الموظف في الدليل | `server/src/lib/entity-access.ts` + `modules/{suppliers,merchants,companies}/{service,routes}.ts` + `modules/directory/{service,routes}.ts` + `web/src/lib/types.ts` + `tests/sec04b-entity-read-access.test.ts` (**12/12** على PostgreSQL 16 معزول) + `docs/SEC-04B_ENTITY_READ_ACCESS.md` |
| **PERM-01A** | فصل الحارس العام `/api/admin` عن المكاتب المختصة: الحارس يتنازل صراحةً عن بادئات verification/trust/risk/disputes، ويُفرض كل مكتب بصلاحيته الدقيقة (`verification:review` / `trust:read` / `risk:read` / `dispute:review|manage`)؛ بقية `/api/admin/*` تبقى ADMIN/SUPER_ADMIN | `admin/routes.ts` (`isSpecializedDeskPath`) + `admin/engines-routes.ts` (أحراس لكل مكتب) + `perm01a-staff-desk-access.test.ts` (18 حالة) |
| **PERM-01A-UI** | الواجهة صارت صادقة مع الخادم: `StaffOnly` صار واعياً بالمكتب، وكتالوج التدقيق يوسم كل مكتب بالأدوار التي يقبلها الخادم فعلاً | `web/src/pages/AdminPages.tsx` (`STAFF_DESK_ROLES`) + `web/src/App.tsx` + `web/src/lib/demo-owner-catalog.ts` |
| **PERM-01B** | فصل صلاحيات المخزون: `inventory:read` (قراءة ضمن الملكية) و`inventory:read:all` (قراءة عبر كل البائعين — ADMIN فقط) و`inventory:update`/`inventory:movement:create` (كتابة — البائعون فقط)؛ القراءة والكتابة في `/api/inventory` صارا حارسين منفصلين؛ الكتابة تبقى مربوطة بالملكية فلا يستطيع ADMIN/SUPER_ADMIN تعديل مخزون تاجر | `shared/constants/permissions.ts` + `shared/constants/rbac.ts` + `server/modules/inventory/routes.ts` + `server/modules/inventory/service.ts` + `perm01b-inventory-product-permissions.test.ts` (15 حالة) |
| **PERM-01B-UI** | مواءمة الواجهة: ميزة `inventory.read` جديدة (تُمنح للبائعين ولـADMIN/SUPER_ADMIN)، و`inventory.manage` (كتابة) للبائعين فقط؛ أزرار المخزون (إضافة/خصم/إعدادات) تُخفى لمن لا يملك الكتابة؛ وكتالوج التدقيق يوسم المخزون بـ`inventory.read` | `web/src/lib/rbac.ts` + `web/src/pages/DashboardInventoryPages.tsx` + `web/src/lib/demo-owner-catalog.ts` |
| **PERM-01C** | توحيد حماية مسارات الكيانات (R1): `POST /api/{suppliers,merchants,companies}` تُحرس الآن بصلاحية RBAC (`*_create`) لا باسم الدور وحده — مع إبقاء التسجيل الذاتي (الدور المطابق)؛ `PATCH` تُحرس بـ`*_update`؛ إضافة جهة اتصال مورد بـ`supplier:update`؛ الملكية محفوظة (لا يتجاوزها ADMIN/SUPER_ADMIN). (R2) ربط `admin:reports` بسطح التقارير `/api/admin/analytics/reports` بدل مسار الضرائب (صار `admin:policies`). (R3) تصحيح probe التقارير في كتالوج التدقيق. (R6) إزالة ميزة `payment.view` الشبحية. (R4/R5) توثيق الصلاحيات غير المستخدمة ومصفوفة المكاتب — بلا حذف أو تغيير صلاحيات | `server/middleware/auth.ts` (`requireRoleOrPermission`) + `modules/{suppliers,merchants,companies}/routes.ts` + `modules/tax/routes.ts` + `modules/admin/analytics-routes.ts` + `web/src/lib/{rbac,demo-owner-catalog}.ts` + `tests/perm01c-rbac-cleanup.test.ts` (23 حالة) + `docs/PERM-01C_RBAC_CLEANUP.md` |
| PS-01* | طبقة Settlement حقيقية (`confirmSettlement`) — كاتب وحيد لـ`SETTLED` وقيد `SETTLEMENT`، ذرّية + idempotency بالمرجع | `settlements/service.ts:77-198` + `settlement-ledger.test.ts` |
| PS-02* | Payout للبائع (`createPayout`/`dispatch`/`sync`) — المبلغ مُشتق لا مُمرَّر | `payouts/service.ts` + `payout-engine.test.ts` + `payout-provider.test.ts` |
| PS-04* | Reconciliation مع المزوّد/البنك + Receipts | `reconciliation/*` + `reconciliation-engine.test.ts` |
| **PS-01** | Admin Finance Desk: سطح `/admin/finance` (5 تبويبات: settlement/payouts/reconciliation/receipts/providers) + 8 دوال api مطابقة + i18n (ar/fr/en/zh) + مسار محروس ADMIN/SUPER_ADMIN — بلا أي endpoint أو منطق خدمة جديد | `packages/web/src/pages/AdminFinancePages.tsx` + `e2e/admin-finance.spec.ts` + `docs/PS-01_ADMIN_FINANCE_DESK.md` + تحقّق حيّ على PostgreSQL 16 معزول (`wasit_test`): Backend **16/16** (`finance-routes.test.ts`) + E2E **10/10** (`admin-finance.spec.ts`) = **26 passed / 0 failed** |
| **PS-02** | Manual Payment Completion Desk (DEMO فقط): تبويب `manual` في `/admin/finance` يُتمّ دفع `manual`/offline عبر `applyPaymentSucceeded` نفسه (لا كاتب جديد)؛ بوّابات مغلقة (503 خارج DEMO، 409 لمزوّد غير `manual`، 422 بلا مرجع)؛ مسار محروس ADMIN/SUPER_ADMIN؛ `Paid ≠ Settled` (لا `SETTLEMENT`/`Payout`) + Audit `PAYMENT.MANUAL_COMPLETED` | `packages/server/src/modules/payments/service.ts` (`completeManualPayment`) + `packages/server/src/modules/finance/routes.ts` + `packages/web/src/pages/AdminFinancePages.tsx` + `docs/PS-02_MANUAL_PAYMENT_COMPLETION.md` + **تحقّق حيّ على PostgreSQL 16 معزول (`wasit_test`)**: Backend `manual-payment-completion.test.ts` **10/10** + بوّابات **4/4** + E2E `manual-payment-completion.spec.ts` **5/5** + تراجع PS-01 (`finance-routes` 16/16، `admin-finance` E2E 10/10) |
| **OBS-01** | مكتب فشل الـWebhooks: تبويب `webhooks` في `/admin/observability` يعرض أحداث FAILED/DEAD_LETTERED (بلا payload/توقيع)، مع ترقيم (offset + total)، وتأكيد قبل الفعل، وإعادة تشغيل محروسة بـ`REFUND_MANAGE` تكتب `PAYMENT.WEBHOOK_REPLAY` بهوية المشغّل (إصلاح `actorId` كان `NULL`). إعادة التشغيل تُعيد الحدث إلى `RECEIVED` بلا أي أثر مالي. | `packages/server/src/modules/payments/{routes,service}.ts` + `packages/server/src/lib/query.ts` + `packages/web/src/pages/AdminObservabilityPage.tsx` + `packages/web/src/lib/{api,types,i18n}.ts` + `packages/server/tests/p6-p7-dispute-webhook.test.ts` (19/19) + `e2e/admin-webhook-failures.spec.ts` (4/4) + `docs/OBS-01_WEBHOOK_FAILURES_REPLAY.md` + **تحقّق حيّ على PostgreSQL 16 معزول (`wasit_test`)**: Backend 887/887، E2E 226/226 |
| **AI-01** | جدولة الوكلاء: تنفيذ دوري حقيقي (`agent_schedules`) بدل طلب-استجابة فقط؛ مطالبة ذرّية بالعقد (`FOR UPDATE SKIP LOCKED`) تمنع التنفيذ المزدوج عبر النسخ؛ موافقة fail-closed؛ حدود ميزانية قبل الإنشاء؛ تدقيق بهوية `SYSTEM` (`audit_logs.actor_type`) مع إبقاء المهمة منسوبة لمنشئها؛ مسارات إدارة محروسة `AI_MANAGE|ADMIN_AI`. | `packages/server/src/modules/ai/scheduling.ts` + `packages/server/src/db/schema/agent_schedules.ts` + ترحيل `0027_melodic_lifeguard.sql` + `packages/server/src/lib/scheduler.ts` + `packages/server/src/lib/{audit.ts,ai/cost-control.ts}` + `packages/server/src/modules/admin/ai-routes.ts` + `packages/server/tests/ai01-agent-scheduling.test.ts` (**12/12**) + الحزمة الكاملة **899/899** + `docs/AI-01_AGENT_SCHEDULING.md` + **تحقّق حيّ** على PostgreSQL 16 معزول (`wasit-ai01-pg`) بنسختين متزامنتين (تنفيذ واحد فقط، تدقيق `SYSTEM`) |
| — | حرّاس المال محكمة: `/api/admin/finance|tax|analytics|privacy` كلها 403 لغير ADMIN/SUPER_ADMIN (تحقّق حيّ على 8 أدوار) | probe حيّ 2026-11-04 |
| **LC-06** | إلزام MFA للطاقم الداخلي: الأدوار `SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN` لا تحصل على جلسة ولا تصل أي سطح طاقم بلا عامل ثانٍ مُفعَّل؛ الحارس على كامل `/api/*` (استثناء `/api/auth`+`/api/health`)؛ تسجيل الدخول يعيد `staff_enrollment_required` ويُفتح عبر `/mfa/staff-enroll`+`/mfa/staff-confirm`؛ فحص حيّ لكل طلب بلا تجاوز SUPER_ADMIN؛ `STAFF_MFA_ENFORCEMENT=auto` في production فقط | `packages/server/src/middleware/mfa.ts` + `packages/server/src/app.ts` + `packages/server/src/modules/auth/{routes,service}.ts` + `packages/shared/src/constants/roles.ts` + `packages/server/tests/{staff-mfa-enforcement,staff-mfa-login}.test.ts` + `docs/SECURITY_MODEL.md` + **تحقّق حيّ على PostgreSQL 16 معزول (`wasit-lc06-pg`، `wasit_test`)**: `staff-mfa-login.test.ts` **13/13** + الحزمة الكاملة **1126/1126** (92 ملف) + Typecheck نظيف |
| **LC-07** | قفل الحساب بعد فشل دخول متكرر: بعد `MAX_LOGIN_ATTEMPTS` (5) كلمة مرور خاطئة متتالية يُقفل الحساب مؤقتاً `LOCKOUT_MINUTES` (15) عبر `locked_until` ثم يُفتح تلقائياً؛ العدّاد ذرّي (`failed_login_attempts + 1` في SQL) لا يفقد تحديثات تحت التزامن؛ **التصفير بعد اكتمال المصادقة كاملةً** (كلمة المرور + العامل الثاني) لا عند صحة كلمة المرور؛ **فشل TOTP لا يمسّ عدّاد كلمة المرور** (حماية مستقلة عبر `mfaChallenges.attempts` الذرّي + حدّ `MFA_CHALLENGE_MAX_ATTEMPTS` + TTL + أحادية الاستخدام)؛ رسالة موحّدة `Invalid credentials` (401) بلا كشف الوجود/الحالة + **موازنة زمن** عبر `DUMMY_ARGON2_HASH` بمعاملات مطابقة؛ يغطّي كل الأدوار بما فيها `SUPER_ADMIN`؛ لا يُتجاوَز عبر MFA؛ تدقيق `AUTH.ACCOUNT_LOCKED`/`AUTH.ACCOUNT_UNLOCKED` بلا أسرار | `packages/server/src/lib/lockout.ts` + `packages/server/src/lib/security.ts` (`DUMMY_ARGON2_HASH`) + `packages/server/src/modules/auth/service.ts` + `packages/server/tests/account-lockout.test.ts` (**19/19**) + `packages/server/tests/unit/{lockout-policy,security-timing,account-lockout-flow}.test.ts` (16/16) + `docs/SECURITY_MODEL.md` + **تحقّق حيّ على PostgreSQL 16 معزول (`wasit-lc07-pg`، `wasit_test`، `127.0.0.1:55440`)**: `account-lockout.test.ts` **19/19** + الحزمة الكاملة **1161/1161** (96 ملف) + Typecheck (server+web) نظيف؛ الموارد المؤقتة حُذفت |
| **SEC-CSRF-01** | حماية CSRF مركزية: رفض الطلبات المُغيِّرة للحالة (POST/PUT/PATCH/DELETE) التي تحمل كوكي الجلسة إن كان أصلها غير موثوق؛ قبول same-origin (`APP_URL`) أو المُدرَج في `CORS_ORIGIN`؛ `Referer` بديل عند غياب `Origin`؛ **رفض مغلق** عند غياب الدليل مع وجود الكوكي؛ رسالة `403` مقتضبة لا تكشف الأصل؛ لا مسارات مستثناة (تغطي المسارات الحسّاسة كـ`/api/admin/*`)؛ لا يمسّ الطلبات بلا كوكي (عملاء التوكن/webhooks الموقّعة)؛ الطرق الآمنة لا تُفحص؛ يتحكّم به `CSRF_PROTECTION=auto|on|off` (`auto` = production/staging) | `packages/server/src/middleware/csrf.ts` + `packages/server/src/lib/env.ts` (`CSRF_PROTECTION`) + `packages/server/src/app.ts` (بعد CORS وقبل routing) + `packages/server/tests/csrf.test.ts` (**21/21**) + `packages/server/tests/cors.test.ts` (**4/4**) + `docs/SECURITY_MODEL.md` (§3.1) + **تحقّق معزول بلا DB/Docker (WASIT-EXECUTION-005):** csrf 21/21 + cors 4/4 + secret-scan 3/3 + staff-mfa-enforcement 17/17 + Typecheck (server+web) نظيف |
| **PERM-01** | سياسة صلاحيات ADMIN للإيراد/التقارير: `revenue:read` تبقى **غير ممنوحة** لـADMIN (منع مقصود مُوثَّق ومُتحقَّق حياً)؛ `report:read` صلاحية بلا مسار تُوثَّق كـ«ميتة/مُسمّاة خطأً» (مكتب التقارير محروس بـ`admin:reports` الذي يملكه ADMIN)؛ لا تغيير مصفوفة ولا كود | `packages/shared/src/constants/{permissions,rbac}.ts` (مرجعية فقط، بلا تعديل) + `packages/server/src/modules/revenue/routes.ts` + `packages/server/tests/perm01-admin-revenue-report.test.ts` (**17/17** معزول بلا DB) + `docs/management/guide.html` §8 + `docs/PERM-01C_RBAC_CLEANUP.md` |
| **LC-02** | موافقة ملفات تعريف الارتباط والخصوصية: واجهة كاملة (banner + نافذة إعدادات + رابط دائم) بأربع فئات (Necessary/Preferences/Analytics/Marketing)؛ **بوّابة فعلية** على التتبّع التسويقي (`AdSlot` لا يجلب/يعرض/يرسل أي حدث قبل موافقة `marketing`)؛ تخزين على العميل بإصدار سياسة (`CONSENT_POLICY_VERSION`) وانتهاء (180 يوماً)؛ سحب الموافقة يحذف معرّف الإعلانات (`wasit.adSession`) **من localStorage وsessionStorage** ويعطّل التتبّع بلا مساس بالكوكيز الضرورية؛ دعم ar/en/fr/zh وRTL/LTR | `packages/web/src/lib/cookie-consent.ts` + `packages/web/src/lib/consent-context.tsx` + `packages/web/src/components/CookieConsent.tsx` + `packages/web/src/components/AdSlot.tsx` + `packages/web/src/lib/i18n.ts` + `packages/web/src/{main.tsx,App.tsx}` + `packages/web/src/components/layouts/{PublicLayout,AppSidebar}.tsx` + `packages/web/tests/{cookie-consent,consent-enforcement}.test.ts` (**34/34** معزول بلا DB/DOM) + `e2e/cookie-consent.spec.ts` + `playwright.cookie.config.ts` (**E2E متصفّح بلا DB: 8/8**) + `docs/LC-02_COOKIE_CONSENT.md` |
| **LC-03** | سياسة السلع المحظورة/المقيّدة + مراجعة امتثال بشرية: مصنّف مركزي بأولوية `PROHIBITED>RESTRICTED>ALLOWED` وتطبيع مقاوم للتحايل ومطابقة كلمة كاملة؛ **نقطة إنفاذ واحدة** في خدمة المنتجات (محظور → 422 `PROHIBITED_GOODS` بلا كتابة؛ مقيّد → مسودّة غير منشورة؛ منع التفعيل → 422 `RESTRICTED_GOODS_REVIEW_REQUIRED`؛ إعادة تصنيف الناتج عند التعديل)؛ بوّابة نشر بشرية بصلاحية `catalog:compliance:review` (غير ممنوحة لأي وكيل AI)؛ تدقيق كامل؛ **بلا Migration** | `packages/server/src/lib/prohibited-goods.ts` + `packages/server/src/modules/products/{service,routes}.ts` + `packages/shared/src/errors/api-error.ts` + `packages/shared/src/constants/{permissions,rbac}.ts` + `packages/server/tests/lc03-{prohibited-goods-policy,enforcement,review-authorization}.test.ts` (**26/26** معزول بلا DB) + `packages/server/tests/lc03-prohibited-goods.test.ts` (**4/4**) + `docs/LC-03_PROHIBITED_GOODS.md` + **تحقّق حيّ على PostgreSQL 16 معزول (`wasit-lc03-pg`، `wasit_test`، `127.0.0.1:55433`)**: `lc03-prohibited-goods.test.ts` **4/4** + 26/26 معزول + Typecheck (server+web) نظيف؛ الموارد المؤقتة حُذفت |
| **PR-05** | حاسبة الأعمال `/tools/calculator`: صفحة عامة `BusinessCalculatorPage` + منطق صرف معزول يعكس نموذج رسوم الطلب (عمولة البائع على المجموع، عمولة المشتري تُضاف لإجمالي المشتري، رسوم الدفع على البائع، `sellerNet = المجموع − عمولة البائع − رسوم الدفع`)، بنسب افتراضية قابلة للتعديل موسومة كسياسة القاعدة؛ رفض المدخلات غير الصالحة؛ i18n في اللغات الأربع | `packages/web/src/lib/business-calculator.ts` + `packages/web/src/pages/BusinessCalculatorPage.tsx` + `packages/web/src/{App.tsx,components/layouts/PublicLayout.tsx,lib/i18n.ts}` + `packages/web/tests/business-calculator.test.ts` (**10/10** معزول بلا DB/DOM) + `e2e/business-calculator.spec.ts` (**4/4** متصفّح حقيقي بلا DB عبر `playwright.tools.config.ts`) |
| B1 | SEO: sitemap/robots/JSON-LD | `seo.test.ts` (10) |
| B2 | Email/SMS إنتاجي | `sms.test.ts` (17) + `mail.test.ts` (9) |
| B7 | دورة فواتير الاشتراك + التحصيل | `subscriptions-collection.test.ts` (18) |
| B10 | Price Comparison Engine | `price-comparison.test.ts` (9) |
| B12 | إدارة/إنهاء الجلسات | `e2e/security-sessions.spec.ts` |
| B14 | آلة حالة الحملات + منع البائع من رفع الإيقاف الإداري | `product-suspension.test.ts` + `ads` E2E |
| C1 | Rate limiting موزّع (memory/postgres) | `rate-limit.test.ts` (12) |
| C2 | Observability: trace/metrics/logs/alerts | `observability.test.ts` (23) |
| C4 | MFA UI E2E + تحدّي الدخول | `mfa-login-challenge.test.ts` (10) |
| C5 | Anti-Fee-Evasion | `fee-evasion.test.ts` (10) |

`*` = الـBackend مُغلق، وكان السطح الإداري مفتوحاً تحت PS-02 في القسم 2. أُغلق سطح PS-01 بـDOC-PS01-CLOSE، وسطح PS-02 (إتمام الدفع اليدوي، DEMO) بـDOC-PS02-CLOSE (تحقّق حيّ 45/45) — فلم يبقَ سطح إداري مفتوح تحت PS-02. (بند PS-02* للـPayout يبقى بخلفيته فقط؛ «Payout للبائع» كتحويل فعلي يتبع PS-03.)

---

## 7. فجوات كاذبة (FALSE GAPS) — مُستبعدة بتصميم

- **Wallet/رصيد داخل المنصّة**: غير مطلوب — WASIT وسيط تجاري فقط.
- **تخزين بيانات البطاقات/PCI**: خارج النطاق (redirect إلى مزوّد مرخّص).
- **إصدار فواتير ضريبية**: يوفّره المزوّد.
- **WASIT AI Copilot**: اختياري صراحةً في `AI_ARCHITECTURE.md` §6.5.
- **Push notifications**: تُحلّ بمزوّد خارجي.
- **«نحتاج موظّفين»**: مرفوض كحل افتراضي — لكل فجوة مسار Software/Agent/Provider.

---

## 8. الاعتماديات الخارجية (BLOCKED — تحتاج عقوداً/موافقات)

| البند | ما يحتاجه |
| --- | --- |
| PS-03 | تأكيد/عقد مزوّد دفع على قدرة **Split / Sub-merchant** (iPay/ClicToPay/Flouci) |
| PS-06 | توثيق/عقد استرداد ClicToPay (SPS reversals) |
| LC-01/LC-03/LC-04 | صياغة قانونية معتمدة |
| LC-05 | عقد مزوّد KYC/KYB |
| PI-03/PI-09 | وجهة نسخ خارجية + مفاتيح إنتاجية |
| BU-01/BU-02 | عقد مزوّد دفع + حساب تسوية بنكي |
| BU-04 | موردون/مشترون حقيقيون |

---

## 9. سجل التنفيذ

| التاريخ | البند | الإجراء | النتيجة |
| --- | --- | --- | --- |
| 2026-11-22 | AI-03 | **أتمتة مساعد النزاعات:** `modules/disputes/assistant.ts` (طلب عند الفتح بلا مالك وهمي، إنشاء عند تعيين مراجع مخوّل، دورة تعيين + `dedupe_key` + إلغاء مهام الدورة السابقة، فشل لا يعطّل النزاع، Audit لكل مرحلة) + `AgentTaskOrigin` في `createAgentTask` (رابط موثوق يُحقن بعد إسقاط مفاتيح الطالب) + حارس تنفيذ يعتمد `requestedBy` من سياق التشغيل + مساران إداريان (`GET .../assistant`, `POST .../assistant/retry`) + بطاقة في `AdminDisputesPage`. **بلا Migration/Seed، بلا صلاحية جديدة، بلا قرار آلي.** الأدلة: `afc08-dispute-assistant-automation` **12/12** + تراجع النزاعات والوكلاء **61/61** + الحزمة الكاملة **2209/2209** (173 ملفًا، EXIT=0) + Typecheck (server+web) exit 0. | **COMPLETED** ✅ |
| 2026-11-20 | AI-10 | **إعادة بناء `dispute-assistant` على نزاع واحد:** `modules/ai/dispute-summary.ts` (منطق صرف) + إعادة كتابة `execDisputeAssistant` (وضع `summary` بـ`disputeId` ووضع `triage` بلا نصوص) + `disputePolicySnapshot()` في خدمة النزاعات (قراءة بلا كتابة) + حقن `__disputePolicy` في `createAgentTask` مع إسقاط قيمة الطالب + توسيع عقد A2 (evidence/events/appeals/orders، قراءة فقط). **بلا Migration/Seed، بلا صلاحية جديدة.** الأدلة: `unit/dispute-summary` **23/23** + `ai-dispute-assistant` **12/12** (عزل A/B، لا كتابة، رفض CUSTOMER/SUPPORT قبل أي صف، نزاع مجهول ⇒ `failed`) + تراجع AI **101/101** + الحزمة الكاملة **2197/2197** (172 ملفًا، EXIT=0) + Typecheck exit 0. | **COMPLETED** ✅ |
| 2026-11-08 | SEC-011.4 (011.4) | **تحقّق (011.4):** `sec0114-rate-limit-resource.test.ts` **16/16** على PostgreSQL 17 معزول `wasit_test` (سقف جسم 413، حدّ عام 429+`Retry-After`، استثناءات، AI لكل مستخدم+IP، بحث، فيديو، سقف المهام، **XFF لا يحرّك الدلو**، **fail-closed 503**، `Semaphore`) + تراجع `security-privacy`(19)/`rate-limit`(12)/`client-ip`(32)/`marketing-video`(86) + الحزمة الكاملة **1374/1374** (110 ملف، EXIT=0؛ تشغيل سابق أظهر `read-cache` عابراً) + Typecheck (server) exit 0. **بلا Migration/Seed.** | **COMPLETE_VERIFIED** ✅ |
| 2026-11-08 | SEC-011.4 (011.4) | **تنفيذ حماية الموارد:** `middleware/rate-limit.ts` (موضوع auto/user/ip + `Retry-After` + fail-closed + مستثنى) · `middleware/body-limit.ts` (413) · `lib/concurrency/semaphore.ts` · ربط `app.ts` بعد CSRF · سقف المهام الفعّالة في `modules/ai/agents.ts` · `RATE_LIMIT_*`/`MAX_REQUEST_BODY_BYTES`/`MEDIA_VIDEO_*`/`AI_AGENT_MAX_ACTIVE_TASKS_PER_USER` في `env.ts` · `ApiError.payloadTooLarge/tooManyRequests` · توثيق `.env.example` ودليل البيئة. **بلا Migration/Seed.** | **IMPLEMENTED** |
| 2026-11-08 | SEC-XFF-01 (011.3) | **قائمة وكلاء صريحة:** إضافة `lib/net/cidr.ts` (تحليل/مطابقة CIDR بلا اعتماديات، IPv4/IPv6/IPv4-mapped، حدود دقيقة) + `TRUSTED_PROXY_CIDRS` (فارغ افتراضياً) في `env.ts`؛ إعادة صياغة `isTrustedPeer` لتثق **فقط** بشبكة مُدرَجة صراحة (إلغاء الثقة الضمنية بـloopback/RFC1918/ULA)؛ `canonicalIp` لتوحيد IPv4-mapped؛ إبقاء fail-closed و`user:<id>`. توثيق `.env.example` ودليلَي النشر/البيئة + سجل الفجوات. **بلا Migration/Seed.** | **COMPLETE_VERIFIED** — `client-ip.test.ts` **32/32** + تراجع متعلّق + Typecheck (server+web) نظيف ✅ |
| 2026-11-08 | SEC-XFF-01 (011.2) | **إغلاق تزوير Client IP:** تشخيص أثبت أن الـruntime (`@hono/node-server` 1.19.17) يكشف عنوان مقبس TCP الحقيقي عبر `getConnInfo` (إثبات حيّ: `::ffff:127.0.0.1`)، وأن XFF/X-Real-IP قابلان للتزوير من عميل مباشر. وحدة مركزية `lib/net/client-ip.ts` + `TRUSTED_PROXY_HOPS` (افتراضي 0) + ربط `core.ts`/`rate-limit.ts`؛ توثيق `.env.example` ومتطلبات Nginx (تمرير XFF، وصول الـorigin عبر الوكيل فقط). **بلا Migration/Seed.** | **COMPLETE_VERIFIED** — `client-ip.test.ts` **18/18** + تراجع متعلّق **140/140** + Typecheck (server+web) نظيف ✅ |
| 2026-11-07 | LC-02 | تنفيذ موافقة الكوكيز: منطق قرار صرف (`cookie-consent.ts`) + مزوّد React (`consent-context.tsx`) + واجهة (banner/إعدادات/رابط دائم) + **بوّابة فعلية على تتبّع الإعلانات** (`AdSlot`) + i18n ar/fr/en/zh | IMPLEMENTED |
| 2026-11-07 | LC-02 | تحقّق معزول بلا DB/DOM: `cookie-consent.test.ts` **18/18** + `consent-enforcement.test.ts` **11/11** = **29/29**؛ Typecheck (web) + Build نظيفان؛ `e2e/cookie-consent.spec.ts` (8 حالات) مكتوب ولم يُشغَّل (لا DB/Docker) | **IMPLEMENTED_UNVERIFIED** — تحقّق المتصفّح مطلوب |
| 2026-11-07 | LC-02 | تصحيح الحالة (WASIT-EXECUTION-007.1): من `COMPLETE_VERIFIED` إلى **`IMPLEMENTED_UNVERIFIED`** بما يوافق الأدلة (E2E غير مُشغَّل)؛ إعادة LC-02 إلى «المفتوحة» | المفتوحة = 19، المغلقة = 29 (بلا تغيير عن ما قبل 007) |
| 2026-11-07 | LC-02 | E2E متصفّح حقيقي بلا DB (WASIT-EXECUTION-007.2): إعداد `playwright.cookie.config.ts` (تطبيق Vite حقيقي + اعتراض `/api/**` + Chromium النظام) وتصحيح الاختبار؛ **7/8 نجحت** | تحقّق جزئي |
| 2026-11-07 | LC-02 | كشف **عيب إنتاج**: سحب `marketing` لا يحذف `wasit.adSession` (sessionStorage) لأن `persist()` يمرّر localStorage فقط؛ الحالة تبقى `IMPLEMENTED_UNVERIFIED` | لم يُغلَق |
| 2026-11-07 | LC-02 | إصلاح 007.3 (كود إنتاج في `packages/web/src/lib/consent-context.tsx` فقط): تمرير `getSessionStorage()` إلى `applyConsentTransition` في `persist()`؛ +5 حالات وحدة (34/34) | IMPLEMENTED |
| 2026-11-07 | LC-02 | تحقّق نهائي: E2E متصفّح بلا DB **8/8** + وحدة 34/34 + Typecheck + Build؛ إثبات الضرورة بإعادة الحالة (فشل بلا الإصلاح/نجاح معه) | **COMPLETE_VERIFIED (تقني)** — المفتوحة 19→18، المغلقة 29→30 |
| 2026-11-07 | LC-03 | **تصميم وتنفيذ سياسة السلع المحظورة/المقيّدة:** مصنّف مركزي `lib/prohibited-goods.ts` (`GOODS_RULES` بـ9 فئات، `normalizeForMatch` مقاوم للتحايل، `classifyListing` بأولوية PROHIBITED>RESTRICTED>ALLOWED، مطابقة كلمة كاملة) + نقطة إنفاذ واحدة `enforceListingPolicy` في `modules/products/service.ts` مربوطة في `createProduct`/`updateProduct`/`updateProductStatus` + `reviewRestrictedListing`؛ رمزا خطأ جديدان (`PROHIBITED_GOODS`, `RESTRICTED_GOODS_REVIEW_REQUIRED`) في `@wasit/shared`؛ صلاحية `catalog:compliance:review` لـADMIN/SUPER_ADMIN فقط؛ مساران `GET /api/products/compliance/queue` و`POST /api/products/:id/compliance-review`. **بلا Migration** (العلامة في `products.tags` غير المستخدَم + `audit_logs`) | IMPLEMENTED |
| 2026-11-07 | LC-03 | **اختبارات بلا DB (مُشغَّلة):** `lc03-prohibited-goods-policy` **10/10** + `lc03-enforcement` **12/12** (خدمة حقيقية على `DB` وهمي في الذاكرة) + `lc03-review-authorization` **4/4** = **26/26 ✅** (`vitest.lc03.config.ts`)؛ تراجع `tests/unit` **90/90** و`web` **34/34**؛ Typecheck (server+web) نظيف. **غير مُشغَّل:** `tests/lc03-prohibited-goods.test.ts` (4 حالات HTTP حقيقية) — يحتاج PostgreSQL/Docker (غير متوفّر وبلا تصريح) | IMPLEMENTED_UNVERIFIED — يبقى ضمن «المفتوحة» (18/30 بلا تغيير) |
| 2026-11-07 | LC-03 (008.1) | **تحقّق متكامل على PostgreSQL 16 مؤقتة معزولة:** حاوية `wasit-lc03-pg` (`postgres:16-alpine`, منفذ loopback `127.0.0.1:55433` فقط, قاعدة `wasit_test` فارغة, بيانات اصطناعية). أُثبت العزل: لا اتصال بـ DEMO/production، ولا شيء على 5432، ولا إعادة استخدام أي حاوية/volume. شُغّلت migrations + seed داخل القاعدة المؤقتة **فقط**. `tests/lc03-prohibited-goods.test.ts` **4/4 ✅** (رفض المحظور عبر HTTP بلا إدراج + حفظ المقيّد كمسودّة غير منشورة + منع النشر دون مراجعة مخوّلة + نجاح قرار المراجعة البشرية). **إصلاح داخل LC-03 فقط:** خطأ في مُساعد الاختبار (`login.data.data.user.id` → `login.data.data.id`؛ الـ`login` يعيد المستخدم مباشرةً). لا تغيير في كود الإنتاج | COMPLETE_VERIFIED |
| 2026-11-07 | LC-03 (008.1) | **تراجع + TypeScript:** `lc03-*` معزول **26/26 ✅** + Typecheck (server+web) نظيف ✅. **تنظيف:** حُذفت الحاوية + الصورة `postgres:16-alpine` + الـvolume + الـdaemon المؤقت ومجلداته (`/var/lib/wasit-docker-data`، `/run/wasit-docker`، `/var/log/wasit-dockerd*.log`)؛ لا containers/images/volumes متبقّية؛ لا عمليات/منافذ اختبار؛ DEMO/production لم تُلمسا. **M0:** أُعيد حساب `sha256(repo.bundle)` فعلياً = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، العدّات قبل/بعد متطابقة (78/71/0) → LC-03 **COMPLETE_VERIFIED**؛ المفتوحة 19→18، المغلقة 29→30 | COMPLETE_VERIFIED |
| 2026-11-07 | LC-04 (009.1) | **تكامل الـRefund المالي — لا نجاح بلا إثبات خارجي:** فصل الطلب عن الإتمام في `createRefund` (يكتب `REQUESTED`/`PROCESSING` فقط)؛ **كاتب الإتمام الوحيد** `completeRefundWithEvidence` (معاملة + قفل `FOR UPDATE` + idempotency) يكتب `COMPLETED` + قيد `REFUND` DEBIT/PENDING + عكس العمولة/الرسم + حالة الطلب؛ مسند الثقة `canProveRefund` + مطابقة `evidenceMatchesRefund` في `lib/payments/refund-integrity.ts` (يرفض كل مزوّد demo/غير متاح)؛ `applyRefundSucceeded` يرفض webhook `REFUND_SUCCEEDED` من مزوّد عرض (422)؛ سجل التدقيق يحمل `evidenceSource`/`evidenceRef`/`evidenceVerified`. **بلا Migration.** تحديث 3 اختبارات قائمة ترمّز السلوك القديم (`payments`, `money-path-invariants`, `p6-p7-dispute-webhook`) | IMPLEMENTED |
| 2026-11-07 | LC-04 (009.2) | **الأُطُر التشغيلية للنزاع (بلا تغيير على محور المال):** `responseWindowDays` في `disputeRulesSchema` + `seed.ts`؛ مُهل مشتقّة من السياسة في `lib/disputes/deadlines.ts` (نقي بلا DB، حدود شاملة، بلا قيم سالبة)؛ فرض نوافذ الفتح/الأدلة (409)؛ **`withdrawDispute`** كاتب السحب الوحيد (فاتح النزاع فقط، قبل قرار فقط، ذرّي ⇒ CLOSED + حدث + تدقيق `DISPUTE.WITHDRAWN`)؛ تنحّي أطراف الطلب عن البتّ (403) وتنحّي مصدر القرار الأصلي عن مراجعة استئنافه (403)؛ إخفاء بريد الطرف الآخر عن غير الموظفين (`maskEmail`/`visibleEmail`)؛ سطح عام `GET /api/public/disputes/refund-policy` (بلا جلسة، بلا بيانات قضية، بلا `decisionEffects`، `operationalSummaryOnly=true`)؛ واجهة الويب: مُهل + زر سحب + مفاتيح i18n (ar/fr/en/zh). **بلا Migration.** | IMPLEMENTED |
| 2026-11-07 | LC-04 (009.2) | **تحقّق معزول:** PostgreSQL 17 مؤقت (`wasit_test`). `tests/lc04-dispute-rails.test.ts` **9/9 ✅** (تكامل: رفض فتح نزاع بعد نافذة الفتح، إغلاق نافذة الأدلة، سحب الفاتح فقط + رفض المكرر/بعد القرار، تنحّي طرف الطلب عن البتّ، إخفاء بريد الطرف الآخر عن الطرف وإظهاره للموظف، سطح السياسة العام + تجاوز الدولة + رمز مجهول) + `tests/lc04-dispute-deadlines.test.ts` **9/9 ✅** (نقي بلا DB: قراءة السياسة، حدود شاملة، تقييم المُهل). الحزمة الكاملة **1241/1241 ✅** (105 ملف)؛ Typecheck (server+web) نظيف. **M0:** `sha256(repo.bundle)` = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، لا حذف، لا commit/push. الجزء **القانوني** من LC-04 يبقى اعتماداً خارجياً مفتوحاً تحت LC-01 | COMPLETE_VERIFIED (الأُطُر التشغيلية) |
| 2026-11-07 | LC-04 (009.3) | **إنفاذ المتطلبات المتبقية (تحقّق مستقل + إغلاق 3 فجوات إنفاذ):** (1) رفض `DECIDED` من مسار الحالة (409) — لا قرار بلا `decidedBy`/`decidedAt`/أثر مالي؛ البتّ عبر `decideDispute` فقط؛ أُزيل من قائمة انتقالات الحالة ومن اختيار واجهة الإدارة. (2) **إنفاذ `responseWindowDays`:** الطرف المقابل (غير الفاتح/المُسنَد/الموظف) يُرفض ردّه (409) بعد انتهاء نافذة الردّ؛ الفاتح والموظفون يبقون مفتوحين. (3) **إنفاذ `autoEscalateDays`:** `escalateOverdueDisputes` مسح idempotent وآمن عبر النسخ (`UPDATE` شرطي) + حدث `STATUS_CHANGED` + تدقيق `DISPUTE.AUTO_ESCALATED` بـ`actorType=SYSTEM`؛ مربوط بالمجدول (`DISPUTE_ESCALATION_ENABLED=false` افتراضياً) وبمسار `POST /api/admin/disputes/escalate-overdue` (`dispute:manage`). **بلا Migration.** | IMPLEMENTED |
| 2026-11-07 | LC-04 (009.3) | **تحقّق معزول:** PostgreSQL مؤقت (`wasit_test`). `tests/lc04-dispute-enforcement.test.ts` **6/6 ✅** (تكامل HTTP+DB: رفض DECIDED عبر الحالة + البتّ الحقيقي عبر decide؛ إنفاذ نافذة الردّ للطرف المقابل؛ تصعيد idempotent + تدقيق SYSTEM؛ عدم تصعيد المبتوت؛ تصعيد واحد تحت مسحَين متزامنَين؛ مسار المشغّل 403/401/200) + `tests/lc04-dispute-deadlines.test.ts` **11/11 ✅**؛ الحزمة الكاملة **1249/1249 ✅** (106 ملف)؛ Typecheck (server+web) نظيف. **M0:** `sha256(repo.bundle)` = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، لا حذف، لا commit/push. الجزء القانوني يبقى مفتوحاً تحت LC-01 | COMPLETE_VERIFIED (إنفاذ المتطلبات) |
| 2026-11-07 | LC-01 (010) | **جاهزية تقنية دون إغلاق:** كتالوج وثائق (9، إصدارات، `LEGAL_REVIEW_REQUIRED`) + تسجيل موافقة على إصدار + كشف إعادة الموافقة + أسطح عامة (`/api/public/legal/documents[/:code]`) وسطح مستخدم (`/api/legal/acceptances`) + صفحة `/legal` ورابط التذييل + **حق التصحيح** `PATCH /api/privacy/me`. **بلا Migration.** مسودّات في `docs/legal/`. **العدّ بلا تغيير (18/30)** لأن النصّ المعتمد يبقى اعتماداً خارجياً | IMPLEMENTED (الجاهزية التقنية) |
| 2026-11-07 | LC-01 (010.1) | **بنية الموافقة + بوابة إلزامية (مطفأة):** سجل الموافقات `GET /api/legal/acceptances/history` + `listLegalAcceptances`؛ مخطط قبول **صارم** يرفض أي حقل هوية مُنتحَل (422) — لا قبول نيابة عن الغير؛ **بوّابة إلزامية** `requireLegalAcceptance()` مثبّتة على كل `/api` في `app.ts`، **مطفأة افتراضياً** (`LEGAL_ACCEPTANCE_ENFORCEMENT=off`) ولا تحجب إلا عند وجود وثيقة **منشورة وسارية** (`isAcceptable`)، ومعفاة على `/api/auth`/`/api/health`/`/api/legal`/`/api/public/legal`؛ رمز خطأ `LEGAL_ACCEPTANCE_REQUIRED` (403)؛ واجهة `/dashboard/legal` متعددة اللغات (ar/en/fr/zh) + رابط الشريط الجانبي؛ توثيق `docs/LC-01.1_LEGAL_CONSENT_INFRASTRUCTURE.md` + `docs/LC-01_LEGAL_INFO_REQUIRED.md`. **بلا Migration** (تُستخدم `consents`/`consent_events`/`audit_logs`). **العدّ بلا تغيير (18/30)** لأن جوهر الفجوة (النصّ المعتمد) اعتماد خارجي | IMPLEMENTED (بنية الموافقة) |
| 2026-11-07 | LC-01 (010.1) | **تحقّق معزول:** PostgreSQL 17 مؤقت (`wasit_test`). `tests/lc011-legal-consent-gate.test.ts` **14/14 ✅** (بلا DB لمعظمها: منطق القرار النقي + ترتيب التثبيت الحقيقي + الحجب 403) + `tests/lc01-legal-framework.test.ts` **27/27 ✅** (تكامل HTTP+DB: السجل/الإصدار/التوقيت، العزل بين المستخدمين، رفض التزوير 422، عدم حجب التسجيل/الدخول، الفصل عن Cookies/التسويق)؛ الحزمة الكاملة للخادم **1290/1290 ✅** (108 ملف)؛ الويب **35/35 ✅** (3 ملفات)؛ Typecheck (server+web) نظيف؛ بناء الويب ✅. **M0:** `sha256(repo.bundle)` = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، لا حذف، لا commit/push. الجزء **القانوني** (النصّ المعتمد) يبقى اعتماداً خارجياً مفتوحاً | COMPLETE_VERIFIED (بنية الموافقة) |
| 2026-11-07 | LC-04 (009.1) | **تحقّق معزول:** PostgreSQL 17 مؤقت (`wasit_test`، `127.0.0.1:5432`، `DEMO_PAYMENT_MODE=true`، مزوّد `manual`). `npx vitest run --config vitest.lc04.config.ts` **11/11 ✅** (5 بلا DB + 6 تكامل: منع نجاح مزوّد العرض/رفض webhook العرض/الإتمام بإثبات فقط/رفض إثبات مبلغ مختلف/إتمام مرتين idempotent/تدقيق مصدر الإثبات). الحزمة الكاملة **1223/1223 ✅** (103 ملف). Typecheck (server) نظيف. **M0:** `sha256(repo.bundle)` = `e731e684…fa8694` (مطابق). **Git:** HEAD `a5391a5…` بلا تغيير، staged=0، لا حذف، لا commit/push. الجزء **القانوني** من LC-04 (نصوص Refund/Dispute Policy المنشورة) يبقى **اعتماداً خارجياً مفتوحاً** تحت LC-01 | COMPLETE_VERIFIED (محور التكامل المالي) |
| 2026-11-04 | — | إعادة تحقّق كامل من الكود + خط أساس اختبارات (780/780) | تم |
| 2026-11-04 | SEC-01/SEC-02 | الإصلاح: استبدال قائمة الأدوار اليدوية بـ`hasProductManageAuthority` (RBAC `product:manage`) في المسارات الثلاثة | COMPLETED |
| 2026-11-04 | SEC-01/SEC-02 | 4 حالات Regression جديدة في `product-suspension.test.ts` (8/8 ناجحة)؛ الحزمة الكاملة 784/784؛ Typecheck نظيف | COMPLETED |
| 2026-11-04 | SEC-01/SEC-02 | إثبات أن الاختبار الجديد يفشل على الكود القديم (`expected 200 to be 403`) ثم ينجح بعد الإصلاح | تم |
| 2026-11-04 | PERM-01A | تحديد تناقض UI↔Backend: الحارس العام لـ`/api/admin` يمنع SUPPORT/RISK/DISPUTE من مكاتبهم المختصة | تم |
| 2026-11-04 | PERM-01A | الإصلاح: الحارس العام يتنازل عن بادئات المكاتب الأربعة؛ كل مكتب يُفرض بصلاحيته الدقيقة في `engines-routes.ts` | COMPLETED |
| 2026-11-04 | PERM-01A | مواءمة الواجهة: `StaffOnly` واعٍ بالمكتب + كتالوج التدقيق يوسم كل مكتب بأدواره الحقيقية | COMPLETED |
| 2026-11-04 | PERM-01A | 18 حالة Regression جديدة؛ الحزمة الكاملة 814/814 (71 ملف)؛ Typecheck نظيف | COMPLETED |
| 2026-11-04 | PERM-01B | تحديد التناقض: ADMIN بلا صلاحية مخزون خادم رغم ظهور الرابط، و`inventory.manage` ممنوحة له خطأً في الواجهة | تم |
| 2026-11-04 | PERM-01B | الإصلاح: فصل قراءة/كتابة المخزون (`inventory:read` / `inventory:read:all` / `inventory:update` + `inventory:movement:create`) وإضافة نطاق قراءة إداري في المسار | COMPLETED |
| 2026-11-04 | PERM-01B | مواءمة الواجهة: `inventory.read` للبائعين وADMIN، و`inventory.manage` للبائعين فقط؛ إخفاء أزرار الكتابة لمن لا يملكها | COMPLETED |
| 2026-11-04 | PERM-01B | 15 حالة Regression جديدة؛ إثبات فشل 3 منها على الكود القديم؛ الحزمة الكاملة 829/829 (72 ملف)؛ Typecheck نظيف | COMPLETED |
| 2026-11-04 | PERM-01C | تحديد الفخ: `*_create` حصرية لـSUPER_ADMIN بينما التسجيل الذاتي يحتاجها للبائع → خلط اسم الصلاحية بالسلوك | تم |
| 2026-11-04 | PERM-01C | R1: `requireRoleOrPermission(role, permission)` على إنشاء الكيانات (تسجيل ذاتي + حامل الصلاحية)؛ `PATCH` بـ`*_update`؛ contacts بـ`supplier:update`؛ الملكية محفوظة | COMPLETED |
| 2026-11-04 | PERM-01C | R2: `admin:reports` → سطح التقارير؛ مسار الضرائب → `admin:policies` | COMPLETED |
| 2026-11-04 | PERM-01C | R3: probe التقارير في كتالوج التدقيق صُحّح؛ R6: إزالة `payment.view` الشبحية | COMPLETED |
| 2026-11-04 | PERM-01C | R4/R5: توثيق 50 صلاحية غير مستخدمة + مصفوفة المكاتب (بلا حذف/تغيير صلاحيات) | COMPLETED |
| 2026-11-04 | PERM-01C | 23 حالة Regression جديدة (منها فشل مُثبت على الكود القديم: `expected 403 to be 201`)؛ الحزمة الكاملة **852/852 (73 ملف)**؛ Typecheck نظيف (server+web) | COMPLETED |
| 2026-11-05 | SEC-04A | تدقيق قراءة فقط: 11 مسار GET (6 كيانات بلا حارس + 5 دليل)؛ تصنيف 1 CRITICAL + 2 HIGH + 4 MEDIUM + 4 LOW؛ `GET /api/companies/:id` يكشف `taxId/registrationNumber` علناً | تم |
| 2026-11-05 | SEC-04B | تنفيذ الإصلاح: إسقاط عام موحّد (`*_PUBLIC_FIELDS`)؛ `contacts`/`taxId`/`registrationNumber` للمالك/الموظف (`user:read`) فقط؛ 404 لغير النشط؛ حجب PII الدليل عن غير الموظف | IMPLEMENTED |
| 2026-11-05 | SEC-04B | 39 ثابتاً أمنياً ساكناً شُغّلت فعلياً (بلا DB) → كلها ناجحة؛ Typecheck (server+web) + Build (server+web) نظيفان | COMPLETED |
| 2026-11-05 | SEC-04B | 9 حالات تكامل مكتوبة في `sec04b-entity-read-access.test.ts` — كان تشغيلها متوقّفاً (لا PostgreSQL، daemon Docker متوقف) | كان BLOCKED |
| 2026-11-05 | SEC-04B | التحقق الفعلي بإذن: PostgreSQL 16 مؤقت معزول (`wasit-sec04b-pg`، قاعدة `wasit_test`)؛ `npx vitest run tests/sec04b-entity-read-access.test.ts` → **12/12** (بعد إصلاح عيب في دالة مساعدة داخل الاختبار نفسه)؛ الحاوية حُذفت وDocker أُوقف | **COMPLETED — 12/12 tests passed** |
| 2026-11-05 | SEC-04B | إغلاق توثيقي (DOC-SEC04B-CLOSE): تحديث §2 (IN_PROGRESS→COMPLETED)، §6 (20→21)، §1 (المغلقة 20→21، المفتوحة 26)، §9 — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | PS-01 | تنفيذ سطح `/admin/finance`: صفحة `AdminFinancePages.tsx` (5 تبويبات)، مسار محروس `RequireAuth`+`AdminOnly`، 8 دوال api مطابقة لمسارات `/api/admin/finance` 1:1، أنواع DTO، مفاتيح `adminFin.*` في ar/fr/en/zh، رابط الشريط الجانبي، وحدة التدقيق — بلا أي endpoint أو منطق خدمة جديد | IMPLEMENTED |
| 2026-11-06 | PS-01 | Typecheck (server+web) + Build (server+web) نظيفان؛ 11 حالة E2E مكتوبة في `e2e/admin-finance.spec.ts` (وصول 401/403، تسوية بمرجع/بلا مرجع، دفعة CREATED→PROCESSING بلا COMPLETED، رفض معاملة غير مُسوّاة، مواءمة، إيصال) | COMPLETED (بلا DB) |
| 2026-11-06 | PS-01 | تشغيل الاختبارات الفعلي متوقّف: لا PostgreSQL أصلي وdaemon Docker متوقف، والقيود تمنع تشغيلهما دون موافقة صريحة | BLOCKED |
| 2026-11-06 | PS-01 | تحديث §2 (PENDING→IN_PROGRESS) و§1 (المفتوحة 26→25)؛ إضافة `docs/PS-01_ADMIN_FINANCE_DESK.md` — لم يُدَّعَ أي نجاح تشغيلي | IN_PROGRESS |
| 2026-11-06 | PS-01 | التحقق الفعلي بإذن: PostgreSQL 16 مؤقت معزول (`wasit-ps01-pg`، قاعدة `wasit_test`)؛ Backend `npx vitest run tests/finance-routes.test.ts` → **16/16**؛ E2E `npm run test:e2e -- e2e/admin-finance.spec.ts` → **10/10**؛ الإجمالي **26 passed / 0 failed / 0 skipped**؛ الحاوية حُذفت والمنفذ 5432 حُرِّر | **COMPLETED — 26/26 tests passed** |
| 2026-11-06 | PS-01 | إغلاق توثيقي (DOC-PS01-CLOSE): تحديث §2 (IN_PROGRESS→COMPLETED)، §6 (21→22، إضافة صف PS-01)، §1 (المغلقة 21→22، المفتوحة تبقى 25)، §9 — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | PS-02 | تنفيذ PS-02: مسار محروس `POST/GET /api/admin/finance/manual-completions` + `GET /manual-payment-availability` يُتمّ دفع `manual`/offline عبر `applyPaymentSucceeded` نفسه (لا كاتب جديد)؛ تبويب `manual` في `/admin/finance` + تأكيد قبل الفعل + شريط «DEMO معطّل»؛ 3 دوال api + أنواع DTO + 15 مفتاح `adminFin.*` في ar/fr/en/zh؛ حزمة بوّابات (بلا DB) + حزمة تكامل DB + E2E | IMPLEMENTED |
| 2026-11-06 | PS-02 | تحقّق تنفيذي: حزمة البوّابات `manual-payment-completion-guard.test.ts` → **4/4** (بلا DB)؛ `typecheck`+`build` (server+web) نظيفة؛ **حزمتا DB (`manual-payment-completion.test.ts`, 10 حالات) وE2E (`manual-payment-completion.spec.ts`, 5 حالات) مكتوبتان ولم تُشغَّلا** (لا PostgreSQL/Docker) | IN_PROGRESS (بلا DB) |
| 2026-11-06 | PS-02 | استئناف (RESUME): استعادة الحالة الفعلية، إكمال الثغرات داخل النطاق — تأكيد قبل الإتمام (`adminFin.manual.confirm` ×4 لغات) + اختبار E2E لرفض التأكيد (لا تغيير حالة) + شريط «DEMO معطّل» يستهلك `manual-payment-availability` + تصحيح عدّ §6 (إخراج PS-02، 23→22) وتصحيح §2/§1 (PS-02 → `IN_PROGRESS`، المفتوحة 24→25، المغلقة 23→22) — بلا Git state change | IN_PROGRESS |
| 2026-11-06 | PS-02 | التحقق الحيّ بإذن محدود: PostgreSQL 16 مؤقت معزول (`wasit-ps02-pg`، `127.0.0.1:5432`، `wasit_test` فقط)؛ Backend `manual-payment-completion.test.ts` **10/10** + بوّابات **4/4** + E2E `manual-payment-completion.spec.ts` **5/5** + تراجع PS-01 (`finance-routes` 16/16، `admin-finance` E2E 10/10) = **45 passed / 0 failed / 0 skipped**؛ إصلاحان في الـspec فقط (توقّع `PENDING`؛ البحث قبل النقر)؛ الحاوية حُذفت والمنفذ حُرِّر وDocker أُعيد لحالته | **COMPLETED — 45/45 tests passed** |
| 2026-11-06 | PS-02 | إغلاق توثيقي (DOC-PS02-CLOSE): تحديث §2 (IN_PROGRESS→COMPLETED)، §6 (22→23، إضافة صف PS-02)، §1 (المفتوحة 25→24، المغلقة 22→23)، §9 — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | PS-03/PS-06 | توحيد مرجعي (DOC-PS03-ALIGN): تصحيح صف §2 — PS-03 صار **Split Capability** (CRITICAL/BLOCKED) وكان مُسجَّلاً خطأً كاسترداد ClicToPay؛ إضافة صف **PS-06** (ClicToPay Refund، HIGH/BLOCKED)؛ §8 (تصحيح PS-03 + إضافة PS-06)؛ §1 (المفتوحة 24→25، الخارجية 9→10، BLOCKED 4→5)؛ إضافة §10.5. **توثيقي بحت** — لا كود، لا اختبارات، لا تغيير حالة أي فجوة أخرى | تم |

| 2026-11-06 | OBS-01 | تنفيذ مكتب فشل الـWebhooks: تبويب `webhooks` في `/admin/observability` (قائمة FAILED/DEAD_LETTERED + ترقيم offset/total + تأكيد قبل الفعل)؛ دوال api + أنواع DTO + 15 مفتاح i18n في ar/fr/en/zh؛ إصلاح عيب تدقيق: `writeAudit(ctx.db, ctx, …)` كان يكتب `actorId=NULL` → صار يمرّر هوية المشغّل | IMPLEMENTED |
| 2026-11-06 | OBS-01 | حماية: `parseNonNegativeIntParam` لـ`offset` (منع `NaN`/`Infinity` قبل SQL) + ترقيم في `listWebhookFailures` (offset + count) + استبعاد `payload`/التوقيع من الاستجابة | COMPLETED |
| 2026-11-06 | OBS-01 | التحقق الحيّ بإذن محدود: PostgreSQL 16 مؤقت معزول (`wasit-obs01-pg`، `127.0.0.1:5432`، `wasit_test` فقط)؛ Backend `p6-p7-dispute-webhook.test.ts` **19/19** + الحزمة الكاملة **887/887** (76 ملف)؛ E2E `admin-webhook-failures.spec.ts` **4/4** + الحزمة الكاملة **226 passed / 8 skipped**؛ الحاوية حُذفت والمنفذ حُرِّر وDocker أُعيد لحالته | **COMPLETED** |
| 2026-11-06 | OBS-01 | إغلاق توثيقي (DOC-OBS01-CLOSE): تحديث §2 (PENDING→COMPLETED)، §6 (23→24، إضافة صف OBS-01)، §1 (المفتوحة 25→24، المغلقة 23→24)، §9 — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.P0 | حسم تضارب `actorType`: فحص الكود (`scheduling.ts`) + الاختبار + الوثائق → التنفيذ صحيح ومتّسق (`actorType='SYSTEM'`, `actorId=null`, `metadata.createdBy`/`scheduleId`)؛ **لا تغيير كود** | تم — لا تضارب |
| 2026-11-06 | AI-02.P0 | منع الموافقة الذاتية: حارس Backend في `decideAgentTask` (`modules/ai/agents.ts`) → الطالب لا يعتمد طلبه (`403`)، ويشمل `SUPER_ADMIN`؛ سحب الطالب لطلبه (`REJECT`) مسموح | IMPLEMENTED |
| 2026-11-06 | AI-02.P0 | جرد الوكلاء: 11 وكيلاً، مصدر تسجيل وحيد (`AGENT_CATALOGUE`→`agent_registry`)، ولكل وكيل منفّذ حقيقي (`executors.ts`)؛ لا «تعريف بلا تنفيذ» | تم |
| 2026-11-06 | AI-02.P0 | اختبارات: `ai02p0-approval-guard.test.ts` **5/5** + إصلاح مساعد `runAndComplete` في `phase14-agents.test.ts`؛ PostgreSQL 16 معزول (`wasit-ai02p0-pg`، `wasit_test` فقط)؛ الحزمة الكاملة **904/904** (78 ملفاً)؛ Typecheck نظيف؛ الحاوية حُذفت وDocker أُعيد لحالته | **COMPLETED** |
| 2026-11-20 | OBS-01 | تنفيذ محرّك استعادة الـwebhooks: `lib/payments/webhook-retry.ts` (تصنيف + backoff أسي + حدود)، claim ذرّي بـlease في `claimWebhookEvent`، سجل `payment_webhook_attempts`، سقف replay، Migration `0041` إضافية (لا DROP) | IMPLEMENTED |
| 2026-11-20 | OBS-01 | التحقق الفعلي: وحدة `webhook-retry-policy` **14/14** + تكامل `obs01-webhook-recovery` **13/13** + تراجع `p6-p7-dispute-webhook` **19/19** على PostgreSQL 17 معزول (`wasit_test`، `127.0.0.1:5434`، عبر `TEST_DATABASE_URL` الصريح وحرّاس `test-db-guard`)؛ Typecheck (server+web) 0 أخطاء + `vite build` ناجح | **COMPLETED** |
| 2026-11-20 | OBS-01 | ملاحظة عزل اختبارات (سابقة، غير مرتبطة): `a1-kill-switch` يحسب صفوف `ai_requests` عالميًا فيتأثر بالملفات المتوازية (نجح منفردًا 13/13، وأخفاق واحد في تشغيل متوازٍ)؛ `marketing-video` يحتاج ثنائية `ffmpeg-static` (نُزّلت في هذه الحاوية). لا تغيير في الكود لهما | ملاحظة |
| 2026-11-06 | AI-02.1 | تصميم وتنفيذ نموذج Agent Runs: `db/schema/agent_runs.ts` (جدولا `agent_runs` + `agent_run_steps`، نوعا ENUM، FK متتالٍ، 3 CHECKs، فهارس فريدة) + ترحيل `0028_keen_gunslinger.sql` (مولّد بـ`drizzle-kit`) | IMPLEMENTED |
| 2026-11-06 | AI-02.1 | آلة الحالات المركزية: `modules/ai/run-state-machine.ts` (11 حالة تشغيل + 10 حالات خطوة، جدولا انتقالات، `assertRunTransition`/`assertStepTransition`، `assertStepSuccess`، `assertRunCompletion`، `assertValidDependencies` بخوارزمية Kahn) — منطق صرف بلا تنفيذ | COMPLETED |
| 2026-11-06 | AI-02.1 | اختبارات: `ai021-agent-runs.test.ts` **31/31** (persistence + انتقالات + إكمال + تبعيات + عدم التأثير على AI-01)؛ PostgreSQL 16 معزول (`wasit-ai021-pg`، `wasit_test` فقط)؛ تراجع AI **66/66**؛ الحزمة الكاملة **935/935** (79 ملفاً)؛ Typecheck نظيف؛ تحقّق حيّ على كائنات القاعدة (FK/CHECK/فريد/ENUM) | **COMPLETED** |
| 2026-11-06 | AI-02.1 | إغلاق توثيقي (DOC-AI021): AI-02 في §3 (PENDING→IN_PROGRESS)؛ §1 (المفتوحة 23→22، المغلقة تبقى 25)؛ §9؛ إضافة `docs/AI-02.1_AGENT_RUNS_STATE_MACHINE.md` — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.2 | خدمة التخطيط: `modules/ai/planner.ts` — `validatePlan` (وكيل مسجّل/نشط، مفاتيح فريدة، مدخلات صالحة، حدود، صلاحيات الطالب) + `topologicalOrder` (طوبولوجي حتمي: أولوية ثم مفتاح) + `planAgentRun` (حفظ ذرّي لـ`agent_runs`+`agent_run_steps` بحالة `PLANNING`) + `loadPlan` (إعادة فحص الرسم والوكلاء عند القراءة) — بلا تنفيذ | IMPLEMENTED |
| 2026-11-06 | AI-02.2 | اختبارات: `ai022-planning.test.ts` **28/28** (15 حالة مطلوبة + إثبات عدم التنفيذ)؛ PostgreSQL 16 معزول (`wasit-ai022-pg`، `wasit_test` فقط)؛ تراجع AI **97/97**؛ الحزمة الكاملة **963/963** (80 ملفاً)؛ Typecheck نظيف | **COMPLETED** |
| 2026-11-06 | AI-02.2 | إغلاق توثيقي (DOC-AI022): AI-02 في §3 (وصف التقدّم)؛ §1 (بلا تغيير: 22/25)؛ §9؛ إضافة `docs/AI-02.2_PLANNING_DEPENDENCY_RESOLUTION.md` — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.3 | خدمة الإرسال والتنفيذ: `modules/ai/dispatcher.ts` — `dispatchStep` (تحقق حالة/تبعيات/وكيل/صلاحيات/موافقة/ميزانية → مطالبة ذرّية → `createAgentTask` → جسر `decideAgentTask` للحساس → تسجيل النتيجة) + `approveRunStep` (AI-02.P0) + `reconcileRun` (SKIP متعدٍّ + إغلاق الخطة) + `cancelRun` + `getRunWithSteps`؛ الربط عبر `agent_tasks.input.__runId/__stepId` بلا Migration | IMPLEMENTED |
| 2026-11-06 | AI-02.3 | اختبارات: `ai023-dispatch.test.ts` **21/21** (إرسال/ربط/تنفيذ، تبعيات، موافقات ورفض ذاتي، وكيل/صلاحية/ميزانية، منع التكرار والتزامن، فشل وSKIP، إلغاء، اتساق الحالات، تدقيق، لا تجاوز لنظام المهام)؛ PostgreSQL 16 معزول (`wasit-ai023-pg`، `wasit_test` فقط)؛ مجموعة AI **125/125**؛ الحزمة الكاملة **984/984** (81 ملفاً)؛ Typecheck نظيف | **COMPLETED** |
| 2026-11-06 | AI-02.3 | إغلاق توثيقي (DOC-AI023): AI-02 في §3؛ §1 (بلا تغيير: 22/25)؛ §9؛ إضافة `docs/AI-02.3_CONTROLLED_EXECUTION.md` — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.3.1 | موثوقية التنفيذ والاستعادة: `syncStepFromTask` (مزامنة الخطوة مع مهمتها: succeeded→SUCCEEDED بشرط وجود نتيجة، failed/rejected→FAILED، in-flight/unknown→لا إجراء) + `recoverStuckSteps` (اكتشاف الخطوات العالقة `RUNNING` + مطالبة/إيجار ذرّي + عدم إنشاء مهمة بديلة + تسجيل السبب) + `recoverRun`؛ إضافة حدّ `maxAttempts` إلى `dispatchStep`؛ إصلاح `reconcileRun` ليمرّ عبر الحالات القانونية عند إغلاق خطة ما زالت `PLANNING` | IMPLEMENTED |
| 2026-11-06 | AI-02.3.1 | نقطة تشغيل فعلية: إعادة استخدام المُجدول الداخلي `lib/scheduler.ts` (وظيفة `runAgentRunRecovery`) + توصيل `index.ts`؛ مفاتيح بيئة جديدة `AI_AGENT_RUNS_RECOVERY_ENABLED` (افتراضي false) / `AI_AGENT_RUNS_RECOVERY_INTERVAL_MINUTES` / `AI_AGENT_RUN_STEP_STUCK_SECONDS` — بلا قيمة سحرية؛ ومسارات إدارية `GET/POST /api/admin/ai/agent-runs/...` (dispatch/approve/cancel/recover) خلف AI_MANAGE/ADMIN_AI. (أُزيل لاحقاً في AI-02.3.2 إعداد `AI_AGENT_RUNS_AUTO_DISPATCH_ENABLED` لأنه كان ميّتاً.) | IMPLEMENTED |
| 2026-11-06 | AI-02.3.1 | اختبارات: `ai0231-reliability.test.ts` **23/23** (دورة التنفيذ، المزامنة، الاستعادة، الانقطاع، التزامن، maxAttempts، الفشل/التبعيات، الإغلاق، الصلاحيات/الموافقات، idempotent audit)؛ PostgreSQL 16 معزول (`wasit-ai0231-pg`، `wasit_test` فقط)؛ الحزمة الكاملة **1007/1007** (82 ملفاً)؛ Typecheck نظيف (server+web) | **COMPLETED** |
| 2026-11-06 | AI-02.3.1 | إغلاق توثيقي (DOC-AI0231): AI-02 في §3 (وصف التقدّم)؛ §1 (بلا تغيير: 22/25)؛ §9؛ إضافة `docs/AI-02.3.1_EXECUTION_RELIABILITY_RECOVERY.md` — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.3.2 | Fencing والتزامن: `attempt_count` كـ**fencing token** عند المطالبة + كل كتابة نتيجة عبر `fencedStepWrite` (`WHERE id=? AND status='RUNNING' AND attempt_count=<token>`) → لا كتابة قديمة فوق قرار Recovery (تُسجَّل `AI.AGENT_RUN_STEP_WRITE_REJECTED`)؛ حماية خدمة `createAgentTask(..., fencing)` بمعاملة واحدة (فحص ملكية+تجديد إيجار+إدراج) + idempotency ضد التكرار؛ بلا Migration | IMPLEMENTED |
| 2026-11-06 | AI-02.3.2 | حارس Recovery داخل العملية `createInFlightGuard()` (تحرير في finally) + سجل كل دورة (correlationId/status/عدّادات/durationMs حتى الدورة الفارغة) + عزل أخطاء الخطوات (`AI.AGENT_RUN_STEP_RECOVERY_FAILED`/`AI.AGENT_RUN_RECONCILE_FAILED`)؛ إزالة `AI_AGENT_RUNS_AUTO_DISPATCH_ENABLED` (إعداد ميّت) | IMPLEMENTED |
| 2026-11-06 | AI-02.3.2 | اختبارات: `ai0232-fencing.test.ts` **30/30** (منها تزامن حقيقي عبر seam `dispatchStep(..., {onClaimed})` + Deferred): منع الكتابة فوق FAILED/CANCELLED، token قديم، Recovery أثناء مطالبة صالحة، انتهاء الإيجار وعودة Dispatch قديم، منع المهمة بعد فقدان الملكية، دورتا Recovery متزامنتان، حماية الموافقات/الصلاحيات، حارس العملية، سجل الدورة الفارغة؛ PostgreSQL 16 معزول (`wasit-ai0232-pg`، `wasit_test` فقط)؛ الحزمة الكاملة **1037/1037** (83 ملفاً)؛ Typecheck نظيف (server+web) | **COMPLETED** |
| 2026-11-06 | AI-02.3.2 | إغلاق توثيقي (DOC-AI0232): AI-02 في §3 (وصف التقدّم)؛ §1 (بلا تغيير: 22/25)؛ §9؛ إضافة `docs/AI-02.3.2_FENCING_CONCURRENCY_RECOVERY_SAFETY.md`؛ تحديث وثيقة AI-02.3.1 (إزالة AUTO_DISPATCH) — بلا تغيير أي فجوة أخرى | COMPLETED |
| 2026-11-06 | AI-02.3.2 | **إصلاح ترتيب القفل + اختبارات تزامن حقيقية:** أُعيد ترتيب `createAgentTask(fencing)` ليُنفَّذ `UPDATE` الملكية (قفل صف الخطوة) **قبل** فحص التكرار — منع **مهمتين نشطتين** للخطوة نفسها تحت `READ COMMITTED` (كان فحص-then-إدراج غير ذرّي). إضافة `tests/ai0232-concurrency.test.ts` **10/10** بحوضَي `pg.Pool` منفصلين (اتصالان/جلستان مستقلان بقاعدة PostgreSQL، دون مشاركة الاتصال أو المعاملة) و`Promise.all` على أقفال الصفوف: Dispatchان متزامنان، دورتا Recovery متزامنتان، كاتب قديم عبر اتصال B، فشل قبل/بعد إنشاء المهمة وأثناء حفظ النتيجة، تكرار Recovery. PostgreSQL 16 معزول (`wasit-ai0232-pg`، `wasit_test`)؛ الحزمة الكاملة **1047/1047** (84 ملفاً)؛ Typecheck نظيف. **بلا Migration** (البديل المؤجّل: فهرس تعبيري فريد موثّق في §12 من وثيقة AI-02.3.2) | **COMPLETED** |
| 2026-11-06 | AI-02.3.2 | **دقّة تدقيق الاستعادة (تصحيح التدقيق النهائي):** إغلاق الخطوة في `syncStepFromTask` أصبح مشروطاً بفحص الصفوف المتأثرة عبر `settleRunningStep` (`UPDATE … WHERE id=? AND status='RUNNING' RETURNING id`)؛ صفر صفوف = `lost_race` ⇒ لا `recovered`، لا Audit نجاح، ويُسجَّل `AI.AGENT_RUN_STEP_RECOVERY_LOST_RACE` ويُزاد `lostRace` في الدورة (وسطر السجل)؛ لا `reconcileRun` لخطوة خسرت السباق. **بلا تغيير Fencing/`attempt_count`/Retry/الصلاحيات، وبلا Migration.** اختبارات جديدة في `ai0232-concurrency.test.ts` (**14/14**): Recovery يفوز/ Dispatch يفوز داخل النافذة / صفر صفوف ليس نجاحاً / لا سجلات مكرّرة / الحالات النهائية لا تتغيّر (seam اختباري `SyncHooks.beforeSettle` نظير `onClaimed`، غير مُمرَّر في الإنتاج). الحزمة الكاملة **1051/1051** (84 ملفاً)؛ Typecheck نظيف | **COMPLETED** |
| 2026-11-06 | AI-02.3.2 | **إغلاق نهائي (DOC-AI0232-CLOSE):** ضبط دقّة الصياغة التوثيقية — استُبدل «عمليتا Server مستقلتان» بـ«اتصالان/جلستان مستقلان بقاعدة PostgreSQL، دون مشاركة الاتصال أو المعاملة» في §10.2 من وثيقة AI-02.3.2 وفي `AGENTS.md`، مع حفظ القيد الصريح (لم يُختبر تشغيل عمليتَي Node Server مستقلتين فعلياً)؛ الحالة → **CLOSED**؛ `git diff --check` نظيف؛ **توثيقي بحت — لا كود/اختبار/Migration**؛ AI-02 تبقى `IN_PROGRESS` (العدّات دون تغيير 22/25) | **CLOSED** |
| 2026-11-06 | M1.9.0-A1 | **سلسلة الترحيلات الموحّدة (ملفات فقط، بلا تنفيذ DB):** توليد 0030–0036 بـ`drizzle-kit` (أعمدة Registry/Tasks، حقول `agent_schedules`، فهارس dedupe، `agent_metrics`/`agent_memory`، lockout، `notification_deliveries`، `event_outbox`)؛ `drizzle-kit check` نظيف؛ `tsc` نظيف. **بلا تغيير أي فجوة.** التفاصيل: `docs/M1.9.0-A1_MIGRATION_CHAIN.md` | IMPLEMENTED |
| 2026-11-06 | M1.9.0-A1.1 | **تدقيق توافق Schema/Runtime (قراءة فقط):** كشف BLOCKER في 0032 — شرط الفهرس الجزئي يستثني `blocked` غير المستخدمة ويغفل `approved` النهائية؛ وتحذير تفعيل مزدوج (`enabled` بلا مستهلك). **بلا تعديل ملفات.** | تم |
| 2026-11-06 | M1.9.0-A1.2 | **تصحيح شرط dedupe + تنظيف التفعيل:** (1) 0032 يستثني الحالات النهائية الفعلية `succeeded/failed/rejected/approved` (أُضيفت `approved`، أُزيلت `blocked`) + **فحص تكرار مسبق DO block** يوقف الترحيل برسالة واضحة بلا حذف/دمج. (2) إزالة `enabled` و`agent_schedules_enabled_idx` من Schema/0031/Snapshots (مصدر الحقيقة الوحيد `is_active`). (3) اختبار وحدة ساكن **14/14** (`tests/unit/agent-task-dedupe-predicate.test.ts`)؛ `drizzle-kit check` نظيف؛ `tsc` نظيف؛ سلسلة `prevId` متّصلة؛ صفر drift. **بلا تنفيذ DB.** | IMPLEMENTED |
| 2026-11-07 | M1.9.0-A2 | **تحقّق حيّ معزول (T1 قاعدة فارغة):** PostgreSQL 16 في حاوية مؤقتة معزولة (`wasit-m190-a2-pg`، `127.0.0.1:5433`، `wasit_test`)؛ تطبيق **0000→0036 كاملة** عبر مُهاجِر Drizzle الحقيقي (`drizzle-orm/node-postgres/migrator`) → **37/37 migration**. لم يُعدَّل أي كود/Schema/Migration/Snapshot | تم |
| 2026-11-07 | M1.9.0-A2 | **تحقّق حيّ معزول (T2 ترقية اصطناعية):** بناء إلى **0028** (`applied:29`) + إدخال **بيانات اصطناعية** (3 registry/3 tasks/2 schedules) + تطبيق **0029→0036** (`applied:37`)؛ بصمات `md5` مطابقة قبل/بعد (`2f2c161c…`, `5967ed36…`, `57792842…`). فرق الكتالوج 0028→0036: **+67 عموداً، +21 فهرساً، 0 محذوف** | تم |
| 2026-11-07 | M1.9.0-A2 | **0029 (تكرار Registry):** يرفض التطبيق مع مفاتيح مكرّرة («1 duplicated key(s) found: dup-agent (2 rows)… no rows were changed»؛ العدّاد ثابت 29، الفهرس غير فريد)، وينجح بعد إزالة التكرار → UNIQUE صالح | تم |
| 2026-11-07 | M1.9.0-A2 | **0032 (تكرار المهام المفتوحة):** WARNING + RAISE EXCEPTION مع rollback كامل (الصفوف سليمة، العدّاد ثابت 32، لا فهرس)، وينجح بعد حلّ التكرار → `agent_tasks_dedupe_idx` + `agent_tasks_dedupe_open_uidx` (فريد جزئي) | تم |
| 2026-11-07 | M1.9.0-A2 | **Dedupe behavior 9/9:** المفتوحة (`queued`/`running`/`awaiting_approval`) → التكرار مرفوض؛ النهائية (`succeeded`/`failed`/`rejected`/`approved`) → مسموح؛ `NULL` → تعدّد مسموح؛ مالك مختلف بنفس المفتاح → مسموح | **COMPLETED** |
| 2026-11-07 | M1.9.0-A2 | **الاختبارات:** مجموعة AI/الجدولة/Recovery/Fencing **282/282** (26 ملفاً) + الحزمة الكاملة **1079/1079** (89 ملفاً)، بلا `skipped`/`todo`/`.only`؛ `tsc --noEmit` نظيف؛ `drizzle-kit check` نظيف؛ صفر drift؛ `git diff --check` نظيف | **COMPLETED** |
| 2026-11-07 | M1.9.0-A2 | **التنظيف والسلامة:** حُذفت الحاوية/الشبكة/الصورة/الأسرار/الـharness وأُوقف Docker (حالة ما قبل الجلسة)؛ **DEMO لم تُمس**، وM0-RECOVERY سليمة (sha256 مطابق)؛ بوابة Git قبل/بعد متطابقة (0/59/45/0) وHEAD دون تغيير | تم |
| 2026-11-07 | M1.9.0-A2 | **إغلاق توثيقي (DOC-A2-CLOSE):** M1.9.0-A2 → **CLOSED / VERIFIED**؛ إضافة نتائج A2 إلى `docs/M1.9.0-A1_MIGRATION_CHAIN.md` §9؛ تسجيل `GAP-A2-01` و`GAP-A2-02` (§11)؛ §1 (المفتوحة 22→24)؛ §9. **توثيقي بحت — لا كود/Migration/Schema/Snapshot** | **CLOSED** |
| 2026-11-07 | SEC-CSRF-01 | تنفيذ حماية CSRF مركزية: `packages/server/src/middleware/csrf.ts` (تحقق صارم من `Origin`/`Referer` للطلبات POST/PUT/PATCH/DELETE التي تحمل كوكي الجلسة فقط؛ رفض مغلق عند غياب الدليل؛ بلا مسارات مستثناة؛ لا يمسّ الطلبات بلا كوكي = عملاء التوكن/webhooks الموقّعة)؛ `CSRF_PROTECTION=auto|on|off` في `env.ts`؛ الربط في `app.ts` بعد CORS وقبل routing | IMPLEMENTED |
| 2026-11-07 | SEC-CSRF-01 | اختبارات (بلا DB): `tests/csrf.test.ts` **17/17** (رفض origin خارجي/null/referer أجنبي؛ قبول same-origin؛ رفض مغلق بلا origin مع الكوكي؛ عدم المساس بطلبات بلا كوكي؛ سلامة GET/HEAD/OPTIONS؛ inert في off/auto-dev؛ ربط التطبيق الحقيقي يحجب الكتابة قبل الوصول للمسار) + تراجع `tests/cors.test.ts` **4/4** + Typecheck (server) نظيف | IMPLEMENTED |
| 2026-11-07 | SEC-CSRF-01 | **لم تُشغَّل الحزمة الكاملة**: لا PostgreSQL (`ECONNREFUSED`) و`tests/setup.ts` يهدم/يُنشئ قاعدة ويرحّل (ممنوع في هذه المهمة)؛ لذلك الحالة `IMPLEMENTED` لا `COMPLETED` (يلزم تشغيل الحزمة الكاملة + E2E عند توفّر PostgreSQL) | IMPLEMENTED |
| 2026-11-07 | SEC-CSRF-01 (005) | **تحقق معزول نهائي (بلا DB/Docker):** غُطّيت حالات الفحص الـ12. الموجود سابقاً: `auto`/`on`/`off`، رفض Origin أجنبي/`null`، Referer أجنبي/مطابق، رفض مغلق بلا دليل، قبول same-origin، عدم المساس بطلبات بلا كوكي، سلامة GET/HEAD/OPTIONS، عدم كشف الأصل، CORS دون تغيير. **المُضاف مركزياً:** (1) رفض **كل** الطرق الأربع POST/PUT/PATCH/DELETE (كان PUT غير مُختبَر صراحةً)؛ (2) فرض وضع `auto` الافتراضي في `NODE_ENV=production` عبر `createApp()` الحقيقي (ضمان الإنتاج دون `CSRF_PROTECTION=on`)؛ (3) عدم وجود استثناء للمسارات الحسّاسة (`/api/admin/users`, `/api/payments/...`)؛ (4) **الترتيب** مُثبَت: `403` من CSRF يحمل ترويسة CORS (CORS قبل CSRF) والمسار لا يُبلَغ (CSRF قبل routing). | COMPLETE_VERIFIED |
| 2026-11-07 | SEC-CSRF-01 (005) | **نتائج الاختبار (معزول، `vitest` بلا `globalSetup` — لا PostgreSQL/migrations/seeds):** `csrf.test.ts` **21/21** ✅ + `cors.test.ts` **4/4** ✅ + `secret-scan.test.ts` **3/3** ✅ + `staff-mfa-enforcement.test.ts` **17/17** ✅ (تراجع) = **45/45**؛ TypeScript (server+web) نظيف ✅. **بلا تغيير كود إنتاج** (الإضافة اختبارات فقط) وبلا schema/migration/seed. | COMPLETE_VERIFIED |
| 2026-11-07 | SEC-CSRF-01 (005) | **إغلاق:** الصف انتقل من `IMPLEMENTED` إلى `COMPLETE_VERIFIED`؛ «المفتوحة» 21 → 20 و«المغلقة» 27 → 28؛ أُضيف صف §6. الموارد المؤقتة (ملف `vitest` مؤقت للعزل) حُذفت. | COMPLETE_VERIFIED |
| 2026-11-07 | LC-07 | **تصميم وتنفيذ قفل الحساب:** `lib/lockout.ts` (سياسة صرفة: `lockoutPolicy`/`isLoginBlocked`/`hasActiveTemporaryLock`/`nextFailureOutcome` + أنواع `LockState`/`LockoutPolicy`) + `registerFailedLogin`/`clearFailedLogin` في `auth/service.ts`؛ الربط في `loginUser` (رفض مسبق لـ401 موحّد، عدّ ذرّي، تصفير عند النجاح) + مسارات MFA (`completeMfaLogin`/`loadStaffEnrollmentChallenge`/`openDemoSession`) بفحص `isLoginBlocked`؛ تدقيق `AUTH.ACCOUNT_LOCKED`/`AUTH.ACCOUNT_UNLOCKED` بلا أسرار؛ `MAX_LOGIN_ATTEMPTS`/`LOCKOUT_MINUTES` موثّقة في `.env.example`. **بلا Migration** (الأعمدة `failed_login_attempts`/`locked_until`/`is_locked` موجودة في الترحيل 0034) | IMPLEMENTED |
| 2026-11-07 | LC-07 | **اختبارات بلا DB:** `unit/lockout-policy.test.ts` **7/7** (حدود قابلة للضبط، زيادة العدّاد، القفل عند الحد، قفل نشط/منتهٍ، قفل إداري دائم) + عدم تأثّر `staff-mfa-enforcement`(17)/`csrf`(17)/`unit/mfa`(8)/`secret-scan`(3)/`manual-payment-completion-guard`(4)/`lockout-policy`(7) → **56/56**؛ Typecheck (server) نظيف | IMPLEMENTED |
| 2026-11-07 | LC-07 | **غير مُشغَّل:** `tests/account-lockout.test.ts` (12 حالة متكاملة: عدّ/قفل/انتهاء/تصفير/تزامن/عدم تجاوز MFA/طاقم/عدم تسريب/تدقيق) يحتاج PostgreSQL؛ لم يُشغَّل بلا إذن مستقل (لا Docker/PostgreSQL) → الحالة **`IMPLEMENTED_UNVERIFIED`** وتبقى الفجوة مفتوحة | IMPLEMENTED_UNVERIFIED |
| 2026-11-07 | LC-07 (004.1) | **مراجعة أمنية — تصفير العدّاد:** نُقل `clearFailedLogin` من قبل خطوة MFA إلى **بعد اكتمال المصادقة كاملة** في `loginUser` (بعد العامل الثاني) و`completeMfaLogin`/`completeStaffMfaEnrollment` (بعد التصديق)؛ الآن **صحة كلمة المرور وحدها لا تصفّر العدّاد**، و**فشل TOTP لا يزيد عدّاد كلمة المرور** (ولا يصفّره) | IMPLEMENTED |
| 2026-11-07 | LC-07 (004.1) | **مراجعة أمنية — حماية MFA مستقلة:** زيادة `mfaChallenges.attempts` صارت ذرّية (`attempts + 1` في SQL) في `completeMfaLogin` و`completeStaffMfaEnrollment`؛ الحماية قائمة فعلاً: حدّ `MFA_CHALLENGE_MAX_ATTEMPTS` (5)، تحدٍّ أحادي الاستخدام (`consumedAt`)، وانتهاء `MFA_CHALLENGE_TTL_MINUTES` (5) — فلا يُعاد استخدام تحدٍّ ناجح، وتُرفض المحاولات فوق الحدّ حتى بالكود الصحيح | IMPLEMENTED |
| 2026-11-07 | LC-07 (004.1) | **مراجعة أمنية — التوقيت (قياس لا ادّعاء):** القياس كشف أنّ مسار «حساب غير موجود/مقفل/معطّل» لم يكن يشغّل argon2 إطلاقاً (~0ms) مقابل ~25ms لكلمة مرور خاطئة، وأنّ الهاش الوهمي القديم كان `m=65536` (~114ms) بينما `hashPassword` تستخدم `m=19456` (~25ms). أُضيف `DUMMY_ARGON2_HASH` بمعاملات **مطابقة** إلى `lib/security.ts` ويُستخدم في كل مسارات «بلا جلسة» | IMPLEMENTED |
| 2026-11-07 | LC-07 (004.1) | **اختبارات بلا DB:** `unit/security-timing.test.ts` **3/3** (مطابقة معاملات الهاش الوهمي لـ`hashPassword` + قياس نسبة الزمن <2.5 + عدم قبوله أي كلمة مرور) + `unit/account-lockout-flow.test.ts` **6/6** (تدفّق `loginUser` الحقيقي بـDB وهمي + `vi.spyOn` على `verifyPassword`: موازنة المسارات الثلاثة، عدّ عند الخطأ، **عدم تصفير عند MFA معلّق**، تصفير بعد المصادقة الكاملة)؛ كل `tests/unit` **90/90**؛ عيّنة بلا DB (LC-06/CSRF/lockout) **65/65**؛ Typecheck (server) نظيف؛ **لا schema/migration/seed** | IMPLEMENTED |
| 2026-11-07 | LC-07 (004.1) | **اختبارات متكاملة جديدة (غير مُشغَّلة — تحتاج PostgreSQL):** توسيع `tests/account-lockout.test.ts` بـ«تفاعل MFA» (4 حالات: لا تصفير مع MFA معلّق، فشل TOTP لا يمسّ العدّاد، تصفير بعد اكتمال MFA، حدّ التحدّي تحت التزامن) + «التوقيت» (قياس حيّ للمسارات الثلاثة) → المجموع **17 حالة** | IMPLEMENTED_UNVERIFIED |
| 2026-11-07 | LC-07 (004.2) | **التحقّق المتكامل النهائي (PostgreSQL 16 مؤقتة معزولة):** حاوية `wasit-lc07-pg` على `127.0.0.1:55440`، قاعدة `wasit_test`، volume خاص؛ أُثبت العزل (لا إعادة استخدام لأي حاوية/volume/قاعدة قائمة، ولا شيء على 5432)؛ 37 Migration + Seed داخل القاعدة المؤقتة فقط. تشغيل `tests/account-lockout.test.ts`: **19/19 ✅** (عدّ/تصفير/قفل عند الحد/رفض أثناء القفل حتى بكلمة مرور صحيحة/انتهاء تلقائي/عدم فقدان الزيادات تحت التزامن/عدم التجاوز عبر MFA/طاقم + SUPER_ADMIN/عدم تعطيل العملاء والتجار/عدم كشف الوجود + التوقيت/تفاعل MFA: لا تصفير مع MFA معلّق وفشل TOTP لا يمسّ العدّاد/تصفير بعد اكتمال MFA/انتهاء التحدّي وعدم إعادة استخدامه/الحدّ الذرّي للمحاولات المتزامنة) | COMPLETE_VERIFIED |
| 2026-11-07 | LC-07 (004.2) | **إصلاح داخل LC-07 فقط:** (1) إصلاح مُساعد الاختبار `createMfaUser` ليستخدم `confirmMfa` (يفعّل الصفّ) بدل ضبط `mfaEnabled` يدوياً (كان يجعل `verifyMfaChallenge` يرفض بـ«MFA not enabled» → 401)؛ (2) تصحيح تأكيد «الحدّ الذرّي» ليقيس بلوغ الحدّ فعلاً (الطلبات المتأخّرة تُرفض دون زيادة، فالعدّ النهائي ∈ [الحدّ, N]) بدل افتراض بلوغ N؛ (3) توحيد كلفة هاش المستخدم في الاختبار عبر `hashPassword` التطبيقية (m=19456) بدل افتراضي argon2 (m=65536) — كان يجعل مسار «كلمة المرور الخاطئة» أغلى من الهاش الوهمي فيقيس كلفة الـfixture لا مسارات الإنتاج؛ (4) توسيع حالة التوقيت (تسخين كل المسارات + 9 تكرارات + سقف 5×) لتحتمل حِمل الحزمة الكاملة. **لا تغيير في كود الإنتاج.** | COMPLETE_VERIFIED |
| 2026-11-07 | LC-07 (004.2) | **الحزمة الكاملة + TypeScript:** الخادم **1161/1161** (96 ملف) ✅ (أول تشغيل كشف حالة توقيت واحدة فاشلة بسبب كلفة هاش الـfixture → أُصلحت ثم **1161/1161** نظيف)؛ `tests/unit` **90/90** ✅؛ `staff-mfa-enforcement`(17)/`staff-mfa-login`(13)/`mfa-login-challenge`(10)/`csrf`(17)/`secret-scan`(3) ✅؛ Typecheck (server+web) نظيف ✅. **تنظيف:** حُذفت الحاوية + الـvolume + صورة `postgres:16-alpine` + السجلات المؤقتة؛ لا موارد متبقّية؛ DEMO/قواعد الإنتاج لم تُمسّ (لا شيء على 5432)؛ M0 مطابق. → LC-07 **COMPLETE_VERIFIED** | COMPLETE_VERIFIED |
| 2026-11-07 | PERM-01 | **حسم السؤال:** هل يُمنح ADMIN `revenue:read`/`report:read`؟ القرار: **لا** لـ`revenue:read` (منع مقصود مُوثَّق ومُتحقَّق حياً في `docs/management/guide.html` §8: ADMIN→403 وSUPER_ADMIN→200 على `/api/revenue/report`؛ الفرق الحقيقي بين المنصبين هو بالضبط `/api/revenue/*`؛ ولا واجهة للمسار). و**`report:read` ليست فجوة**: لا مسار يستهلكها، ومكتب التقارير محروس بـ`admin:reports` الذي يملكه ADMIN (PERM-01C R2). | COMPLETE_VERIFIED |
| 2026-11-07 | PERM-01 | **الاختبار (معزول بلا DB، بلا `globalSetup`):** `perm01-admin-revenue-report.test.ts` **17/17** ✅ — مصفوفة RBAC (ADMIN بلا revenue:*/report:read؛ SUPER_ADMIN كامل)، منع ADMIN على `/api/revenue/report|scenarios|scenario`، 401 لغير المصادق، بقاء مكتب التقارير متاحاً لـADMIN (200-class) وممنوعاً لـCUSTOMER/MERCHANT (403)، منع CUSTOMER/MERCHANT/SUPPLIER/COMPANY/MARKETER على `/api/admin/stats`، عدم التسريب عبر endpoint بديل (كل مسارات الإيراد خلف revenue:read/simulate)، التحقق لكل طلب (نفس جلسة ADMIN: 200-class على الإدارة و403 على الإيراد)، وعدم التجاوز بتغيير الدور. | COMPLETE_VERIFIED |
| 2026-11-07 | PERM-01 | **تراجع + TypeScript:** csrf(21)/cors(4)/secret-scan(3)/staff-mfa-enforcement(17) ✅؛ Typecheck (server+web) نظيف ✅؛ **لا تغيير صلاحيات ولا كود إنتاج ولا schema/migration/seed**؛ الموارد المؤقتة (ملف vitest للعزل) حُذفت. | COMPLETE_VERIFIED |
| 2026-11-07 | PERM-01 | **إغلاق:** صف PERM-01 (المتبقّي) → `COMPLETE_VERIFIED`؛ «المفتوحة» 20 → 19 و«المغلقة» 28 → 29؛ أُضيف صف §6. | COMPLETE_VERIFIED |

### تفاصيل إصلاح PERM-01C

**الملفات المعدّلة:**
- `packages/server/src/middleware/auth.ts` — إضافة `requireRoleOrPermission(role, permission)`.
- `packages/server/src/modules/suppliers/routes.ts` — `POST /` بـ`requireRoleOrPermission('SUPPLIER', SUPPLIER_CREATE)`؛ `POST /contacts` بـ`SUPPLIER_UPDATE`.
- `packages/server/src/modules/merchants/routes.ts` — `POST /` بـ`requireRoleOrPermission('MERCHANT', MERCHANT_CREATE)`؛ `PATCH /:id` بـ`MERCHANT_UPDATE`.
- `packages/server/src/modules/companies/routes.ts` — `POST /` بـ`requireRoleOrPermission('COMPANY', COMPANY_CREATE)`؛ `PATCH /:id` بـ`COMPANY_UPDATE`.
- `packages/server/src/modules/tax/routes.ts` — الحارس العام من `ADMIN_REPORTS` إلى `ADMIN_POLICIES`.
- `packages/server/src/modules/admin/analytics-routes.ts` — `/reports` (GET/POST) يحملان `ADMIN_REPORTS` صراحةً.
- `packages/web/src/lib/demo-owner-catalog.ts` — probe التقارير → `/api/admin/analytics/reports`.
- `packages/web/src/lib/rbac.ts` — إزالة ميزة `payment.view` (غير موجودة في `Feature`، بلا مستهلك، بلا صلاحية خادم).
- `packages/server/tests/perm01c-rbac-cleanup.test.ts` — 23 حالة (جديد).
- `docs/PERM-01C_RBAC_CLEANUP.md` — التصنيف الكامل (R4/R5).

**جوهر الإصلاح (الكيانات):** كانت مسارات الإنشاء محروسة باسم الدور وحده (`requireRole('SUPPLIER'|'MERCHANT'|'COMPANY')`)
رغم وجود صلاحيات `*_create`/`*_update` معرّفة. **الفخ:** أسماء الصلاحيات تُضلّل — `*_create` ممنوحة لـSUPER_ADMIN فقط،
بينما التسجيل الذاتي (`OnboardingPage`) يحتاج البائع لإنشاء كيانه. الاستبدال الساذج CREATE→`*_create` كان **سيكسر**
تسجيل الموردين/التجّار/الشركات الذاتي (403 لكل بائع جديد). الحل `requireRoleOrPermission`: يقبل الدور المطابق **أو**
حامل الصلاحية، فيبقى التسجيل الذاتي سليماً ويصبح المسار مُعبِّراً عن الصلاحية. `PATCH` و`contacts` صارتا بـ`*_update`
(البائع يملكها ضمن ملكيته). الملكية تُفرض في الخدمة (`row.userId !== actorId` → 403)، فلا يستطيع ADMIN تعديل ملف غيره
(مُثبت بالاختبار).

**جوهر الإصلاح (الصلاحيات المُضلِّلة):** `admin:reports` كان يحرس **مسار الضرائب** بينما سطح التقارير الحقيقي
(`/api/admin/analytics/reports`) كان محروسة بالحارس العام فقط. الآن `admin:reports` يحرس التقارير، والضرائب صارت
`admin:policies` (سطح سياسة). لم يتغيّر وصول أي دور فعلياً (ADMIN/SUPER_ADMIN يملكان الاثنتين؛ الأدوار التجارية لا تملك أياً منهما).

**ما بقي مفتوحاً بعد PERM-01C (مؤجّل صراحةً):**
- **50 صلاحية غير مستخدمة** مصنّفة في `docs/PERM-01C_RBAC_CLEANUP.md` — 10 منها «ميتة» تحتاج قرار إزالة/ربط.
  (تعريف دقيق: 50 = الصلاحيات غير المُشار إليها برمز `PERMISSIONS.*` في الخادم **عدا** `ad:create` المُنفَّذة بآلية أخرى؛ 60 = المُشار إليها برمز، و1 = بآلية أخرى، والمجموع 111. انظر **§10**.)
- **الصلاحيات المُضلِّلة للموظفين المتخصصين** (SUPPORT/RISK/DISPUTE يملكون `user:read`/`audit:log:read`/`transaction:read`
  بلا مسار قابل للوصول بسبب الحارس العام) — قرار إداري: فتح مكاتب أم إزالة صلاحيات.
- **`revenue:manage`/`report:read` لـADMIN** — تناقض موثّق سابقاً، لم يُمسّ.
- **`ad:manage`** — مرشّح ربط/إزالة (لا مسار يستخدمها).

### تفاصيل إصلاح PERM-01B

**الملفات المعدّلة:**
- `packages/shared/src/constants/permissions.ts` — صلاحية جديدة `INVENTORY_READ_ALL` (`inventory:read:all`).
- `packages/shared/src/constants/rbac.ts` — ADMIN يحصل على `INVENTORY_READ` + `INVENTORY_READ_ALL` (قراءة فقط).
- `packages/server/src/modules/inventory/routes.ts` — فصل حارس القراءة عن حارس الكتابة + نطاق قراءة إداري.
- `packages/server/src/modules/inventory/service.ts` — دوال القراءة تقبل `sellerId: string | null` (null = كل البائعين).
- `packages/server/tests/perm01b-inventory-product-permissions.test.ts` — 15 حالة (جديد).
- `packages/web/src/lib/rbac.ts` — ميزة `inventory.read` + تصحيح منح ADMIN/SUPER_ADMIN.
- `packages/web/src/pages/DashboardInventoryPages.tsx` — إخفاء أزرار الكتابة لمن لا يملك `inventory.manage`.
- `packages/web/src/lib/demo-owner-catalog.ts` — وسم المخزون بـ`inventory.read`.
- `docs/GAP_REGISTER.md` (توثيق).

**جوهر الإصلاح (المخزون):** كان `/api/inventory` كله خلف حارس واحد يجمع القراءة والكتابة معاً، وADMIN لا يملك أيّاً
منها. الآن:
- **قراءة** (`GET /`, `GET /:id`, `GET /:id/movements`): يكفي `inventory:read` (البائعون) أو `inventory:read:all`
  (ADMIN). من يملك `read:all` يُقرأ له عبر كل البائعين (`sellerId = null`)، ومن لا يملكه يُقيَّد بملكيته.
- **كتابة** (`POST /:id/adjust`, `PATCH /:id`): تتطلّب `inventory:update` أو `inventory:movement:create` — وهي
  صلاحيات البائعين (MERCHANT/SUPPLIER/COMPANY) فقط. ADMIN/SUPER_ADMIN لا يملكانها، ثم يبقى `ownedSellerOrThrow`
  حارساً ثانياً يمنع الكتابة أصلاً بلا ملكية — فلا يستطيع أي مشرف تعديل مخزون تاجر.

**جوهر الإصلاح (المنتجات):** لم يُغيَّر منطق المنتجات لأن قواعده كانت سليمة بعد SEC-01/02: `hasProductManageAuthority`
(من `product:manage` = ADMIN/SUPER_ADMIN) يحدّد من ينشر/يعدّل نيابة عن الغير، والبائع مقيَّد بملكيته. أُضيفت اختبارات
تثبيت لهذا السلوك فقط (نشر/تعديل/403 للغير)، بلا أي توسيع صلاحيات.

**ما بقي مفتوحاً بعد PERM-01B (مؤجّل صراحةً، لم يُعدَّل):**
- **صلاحيات ميتة/غير موصولة** (`admin:reports` على مسار الضرائب، `/api/revenue` بلا واجهة، probes خاطئة) — من نطاق PERM-01C.
- **COMPANY لا يملك `PRODUCT_DELETE`** — سلوك قائم؛ لم أوسّعه (يحتاج قراراً إدارياً).
- **ترقيم مخزون التاجر**: `normalizePage` يعيد دائماً `pageSize=50` ويتجاهل `pageSize` المطلوب (خلل قائم سابق لهذه المهمة، غير مرتبط بالصلاحيات).
- **لا مكتب إداري مخصّص للمخزون**: ADMIN يقرأ `/api/inventory` (كل البائعين) وصفحة `/dashboard/inventory` تعمل له للقراءة عند فتحها مباشرة، لكن لا رابط لها في شريط ADMIN — أُبقي على الحد الأدنى ولم تُضَف صفحة جديدة.
- **`inventory.manage` في الواجهة** تبقى ميزة عرضية (تلميح)؛ الإنفاذ الحقيقي في الخادم عبر صلاحيات `inventory:*`.

### تفاصيل إصلاح PERM-01A

**الملفات المعدّلة:**
- `packages/server/src/modules/admin/routes.ts` — دالة `isSpecializedDeskPath` + حارس عام واعٍ بالمسار.
- `packages/server/src/modules/admin/engines-routes.ts` — أربعة أحراس لكل مكتب بدل الحارس الواحد `ADMIN_*`.
- `packages/server/tests/perm01a-staff-desk-access.test.ts` — 18 حالة (جديد).
- `packages/web/src/pages/AdminPages.tsx` — `StaffOnly` واعٍ بالمكتب (`STAFF_DESK_ROLES`).
- `packages/web/src/App.tsx` — تمرير `desk` لكل صفحة مختصة.
- `packages/web/src/lib/demo-owner-catalog.ts` — ثوابت أدوار لكل مكتب.
- `docs/GAP_REGISTER.md` (توثيق).

**جوهر الإصلاح:** كان `app.route('/api/admin', adminRoutes)` + `app.route('/api/admin', adminEnginesRoutes)`
يتشاركان البادئة، والحارس العام `adminRoutes.use('*', requireRole('ADMIN','SUPER_ADMIN'))` يسبق المكاتب في السلسلة
فيمنعها. الآن الحارس العام يقرأ `c.req.path` (وهو كامل داخل التطبيق الفرعي، كما أثبتته تجربة Hono) ويتنازل **فقط**
عن البادئات الأربعة `verification|trust|risk|disputes`. تُفرض المكاتب في `engines-routes.ts` بصلاحية واحدة لكل مكتب،
فتصبح الصلاحية (لا اسم الدور) هي حدّ الأمان الحقيقي. كل ما هو خارج البادئات الأربع يبقى خلف الحارس العام كما كان.

**الأمان داخل المكتب محفوظ:** كل عملية تحتفظ بحارسها الدقيق الخاص (assign→`dispute:assign`،
decide→`dispute:decide`، recompute→`trust:read:all`، review→`verification:approve/reject`)، فلا يكفي الوصول
للمكتب لتنفيذ أي عملية فيه.

### تفاصيل إصلاح SEC-01 / SEC-02

**الملفات المعدّلة:**
- `packages/server/src/modules/products/routes.ts` (18 إضافة / 5 حذف)
- `packages/server/tests/product-suspension.test.ts` (+4 حالات)
- `docs/GAP_REGISTER.md` (توثيق)

**جوهر الإصلاح:** أُضيفت دالة `hasProductManageAuthority(roles)` التي تستمدّ السلطة الإدارية من RBAC
(`userHasAnyRole(roles, PERM_PRODUCT_MANAGE)`) — وهي صلاحية يملكها **ADMIN وSUPER_ADMIN فقط** — بدلاً من
مصفوفة أدوار مكتوبة يدوياً كانت تضمّ `SUPPORT` خطأً. النتيجة:
- `SUPPORT` يفقد كل سلطة إدارية على كتالوج المنتجات (تعديل/إيقاف/نشر للغير/رفع إيقاف إداري).
- لا يتوسّع أي دور آخر: الأدوار التي لا تملك `product:manage` ولا تملك ملكية المورد تحصل على 403.
- ADMIN/SUPER_ADMIN يحتفظان بكل عمليات التصميم (تعديل/إيقاف/إعادة تنشيط/نشر باسم بائع/نقطة `/:id/suspend`).

---

## 10. مواءمة الأرقام (DOC-GAP-01 — 2026-11-05)

**النوع:** توثيقي بحت. لا كود، لا اختبارات، لا Docker/PostgreSQL، لا commit/push، ولا تغيير لأي حالة فجوة.

### 10.1 أرقام الصلاحيات — 50 مقابل 60 (توحيد)

كلاهما صحيح، بمصدرين مختلفين لـ«غير المستخدمة»:

| الرقم | التعريف | الطريقة (قابلة لإعادة الإنتاج) | المصدر |
| --- | --- | --- | --- |
| **60** | صلاحيات **مُشار إليها برمز** `PERMISSIONS.<KEY>` في `packages/server/src` | عدّ مفاتيح `PERMISSIONS.` الفريدة | عدّ DOC-GAP-01 + PERM-01C §1 |
| **51** | صلاحيات **بلا إشارة رمزية** في الخادم | 111 − 60 | 111 معرّفة في `permissions.ts` |
| **50** | «غير مستخدمة فعلاً» = 51 **ناقص** `ad:create` | `ad:create` مُنفَّذة بآلية أخرى (`ai/agents.ts` عبر `permissionsRequired`) لا برمز `PERMISSIONS.*` | PERM-01C §2.1 |
| **1** | `ad:create` — `ENFORCED_BY_OTHER_MECHANISM` | وكيل AI يفرضها في `createAgentTask` | PERM-01C §2.1 |

**المطابقة:** `60 (رمز) + 1 (آلية أخرى) + 50 (غير مستخدمة) = 111`. ✅

**تصنيف الـ50 (PERM-01C §2، عدا فئة `ENFORCED_BY_OTHER_MECHANISM` = 1):** `PUBLIC_BY_DESIGN` 7 · `OWNERSHIP_BY_DESIGN` 10 · `ROLE_GUARD_BY_DESIGN` 3 · `REDUNDANT_DEFENCE` 20 · `DEAD` 10. المجموع: **50**. ✅ (لم تُحذف أي صلاحية ولم يُغيَّر أي رمز.)

> **ملاحظة:** إشارة سابقة في §9 كانت تقول «50 صلاحية غير مستخدمة» — صحيحة. الرقم «60» في `PERM-01C §1` يصف **المُشار إليها برمز**، لا «غير المستخدمة». لا تعارض بين الرقمين؛ الاختلاف في التعريف فقط.
>
> **تنبيه على تسمية في `PERM-01C`:** عنوان §2 هناك يقول «غير المُشار إليها (50)» بينما فئاته الست مجموعها **51** (لأنه يضمّ `ad:create` ضمن الجدول). التعريف المعتمد هنا هو الأضيق: **50 = غير مستخدمة فعلاً** (يستثني `ad:create`). لم يُعدَّل ملف `PERM-01C` (خارج نطاق DOC-GAP-01)؛ التنبيه موثّق لا مخمَّن.

### 10.2 خطوط أساس الاختبارات — توحيد المصادر

| القيمة | المصدر | الطبيعة |
| --- | --- | --- |
| 69 ملف / 780 اختبار | §9 (2026-11-04) | **تاريخي** (تشغيل حيّ Postgres 16) |
| 73 ملف / 843 حالة | عدّ نصّي (DOC-GAP-01) | **عدّ من الملفات** (`\b(it\|test)\(`) |
| 852 ناجح / 73 ملف | PERM-01C (2026-11-04) | **تاريخي** (`vitest run`) |
| 784 / 796 / 814 / 829 | §9 | **تاريخي** (كل رقم عند مهمته) |

`843` (عدّ نصّي) ≠ `852` (اختبارات نُفِّذت): الأول يحصي الأنماط في الملفات، والثاني يحصي ما نفّذه `vitest` (يشمل توسيع `it.each`). **لا يُستبدل أحدهما بالآخر، ولم يُعَد أي تشغيل في DOC-GAP-01.**

### 10.3 ما تغيّر في هذا الملف (DOC-GAP-01)

| الموضع | قبل | بعد |
| --- | --- | --- |
| ترويسة «خط الأساس للاختبارات» | سطر واحد (69/780) | جدول متعدّد المصادر (A/B/C/D) + توضيح الفارق |
| §1 ملخّص الوضع | 20 / 20 / 8 / 9 | **26 / 20 / 6 / 9** + تفصيل العدّ |
| §2 العنوان | «الفجوات المفتوحة» (يضمّ مكتملة) | ملاحظة توضّح وجود الصفوف المكتملة + المفتوحة الفعلية (4) |
| SEC-01 المرجع | `:115,131,153` (غير مؤكَّد) | «HEAD، الأسطر 115,131,153» + موقع الإصلاح (77/128/144/166) |
| §6 | بلا عدّ | «20 بنداً» + تنبيه تاريخية الأرقام |
| PERM-01C «50» | بلا تعريف | تعريف دقيق + إحالة إلى §10 |
| §10 | غير موجود | هذا القسم |

### 10.4 ما بقي عالقاً (لم يُغلق ولم يُخمَّن)

1. **الفجوات المفتوحة (26)** — كلها بحالة PENDING/BLOCKED كما هي؛ **لم تُغلق أي فجوة** لمجرد وجود توثيق (التزاماً بقاعدة الإغلاق).
2. **`revenue:manage`/`report:read` لـADMIN** — قرار إداري (مفتوح، P2).
3. **الصلاحيات المُضلِّلة للموظفين المتخصصين (R5)** — قرار فتح مكاتب أم إزالة.
4. **إزالة/ربط الصلاحيات الميتة العشر** — قرار إداري.
5. **أدلّة الاختبارات** — تاريخية (`HISTORICAL_EVIDENCE_ONLY`)، و`NOT_VERIFIED` اليوم.
6. **`BU-01/BU-02/BU-04`** — مُدرجة في §8 بلا صف تفصيلي في المستودع (معلومة ناقصة، موثّقة لا مخمَّنة).
7. **DOC-GAP-01 لم يعدّل** `FULL_PROJECT_COVERAGE_AUDIT.md` (متّسق أصلاً على 73/843/852).

### 10.5 توحيد مرجع PS-03/PS-06 (DOC-PS03-ALIGN — 2026-11-06)

**النوع:** توثيقي بحت. لا كود، لا اختبارات، لا Docker/PostgreSQL، لا commit/push، ولا تغيير حالة أي فجوة أخرى.

**سبب التصحيح:** كان السجل المركزي `GAP_REGISTER.md` يسجّل `PS-03` كـ«لا مسار استرداد لـClicToPay (`refund()` يرمي 503)» بينما المرجع الأصلي (`MASTER_GAP_AUDIT.md` و`PILOT_EXECUTION_PLAN.md`) يُثبّت أن **`PS-03` = قدرة Split لدى المزوّد** وأن **`PS-06` = استرداد ClicToPay**. هذا الالتباس أنتج خطورة خاطئة (`MEDIUM` بدل `CRITICAL`) وترتيباً خاطئاً (Split على المسار الحرج، Phase 0).

**المعنى الموحّد المعتمد (المطابق للمرجع الأصلي):**

| المعرّف | الموضوع | المجال | الخطورة | الحالة | الاعتمادية |
| --- | --- | --- | --- | --- | --- |
| **PS-03** | Payment Provider Split Capability (Split / Sub-merchant / توزيع المبالغ) | Payment/Settlement | **CRITICAL** | **BLOCKED** | تأكيد كتابي موثّق من المزوّد + تصنيف صريح `Split supported` / `Provider capability gap` |
| **PS-06** | ClicToPay Refund Capability (لا endpoint استرداد موثَّق؛ المحوّل يرفض بـ503) | Payment/Refund | **HIGH** | **BLOCKED** | توثيق رسمي/عقد من SPS/ClicToPay يحدّد آلية الاسترداد |

**ما تغيّر في هذا الملف:** صف §2 (تصحيح PS-03 + إضافة PS-06)، §8 (تصحيح PS-03 + إضافة PS-06)، §1 (المفتوحة 24→25، الخارجية 9→10، BLOCKED 4→5)، §9 (سطر DOC-PS03-ALIGN)، وهذا القسم. **لم تُغيَّر أي فجوة أخرى.**

**الحقائق التقنية التي لم تُمسّ:** آلة الاسترداد العامة مكتملة وظيفياً (تدقيق سابق)؛ `ClicToPay Refund` غير منفَّذ عمداً (503)؛ `Split` غير منفَّذ في الكود؛ PS-01 وPS-02 مكتملتان ولا تُعادان إلى PENDING؛ وجود كود Flouci/refund عام **ليس** دليلاً على دعم Split أو دعم استرداد ClicToPay.

**ملفات ذات صلة:** `docs/MASTER_GAP_AUDIT.md` (PS-03 §2/§3/§5، PS-06 §2/§3) · `docs/PILOT_EXECUTION_PLAN.md` (PS-03 Phase 0 / C6، PS-06 Phase 5 / C8) · `docs/FULL_PROJECT_COVERAGE_AUDIT.md` (جدول EXTERNAL BLOCKERS) · `docs/PAYMENT_PROVIDER_IPAY_COMPATIBILITY_AUDIT.md` §D (دليل انعدام endpoint الـsplit).

> **ما بقي عالقاً (لم يُخمَّن):** PS-03 وPS-06 كلاهما `BLOCKED` على طرف خارجي؛ ولا يُبدأ أي تنفيذ Split قبل إثبات القدرة وقرار معماري معتمد، ولا يُخترع endpoint استرداد لـClicToPay.

---

### 10.6 إغلاق OBS-01 (DOC-OBS01-CLOSE — 2026-11-06)

**النوع:** تنفيذ + تحقّق حيّ + إغلاق توثيقي. لا commit/push، ولا تغيير في أي فجوة أخرى.

**ما كان:** مسارا `GET /api/payments/webhook-failures` و`POST /api/payments/webhook-failures/:id/replay` موجودان ومحروسان بـ`REFUND_MANAGE`، لكن بلا أي سطح إداري (تبويب أو زر)، وبلا توثيق مشغّل، وبلا تغطية E2E لإظهار الفشل وإعادة التشغيل من الواجهة.

**ما نُفّذ:**

| المحور | التفصيل |
| --- | --- |
| الواجهة | تبويب `webhooks` في `/admin/observability`: جدول FAILED/DEAD_LETTERED (المزوّد/النوع/الحالة/المحاولات/آخر خطأ/التاريخ)، ترقيم `offset`/`total`، زر «إعادة التشغيل» مفعّل فقط لـ`DEAD_LETTERED`، وتأكيد قبل الفعل |
| الخلفية | `listWebhookFailures` يعيد `{ items, total }` مع `offset`؛ `parseNonNegativeIntParam` يمنع `NaN`/`Infinity` قبل SQL؛ الاستجابة لا تحمل `payload`/توقيع |
| الأمان | المساران محروسان بـ`REFUND_MANAGE` (ADMIN/SUPER_ADMIN)؛ إعادة التشغيل تعيد الحدث إلى `RECEIVED` بلا أي أثر مالي (لا `SETTLED`، لا Payout) |
| عيب التدقيق | `writeAudit(ctx.db, ctx, …)` كان يكتب `actorId=NULL` لأن `AppContext` بلا `actorId`؛ صار المسار يمرّر `{ actorId: ctx.user!.id, ipAddress, userAgent }` — مؤكَّد باختبار يقرأ صف التدقيق |
| الاختبارات | Backend `p6-p7-dispute-webhook.test.ts` **19/19** (9 حالات OBS-01 جديدة: هوية التدقيق، 404 لغير الـDEAD_LETTERED/غير الموجود، تزامن → انتقال واحد، لا أثر مالي، ترقيم + offset غير صالح، لا تسريب payload، RBAC SUPER_ADMIN/SUPPORT/RISK/DISPUTE/MERCHANT، 401 للزائر)؛ E2E `admin-webhook-failures.spec.ts` **4/4** |
| التحقّق الحيّ | PostgreSQL 16 معزول (`wasit-obs01-pg`، `wasit_test` فقط): Backend **887/887** (76 ملف) + E2E **226 passed / 8 skipped** (الإخفاقات الثمانية شرطية `DEMO_AUTO_LOGIN`، سابقة) |

**ما تغيّر في هذا الملف:** صف §2 (PENDING→COMPLETED)، §6 (23→24 + صف OBS-01)، §1 (المفتوحة 25→24، المغلقة 23→24)، §2 note، §9 (4 أسطر)، وهذا القسم. **لم تُغيَّر أي فجوة أخرى.**

**ملفات ذات صلة:** `docs/OBS-01_WEBHOOK_FAILURES_REPLAY.md` · `packages/server/tests/p6-p7-dispute-webhook.test.ts` · `e2e/admin-webhook-failures.spec.ts` · `packages/web/src/pages/AdminObservabilityPage.tsx`.

**ما بقي عالقاً:** لا شيء داخل نطاق OBS-01. القيود المالية القائمة (`Paid ≠ Settled`، لا Payout تلقائي) لم تُمسّ.

---

## 11. إغلاق M1.9.0-A2 وفجوات التحقّق (DOC-A2-CLOSE — 2026-11-07)

**النوع:** توثيقي بحت. لا كود، لا Migration، لا Schema، لا Snapshot، لا اختبارات، لا Docker/PostgreSQL، لا commit/push. **لم تُغيَّر حالة أي فجوة قائمة.**

**ما أُغلق:** المهمة **M1.9.0-A2** (التحقّق الحيّ المعزول لسلسلة الترحيلات 0029–0036) → **CLOSED / VERIFIED**. نتائجها الكاملة في `docs/M1.9.0-A1_MIGRATION_CHAIN.md` §9. المهمة نفسها **ليست صفّ فجوة** في §2–§5 (كانت مهمة تحقّق، لا فجوة منتج)، لذا لا يوجد «بند A2» لإغلاقه في الجداول؛ إغلاقها مسجّل هنا وفي §9.

**حدود الإثبات المُثبتة بدقّة:** T1 قاعدة فارغة (0000→0036، 37/37) · T2 ترقية اصطناعية (0028 → بيانات اصطناعية → 0029→0036) · ثبات بصمات `agent_registry`/`agent_tasks`/`agent_schedules` · 0029 (رفض التكرار + نجاح إعادة الترحيل) · 0032 (رفض التكرار المفتوح + rollback + نجاح إعادة الترحيل) · Dedupe 9/9 · **282/282** (AI/الجدولة/Recovery) و**1079/1079** (الحزمة الكاملة، مجموعتان مختلفتان) · فحوص TypeScript/Drizzle/Schema-drift سليمة · تنظيف Docker والحاوية والشبكة والأسرار · **DEMO لم تُمس** وM0-RECOVERY سليمة · لا تغيير على كود المشروع أو Git خلال A2.

### 11.1 الفجوتان المفتوحتان الجديدتان

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GAP-A2-01** | Verification/DB | **ترقية البيانات الفعلية غير مثبتة:** التحقّق جرى على قاعدة **اصطناعية** أُعيد بناؤها إلى مخطط 0028 وبها بيانات اختبار مُصطنعة. لم تُختبر نسخة فعلية من قاعدة **إنتاج/تطوير**، ولا أحجام البيانات الحقيقية، ولا الحالات الحدّية فيها. | HIGH | P1 | نسخة قاعدة فعلية + إذن | OPEN | `DOCUMENTED LIMITATION`. **لا تمنع إغلاق A2**، لكنها **تمنع** الادعاء بأن الترقية على بيانات إنتاج مثبتة. |
| **GAP-A2-02** | Documentation/Evidence | **أرشفة الأدلة الخام:** ملفات `harness`/`logs`/`facts`/`snapshots` المؤقتة حُذفت عند التنظيف. الدليل الباقي هو **سجل أحداث المحادثة** الأصلي (النافذة `2026-11-07T04:55:14Z` → `2026-11-07T05:20:32Z`). **لم تُؤرشَف الملفات الخام.** | LOW | P2 | — | OPEN | `DOCUMENTATION LIMITATION`. لا يُدَّعى أرشفة الملفات الخام، ولم يُنسخ سجل المحادثة الكامل إلى المستودع. |

**ما تغيّر في هذا الملف:** ترويسة (ملاحظة DOC-A2-CLOSE) · §1 (المفتوحة 22→24) + تفصيل العدّ · §9 (9 أسطر A2) · هذا القسم (§11). **لم تُغيَّر أي فجوة قائمة، ولم تُغلق أي فجوة تحقّق على بيانات فعلية.**

**ملفات ذات صلة:** `docs/M1.9.0-A1_MIGRATION_CHAIN.md` (§9) · `packages/server/src/db/migrations/0029…0036` (مرجعية فقط، بلا تعديل) · سجل أحداث المحادثة `994885a56c1b4f03b783237e3322183f`.

---

## 12. حماية الموارد (011.4 — حدّ المعدّل + حجم الجسم + التزامن) — 2026-11-08

**النوع:** تنفيذ كود + اختبارات. **بلا Migration/Seed/DEMO/إنتاج. لا commit/stage/push.**

**الفجوة المُعالَجة (بند منتج جديد):** لم يكن هناك حدّ معدّل **عام** على `/api/*`، ولا سقف لحجم الجسم على مستوى التطبيق، ولا حدّ لمعدّل مسارات الذكاء الاصطناعي/البحث/توليد الفيديو، ولا سقف للمهام الفعّالة لكل مستخدم، ولا حدّ لعدد عمليات توليد الفيديو المتزامنة. عميل واحد (أو سكربت) كان يستطيع إغراق مسار مكلف (توليد فيديو/ذكاء اصطناعي/بحث) أو إرسال جسم ضخم.

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **SEC-011.4** | Security/API | **استنزاف الموارد:** لا حدّ عام على `/api/*`، ولا سقف حجم جسم على مستوى التطبيق، ولا حدود خاصة بمسارات AI/البحث/توليد الفيديو، ولا سقف للمهام الفعّالة لكل مستخدم، ولا حدّ تزامن لعمليات توليد الفيديو. | HIGH | P1 | — | **COMPLETE_VERIFIED** | `middleware/rate-limit.ts` (موضوع `auto`/`user`/`ip` + ترويسة `Retry-After` + **fail-closed 503** + مسارات مستثناة) · `middleware/body-limit.ts` (**413 PAYLOAD_TOO_LARGE** قبل أي handler) · `lib/concurrency/semaphore.ts` (سقف تزامن) · ربط `app.ts` · سقف المهام الفعّالة في `modules/ai/agents.ts` · `RATE_LIMIT_*`/`MAX_REQUEST_BODY_BYTES`/`MEDIA_VIDEO_MAX_CONCURRENCY`/`AI_AGENT_MAX_ACTIVE_TASKS_PER_USER` في `env.ts` + توثيق `.env.example`/دليل البيئة. **الثقة بعنوان العميل عبر `lib/net/client-ip.ts` فقط** ⇒ XFF المزوّر لا يحرّك الدلو (SEC-XFF-01). |

**الأدلة (تحقّق حيّ على PostgreSQL 17 معزول `wasit_test`):** `packages/server/tests/sec0114-rate-limit-resource.test.ts` **16/16** — سقف الجسم (413 + عدم تسريب الحجم) · الحدّ العام (429 + `Retry-After` + عدم تسريب المفتاح/العنوان) · استثناء `/api/auth` و`/api/health` · حدّ AI لكل مستخدم مستقلّ + backstop لكل IP + عدم تجاوز المصادقة (401) · حدّ البحث لكل IP · حدّ الفيديو لكل مستخدم · سقف المهام الفعّالة · **XFF متغيّر لا يحرّك الدلو** (عام + بحث) · **fail-closed 503** عند تعطّل مخزن الحدود (لا تمرير صامت، بلا تسريب رسالة الخطأ) · `Semaphore` (سقف، إشهار 503 عند انتهاء المهلة، تسليم الدور للمنتظر، تحرير عند الاستثناء). **التراجع:** الحزمة الكاملة للخادم **1374/1374** (110 ملف، EXIT=0) + `security-privacy`(19)/`rate-limit`(12)/`client-ip`(32)/`marketing-video`(86) ✅ · Typecheck (server) **exit 0**. (تشغيل سابق أظهر `read-cache.test.ts` **عابراً** 1373/1374 — ينجح معزولاً 9/9، سببه تسابق على عدّ الفئات في قاعدة `wasit_test` المشتركة عبر ملفات متوازية، لا علاقة له بالتغيير؛ أكّد التشغيل اللاحق نظافة الحزمة.)

**ملاحظات تصميم (حدود الإثبات):** حدّ `auto` **لا يفرض** تحميل الجلسة (يحافظ على «الحدّ يعمل قبل المصادقة» وثبات دلو الطلب) — فقط `subject:'user'` يفرضه؛ القيم تُقرأ لكل طلب من البيئة الحيّة (قابلة للضبط بلا إعادة بناء)؛ الاعتماد على التزامن (`Semaphore`) **لكل عملية (process)** — عند تشغيل أكثر من نسخة API يلزم `RATE_LIMIT_STORE=postgres` (موثّق) وسقف التزامن يبقى لكل نسخة لا عالمياً.

**ملفات:** `packages/server/src/middleware/{rate-limit,body-limit}.ts` · `packages/server/src/lib/concurrency/semaphore.ts` · `packages/server/src/app.ts` · `packages/server/src/lib/env.ts` · `packages/server/src/modules/{ai/agents,media/service}.ts` · `packages/shared/src/errors/api-error.ts` · `packages/server/tests/sec0114-rate-limit-resource.test.ts` · `packages/server/.env.example` · `docs/commercial-release/03-ENVIRONMENT-REFERENCE.md`.

**سجل التنفيذ:** يُضاف سطران في §9 (`011.4 — تنفيذ` و`011.4 — تحقّق`).

---

## 13. M2.1 — إلغاء الطلبات الفرعية وتصحيح المخزون (2026-11-03)

**النوع:** تنفيذ كود + اختبارات + توثيق. **بلا Migration/Seed/DEMO/إنتاج. لا commit/stage/push.**

**الخلل المُصلَح (انحدار M2 — كُشف بالتدقيق المستقل):** قرار المخزون عند الإلغاء (`restoreStock` مقابل `releaseReservation`) كان يُتَّخذ من حالة **Parent Order** (`order[0].status`) لا من حالة **Seller Suborder** المستهدف. الأثر: في سلة متعدّدة البائعين تكون حالة الأم `PENDING` (لأن فرعية أخرى لم تُؤكَّد بعد)، فإلغاء فرعية **مؤكَّدة** (مخزونها مخصوم فعلاً) كان يستدعي `releaseReservation` بدل `restoreStockForCancelledOrder` ⇒ **مخزون البائع المؤكَّد لا يُعاد**. وخلل مصاحب: إلغاء الأم لسلة بحالات مختلفة كان يطبّق قاعدة واحدة (المبنية على حالة الأم) على كل الفرعيات.

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.1-CANCEL-INV** | Orders/Inventory | **قرار مخزون الفرعية مبني على حالة الأم:** `updateOrderStatus` كان يقرأ `order[0].status` لتحديد «مُخصوم/محجوز»، فيُخطئ في إعادة مخزون فرعية مؤكَّدة داخل سلة متعدّدة البائعين حالتها الأم `PENDING`؛ وإلغاء الأم المختلط كان يعامل كل الفرعيات بقاعدة واحدة. | HIGH | P1 | — | **COMPLETE_VERIFIED** | الإصلاح: `applyInventory(items, priorStatus)` يُستدعى بحالة **السجل المستهدف** (الفرعية عند استهدافها، الأم للطلب القديم)، وإلغاء الأم يعالج كل فرعية على حدة وفق حالتها. الملف: `modules/orders/service.ts`. **الأدلة:** `tests/m21-cancel-inventory.test.ts` **9/9** على PostgreSQL 17 معزول (`wasit_test` @5434) + تراجعات الطلبات/المخزون/الدفع/التسوية **152/152** + الحزمة الكاملة للخادم (انظر §9) + Typecheck (server) نظيف. |
| **M2.1-PARENT-STATUS** | Orders | **حالة أم مضلِّلة عند الإلغاء الجزئي:** `aggregateParentStatus` كانت تُرجِع `PENDING` إذا وُجدت أي فرعية معلّقة، فتبدو السلة المختلطة (فرعية مؤكَّدة + فرعية ملغاة) «معلّقة» رغم أن الجزء الحي مؤكَّد. | MEDIUM | P1 | — | **COMPLETE_VERIFIED** | الإصلاح: تُستبعد الفرعيات `CANCELLED` من التلخيص وتُبنى حالة الأم على الأجزاء الحيّة فقط (مع الحفاظ على معاني الحالات القائمة، بلا حالات جديدة). اختبار: «partially cancelled basket» في `m21-cancel-inventory.test.ts`. |
| **M2.2-PAYOUT-SUBORDER** | Payments/Payouts | **Payout لكل Seller Suborder غير منفَّذ:** جدول `payouts` مفتاحه `transaction_id` واحد، والطلب متعدّد البائعين يُرفَض حالياً **فشل-مغلقاً** (409) بدل إنشاء دفع لكل بائع فرعي. الأثر: البائعون في الطلبات المختلطة لا يستطيعون تحصيل مستحقاتهم عبر المسار الآلي. | HIGH | P1 | PS-03 (قدرة Split لدى المزوّد) | **COMPLETE_VERIFIED (§14)** | نُفِّذ في §14: ربط `payouts` بـ`seller_order_id` + احتساب المستحق من الفرعية + فهرس `payouts_unit_live_idx`. الأدلة: `tests/m22-t2-suborder-payout.test.ts` **21/21** + مجموعة Payout/Finance **119/119**. |
| **M2.3-SUBORDER-SETTLEMENT** | Payments/Settlement | **`seller_orders.settlement_status` لا يكتبه أي كود:** يبقى `PENDING` دائماً؛ التسوية تُحدِّث `orders.settlement_status` والدفتر على مستوى الأم فقط، فلا تعكس حالة تسوية كل بائع فرعي. | MEDIUM | P2 | M2.2-PAYOUT-SUBORDER | **COMPLETE_VERIFIED (§15)** | نُفِّذ في §15: جدول `seller_settlements` (Migration 0039) + كاتب واحد `settleSellerSuborder` يكتب `settlement_status` + ربط تلقائي عند التسليم + بوابة دفع. الأدلة: `tests/m23-t2-suborder-settlement.test.ts` **20/20** + الحزمة الكاملة **1573/1573**. |
| **M2.4-REFUND-SUBORDER** | Payments/Refunds | **الاسترداد لا يُحدِّث حالة الفرعيات:** عكس العمولة/الرسوم في الدفتر يشمل كل البائعين ✅، لكن `seller_orders.status`/`settlement_status` لا يُحدَّثان عند الاسترداد الكامل أو الجزئي، فتبقى الفرعية `PENDING` بعد استرداد كامل. | MEDIUM | P2 | M2.2/M2.3 | **CLOSED (§16–§19 + سجل الإغلاق §20)** | أُنجزت **T2.1** (أساس البيانات: جدول `refund_allocations`، Migration 0040) و**T2.2** (إنشاء الاسترداد بالتخصيص لكل بائع: تحقق + تزامن + idempotency) و**T2.3** (عند الاكتمال: حالة كل فرعية `REFUNDED` على نصيبها + عكس عمولة كل بائع على نصيب فرعيته + منع تسوية الفرعية المستردة) و**T2.4** (واجهة عرض التخصيص لكل بائع — قراءة فقط). **الأدلة:** 45/45 اختبار خادم للمراحل الأربع + 12/12 اختبار ويب + `tsc` نظيف (انظر §20). |
| **M2.5-TX-SELLER-ATTRIBUTION** | Trust Engine | **إسناد `transactions.sellerId` للبائع الأول:** في الطلب متعدّد البائعين يُكتب `transactions.sellerId = soleSeller ?? firstProduct.sellerId` ⇒ يُنسب كامل السلة لبائع واحد في مجاميع الثقة (`trust-engine.ts` يقرأ `transactions.sellerId`). | LOW | P2 | — | **CLOSED (§21–§22)** | **T1 (تصميم):** `docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md`. **T2 (تنفيذ):** طبقة إسناد مركزية `lib/seller-attribution.ts` (اشتقاق من `seller_orders` + احتياطي للبائع الواحد القديم، واستبعاد المختلط غير القابل للإسناد) مربوطة في `trust-engine.ts`؛ **بلا Migration وبلا مسّ `transactions.sellerId`**. **T3 (تدقيق اتساق حالة الدفع):** `orders.payment_status` هو دلالة النجاح؛ لا مسار كتابة يُنتج اختلافاً مؤثّراً (انظر §22). **الأدلة:** `tests/m25-tx-seller-attribution.test.ts` **18/18** + تراجع payments(19)/money-path(6)/verification-trust(11)/analytics(15)/revenue(16) + `tsc` نظيف. |

**حدود الإثبات:** الإصلاح يقتصر على مسار الإلغاء/المخزون وتجميع حالة الأم. **لا Payout، ولا تغييرات مزوّد دفع، ولا Migration جديدة.** حالات `PROCESSING`/`SHIPPED`/`DELIVERED`/`COMPLETED` كلها «بعد الخصم» بحكم أن الخصم يقع حصراً عند `CONFIRMED` (بلا حارس انتقالات)، لذا تُعالَج كـ«مُخصومة» عند الإلغاء.

**ملفات:** `packages/server/src/modules/orders/service.ts` · `packages/server/tests/m21-cancel-inventory.test.ts` · `AGENTS.md` · هذا الملف.

**الأثر على العدّ:** **لا تغيير** — الصفوف الخمسة أعلاه إمّا **مُغلقة جديدة** (`M2.1-CANCEL-INV`، `M2.1-PARENT-STATUS`، كلاهما `COMPLETE_VERIFIED`) أو **مفتوحة جديدة موثَّقة** (`M2.2`–`M2.5`). وبما أن العدّاد الحالي يعتمد **تعريفاً صريحاً للصفوف في §2–§5**، وهذه صفوف M2 جديدة في قسم مستقل (§13)، يُسجَّل هنا للشفافية: **مغلقة +2** و**مفتوحة +4** على مستوى هذا القسم. تحديث العدّاد في §1 مهمة توثيقية منفصلة تُترك للمالك كي لا يُغيَّر الرقم بلا مراجعة.

## 14. M2.2 — Payout لكل Seller Suborder (2026-11-14)

**النوع:** تنفيذ كود + اختبارات + توثيق. **بلا Migration جديدة/Seed/DEMO/إنتاج. لا commit/stage/push.**

**السياق:** Migration 0038 (M2.2-T1) جهّزت البنية على مستوى قاعدة البيانات: عمود `payouts.seller_order_id`، المفتاح الأجنبي المركّب `payouts_suborder_fk` (suborder, order, seller) → `seller_orders(id, parent_order_id, seller_id)`، وفهرس `payouts_unit_live_idx` الفريد. **T2** يربط هذه البنية بالخدمة والـAPI والواجهة.

**ما تغيّر:**

| الملف | التغيير |
| --- | --- |
| `src/modules/payouts/engine.ts` | إضافة `sellerOrderId?: string \| null` إلى `PayoutRecord`. |
| `src/modules/payouts/service.ts` | `createPayout` يستقبل `sellerOrderId`؛ يفرضه للطلبات ذات الفرعيات ويرفضه للطلبات القديمة؛ المبلغ = `seller_orders.seller_payable` للفرعية، ومن `computeSellerPayable(order)` للطلب القديم؛ يمرّر `seller_order_id` في الإدراج؛ رسائل 409/422 دقيقة. |
| `src/modules/finance/routes.ts` | `payoutSchema` يقبل `sellerOrderId` اختيارياً؛ يُمرَّر إلى الخدمة. |
| `packages/web/src/lib/types.ts` | `PayoutRecord.sellerOrderId`. |
| `packages/web/src/lib/api.ts` | `financeCreatePayout` يقبل `sellerOrderId`. |
| `packages/web/src/pages/AdminFinancePages.tsx` | حقل إدخال «معرّف الطلب الفرعي (اختياري)» في تبويب الدفعات. |
| `packages/web/src/lib/i18n.ts` | مفتاحان جديدان في ar/fr/en/zh. |
| `tests/m22-t2-suborder-payout.test.ts` | ملف جديد: 21 اختباراً. |
| `tests/persistence-invariants.test.ts`، `tests/finance-routes.test.ts` | تحديث المُهيّئين لتمرير `sellerOrderId` (الطلبات المُنشأة عبر API صار لها فرعية). |

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.2-PAYOUT-SUBORDER** | Payments/Payouts | **Payout لكل Seller Suborder غير منفَّذ** (كان مفتوحاً في §13). | HIGH | P1 | Migration 0038 (منفَّذة) | **COMPLETE_VERIFIED** | `createPayout` صار يُصدر دفعة لكل فرعية: الوحدة = الفرعية، المبلغ = `seller_payable`، والقيد المركّب يضمن انتماء الفرعية للطلب والبائع. **الأدلة:** `tests/m22-t2-suborder-payout.test.ts` **21/21** على PostgreSQL 17 معزول (`wasit_test` @5434) + مجموعة Payout/Finance/الاستمرارية **119/119** + حارس الاختبارات **10/10** + Typecheck (server+web) نظيف + `drizzle-kit check` نظيف. |

**قواعد T2 المُنفَّذة:**
- **أ. الطلب متعدد البائعين:** `sellerOrderId` إلزامي، ويجب أن ينتمي للطلب الأب المحدد؛ البائع يُشتق من الفرعية (لا يُمرَّر)؛ أي عدم تطابق يُرفض (422)، والقيد المركّب يرفض أي كتابة مباشرة ببائع مغاير.
- **ب. الطلب القديم أحادي البائع:** يعمل بـ`seller_order_id = NULL`؛ تمرير `sellerOrderId` له يُرفض.
- **ج. المبلغ:** من `seller_orders.seller_payable` (وليس إجمالي الأب)، بلا دفع جزئي، بلا مبلغ يتجاوز المستحق، بعملة الفرعية ودقة 4 منازل. أي مبلغ يُمرَّر من المستدعي يُتجاهل.
- **د. شروط السماح:** شرط التسوية القائم = قيد `SETTLEMENT` بحالة `SETTLED` على المعاملة؛ حالة الطلب الأب وحدها ليست دليلاً. **`seller_orders.settlement_status` غير مُبوَّب** (تخص M2.3) — لم تُخترع بوابة جديدة.
- **هـ. منع التكرار والتزامن:** الفهرس الفريد `payouts_unit_live_idx` هو الحماية النهائية (وليس الفحص المسبق)؛ `FAILED` مستثنى فيسمح بمحاولة جديدة؛ `CREATED/PROCESSING/HELD/COMPLETED` تمنع أي محاولة ثانية.
- **و. الفشل وإعادة المحاولة:** الحالات `CREATED/PROCESSING/HELD/COMPLETED/FAILED`؛ `HELD` للحالات غير الحاسمة؛ لا حذف للسجلات التاريخية؛ لا تحويل فشل مؤكد إلى نجاح بلا دليل.

**حدود الإثبات:** لا Wallet، لا أرصدة، لا مزوّد خارجي، لا Refund (M2.4)، لا Seller Suborder Settlement (M2.3)، لا تغيير نسب عمولة، لا Migration جديدة.

**ملفات:** `packages/server/src/modules/payouts/{engine,service}.ts` · `packages/server/src/modules/finance/routes.ts` · `packages/web/src/{lib/types,lib/api,pages/AdminFinancePages,lib/i18n}.ts(x)` · `packages/server/tests/m22-t2-suborder-payout.test.ts` · `docs/M2.2-T2_SUBORDER_PAYOUT.md` · هذا الملف.

**الأثر على العدّ:** **مغلقة +1** (`M2.2-PAYOUT-SUBORDER` انتقل من `OPEN` إلى `COMPLETE_VERIFIED`). تبقى `M2.3`/`M2.4`/`M2.5` مفتوحة. تحديث العدّاد في §1 مهمة توثيقية منفصلة تُترك للمالك.

---

## 15. M2.3 — تسوية كل Seller Suborder (2026-11-14)

**النوع:** تنفيذ كود + اختبارات + توثيق. **بلا Migration جديدة بعد 0039، بلا Seed، بلا DEMO/إنتاج، بلا commit/stage/push.**

**السياق:** Migration 0039 (M2.3-T1) جهّزت البنية على مستوى قاعدة البيانات: جدول `seller_settlements`، ست قيود `CHECK` (`seller_settlements_amount_positive`، `_currency_len`، `_parent_is_settled`، `_parent_is_settlement`، `_settled_requires_at`، `_status_settled`)، ثلاث مفاتيح أجنبية مركّبة (منها `seller_settlements_parent_entry_fk`)، والفهارس. **T2** يربط هذه البنية بالخدمة والـAPI والواجهة، ويجعل `seller_orders.settlement_status` مكتوباً فعلاً.

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.3-SUBORDER-SETTLEMENT** | Payments/Settlement | **`seller_orders.settlement_status` لا يكتبه أي كود** (كان مفتوحاً في §13). | MEDIUM | P2 | Migration 0039 (منفَّذة) | **COMPLETE_VERIFIED** | كاتب واحد `settleSellerSuborder` يكتب `settlement_status`، وربط تلقائي عند التسليم، وبوابة دفع تمنع الدفع قبل تسوية الفرعية. **الأدلة:** `tests/m23-t2-suborder-settlement.test.ts` **20/20** على PostgreSQL 17 معزول (`wasit_test` @5434) + الحزمة الكاملة للخادم **1573/1573** (123 ملف) + حزمة الويب **51/51** + Typecheck (server+web) نظيف + `drizzle-kit check` نظيف. |

**الكاتب الوحيد:** `settleSellerSuborder` هو الكاتب الوحيد لـ`seller_orders.settlement_status = 'SETTLED'`. ترتيب الأقفال الثابت: **الفرعية أولاً، ثم المعاملة الأب** — نفس ترتيب `createPayout` و`confirmSettlement`، فلا deadlock بين المسارات.

**شروط الأهلية:** التسوية تتطلّب فرعية `DELIVERED`/`COMPLETED`، طلباً `PAID`، بلا استرداد (كامل/جزئي/قيد المعالجة)، بلا نزاع مفتوح، وقيود `SETTLEMENT / SETTLED` على المعاملة الأب. كل رفض يُسجَّل في `audit_logs` ويُعاد مع السبب.

**الربط التلقائي:** `updateOrderStatus` يستدعي التسوية **بعد commit** الانتقال إلى `DELIVERED`، بشكل best-effort ومتكرّر-آمن: فشل التسوية لا يُلغي انتقالاً نجح، والفرعية غير المؤهّلة تبقى `PENDING` ويُلتقطها مسار إعادة المعالجة الإداري.

**بوابة الدفع:** `createPayout` صار داخل معاملة، يأخذ قفل الفرعية ثم المعاملة **قبل** أي بوابة، ويفحص قيد التسوية الأب أولاً ثم تسوية الفرعية ⇒ `Cannot create a payout before this seller suborder is settled`.

**مسار الإدارة:** `POST /api/admin/finance/settlements/suborders/reconcile` (صلاحية `COMMISSION_MANAGE`/`PAYMENT_READ`) — idempotent، يعيد حكماً لكل فرعية، ولا يكتب أي قيد دفتر.

**حدود الإثبات:** لا Refund على مستوى الفرعية (M2.4)، لا تغيير في إسناد `transactions.sellerId` (M2.5)، لا Wallet، لا مزوّد خارجي فعّال، لا reverse-settlement.

**ملفات:** `packages/server/src/db/migrations/0039_seller_settlements.sql` · `packages/server/src/modules/settlements/service.ts` · `packages/server/src/modules/orders/service.ts` · `packages/server/src/modules/payouts/service.ts` · `packages/server/src/modules/finance/routes.ts` · `packages/web/src/{lib/types,lib/api,pages/AdminFinancePages,lib/i18n}.ts(x)` · `packages/server/tests/m23-t2-suborder-settlement.test.ts` · `packages/web/tests/m23-i18n.test.ts` · `docs/M2.3-T2_SUBORDER_SETTLEMENT.md` · هذا الملف.

**الأثر على العدّ:** **مغلقة +1** (`M2.3-SUBORDER-SETTLEMENT` انتقل من `OPEN` إلى `COMPLETE_VERIFIED`). تبقى `M2.4`/`M2.5` مفتوحة. تحديث العدّاد في §1 مهمة توثيقية منفصلة تُترك للمالك.

---

## 16. M2.4-T2.1 — أساس بيانات تخصيص الاستردادات (Refund Allocation) (2026-11-03)

**النوع:** تصميم + Migration جديدة (0040) + اختبارات بنية. **بلا منطق خدمة، بلا Seed، بلا DEMO/إنتاج، بلا commit/stage/push.** **Migration 0040 لم تُطبَّق على أي قاعدة بيانات** (PostgreSQL غير متاح في هذه البيئة — راجع «حدود الإثبات»).

**السياق:** M2.4-T1 (اكتشاف/تصميم) أثبت أن الاسترداد يعمل حالياً على مستوى الطلب الأب بالكامل: عكس العمولة/الرسوم يشمل كل البائعين، ولا يوجد أي إسناد لبائع في نموذج البيانات (`refunds` بلا `seller_order_id`). **T2.1** يبني الأساس الذي سيُنسَب عليه الاسترداد للفرعية لاحقاً (طبقة الخدمة في T2.2+)، دون أي تغيير في السلوك الحالي.

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.4-REFUND-SUBORDER** | Payments/Refunds | الاسترداد لا يُنسَب لبائع ولا يُحدِّث حالة الفرعية (مفتوحة في §13). | MEDIUM | P2 | Migration 0040 (منفَّذة، غير مُطبَّقة) | **PARTIAL — T2.1 مكتمل** | أساس البيانات جاهز؛ تبقى طبقة الخدمة والواجهة (T2.2+). |

**الجدول الجديد:** `refund_allocations` — استرداد واحد يمكن أن يُوزَّع على عدة فرعيات (بائعين مختلفين). الأعمدة: `id`، `refund_id`، `parent_order_id`، `seller_order_id`، `order_item_id` (اختياري)، `amount`، `currency_code`، `created_at`. **ليس حركة مالية ولا قيد دفتر ولا محفظة ولا رصيد** — لا مجاميع جارية ولا تراكم لكل بائع؛ الاسترداد نفسه يبقى مصدر الحقيقة (`refunds.status` + قيد `REFUND`)، وهذه الصفوف تقول فقط **لأي بائعين** يُنسب استرداد مسجَّل.

**العلاقات (مثبتة على مستوى قاعدة البيانات):**
- `refund_allocations_refund_fk` → `refunds(id, order_id)`: طلب التخصيص هو طلب الاسترداد نفسه.
- `refund_allocations_suborder_fk` → `seller_orders(id, parent_order_id, currency_code)`: الفرعية تخص نفس الطلب الأب، **ونفس عملة التخصيص**.
- `refund_allocations_item_fk` → `order_items(id, order_id, seller_order_id)`: البند يخص **نفس الطلب الأب ونفس الفرعية** (قابل للـNULL: تخصيص على مستوى الفرعية بلا بند — `MATCH SIMPLE`).

**القيود والفهارس:** قيدا `CHECK` (`amount > 0`، `length(currency_code) = 3`)؛ فهرس فريد `refund_allocations_refund_suborder_idx (refund_id, seller_order_id)` لمنع التكرار غير الصحيح (استرداد واحد لا يُنسب لنفس الفرعية مرتين)؛ فهارس مساندة على `refund_id`/`seller_order_id`/`parent_order_id`/`order_item_id`.

**ثلاثة فهارس هوية جديدة (UNIQUE، additive):** `refunds_identity_idx (id, order_id)`، `order_items_identity_idx (id, order_id, seller_order_id)`، `seller_orders_identity_currency_idx (id, parent_order_id, currency_code)`. **ملاحظة تصميمية:** عمود `seller_id` مُستبعَد عمداً من فهرس الفرعية لأن المفتاح الأجنبي يتطلب فهرساً فريداً بنفس أعمدة المرجع بالضبط؛ ومفتاح `refund_fk` على العمودين `(refund_id, parent_order_id)` يضمن أصلاً أن الطلب الأب يطابق طلب الاسترداد، فلا فائدة من تكرار `seller_id`.

**ترتيب الإنشاء (خطأ 42830):** تماماً كما في 0039، يجب إنشاء فهارس الهوية **قبل** المفاتيح الأجنبية التي تشير إليها (المفتاح المركّب يتطلب هدفاً فريداً موجوداً). الملف المكتوب يدوياً يصحّح ترتيب ما يُنتجه `drizzle-kit generate` (الذي يضع المفاتيح أولاً) — نفس الخلل ونفس التصحيح المُعتمد في 0039.

**حارس الانحراف:** كتلة `DO $$` في رأس الملف ترفض التنفيذ إذا وُجد كائن بالاسم نفسه بتعريف مختلف (جدول بلا الأعمدة المتوقعة، أو فهرس/قيد بتعريف غير متوقع) — نفس نمط 0039.

**حدود الإثبات:** PostgreSQL **غير متاح** في بيئة هذه المهمة (لا ملفات تنفيذية، المنفذان 5434/5432 غير مستمعين)، **ولم يُشغَّل ولم تُطبَّق 0040 على أي قاعدة**. لذلك لم تُنفَّذ اختبارات قيود الفحص الحي (مرفوضة/مقبولة). ما أُثبت: `drizzle-kit check` نظيف، `tsc` للخادم نظيف، وتوليد Drizzle لا يُنتج أي تغيير (snapshot مطابق للمخطط حرفياً)، وسلسلة snapshot 0039→0040 متّصلة. الاختبارات المكتوبة (`tests/m24-t21-refund-allocation-schema.test.ts`) تُشغَّل عند توفّر PostgreSQL.

**ملفات:** `packages/server/src/db/schema/commerce.ts` · `packages/server/src/db/migrations/0040_refund_allocations.sql` · `packages/server/src/db/migrations/meta/0040_snapshot.json` · `packages/server/src/db/migrations/meta/_journal.json` · `packages/server/tests/m24-t21-refund-allocation-schema.test.ts` · `docs/M2.4-T2.1_REFUND_ALLOCATION.md` · هذا الملف · `AGENTS.md`.

**الأثر على العدّ:** `M2.4-REFUND-SUBORDER` لا تزال **مفتوحة** (انتقلت إلى **PARTIAL — T2.1 مكتمل**). لا فجوة مغلقة.

## 17. M2.4-T2.2 — إنشاء الاسترداد مع التخصيص لكل بائع (Refund Creation & Allocation) (2026-11-03)

**النوع:** منطق خدمة + مسار API + اختبارات. **بلا Migration جديدة، بلا Seed، بلا DEMO/إنتاج، بلا commit/stage/push.** الكود مكتوب و`tsc` نظيف؛ **اختبارات قاعدة البيانات لم تُشغَّل** (PostgreSQL غير متاح).

**السياق:** T2.1 بنى أساس البيانات (`refund_allocations`) فقط. **T2.2** يجعل `createRefund` يكتب التخصيصات فعلياً: يقبل `allocations` اختيارية، يتحقق منها مقابل بنية الطلب الحقيقية، ويحميها من التجاوز والتكرار والتزامن — **مع بقاء الإنشاء ≠ الاكتمال**: لا قيد `REFUND` ولا تغيير حالة الطلب/الفرعية هنا (ذلك حصراً في `completeRefundWithEvidence`).

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.4-REFUND-SUBORDER** | Payments/Refunds | الاسترداد لا يُنسَب لبائع ولا يُحدِّث حالة الفرعية (مفتوحة في §13). | MEDIUM | P2 | Migration 0040 (منفَّذة، غير مُطبَّقة) | **PARTIAL — T2.1 + T2.2 مكتملان** | أساس البيانات + إنشاء الاسترداد بالتخصيص جاهزان؛ تبقى تحديث حالة الفرعية وعكس العمولة لكل بائع (T2.3+) والواجهة. |

**منطق التحقق (`resolveRefundAllocations` في `payments/service.ts`):**
- **بلا `allocations` = استرداد كامل** يُوزَّع على الفرعيات بحسب **المتبقّي القابل للاسترداد الفعلي** لكل فرعية (توزيع الباقي الأكبر) — لا توزيع متساوٍ ولا عشوائي؛ المجموع يساوي المبلغ بالضبط.
- **مع `allocations`:** المجموع = مبلغ الاسترداد بالضبط؛ كل فرعية/بند يخص هذا الطلب؛ لا تكرار لفرعية/بند؛ لا تجاوز سقف الفرعية/البند.
- **قاعدة السقف:** سقف الفرعية = `items_total + buyer_commission` (ما دفعه المشتري فعلاً) — **ليس `seller_payable`** (صافي البائع) — مطابقةً لتقرير M2.4-T1.
- **البائع الواحد:** استرداد جزئي بلا تخصيص يُقبل ويُنسب للفرعية الوحيدة (يحفظ سلوك ما قبل M2). **متعدد البائعين:** استرداد جزئي بلا تخصيص **مرفوض** (`422`) — لا تخمين.
- **الطلب القديم بلا فرعيات:** تُرجَع `[]` (لا كسر).

**التزامن (`db.transaction` واحدة):** قفل صف الطلب `FOR UPDATE` (قفل أول ثابت لا تأخذه مسارات التسوية/الدفع ⇒ لا دورة) ← قراءة المتبقّي من `refunds` ← قفل الفرعيات ثم البنود المرجعية بترتيب ثابت ← قراءة التخصيصات المحجوزة (مع ضمّ `refunds` واستبعاد الحالات غير المحجوزة) ← إدراج `refunds` (الحجز) ثم `refund_allocations`. **النتيجة:** طلبان متزامنان لا يصرفان نفس المتبقّي مرتين. **Idempotency:** فحص مسبق + حارس عند الالتزام عبر `refunds_idem_idx` (إعادة الاسترداد الأصلي `reused: true` بدل `500`).

**التوافقية:** `allocations` اختيارية في مخطط `zod` (`max 200`) ⇒ طلبات الاسترداد القديمة صالحة؛ مسار النزاعات يستدعي `createRefund` بلا تخصيص (استرداد كامل) وطلباته بلا `seller_orders` ⇒ بلا تغيير سلوكي.

**حدود الإثبات:** PostgreSQL **غير متاح** ⇒ `tests/m24-t22-refund-allocation.test.ts` (14 حالة) **لم تُشغَّل**، ولم يُدَّعَ نجاحها. ما أُثبت: `tsc` (server+web) نظيف · `drizzle-kit check` نظيف · لا Migration جديدة · لا تعديل على أي ملف سابق.

**ملفات:** `packages/server/src/modules/payments/service.ts` · `packages/server/src/modules/payments/routes.ts` · `packages/server/tests/m24-t22-refund-allocation.test.ts` (جديد) · `docs/M2.4-T2.2_REFUND_CREATION.md` · هذا الملف · `AGENTS.md`.

**الأثر على العدّ:** `M2.4-REFUND-SUBORDER` لا تزال **مفتوحة** (انتقلت إلى **PARTIAL — T2.1 + T2.2 مكتملان**). لا فجوة مغلقة.

---

## 18. M2.4-T2.3 — حالة الفرعية لكل بائع + عكس العمولة لكل بائع عند اكتمال الاسترداد (2026-11-16)

**النوع:** منطق خدمة + اختبارات قاعدة بيانات حقيقية. **بلا Migration جديدة، بلا Seed، بلا DEMO/إنتاج، بلا commit/stage/push.**

**الحالة:** الكود مكتوب و`tsc` (server) نظيف، و**اختبارات قاعدة البيانات مُشغَّلة وناجحة 7/7** على PostgreSQL 16 معزول (`wasit_test` @127.0.0.1:5434، حاوية `wasit-m243-test-pg`، مضبوطة `127.0.0.1` فقط) — وهي أول مهمة في سلسلة M2.4 تُشغَّل اختباراتها فعلياً.

**السياق:** T2.1 بنى أساس البيانات (`refund_allocations`)، وT2.2 جعل `createRefund` يكتب التخصيصات ويتحقق منها. بقي أن **يُترجَم الاكتمال إلى أثر لكل بائع**: في `completeRefundWithEvidence` كان عكس العمولة/الرسوم على مستوى الطلب الأب بالكامل، وحالة الفرعية لا تُكتب أبداً.

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.4-REFUND-SUBORDER** | Payments/Refunds | الاسترداد لا يُنسَب لبائع ولا يُحدِّث حالة الفرعية. | MEDIUM | P2 | Migration 0040 + T2.1 + T2.2 | **PARTIAL — T2.1 + T2.2 + T2.3 مكتملة** | عند الاكتمال: حالة كل فرعية + عكس عمولتها على نصيبها + منع تسويتها. تبقى الواجهة. |

**التغيير (كله في `completeRefundWithEvidence`، بلا كتابة جديدة في `createRefund`):**

1. **`attributedRefundsBySuborder(db, orderId)`** — مجموع تخصيصات **الاستردادات `COMPLETED` فقط** لكل فرعية (طلب/معالجة لا يُحتسب: المال لم يرجع بعد). المصدر: `refund_allocations` ⋈ `refunds`.
2. **عكس العمولة/الرسوم لكل بائع (`reverseCommissionAndFee`):**
   - **حصة البائع** (`COMMISSION`/`SELLER` مع `sellerOrderId`): تُعكَس بنسبة **نصيب فرعيتها هي** = `attributed ÷ (items_total + buyer_commission)`، مقصوصة عند `1`. البائع غير المسترد لا يُعكَس شيء من عمولته؛ البائع المسترد كلياً تُعكَس عمولته كاملة. سقف الفرعية مطابق لسقف T2.2.
   - **حصة المشتري (`COMMISSION`/`BUYER`) ورسم الدفع (`PAYMENT_FEE`)**: تبقى على سياسة الطلب = `cumulativeRefunded ÷ grandTotal` — **بلا تغيير**.
   - **بيانات قديمة** (حصة بائع بلا `sellerOrderId`، أو فرعية مجهولة): تراجع لسياسة الطلب (لا تُتخطى) ⇒ الطلبات القديمة تحافظ على سلوكها.
   - **Idempotency محفوظة:** الهدف دالة في المجاميع التراكمية، ويُكتب الفرق الناقص فقط ⇒ الإعادة لا تكتب قيداً إضافياً.
3. **حالة الفرعية (`markRefundedSuborders`):** كل فرعية **مستردة بالكامل** (`attributed >= cap`) تنتقل إلى `REFUNDED` (بشرط `status <> 'REFUNDED'` ⇒ idempotent)، و**الجزئية تحافظ على حالتها التفيذية**. لا تُكتب `settlement_status` (المُعدَّد لا يحوي قيمة «مسترد»، والحالة + بوابة الاسترداد في `evaluateSuborderRow` تكفيان).
4. **منع التسوية:** `evaluateSuborderRow` يشترط `DELIVERED/COMPLETED` ⇒ الفرعية `REFUNDED` **غير مؤهَّلة للتسوية تلقائياً**، فلا يمكن دفع مستحقات بائع رُدّ ثمنه. (تحقّقت الحالة 5 من ذلك.)
5. **حالة الطلب الأب:** تبقى محسوبة من المجموع الكلي (`fullyRefunded`) — **بلا تغيير** (تفادي خلطها بحالة كل فرعية).
6. **تدقيق:** أُضيف `refundedSuborders` إلى حمولة `REFUND.COMPLETED` ليُسجَّل أي فرعية انتقلت فعلاً.

**قرار التصميم — لماذا عكس البائع على أساس فرعيته لا على أساس الطلب:** الطلب المختلط (بائع أ + ب) باسترداد كامل لبائع واحد فقط: سياسة الطلب القديمة كانت تعكس نصيباً من عمولة **كل** بائع (لأن النسبة على مستوى الأب)، فيخسر بائع لم يُسترد شيء من عمولته. القاعدة الجديدة تربط العمولة بمصير المال لكل بائع — مطابقةً لمبدأ «لا خصم بلا استرداد فعلي».

**التوافقية:** بلا تغيير في `createRefund` أو `routes.ts` أو المخطط؛ بلا Migration جديدة. الطلبات القديمة (بلا فرعيات) تعكس عمولتها على مستوى الطلب كما قبل.

**الإثبات (فعلي):**
- `tests/m24-t23-refund-suborder-status.test.ts` (جديد) **7/7** على `wasit_test` @5434: استرداد كامل ⇒ كل الفرعيات `REFUNDED`؛ جزئي ⇒ لا تغيير حالة؛ عكس عمولة البائع المسترد فقط وعدم مسّ الآخر؛ عكس كامل عند الاسترداد الكامل (العمولة والرسم يصفرّان)؛ **رفض تسوية فرعية مستردة** (`SUBORDER_NOT_DELIVERED`)؛ idempotency؛ طلب قديم بلا فرعيات.
- **إصلاح عيبين كامنين في اختبارين لم يُشغَّلا قبل الآن:** `tests/m24-t22-refund-allocation.test.ts` (كلمة مرور دخول المدير كانت خاطئة ⇒ 14/14 الآن) و`tests/m24-t21-refund-allocation-schema.test.ts` (معرّف `product_id` يتجاوز 36 حرفاً + مقارنة نص قيد `CHECK` بعد تطبيع Postgres ⇒ 13/13 الآن). لم يُغيَّر أي سلوك إنتاجي بذلك.
- الحزمة الكاملة للخادم: **1608 حالة، 1596 نجحت**؛ الحالات الفاشلة (12) كلها في ملفين **قبل** هذا العمل: `m24-t21` (أُصلحت الآن) و`sec04b-entity-read-access.test.ts` (حالة دليل الموردين تتأثر بالتوازي على قاعدة مشتركة؛ تنجح **12/12** منفردة).
- `tsc` (server) نظيف.

**حدود الإثبات:** لا Wallet/clawback، لا توزيع تلقائي على بنود داخل فرعية واحدة، لا مزوّد خارجي فعّال، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push).

**ملفات:** `packages/server/src/modules/payments/service.ts` · `packages/server/tests/m24-t23-refund-suborder-status.test.ts` (جديد) · `packages/server/tests/m24-t22-refund-allocation.test.ts` (إصلاح عيب اختبار) · `packages/server/tests/m24-t21-refund-allocation-schema.test.ts` (إصلاح عيب اختبار) · `docs/M2.4-T2.3_REFUND_SUBORDER_STATUS.md` (جديد) · هذا الملف · `AGENTS.md`.

**الأثر على العدّ:** `M2.4-REFUND-SUBORDER` لا تزال **مفتوحة** (PARTIAL — T2.1 + T2.2 + T2.3). لا فجوة مغلقة.

---

## 19. M2.4-T2.4 — واجهة عرض تخصيص الاستردادات لكل بائع (Per-seller Refund Allocation View) (2026-11-16)

**النوع:** طبقة قراءة (خدمة + مسار API) + واجهة إدارية للقراءة فقط + اختبارات. **بلا Migration جديدة، بلا Seed، بلا DEMO/إنتاج، بلا commit/stage/push.**

**الحالة:** `COMPLETE_VERIFIED` — الكود مكتوب، و`tsc` (server+web) نظيف، و**11/11 اختبار خادم** + **12/12 اختبار ويب** على PostgreSQL 16 معزول (`wasit_test` @127.0.0.1:5434، حاوية `wasit-m243-test-pg`).

| ID | المجال | وصف الفجوة | الخطورة | الأولوية | الاعتماديات | الحالة | ملاحظة |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M2.4-REFUND-SUBORDER** | Payments/Refunds | الاسترداد لا يُنسَب لبائع في الواجهة (مفتوحة في §13). | MEDIUM | P2 | T2.1 + T2.2 + T2.3 | **CLOSED (§20)** | أُضيفت طبقة قراءة تعرض نصيب كل بائع؛ أُغلقت الفجوة في M2.4-CLOSE. |

**السياق:** T2.1–T2.3 جعلت الاسترداد يُنسَب لكل بائع ويكتب أثره (حالة الفرعية + عكس عمولتها). بقي أن **يرى المشغّل** هذا الإسناد: السقف، المُسترد، المتبقي، حالة الفرعية، والعمولة المعكوسة لكل بائع. T2.4 يبني طبقة قراءة واحدة وواجهة إدارية فوقها — **بلا أي كتابة**.

**التغيير:**
1. **`getOrderRefundAttribution`** (`modules/payments/service.ts`): لطلب واحد تُرجِع حالة الطلب ومجاميعه، قائمة الاستردادات (مع الفرعيات المنسوب إليها)، وقائمة البائعين — لكل بائع: `refundableCap` (= `items_total + buyer_commission`)، `refundedAmount` (تخصيصات **`COMPLETED` فقط**)، `remainingAmount`، `sellerCommission`، **`sellerCommissionReversed` مقروءة من الدفتر** (قيود العكس عبر `metadata.reversalOf`، لا معاد حسابها)، `fullyRefunded`، البنود، واستردادات البائع مع `counted`. الطلبات القديمة بلا فرعيات ⇒ `legacy = true`.
2. **المسار `GET /api/payments/orders/:orderId/refund-attribution`** (`modules/payments/routes.ts`): بصلاحية **`REFUND_MANAGE`** (`ADMIN`/`SUPER_ADMIN` فقط).
3. **الواجهة:** مكوّن `RefundAttributionPanel` (عرض بحت) + زر «عرض تفاصيل التخصيص» في `AdminOrdersPage` + مساعدات عرض بحتة (`lib/refund-attribution.ts`) + مفاتيح `admin.refundAttr.*` و`common.yes/no` في اللغات الأربع.

**قرار التصميم — لماذا `REFUND_MANAGE` لا `PAYMENT_READ`؟** `PAYMENT_READ` يملكه أيضاً `MERCHANT`/`SUPPLIER`/`COMPANY`، فلو بوّبنا عليه لاستطاع بائع قراءة **نصيب بائع آخر** في نفس الطلب (تسرّب تجاري + انتهاك IDOR). `REFUND_MANAGE` يحصرها في مكتب الاسترداد المصرّح. مسارا القراءة الذاتية القائمان (`/orders/:id` و`.../refunds`) يبقيان مقيَّدين بالملكية ولا يكشفان نصيب بائع آخر.

**مبدأ ثابت:** كل رقم يُعرض **مأخوذ من الخادم كما هو**؛ الواجهة تصنّف وتُسمّي فقط ولا تحسب مالاً. الاسترداد غير المكتمل يُعرض بحالته لكنه **لا يُحتسب** في المال المُعاد (نفس مبدأ LC-04/T2.3).

**التوافقية:** بلا تغيير في `createRefund`/`completeRefundWithEvidence`/المخطط؛ بلا Migration جديدة. طبقة القراءة **لا تكتب شيئاً** (الاختبار 10 يثبت ثبات الدفتر والفرعيات والدفعات بعد ثلاث قراءات).

**الإثبات (فعلي):**
- `packages/server/tests/m24-t24-refund-attribution-view.test.ts` (جديد) **11/11** على `wasit_test` @5434: بائع واحد بلا استرداد؛ بائعان بسقفين مستقلين؛ جزئي (مبالغ دون تغيير حالة)؛ كامل لبائع واحد (فرعيته `REFUNDED` وعمولته تُعكَس، والآخر لا يُمَس)؛ كامل للجميع؛ **العمولة المعكوسة من الدفتر** (نصف استرداد ⇒ نصف عكس)؛ `CUSTOMER`/`MERCHANT`/`SUPPLIER`/`SUPPORT` ⇒ `403` و`ADMIN` ⇒ `200`؛ بلا استردادات؛ `404` لطلب غير موجود؛ **القراءة لا تكتب**؛ طلب قديم ⇒ `legacy`.
- `packages/web/tests/m24-t24-refund-attribution.test.ts` (جديد) **12/12**: عقد الترجمة في اللغات الأربع + تصنيف `NONE`/`PARTIAL`/`FULL` + تصيير فعلي (`react-dom/server`) بلا تسرّب مفتاح خام.
- **حزمة الويب الكاملة 73/73** (7 ملفات) + `tsc` (server+web) نظيف.
- **الحزمة الكاملة للخادم: 1619 حالة، 1618 نجحت**؛ الفشل الوحيد `sec04b-entity-read-access.test.ts` (حالة دليل الموردين تتأثر بالتوازي على قاعدة مشتركة؛ **12/12 منفردة** — سبق توثيقها في §18، وليست انحداراً).

**حدود الإثبات:** لا Wallet/clawback، لا إنشاء/إتمام استرداد من هذه الواجهة، لا مزوّد خارجي فعّال، لا DEMO/إنتاج، لا Git مُغيِّر (بلا stage/commit/push). الواجهة قراءة فقط ولا تحتوي أي زر ينقل مالاً.

**ملفات:** `packages/server/src/modules/payments/service.ts` · `packages/server/src/modules/payments/routes.ts` · `packages/server/tests/m24-t24-refund-attribution-view.test.ts` (جديد) · `packages/web/src/lib/types.ts` · `packages/web/src/lib/api.ts` · `packages/web/src/lib/refund-attribution.ts` (جديد) · `packages/web/src/components/RefundAttributionPanel.tsx` (جديد) · `packages/web/src/pages/AdminPages.tsx` · `packages/web/src/lib/i18n.ts` · `packages/web/vitest.config.ts` · `packages/web/tests/m24-t24-refund-attribution.test.ts` (جديد) · `docs/M2.4-T2.4_REFUND_ATTRIBUTION_VIEW.md` (جديد) · هذا الملف · `AGENTS.md`.

**الأثر على العدّ:** `M2.4-REFUND-SUBORDER` **أُغلقت** (CLOSED) في M2.4-CLOSE (§20). «المغلقة» 33 → **38** (بإدراج سلسلة M2: 4 مغلقة سابقة + M2.4)، و«المفتوحة» 20 → **21** (بإدراج `M2.5-TX-SELLER-ATTRIBUTION`). التفاصيل: §20.

---

## 20. سجل إغلاق M2.4-REFUND-SUBORDER (M2.4-CLOSE — 2026-11-16)

**النوع:** مراجعة تحقّق وإغلاق إداري + توثيق. **بلا تعديل منطق تطبيق، بلا Migration، بلا Seed، بلا Git مُغيِّر (بلا commit/stage/push).**

**قرار الإغلاق:** `M2.4-REFUND-SUBORDER` انتقلت من **`PARTIAL`** إلى **`CLOSED`** بعد مطابقة **الشروط الأحد عشر** مقابل **الكود والاختبارات الفعلية** (لا التقارير وحدها).

### 20.1 مصفوفة الشروط ↔ الدليل

| # | الشرط | الدليل (كود + اختبار) | النتيجة |
| --- | --- | --- | --- |
| 1 | تخصيص فعلي لكل Seller Suborder | جدول `refund_allocations` (Migration 0040، §16) + كتابة التخصيص في `createRefund` (`service.ts` ~1496) | ✅ |
| 2 | احتساب المكتمل فقط | `attributedRefundsBySuborder` و`getOrderRefundAttribution` يقيّدان بـ`refunds.status = 'COMPLETED'`؛ غير المكتمل يُعرض بلا احتساب | ✅ (اختبار T2.4 #8/#3) |
| 3 | صحة المتبقي والسقف | `suborderRefundableCap = itemsTotal + buyerCommission`؛ `remaining = cap − refunded` (بحدّ صفر) | ✅ (T2.4 #1/#2/#3) |
| 4 | عكس العمولة وفق الاسترداد الفعلي | `reverseCommissionAndFee`: حصة البائع تُعكَس بنسبة `attributed ÷ cap` **من الدفتر** (لا معاد حسابها) | ✅ (T2.4 #6) |
| 5 | عدم المساس بعمولة البائعين الآخرين | في الطلب المختلط، بائع بلا تخصيص ⇒ `ratio = 0` ⇒ لا قيد عكس له | ✅ (T2.3 #3، T2.4 #4) |
| 6 | حماية من التكرار (idempotency) | `reverseCommissionAndFee` يكتب الفرق الناقص فقط؛ `markRefundedSuborders` مشروط بـ`status <> 'REFUNDED'`؛ `createRefund` بمفتاح idempotency | ✅ (T2.2/T2.3 #6) |
| 7 | منع التسوية غير المستحقة | `evaluateSuborderRow` يشترط `DELIVERED/COMPLETED` ⇒ الفرعية `REFUNDED` غير مؤهَّلة | ✅ (T2.3 #5: `SUBORDER_NOT_DELIVERED`) |
| 8 | مسار إداري محمي للقراءة | `GET /orders/:orderId/refund-attribution` بـ`requirePermission(REFUND_MANAGE)` | ✅ (T2.4 #7) |
| 9 | لا IDOR بين البائعين | `REFUND_MANAGE` محصور في `ADMIN`/`SUPER_ADMIN`؛ `PAYMENT_READ` (يملكه MERCHANT/SUPPLIER/COMPANY) **لا يفتحها** | ✅ (T2.4 #7: رفض 403 لكل الأطراف) |
| 10 | الواجهة عرض فقط | `RefundAttributionPanel` بلا أي نداء كتابة؛ الاختبار يثبت ثبات الدفتر/الفرعيات/الدفعات بعد 3 قراءات | ✅ (T2.4 #10) |
| 11 | اختبارات المراحل موثّقة وقابلة للتحقق | 4 ملفات خادم + ملف ويب، أُعيد تشغيلها فعلياً في هذه الجولة | ✅ (20.2) |

### 20.2 الاختبارات المُشغَّلة فعلياً في هذه الجولة (2026-11-16)

| الملف | النتيجة |
| --- | --- |
| `packages/server/tests/m24-t21-refund-allocation-schema.test.ts` | **13/13** ✅ |
| `packages/server/tests/m24-t22-refund-allocation.test.ts` | **14/14** ✅ |
| `packages/server/tests/m24-t23-refund-suborder-status.test.ts` | **7/7** ✅ |
| `packages/server/tests/m24-t24-refund-attribution-view.test.ts` | **11/11** ✅ |
| **مجموع اختبارات المراحل الأربع** | **45/45** ✅ |
| `packages/web/tests/m24-t24-refund-attribution.test.ts` (وضمن الحزمة الكاملة) | **12/12** (الحزمة الكاملة **73/73**) ✅ |
| `tsc` (server + web) | نظيف ✅ |

**البيئة:** PostgreSQL 16 معزول `wasit-m243-test-pg` على `127.0.0.1:5434` فقط، قاعدة `wasit_test` (بوابة `tests/test-db-guard.ts`). لا DEMO/إنتاج.

### 20.3 الأثر على العدّ

| المحور | قبل | بعد |
| --- | --- | --- |
| بنود مفتوحة | 20 | **21** (+`M2.5-TX-SELLER-ATTRIBUTION`) |
| بنود مُغلقة فعلياً | 33 | **38** (+سلسلة M2: 4 مغلقة سابقة + `M2.4-REFUND-SUBORDER`) |
| فجوات كاذبة | 6 | 6 |
| بنود خارجية | 10 | 10 |

> **تنبيه:** سلسلة **M2** (§13–§19) كانت موثَّقة بصفوفها لكنها **لم تكن مُحتسبة في §1**؛ أُدرجت صراحةً في هذه الجولة (انظر ملاحظة «دمج سلسلة M2» في §1). لذلك القفز في «المغلقة» (33→38) يعكس **إدراج 4 بنود M2 مغلقة سابقاً** + **إغلاق M2.4**، لا خمسة إغلاقات جديدة في هذه الجولة.

### 20.4 النواقص المتبقية (خارج نطاق M2.4)

- **`M2.5-TX-SELLER-ATTRIBUTION`** (§13): إسناد `transactions.sellerId` للبائع الأول — **مفتوحة** (أول مهمة تالية، انظر 20.5).
- `sec04b-entity-read-access.test.ts`: حالة دليل الموردين حسّاسة للتوازي على قاعدة مشتركة (سباق ترقيم صفحات)؛ **12/12 منفردة** — ليست عيباً في منطق M2.4 ولا في الإنتاج (سباق في مُهيّئ الاختبار).

**ملفات هذا السجل:** `docs/GAP_REGISTER.md` (هذا القسم + §1 + §13 + §19) · `AGENTS.md` · `docs/M2.4-T2.4_REFUND_ATTRIBUTION_VIEW.md`.

---

## 21. المهمة التالية — تعريف M2.5-TX-SELLER-ATTRIBUTION (بلا تنفيذ)

**المعرّف:** `M2.5-TX-SELLER-ATTRIBUTION` (§13، الحالة `OPEN`، الخطورة LOW، الأولوية P2، الاعتماديات: —).

**ما ينقص المنصة:** في الطلب متعدّد البائعين يُكتب `transactions.sellerId` لبائع **واحد** فقط (`soleSeller ?? firstProduct.sellerId`)، ثم يقرأ `trust-engine.ts` هذا الحقل لبناء مجاميع الثقة/التقييم. النتيجة: يُنسب **كامل السلة** (بما فيها مبيعات بائعين آخرين) إلى بائع واحد، فيتضخّم رصيده ويتشوّه ترتيب الثقة بين البائعين.

**الأثر التشغيلي:** تقييمات/شارات الثقة لبوائع الطلبات المختلطة **غير دقيقة** (بائع يبدو أكبر/أعلى ثقة ممّا هو)، ويُهمَل الآخرون. لا أثر على المال (المبالغ تُحسب من `seller_orders` في التحليلات)، لكن الأثر على العدالة والترتيب في السوق.

**الاعتماديات:** لا يعتمد على مزوّد خارجي ولا Migration إلزامية؛ التصميم المقترح **الاشتقاق من `seller_orders`** (كما فُعل في `analytics`) لا من صف `transactions` الواحد. المطلوب قبل التنفيذ: حصر كل قارئي `transactions.sellerId` (خصوصاً `trust-engine.ts`) وتحديد مصدر التجميع لكل بائع، مع خطة توافقية للبيانات القائمة (طلبات قديمة بلا فرعيات). **لا يبدأ التنفيذ في هذه الجولة.**

**T1 — Discovery & Design مُنجَز (2026-11-16):** أُنجزت وثيقة التصميم الكاملة في **`docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md`**. خلاصتها المؤكَّدة من الكود: الكاتب الوحيد `orders/service.ts:358` (`soleSeller ?? firstProduct.sellerId`)، والقارئان الوحيدان `trust-engine.ts:84` و`:100` (عامِلا `totalTransactions`/`successfulTransactions`). **لا أثر مالي** (كل المالية/التحليلات/التقارير تقرأ `seller_orders`/`orders`/الدفتر، لا `transactions.sellerId`). **لا Migration مطلوبة**: الحل قراءة فقط من `seller_orders` + احتياطي قديم بشرط `NOT EXISTS suborder` (منع الازدواج). الحالة تبقى **`OPEN`** بانتظار موافقة التصميم.

**T2 — تنفيذ طبقة الإسناد (2026-11-16):** اعتُمدت القرارات D1–D4 ونُفِّذت. **ملف جديد** `packages/server/src/lib/seller-attribution.ts` (`countSellerTransactions`): عدّ لكل بائع من `seller_orders` (النجاح = `orders.payment_status='PAID'`، دفعة واحدة) + احتياطي `orders` **بلا فرعية** (بائع واحد قديم) + `NOT EXISTS` لمنع الازدواج + استبعاد القديم المختلط + أمان المدخلات. **تعديل** `trust-engine.ts` لاستبدال الاستعلامين على `transactions.sellerId` بنداء واحد، **بلا تغيير معادلة الدرجة/الأوزان/الحدود/الشارات**. **بلا Migration، بلا مسّ `transactions.sellerId`، بلا إعادة حساب جماعية** (D3/D4). **الأدلة:** `tests/m25-tx-seller-attribution.test.ts` **14/14** + تراجع `verification-trust`(11)/`analytics`(15)/`revenue`(16) = **42/42** + الحزمة الكاملة (انظر سجل التنفيذ). الحالة: **`IN_PROGRESS`** (لا إغلاق قبل اكتمال التحقق الكامل). التفاصيل: §12 في `docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md`.

**T3 — تدقيق اتساق حالة الدفع والإغلاق (2026-11-16):** أُنجز تدقيق قراءة على كل مسارات كتابة `transactions.status` و`orders.payment_status`، وأُضيفت **4 اختبارات** لاختلاف الحقلين ⇒ **18/18**. ثبت أن `orders.payment_status` يحافظ على دلالة النجاح. **الحالة: `CLOSED`**. التفاصيل الكاملة في **§22**.

> **الأثر على العدّ:** أُغلق `M2.5-TX-SELLER-ATTRIBUTION` ⇒ **«المفتوحة» تنخفض 21 → 20** و**«المغلقة» ترتفع 38 → 39**. لا تغيير على «الكاذبة» (6) ولا «الخارجية» (10).

---

## 22. سجل إغلاق M2.5-TX-SELLER-ATTRIBUTION (M2.5-T3 — 2026-11-16)

**النوع:** تدقيق قراءة (Payment-Status Consistency Audit) + إغلاق إداري + توثيق. **بلا تعديل منطق تطبيق، بلا Migration، بلا Seed، بلا كتابة على قواعد البيانات، بلا Git مُغيِّر (بلا commit/stage/push).**

**قرار الإغلاق:** `M2.5-TX-SELLER-ATTRIBUTION` انتقلت من **`IN_PROGRESS`** إلى **`CLOSED`** بعد إثبات أن اعتماد `orders.payment_status` كدلالة النجاح **يحافظ على المعنى المطلوب** ولا يوجد مسار كتابة يُنتج اختلافاً مؤثّراً بين الحقلين.

### 22.1 حصر مسارات الكتابة على الحقلين (كود فعلي، بلا تخمين)

| المسار | `transactions.status` | `orders.payment_status` | متزامنان؟ |
| --- | --- | --- | --- |
| إنشاء الطلب (`orders/service.ts:305,353`) | `PENDING` (افتراضي المخطط) | `UNPAID` | نعم (لا نجاح) |
| إنشاء نية الدفع (`payments/service.ts:193`) | — | `PENDING` | لا نجاح |
| **نجاح الدفع** — `applyPaymentSucceeded` (`:798,812`) | `PAID` | `PAID` | **نعم — في نفس الدالة** |
| **فشل الدفع** — `applyPaymentFailed` (`:852,851`) | `FAILED` | `FAILED` | **نعم — في نفس الدالة** |
| **استرداد (كامل/جزئي)** — (`:1037,1026`) | `REFUNDED` / `PARTIALLY_REFUNDED` | `REFUNDED` / `PARTIALLY_REFUNDED` | **نعم — في نفس الكتلة** |
| إتمام دفع يدوي (إداري) — `completeManualPayment` (`:1892`) | — | — | **يمرّ عبر `applyPaymentSucceeded` نفسه** (لا كاتب ثانٍ) |
| Webhooks (`handlePaymentWebhook`) | — | — | يُفوّض إلى `applyPaymentSucceeded`/`applyPaymentFailed`/`applyRefundSucceeded` |
| إلغاء/انتهاء الصلاحية | **لا كاتب** | **لا كاتب** (`CANCELLED`/`EXPIRED` قيم نية دفع فقط؛ بلا مسار يكتبها) | لا ينطبق |
| التسوية (`settlements/service.ts:181`) | — | — | يكتب `settlementStatus` فقط (لا `payment_status`) |

> **`payment_status` enum:** `UNPAID, PENDING, PROCESSING, PAID, FAILED, REFUNDED, PARTIALLY_REFUNDED` — لا يوجد `CANCELLED`/`EXPIRED` (تلك لحالة نية الدفع `payment_intent_status`). **`transactions.status` يستخدم نفس الـenum** (`paymentStatusEnum`).

**الخلاصة:** كل انتقال يمسّ «النجاح» يكتب الحقلين **معاً** في نفس الدالة. **لا مسار واحد يكتب أحدهما دون الآخر على محور النجاح** (نجاح/فشل/استرداد). الفرق البنيوي الوحيد: الحالة الابتدائية (`PENDING` مقابل `UNPAID`) وهي **ليست نجاحاً في الحالتين**.

### 22.2 قرّاء `transactions.status`
موضعان فقط: قائمة `/api/admin/transactions` (عرض)، و`lib/risk-engine.ts:76` (`status='FAILED'` لعدّ فشل الشراء — لا علاقة بالثقة). **لا قارئ للإسناد/الثقة** ⇒ لا تعارض مع `countSellerTransactions`.

### 22.3 هل يمكن أن يختلف الحقلان؟ وهل يؤثر؟
- **عملياً لا** على محور النجاح (تكتبهما نفس الدالة في نفس العملية؛ إما معاملة واحدة أو استدعاءان متتاليان بلا حالة وسيطة).
- **لو اختلفا (سيناريو صناعي/بيانات مرمّمة):** القرار المقصود أن **`orders.payment_status` هو الحقيقة** (دفعة واحدة لكل طلب أب). هذا **مقصود ومُختبَر** (انظر 22.4) ولا يخلق خطأً في الإسناد: كل فرعية تُحتسب نجاحاً وفق دفعة أبيها الواحدة — وهو الأدقّ لسلة متعدّدة البائعين.

### 22.4 اختبارات التدقيق (مُشغَّلة فعلياً على `wasit_test` @127.0.0.1:5434)
أُضيفت **4 اختبارات** (بلا Migration، بلا كتابة على بيانات إنتاج) تزرع اختلافاً صناعياً بين الحقلين وتُثبت أن الدلالة من `orders.payment_status`:

| # | السيناريو | التوقّع | النتيجة |
| --- | --- | --- | --- |
| 1 | `orders=PAID` و`transactions=PENDING` | النجاح محفوظ (`1/1`) | ✅ |
| 2 | `orders=REFUNDED` و`transactions=PAID` | غير ناجح (`1/0`) | ✅ |
| 3 | قديم بائع واحد `orders=PAID` و`transactions=FAILED` | يُحتسب من الأم (`1/1`) | ✅ |
| 4 | `orders=UNPAID` و`transactions=PAID` | غير ناجح (`1/0`) | ✅ |

**ملف الاختبار:** `packages/server/tests/m25-tx-seller-attribution.test.ts` ⇒ **18/18** ✅ (14 من T2 + 4 من T3).

### 22.5 الاختبارات المرجعية المُشغَّلة
| المجموعة | النتيجة |
| --- | --- |
| `m25-tx-seller-attribution.test.ts` | **18/18** ✅ |
| `payments.test.ts` (يشمل RC-1: تطابق `transactions.status` مع حالة الدفع الحقيقية) | **19/19** ✅ |
| `money-path-invariants.test.ts` (تطابق الحقلين عند النجاح) | **6/6** ✅ |
| `verification-trust` (11) + `analytics` (15) + `revenue` (16) | **42/42** ✅ |
| `tsc` (server + web) | نظيف ✅ |

### 22.6 لقطات الثقة التاريخية
**لم تُعَد حساب أي لقطة تاريخية** في `trust_scores` (قرار D3): اللقطات تُكتب عند الطلب فقط. التغيير يظهر في **اللقطات الجديدة** للبائعين المشاركين في طلبات مختلطة؛ اللقطات القديمة تبقى كما كُتبت.

### 22.7 الأثر على العدّ
| المحور | قبل | بعد |
| --- | --- | --- |
| بنود مفتوحة | 21 | **20** |
| بنود مُغلقة فعلياً | 38 | **39** |
| فجوات كاذبة | 6 | 6 |
| بنود خارجية | 10 | 10 |

**ملفات هذا القسم:** `packages/server/src/lib/seller-attribution.ts` · `packages/server/src/lib/trust-engine.ts` · `packages/server/tests/m25-tx-seller-attribution.test.ts` · `docs/M2.5-TX-SELLER-ATTRIBUTION_DESIGN.md` (§12) · `AGENTS.md` · هذا الملف.

---

## 23. سجل تنفيذ AI-02.S1 — Agent Supervisor + Retry Policy (2026-11-16)

**النوع:** تنفيذ + اختبارات + توثيق. **بلا Migration · بلا Seed · بلا تغيير مخطط · بلا تعديل آلة الحالات · بلا Git مُغيِّر (بلا commit/stage/push).**

**المهمة:** الشريحة الأولى المحدودة من AI-02 — طبقة Supervisor تقرأ التشغيلات وتتّخذ تدخّلات محدودة، مع سياسة إعادة محاولة مركزية. **بلا مزوّد خارجي** (السياسة حتمية، والمزوّد الافتراضي `local-heuristic`).

### 23.1 ما أُنجز (كود فعلي)

| المكوّن | الملف | الدور |
| --- | --- | --- |
| خدمة Supervisor | `modules/ai/supervisor.ts` (جديد) | `runSupervisorCycle` · `containRun` · `retryStep` · `buildSupervisorOverview` · `createSupervisorCycleGuard` |
| سياسة إعادة المحاولة | `modules/ai/retry-policy.ts` (جديد، صرف) | `decideRetry` — fail-closed |
| سطح إداري | `modules/admin/ai-routes.ts` | `GET /supervisor/overview` · `POST /supervisor/runs/:runId/contain` |
| دورة دورية | `lib/scheduler.ts` + `lib/env.ts` + `index.ts` | مؤقّت اختياري **مُطفأ افتراضياً** (`AI_AGENT_RUNS_SUPERVISOR_ENABLED=false`) |
| المطالبة الذرّية | `modules/ai/dispatcher.ts` | إضافة `RETRYING` إلى مجموعة المطالبة (انتقال AI-02.1 قائم — لا حالة جديدة) |

### 23.2 الاختبارات (بالأرقام)

| المجموعة | الملف | النتيجة |
| --- | --- | --- |
| Retry policy (وحدة) | `tests/unit/retry-policy.test.ts` | **10/10** ✅ |
| Supervisor (تكامل + تزامن) | `tests/ai024-supervisor.test.ts` | **17/17** ✅ |
| Supervisor API + RBAC | `tests/ai024-supervisor-routes.test.ts` | **7/7** ✅ |
| تراجع AI-02 | `ai021` · `ai022` · `ai023` · `ai0231` · `ai0232-concurrency` · `ai0232-fencing` · `unit/supervisor-policy` | **158/158** ✅ |
| الحزمة الكاملة (خادم) | `vitest run` | **1670/1671** — الفشل الوحيد `sec04b-entity-read-access` **سابق/متقطّع** (يمرّ 3/3 معزولاً؛ خارج نطاق المهمة) |
| TypeScript | `tsc --noEmit` (server + web) | نظيف ✅ |

### 23.3 الأثر على العدّ

| المحور | قبل | بعد |
| --- | --- | --- |
| بنود مفتوحة | 20 | **20** (AI-02 تبقى `IN_PROGRESS` — لم تُغلق الفجوة الأم) |
| بنود مُغلقة فعلياً | 39 | **39** |
| فجوات كاذبة | 6 | 6 |
| بنود خارجية | 10 | 10 |

**سبب عدم تغيّر العدّ:** AI-02.S1 شريحة فرعية؛ AI-02 تبقى مفتوحة لأن LLM Planner وTool Gateway وKill Switch وسطح الويب ما زالت مؤجّلة.

### 23.4 الحدود والوظائف المؤجّلة

- **دلالة إغلاق التشغيل عند الفشل (قائم قبل المهمة):** `reconcileRun` يُغلق التشغيل فور حسم كل خطواته، لذا إعادة المحاولة تعمل فقط في تشغيل ما زالت فيه خطوة أخرى غير محسومة — موثّق كحدّ ولم يُغيَّر سلوك الإغلاق.
- **مؤجّل صراحةً:** LLM Planner · Tool Gateway · Kill Switch · Circuit Breaker/Backoff المتقدّم · واجهة ويب Supervisor · AI-05 · AI-03 · AI-04.

**ملفات هذا القسم:** `packages/server/src/modules/ai/supervisor.ts` · `packages/server/src/modules/ai/retry-policy.ts` · `packages/server/src/modules/ai/dispatcher.ts` · `packages/server/src/modules/admin/ai-routes.ts` · `packages/server/src/lib/{env.ts,scheduler.ts}` · `packages/server/src/index.ts` · `packages/server/tests/{ai024-supervisor.test.ts,ai024-supervisor-routes.test.ts,unit/retry-policy.test.ts}` · `docs/AI-02.S1_SUPERVISOR_RETRY.md` · `docs/AI_ARCHITECTURE.md` · `docs/AI-02.4_SUPERVISOR_ORCHESTRATION_CORE.md` · `docs/WASIT_EXECUTION_REGISTER.md` · `AGENTS.md` · هذا الملف.

---

## 24. تدقيق الاختبار المتقطّع `sec04b-entity-read-access` + إغلاق AI-02.S1 (2026-11-16)

**النوع:** تحقيق READ-ONLY في اختبار متقطّع + إغلاق إداري لشريحة. **بلا تعديل اختبار أو منطق تطبيق، بلا Migration، بلا Seed، بلا كتابة على DEMO/إنتاج، بلا Git مُغيِّر (بلا commit/stage/push).**

### 24.1 إغلاق AI-02.S1

`AI-02.S1 = COMPLETED`. شروط القبول متحقّقة ومُثبتة: اختبارات جديدة **34/34** (`unit/retry-policy` 10 + `ai024-supervisor` 17 + `ai024-supervisor-routes` 7) + تراجع AI-02 **158/158** + `tsc` (server+web) نظيف + توثيق كامل (`docs/AI-02.S1_SUPERVISOR_RETRY.md`, `AI_ARCHITECTURE.md`, §23 أعلاه).
**AI-02 تبقى `IN_PROGRESS`** — الفجوات المؤجّلة محفوظة: **LLM Planner · Tool Gateway · Kill Switch · واجهة Supervisor الكاملة**. **لا ادّعاء جاهزية إنتاجية.**

### 24.2 سبب الفشل (مُثبت، لا مُخمَّن)

**التصنيف:** **مشاركة بيانات/قاعدة اختبار + ترتيب الاختبارات** (وليس سباقاً زمنياً ولا تنظيفاً ناقصاً ولا علاقة بـAI-02.S1).

**الميكانيكا (بأدلة من الكود والبيانات):**
1. اختبار `SEC-04B E` يُنشئ مورّداً باسم `S4 Supplier <stamp>` ثم يطلب `GET /api/directory/suppliers?pageSize=100` ويتوقّع أن يجد صفّه في الصفحة الأولى (`find(r => r.id === id)`).
2. نقطة النهاية (`modules/directory/service.ts` → `listSupplierDirectory`) **عالمية وغير معزولة**: تُعيد **كل** الموردين النشطين، مرتّبين بـ`orderBy(suppliers.companyName)`، ومحدودة بـ`limit(pageSize)` (والسقف 100 في `routes.ts`).
3. **26 ملف اختبار** يُنشئ موردين عبر `POST /api/suppliers` **بلا أي تنظيف** (لا `afterAll`/`delete` في `sec04b`)، والحزمة تعمل **بالتوازي** على قاعدة `wasit_test` **مشتركة** ⇒ تتراكم مئات الموردين النشطين في نفس القاعدة.
4. القياس الفعلي بعد تشغيل الحزمة الكاملة: **397 مورداً نشطاً** (المجموع 398). **352** منها تُرتَّب **قبل** `S4`، فصفوف `S4 Supplier` تسقط في المواضع **#354…#359** — أي **خارج** الصفحة الأولى (سقف 100). فيُعيد `find` قيمة `undefined` ⇒ يفشل `expect(customerRow).toBeTruthy()`.
5. **لماذا ينجح منفرداً:** عند تشغيل الملف وحده لا توجد موردينات متراكمة أخرى تُسبق `S4` أبجدياً (العيّنة < 100) ⇒ يظهر الصف.

**سلسلة القياس (الأوامر والنتائج):**
- منفرداً: `npx vitest run tests/sec04b-entity-read-access.test.ts` ⇒ **12/12 ناجح**.
- الحزمة الكاملة: `npx vitest run` ⇒ `sec04b` **1 failed** في `SEC-04B E` عند السطر 369 (مرّتين متتاليتين — حتمي تحت هذه الشروط، لا عشوائي).
- حصر التراكم: `select count(*) from suppliers where is_active=true` ⇒ **397**؛ `... and company_name < 'S4'` ⇒ **352**؛ مواضع صفوف `S4 Supplier` ⇒ **#354–#359** (كلها > 100).

### 24.3 هل المشكلة قبل AI-02.S1 أم تأثّرت بها؟

**قبل، ومستقلّة تماماً.** الدليل القاطع: تشغيل الحزمة مع **استبعاد ملفات اختبار AI-02.S1 الثلاثة** (`ai024-supervisor`, `ai024-supervisor-routes`, `unit/retry-policy`) أعاد الفشل نفسه (`1 failed | 127 passed`). كما أنّ مسار `directory`/`suppliers` **لا يستورد** أي وحدة من AI-02.S1، وملف الاختبار ووحدة الدليل **غير معدَّلين** من المهمة (الملف غير متعقَّب أصلاً، والوحدة تعديل سابق سابق للمهمة).

### 24.4 أصغر إصلاح مقترح (لم يُطبَّق)

- **الخيار الأدنى (داخل الاختبار، بلا مساس بالإنتاج):** تضييق الطلب بالبحث بدل الاعتماد على الصفحة الأولى:
  `GET /api/directory/suppliers?q=<companyName>&pageSize=100` ثم `find` بالمعرّف.
  *الأساس:* المرشّح `q` يستخدم `ilike(companyName, '%q%')` ⇒ يقلّ العائد إلى **6** صفوف لـ`S4 Supplier` (يُثبت التجريب: `count = 6`) فيبقى الصف في الصفحة الأولى دائماً. **أصغر تغيير، لا يمسّ منطق الإنتاج.**
- **الخيار الأفضل (جذري، أوسع):** عزل بيانات الاختبار (مسح/تنظيف موردي كل ملف بعد الاختبار، أو بادئة فريدة لكل ملف + `q`)، أو رفع السقف/الترتيب، أو تشغيل الحزمة على قاعدة لكل ملف. هذا تغيير **أوسع من أصغر إصلاح** ويحتاج قراراً.
- **لا تغيير على كود الإنتاج موصى به:** الدليل العام المرتَّب بالاسم سلوك مقصود؛ الخلل في **فرضية الاختبار** لا في المنتج.

### 24.5 الأثر على العدّ

| المحور | قبل | بعد |
| --- | --- | --- |
| بنود مفتوحة | 20 | **20** |
| بنود مُغلقة فعلياً | 39 | **39** |
| فجوات كاذبة | 6 | 6 |
| بنود خارجية | 10 | 10 |

**لا تغيير في العدّ:** AI-02.S1 شريحة فرعية (AI-02 تبقى `IN_PROGRESS`)، وتدقيق `sec04b` تحقيق READ-ONLY بلا إصلاح مُطبَّق.

### 24.6 الحالة النهائية

- **AI-02.S1 = `COMPLETED`** · **AI-02 = `IN_PROGRESS`**.
- **`sec04b` = عيب اختبار معروف (test-data contamination)، غير مُصلَح في هذه الجولة** — مُوثَّق بأصغر إصلاح مقترح.
- **لا تغيير على الاختبار أو كود التطبيق، لا Migration، لا Seed، لا Git مُغيِّر.**

**ملفات هذا القسم:** `packages/server/tests/sec04b-entity-read-access.test.ts` (قراءة فقط) · `packages/server/src/modules/directory/{service.ts,routes.ts}` (قراءة فقط) · `packages/server/vitest.config.ts` (قراءة فقط) · `docs/WASIT_EXECUTION_REGISTER.md` (§8) · `AGENTS.md` · هذا الملف.

### 24.7 إصلاح `sec04b` + التحقق (2026-11-17) — **مُصلَح ومُتحقَّق**

**النوع:** إصلاح اختبار فقط (test-only) بأصغر تعديل. **بلا تعديل كود إنتاج، بلا Migration، بلا Seed، بلا تغيير مخطط، بلا Git مُغيِّر.**

**التغيير الدقيق** (`packages/server/tests/sec04b-entity-read-access.test.ts` — كتلة `SEC-04B E` فقط):
- قبل: `GET /api/directory/suppliers?pageSize=100` ثم `find(r => r.id === id)` — يفترض ظهور المورّد في الصفحة الأولى.
- بعد: قراءة `companyName` للمورّد بالمعرّف من قاعدة البيانات، ثم `GET /api/directory/suppliers?q=<companyName>&pageSize=100` (الاسم فريد يحمل `stamp`)، ثم **نفس** `find` بالمعرّف. الطلبان (customer + admin) وكل تأكيدات الصلاحيات/حجب PII **بلا تغيير**.

**لماذا صحيح:** المرشّح `q` يُطبَّق على **العدّ والقائمة معاً** في `listSupplierDirectory` (`ilike(companyName, '%q%')`)، والاسم فريد ⇒ العائد 6 صفوف دائماً ⇒ الصف داخل الصفحة. **لا يمسّ سلوك API ولا كود الإنتاج.**

**نتائج التحقق (PostgreSQL 16 معزولة `wasit_test` @127.0.0.1:5434):**

| الفحص | النتيجة |
| --- | --- |
| `sec04b` منفرداً | **12/12** ✅ |
| `sec04b` ×3 (استقرار) | **12/12** ×3 ✅ |
| مجموعة الأمان (`sec04b` + `security-privacy`) | **31/31** ✅ |
| **الحزمة الكاملة** | **131 ملفاً / 1671 اختباراً — كلها ناجحة** ✅ |
| `tsc --noEmit` (server) | **0 أخطاء** ✅ |
| `tsc --noEmit` (web) | **0 أخطاء** ✅ |

**إثبات إزالة السبب فعلياً (لا إخفاء العَرَض):** أثناء تشغيل الحزمة الكاملة الناجح كان شرط الفشل الأصلي **قائماً**: **397 مورداً نشطاً**، منها **352** تُسبق `S4` أبجدياً (> سقف 100) ⇒ لولا الإصلاح لكان الفشل حتمياً (كما أُثبت في §24.2). نجاح `sec04b` داخل الحزمة تحت هذه الشروط = إزالة للسبب.

**لا فشل متبقٍ:** صفر فشل في كل التشغيلات أعلاه.

**الملفات المعدَّلة:** `packages/server/tests/sec04b-entity-read-access.test.ts` (فقط) + التوثيق (`docs/GAP_REGISTER.md`, `docs/WASIT_EXECUTION_REGISTER.md`, `AGENTS.md`). **كود الإنتاج لم يُمَسّ.**

---

## §25 — DEMO-SEC-01: تأمين العرض العام (CLOSED / VERIFIED — 2026-11-21)

**المشكلة (ثغرة حقيقية، لا فجوة توثيقية):** على الرابط العام للعرض كان `POST /api/auth/demo-audit-session`
يقبل `{"persona":"super-admin"}` من **أي زائر** بلا بيانات اعتماد، وصفحة `/demo/owner` تفتح تلك الجلسة
تلقائيًا عند أول زيارة. النتيجة: تجاوز كامل لـRBAC — أي شخص يملك الرابط يحصل على SUPER_ADMIN. وكانت
كلمة مرور العرض `Passw0rd!2026` منشورة في الكود والوثائق، وحساب العرض الرسمي بريدًا شخصيًا.

**الإصلاح (كود إنتاج):**

| الطبقة | قبل | بعد |
| --- | --- | --- |
| `POST /api/auth/demo-audit-session` | مفتوح لأي زائر عند `DEMO_AUTO_LOGIN=true` | بوابة العرض أولًا (404)، ثم `requireAuth` (401)، ثم `canOpenDemoPersona` (403)، وسقف: لا شخصية أعلى من المستدعي |
| `/demo/owner` | يفتح SUPER_ADMIN تلقائيًا | إشعار «للموظفين فقط» + رابط دخول؛ لا استدعاء تلقائي؛ إخفاء شخصية SUPER_ADMIN عن غير SUPER_ADMIN |
| بيانات اعتماد العرض | `Passw0rd!2026` منشورة | `DEMO_ACCOUNT_PASSWORD` (عشوائي، git-ignored)؛ إعادة تشغيل `seed-demo` تدوّر الهاشات |
| حساب العرض الرسمي | `rhimiimed18@gmail.com` (بريد شخصي) | `demo@wasit.tn` (محايد) + تعطيل/إخفاء هوية الصف القديم في قاعدة العرض |
| سجل الـseeder | يطبع كلمة المرور المنشورة وكلمة مرور الموظفين | لا يطبع أي كلمة مرور |

**الدليل (تشغيل حيّ على الرابط العام، 2026-11-21):**

| الفحص | النتيجة |
| --- | --- |
| زائر → `POST /api/auth/demo-audit-session` | **401** `UNAUTHORIZED`، ولا جلسة |
| زائر → `/demo/owner` (متصفح، 390×844) | `owner-staff-only` ظاهر، `owner-roles` = 0، `/api/auth/me` = 401 |
| كلمة المرور القديمة `Passw0rd!2026` | **401** لكل حسابات العرض |
| `DEMO_ACCOUNT_PASSWORD` الجديدة | **200** لـcustomer/merchant/supplier/company/`demo@wasit.tn` |
| البريد الشخصي القديم | **401** (الصف معطّل و`removed-…@invalid.local`) |
| SUPER_ADMIN يفتح شخصية super-admin | **200** (roles: ADMIN, CUSTOMER, SUPER_ADMIN) |
| ADMIN يفتح شخصية super-admin | **403** «staff account that outranks the persona» |
| ADMIN يفتح شخصية merchant | **200** |
| CUSTOMER على `/api/admin/stats` | **403** · زائر **401** |
| POST بجلسة بلا `Origin` (staging) | **403** CSRF |
| `POST /api/auth/demo-session` | **200** — `demo@wasit.tn`, roles `['CUSTOMER']` |
| متصفح: SUPER_ADMIN يرى مبدّل super-admin · ADMIN لا يراه | ✅ |

**الاختبارات:** `tests/unit/demo-audit-authorization.test.ts` **5/5** · `tests/demo-auto-login.test.ts`
**23/23** · الحزمة الكاملة **147 ملفًا / 1905 اختبارًا — كلها ناجحة** (تشغيل ببيئة نظيفة) ·
`tsc --noEmit` server وweb **0 أخطاء** · `ui-mobile-smoke` **16/16** · `ui-functional-audit` **45/45**.

**ملاحظة بيئية (ليست انحدارًا):** تشغيل الحزمة في shell ورث `APP_URL` من `.env.demo` يُفشل
`tests/seo.test.ts` (3 حالات) لأن sitemap/robots يعكسان الأصل العام؛ مع `APP_URL=http://localhost:5173`
تمرّ **10/10**. نفس فخ تهريب `.env.demo` الموثّق في `AGENTS.md`.

---

## §26 — AI-MEM-01: ذاكرة الوكلاء المؤسسية المعزولة (CLOSED / VERIFIED — 2026-11-21)

**الفحص أولًا.** `agent_memory` كان **جدولًا بلا ذاكرة**: موجود منذ migration `0033`، صفر صفوف في
`wasit_demo` و`wasit_test`، ولا كاتب ولا قارئ في الكود — فقط تعليق في `agent-run-context.ts` يدّعي أن
`priorContext` يُجمَّع منه. كل ما يلزم للطبقة كان ناقصًا: هوية، عزل، أنواع، انتهاء صلاحية، فاحص أسرار،
تدقيق قراءة، حدود، وواجهة إشراف.

**ما بُني (كود إنتاج):**

| القدرة | التنفيذ |
| --- | --- |
| حفظ/استرجاع/تحديث/حذف | `modules/ai/memory.ts` + `GET/POST/PATCH/DELETE /api/ai/memory` |
| هوية الوكيل المالك | `agent_key` إلزامي في كل عملية؛ المالك من الجلسة فقط (`ctx.user.id`) |
| عزل الوكلاء | كل استعلام `owner + agent_key`؛ معرّف صف وكيل آخر ⇒ 404 |
| عزل المالكين | `scope_owner` في كل استعلام؛ `.strict()` يرفض `scopeOwner` في الجسم (422) |
| النطاق | `taskId` (يُتحقق أنه للمالك ونفس الوكيل)، `entityType/entityId` من قائمة مغلقة |
| الأنواع | `operational` / `contextual` / `procedural` / `task_result` |
| التواريخ والانتهاء | `createdAt` + `updatedAt` + `expiresAt` مع TTL لكل نوع وسقف 365 يومًا |
| منع الأسرار | 12 نمطًا + Luhn + IBAN + بريد ⇒ 422 `MEMORY_CONTENT_REFUSED` |
| التدقيق | 11 إجراء `AI.MEMORY_*` يشمل القراءة (`READ`/`LISTED`/`RECALLED`) |
| الحدود والاحتفاظ | 2000 حرفًا · 200/وكيل · 1000/مالك · حذف المنتهي فعليًا |
| السلامة | checksum لكل صف + `revision` + 409 عند التلاعب |
| الإشراف | `AI_MANAGE` فقط: ملخص/بيانات وصفية/فحص بسبب مُسجَّل/تنظيف — بلا تصدير نصوص جماعي |
| ربط التشغيل | `priorContext` من ذاكرة الوكيل نفسه + `task_result` تلقائي لكل مهمة منتهية |

**القيود المحفوظة:** لا migration، لا seed، لا تغيير في `wasit_demo`/الإنتاج، لا صلاحية RBAC جديدة
(`AI_USE` للذاكرة الخاصة، `AI_MANAGE` للإشراف)، ولا توسيع `allowedTables` لأي وكيل — اختبارات
`agent-scope-contract` التي تشترط ألّا يقرأ أي وكيل `agent_memory` عبر نطاق التشغيل ما زالت تمرّ.

**الدليل:** `tests/ai-mem01-agent-memory.test.ts` **15/15** · `tests/unit/agent-memory-policy.test.ts`
**6/6** · الحزمة الكاملة **149 ملفًا / 1926 اختبارًا — كلها ناجحة** · `tsc --noEmit` **0 أخطاء**.

**فجوة متبقية (معلنة لا مخفية):** لا واجهة ويب للذاكرة بعد — الطبقة API فقط؛ إضافة لوحة للمستخدم
قرار منفصل. الترقية إلى أعمدة `updated_at`/`expires_at` مفهرسة مؤجَّلة إلى ما بعد موافقة على migration
على القواعد المشتركة (الخطة في AD-046).

## §27 — AI-MET-01: قياس أداء الوكلاء الدائم (CLOSED / VERIFIED — 2026-11-21)

**الفجوة قبل المهمة:** كان القياس كله **وقتيًا**. `agent-metrics.ts` (A3) يعيد حساب كل رقم من
`agent_tasks`/`ai_requests`/`agent_run_steps`/`audit_logs` عند كل طلب، وجدول `agent_metrics`
(موجود منذ migration `0033`) **فارغ تمامًا بلا كاتب ولا قارئ**. النتيجة: لا سلسلة زمنية، ولا سجل
يبقى بعد حذف المهام بسياسة الاحتفاظ، ولا إمكانية معرفة «كيف أدّى الوكيل الأسبوع الماضي»، ومسح كامل
للجداول في كل نداء. ولم تكن موجودة: المهام المرفوضة، المهام المتوقفة، المهلات، استخدام الأدوات
(المسموح/المرفوض)، طلبات الموافقة، ولا استفادة الذاكرة.

**ما بُني (كود إنتاج):**

| القدرة | التنفيذ |
| --- | --- |
| سجل قياس دائم | `modules/ai/metrics.ts` + جدول `agent_metrics` القائم — **بلا migration** |
| منع التكرار | مفتاح أساسي حتمي `sha256(JSON[agentKey,taskId,attempt,outcome])` + `ON CONFLICT DO NOTHING` |
| ربط دورة الحياة | المسار المباشر (نجاح/فشل)، مسار الموافقة (نجاح/فشل/رفض بشري)، والرفض قبل التنفيذ (`blocked`) |
| العدّ الدقيق | `tasks` = مهام مختلفة، `attempts` = (مهمة، محاولة) مختلفة — لا حدث يضيع ولا يُحسب مرتين |
| الإعادة | محاولة ثانية = صف جديد؛ `retriedTasks`/`maxAttempts` + خطوات `agent_run_steps` |
| المهام المتوقفة | استعلام حالة حاضر من `agent_tasks` بعتبة `AI_METRICS_STALL_AFTER_MINUTES` |
| الموافقات | `requested/approved/rejected/pending` + معدل القبول/الرفض البشري |
| الأدوات | `AI.TOOL_EXECUTED/REFUSED/FAILED/REPLAYED` + `TOOL_TIMEOUT` + أكثر 5 أدوات (معرّفات فقط) |
| الذاكرة | `recalls`/`recallRate`/`recorded`/`ownerNotes`/`integrityFailures` — **عدّ بلا محتوى** |
| التكلفة | `ai_requests` الفعلي؛ غياب الصفوف ⇒ `unavailable` و`null` لا صفر |
| التجميع | حسب الوكيل ونوع المهمة والنافذة الزمنية، وسلسلة يومية/أسبوعية/شهرية |
| الملء التاريخي | `POST /api/admin/ai/metrics/backfill` — idempotent، يتخطى غير المحسوم، مُدقَّق |
| التغطية | `coverage {tasksInWindow, tasksWithMetric, percent, backfillRecommended}` |
| الصلاحيات والعزل | `AI_MANAGE` فقط؛ لا تفصيل لكل مالك — عدد المالكين فقط؛ لا معرّفات ولا نصوص |
| متانة | `recordMetricSafely` يبتلع فشل القياس — لا يُفشل المهمة |

**القيود المحفوظة:** لا migration، لا seed، لا تغيير مالي، لا صلاحية RBAC جديدة، لا مساس ببيانات
الذاكرة الحالية، ولا عملية Git تدميرية. `agent-metrics.ts` (A3) لم يتغيّر عقده.

**الدليل:** `tests/ai-met01-agent-metrics.test.ts` **18/18** · `tests/unit/agent-metrics-store.test.ts`
**6/6** · الحزمة الكاملة **151 ملفًا / 1950 اختبارًا — كلها ناجحة** · `tsc --noEmit` **0 أخطاء**
(server + web). الاختبارات تشمل: دقة العدّ، منع التكرار، الفشل والرفض، الإعادة، الاستمرارية عبر
اتصال PostgreSQL مستقل، عزل الوكلاء، 401/403/200 للأدوار، فشل خدمة القياس، وعدم تسريب أي معرّف
مالك أو محتوى ذاكرة.

**فجوات متبقية (معلنة):**
1. **التكلفة لكل فترة**: `ai_requests` لا يحمل عمود وكيل (المفتاح داخل `metadata`)، فالسلسلة الزمنية
   لا تُقسّم التكلفة لكل دلو؛ التقرير يعطي تكلفة النافذة الكاملة بدقة. تقسيمها يتطلب فهرسًا على
   `metadata->>'agentKey'` (migration) أو مسحًا ثانيًا — قرار مؤجَّل.
2. **جودة النتائج**: لا مصدر يثبت أن توصية وكيل نُفِّذت تجاريًا، لذلك `businessOutcomes` تبقى
   `unavailable` بدلًا من رقم مُخمَّن. المتاح: نسبة وجود نتيجة مخزّنة + نسبة الرفض البشري.
3. **لوحة واجهة**: السطح API فقط؛ رسم بياني للمدير العام قرار منفصل.
4. **الاحتفاظ بسجل القياس**: لا حذف تلقائي لصفوف `agent_metrics` القديمة (لا سياسة احتفاظ معتمدة
   لهذا الجدول). يُترك النمو مكشوفًا ومُبلَّغًا بدل اختراع سياسة.

## §28 — AI-SUP-02: التصعيد إلى المدير العام وإشعاره (CLOSED / VERIFIED — 2026-11-21)

**الفجوة قبل المهمة:** كتالوج الوكلاء يعلن قدرة `escalate` على Agent Supervisor وهدف
`supervisor.escalation_delivery` (`undelivered_escalations = 0`)، ولم يكن هناك **أي تنفيذ**: لا كائن
تصعيد، لا حالة (`OPEN/ACKNOWLEDGED/RESOLVED`)، لا إشعار للمدير العام، ولا رؤية لانهيار دورة المشرف
نفسها أو لموافقة معلقة أو لتجاوز حدود المحاولات. كل ما كان متاحًا: `supervisor.ts` يحتوي ويعيد
المحاولة، و`audit_logs` يكتب ما حدث لمن يقرأه يدويًا.

**ما بُني (كود إنتاج):**

| القدرة | التنفيذ |
| --- | --- |
| قواعد الاكتشاف (9) | `modules/ai/escalation-policy.ts` — صرفة: بلا DB ولا ساعة، قابلة للاختبار بحقائق حرفية |
| فشل الوكيل المتكرر | معدل فشل ≥ العتبة على المحاولات المحسومة فقط (الرفض لا يُحسب محاولة فاشلة)، بعد `minSamples` |
| التوقف/التعليق | `task_stalled` من عمر المهمة الحقيقي؛ المتوقفة على إنسان تُصنَّف «موافقة معلقة» لا «متوقفة» |
| تجاوز المحاولات | `task_attempts_exhausted` — مهمة **مفتوحة** (queued) بلا محاولات متبقية |
| رفض الصلاحيات/النطاق | `agent_scope_violations` من قياس `blocked` ومن `AI.TOOL_REFUSED` (بالأكواد فقط) |
| فشل الأدوات | `tool_failures` من `AI.TOOL_FAILED` + تمييز المهلات (`TOOL_TIMEOUT`) |
| الموافقات المعلقة | `approvals_pending` (INFO، وWARNING عند تجاوز ضعف العتبة) |
| تدهور الأداء | `metrics_degradation` — هبوط معدل النجاح بين النافذة الحالية والسابقة |
| تعطل دورة المشرف | `cycle_failed` (HIGH/CRITICAL) و`cycle_inactive` (CRITICAL: مفعّل، رانجات مفتوحة، صفر تدخّل) |
| مستويات التصعيد | `INFO / WARNING / HIGH / CRITICAL` مع ترتيب صريح يُستخدم في الترقية والقصّ |
| سبب وأدلة | `title` + `recommendation` + `recommendationKey` + `evidence` (أعداد/أكواد/معرّفات فقط) |
| الوكيل/المهمة | `agentKey` / `taskId` / `runId` عند توفّرها |
| الحالة والتواريخ | `OPEN → ACKNOWLEDGED → RESOLVED`، `createdAt` + `updatedAt` + من أقرّ/أغلق ومتى ولماذا |
| منع التكرار | قفل `pg_advisory_xact_lock` على البصمة + حالة مفتوحة واحدة لكل بصمة؛ نفس الخطورة = تحديث بلا إشعار |
| التصعيد داخل الحالة | خطورة أعلى ⇒ ترقية + إعادة فتح + إشعار ثانٍ (جيل جديد) |
| عدم الإزعاج بعد الإغلاق | `reopenCooldownMinutes` (60) يمنع إعادة فتح حالة أُغلقت للتو |
| قناة المدير العام | `notifications` (IN_APP) للمستخدمين `SUPER_ADMIN` النشطين فقط + `notification_deliveries` كسجل تسليم فريد |
| فشل القناة | الحالة تبقى، `notified_result=FAILED`، سجل FAILED، و`POST /:id/notify` يعيد التسليم بلا تكرار |
| الحوكمة | `AI_MANAGE` فقط (بلا صلاحية جديدة)؛ Audit لكل إنشاء/ترقية/إقرار/إغلاق/إشعار |
| Kill Switch | إيقاف الاكتشاف والإشعار الآلي (مع تدقيق الرفض)، مع بقاء الإقرار/الإغلاق البشري |
| المسح الدوري | `startScheduler` — `AI_ESCALATIONS_ENABLED` كل `AI_ESCALATION_INTERVAL_MINUTES` (15) بحرس عدم تداخل |
| التخزين | `alert_events` (`rule = supervisor.<code>`) — **بلا migration ولا seed** |

**القيود المحفوظة:** لا migration، لا seed، لا تغيير في `wasit_demo`/الإنتاج، لا صلاحية RBAC جديدة،
لا بريد/SMS/webhook خارجي، لا تنفيذ آلي لقرار مالي أو إداري، ولا تغيير في عقد `supervisor.ts` أو
`agent-metrics.ts`.

**الدليل:** `tests/ai-sup02-escalations.test.ts` **21/21** · `tests/unit/escalation-policy.test.ts`
**22/22** · الحزمة الكاملة **153 ملفًا / 1993 اختبارًا — كلها ناجحة** · `tsc --noEmit` **0 أخطاء**.
الاختبارات تغطي: الاكتشاف من صفوف حقيقية، إنشاء الحالة وتصنيفها، منع التكرار، الترقية، استلام
المدير العام وإقراره، الإغلاق بتاريخه، العزل و401/403، فشل قناة الإشعار وإعادة التسليم، Kill Switch،
الاستمرارية عبر اتصال PostgreSQL مستقل، وعدم تسريب أي مُدخل مهمة أو بريد أو معرّف مالك.

**فجوات متبقية (معلنة):**
1. **`updated_at` غير مفهرس**: الحالة تُخزَّن في `alert_events` بلا عمود تحديث؛ الترتيب بالإنشاء لا
   بآخر تحديث. جدول `escalations` مخصص + فهرس فريد جزئي على البصمة المفتوحة هو الترقية الصحيحة،
   ويحتاج migration (ممنوع في هذه المهمة).
2. **قناة واحدة**: IN_APP فقط. البريد/SMS/webhook يحتاج مزوّدًا معتمدًا وموافقة صريحة.
3. **لا لوحة واجهة**: السطح API؛ شاشة المدير العام قرار منفصل.
4. **الاحتفاظ**: لا سياسة حذف لصفوف `alert_events` (مراقبة أو تصعيد).
5. **`cycle_inactive` استكشافي**: يعتمد على غياب تدخّل خلال ساعة؛ المشرف الذي لا يجد ما يفعله
   (كل شيء سليم) لا يُصنَّف خاملًا إلا إذا وُجدت رانجات مفتوحة قديمة.

## §29 — AI-ARCH-ALIGN-01: توحيد الهيكل الرسمي للمنظومة الذكية (CLOSED / VERIFIED — 2026-11-20)

**الفجوة قبل المهمة:** الهيكل المُعلن (12 وكيلاً رسمياً) لم يكن معرَّفاً في الكود. `catalogue.ts` كان
قائمة مسطّحة من 20 وكيلاً بلا `tier`، فلا شيء يفرّق بين «رسمي» و«داعم داخلي»؛ ولا وكيل فيديو تسويقي
رغم وجود قدرة رندر فيديو حقيقية في `lib/media/*`؛ وطبقة التنسيق كانت تقبل خطة لوكيل بلا منفّذ (أو
للمشرف/Copilot) ولا ترفضها إلا **وقت الإرسال** بعد كتابة صف التشغيل؛ و`POST` لإنشاء خطة لم يكن
معروضاً عبر HTTP إطلاقاً.

**ما بُني:**

| القدرة | التنفيذ |
| --- | --- |
| تعريف رسمي للاثني عشر | `CORE_SPECIALIST_KEYS` (مرتّبة) + `tier: 'CORE_SPECIALIST'` على كل عضو |
| فصل الداعمين | `tier: 'SUPPORTING'` على الثمانية + `supportingAgents()` |
| فصل الحوكمة | `governanceAgents()` = Copilot + Supervisor، و`tier: 'GOVERNANCE'` لكل منهما |
| فحص التكامل | `catalogueIntegrity()` — مفاتيح ناقصة/زائدة/مكرّرة/Copilot داخل الكتالوج |
| وكيل الفيديو | `marketing-video-agent` بعقد كامل، `executable: false`، `scope: 'own'`، `ai:use` فقط — **عُدِّل في COMPLETION-02 (منفّذ تخطيط) وCOMPLETION-03 (رندر + تحقق داخل المهمة، بلا نشر وبلا كتابة صفوف)** |
| فصل الإنتاج عن النشر | `render_video`/`publish_video` بموافقة، و`video.publish`/`video.render_paid` في `SENSITIVE_ACTIONS` |
| منع توجيه وكيل بلا منفّذ | `agentRunRefusal` داخل `validatePlan` — رفض 422 قبل أي كتابة |
| إتاحة التنسيق | `POST /api/admin/ai/agent-runs` (PLANNING فقط، `AI_MANAGE`، Kill Switch) |

**حدود مُعلنة (ليست تنفيذاً ناقصاً مخفياً):**

1. ~~منفّذ وكيل الفيديو غير موجود~~ — **حُلَّ جزئياً في AI-FIRST-COMPLETION-02:** منفّذ التخطيط موجود؛ الإنتاج والنشر ما زالا يحتاجان قرار ميزانية/ملكية/نشر (AD-049 `DECISION REQUIRED`).
2. لا تفكيك أهداف آلي (لا LLM Planner) ولا اختيار وكيل تلقائي — قرار المتصل، والكود يتحقق فقط.
3. لا واجهة ويب لطبقة التنسيق؛ المسار الإداري فقط.

**الإثبات:** `tests/unit/ai-arch-align.test.ts` (17) · `tests/ai-arch-align-copilot.test.ts` (12) ·
`tsc --noEmit` = 0 · المجموعة الكاملة خضراء بعد تحديث عقود العدّ (21 وكيلاً).

**ملاحظة عقود:** `agentCount()` 20 ← 21، `allAgentSpecs()` 21 ← 22، `declaredOnlyAgents()` 8 ← 9.
كل الاختبارات التي كانت تُثبّت الأرقام حُدِّثت، ولم يُحذف أي وكيل ولم تتغيّر أي صلاحية.

## §30 — AI-AGENT-MERGE-01: دمج الاختصاصات وتطوير منظومة WASIT AI (CLOSED / VERIFIED — 2026-11-20)

**الفجوة قبل المهمة:** ثلاث هويات في الكتالوج كانت تعلن اختصاصاً أوسع مما تنفّذه:
`outreach-acquisition-agent` (استقطاب فقط، بلا ترتيب أسواق أو فرص مؤهلة، وبلا منفّذ)،
`finance-agent` (تلخيص مالي بلا حساب تكلفة أو مساهمة، وبلا منفّذ، ويعلن أداة `finance.read_ledger`
المحجوبة بنيوياً)، و`development-agent` (يولّد «خطة تقنية» نصية فقط بلا تشخيص حقيقي من حالة الطبقة).
النتيجة: ثلاث وظائف مطلوبة من المدير العام (توسع عالمي، محاسبة تكاليف، صيانة/إصلاح) بلا قدرة قابلة للفحص.

**ما بُني:**

| الوكيل (مفتاح ثابت) | الاختصاص بعد الدمج | المنفّذ | البوابة |
| --- | --- | --- | --- |
| `outreach-acquisition-agent` | Global Growth & Acquisition: ترتيب أسواق من العرض/الكتالوج، فرص مؤهلة بدليل، شرائح، مسودات متعددة اللغات | `execGrowthAgent` (`discover_markets`) | `requiresHumanApproval: true`؛ الإرسال/الحملات `approvalActions` بلا منفّذ |
| `finance-agent` | Finance & Cost Accounting: إيراد/تكلفة/مساهمة لكل عملة من `orders`+`campaigns`+`ai_requests` | `execFinanceAgent` (`report_pnl`) | تلقائي (قراءة فقط)؛ ledger/policies محجوبة |
| `development-agent` | Platform Maintenance & Repair: تشخيص من `agent_tasks`/`agent_runs`/`agent_run_steps` مع دليل وخطورة | `execDevelopmentAgent` (`diagnose_platform`) | التشخيص تلقائي؛ `code.apply_patch`/`code.merge` بلا منفّذ |
| `marketing-video-agent` | كما هو | — | `AGENT_NOT_EXECUTABLE` (AD-049) — **أُلغي في AI-FIRST-COMPLETION-02**: منفّذ تخطيط، والرندر/النشر يبقيان بلا منفّذ |

**الضوابط:** لا صلاحية RBAC تغيّرت (مقارنة snapshot) · عقد A2 جديدان (مالية/نمو) + توسيع عقد الصيانة
لجداول التشغيل · `code.apply_patch`, `code.merge`, `growth.paid_campaign` في `SENSITIVE_ACTIONS` ·
لا خلط عملات في المالية (`null` + سبب عند غياب التكلفة) · لا إرسال/شراء/تعديل كود بأي مسار.

**الأرقام:** 21 وكيلاً (بلا تغيير) · القابلون للتنفيذ 11 → **13** · عقود النطاق 11 → 13 · المعلنون فقط 9 → 7.

**تعديل لاحق (AI-FIRST-COMPLETION-03، 2026-11-22):** وكيل الفيديو صار **يرندر ويتحقق داخل المهمة** (`render` + `store` + `probe` + `decode`) بلا كتابة `media_assets`/`audit_logs` · `b2b-agent` انتقل إلى `requiresPlatformScope` ⇒ الوكلاء بعرض المنصة 10 → **11** · `sales`/`marketing`/`product` تُفلتر صفياً بالملكية. التفاصيل: `docs/AI-FIRST-COMPLETION-03.md`.

**تعديل لاحق (AI-FIRST-COMPLETION-02، 2026-11-22):** القابلون للتنفيذ 13 → **14** (منفّذ تخطيط الفيديو) · عقود النطاق 13 → 14 · المعلنون فقط 7 → **6** · `requiresPlatformScope` 9 → **10** (`market-research-agent`) · `support-agent` صار مفلتراً صفياً. التفاصيل: `docs/AI-FIRST-COMPLETION-02.md`.

**الإثبات:** `tests/unit/ai-agent-merge-01.test.ts` (14) · `tests/ai-agent-merge-01.test.ts` (5، PostgreSQL حقيقي)
· تحديث عقود العدّ في 7 ملفات · `tsc --noEmit` = 0 · المجموعة الكاملة خضراء.

**حدود مُعلنة:** لا إرسال خارجي، لا شراء حملات، لا تعديل ملفات/مخطط آلياً، لا قراءة ledger،
ولا ربط لوكيل الفيديو. التفاصيل: `docs/AI-AGENT-MERGE-01.md`، القرار: AD-050.

## 25. GM-ACCESS-01 — دخول المدير العام دون الاعتماد على البريد (2026-11-23)

> **العدّ:** يُضاف معرّف واحد **مغلق** (`GM-ACCESS-01`) ⇒ «المفتوحة» بلا تغيير و«المغلقة» +1.
> الحالة `COMPLETE_VERIFIED`: كود + Migration + اختبارات ناجحة + توثيق + قرار معماري.

| ID | البند | الخطورة | الأولوية | التبعية | الحالة | معيار القبول | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GM-ACCESS-01** | **حساب `SUPER_ADMIN` لا يستطيع إكمال الدخول**: `loginUser` يرفض أي حساب `emailVerified=false` بـ`403 EMAIL_NOT_VERIFIED` **قبل** أي خطوة، والقناة الوحيدة لإشباع البوابة رابط بريدي بينما `MAIL_TRANSPORT` افتراضيه `log` و`ALLOW_DEV_TOOLING=false` (فلا يصل شيء ولا مسار بديل). وبشكل مستقل: فقدان جهاز TOTP بلا رموز استرداد = قفل دائم (لا مسار استعادة للمشغّل)، و`POST /api/auth/mfa/enroll` كان يقبل جلسة قائمة وحدها ويستبدل السر (جلسة مسروقة تُزيح عامل المالك). **الإصلاح:** البوابة باقية لكل حساب، وتُشبَع (1) بعامل ثانٍ **مؤكَّد** يُقرأ حيًّا (`AUTH.EMAIL_VERIFIED_VIA_MFA`)، أو (2) بتذكرة مشغّل أحادية الاستخدام (15 دقيقة، هاش فقط، مقيَّدة بحساب واحد، تُولَّد من CLI محلي فقط بـ`--confirm` وسبب مُدقّق) لا تتجاوز عاملًا مُفعَّلًا ولا تمنح دورًا ولا تعيد تعيين كلمة مرور؛ و`reset-factor` يحذف العامل المفقود ويُبطل كل الجلسات دون لمس كلمة المرور؛ و`/mfa/enroll` يتطلب كلمة المرور (+رمز حالي إن كان العامل مُفعَّلًا) وتغيير العامل يُبطل الجلسات الأخرى. | CRITICAL | P0 | — | **COMPLETE_VERIFIED** | دخول `SUPER_ADMIN` بلا بريد · رفض تجاوز الحسابات الأخرى · رفض الترقية · جلسات تنتهي وتُبطل · رموز استرداد مرة واحدة · لا أسرار في السجلات · دخول بقية المستخدمين بلا تغيير | `packages/server/tests/gm-access-01.test.ts` (**17/17**) · Migration `0044_gm_access_tickets.sql` · `lib/gm-access.ts` + `lib/session-admin.ts` + `scripts/gm-access.ts` (`npm run gm:access`) · `docs/GM-ACCESS-01.md` · AD-058 · Typecheck (server+web) = 0 |

**حدود الإثبات:** الاختبارات تعمل على `wasit_test` الحقيقية عبر `createApp()` (بلا mocks). قاعدة Demo
لم تُمسّ، ولم تُعدّل أي كلمة مرور. التذكرة تُثبت باختبار استخدام مزدوج وتقييد بحساب، لكن **لم** يُختبر
مسار CLI نفسه في CI (يُستدعى `issueGmAccessTicket` التي يستدعيها الـCLI مباشرة).

## 26. GM-ACCESS-02 — تدوير كلمة مرور المدير العام (2026-11-23)

> **العدّ:** يُضاف معرّف واحد **مغلق** (`GM-ACCESS-02`) ⇒ «المفتوحة» بلا تغيير و«المغلقة» +1.
> الحالة `COMPLETE_VERIFIED` للكود والاختبارات؛ **تطبيقها على الحساب الفعلي ينتظر موافقة المالك**.

| ID | البند | الخطورة | الأولوية | التبعية | الحالة | معيار القبول | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GM-ACCESS-02** | **كلمة مرور `SUPER_ADMIN` مجهولة أو مسرَّبة**: كل مسارات AD-058 تفترض امتلاك كلمة المرور (رابط البريد، العامل المؤكَّد، التذكرة تُدخَل معها، `reset-factor` لا يمسّها)، فلم يكن للمالك أي إجراء. **الإصلاح:** `npm run gm:access -- set-password` يستبدل كلمة مرور **حساب واحد** (`users.password_hash` فقط)، يولّد ٣٢ حرفًا من CSPRNG أو يقرأ من ملف `0600`، يحفظ السر في ملف `0600` داخل مجلد `0700` **خارج Git**، يُبطل كل جلسات الحساب، ويُدقّق السبب والمشغّل وعدد الجلسات **بلا أي سر**. مرفوض: `--password` في argv، الملف المقروء للمجموعة، `--vault` داخل شجرة Git، `Rhimi123`/`Passw0rd!2026`، أقل من ٢٤ حرفًا، وأي حساب ليس `SUPER_ADMIN`. لا يمسّ `email_verified` ولا `mfa_enabled` ولا `authenticator_apps` ولا `user_roles`. | CRITICAL | P0 | GM-ACCESS-01 | **COMPLETE_VERIFIED** (تطبيق الإنتاج بانتظار موافقة) | كلمة مرور جديدة تعمل والقديمة تُرفض · الجلسات القديمة 401 · حساب آخر لم يتغيّر · البوابة والعامل الثاني سليمان · رفض غير `SUPER_ADMIN` · لا سر في التدقيق · الملف `0600` | `packages/server/tests/gm-access-02.test.ts` (**12/12**) · `lib/gm-access.ts` + `scripts/gm-access.ts` · `docs/GM-ACCESS-02.md` · AD-059 · فحص CLI فعلي على `wasit_test` المعزولة · Typecheck (server+web) = 0 |

**حدود الإثبات:** الاختبارات والفحص اليدوي جريا على `wasit_test` المعزولة فقط. لم تُطبَّق أي
كلمة مرور على `wasit_demo` أو الإنتاج، ولم تُغيَّر كلمة مرور أي حساب آخر. **لا Migration مطلوبة**
(الأداة تستخدم `users.password_hash` و`sessions` القائمين منذ `0000`).

## 27. GM-ACCESS-04 — حارس بيئة قاعدة البيانات (2026-11-23)

> **العدّ:** يُضاف معرّف واحد **مغلق** (`GM-ACCESS-04`) ⇒ «المفتوحة» بلا تغيير و«المغلقة» +1.

| ID | البند | الخطورة | الأولوية | التبعية | الحالة | معيار القبول | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GM-ACCESS-04** | **`gm:access` تنفّذ `set-password`/`reset-factor` على أي قاعدة**: بعد GM-ACCESS-02 كان يكفي `DATABASE_URL` خاطئ (رأيناه فعليًا يشير إلى `wasit_test`) لتغيير كلمة مرور حساب على قاعدة اختبار أو Demo منشورة. **الإصلاح:** بوابة بثلاثة شروط مستقلة — `NODE_ENV=production` **و** `WASIT_PRODUCTION_DB_NAME` مساوٍ لِـ`current_database()` المقروء من الخادم **و** اسم غير محمي (`wasit_test`/`wasit_demo`/`wasit_dev`/`wasit_staging`/`postgres`/`template*`/`*_test`/`*_demo`…) — مع تثبيت مضيف اختياري. الرفض يسبق البحث عن الحساب فلا يُكتب أي صفّ. | CRITICAL | P0 | GM-ACCESS-02 | **COMPLETE_VERIFIED** | رفض `wasit_test`/`wasit_demo`/`postgres` حتى لو أُعلنت إنتاجًا · رفض بلا `NODE_ENV=production` · رفض بلا إعلان اسم · رفض تعارض الاسم/المضيف · قبول إنتاج مطابق · لا سرّ في الرسائل · الرفض بلا أي كتابة | `packages/server/tests/gm-access-04.test.ts` (**18/18**، منها 4 تشغّل الـCLI كعمليّة فرعية) · `lib/db-target-guard.ts` + `scripts/gm-access.ts` · `docs/GM-ACCESS-04.md` · AD-060 · Typecheck = 0 |

**حدود الإثبات:** لا توجد قاعدة إنتاج في بيئة التطوير، فمسار **القبول** مُثبت على دالّة
القرار فقط (اسم إنتاج مطابق، اسم مختلف معلن، مضيف مثبَّت، حالة الأحرف)؛ مسار **الرفض**
مُثبت عبر الـCLI الحقيقي على `wasit_test`. لم تُنفَّذ أي كتابة على أي قاعدة، ولم يُغيَّر
أي حساب.

## 28. GM-ACCESS-05 — حزمة نشر الاستعادة على الإنتاج (2026-11-23)

> **العدّ:** يُضاف معرّف واحد **مغلق** (`GM-ACCESS-05`) ⇒ «المفتوحة» بلا تغيير و«المغلقة» +1.

| ID | البند | الخطورة | الأولوية | التبعية | الحالة | معيار القبول | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GM-ACCESS-05** | **الاستعادة كانت إجراءً شفهيًا**: بعد GM-ACCESS-02/04 كانت الأداة والحارس جاهزين، لكن المشغّل على الإنتاج لا يملك إلا نصًّا؛ كل خطوة يدوية تُنسى تُنتج سرًّا في سجل الأوامر أو تدويرًا على قاعدة خاطئة. **الإصلاح:** حزمة `deploy/gm-recovery/` — `check-runtime` ثم `precheck` (يكتب baseline) ثم `generate-password` أو ملف `0600` ثم `rotate` (تأكيد بكتابة اسم القاعدة) ثم `verify` (١٠ فحوص مقابل الـbaseline) ثم `login-check` — مع packager يُنتج tar.gz موقّعًا بـSHA256SUMS ويرفض أي ملف يشبه سرًّا. | CRITICAL | P0 | GM-ACCESS-04 | **COMPLETE_VERIFIED** (التنفيذ على الإنتاج بانتظار موافقة المالك) | رفض `wasit_test`/`wasit_demo` في كل طبقة · لا سرّ مطبوع أو في argv · `verify` يفشل عند تغيّر `email_verified`/العامل/الأدوار أو بقاء جلسة أو غياب صفّ تدقيق · `generate-password` لا يمسّ أي حساب · الحزمة تعمل بلا مستودع | `packages/server/tests/gm-access-05.test.ts` (**33/33**) · `lib/gm-recovery.ts` · `deploy/gm-recovery/` · `docs/GM-ACCESS-05.md` · AD-061 · tar.gz ٤٨٨KB استُخرج في مجلد نظيف و٥٩ checksum نجحت · Typecheck = 0 |

**حدود الإثبات:** كل ما سبق جرى على `wasit_test` المعزولة وعلى حزمة مستخرجة بلا مستودع. **لم**
يُجرَ `precheck → rotate → verify → login-check` على قاعدة إنتاج (لا يوجد مضيف إنتاج متاح من هنا)،
ولم يُغيَّر أي حساب أو قاعدة.

## 29. CI-01 — إصلاح بوابة الاختبارات (2026-11-23)

> **العدّ:** لا يُغلق هذا البند أي فجوة سابقة ولا يغيّر «المفتوحة/المغلقة» — كان
> فشل CI **عطلاً في البوابة نفسها** لا فجوة منتج مسجّلة. يُضاف معرّف واحد
> (`CI-01`) بحالة `COMPLETE_VERIFIED` بعد تشغيل حقيقي، والانحدارات التي كشفها
> (فشلان في `admin-webhook-failures`) تُسجَّل كبنود مفتوحة تحت **OBS-01**.

| ID | البند | الخطورة | الأولوية | التبعية | الحالة | معيار القبول | دليل الإغلاق |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CI-01** | **CI لم يكن يشغّل الاختبارات أصلاً**: (1) `ci.yml` كان يضبط `TEST_DATABASE_URL=...@localhost:5432` بينما `tests/test-db-guard.ts` يرفض كل هدف غير `127.0.0.1:5434` → `vitest.config.ts` يفشل عند التحميل قبل أي اختبار؛ (2) `ffprobe` غير موجود على الـrunner (`ffmpeg-static` يوفّر `ffmpeg` وحده) و`npm ci --ignore-scripts` يمنع تنزيل باينري `ffmpeg-static` → 5 تأكيدات/مواصفات فيديو تفشل؛ (3) piper غير مثبَّت إطلاقاً و`scripts/install-tts.sh` نفسه معطوب من نسخة نظيفة (`cp -a piper/. .` يصطدم بمجلد الأرشيف) → `voice-pack.test.ts` يفشل ومواصفات الصوت تُتخطّى؛ (4) `age` مثبَّت بإصدار دقيق اختفى من أرشيف Ubuntu، و`pg_dump` من الـrunner (Ubuntu 26.04، عميل 18) يكتب `SET transaction_timeout` الذي يرفضه خادم 16 → نصف الاستعادة في فحص النسخ الاحتياطي يفشل؛ (5) مواصفة `e2e/mfa.spec.ts` لا تملأ كلمة المرور التي يشترطها نموذج تفعيل MFA (إعادة مصادقة) → الزر معطّل واختباران يتوقّفان. **الإصلاح:** CI يتبنّى عقد الحارس (خدمة على `127.0.0.1:5434`، `trust`، بلا كلمة مرور)، `npm rebuild argon2 ffmpeg-static`، تثبيت `ffmpeg`+خطوط+piper مع خطوات تحقّق صريحة، خادم الفحص على 17 ليطابق عميل الـrunner، وإصلاح مُثبِّت piper والمواصفة. **بلا `skipIf` جديد وبلا تخفيف أي تأكيد.** | HIGH | P0 | — | **COMPLETE_VERIFIED** | CI أخضر في الوظائف الثلاث القابلة للإغلاق · صفر أسرار في ملف الـworkflow · الاختبارات كلها تُنفَّذ لا تُتخطّى · فيديو يُرسم ويُتحقَّق فعلياً في CI | **تشغيل حقيقي #45133544390**: `Unit & integration tests` ✅ **179 ملف / 2335 اختباراً ناجحاً / 0 فاشل / 0 متخطّى** (353s، ffmpeg/ffprobe 8.0.1، piper ready) · `Backup & restore drill` ✅ **113 PASS** بما فيها E3 (استعادة مشفّرة بهوية صحيحة، 120 صفاً) مع `pg_dump 18.7` وخادم 17 · `Typecheck & build` ✅ · `E2E` **242 ناجح / 15 متخطّى / فشلان** في `admin-webhook-failures` فقط (انظر أدناه) · `actionlint 1.7.12` = 0 · Typecheck محلي (server+web) = 0 |

**سبب المشكلة الأصلي:** الحارس `test-db-guard.ts` أُضيف لحماية مسار `DROP/CREATE DATABASE`
من قاعدة إنتاج، لكن ملف CI لم يُحدَّث معه؛ فصار الشرط الأمني وملف الـCI يتناقضان،
وأي تشغيل في CI يفشل **قبل** أول اختبار. أما فشل الفيديو فسببه أن `ffmpeg-static`
يوفّر `ffmpeg` فقط ولا يوفّر `ffprobe`، وهو ما تستخدمه طبقة التحقّق (`verify.ts`،
`video-quality.ts`، `tts.ts`).

**حدود الإثبات:** المجموعة الكاملة شُغّلت محلياً على PostgreSQL 17.12
(`127.0.0.1:5434/wasit_test`) مع `ffprobe 7.1.5` (**2335/2335**)، ثم في CI على
الـrunner الحقيقي (**2335/2335**، بلا تخطٍّ). قسم E3 من فحص النسخ الاحتياطي لا يعمل
محلياً لأن الدور `wasit` المحلي ليس superuser (يرفض `pg_authid`)، ويُثبَت في CI حيث
`POSTGRES_USER=wasit` هو superuser. **لم تُغيَّر أي قاعدة بيانات ولم تُضَف أي Migration.**

**فشلان متبقّيان — خارج نطاق CI-01 (OBS-01):** `e2e/admin-webhook-failures.spec.ts`
يتوقّع `404` لكل تسليم لحدث «intent غير موجود» ثم `DEAD_LETTERED` بعد 5 محاولات سريعة.
بعد محرّك الاستعادة (OBS-01-RECOVERY) صار الخادم يردّ `200` (إقرار + تصنيف + backoff
30s)، فلا تُستنفد المحاولات في 5 تسليمات متتالية. المواصفة لم تُحدَّث مع العقد الجديد،
وقرار الشكل (`200` مقابل `404`) وتسليط `WEBHOOK_RETRY_*` في بيئة الـE2E يخصّان OBS-01
ولم يُلمسا هنا. البوابة الآن **تُظهر هذا العيب بدل أن تخفيه**.
