# SECURITY MODEL — WASIT BUSINESS GLOBAL

## 1. المصادقة

- كلمات مرور مشفرة عبر **argon2** (dummy-timing للتحقق).
- جلسات عبر **HttpOnly Cookie** (توقيع/تشفير) مع دعم **Bearer** للتطبيقات (PWA/Android/iOS).
- `MAX_LOGIN_ATTEMPTS` (5) → lockout مؤقت بعد `LOCKOUT_MINUTES` (15) ضد Hashing Brute-Force.
- Tokens للتحقق من البريد وإعادة التعيين مؤقتة (TTL) و**أحادية الاستخدام فعليًا**: يُنفَّذ الاستهلاك عبر `UPDATE` شرطي واحد يحمل `used_at IS NULL` وشرط الانتهاء في جملة `WHERE` مع `.returning()`، داخل معاملة (`db.transaction`) — فتتسلسل الطلبات المتزامنة على قفل الصف ولا ينجح منها إلا طلب واحد، وإعادة الاستخدام أو الطلب الخاسر في السباق لا يطابق شيئًا ويُرفض 401. لأن إعلان الاستخدام والتأثير (تأكيد البريد أو تحديث كلمة المرور وإبطال الجلسات) في معاملة واحدة، فأي فشل لاحق يُرجع إعلان الاستخدام ويُبقي الرابط صالحًا.
- `mfaEnabled` + `authenticatorApp` (سر TOTP + أكواد استرداد salted) — تفعيل MFA عبر Setting أمان. **عند التفعيل، كلمة المرور وحدها لا تكفي**: `/api/auth/login` يعيد `mfaRequired:true` + `challengeToken` بلا أي جلسة، والجلسة تُصدر فقط من `/api/auth/mfa/challenge` بعد TOTP أو رمز استرداد.
- `mfaChallenges` — تحديات الدخول: `tokenHash` فقط (لا التوكن الخام)، أحادية الاستخدام (`consumedAt`)، TTL قصير وعدّاد محاولات (`MFA_CHALLENGE_TTL_MINUTES` / `MFA_CHALLENGE_MAX_ATTEMPTS`) يُبطل التحدي عند بلوغه.

## 2. التفويض (RBAC)

- `requireAuth` — يجب أن يكون المستخدم مصادقاً ونشطاً.
- `requireRole('X', ...)` — أحد الأدوار المطلوبة.
- `requirePermission(PERMISSIONS.X)` — صلاحية محددة من `rolePermissions`.
- ROLE_PERMISSIONS والمعادلات في `@wasit/shared`؛ إنفاذ الجهة الوحيدة في الخادم.

## 3. حماية واجهات API

- **Input Validation**: zod على كل body/params/query — 422 مع fieldErrors.
- **Rate Limiting**: مسارات المصادقة والرسائل والإعلانات ضد إساءة الاستخدام (429). المخزن قابل للتبديل (`RATE_LIMIT_STORE=memory|postgres`): في الإنتاج متعدد النسخ يُستخدم `postgres` فتتشارك العدّادات ولا تتضاعف الحدود الفعلية؛ الموضوع `user:<id>` للطلب المصادَق (لئلا يفلت حساب بتدوير IP) و`ip:<ip>` للمجهول. الجدول `rate_limit_counters` لا يحوي PII ويُنظَّف من الـscheduler ومن مسار admin مُدقَّق.
- **CORS**: origin مقيّد (استجابة حسب الطلب وليس `*` ثابت في الطلب).
- **أخطاء**: ApiError موحّد، لا تفاصيل داخلية (500 عام)، traceId للتشخيص.

## 4. حماية البيانات

- **SQL Injection**: Drizzle + Prepared Statements.
- **XSS**: لا `innerHTML` غير آمن؛ الواجهة ستستخدم React escape.
- **File Upload** (مستقبلاً): تحقق MIME + حجم + تخزين خارج مصفوفة (لا ات)؛ إعادة تسمية عشوائية.
- **Secrets**: كل المتغيرات عبر `.env` و `env.ts` — لا أسرار في الريبو.
- **Privacy**: consents، إعدادات خصوصية؛ Data Export/Deletion جاهزية في السكيما (consents، user.data policies).

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