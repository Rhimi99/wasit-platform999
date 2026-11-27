# GM-ACCESS-04 — حارس بيئة قاعدة البيانات

> **الحالة**: مُنفَّذ ومُتحقَّق — 2026-11-23
> **القرار**: AD-060 · **الفجوة**: §27 في `docs/GAP_REGISTER.md`
> **الاختبارات**: `packages/server/tests/gm-access-04.test.ts` (18 حالة)
> **Migration**: لا يوجد

---

## 1. المشكلة التي يُغلقها

بعد GM-ACCESS-02 أصبحت `gm:access` قادرة على تغيير كلمة المرور على **أي**
`DATABASE_URL`. وفي جلسة التحقق من GM-ACCESS-03 كان المتغير `DATABASE_URL` في
الصدفة يشير إلى `wasit_test` (بقايا فحص سابق) — أي أن أمرًا واحدًا بالخطأ كان
سيغيّر كلمة مرور حساب على قاعدة **اختبار**، أو — أسوأ — على `wasit_demo` المنشورة
علنًا.

اسم القاعدة وحده ليس دليلًا: من يستطيع تعيين `DATABASE_URL` يستطيع تعيين اسم يوحي
بالإنتاج. الحارس هنا يطلب **إشارة بيئة صريحة** + **تطابقًا مع الخادم نفسه**.

## 2. البوابة (ثلاثة شروط مستقلة)

| # | الشرط | كيف يُتحقَّق |
| --- | --- | --- |
| ١ | النشر يعلن أنه إنتاج | `NODE_ENV=production` (بالضبط، بعد trim وlowercase) |
| ٢ | النشر يسمّي قاعدته الإنتاجية، والخادم يؤكّد الاسم | `WASIT_PRODUCTION_DB_NAME` = `current_database()` |
| ٣ | الاسم ليس محميًا | قائمة + أنماط، تُفحص **بعد** التطابق فلا يُشرّع `wasit_demo` نفسه |

إضافة اختيارية: `WASIT_PRODUCTION_DB_HOST` — إن ضُبط، وجب أن يطابق المضيف الذي
يبلّغ عنه الخادم (`host(inet_server_addr())`، بلا netmask).

`NODE_ENV=production` وحدها لا تكفي، والاسم وحده لا يكفي: الشرطان معًا لازمان.

### 2.1 الأسماء المحمية (تُرفض دائمًا)

`postgres` · `template0` · `template1` · `templateN` · `wasit_dev` ·
`wasit_staging` · `wasit_test` · `wasit_demo` · أي اسم ينتهي بـ
`_test`/`_demo`/`_dev`/`_staging` · أي اسم يبدأ بـ `_restore`/`_drill`.

### 2.2 جدول الرفض

| الحالة | الرمز | النتيجة |
| --- | --- | --- |
| `NODE_ENV` غير `production` | `NOT_PRODUCTION_ENV` | رفض |
| لا `WASIT_PRODUCTION_DB_NAME` | `PRODUCTION_NAME_UNDECLARED` | رفض |
| القاعدة `wasit_test`/`wasit_demo`/`postgres`… | `PROTECTED_DATABASE` | رفض (حتى لو أُعلنت إنتاجًا) |
| الإعلان ≠ ما يبلّغ عنه الخادم | `DATABASE_MISMATCH` | رفض |
| المضيف المثبَّت ≠ الخادم | `HOST_MISMATCH` | رفض |
| إنتاج + اسم مطابق + غير محمي | — | **سماح** |

الرفض يحدث **قبل** البحث عن الحساب: لا صفّ تدقيق، لا تحديث، لا جلسة تُبطل، ولا
حتى قراءة ملف كلمة المرور. رمز الخروج `2`.

## 3. ما يُحرس وما لا

| الأمر | محروس؟ | لماذا |
| --- | --- | --- |
| `set-password` | ✅ | يغيّر دليل الثقة |
| `reset-factor` | ✅ | يحذف عاملًا ثانيًا |
| `status` | ❌ | قراءة فقط — يجب أن يعمل على أي بيئة للتشخيص |
| `issue` | ❌ | يُصدر تذكرة تُشبع بوابة البريد لحساب واحد؛ خارج نطاق التعليمات — انظر §7 |

## 4. تشغيل الاستعادة على مضيف الإنتاج

> لا تُنفَّذ من بيئة تطوير. كل خطوة تحتاج موافقة المالك.

### 4.1 إعلان الإنتاج على الخادم (مرة واحدة)

في بيئة الخادم الإنتاجي (ملف `.env` غير متعقّب، أو secret store):

```env
NODE_ENV=production
DATABASE_URL=<سلسلة الإنتاج — لا تُطبع ولا تُنسخ إلى المحادثة>
WASIT_PRODUCTION_DB_NAME=wasit_prod
# اختياري لكن مُوصى به: يثبّت المضيف المتوقّع
WASIT_PRODUCTION_DB_HOST=<مضيف القاعدة>
```

`lib/env.ts` يرفض الإقلاع في `production` إن كان `JWT_SECRET` هو الافتراضي، أو إن
كان `ALLOW_DEV_TOOLING`/`DEMO_PAYMENT_MODE` مُفعّلًا — أي أن الخادم لا يستطيع أصلًا
تشغيل أمر حساس في بيئة «إنتاج» مزيّفة.

### 4.2 فحوص ما قبل الكتابة (قراءة فقط)

```bash
cd packages/server
npm run gm:access -- status --email <بريد المدير العام>   # غير محروس، لا يكتب
```

ثم بالـSQL:

```sql
select current_database(), host(inet_server_addr()), inet_server_port(), current_user;

select u.id, u.email, u.is_active, u.email_verified, u.mfa_enabled
from users u
  join user_roles ur on ur.user_id = u.id
  join roles r on r.id = ur.role_id
where lower(u.email) = lower($1) and r.name = 'SUPER_ADMIN';

select count(*) from sessions
where user_id = $2 and revoked_at is null and expires_at > now();
```

يجب أن يظهر: اسم القاعدة المُعلَن، وحساب `SUPER_ADMIN` **واحد**، وعدد الجلسات
الحيّة (هذا الرقم سيُبطل).

### 4.3 التنفيذ

```bash
cd packages/server
npm run gm:access -- set-password --email <البريد> \
  --reason "GM-ACCESS-03: rotation requested by the platform owner" \
  --password-file <مسار الملف 0600> --confirm
```

المخرجات المتوقّعة: سطر `target: database "..." on ... as ... (declared production)`،
ثم `Password replaced`، ثم `password: ... not displayed here`.

### 4.4 بعد التنفيذ

1. تحقّق أن `password_hash` تحدّث (`$argon2…`) وأن الجلسات القديمة `revoked_at` غير فارغ.
2. جرّب الدخول بكلمة المرور الجديدة **بلا طباعتها** (سكربت يقرأ الملف ويرسل الطلب).
3. تحقّق أن MFA ما زال مطلوبًا (`mfaRequired: true` + تحدٍّ).
4. ابحث في `audit_logs` عن `GM_ACCESS.PASSWORD_RESET` وتأكّد أنه لا يحوي السر ولا الهاش.
5. انقل كلمة المرور إلى مدير كلمات المرور، ثم `shred -u <path>`.

## 5. الإثبات

| المجموعة | العدد |
| --- | --- |
| الأسماء المحمية (تمثيلاتها وحالاتها الحدّية) | 2 |
| رفض: بلا `production` · بلا إعلان اسم · `wasit_test`/`wasit_demo`/`postgres` معلنة · تعارض الاسم · تعارض المضيف · لا سرّ في الرسالة | 6 |
| قبول: إنتاج مطابق · اسم مختلف معلن · مضيف مثبَّت · حالة الأحرف | 4 |
| قراءة الهوية من الخادم + وصف بلا أسرار | 2 |
| **CLI الحقيقي** (عمليّة فرعية): رفض `wasit_test` رغم `NODE_ENV=production` · رفض بلا إعلان · رفض في `development` · `status` غير محروس | 4 |

المجموع **18/18**. الرفض عبر الـCLI يُثبت أن الحارس مربوط فعلًا في `main()`، لا
دالّة معزولة: لو حُذف نداء الحارس لنجح الأمر ووصل إلى «No account with that address».

**حدود الإثبات:** لا توجد قاعدة إنتاج في بيئة التطوير، لذلك **لم** يُنفَّذ قبول عبر
الـCLI؛ القبول مُثبت على دالّة القرار (بما فيها اسم إنتاج مختلف ومضيف مثبَّت). ولم
تُنفَّذ أي كتابة على أي قاعدة في هذا العمل.

## 6. ما لم يتغيّر

- لا مسار HTTP جديد، لا صلاحية جديدة، لا Migration.
- `set-password`/`reset-factor` لم يتغيّرا بعد البوابة (نفس النطاق، نفس التدقيق، نفس إبطال الجلسات).
- `wasit_demo`/`wasit_test`/`wasit_prod` لم تُمسّ. `master` لم يُمسّ.

## 7. قرارات معلّقة

1. هل يُحرس `issue` أيضًا؟ (يُشبع بوابة البريد لحساب واحد، ولا يغيّر دليلًا.)
2. هل يُضاف `--expected-db <name>` كتأكيد إضافي مكتوب في الأمر نفسه؟
3. هل يُرسَل تنبيه خارجي عند كل رفض للحارس؟
