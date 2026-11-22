# DEMO-02 — إعادة تشغيل الرابط التجريبي العام (2026-11-22)

> **الحكم**: ✅ يعمل — SPA + API + PostgreSQL تجريبية معزولة على رابط HTTPS عام، مُتحقَّق من
> خادم خارجي (W3C Nu validator) ومن متصفح بهاتف Pixel 7.

## 1. لماذا توقف الرابط السابق

`DEMO-01` كان يشير إلى قاعدة `wasit_demo` داخل حاوية Docker (`wasit-demo-pg`, منفذ 5433)
وإلى اسم نطاق تشغيل قديم. بعد إعادة إنشاء حاوية التشغيل:

- قاعدة `wasit_demo` لم تكن موجودة (الحاوية/الـvolume اختفى؛ المتبقي `pgdata-obs01` بمنفذ
  5434 وقاعدة `wasit_test` فقط) ⇒ كل طلب API يفشل عند أول استعلام.
- اسم النطاق القديم لم يعد يوجّه إلى هذه البيئة، و`vite preview` يرفض أي Host غير مُدرج في
  `allowedHosts` (كان يرد `403 Blocked request. This host ... is not allowed`).

لم يُنشأ مستودع ولا مشروع جديد: أُعيد استخدام نفس البيئة (PostgreSQL 17 المحلي + `vite preview`).

## 2. ما تم تشغيله

| المكوّن | التفاصيل |
| --- | --- |
| Frontend | `vite preview` على `0.0.0.0:12000`، بناء `VITE_DEMO_MODE=true` (لافتة DEMO ظاهرة) |
| Backend | `tsx src/index.ts`، `NODE_ENV=staging`، المنفذ 3000 (داخلي فقط) |
| Proxy | `/api`, `/sitemap.xml`, `/robots.txt` عبر نفس أصل الواجهة ⇒ كوكي الجلسة same-origin |
| Database | PostgreSQL 17 على `127.0.0.1:5434`، قاعدة `wasit_demo` معزولة (migrate + seed + seed-demo) |
| Payments | `PAYMENT_PROVIDER=manual` + `DEMO_PAYMENT_MODE=true` — لا مزوّد حقيقي، لا `SETTLED` |
| AI | `AI_PROVIDER=local-heuristic` — بلا مفتاح خارجي |

الأوامر الفعلية:

```bash
# قاعدة معزولة (لا تلمس wasit_dev/wasit_test)
createdb -h 127.0.0.1 -p 5434 -U wasit wasit_demo
cd packages/server && set -a && . ../../.env.demo && set +a
npx drizzle-kit migrate && npx tsx src/scripts/seed.ts && npx tsx src/scripts/seed-demo.ts

# الخدمات
cd packages/server && set -a && . ../../.env.demo && set +a && nohup npx tsx src/index.ts > /tmp/demo-api.log 2>&1 &
VITE_DEMO_MODE=true npm run build -w @wasit/web
cd packages/web && set -a && . ../../.env.demo && set +a && nohup npx vite preview --port 12000 --host 0.0.0.0 > /tmp/demo-web.log 2>&1 &
```

## 3. تغييرات الكود (فرع `demo/public-url`)

1. **`packages/web/vite.config.ts`** — `allowedHosts` صار يُشتق من `APP_URL` و`CORS_ORIGIN`
   و`WEB_ALLOWED_HOSTS` بدل قائمة نطاقات ثابتة، لأن اسم نطاق التشغيل يتغيّر مع كل حاوية جديدة.
   لا يُضاف أي Host غير مُعلن (يُثبته `tests/preview-hosts.test.ts`).
2. **`AppSidebar`/`AppLayout`** — الشريط الجانبي (240px) كان يُعرض دائماً فيضغط محتوى لوحة
   التحكم على هاتف 412px (عناصر بإحداثيات سالبة). صار **drawer** تحت `lg`: مخفي افتراضياً،
   يُفتح بزر قائمة في `TopHeader` (`aria-controls="app-sidebar"`)، ويُغلق عند اختيار وجهة أو
   تغيير المسار. أُضيفت مفاتيح `nav.openMenu`/`nav.closeMenu` في ar/en/fr/zh.

## 4. تشديد أمان لازم للعرض العام (`.env.demo`، git-ignored)

| المتغيّر | قبل | بعد | السبب |
| --- | --- | --- | --- |
| `DEMO_AUTO_LOGIN` | `true` | `false` | يمنع `POST /api/auth/demo-session` من فتح جلسة بلا بيانات اعتماد (صار `404`) |
| `ALLOW_DEV_TOOLING` | `true` | `false` | كان يُعيد `devResetToken` لأي بريد — بما فيه `admin@wasit.tn` ⇒ استيلاء على حساب إداري |

بقي `DEMO_SKIP_EMAIL_VERIFICATION=true` (بدونه لا يمكن التسجيل لأن `MAIL_TRANSPORT=log`)،
وهو لا يمنح أي صلاحية — يكتفي بوضع `emailVerified` عند التسجيل. `DEMO_PAYMENT_MODE=true`
يبقى محصوراً في مزوّد `manual` (هيكل عرض، لا قناة أموال).

## 5. نتائج الاختبار (كلها على الرابط العام)

- **من خارج البيئة**: `https://validator.w3.org/nu/` جلب `/`, `/pricing`, `/api/health/ready`
  بنجاح (0 io-errors) — دليل طرف ثالث على أن الرابط عام.
- `scripts/ui-redesign-check.mjs`: **54/54** (سطح مكتب، هاتف 390، RTL، marketplace).
- `scripts/ui-mobile-smoke.mjs`: **16/16** (تسجيل دخول من الهاتف، سوق، منتج، طلبات، إشعارات، بحث، لا 5xx).
- `scripts/ui-login-check.mjs`: الحسابات الخمسة (`customer1`, `merchantA`, `supplierA`, `companyA`, `demo`) — كلها PASS.
- أمن: `/api/admin/*` = `401` للمجهول و`403` لـCUSTOMER · تسجيل بدور `SUPER_ADMIN` = `422` ·
  دخول `admin@wasit.tn` بكلمة مرور العرض = `401` · `demo-session` = `404` · `dev/verification-link` = `404`.
- الحزمة العامة خالية من `JWT_SECRET`/`postgresql://`/`DEMO_*_PASSWORD`/`AI_API_KEY`.
- سجل الخادم: 0 `level:"error"`، 0 استجابة `5xx` خلال كل الفحوص.

## 6. الحسابات

| الحساب | الدور |
| --- | --- |
| `customer1@wasit.tn` / `merchantA@wasit.tn` / `supplierA@wasit.tn` / `companyA@wasit.tn` / `demo@wasit.tn` | CUSTOMER / MERCHANT / SUPPLIER / COMPANY / CUSTOMER |

كلمة المرور: `DEMO_ACCOUNT_PASSWORD` في `.env.demo` (0600، غير متعقَّب). الحسابان الإداريان
(`admin@wasit.tn`, `admin2@wasit.tn`) يستخدمان `DEMO_STAFF_PASSWORD` **المختلف**، مع
`STAFF_MFA_ENFORCEMENT=auto`، ولا يُنشر أي منهما.

## 7. القيود

- الرابط مؤقت: يعيش ما دامت عمليات `tsx src/index.ts` و`vite preview` تعمل داخل هذه الحاوية.
  إعادة إنشاء الحاوية تُوقفها وتغيّر اسم النطاق (الحل: أعد الأوامر في §2؛ `allowedHosts` يقرأ
  `APP_URL` الجديد تلقائياً).
- `RATE_LIMIT_STORE=memory` (عدّادات لكل عملية) — يكفي للعرض، ليس للنشر الحقيقي.
- لا مزوّد دفع/بريد/SMS حقيقي: رسائل البريد في السجل، والدفع `manual` فقط.
