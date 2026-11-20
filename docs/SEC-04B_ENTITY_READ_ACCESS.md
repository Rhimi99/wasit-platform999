# SEC-04B — ENTITY PUBLIC/PRIVATE DATA PROTECTION

تاريخ: 2026-11-05 · الحالة: **COMPLETED — 12/12 tests passed** (PostgreSQL 16 معزول) · لا Commit/Push

مرجع التحليل: تقرير SEC-04A (تدقيق قراءة فقط) + سياسة الوصول المُقرّة إدارياً.

---

## 1. ملخّص

كانت مسارات قراءة الكيانات (`GET /api/{suppliers,merchants,companies}` و`/:id`) **بلا أي حارس**، وخدماتها
تستخدم `db.select()` كاملاً، فتُرجع كل أعمدة الصف: `userId` (المالك)، `isActive`، الطوابع الزمنية، و`contacts`
(بريد/هاتف شخص الاتصال)، و`taxId`/`registrationNumber` للشركات — لكل زائر بلا تسجيل، وأيضاً للكيانات **غير النشطة**.

نفّذ SEC-04B الحماية على أربعة محاور دون إنشاء أي صلاحية جديدة ودون توسيع أي دور:

| المحور | القبل | البعد |
| --- | --- | --- |
| **A. الإسقاط العام** | `select()` كامل الصف | إسقاط صريح موحّد (`*_PUBLIC_FIELDS`) يستبعد `userId/isActive/createdAt/updatedAt` |
| **B. البيانات الخاصة** | `contacts` عامة دائماً | `contacts` للمالك/الموظف فقط · `taxId/registrationNumber` للمالك/الموظف فقط |
| **C. الكيانات غير النشطة** | `/:id` يُرجع غير النشط للجميع | 404 للزوار وغير المالك؛ 200 للمالك/الموظف |
| **D. الدليل** | `contactEmail/contactPhone` لكل من يملك `*_list` | تُحجب عن غير الموظف (PII) |

**مبدأ الحماية:** التمييز بين «عام» و«خاص» يُبنى على **الملكية** (`userId`) + **صلاحية موظف موجودة** (`user:read`)
— لا على إنشاء صلاحيات أو endpoints جديدة.

---

## 2. الفجوات المُعالَجة (مطابقة لتقرير SEC-04A)

| # | Endpoint | خطورة SEC-04A | الإصلاح |
| --- | --- | --- | --- |
| G1 | `GET /api/suppliers` | MEDIUM | إسقاط عام (يزيل `userId`/الطوابع) |
| G2 | `GET /api/suppliers/:id` | HIGH (PII اتصال) | إسقاط عام + `contacts` للمالك/الموظف فقط + 404 لغير النشط |
| G3 | `GET /api/merchants` | MEDIUM | إسقاط عام |
| G4 | `GET /api/merchants/:id` | MEDIUM | إسقاط عام + 404 لغير النشط |
| G5 | `GET /api/companies` | HIGH (تعداد معرّفات) | إسقاط عام (يزيل `taxId`/`registrationNumber`) |
| G6 | `GET /api/companies/:id` | CRITICAL (معرّف ضريبي/قانوني عام) | إسقاط عام + المعرّفات للمالك/الموظف فقط + 404 لغير النشط |
| G7 | `GET /api/directory/suppliers` | MEDIUM (PII) | حجب `contactEmail/contactPhone` عن غير الموظف |

---

## 3. القرارات التصميمية

### 3.1 الإسقاط العام (A)
لكل كيان مُسقِط صريح `*_PUBLIC_FIELDS` (نفس نمط `search/service.ts` الموجود):

- `SUPPLIER_PUBLIC_FIELDS`: `id, companyName, slug, countryId, cityId, description, logoUrl, verified`
- `MERCHANT_PUBLIC_FIELDS`: `id, storeName, slug, countryId, cityId, description, logoUrl, verified`
- `COMPANY_PUBLIC_FIELDS`: `id, legalName, slug, countryId, cityId, industry, description, logoUrl, verified`

القوائم تستخدم الإسقاط العام مباشرة. مسار `/:id` يختار صفّاً أوسع (`*_ROW_FIELDS` = العام + `userId/isActive` [+
المعرّفات القانونية للشركات]) **لأغراض التفويض فقط**، ثم تُجرَّد الأعمدة غير العامة عبر دالة `toPublic*` قبل الإرجاع.

> **ملاحظة:** `isActive` يبقى **داخلياً** (لا يُعاد أبداً) لكنه مقروء لحسم 404/200؛ الكيانات النشطة فقط تُدرج في
> القوائم (`where isActive = true`) أصلاً.

### 3.2 بوابة البيانات الخاصة (B) — بلا صلاحيات جديدة
`packages/server/src/lib/entity-access.ts`:

- `ENTITY_PRIVATE_READ_PERMISSION = PERMISSIONS.USER_READ` (`user:read`).
- `isEntityStaff(viewer)` = `userHasAnyRole(roles, USER_READ)`.

**لماذا `user:read` تحديداً؟** إنها الصلاحية **الموجودة** الوحيدة التي تُمنح لأدوار الموظفين
(SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN) و**لا** تُمنح لأي دور بائع (البائعون يملكون `user:read:own` فقط).
فتفصل الموظف عن المالك دون اختراع صلاحية ودون منح ADMIN أي صلاحية جديدة. (PERM-01C §2.4 صنّف `user:read` كمُمنوحة
للموظفين المتخصصين بلا مسار قابل للوصول بسبب الحارس العام؛ SEC-04B يمنحها الآن مساراً فعلياً للقراءة الخاصة بالكيانات —
دون تغيير المصفوفة.)

### 3.3 لا endpoint جديد للاتصالات
لم يُنشأ مسار `/:id/contacts`. جهة الاتصال تُعاد **ضمن** استجابة `/:id` للمالك/الموظف فقط (شكل الاستجابة لم يتغيّر
لمن كان يملك حقّه)، ولا يوجد مستهلك (ويب/E2E) يقرأ `contacts` أصلاً (تحقّق SEC-04A §11)، فلا حاجة لمسار منفصل.

### 3.4 الكيانات غير النشطة (C)
`getX(db, id, viewer)`: إن كان الصف `isActive = false` وليس المستدعي هو المالك ولا موظفاً → `404` (نفس رسالة
«غير موجود»)، فلا يُكشف **وجود** السجل غير النشط. المالك والموظف يريانه (200).

### 3.5 الدليل (D)
`listSupplierDirectory(db, query, { includeContacts })`: تُختار حقول الاتصال (استعلام واحد ثابت) ثم تُجرَّد لغير
الموظف قبل الإرجاع — فلا تُسلسَل أبداً لمن لا يملكها. المسار يمرّر `includeContacts: isEntityStaff(...)`.
`DirectorySupplierRow.contactEmail/contactPhone` صارت اختيارية في الخادم والويب.

---

## 4. الملفات المعدّلة والجديدة

### معدّلة (9)
| الملف | التغيير |
| --- | --- |
| `packages/server/src/modules/suppliers/service.ts` | إسقاط عام + `getSupplier(viewer)` + contacts للمالك/الموظف + 404 |
| `packages/server/src/modules/suppliers/routes.ts` | `optionalAuth` على GET؛ تمرير viewer |
| `packages/server/src/modules/merchants/service.ts` | إسقاط عام + `getMerchant(viewer)` + 404 |
| `packages/server/src/modules/merchants/routes.ts` | `optionalAuth` على GET؛ تمرير viewer |
| `packages/server/src/modules/companies/service.ts` | إسقاط عام + `getCompany(viewer)` + معرّفات قانونية للمالك/الموظف + 404 |
| `packages/server/src/modules/companies/routes.ts` | `optionalAuth` على GET؛ تمرير viewer |
| `packages/server/src/modules/directory/service.ts` | بوابة `includeContacts` على PII |
| `packages/server/src/modules/directory/routes.ts` | تمرير `includeContacts` من `isEntityStaff` |
| `packages/web/src/lib/types.ts` | `DirectorySupplierRow.contactEmail/contactPhone` اختيارية |

### جديدة (2)
| الملف | الغرض |
| --- | --- |
| `packages/server/src/lib/entity-access.ts` | `EntityViewer` + `isEntityStaff` + `ENTITY_PRIVATE_READ_PERMISSION` |
| `packages/server/tests/sec04b-entity-read-access.test.ts` | 12 حالة تكامل (مصفوفة الأدوار كاملة) |

> لم تُمسّ أي صلاحية أو مصفوفة أدوار أو نموذج عمولة أو وساطة. لم يُغيَّر أي مسار كتابة/إنشاء/تحديث (خارج نطاق SEC-04).

---

## 5. مصفوفة الوصول الناتجة (المرجع)

| السطح | زائر | CUSTOMER | MERCHANT | SUPPLIER | COMPANY | SUPPORT/RISK/DISPUTE | ADMIN | SUPER_ADMIN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/suppliers` (قائمة) | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام |
| `GET /api/suppliers/:id` (عام) | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام | 200 عام |
| `GET /api/suppliers/:id` (contacts) | — | — | — | المالك ✓ | — | ✓ | ✓ | ✓ |
| `GET /api/companies/:id` (taxId/RN) | — | — | — | — | المالك ✓ | ✓ | ✓ | ✓ |
| كيان غير نشط (`/:id`) | 404 | 404 | 404 | المالك 200 | 404 | 200 | 200 | 200 |
| `GET /api/directory/suppliers` (PII) | 401 | بلا PII | بلا PII | بلا PII | بلا PII | PII ✓ | PII ✓ | PII ✓ |

«عام» = الإسقاط العام فقط. «المالك ✓» = يستقبل بياناته الخاصة. الأدوار RISK/DISPUTE تتصرف كـSUPPORT (تملك `user:read`).

---

## 6. الاختبارات

### 6.1 مُنفَّذة الآن (لا تحتاج DB) — ثوابت أمنية ساكنة
شُغّلت فعلياً عبر `tsx` على الكود الفعلي؛ **كلها PASSED** (39 فحصاً): إسقاط الحقول العامة (استبعاد
`userId/isActive/createdAt/updatedAt`)، استبعاد `taxId/registrationNumber`، بقاء حقول السوق/البحث/SEO، منح
`user:read` للموظفين وحجبه عن البائعين، `optionalAuth` على كل مسارات GET الستة، استخدام الإسقاط العام في القوائم
(لا `select()` عارٍ)، وبوابة `includeContacts` في الدليل.

### 6.2 مُنفَّذة فعلياً (PostgreSQL 16 معزول) — `sec04b-entity-read-access.test.ts`
**12 حالة ناجحة · 0 فاشلة · 0 متخطاة.** تغطي مصفوفة الأدوار العشرة، IDOR، الكيانات غير النشطة، البيانات
الخاصة (contacts/المعرّفات القانونية)، PII الدليل، والتوافق (search + JSON-LD).

**الأمر الفعلي المعتمد:** `npx vitest run tests/sec04b-entity-read-access.test.ts` (من `packages/server`).

**تفصيل أول تشغيل:** 10 ناجحة / 2 فاشلة — والسبب **عيب في دالة مساعدة داخل الاختبار نفسه** (`expectPublicProjection`
كانت تفرض «لا حقل خارج الإسقاط العام» على ردّي المالك/الموظف اللذين يحتويان `contacts` عن حق). أُصلح الاختبار
(وسيط `extraAllowed`) **بلا أي تغيير في الكود المُختبَر**، فصار التشغيل الثاني **12/12**.

### 6.3 نتيجة التحقق الفعلي (2026-11-05) — لم يبقَ عائق
- **البيئة:** PostgreSQL 16 في حاوية مؤقتة معزولة `wasit-sec04b-pg` (قاعدة `wasit_test` فارغة، بلا أي ربط بمجلد
  بيانات أو قاعدة موجودة، على المنفذ 5432 الذي كان حراً).
- **النتيجة:** **12 ناجحة · 0 فاشلة · 0 متخطاة.**
- **TypeScript:** ✅ نظيف (`tsc --noEmit` لـserver، ويشمل `tests/**`).
- **البناء:** لم يُعَد تشغيله بعد تعديل ملف الاختبار؛ **آخر بناء سابق ظلّ صالحاً** لأن التغيير الوحيد اللاحق كان في
  `packages/server/tests/sec04b-entity-read-access.test.ts` وهو خارج `tsconfig.build.json` ⇒ لا تأثير على مخرجات البناء.
- **التنظيف:** حُذفت الحاوية المؤقتة (`docker stop` + `docker rm`)، وأُوقف Docker الذي شُغّل مؤقتاً بإذن ⇒ أُعيدت
  البيئة لحالتها السابقة (لا حاويات، daemon متوقف، المنفذ 5432 حر).

**أمر إعادة التحقق** (عند الحاجة مستقبلاً؛ يتطلب PostgreSQL متاحاً):
```bash
docker run -d --name wasit-pg -e POSTGRES_USER=wasit -e POSTGRES_PASSWORD=wasit_dev_password \
  -e POSTGRES_DB=wasit_test -p 5432:5432 postgres:16
cd packages/server && npx vitest run tests/sec04b-entity-read-access.test.ts
```

---

## 7. معايير الإغلاق — الحالة

| المعيار | الحالة |
| --- | --- |
| تنفيذ الإصلاحات | ✅ (9 معدّلة + 2 جديدة) |
| اجتياز الاختبارات المستهدفة فعلياً | ✅ **12/12** (PostgreSQL 16 معزول؛ 0 فاشلة، 0 متخطاة) |
| TypeScript نظيف (server + web) | ✅ `tsc --noEmit` (يشمل `tests/**`) |
| التحقق من البناء | ✅ آخر بناء نظيف؛ لم يُعَد بعد تعديل الاختبار لأن التغيير في ملف الاختبار فقط (خارج `tsconfig.build.json`) |
| توثيق النتائج | ✅ هذا الملف |
| مراجعة diff كامل | ✅ (معروض في التقرير) |
| قائمة الملفات المعدّلة/الجديدة | ✅ §4 |
| فصل المُنفَّذ الآن عن الأدلة التاريخية | ✅ §6 |

---

## 8. التوافق (عدم كسر الواجهات)

- صفحات السوق العامة (`/suppliers`, `/merchants`, `/companies`) تعرض: الاسم، `description`، `verified`،
  `industry` (للشركات)، `logoUrl` — **كلها ضمن الإسقاط العام** ⇒ لا كسر.
- **لا مستهلك** (ويب أو E2E) يقرأ `contacts`/`taxId`/`registrationNumber`/`userId`/الطوابع الزمنية (تحقّق SEC-04A §11).
- `/api/search` وJSON-LD يعملان أصلاً على الحقول العامة ⇒ لا تأثير (حالة توافق في الاختبار).
- `directorySuppliers` في الويب تعرض عمود `contactEmail` → صار يعرض `—` للبائع (مقبول: PII لم تكن مخصصة له).

## 9. مخاطر متبقية / قرارات مطلوبة

- **واجهة الدليل:** عمود البريد في `/dashboard/*` يُظهر `—` لغير الموظف. إن رُغب بإظهاره للبائع (لأنه يخصّ مورّده)
  فيلزم قرار إداري + صلاحية أدق (خارج نطاق SEC-04B).
- **مستهلك API خارجي** يعتمد على الصف الكامل — إن وُجد، فهو تغيير كاسر (يحتاج قراراً).
- **قانونية `taxId/registrationNumber`** علناً — قرار قانوني/إداري (SEC-04A §12).
