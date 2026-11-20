# SECURITY MODEL — WASIT BUSINESS GLOBAL

## 1. المصادقة

- كلمات مرور مشفرة عبر **argon2** (dummy-timing للتحقق).
- جلسات عبر **HttpOnly Cookie** (توقيع/تشفير) مع دعم **Bearer** للتطبيقات (PWA/Android/iOS).
- **قفل الحساب بعد فشل متكرر (LC-07 — `COMPLETE_VERIFIED`):** بعد `MAX_LOGIN_ATTEMPTS` (5) كلمة مرور خاطئة **متتالية** يُقفل الحساب مؤقتاً لمدة `LOCKOUT_MINUTES` (15) عبر `locked_until`، ثم **يُفتح تلقائياً** بانتهاء المدة — لا قفل دائم. العدّاد **يُصفَّر فقط بعد اكتمال المصادقة كاملةً** (كلمة المرور **والعامل الثاني** إن كان مفعّلاً) — لا عند صحة كلمة المرور وحدها؛ و**فشل TOTP لا يزيد عدّاد كلمة المرور ولا يصفّره** (له حماية مستقلة، انظر بند MFA). التطبيق **ذرّي** (`UPDATE` شرطي واحد يقرأ `failed_login_attempts + 1` في القاعدة) فلا يفقد تحديثات العدّاد تحت التزامن. **الرسالة موحّدة** (`Invalid credentials`، 401) لكل حالات الفشل — حساب موجود/مقفل/غير موجود — فلا يكشف وجود الحساب أو حالته، **وزمن الاستجابة مُوازَن**: كل مسار «بلا جلسة» (حساب غير موجود/مقفل) يشغّل تحقّق argon2 بمعاملات مطابقة (`DUMMY_ARGON2_HASH` في `lib/security.ts`) فلا يفصل المهاجم بين الحالات بالزمن (القياس يُثبت التقارب، ولا يُدّعى ثبات توقيت تام). يغطّي **كل الأدوار بلا استثناء** (بما فيها `SUPER_ADMIN`)، و**لا يُتجاوَز عبر MFA** (تحدّي `mfa_required` يُرفض إن كان الحساب مقفلاً). يُسجَّل `AUTH.ACCOUNT_LOCKED` عند تفعيل القفل و`AUTH.ACCOUNT_UNLOCKED` عند فتحه تلقائياً، **بلا كلمات مرور أو أسرار**. القفل **مستقل عن القفل الإداري الدائم** `is_locked` (الذي يبقى 403 عند الحاجة). الضبط عبر `MAX_LOGIN_ATTEMPTS`/`LOCKOUT_MINUTES` (`.env.example`)، ويُفضّل إبقاء `MAX_LOGIN_ATTEMPTS` دون `RATE_LIMIT_LOGIN_MAX` ليعمل القفل قبل حدّ الـIP.
- Tokens للتحقق من البريد وإعادة التعيين مؤقتة (TTL) وذات استخدام واحد.
- `mfaEnabled` + `authenticatorApp` (سر TOTP + أكواد استرداد salted) — تفعيل MFA عبر Setting أمان. **عند التفعيل، كلمة المرور وحدها لا تكفي**: `/api/auth/login` يعيد `mfaRequired:true` + `challengeToken` بلا أي جلسة، والجلسة تُصدر فقط من `/api/auth/mfa/challenge` بعد TOTP أو رمز استرداد.
- `mfaChallenges` — تحديات الدخول: `tokenHash` فقط (لا التوكن الخام)، أحادية الاستخدام (`consumedAt`)، TTL قصير وعدّاد محاولات (`MFA_CHALLENGE_TTL_MINUTES` / `MFA_CHALLENGE_MAX_ATTEMPTS`) يُبطل التحدي عند بلوغه؛ الزيادة **ذرّية** (`attempts + 1` في SQL) فلا تتجاوز محاولات متزامنة الحدّ. **هذه هي الحماية المستقلة للعامل الثاني:** فشل TOTP لا يمسّ عدّاد كلمة المرور (LC-07).
- **إلزام MFA للطاقم الداخلي (LC-06):** الأدوار `SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN` (`STAFF_ROLES`) **لا يمكنها الحصول على جلسة ولا الوصول لأي سطح طاقم بلا عامل ثانٍ مُفعَّل**. عند تسجيل الدخول، حساب طاقم بلا MFA يعيد `mfaRequired:true` + `mfaEnrollmentRequired:true` + `challengeToken` **بلا جلسة**؛ تُفتح الجلسة فقط عبر `/api/auth/mfa/staff-enroll` (يُعيد سرّ TOTP + `qrUri` + أكواد الاسترداد، بلا جلسة) ثم `/api/auth/mfa/staff-confirm` بعد TOTP صالح. الحارس `requireStaffMfa` (`middleware/mfa.ts`) مربوط **مرة واحدة على كامل سطح `/api/*`** (`app.use('/api/*', requireStaffMfa())` بعد CSRF وقبل كل المسارات) فيغطّي `admin` + المكاتب (`verification/trust/risk/disputes`) + **`revenue`** + كل مسار مختلط يصل إليه دور طاقم (`orders/payments/subscriptions/ai/media/analytics/tax/finance/observability/…`) بلا قائمة مسارات قابلة للانحراف. **يقرأ `mfaEnabled` من قاعدة البيانات حيّاً في كل طلب** (لا يُتجاوَز بجلسة قديمة ولا بحالة عميل)، **ولا استثناء لـ `SUPER_ADMIN`**، والفحص **fail-closed**. **لا يقيّد إلا أدوار الطاقم الخمسة** → العملاء/التجار/الموردون/الشركات/المسوّقون غير متأثرين. **الاستثناءات:** `/api/auth` و`/api/health` فقط (لإنشاء العامل الثاني)، والمطابقة دقيقة أو بفاصل `/` (`/api/authz` غير مستثنى).
- **سياسة الإلزام:** `STAFF_MFA_ENFORCEMENT=auto|on|off` (افتراضي `auto`). `auto` = مفروض في **production فقط**؛ `staging` (العرض التجريبي العام بكلمات مرور منشورة) لا يُقفل؛ `on` يفرض في كل البيئات (للاختبار/الإثبات)، و`off` يعطّل.

## 2. التفويض (RBAC)

- `requireAuth` — يجب أن يكون المستخدم مصادقاً ونشطاً.
- `requireRole('X', ...)` — أحد الأدوار المطلوبة.
- `requirePermission(PERMISSIONS.X)` — صلاحية محددة من `rolePermissions`.
- ROLE_PERMISSIONS والمعادلات في `@wasit/shared`؛ إنفاذ الجهة الوحيدة في الخادم.
- **صلاحيات ADMIN للإيراد/التقارير (PERM-01 — `COMPLETE_VERIFIED`):** `ADMIN` **لا يملك** `revenue:read`/`revenue:manage`/`revenue:simulate` — تقرير ربحية المنصّة (`GET /api/revenue/report`، و`scenarios`، و`scenario`) يبقى **حصراً على `SUPER_ADMIN`**، وهذا **منع مقصود** لا سهو: `docs/management/guide.html` §8 يوثّقه بتحقّق حيّ (ADMIN→403، SUPER_ADMIN→200) وينصّ أن الفرق الفعلي بين المنصبين هو بالضبط `/api/revenue/*` (لا واجهة لهذا المسار — Backend فقط). و`report:read` **لا تحرس أي مسار**: مكتب التقارير (`GET/POST /api/admin/analytics/reports`) محروس عمداً بـ`admin:reports` الذي يملكه `ADMIN` (PERM-01C R2)، فتُوثَّق كصلاحية «ميتة/مُسمّاة خطأً» (قرار إزالتها مهمة تنظيف منفصلة). لا يُمنح ADMIN أي صلاحية مالية جديدة، ولا يُغيّر سلوك `SUPER_ADMIN`. مُثبَت بـ`packages/server/tests/perm01-admin-revenue-report.test.ts` (17 حالة، معزول بلا DB).

## 3. حماية واجهات API

- **Input Validation**: zod على كل body/params/query — 422 مع fieldErrors.
- **Rate Limiting**: مسارات المصادقة والرسائل والإعلانات ضد إساءة الاستخدام (429). المخزن قابل للتبديل (`RATE_LIMIT_STORE=memory|postgres`): في الإنتاج متعدد النسخ يُستخدم `postgres` فتتشارك العدّادات ولا تتضاعف الحدود الفعلية؛ الموضوع `user:<id>` للطلب المصادَق (لئلا يفلت حساب بتدوير IP) و`ip:<ip>` للمجهول. الجدول `rate_limit_counters` لا يحوي PII ويُنظَّف من الـscheduler ومن مسار admin مُدقَّق.
- **CORS**: origin مقيّد (استجابة حسب الطلب وليس `*` ثابت في الطلب).
- **CSRF**: حماية الطلبات المُغيِّرة للحالة (POST/PUT/PATCH/DELETE) التي تحمل كوكي الجلسة، بالتحقق الصارم من `Origin` (و`Referer` كبديل). التفاصيل في §3.1.
- **أخطاء**: ApiError موحّد، لا تفاصيل داخلية (500 عام)، traceId للتشخيص.

### 3.1 حماية CSRF (CAN-SEC-CSRF-01) — `COMPLETE_VERIFIED`

- **الآلية**: المصادقة كوكي جلسة (`wasit_session`، `SameSite=Lax`، `HttpOnly`، `Secure` في HTTPS). الكوكي تُرفَق تلقائياً بأي طلب يصل إلى الـAPI — بما فيها طلب يُطلقه موقع خارجي — لذا يحتاج الطلب المُغيِّر للحالة إثباتاً ثانياً بأنه من واجهتنا: ترويسة `Origin` (أو `Referer` عند غيابها)، وهي قيم لا يستطيع نصّ صفحة تزويرها.
- **النطاق**: يُطبَّق على `POST/PUT/PATCH/DELETE` فقط، وفقط عندما يحمل الطلب كوكي الجلسة. الطلبات بلا كوكي (عملاء التوكن، مسار webhooks الموقّع بـHMAC) لا تتأثر لأنها لا تحمل اعتماداً ضمنياً قابلاً للاستغلال. الطرق الآمنة (GET/HEAD/OPTIONS) لا تُفحص أبداً.
- **القرار**: يُقبل الطلب إذا كان أصله مطابقاً لـ`APP_URL` أو ضمن `CORS_ORIGIN`. عند غياب `Origin` و`Referer` مع وجود الكوكي → **رفض مغلق** (لا يمكن إثبات الأصل). الرفض `403 FORBIDDEN` برسالة مقتضبة لا تكشف الأصل المرفوض.
- **الإنفاذ**: يتحكّم به `CSRF_PROTECTION` (`auto` افتراضاً: مُفعَّل في production/staging، معطّل في dev/test؛ أو `on`/`off`). **لا مسارات مستثناة.**
- **الترتيب**: بعد CORS وقبل التوجيه (routing)؛ الحرّاس RBAC تبقى تعمل لكل مسار. لا يُوسّع CORS ولا يُضعف المصادقة. (مُثبَت باختبار: ردّ CSRF `403` يحمل ترويسة CORS، والمسار لا يُبلَغ.)
- **الاختبار** (WASIT-EXECUTION-005، معزول بلا DB): `packages/server/tests/csrf.test.ts` (**21/21**: الطرق الأربع، رفض Origin أجنبي/`null`/Referer أجنبي، قبول same-origin/Referer مطابق، رفض مغلق بلا دليل، عدم المساس بطلبات بلا كوكي، سلامة GET/HEAD/OPTIONS، `auto` في production عبر التطبيق الحقيقي، عدم استثناء المسارات الحسّاسة، الترتيب CORS→CSRF→routes) + `tests/cors.test.ts` (**4/4**).

## 4. حماية البيانات

- **SQL Injection**: Drizzle + Prepared Statements.
- **XSS**: لا `innerHTML` غير آمن؛ الواجهة ستستخدم React escape.
- **File Upload** (مستقبلاً): تحقق MIME + حجم + تخزين خارج مصفوفة (لا ات)؛ إعادة تسمية عشوائية.
- **Secrets**: كل المتغيرات عبر `.env` و `env.ts` — لا أسرار في الريبو.
- **Privacy**: consents، إعدادات خصوصية؛ Data Export/Deletion جاهزية في السكيما (consents، user.data policies).
- **Prohibited/Restricted Goods (LC-03 — `COMPLETE_VERIFIED`: 26/26 معزول بلا DB + 4/4 HTTP على PostgreSQL 16 مؤقتة معزولة):** مصنّف مركزي (`lib/prohibited-goods.ts`) بقواعد `PROHIBITED/RESTRICTED/ALLOWED` و`reason`؛ تطبيع مقاوم للتحايل (حالة الأحرف/التشكيل/أشكال الحروف العربية/المسافات/الرموز الصفرية) ومطابقة **كلمة كاملة**. **نقطة إنفاذ واحدة** في الخدمة (`enforceListingPolicy`) داخل `createProduct`/`updateProduct`/`updateProductStatus`، فلا يُتجاوزها أي مدخل. **الفشل مُغلق:** محظور → `422 PROHIBITED_GOODS` بلا كتابة؛ مقيّد → مسودّة غير منشورة (`DRAFT`, `isPublished=false`) لا تُنشر إلا عبر **مراجعة بشرية** (`POST /api/products/:id/compliance-review` بصلاحية `catalog:compliance:review` التي لا يحملها أي وكيل AI، ولا يمنحها أي دور آلي). إعادة تصنيف المنتج الناتج عند التعديل تمنع تحويل منتج قائم إلى محظور أو «تنظيف» منتج مُعلَّم. القرارات مُدقّقة (`PRODUCT.PROHIBITED_REJECTED`/`RESTRICTED_REVIEW_REQUIRED`/`RESTRICTED_PUBLISH_BLOCKED`/`RESTRICTED_APPROVED`/`RESTRICTED_REJECTED`). **بلا Migration** (العلامة في `products.tags` غير المستخدَم + `audit_logs`). القائمة أولية قابلة للضبط؛ لا تدّعي تغطية قانونية شاملة (النصّ القانوني تحت LC-01، وقوائم العقوبات/KYC تحت LC-05).
- **Cookie/Privacy Consent (LC-02 — `COMPLETE_VERIFIED` تقنياً: 34/34 وحدة + E2E متصفّح بلا DB 8/8)**: موافقة تُخزَّن على العميل (localStorage، مفتاح `wasit.consent`) بإصدار سياسة (`CONSENT_POLICY_VERSION`) وانتهاء (180 يوماً)؛ **لا موافقة ضمنية** (غياب/تلف/إصدار قديم/انتهاء = لا قرار)؛ أربع فئات (Necessary دائماً مفعّلة وغير قابلة للتعطيل، Preferences/Analytics/Marketing معطّلة حتى الموافقة)؛ **البوّابة على التنفيذ لا الإظهار**: `AdSlot` لا يجلب/يعرض/يرسل أي حدث تتبّع تسويقي قبل موافقة `marketing`، ويتوقّف فور سحبها ويحذف معرّف الإعلانات (`wasit.adSession`)؛ لا مساس بكوكي الجلسة `wasit_session` أو الأمان. الجزء القانوني (نصّ السياسة/الأساس القانوني) يبقى اعتماداً خارجياً تحت LC-01 — لا يُدَّعى امتثال قانوني كامل.

## 5. السجل والمراقبة

- `audit_logs` — who/what/old/new/date/reason لتغييرات مهمة (admin/setting، طلبات، عمولات، سياسات).
- سجل الخادم (logger) مع traceId.
- Health checks (`/api/health/ready`) — جاهزية DB.

## 6. مضاد تخطي العمولة

- `ANTI_FEE_EVASION` policy (rules: offPlatformContact prohibited, penalty account_suspension).
- آليات مبكرة: تحقق بائع/مشتري، درجات ثقة، Risk events — لمكافحة multi-account وprice manipulation.
- تبقى سياسات الاستخدام غير المحددة قانونياً → DECISION REQUIRED.

## 7. النسخ الاحتياطي والاسترداد

- Migrations قابلة للتراجع (Drizzle).
- Backups و rollback strategy موصوفة في DEPLOYMENT.md.
- Staging بيئة منفصلة قبل الإنتاج.

## 8. الضوابط غير محلولة بعد (قائمة انتظار)

- تفاصيل KYC/AML حسب الدولة (يُرفع كـ Decision Required).
- معالجة الـ File Upload الفعلية (لِلمُستقبل).
- إعدادات تسجيل دخول firebase/SSO (غير ضروري حالياً).