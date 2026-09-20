# TESTING STRATEGY — WASIT BUSINESS GLOBAL

## المبدأ

كل وظيفة (UI → API → Backend → DB) لها اختبار. لا نختبر فقط استجابة HTTP؛ نتحقق من **التأثيرات الجانبية** (Ledger, Audit, Inventory).

## الطبقات

### 1. Unit Tests (قادمة)
- دوال Services خالصة: حساب العمولة، صياغة slug، تحويل الأسعار، منطق Trust.
- دوال Validation.

### 2. Integration Tests (موجودة حالياً)
- `tests/vertical-slice.test.ts` — مسار E2E كامل عبر `app.fetch` ضد `wasit_test`.
- `tests/admin-access.test.ts` — صلاحية ADMIN.
- `tests/setup.ts` — drop/create قاعدة اختبار + migrations + seed تلقائياً.

### 3. API Tests
- مغطاة ضمن integration (كل call عبر `app.request` الحقيقي للـ router).

### 4. Permission Tests
- `CUSTOMER cannot create supplier/merchant/company` → 403.
- `CUSTOMER cannot access admin` → 403.
- `ADMIN can access admin` → 200.
- بدون مصادقة → 401.

### 5. Database Tests
- التحقق من كتابة Ledger (3 entries: TRANSACTION_VALUE/COMMISSION/PAYMENT_FEE).
- التحقق من Audit Logs بعد إنشاء الطلب.
- تأكيد حالة المعاملة `PAID`.

### 6. E2E (Playwright — مُنفّذ)
- `e2e/` — 10 ملفات spec، 54 اختباراً، ضد server + PostgreSQL + Vite حقيقيين (`npm run test:e2e`، لا Mocks ولا route interception).
- `global-setup.ts` يشغّل الـ seeder idempotent ثم يبني `storageState` لكل دور عبر login حقيقي (يتفادى rate-limit تسجيل الدخول). `storageFor(role)` في `helpers.ts`.
- يغطي: Auth/recuperation، Marketplace→Order→Commission (قيمة السيرفر 4% = 2% بائع + 2% مشتري)، RBAC (منع CUSTOMER من admin/inventory، رفض 401 لغير المصادق، سماح ADMIN)، Inventory side-effects، Ledger (قيد العمولة)، Audit (`ORDER.CREATE`)، Advertising (إنشاء حملة + 403 لغير المخوّل)، Disputes، Payments (intent/webhook/refund)، الدفع النقدي، سياسات الدول، مكتبة العميل، وSEO (`seo.spec.ts`: sitemap/robots عبر أصل الويب، JSON-LD، canonical على صفحات المنتج/التصنيف/التجّار/الشركات).
- `auth.spec.ts` يمارس نموذج الدخول نفسه بشكل مقصود؛ بقية الاختبارات تستخدم جلسات مخزّنة.
- `mfa.spec.ts` (C4) يقود دورة MFA كاملة عبر الواجهة: التسجيل→توثيق البريد→تفعيل 2FA في صفحة الأمان→الدخول يطالب بالعامل الثاني→التحقق→إعادة توليد أكواد الاسترداد→التعطيل؛ وحالة ثانية تُثبت رفض رمز خاطئ دون منح جلسة (`GET /api/auth/me` = 401). رمز TOTP يُجلب من `POST /api/auth/mfa/dev-totp` (server-side، RFC 6238 نفسه المستخدَم في التحقق) — لا secret مزيّف.

## تغطية حالية (418 اختبار وحدة/تكامل + 54 E2E)

| الطبقة | التغطية |
| --- | --- |
| Unit/Integration (vitest) | 418 اختباراً في 41 ملفاً — تشمل Vertical Slice، RBAC، Commission/Payment Fee Policies، Money، Trust، Risk، Revenue scenarios، Geo، Country Activation، Customer Library، SEO، MFA login challenge، إلخ. |
| E2E (Playwright) | 54 اختباراً في 10 ملفات — Auth/Recovery، MFA (C4)، Marketplace→Order→Commission، RBAC، Inventory، Ledger، Audit، Advertising، Disputes، Payments، Country Policies، Customer Library، SEO. |

## كيفية التشغيل

```bash
# الوحدة والتكامل (يبني wasit_test تلقائياً)
npm test

# E2E (يشغّل server + web تلقائياً ضد wasit_dev)
npm run test:e2e

# التحقق من الأنواع
npm run typecheck -w @wasit/server
npm run typecheck -w @wasit/web
```

## معايير القبول

- `npm test` أخضر.
- `npm run test:e2e` أخضر وقابل للإعادة دون تراكم بيانات.
- `npm run typecheck` بلا أخطاء (server + web).
- كل وظيفة جديدة: أضف اختباراً يغطي مسار السعادة + مسار الخطأ + مسار الصلاحيات.
- لا Mocks للـ database/network في الاختبارات الأساسية؛ اختبر الكود الحقيقي.