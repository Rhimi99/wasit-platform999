# OFFICIAL PROJECT BASELINE — WASIT BUSINESS GLOBAL

> **نوع الوثيقة**: BASELINE رسمي مُجمَّد (تحليل/توثيق فقط — لا Production Code تغيّر).
> **Baseline date**: 2026-09-23 (UTC)
> **HEAD commit**: `99c965e` — `M7 audit: make admin reports refresh assertion robust to the 20-row list cap`
> **Branch**: `master`
> **Git status**: clean (`git status --short` فارغ)

هذه الوثيقة تُثبّت نقطة قياس رسمية. لا تُفتح العناصر المغلقة (B18 → M7، Marketing Video
duration، M7 budget fix) إلا عند اكتشاف Regression حقيقي.

---

## 1. ملخص النسب

| المقياس | القيمة | الطريقة |
| --- | --- | --- |
| **PROJECT COMPLETION** | **86%** | 136.0 / 158 وزناً على كل النطاق المُعرَّف (يشمل الـRoadmap غير المنفَّذ) |
| **SOFTWARE/PRODUCT COMPLETION** | **93%** | 136.0 / 146 — نفس البسط، مقام يستثني عناصر الـRoadmap |
| **LAUNCH READINESS** | **73%** | متوسط 4 بوابات: الكود + التحقق الآلي + إغلاق الفجوات + التهيئة الخارجية |

> لا يُعلن «100%»: متطلبات الـMaster Spec/Roadmap (Business Calculator، Business/Market Map،
> Recommendations، Offers، ووحدات إدارية للدول/العملات/اللغات، وWASIT AI COPILOT) غير منفَّذة،
> و7+ متطلبات بنية خارجية غير مُهيّأة فعليًا.

---

## 2. طريقة الحساب (قابلة للتدقيق)

مخزون موحّد من **158 عنصراً** في ثلاث طبقات غير متكرّرة (كل عنصر يُحتسب مرة واحدة):

| الطبقة | العدد | ✅ | 🟡 | 🔵 | ⬜ | النقاط |
| --- | --- | --- | --- | --- | --- | --- |
| A — Phase/Roadmap | 23 | 21 | 1 | 0 | 1 | 21.5 |
| B — Backend Modules | 30 | 30 | 0 | 0 | 0 | 30.0 |
| C — UI/Feature Surfaces | 105 | 74 | 19 | 0 | 12 | 84.5 |
| **الإجمالي** | **158** | **125** | **20** | **0** | **13** | **136.0** |

الأوزان: ✅ = 1.0 · 🟡 = 0.5 · 🔵 = 1.0 للكود (يُحتسب منفصلاً في Launch) · ⬜ = 0.0.

- **PROJECT COMPLETION** = 136.0 / 158 = **86.1%**
- **SOFTWARE/PRODUCT COMPLETION** = 136.0 / (158 − 13 عنصر Roadmap) = 136.0 / 145 = **93.8%**
- **LAUNCH READINESS** = متوسط (93.8% كود · 100% تحقق آلي · 98.2% إغلاق فجوات · 0% تهيئة خارجية) = **73.0%**

### توزيع طبقة A — Phase/Roadmap (23)
- ✅ P0–P20: 21 مرحلة مكتملة (P20 مكتمل داخل نطاق الريبو).
- 🟡 P21 Production Readiness: جزئي (Docker/CI/health/backup/monitoring منجزة؛ بيئة إنتاج مستضافة ⏳).
- ⬜ WASIT AI COPILOT: مواصفة فقط (`AI_ARCHITECTURE.md` §6.5، AD-043).

### توزيع طبقة C — UI/Feature Surfaces (105)

| المجموعة | العدد | ✅ | 🟡 | ⬜ | البنود الناقصة/الجزئية |
| --- | --- | --- | --- | --- | --- |
| Public/Marketplace | 14 | 12 | 0 | 2 | Business Calculator، Business/Market Map |
| Customer | 14 | 12 | 1 | 1 | Settings (🟡)، Recommendations (⬜) |
| Merchant | 18 | 12 | 6 | 0 | Customers/Suppliers/Sales/Expenses/Profit/Settings (🟡 placeholder) |
| Supplier | 18 | 13 | 4 | 1 | Buyers/Merchants/Price Management/Settings (🟡)، Offers (⬜) |
| Company | 15 | 9 | 6 | 0 | Branches/Suppliers/Buyers/Employees/Finance/Reports (🟡 placeholder) |
| Admin | 26 | 16 | 2 | 8 | Payments/Refunds (🟡)، Merchants/Suppliers/Companies/Categories/Countries/Currencies/Languages/Commissions (⬜) |
| **الإجمالي** | **105** | **74** | **19** | **12** | |

المصدر: `docs/UI_SCREEN_MAP.md` (العامة + شاشات كل دور). أي شاشة لها Route فعلي لكن محتواها
Placeholder بلا Backend حقيقي تُصنَّف 🟡؛ وأي شاشة مطلوبة وغير موجودة أصلاً تُصنَّف ⬜.

### توزيع طبقة B — Backend Modules (30)
كل وحدات `packages/server/src/modules`: admin, ads, ai, analytics, auth, categories, companies,
comparison, customer-library, disputes, geo, health, inventory, merchants, media, messaging,
notifications, observability, orders, payments, privacy, products, revenue, risk, search, seo,
subscriptions, suppliers, trust, verification → **30/30 لكلٍّ route + service + اختبارات**.

---

## 3. Completed Phases
P0 Architecture/Docs · P1 Repo/DB · P2 Auth/Users/RBAC/MFA · P3 Countries/Languages/Currencies ·
P4 Products/Categories/Suppliers/Merchants · P5 Search/Marketplace · P6 Orders/Transactions/Commission/Ledger ·
P7 Inventory/Business Tools · P8 Messaging/Notifications · P9 Verification/Trust · P10 Risk/Fraud ·
P11 Dispute Center (+Appeal +per-country) · P12 Advertising · P13 AI Core/AI Agents ·
P14 Specialized AI Executors · P15 Admin Dashboard · P15+ Price Comparison Engine · P16 Analytics (+Unit Economics) ·
P17 Security/Privacy/Audit · P18 Full Testing/E2E · P19 Performance/Optimization · P20 Staging (repo scope).

## 4. Completed Modules
الـ30 وحدة Backend أعلاه + محركات `lib/*`: commission (Policy Engine), inventory-engine, audit, security,
request-context, seller-ownership, ai/* (provider/routing/runtime/cost-control/endpoints), read-cache, money/decimal.
مغلقة أيضاً فجوات B1–B20 وM1–M7 وA1–A5 وC1–C5 وD1–D3 وF1–F4 (ما عدا البنية الخارجية).

## 5. Remaining Roadmap
- Business Calculator `/tools/calculator`
- Business/Market Map `/map`
- Recommendations (Customer)
- Offers (Supplier)
- Placeholder role surfaces: Customers, Suppliers, Sales, Expenses, Profit, Buyers, Merchants,
  Branches, Employees, Finance, Reports (role-scoped)
- Admin: Merchants / Suppliers / Companies / Categories / Countries / Currencies / Languages / dedicated Payments desk
- WASIT AI COPILOT (optional, spec-only)
- P21 Production Readiness (external part)

## 6. External Dependencies (كود جاهز — يحتاج تهيئة خارجية)
1. بيئة Staging مستضافة فعلية (VM + نطاق + DNS/TLS + أسرار منفصلة) — E1
2. بيئة Production مستضافة + نشر
3. Credentials حقيقية لمزوّد الدفع + Webhooks + onboarding (ClicToPay/Flouci/Stripe) — A1
4. Backups: WAL streaming + تشفير + تخزين offsite — E4
5. جسر تنبيه مركزي حقيقي (`OBS_ALERT_NOTIFY=webhook` endpoint) — E5
6. Credentials مزوّد Email/SMS إنتاجي (SMTP/HTTP ports موجودة)
7. Legal/Operational: PCI/compliance، DPA، شروط الاستخدام (خارج الريبو)

## 7. Known Limitations
- شاشات Placeholder (🟡) تعرض حالة فارغة/معلوماتية ولا تنفّذ عمليات.
- AI Provider الحقيقي مُتحقق تكاملياً (F3) لكن التشغيل الإنتاجي يحتاج مفاتيح.
- Marketing Video يولّد MP4 فعلياً (35–120s) ويُقاس مدة الـMP4 الحقيقي.
- الدفع يعمل بمحوّلات (adapters)؛ التحصيل الفعلي بلا مزوّد حي لا يكتمل.

## 8. Real Production Gaps
**0** — لا توجد وظيفة مطلوبة وموجودة لكنها مكسورة (❌ = 0). الفجوة F1 (Roadmap drift) كانت
مُصلَحة ومثبّتة. كل المتبقي هو ⬜ Roadmap أو 🔵/⏳ بنية خارجية، وليس كسراً.

## 9. Verification Snapshot
| البند | القيمة |
| --- | --- |
| E2E | **181/181 PASS** (25 spec، Playwright/Chromium) |
| Server Unit/Integration | **534/534 PASS** (51 ملف) |
| Typecheck | server + web PASS (`tsc --noEmit`) |
| Build | server + web PASS |
| DB | PostgreSQL — **87 table**، migrations **24** (آخرها `0023_indexes`) |
| DB/migration actions | لا reset/drop/push — لم تُضف migration |
| Git tree | clean على `99c965e` |

## 10. Frozen Policies (Baseline)
- **Commission Policy**: 4% إجمالياً = **2% seller + 2% buyer**، عبر Policy Engine (غير Hardcoded).
- **Marketing Video duration**: **35–120s** inclusive، مع قياس مدة MP4 الحقيقي (commit `7da060f`).
- **M7 AI budget identity**: upsert يطابق `(target, period)` (commit `e0408fc`).
- **Audit stability**: commit `99c965e`.

## 11. شروط تمنع اعتبار المشروع 100%
1. 12 عنصر Roadmap غير منفَّذ (بما فيها WASIT AI COPILOT).
2. 18 واجهة جزئية (Placeholder) بلا Backend تشغيلي كامل.
3. 7+ متطلبات بنية خارجية غير مُهيّأة (Hosting/Credentials/Backups/Monitoring/Legal).
4. P21 Production Readiness لم تكتمل بيئياً.

---

**Baseline locked at** `99c965e`. أي تغيير لاحق يتطلب Regression حقيقي موثّق أو أمر منفصل.
