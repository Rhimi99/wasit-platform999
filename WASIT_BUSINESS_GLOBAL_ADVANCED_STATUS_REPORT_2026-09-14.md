# WASIT BUSINESS GLOBAL — Advanced Status Report

> **التاريخ**: 2026-09-14 (22:03 UTC)
> **الفرع**: `feat/messaging-notifications`
> **HEAD**: `e9435c6287f9f75d027d27d9c66e194caf98a307`
> **Tag**: `checkpoint-master-2026-09-14`
> **نوع التقرير**: MASTER CHECKPOINT — Advanced Status (قراءة شاملة + توقيع)

---

## 1. الملخص التنفيذي (Executive Summary)

منصة WASIT BUSINESS GLOBAL هي وسيط تجاري عالمي (B2B/B2C) مبني على Monorepo
(`packages/server` + `packages/shared` + `packages/web`)، بواجهة عربية أولاً (RTL)
ودعم لغات (ar/fr/en + zh).

**الوضع في هذا MASTER CHECKPOINT:**
- أكتملت المراحل **0→12** بالكامل (Auth+RBAC، Categories، Products، Search،
  Orders+Commission+PaymentFee+Ledger، Inventory، Messaging/Notifications،
  Verification+Trust، Risk، Disputes، Advertising Phase 12).
- **Phase 13 (AI Core + 11 Agents)** — مكتملة.
- **Phase 14 (Specialized AI Executors)** — مكتملة.
- **Phase 15 (Advertising + AI Ads)** — **مكتملة التنفيذ والاختبار** (أُدخلت في هذا
  الـ checkpoint commitment). تتضمن `runAdsRecommendations` وملخّص Admin ووصلة Web حقيقية.
- **غير مبدوء**: Phase 16 (Analytics Dashboard) وما بعدها — ممنوع حتى أمر منفصل.
- الفحوص: **94/94 Test (10 files)** · Server/Web Typecheck نظيف · Web Build ناجح.

---

## 2. مرجعية المستودع (Repository Reference)

| البند | القيمة |
| --- | --- |
| الفرع | `feat/messaging-notifications` |
| HEAD | `e9435c6287f9f75d027d27d9c66e194caf98a307` |
| Commit checkpoint | `chore: create master project checkpoint` |
| Tag | `checkpoint-master-2026-09-14` |
| آخر 10 Commits | `e9435c6 → f520d2e (P14) → 19aa88b (P13) → 8378542 (tag AI foundation) → ef0ec6d (P12 ads) → 9b3ca17 → 867247c → 5f9787f (tag 2026-09-13) → 3247ef0 → 1b77fee` |
| تتبع | `AGENTS.md` (ذاكرة الوكيل)، `CHECKPOINT.md` (ملف checkpoint)، `docs/*` (وثائق معماري) |
| ZIP | `WASIT_BUSINESS_GLOBAL_MASTER_CHECKPOINT_2026-09-14.zip` |

**ملاحظة أمان**: لا push متاح للـ remote الحالي (مقيّد بالـ token سابقاً —
موثّق في docs). الـ commit محلي فقط.

---

## 3. بنية النظام (Architecture)

- **Monorepo** npm workspaces:
  - `packages/server` — TypeScript + **Hono** + **Drizzle ORM** + PostgreSQL + zod + argon2 + decimal.js
  - `packages/shared` — Constants (Roles, Permissions, RBAC matrix), ApiError, validation, types
  - `packages/web` — React + Vite + Tailwind (RTL/LTR جاهزة؛ i18n ar/fr/en/zh)
- **Server modules (23)**: admin, ads, ai, analytics(فارغ), auth, categories, companies,
  disputes, geo(فارغ), health, inventory, merchants, messaging, notifications, orders,
  products, risk, search, suppliers, transactions(فارغ), trust, users(فارغ), verification
- **Libs**: `lib/ai/*` (provider/routing/runtime/cost-control/endpoints/self-endpoints/types),
  `lib/inventory-engine.ts`, `lib/audit.ts`, `lib/security.ts`, `lib/request-context.ts`, `lib/seller-ownership.ts`
- **DB Schema (18 ملف)**: ads, agents, ai, analytics, audit, auth, commerce, commerce_extras,
  disputes, engine, geo, index, messaging, products, risk, subscriptions, trade, trust

> ملاحظة: مجلدات فارغة (analytics/geo/users/transactions) = جداول موجودة في SQL لكن
> لن تُبنى خدماتها إلا في المراحل المخططة لاحقاً (لا Mock بدلاً منها).

---

## 4. قاعدة البيانات (Database)

| القاعدة | الحالة | الجداول | ملاحظات |
| --- | --- | --- | --- |
| `wasit_dev` (live) | PostgreSQL 17 على `/workspace/pgdata` (Persistent) | **74** | 5 عملات، 3 لغات، 1 دولة، 24 region، 33 مدينة، 10 أدوار، 11 وكيلاً، 3 نماذج AI، 9 ai_requests، 10 agent_tasks |
| `wasit_test` | يُعاد بناؤه في كل `vitest run` | **74** | drop+create+migrate+seed عبر `tests/setup.ts` |

**Migrations**: `0000_cheerful_maddog.sql` → `0001_inventory-variant-unique.sql` →
`0002_messaging-status-readat.sql` → `0003_redundant_golden_guardian.sql` →
`0004_ai_core_agents.sql`.

**Seed**: roles/permissions/countries/currencies/categories/policies (commission BASE 3%,
payment_fee_default 2%) عبر `src/scripts/seed.ts`؛ مستخدمو demo عبر `seed-demo.ts`.

---

## 5. الحالة الوظيفية التفصيلية (18 تصنيفاً صارماً)

> Legend: ✅ = كامل · 🟡 = جزئي · ⚠️ = عقد (contract) · 🚧 = غير مبني

| # | النظام | الحالة | الدليل (Code/DB/Tests) |
| --- | --- | --- | --- |
| 1 | Auth + Sessions | ✅ كامل | register/login/logout + argon2 + cookie session + `/sessions` + reset; اختبار في vertical-slice |
| 2 | RBAC (10 أدوار) | ✅ كامل | `shared/constants/*` + `requireRole/requirePermission`; `admin-access.test.ts` |
| 3 | Categories | ✅ كامل | `modules/categories`; CRUD + list + search |
| 4 | Products (SKU/variants/images) | ✅ كامل | `modules/products`; drafts/variants/inventory/status |
| 5 | Suppliers/Merchants/Companies | ✅ كامل | `modules/{suppliers,merchants,companies}`; owners + RBAC |
| 6 | Search (موحّد) | ✅ كامل | `modules/search`; products/suppliers/categories/merchants/companies + filters |
| 7 | Orders + Commission + PaymentFee + Ledger | ✅ كامل | Policy-engine (لا نسب Hardcoded) + `transactionLedger`; `payment-fee-policy.test.ts`, `vertical-slice.test.ts` |
| 8 | Inventory + Movements | ✅ كامل | `modules/inventory` + `lib/inventory-engine.ts`; reservations/sale/purchase/adjust; `inventory.test.ts` |
| 9 | Messaging + Notifications | ✅ كامل | `modules/messaging` + `modules/notifications`; threads/read-status; `messaging.test.ts` |
| 10 | Verification (4 مستويات) | ✅ كامل | `modules/verification`; requests + Admin review; `verification-trust.test.ts` |
| 11 | Trust Engine (قابل للتفسير) | ✅ كامل | `modules/trust`; factors → score/level/summary; منفصل عن Risk |
| 12 | Risk Engine (Staff) | ✅ كامل (Admin) | `modules/risk` + Admin reassess; `RISK_*` perms |
| 13 | Dispute Center | ✅ كامل | `modules/disputes`; open/evidence/messages/decide/audit; Policy `DISPUTE_RESOLUTION` |
| 14 | Advertising Engine (Phase 12) | ✅ كامل | `modules/ads`; campaigns/creatives/events/stats/served + RBAC `AD_*`; `ads.test.ts` (11) |
| 15 | AI Core + Agents (Ph 13/14) | ✅ كامل | `lib/ai/*` + `modules/ai/*`; 11 agents + executors متخصصة; `ai-core.test.ts` (13), `phase14-agents.test.ts` (20) |
| 16 | **AI Ads (Phase 15)** | ✅ كامل | `runAdsRecommendations` + `POST /api/ai/ads-recommendations` + `GET /api/admin/ads/summary` + Web UI + i18n; `phase15-ads-ai.test.ts` (5) |
| 17 | Subscriptions / Billing | 🚧 غير مبني | جداول موجودة؛ المرحلة 14 مخططة (لم تبدأ) |
| 18 | Analytics Dashboard / Geo / Users / Transactions modules | 🚧 فارغ (جداول موجودة) | مخصص للمراحل التالية |

---

## 6. حالة UI/UX

- **RTL/عربي أول** مع Demo users (customer1/suppliera/merchanta/companya/admin — كلمة
  `Passw0rd!2026`).
- **Dashboards**: Customer/Merchant/Supplier/Company عبر `DashboardBusinessPages.tsx`
  مع tabs (Overview, Products, Inventory, Orders, AI, Ads, Trust, Verification, Disputes...).
- **Admin**: `DashboardAdminPages` + `AdminEnginesPages.tsx` (Verification/Trust/Risk/Disputes).
- **AI**: `DashboardAIPage` — أدوات + وكلاء + tasks + marketingVideos.
- **Ads**: `DashboardAdvertisementPage` — حملات + creatives + stats + (جديد) AI Ads Recommendations.
- كل النصوص عبر i18n keys (ar/fr/en/zh) — لا نصوص مباشرة في Components.

**الواجهة Responsive** (Tailwind + mobile-first)، متوافقة مع متطلب Mobile Readiness.

---

## 7. عناصر الأمان (Security)

- Argon2 للكلمات السرية
- جلسات عبر Cookie + SessionHash، مع `isActive`/`isEmailVerified` gates
- RBAC في الـ Backend حصراً + Owner isolation + Tenant isolation
- Zod Validation لكل Body/Query/Params
- Rate limiting (Register/Login) — في الذاكرة (dev)؛ Redis لاحقاً Production
- Audit Logs (`audit_logs`) لكل تغيير حساس (ADMIN.*, AI.*, ADS.*, ORDER.*...)
- `ApiError` منظم (HTTP + code + message + fieldErrors + traceId)
- لا Secrets داخل الريبو (`.env` معزول، `.env.example` أمان)
- حماية الملفات: لا upload endpoints حرجة بعد (مؤجل)

---

## 8. المحرك المالي (Financial Engine)

- **Commission**: من `commission_policies` فقط (default BASE 3% من seed) — لا نسبة
  Hardcoded في الكود (تم التحقق: لا `0.03` في `orders/service.ts`).
- **Payment Fees**: من `payment_fee_policies` (default 2%).
- **Policy Engine**: قابل للتعديل Admin مستقبلاً (يُسجَّل في Audit).
- **Ledger**: `transactionLedger` يسجّل DEBIT/CREDIT لكل معاملة (لا Wallet —
  WASIT لا يحتفظ برصيد).
- العمولة المختبرة: `payment-fee-policy.test.ts` + `vertical-slice.test.ts`.

---

## 9. الذكاء الاصطناعي (AI Core + Agents + Ads)

- **Provider Abstraction**: `local-heuristic` (افتراضي deterministic) / noop /
  OpenAI-compatible / Anthropic — اختيار من env فقط.
- **Cost Control**: budgets per user/role + period window + `ai_usage`/`ai_requests`.
- **Model Routing**: capability→model من `ai_models` + RBAC-aware.
- **11 Agents** (sales, marketing, ads, product, support, analytics, market-research,
  b2b, risk, dispute-assistant, development) — non-gated يشتغل؛ 6 gated بموافقة ADMIN.
- **AI Ads (جديد)**: `runAdsRecommendations` تحلل campaigns+adEvents وتُنتج bestObjective/CTR/CR
  وتكلفة/استخدام عبر `runAIFeatureStructured`. `POST /api/ai/ads-recommendations` (AI_USE).
  `GET /api/admin/ads/summary` (ADMIN/SUPER_ADMIN).

---

## 10. الاختبارات (Testing)

**آخر تشغيل كامل**: `vitest run` = **94/94 PASS — 10 files** (0 failed, 11.17s)

| الملف | الحالات |
| --- | --- |
| `admin-access.test.ts` | 2 |
| `ads.test.ts` | 11 |
| `ai-core.test.ts` | 13 |
| `inventory.test.ts` | 11 |
| `messaging.test.ts` | ~ |
| `payment-fee-policy.test.ts` | 2 |
| `phase14-agents.test.ts` | 20 |
| `phase15-ads-ai.test.ts` (جديد) | 5 |
| `verification-trust.test.ts` | 10 |
| `vertical-slice.test.ts` | ~ |

- تحقق إضافي: Server typecheck 0 خطأ، Web typecheck 0 خطأ، Web build ناجح (71 modules).
- تشغيل: `cd packages/server && npx vitest run`.

---

## 11. الأخطاء / الملاحظات (Known Issues)

1. `analytics`, `geo`, `users`, `transactions` modules — مجلدات فارغة (جداول موجودة).
2. E2E مخصص Phase 15 — لم يُسجَّل (وضع حفظ؛ لا بناء جديد مطلوب). لكن منظومة Ads
   (Phase 12) مُثبتة E2E سابقاً (curl + browser).
3. Rate limiter في الذاكرة — غير مناسب للإنتاج (يتطلب Redis).
4. `wasit_dev` seed بيانات جزئي فقط (لا demo data ممتلئة) — نحتاج أمر منفصل لتشغيل
   `db:seed` + `db:seed:demo` للاختبار live أوسع.
5. **Marketing Video** = CONTRACT فقط (لا Media Pipeline حقيقي / `mediaUrl: null`).

---

## 12. العقود والـ Placeholder

| المكون | الحالة |
| --- | --- |
| `marketingVideos` (marketing-agent) | ⚠️ عقد — `mediaUrl: null`, `mimeType: video/mp4`, previewable/downloadable — لا توليد/مخزن حقيقي |
| Analytics tables | جداول موجودة — لا Routes |
| Geo tables | جداول موجودة — لا Routes |
| Users module | فارغ تماماً (إدارة مستخدمين عبر Admin فقط) |
| Subscriptions billing | مخططة |
| MFA / Phone verify | readiness (بدون تنفيذ فعلي) |
| SEO/Sitemap/Robots | readiness (في docs) |
| File Upload | readiness |

---

## 13. العناية بأمن البيانات / الـ Secrets

- `.env` غير مرفوع (gitignored + مستثنى من ZIP).
- `backups/pg_globals.sql` (hashes SCRAM) غير مرفوع وغير داخل ZIP.
- لا واجهة تعرض بيانات حساسة كاملة إلا ADMIN (كلها خلف RBAC).
- Audit logs لكل وصول حساس.

---

## 14. المعاملات والنقود (Transactions / Money) — زاوية الالتزام

- **لا Wallet** — مطابق للمواصفات.
- لا عمولة Hardcoded — Policy Engine.
- Ledger يدعم: debit/credit، statuses (PENDING/PAID/...)، settlement، refund.
- كل تغيير مالي يسجل event في `audit_logs`.

---

## 15. Global-First (دول/عملات/لغات)

- جداول: `countries`, `regions`, `cities`, `currencies`, `exchange_rates`, `languages`.
- Seed: دولة تونس (1) + 24 region + 33 city + 5 عملات + 3 لغات داعمة (ar/fr/en + zh fallback).
- لا `Tunisia` Hardcoded في الـ Core (قرار معماري موثق).

---

## 16. الأدوار والصلاحيات (RBAC Matrix)

- 10 أدوار: CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER, SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN
- `ROLE_HIERARCHY`: CUSTOMER=0, MERCHANT/SUPPLIER/COMPANY/MARKETER=1, SUPPORT=40, RISK=50, DISPUTE=50, ADMIN=90, SUPER_ADMIN=100
- Permissions (من `PERMISSIONS`): AI_USE، AI_MANAGE، ADMIN_*, DISPUTE_*, TRUST_*, RISK_*, VERIFICATION_*, AD_*, CAMPAIGN_*, ORDER_*, PRODUCT_*...
- مفصل في `docs/PERMISSIONS_MATRIX.md`.

---

## 17. الحالة مقابل أهداف القاعدة (DoD)

| المتطلب | الحالة |
| --- | --- |
| UI | ✅ (حقيقية عبر API) |
| Backend | ✅ |
| Database | ✅ |
| API | ✅ |
| Validation | ✅ (zod) |
| Auth | ✅ |
| Authorization | ✅ (RBAC backend) |
| Error Handling | ✅ (ApiError + traceId) |
| Audit | ✅ |
| Tests | ✅ 94/94 |
| Responsive | ✅ |
| Documentation | ✅ (docs/ + checkpoint) |

---

## 18. الإنفاق/الأداء (Performance & Cost notes)

- AI default provider = `local-heuristic` (بدون مفتاح) → **صفر تكلفة خارجية** حتى تفعيل مفتاح LLM.
- Cost Control Layer يقيّد budgets قبل كل `runAIFeature`.
- Web build: 381.72 kB JS (gzip 103.44 kB) — خفيف.
- Backend modular (23 modules) — سهل الصيانة؛ الاحتياج إلى Redis للـ rate-limit.

---

## 19. التوصيات التالية (Recommended Next Steps — لا تنفيذ دون أمر)

1. **الموافقة على تشغيل Dummy/Seed للبيانات** في `wasit_dev` (db:seed + seed:demo).
2. **Phase 16 (Analytics Dashboard)** — حين يسمح المسار (عند إذن منفصل).
3. **Media Pipeline** لملء `marketingVideos.mediaUrl` بوظيفة حقيقية.
4. **Redis Rate Limiter** قبل الإنتاج + إدخال Secrets Management (Vault/произв).
5. **Staging environment** + CI (اختبارات تلقائية عند push) + backups مجدولة.

---

*أُعد بواسطة الوكيل (OpenHands) بناءً على فحص Read-Only شامل. التقرير يطابق الحالة
المرجعية في `CHECKPOINT.md` والإشارة المرجعية `checkpoint-master-2026-09-14`.*