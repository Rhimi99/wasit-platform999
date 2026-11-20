# LC-03 — Prohibited & Restricted Goods Policy

الحالة: **`COMPLETE_VERIFIED`** (تقنياً) — إغلاق WASIT-EXECUTION-008.1 بعد نجاح الحالات الأربع عبر HTTP على PostgreSQL 16 مؤقتة معزولة + 26/26 اختبار معزول + TypeScript. الجزء القانوني (نصّ السياسة/قائمة العقوبات الرسمية) يبقى **اعتماداً خارجياً مفتوحاً** تحت LC-01/LC-05.

> **تنبيه:** هذا الضابط **تقني بحت**. لا يدّعي امتثالاً قانونياً كاملاً ولا يغطّي كل تشريع في كل بلد؛ القائمة الأولية **قابلة للضبط** من الإدارة، والقرارات الحدّية تحتاج مراجعة قانونية. النصّ القانوني نفسه يبقى تحت **LC-01**.

## 1. الفجوة قبل العمل

`docs/GAP_REGISTER.md` §5 كان يصف LC-03: «لا سياسة سلع محظورة (محتوى/إنفاذ)» — بحالة `PENDING`.

الفحص المحدود أكّد:
- **لا يوجد أي فحص سلع محظورة** في مسار إنشاء المنتج: `createProduct` في `packages/server/src/modules/products/service.ts` كان يتحقّق فقط من طول الاسم، وسالبيّة السعر، وتفرّد (البائع، SKU). لا قائمة، لا فلترة، لا تدقيق.
- **موضع الإدراج الوحيد** كان `db.insert(products).values({… status: 'ACTIVE', isPublished: true …})` — أي أنّ أي إدراج يُنشر فوراً وبلا بوّابة.
- لا تلميحات «محظور/blocklist» في وحدة المنتجات، وأدوات الـAI لا تمسّ المنتجات أصلاً.
- توجد **محرّكات سياسات جاهزة** يمكن البناء عليها بدل اختراع مسار جديد: `lib/policy-engine.ts` (سياسة مُنطاقة: الأخصّ يفوز)، `lib/country-policy-gaps.ts` (تسجيل فجوة `DECISION_REQUIRED`)، `lib/risk-engine.ts`، `lib/trust-engine.ts`.

## 2. القرار التقني

1. **مصنّف مركزي واحد** (`lib/prohibited-goods.ts`) هو المصدر الوحيد للحقيقة: قائمة قواعد مع `severity` (PROHIBITED / RESTRICTED / ALLOWED) و`reason`، وكل قاعدة لها `id` ثابت يظهر في التدقيق.
2. **الفشل المُغلق (fail-closed):** PROHIBITED يُرفض نهائياً ولا يُكتب شيء؛ RESTRICTED يُقبل **مسودّة غير منشورة** (`status=DRAFT`, `isPublished=false`)؛ ALLOWED يُنشر كما كان.
3. **مقاومة التحايل:** التطبيع (`normalizeForMatch`) يُسقط حالة الأحرف، والتشكيل والحركات، وأشكال الحروف العربية/الفارسية (أ/إ/آ→ا، ى→ي، ة→ه)، والمسافات/الفواصل/رموز العرض الصفري. المطابقة **على مستوى الكلمة الكاملة** (لا `substring`) فلا تطلق كلمة حميدة على أخرى («begun» لا تطابق «gun»).
4. **الإنفاذ في الخدمة لا في المسار:** `enforceListingPolicy` تُستدعى داخل `createProduct`/`updateProduct`/`updateProductStatus`، فأي مدخل — HTTP، seed، مهمة استيراد مستقبلية — يخضع لنفس الحكم ولا يتجاوزه بالنداء المباشر للخدمة.
5. **إعادة التصنيف عند التعديل:** `updateProduct` تعيد تصنيف **المنتج الناتج** (لا الحقول المتغيّرة فقط)، فلا يستطيع بائع أن يعيد تسمية/توصيف منتج قائم ليصبح محظوراً أو مقيّداً، ولا أن «ينظّف» منتجاً مُعلَّماً. المنتج المقيّد الذي كان منشوراً يُسحَب تلقائياً إلى مسودّة.
6. **بوّابة بشرية للمقيّد:** لا مسار آلي (ولا تغيير حالة) ينشر منتجاً مقيّداً؛ فقط `POST /api/products/:id/compliance-review` بصلاحية `catalog:compliance:review` — وهي **لا تُمنح لأي وكيل AI**.
7. **بلا Migration:** لا جدول/عمود جديد. العلامة تُخزَّن في عمود `products.tags` (jsonb) **غير المستخدَم سابقاً**، والقرار يُسجَّل في `audit_logs` القائم.

## 3. التصنيف (severity precedence)

الترتيب صارم: **PROHIBITED > RESTRICTED > ALLOWED** مهما كان ترتيب المطابقة أو الحقل. الفئات المغطّاة في القائمة الأولية:

| الفئة | أمثلة على المطابقات | الشدّة |
| --- | --- | --- |
| `ILLEGAL_GOODS_SERVICES` | مسروق، مقلّد/مزيف | PROHIBITED |
| `WEAPONS_AMMUNITION_EXPLOSIVES` | سلاح، بندقية، ذخيرة، متفجّرات (والأجزاء/السلائف: RESTRICTED) | PROHIBITED |
| `DRUGS_CONTROLLED_SUBSTANCES` | مخدّرات، كوكايين، حشيش، سموم، سيانيد | PROHIBITED |
| `MEDICINES_MEDICAL` | وصفة طبية، مضاد حيوي، لقاح، جهاز طبي | RESTRICTED |
| `COUNTERFEIT_STOLEN` | منتجات مقلّدة، مسروقة | PROHIBITED |
| `WILDLIFE_PROTECTED` | عاج، قرن وحيد القرن، أنواع مهدّدة | PROHIBITED |
| `SANCTIONS_TRADE_CONTROLS` | سلع محظورة دولياً، تهريب من العقوبات | PROHIBITED |
| `LICENSED_REGULATED` | كحول، تبغ، سجائر، ألعاب نارية، مبيدات، كيماويات خطرة | RESTRICTED |
| `FRAUDULENT_SERVICES` | وثائق/هوية مزيفة، عملة مزيفة، تبييض أموال، قرصنة حسابات | PROHIBITED |

> الحقول المفحوصة: `name`, `nameAr`, `nameFr`, `description`, `brand`, `categoryId`، وأي نصّ حرّ إضافي (`specifications`, أسماء الـvariants، نصّ بديل للصور).

## 4. التنفيذ

| الملف | الدور |
| --- | --- |
| `packages/server/src/lib/prohibited-goods.ts` | **المصنّف الصرف** (بلا DB): `GOODS_RULES`، `normalizeForMatch`، `classifyListing`، `isPublishable`. |
| `packages/server/src/modules/products/service.ts` | `enforceListingPolicy` (نقطة الإنفاذ الوحيدة: تدقيق + قرار)، وربطها في `createProduct`/`updateProduct`/`updateProductStatus`، و`reviewRestrictedListing` (قرار بشري). |
| `packages/server/src/modules/products/routes.ts` | `GET /api/products/compliance/queue` و`POST /api/products/:id/compliance-review`، محروسان بـ`requirePermission(CATALOG_COMPLIANCE_REVIEW)`. |
| `packages/shared/src/errors/api-error.ts` | رمزا الخطأ `PROHIBITED_GOODS` و`RESTRICTED_GOODS_REVIEW_REQUIRED` + مصنعاهما. |
| `packages/shared/src/constants/permissions.ts` + `rbac.ts` | صلاحية `catalog:compliance:review`، ممنوحة لـADMIN/SUPER_ADMIN (بشر) فقط. |

### المسارات

- `POST /api/products` — منتج محظور → **422 `PROHIBITED_GOODS`** بلا إدراج؛ مقيّد → **201** لكن `DRAFT` غير منشور.
- `PATCH /api/products/:id` — إعادة تصنيف الناتج؛ محظور → 422 بلا كتابة؛ مقيّد → يُسحَب إلى مسودّة.
- `PATCH /api/products/:id/status` — تفعيل منتج مقيّد غير معتمد → **422 `RESTRICTED_GOODS_REVIEW_REQUIRED`**.
- `POST /api/products/:id/compliance-review` — `{ decision: 'APPROVE' | 'REJECT' }` بصلاحية المراجعة: APPROVE ينشر، REJECT يؤرشف. بلا الصلاحية → **403**.
- `GET /api/products/compliance/queue` — قائمة المنتجات المقيّدة المنتظرة.

## 5. التدقيق

كل قرار يُكتب في `audit_logs` عبر `writeAudit`:
- `PRODUCT.PROHIBITED_REJECTED` (مع `ruleId`/`category`/`reason`)،
- `PRODUCT.RESTRICTED_REVIEW_REQUIRED`،
- `PRODUCT.RESTRICTED_PUBLISH_BLOCKED`،
- `PRODUCT.RESTRICTED_APPROVED` / `PRODUCT.RESTRICTED_REJECTED`.

## 6. الأدلة

**مُشغَّل (بلا DB، بلا Docker):** `npx vitest run --config vitest.lc03.config.ts` → **26/26 ✅**
- `tests/lc03-prohibited-goods-policy.test.ts` (10) — التطبيع ومقاومة التحايل + الأولوية + عدم الإيجاب الكاذب.
- `tests/lc03-enforcement.test.ts` (12) — قرارات الخدمة الحقيقية على `DB` وهمي في الذاكرة: الرفض، المسودّة، منع التفعيل، الاعتماد، الرفض، إعادة التسمية المحظورة، سحب المنشور.
- `tests/lc03-review-authorization.test.ts` (4) — مصفوفة RBAC + حارس المسار + أنّ أي تعريف وكيل AI لا يحمل صلاحية المراجعة.

**مُشغَّل (متكامل — PostgreSQL 16 مؤقتة معزولة):** `TEST_DATABASE_URL=…55433/wasit_test npx vitest run tests/lc03-prohibited-goods.test.ts` → **4/4 ✅**
- رفض المنتج المحظور عبر HTTP (`422 PROHIBITED_GOODS`) دون أي صف في `products`.
- حفظ المنتج المقيّد كمسودّة غير منشورة (`DRAFT`, `isPublished=false`).
- منع نشر المنتج المقيّد عبر تغيير الحالة (`422 RESTRICTED_GOODS_REVIEW_REQUIRED`)، ومنع المراجعة دون صلاحية (`403`).
- نجاح قرار المراجعة البشرية بصلاحية `catalog:compliance:review` (APPROVE → `ACTIVE` منشور).

> **العزل المُثبت:** الحاوية `wasit-lc03-pg` (`postgres:16-alpine`) على منفذ loopback `127.0.0.1:55433` فقط، قاعدة `wasit_test` فارغة، بيانات اصطناعية، بلا اتصال بـ DEMO/production (لا شيء على 5432). بعد التحقق حُذفت الحاوية والصورة والـvolume والـdaemon المؤقت ومجلداته؛ لا موارد متبقّية. **ليس production.**

**TypeScript:** `npm run typecheck` (server + web) نظيف ✅

## 7. ما لم يُغطَّ (حدود صريحة)

- **القائمة أولية وقابلة للضبط، لا شاملة قانونياً.** لا تدّعي تغطية كل تشريع؛ القرارات الحدّية تحتاج مراجعة بشرية/قانونية.
- **لا تكامل مزوّد قوائم عقوبات/KYC** (يبقى تحت LC-05).
- **لا لوحة إدارة لتحرير القواعد** بعد (التحرير حالياً في الكود)؛ المرشّح التالي ربط القواعد بمحرّك السياسات القائم (`policy-engine` scope `CATEGORY`/`RISK`) لتمكين تخصيص لكل بلد.
- **لا فحص لمحتوى الصور** (فقط النصّ؛ بما فيه النصّ البديل للصور).
