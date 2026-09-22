# DEVELOPMENT ROADMAP — WASIT BUSINESS GLOBAL

خارطة التطوير حسب PHASES الواردة في الوثيقة المرجعية MASTER FOUNDATIONAL ARCHITECTURE V3.0.

> محدَّث 2026-09-19 بعد تدقيق فعلي مقابل الكود (routes/services/schema/tests). لا يُعتبر أي Phase مكتملاً بمجرد وجود route أو table.

| Phase | المحتوى | الحالة |
| --- | --- | --- |
| PHASE 0 | Architecture + Documentation | ✅ 14 ملف توثيق في `docs/` |
| PHASE 1 | Repository + Environment + Database Foundation | ✅ monorepo + migrations + 79 جدولاً |
| PHASE 2 | Authentication + Users + RBAC | ✅ auth (16 route) + RBAC backend + MFA TOTP + اختبارات |
| PHASE 3 | Countries + Languages + Currencies | ✅ geo (15 route) + ar/fr/en/zh + currency engine — ⚠️ لا اختبار مخصص لـ geo |
| PHASE 4 | Products + Categories + Suppliers + Merchants | ✅ (مع RBAC + اختبارات) |
| PHASE 5 | Search + Marketplace | ✅ search موحّد + Marketplace/RTL |
| PHASE 6 | Orders + Transactions + Commission + Ledger | ✅ Commission عبر Policy Engine (غير hardcoded) + Ledger مُختبر |
| PHASE 7 | Inventory + Business Tools | ✅ movements + low-stock notifications + audit |
| PHASE 8 | Messaging + Notifications | ✅ threads/messages/read + notifications + preferences + اختبارات |
| PHASE 9 | Verification + Trust | ✅ verification requests + trust scores explainable + اختبارات |
| PHASE 10 | Risk + Fraud | ✅ risk profiles/events + reason codes + اختبارات |
| PHASE 11 | Dispute Center | ✅ إنشاء/رسائل/أدلة + admin assign/status/decide + **الاستئناف (Appeal)** + سياسة per-country (COUNTRY→GLOBAL) + اختبارات مخصصة (18 حالة) + E2E (3) |
| PHASE 12 | Advertising | ✅ campaigns/creatives/events + stats + RBAC + اختبارات + E2E |
| PHASE 13 | AI Core + AI Agents | ✅ 21 route + 11 وكيلاً + cost-control/budgets + provider قابل للتبديل (OpenAI-compatible + Anthropic) + أسبقية طراز/مزوّد صحيحة + timeout و503 آمن بلا تسريب + اختبار تكامل حقيقي للأطراف (16 حالة) |
| PHASE 14 | Subscriptions + Revenue | ✅ خطط/subscribe/change/cancel/فواتير + rollover موصول بـ`POST /api/subscriptions/admin/rollover` + scheduler in-process (idempotent عبر optimistic lock) + **تحصيل الفواتير عبر منفذ الدفع** + دورة PAST_DUE/EXPIRED؛ revenue report/scenario موجود |
| PHASE 15 | Admin Dashboard | ✅ stats/entities + engines + AI + analytics + audit |
| PHASE 16 | Analytics | ✅ overview/retention/conversion/revenue-breakdown/daily-kpis/reports + **CAC/LTV/Contribution Margin** (`unit-economics` + cohorts) |
| PHASE 17 | Security + Privacy + Audit | ✅ security headers + argon2id + audit (24 module) + privacy consent/export/deletion مع **anonymization فعلي** + **Email وSMS إنتاجيان** (ports مزوّد-محايدة + تحقق الهاتف OTP) |
| PHASE 18 | Full Testing + E2E | ✅ 364/364 وحدة/تكامل (37 ملف) + 52/52 E2E + typecheck 0/0 + build PASS |
| PHASE 19 | Performance + Optimization | ✅ Load harness (p95 budget) + فهارس مركّبة مُثبَتة بـEXPLAIN + read cache (commit `fc8d368`)؛ build إنتاجي/HEALTHCHECK/non-root + metrics/tracing/rate-limit سابقًا |
| PHASE 20 | Staging | 🟡 Docker Compose Stack كامل (db+api+web) + خطوة إصدار migrate→seed→serve + CI؛ بيئة staging مستضافة ⏳ |
| PHASE 21 | Production Readiness | 🟡 Dockerfile/Dockerfile.web + CI + health checks + secrets من البيئة؛ **Backups (مؤتمتة + مُختبَرة + مجدولة عبر compose/cron/systemd) + monitoring/alerting (قاعدة `backup_stale` فعّالة)** ✅ | بيئة إنتاج مستضافة + WAL/تشفير نسخ + جسر تنبيه مركزي ⏳ |
| — (مستقبلي) | WASIT AI COPILOT (اختياري للتاجر) | ⏳ مواصفة فقط — طبقة تنسيق/محادثة فوق الـAgents القائمة؛ لا يحذف ولا يدمج أي Agent، وكل الـ11 وكيلًا تبقى مستقلة؛ extensible عبر Agent Registry؛ لا يتجاوز RBAC؛ تأكيد التاجر للإجراءات المالية؛ نتائج من بيانات فعلية؛ Audit لكل action. التفاصيل في `docs/AI_ARCHITECTURE.md` §6.5 و`docs/ARCHITECTURE_DECISIONS.md` (AD-043). **غير منفَّذ ولا مُقنَّن في أي Phase.** |

## الأولويات القادمة (حسب الاعتماد المنطقي)

راجع قائمة Production Gaps الكاملة في نهاية هذا الملف؛ الترتيب المختصر:

1. Payment Provider تكاملي + Webhooks + Refunds (يعتمد عليه التسوية الفعلية).
2. Dispute Appeal + Dispute Policy per-country + اختبار disputes.
3. Subscriptions: تحصيل الفواتير (دفع التجديد) + دورة إلغاء/انتهاء — الجدولة ✅ منجزة.
4. Analytics: CAC/LTV/Contribution Margin + اختبار KPI ✅ منجزة (`GET /api/admin/analytics/unit-economics` و`/cohorts` + `unit-economics.test.ts`).
5. SEO (sitemap/robots/canonical/structured data).
6. Email/SMS إنتاجي: ✅ البريد (SMTP port + قوالب + Audit) وSMS (HTTP port + تحقق الهاتف OTP + Audit) منجزان ومختبران؛ توسيع قوالب الإشعارات يبقى ضمن محرّك Messaging.
7. Data deletion execution (anonymization) ✅ منجزة ومختبرة (Milestone I + J)؛ الجدولة الآلية بعد انتهاء نافذة الاستبقاء ✅ منجزة (Milestone J).
8. Geo testing + اختبار توسّع بلد جديد.
9. Observability/Tracing + Rate limiter distributed + Load testing.
10. Staging + Production hardening (Docker/CI/health/monitoring).

## مبدأ العمل بين المراحل

- بعد كل مرحلة: شغّل `npm test` في `packages/server`.
- أصلح الأخطاء قبل الانتقال.
- لا تعتبر Mockup وظيفة مكتملة.
- وثّق أي قرار جديد في `docs/ARCHITECTURE_DECISIONS.md`.