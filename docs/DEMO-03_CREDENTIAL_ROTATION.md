# DEMO-SEC-03 — تدوير اعتماد الحسابات التجريبية وإبطال الجلسات

> **الحكم**: ✅ نُفِّذ ومُتحقَّق منه على الرابط العام. لا كلمة مرور ولا Token في هذا الملف،
> ولا في Git، ولا في سجلات التشغيل.

## 1. المشكلة

العرض العام ينشر قائمة حساباته، فالحماية الوحيدة هي كلمة المرور. كانت الحسابات الخمسة
(`customer1`, `supplierA`, `merchantA`, `companyA`, `demo`) تتشارك كلمة مرور واحدة، والحسابان
الإداريان (`admin@`, `admin2@`) يتشاركان قيمة أخرى ثابتة. أي كلمة مرور مسرَّبة تفتح أكثر من
حساب، والتدوير لم يكن قابلاً للتكرار بأمان.

## 2. الحل

1. **كلمة مرور فريدة لكل حساب** (24 حرفاً `base64url` ≈ 144 بت) تُولَّد من `randomBytes`.
2. **إبطال كل الجلسات** للحسابات المدوَّرة في نفس العملية (`sessions.revoked_at`)، مع إغلاق
   رموز إعادة تعيين كلمة المرور (`password_reset_tokens.used_at`) وتحديات MFA
   (`mfa_challenges.consumed_at`) لأنها كانت صادرة لكلمة المرور القديمة.
3. **حفظ الأسرار محلياً**: `.env.demo.secrets` بصلاحية `0600`، وهو مغطّى أصلاً بـ`.gitignore`
   (`.env.demo.*`). ويُحدَّث `.env.demo` (0600، غير متعقَّب) بالمفاتيح نفسها كي يعيد
   `seed-demo` إنتاج الحالة المدوَّرة بدل إعادة كلمة المرور القديمة.
4. **سجل تدقيق** `AUTH.DEMO_CREDENTIAL_ROTATED` لكل حساب (`actorType: SYSTEM`, `actorId: null`)
   مع عدد الجلسات المُبطلة — الحذف/التدوير لا يمسّ سجلات التدقيق.
5. **لا Migration ولا تغيير RBAC**: العملية كلها `UPDATE` على أعمدة موجودة.

## 3. التشغيل

```bash
cd packages/server
set -a && . ../../.env.demo && set +a
npx tsx src/scripts/rotate-demo-credentials.ts --include-staff \
  --env-file ../../.env.demo --out ../../.env.demo.secrets
```

- `--dry-run` يطبع ما سيحدث دون كتابة.
- إعادة التشغيل آمنة: تُولَّد أسرار جديدة وتُبطَل الجلسات السابقة.
- **بعد أي `seed-demo`**: شغّل `.env.demo` كاملاً (فيه المفاتيح لكل حساب)، فلا حاجة لإعادة
  التدوير؛ وإن شُغِّل الـseeder بلا المفاتيح فستُعاد كلمة المرور المنشورة للنمط التطويري —
  أعد التدوير حينها.

## 4. توزيع المفاتيح

| الحساب | المفتاح |
| --- | --- |
| `customer1@wasit.tn` | `DEMO_ACCOUNT_PASSWORD_CUSTOMER1` |
| `supplierA@wasit.tn` | `DEMO_ACCOUNT_PASSWORD_SUPPLIERA` |
| `merchantA@wasit.tn` | `DEMO_ACCOUNT_PASSWORD_MERCHANTA` |
| `companyA@wasit.tn` | `DEMO_ACCOUNT_PASSWORD_COMPANYA` |
| `demo@wasit.tn` | `DEMO_ACCOUNT_PASSWORD_DEMO` |
| `admin@wasit.tn` | `DEMO_STAFF_PASSWORD_ADMIN` |
| `admin2@wasit.tn` | `DEMO_STAFF_PASSWORD_ADMIN2` |

المنطق في `src/lib/demo-credentials.ts` (دالة نقية، مُختبرة في `tests/demo-credentials.test.ts`)،
ويستخدمه الـseeder وسكربت التدوير معاً حتى لا ينفصلا.

## 5. إثبات التنفيذ (على الرابط العام)

| الفحص | النتيجة |
| --- | --- |
| كلمة المرور القديمة المشتركة (5 حسابات) | `401` لكل حساب |
| كلمة المرور المنشورة `Passw0rd!2026` | `401` |
| كلمة مرور الـstaff القديمة | `401` |
| كوكيز الجلسات الملتقطة قبل التدوير (5) | `401` على `/api/auth/me` |
| الجلسات المُبطلة | 11 جلسة (3+2+2+2+2) |
| تسجيل الدخول بالأسرار الجديدة | `200` لكل حساب مع الدور الصحيح |
| كلمة مرور حساب على حساب آخر | `401` |
| `CUSTOMER/MERCHANT/SUPPLIER/COMPANY` على `/api/admin/{stats,users,audit-logs}` | `403` (12/12) |
| `ADMIN/SUPER_ADMIN` على نفس المسارات | `200` |
| الأدوار التجارية على `/api/ai/recent` | `403` |
| سجلات التدقيق `AUTH.DEMO_CREDENTIAL_ROTATED` | 7 |
| إعادة تشغيل `seed-demo` ثم الدخول بالأسرار المدوَّرة | `200` (الحالة قابلة للتكرار) |

## 6. ما لم يتغيّر

- الرابط التجريبي بقي يعمل طوال العملية (لم يُوقف).
- `DEMO_AUTO_LOGIN=false` و`ALLOW_DEV_TOOLING=false` كما هي من DEMO-02.
- الحسابان الإداريان لا يُنشر أي منهما، و`STAFF_MFA_ENFORCEMENT=auto` لم يُخفَّض.
