# DEPLOYMENT — WASIT BUSINESS GLOBAL

## 1. البيئات

| بيئة | قاعدة | غرض |
| --- | --- | --- |
| Development | `wasit_dev` | تطوير |
| Test | `wasit_test` | اختبارات تلقائية (drop/create في كل vitest) |
| Staging | `wasit_staging` | مراجعة ما قبل الإنتاج |
| Production | `wasit_prod` | إنتاج |

### تشغيل PostgreSQL في بيئة Dev (Container/محلية)

في بيئة التطوير (حاوية/Container) **PostgreSQL لا يُشغّل نفسه تلقائياً**. العارض `ECONNREFUSED 127.0.0.1:5432` المعهود عند تشغيل الخادم أو الاختبارات سببه **قاعدة البيانات متوقفة (غير مُشغّلة) وليس خطأً في الكود**.

الخطوات (Debian/apt):

```bash
# 1) التثبيت (مرة واحدة)
sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client

# 2) بدء خدمة PostgreSQL
sudo pg_ctlcluster 17 main start   # أو: sudo service postgresql start

# 3) إنشاء المستخدم والقاعدتين (مرة واحدة — مستخرج من DATABASE_URL)
sudo -u postgres psql -c "CREATE USER wasit WITH PASSWORD '<password-from-env>';"
sudo -u postgres psql -c "CREATE DATABASE wasit_dev OWNER wasit;"
sudo -u postgres psql -c "CREATE DATABASE wasit_test OWNER wasit;"
sudo -u postgres psql -c "ALTER USER wasit CREATEDB;"   # مطلوب لأن globalSetup يعيد إنشاء wasit_test
```

> ملاحظات:
> - الاختبارات (`wasit_test`) تتعامل مع `CREATE DATABASE` في `tests/setup.ts`، لذلك **المستخدم `wasit` يحتاج صلاحية `CREATEDB`** وإلا يظهر `42501`.
> - بعد بدء الخدمة شغّل `npm run db:migrate` (مرة) ثم `npx tsx src/scripts/seed.ts` (مرة) ثم `npx tsx src/scripts/seed-demo.ts` (اختياري لإعادة مستخدمي Dev).
> - حاوي التطوير: في حال إعادة تشغيل الحاوية أعد تنفيذ الخطوة (2) فقط (التثبيت والمستخدم وقواعد DB تبقى محفوظة).

## 2. المتغيرات (env)

```env
DATABASE_URL=postgresql://user:pass@host:5432/wasit_dev
JWT_SECRET=<سري>
SESSION_SECRET=<سري>
AI_PROVIDER=noop            # noop|openai|anthropic|...  (قابل للتبديل)
AI_MODEL=
AI_API_KEY=
CORS_ORIGIN=http://localhost:5173
NODE_ENV=development

# البريد — MAIL_TRANSPORT=log (بلا شبكة، للتطوير/CI) أو smtp للإرسال الحقيقي.
# SMTP_* أسرار فقط من البيئة؛ لا تُلتزم في الريبو.
MAIL_TRANSPORT=log
MAIL_FROM=WASIT BUSINESS GLOBAL <no-reply@wasit.tn>
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=

# حدّ المعدل — memory (نسخة واحدة/تطوير) أو postgres (مشاركة العدّادات بين النسخ).
# استخدم postgres في أي نشر بأكثر من نسخة API.
RATE_LIMIT_STORE=memory
RATE_LIMIT_PURGE_INTERVAL_MINUTES=15
```

- لا Secrets في الريبو؛ `.env` مستثنى (gitignore).
- الترويس: `.env.example` للتوثيق (قريباً).
- بريد المعاملات: `MAIL_TRANSPORT=log` يطبع سطرًا مُقنَّعًا ويكتب `MAIL.SENT` في Audit؛ للإنتاج اضبط `smtp` + بيانات المزوّد. فشل الإرسال لا يُسقط التسجيل (يُسجَّل `MAIL.FAILED`). للتطوير: `POST /api/auth/dev/verification-link` (404 في production).

## 3. Migrations

- `npm run db:generate` — يولّد SQL من schema (drizzle-kit).
- `npm run db:migrate` — يطبق migrations.
- في الاختبار: migrations تُطبق تلقائياً في globalSetup.
- **Rollback**: Drizzle يدعم down migrations؛ سياسة: أي migration قابل للتراجع قبل الانتشار.

## 4. Backups

النسخ الاحتياطي منفّذ كسكربتات قابلة للتشغيل غير التفاعلي، مع تحقق سلامة وتراجع آمن:

- `scripts/backup-db.sh` — ينسخ `pg_dump -Fc` لكل قاعدة + `pg_globals.sql`، ويكتب `manifest.json` و`checksums.sha256` و`table-counts.tsv`، ويطبّق الاحتفاظ (`BACKUP_RETENTION_COUNT`، الافتراضي 7) وينظّف أي مجلد ناقص. يكتب قلب النجاح `.last-success.json` بعد كل تشغيل ناجح.
- `scripts/restore-db.sh` — يتحقق من `checksums.sha256` قبل الاستعادة، ويرفض الكتابة فوق قاعدة حيّة إلا بـ `--allow-live`، ويرفض هدفًا موجودًا إلا بـ `--force`، ويتحقق من أعداد الصفوف بعد الاستعادة.
- `scripts/backup-restore.test.sh` — تمرين حقيقي (نسخ/استعادة/فقدان بيانات/استرجاع/احتفاظ) بلا mocks.
- **الجدولة**: في `docker compose` توجد خدمة `backup` (صورة `postgres:16` لتطابق عميل `pg_dump` مع الخادم) تنسخ فور الإقلاع ثم كل `BACKUP_INTERVAL_SECONDS` (الافتراضي 86400). خارج الحاويات استخدم `scripts/deploy/backup.cron` أو وحدات systemd في `scripts/deploy/wasit-backup.{service,timer}`.
- **المراقبة**: خدمة `backup` و`api` تتشاركان volume `backup-data`؛ الـapi يقرأ القلب (قراءة فقط) عبر `BACKUP_HEARTBEAT_FILE` ويعرض عمره في `GET /api/health/channels`، وقاعدة `backup_stale` تُطلق تنبيهًا CRITICAL إذا تجاوز العمر `BACKUP_MAX_AGE_HOURS` (الافتراضي 26). إن لم يُضبط `BACKUP_HEARTBEAT_FILE` تبقى القاعدة خاملة.
- رزم الأمان: التشفير أثناء التخزين، ونقل عبر موثوق، وعدم التزام النسخ في Git (`backups/*.dump` و`pg_globals.sql` و`.last-success.json`).

## 5. Health Checks

- `GET /api/health/live` — توقف عملية.
- `GET /api/health/ready` — فحص اتصال DB.
- `GET /api/health/channels` — حالة قنوات الإرسال وحدّ المعدل والإشعارات (بلا أسرار)، إضافة إلى `backup` (آخر نسخة ناجحة وعمرها وحدّ التنبيه).
- (فكرة) إضافة readiness لـ AI/provider في المستقبل.

## 6. Logging & Monitoring

- **Logs**: كل سجل هو سطر JSON واحد على stdout (`OBS_LOG_FORMAT=json`، أو `pretty` للقراءة المحلية)، يجمعها أي منصة حاويات (Docker/systemd/K8s). السجلات تحمل `traceId` والمسارات والأخطاء. حلقة داخلية محدودة (200 سجل) تتيح `GET /api/admin/observability/logs`؛ لا تُخزَّن أسرار (تنقيح تلقائي).
- **Tracing**: ترويسة W3C `traceparent` الواردة تُتبنّى فيبقى الطلب على trace واحد عبر الخدمات؛ تُعاد الترويسة `X-Trace-Id`، ويحمل كل خطأ `traceId`. `traceFromHeaders` يولّد معرّفًا عند غيابها.
- **Metrics**: `GET /metrics` بصيغة Prometheus (`METRICS_ENABLED=true`، وتوكن Bearer اختياري عبر `METRICS_TOKEN`). يشمل `wasit_http_requests_total`/`wasit_http_request_duration_seconds`/`wasit_http_errors_total`/`wasit_rate_limit_rejections_total`/`wasit_audit_writes_total`/`wasit_alerts_fired_total`/`wasit_alert_notifications_total` + `wasit_db_up`/`wasit_uptime_seconds`/`wasit_build_info`. **حين لا يوجد `METRICS_TOKEN`، يجب تقييد `/metrics` على شبكة السحب** (security group/firewall) لأنه بلا مصادقة.
- **Alerting**: محرك قواعد يُشغَّل من الـscheduler (`SCHEDULER_ENABLED=true` و`OBS_ALERTS_ENABLED=true`، كل `OBS_ALERT_INTERVAL_MINUTES`) أو يدويًا من `POST /api/admin/observability/alerts/evaluate`. القواعد: `database_down`، `http_error_ratio`، `http_p95_latency`، `rate_limit_rejections`، `alert_scheduler_stale`، `backup_stale` (تتطلب `BACKUP_HEARTBEAT_FILE`). التنبيه يُرسل عبر `OBS_ALERT_NOTIFY` (`log` افتراضي؛ `webhook` مع `OBS_ALERT_WEBHOOK_URL` لجسر Slack/PagerDuty) وتُحفظ انتقالاته في `alert_events`. يُعاد تحميل حالة القواعد المفتوحة من `alert_events` عند الإقلاع، فينتقل قاعدة كانت FIRING قبل restart إلى RESOLVED بدلًا من ترك صف معلّق أو تكرار FIRING.
- سجل audit في DB (مستقل عن اللوج التشغيلي).
- **ربط منصة خارجية**: أجّه جامع السجلات إلى stdout، وPrometheus إلى `/metrics`؛ لا يوجد تنسيق خاص بالمنصة.

## 7. Rollback Strategy

- التطبيقات: إعادة نشر النسخة السابقة (Docker image) من سجل.
- Database: down migration + إعادة restore من backup قبل تطبيق تغيير Schema جديد.
- عمولات/سياسات: معاملات قاعدة ذرّية (وابتداءً) عند التغيير.

## 8. الإنتاج (محظور)

- ممنوع تنفيذ تغييرات خطيرة مباشرة على Production دون مرور Staging.
- يشمل: migrations destructive، تغيير سياسات مالية، حذف بيانات.

## 9. الحاويات (Docker) — تشغيل إنتاجي مُماثل

الملفات: `Dockerfile` (API)، `Dockerfile.web` (SPA + nginx)، `deploy/nginx.conf`، `docker-compose.yml`، `.dockerignore`.

بنية صورة الـ API: ثلاث مراحل — `deps` (تثبيت بالـ lockfile + `npm rebuild argon2` للامتداد الأصلي) → `build` (`npm run build:prod` = esbuild bundle) → `runtime` (اعتماديات الإنتاج فقط + `dist-bundle/` + أصول migrations + `drizzle-kit` للتطبيق)، وتعمل كـ `USER node` (غير جذرية) مع `HEALTHCHECK` على `/api/health/ready`.

> **لماذا bundle وليس `tsc`؟** مخرجات `tsc` تحتفظ باستيرادات نسبية بلا امتداد وعلى `@wasit/shared` كمصدر TS، فلا تعمل مباشرة على Node (ESM). الحل المعياري: `esbuild` ينتج `dist-bundle/index.cjs`. `argon2` تبقى `--external` (وحدة أصلية). `npm run build` (tsc) يبقى للتحقق من الأنواع.

خطوة الإصدار داخل الحاوية (idempotent، تنفَّذ في `command`):

```bash
npx drizzle-kit migrate      # تطبيق migrations
node /app/dist-bundle/seed.cjs   # بيانات مرجعية (roles/permissions/countries/...)
node /app/dist-bundle/index.cjs  # تشغيل الخادم
```

> **تحذير تشغيلي:** بدون تشغيل `seed.cjs` على قاعدة جديدة يفشل التسجيل بـ `Role CUSTOMER not seeded` (500). البيئة التي لم تُبذَر بعد غير جاهزة لاستقبال المستخدمين.

تشغيل:

```bash
# JWT_SECRET إلزامي (>=32 حرفًا) — لا قيمة افتراضية في compose.
export JWT_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
# الواجهة: http://localhost:8080  (nginx يمرّر /api و/sitemap.xml و/robots.txt إلى api:3000)
```

لا تُنشر قاعدة `db` على المضيف في compose؛ فقط `api` يصل إليها. مفاتيح الدفع تُمرَّر عبر البيئة/Secrets فقط (الافتراضي `PAYMENT_PROVIDER=noop`).

## 10. CI — GitHub Actions

`.github/workflows/ci.yml` بثلاث وظائف، مع خدمة `postgres:16` حقيقية (بلا mocks):

| Job | المحتوى |
| --- | --- |
| `static` | `npm ci` + `npm run typecheck` + `build -w @wasit/web` + `build:prod -w @wasit/server` |
| `test` | اختبارات الوحدة/التكامل (`npm test`)؛ `globalSetup` يعيد إنشاء `wasit_test` ويطبّق migrations ويبذر |
| `e2e` | بعد `static`: `db:migrate` + `db:seed` ثم `playwright install chromium` ثم `npm run test:e2e`؛ عند الفشل يُرفَع `playwright-report` كـ artifact |

- `npm rebuild argon2` مطلوب في كل job لأن `npm ci --ignore-scripts` يتخطى بناء الامتداد الأصلي.
- المستخدم `wasit` يحتاج صلاحية `CREATEDB` (وهي مفعّلة افتراضيًا للمستخدم الرئيسي في صورة Postgres).
- الإلغاء التلقائي للتشغيلات المتقادمة عبر `concurrency`.