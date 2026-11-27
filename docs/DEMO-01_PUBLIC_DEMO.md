# DEMO-01 — PUBLIC DEMO (رابط تجريبي عام)

> **النطاق**: نسخة تجريبية عامة قابلة للاستخدام من الهاتف.
> **الحكم**: ✅ **يعمل** — واجهة + خادم + PostgreSQL تجريبية معزولة على رابط HTTPS عام.
> **لا علاقة له بأي بيئة إنتاج.** لا مزوّد دفع حقيقي، ولا بيانات حقيقية، ولا migration على قاعدة غير تجريبية.

---

## 1. الرابط والحالة

| البند | القيمة |
| --- | --- |
| Public URL | `https://work-1-jbrbmtqnypyjfriv.prod-runtime.all-hands.dev` |
| Frontend | Vite production build عبر `vite preview`، المنفذ 12000 |
| Backend | Hono، `NODE_ENV=staging`، المنفذ 3000 (غير منشور مباشرة) |
| Database | PostgreSQL 17 على `127.0.0.1:5434`، قاعدة `wasit_demo` |
| Proxy | نفس الأصل: `/api` يمرّ عبر أصل الواجهة — لا CORS متقاطع |
| Payments | `PAYMENT_PROVIDER=manual` — مكتب offline، **بلا أي نداء مزوّد حقيقي** |
| AI | `AI_PROVIDER=local-heuristic` — محلي حتمي بلا مفتاح |
| الأسرار | `.env.demo` (غير متعقّب، صلاحية `0600`)، كلمة مرور عشوائية **لكل حساب** |

**منافذ API المنشورة:** لا شيء. الـAPI يُخدَم فقط عبر وكيل الواجهة (same-origin)؛ قاعدة البيانات
غير منشورة إلا على `127.0.0.1:5434`.

---

## 2. الحسابات التجريبية

**لا كلمة مرور منشورة.** منذ `DEMO-SEC-03` لكل حساب كلمة مرور فريدة عشوائية (24 حرفاً
`base64url` ≈ 144 بت)، مخزّنة فقط في `.env.demo` (غير متعقّب) و`.env.demo.secrets` (`0600`).
إعادة التدوير: `rotate-demo-credentials.ts --include-staff` (يُبطل كل الجلسات ويُغلق رموز
إعادة تعيين كلمة المرور وتحديات MFA).

| الحساب | الدور | مفتاح كلمة المرور في `.env.demo` |
| --- | --- | --- |
| `customer1@wasit.tn` | CUSTOMER | `DEMO_ACCOUNT_PASSWORD_CUSTOMER1` |
| `merchanta@wasit.tn` | MERCHANT | `DEMO_ACCOUNT_PASSWORD_MERCHANTA` |
| `suppliera@wasit.tn` | SUPPLIER | `DEMO_ACCOUNT_PASSWORD_SUPPLIERA` |
| `companya@wasit.tn` | COMPANY | `DEMO_ACCOUNT_PASSWORD_COMPANYA` |
| `demo@wasit.tn` | CUSTOMER (حساب العرض الرسمي) | `DEMO_ACCOUNT_PASSWORD_DEMO` |
| `admin@wasit.tn` | SUPER_ADMIN + ADMIN | `DEMO_STAFF_PASSWORD_ADMIN` |
| `admin2@wasit.tn` | ADMIN | `DEMO_STAFF_PASSWORD_ADMIN2` |

- **لا طباعة في السجلات**: `scripts/lib/demo-credentials.mjs` يقرأ كلمة المرور عند الحاجة فقط.
- **حساب العرض الرسمي** عنوان محايد (`demo@wasit.tn`) بدل أي بريد شخصي؛ `MAIL_TRANSPORT=log`.
- **حسابات الإدارة** لا تفتحها بيانات اعتماد العرض (`401`)، وكلمة مرور الإدارة لا تفتح حسابات العرض.

**مسارات دخول تجريبي:**
- `POST /api/auth/demo-session` — يفتح حساب العرض الرسمي فقط، محصور بـ`DEMO_AUTO_LOGIN=true`
  (`404` وهو مطفأ في هذا النشر).
- `POST /api/auth/demo-audit-session` — **أداة تشغيلية، ليست مدخلاً عاماً (DEMO-SEC-01)**:
  تتطلب جلسة موظف حقيقية (`401` للزائر، `403` لغير الموظف)، والشخصية لا تتجاوز صلاحية المستدعي.

---

## 3. الأمان المطبّق (مُتحقَّق)

- كل حساب له كلمة مرور خاصة: كلمة حساب لا تفتح حساباً آخر، ولا حساب إدارة (`401`).
- CUSTOMER/MERCHANT/SUPPLIER/COMPANY وanonymous: `401/403` على كل مسارات `/api/admin/*`.
- `demo-session` و`demo-audit-session` مغلقان للزائر (`404`) ولغير الموظف (`403`).
- CORS: أصل أجنبي لا يحصل على `Access-Control-Allow-Origin`.
- الحزمة العامة نظيفة من الأسرار وعلامات الإنتاج، ولافتة DEMO ظاهرة.
- `.env.demo` غير متعقّب في Git؛ الأسرار عشوائية ولا تُكتب في الكود أو السجل.
- حدّ المحاولات: `RATE_LIMIT_LOGIN_MAX=60` لكل IP (عدة مختبِرين قد يتشاركون عنوان NAT واحد)،
  مع قفل الحساب المنفصل عند 5 محاولات خاطئة (15 دقيقة) — مُثبت في التجربة.

---

## 4. سلامة المال (مُتحقَّق)

- إنشاء نية دفع → `provider: "manual"`، `status: "PENDING"`، `checkoutUrl: null` (لا مزوّد).
- **لا `SETTLED`** في `transaction_ledger` (كل الصفوف `PENDING`)؛ لا يُكتب `SETTLED` إلا من حدث
  `settlement.confirmed` لمزوّد يعلن `capabilities.settlementEvidence`.
- الحساب البنكي والمزوّد الحقيقي غير متصلين إطلاقاً.

---

## 5. إعادة التشغيل / الإيقاف / المراقبة

```bash
# التشغيل (من جذر المستودع)
bash scripts/demo-up.sh            # يتحقق من PostgreSQL ثم يشغّل API + web وينتظر الجهوزية
bash scripts/demo-up.sh --build    # مع بناء جديد للواجهة (VITE_DEMO_MODE=true)

# الصحة
bash scripts/demo-health.sh        # pg، api، web، proxy، الرابط العام

# الإيقاف (PostgreSQL يبقى يعمل: قواعد أخرى على نفس العنقود)
bash scripts/demo-down.sh
```

- ملفات pid والسجلات في `.demo-run/` (غير متعقّبة): `api.pid`، `web.pid`، `api.log`، `web.log`.
- PostgreSQL: `sudo pg_ctlcluster 17 main start` إن كان متوقفاً.
- إعادة بناء البيانات: `drizzle-kit migrate` ثم `tsx src/scripts/seed.ts` ثم `tsx src/scripts/seed-demo.ts`
  مع `.env.demo` (يحفظ كلمات المرور المدوّرة).

---

## 6. نتائج الاختبار (على الرابط العام)

- `scripts/demo-security-smoke.sh` → **74 ناجح / 0 فاشل**: 4 حسابات + رفض الإدارة لكل دور +
  مسارات الدخول التجريبي + CORS + طلب/نية دفع + نظافة الحزمة + قيد الكتابة في `wasit_demo`.
- `scripts/ui-demo-audit.mjs` → **69 ناجح / 0 فاشل** (Chromium حقيقي): الرئيسية، السوق، صفحة منتج،
  تسجيل جديد، دخول 5 أدوار، صفحات الإدارة، رفض `/admin/users` للأدوار التجريبية، 4 لغات
  (`ar` RTL و`fr`/`en`/`zh` LTR)، شاشة هاتف 390×844 بلا تجاوز أفقي، وصدق مزوّد AI.
- `scripts/ui-mobile-smoke.mjs` → **16/16**، و`scripts/ui-flows-check.mjs` → **6/6**.
- الصحة: `/api/health/live` و`/api/health/ready` و`/api/health/channels` = `200` (`db: connected`).
- لا استجابات `5xx` ولا أخطاء JavaScript في Console (يُستثنى `401 /api/auth/me` وهو سبر عادي قبل الدخول).

---

## 7. قيود متبقية

- الرابط مؤقت بطبيعته (بيئة تشغيل محلية مع نفق عام)؛ يتوقف بإيقاف العمليات أعلاه.
- منتجات العرض 13 منتجاً، جميعها لها صور الآن.
- لا فيديوهات تسويقية مُسبقة (مكتبة الفيديو متاحة وتُنفَّذ عند الطلب؛ `items=0` حالياً).
- `DEMO_SKIP_EMAIL_VERIFICATION`/`DEMO_AUTO_LOGIN`/`DEMO_PAYMENT_MODE` كلها تجعل الخادم يرفض
  الإقلاع في `production` — لا يمكن أن تُرخي بوابة بيئة حقيقية.
