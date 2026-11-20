# DEMO-01 — PUBLIC DEMO (رابط تجريبي عام)

> **التاريخ**: 2026-11-06 · **النطاق**: نسخة تجريبية عامة قابلة للاستخدام من الهاتف.
> **الحكم**: ✅ **يعمل** — Frontend + Backend + PostgreSQL تجريبية معزولة على رابط HTTPS عام.
> **لا علاقة له بأي بيئة إنتاج.** لا مزوّد دفع حقيقي، لا بيانات حقيقية، لا Migration على قاعدة غير تجريبية.

---

## 1. الرابط والحالة

| البند | القيمة |
| --- | --- |
| Public URL | `https://work-1-wqozutzaflweunqz.prod-runtime.all-hands.dev` |
| Frontend | Vite production build عبر `vite preview`، المنفذ 12000 |
| Backend | Hono، `NODE_ENV=staging`، المنفذ 3000 |
| Database | PostgreSQL 16 معزولة: حاوية `wasit-demo-pg`، منفذ `127.0.0.1:5433`، قاعدة `wasit_demo` |
| Proxy | نفس الأصل: `/api` يمرّ عبر أصل الواجهة (كما في dev/prod) — لا CORS متقاطع |
| Payments | `PAYMENT_PROVIDER=manual` — مكتب offline، **بلا أي نداء مزوّد حقيقي** |
| AI | `AI_PROVIDER=local-heuristic` — محلي حتمي بلا مفتاح |
| الأسرار | `.env.demo` (git-ignored)، أسرار عشوائية لكل تشغيل |

**منافذ API المنشورة:** لا شيء. الـAPI يُخدَم فقط عبر وكيل الواجهة (same-origin)؛ قاعدة البيانات ليست منشورة إلا على `127.0.0.1:5433`.

---

## 2. الحسابات التجريبية

كلمة المرور المنشورة (لحسابات العرض الأربعة فقط): `Passw0rd!2026`.

| الحساب | الدور | كلمة المرور |
| --- | --- | --- |
| `customer1@wasit.tn` | CUSTOMER | `Passw0rd!2026` |
| `merchantA@wasit.tn` | MERCHANT | `Passw0rd!2026` |
| `supplierA@wasit.tn` | SUPPLIER | `Passw0rd!2026` |
| `companyA@wasit.tn` | COMPANY | `Passw0rd!2026` |
| `rhimiimed18@gmail.com` | CUSTOMER (حساب العرض الرسمي) | `Passw0rd!2026` |

**حسابات الإدارة** (`admin@wasit.tn` SUPER_ADMIN، `admin2@wasit.tn` ADMIN): كلمة مرور **منفصلة وعشوائية**، غير منشورة، ولا تفتحها كلمة المرور المنشورة (`401`). تُقرأ من `/tmp/demo_staff_pw.txt` (mode 0600) أو `DEMO_STAFF_PASSWORD` في `.env.demo`، وتُسلَّم عبر قناة آمنة فقط.

**مسارات دخول تجريبي:** `POST /api/auth/demo-session` (يفتح حساب العرض الرسمي)، و`POST /api/auth/demo-audit-session` بـ`{"persona":"merchant|supplier|company|customer"}`. كلاهما محصور بـ`DEMO_AUTO_LOGIN=true` (404 في الإنتاج).

---

## 3. الأمان المطبّق (مُتحقَّق)

- كلمة المرور المنشورة **لا** تفتح أي حساب إداري (`401`)، وكلمة مرور الإدارة **لا** تفتح حسابات العرض.
- CUSTOMER/MERCHANT/SUPPLIER/COMPANY وanonymous: `401/403` على كل مسارات `/api/admin/*` (34 فحص أمني ناجح).
- CORS: طلب من أصل أجنبي لا يحصل على `Access-Control-Allow-Origin`؛ preflight لأصل المنصة `204`.
- Bundle عام نظيف من الأسرار/علامات الإنتاج (`JWT_SECRET`, `DATABASE_URL`, `postgresql://`, مزوّدو الدفع…).
- لافتة DEMO ظاهرة (وضع العرض التجريبي — بيانات وهمية، لا مدفوعات حقيقية).
- `.env.demo` غير مُتتبَّع في Git؛ الأسرار عشوائية ولا تُكتب في الكود أو السجل.

---

## 4. سلامة المال (مُتحقَّق)

- إنشاء نية دفع → `provider: "manual"`, `status: "PENDING"`, `checkoutUrl: null` (لا مزوّد).
- `POST /api/admin/finance/manual-completions` متاح **فقط** في وضع العرض (`demoMode: true`) → الطلب `paymentStatus=PAID`.
- **لا `SETTLED`** في `transaction_ledger` (كل الصفوف `PENDING`)، و**0** في `payouts`. لا Settlement/Payout/Wallet من دفعة العرض.
- الحساب البنكي/المزوّد الحقيقي غير متصل إطلاقاً.

---

## 5. إعادة التشغيل / الإيقاف

```bash
# التشغيل (من جذر المستودع)
sudo dockerd > /tmp/dockerd-demo.log 2>&1 &
sudo docker start wasit-demo-pg          # قاعدة البيانات التجريبية
set -a; . ./.env.demo; set +a
( cd packages/server && nohup npx tsx src/index.ts > /tmp/demo-api.log 2>&1 & )
( cd packages/web && VITE_DEMO_MODE=true nohup npx vite preview --port 12000 --host 0.0.0.0 > /tmp/demo-web.log 2>&1 & )

# الإيقاف
pkill -f "tsx src/index.ts"; pkill -f "vite preview"
sudo docker stop wasit-demo-pg           # البيانات تبقى في الحاوية
```

لإعادة بناء البيانات: `drizzle-kit migrate` ثم `tsx src/scripts/seed.ts` ثم `tsx src/scripts/seed-demo.ts` مع `.env.demo`.

---

## 6. نتائج الاختبار

- `scripts/demo-security-smoke.sh` على الرابط العام: **34 ناجح / 1 "فشل"** — والفحص الوحيد عبارة عن تعبير grep قديم في السكربت (`VITE_DEMO_MODE` صار مُضمَّناً وقت البناء)؛ نص اللافتة موجود فعلاً في الحزمة (`لا مدفوعات حقيقية`).
- دخول حقيقي عبر المتصفح من الرابط العام: `merchantA` → `/dashboard` مع طلبات/منتجات حقيقية.
- تسجيل حساب جديد `201` ثم دخول `200` (مع `DEMO_SKIP_EMAIL_VERIFICATION=true`).
- دورة طلب: إنشاء `201` → نية دفع `manual/PENDING` → إكمال تجريبي → `PAID` (Ledger يبقى `PENDING`).
- الصحة: `/api/health/live` و`/api/health/ready` = `200` (`db: connected`).
- لا أخطاء `error`/`warn` في سجل الخادم، ولا استجابات `5xx`.

---

## 7. قيود متبقية

- الرابط مؤقت بطبيعته (بيئة تشغيل محلية مع نفق عام)؛ يتوقف بإيقاف العمليات أعلاه.
- لا Retry/Kill-Switch/Tool-Gateway (خارج نطاق AI-02).
- `DEMO_SKIP_EMAIL_VERIFICATION`/`DEMO_AUTO_LOGIN`/`DEMO_PAYMENT_MODE`/`ALLOW_DEV_TOOLING` كلها **تسمح** الخادم بالرفض في الإنتاج — لا يمكن أن تُرخي بوابة بيئة حقيقية.
