# WASIT-MASTER-REFERENCE — المرجع الرسمي الموحّد لمنصة WASIT BUSINESS GLOBAL

> **نوع الوثيقة**: مرجع رسمي موحّد (توثيق فقط — لا تغيير في الكود ولا في قاعدة البيانات).
> **المهمة**: WASIT-01 — UNIFIED MASTER REFERENCE & GAP REGISTER.
> **تاريخ المراجعة**: 2026-10-31 (UTC)
> **HEAD الذي تمت عليه المراجعة**: `1cccbe8ce426ae0ee21f8a08c9d1961b73790ed8`
> **الفرع**: `ci/repair-sandbox-2u-g-20261020-190057`
> **حالة Git**: نظيف قبل الإنشاء (`git status --short` فارغ، `git diff --check` نظيف، ahead/behind = 0/0)

---

## 0. إفصاح إلزامي عن مصادر المخططين (A و B)

**تنبيه دقّة:** المخططان المرجعيان **Reference A** و **Reference B** لم يُوجدا داخل بيئة OpenHands
(لا في نظام الملفات، ولا في سجل Git، ولا في المحادثة كمرفقات، ولا على البعيد).

**لم أفحص أي ملف صورة فعلياً بنفسي.** محتوى المخططين وصلني على مرحلتين:

1. **وصف نصي مختصر** في محادثة WASIT-01 (قوائم نقطية عامة).
2. **مواصفات كاملة** (COMPLETE MASTER REFERENCE SPECIFICATION) صرّح صاحب المشروع أنها **مستخرجة
   من الصورتين الأصليتين** اللتين قدّمهما، وقد وردت في محادثة هذه المهمة.

كل إسناد إلى «Diagram A» أو «Diagram B» في هذا المرجع يعني **المواصفات النصية الكاملة المستخرجة
من الصورتين**، لا ملف صورة فحصتُه بنفسي. النسخة الكاملة منقولة حرفياً في
[القسم 2](#2-المخططات-المرجعية-الكاملة-كما-وصلت-من-صاحب-المشروع).

**لا توجد أدلة كافية على أسبقية A على B أو العكس**، وبناءً على تعليمة المهمة لا يُفترض أن أحدهما
«النسخة التاريخية الأصلية». يُعاملان كمصدرين **متكافئين ومستقلّين**، ويُسجَّل كل اختلاف بينهما صراحةً.

**أرقام الإنجاز في الصورتين ليست حقائق تنفيذية.** كل رقم حالة في هذا المرجع مصدره **فحص المستودع
(WASIT-00)** أو أدلة كود أُعيد التحقق منها، لا أرقام الصور. (تفصيل في
[القسم 5](#5-الوضع-العام-ملخص-تنفيذي)).

---

## 1. الغرض والنطاق

هذا المرجع يوحّد ثلاثة مصادر في سجل واحد قابل للتدقيق:

1. **تقرير WASIT-00** — الخريطة الوظيفية المستخرجة من المستودع (الأدلة الفعلية).
2. **Reference A** — مخطط البناء الكامل: `WASIT BUSINESS GLOBAL — FULL BUILD PLAN (FROM ZERO TO
   PRODUCTION)`، ويتكوّن من **12 قسماً رئيسياً**.
3. **Reference B** — مخطط البناء الكامل: نفس العنوان، ويتكوّن من **10 أقسام رئيسية**.

**المبادئ الحاكمة لهذا المرجع:**

- كل متطلب يُنسب إلى مصدره (`Diagram A` / `Diagram B` / `A+B` / `WASIT-00`).
- لا تُسقط أي وظيفة وردت في أي من المخططين، حتى لو لم يوجد لها أثر في الكود.
- **يُفصَل دائماً بين خمسة مستويات** (انظر [القسم 6](#6-منهجية-التصنيف-خمسة-مستويات-منفصلة)):
  وجود الكود · نجاح الاختبارات · العمل الفعلي · جاهزية الإنتاج · الاعتماد القانوني/التعاقدي.
- لا يُوصف أي بند بأنه «مكتمل» أو «يعمل» دون دليل مسار وملف واختبار.
- أي استنتاج غير متحقق منه في الكود يُوسَم صراحةً `UNVERIFIED`.
- **غياب كلمة أو ملف ليس حكماً نهائياً بغياب الوظيفة** قبل فحص البدائل (مسار بديل، جدول مختلف،
  تنفيذ جزئي) — يُوثَّق في عمود الملاحظات.
- الوثائق القديمة ليست دليلاً أقوى من الكود والاختبارات الحالية.

---

## 2. المخططات المرجعية الكاملة كما وصلت من صاحب المشروع

> **المصدر**: مواصفات نصية كاملة صرّح صاحب المشروع أنها مستخرجة من الصورتين الأصليتين. منقولة هنا
> حرفياً بلا حذف، لتبقى مصدراً مرجعياً دائماً.

### 2.1 REFERENCE A — المخطط الأول

**العنوان**: `WASIT BUSINESS GLOBAL — FULL BUILD PLAN (FROM ZERO TO PRODUCTION)`
**عدد الأقسام الرئيسية**: 12

#### 1. USERS & CHANNELS — المستخدمون والقنوات

- Customers — العملاء.
- Merchants — التجار.
- Suppliers — الموردون.
- Administrators — الإدارة.
- Mobile Apps — تطبيقات الهاتف.
- Web App — تطبيق الويب.
- Partners / API Clients — الشركاء وعملاء API.
- AI Agents — وكلاء الذكاء الاصطناعي.

#### 2. ACCESS & EDGE LAYER — طبقة الوصول والحماية

- Global CDN.
- WAF / DDoS Protection.
- Load Balancer.
- API Gateway.
- Rate Limiting.
- Request Validation.
- Security Headers.

#### 3. APPLICATION & INTEGRATION LAYER

- Web App (React).
- Mobile Apps (iOS / Android).
- REST / tRPC API.
- Type-safe APIs.
- WebSocket / Real-time.
- Third-party integrations.

#### 4. CORE BUSINESS SERVICES LAYER

**Marketplace**: Products · Categories · Search · Filters · Reviews.

**Orders & Transactions**: Orders · Order Status · Invoices · Returns · Cancellations.

**Payments (No Wallet)**: Payment Methods · Payment Gateway · Payment Status · Refunds.

**Invoicing Engine**: Invoice Generation · Tax Rules by Country · PDF / Email / Print ·
E-Invoicing Compliance.

**Logistics Integration**: Carriers · Shipping Rates · Create Shipment · Tracking · Shipping Zones.

**Suppliers**: Supplier Profile · Products · Orders · Analytics.

**Merchants**: Merchant Profile · Store Management · Products · Analytics.

**Customers**: Profile · Addresses · Preferences · Notifications.

**Digital Products**: Products · Files · Secure Delivery · Access Control.

**Services**: Services · Freelance · Appointments · Bookings.

**Advertising & Promotions**: Ads Platform · Campaigns · Banners · Coupons.

**Subscriptions**: Plans · Subscriptions · Billing · Renewals.

**Analytics & Reports**: Dashboards · Reports · KPIs · Data Insights.

**AI & Intelligence**: Recommendations · AI Assistants · Predictions.

**Notifications**: In-App · Email · SMS · Push.

**Support & Tickets**: Tickets · Chat · Knowledge Base · SLA.

#### 5. DATA & STORAGE LAYER

- PostgreSQL Database.
- Drizzle ORM.
- Row Level Security (RLS).
- Redis Cache.
- Object Storage (S3 Compatible).
- Search Engine.
- Real-time Subscriptions.

#### 6. INFRASTRUCTURE & DEVOPS LAYER

- Docker & Containers.
- Kubernetes (Optional).
- CI / CD Pipeline.
- Git Repository.
- Environments: Dev → Staging → Production.
- Monitoring (Prometheus / Grafana).
- Logging.
- Backup & Disaster Recovery.

#### 7. SECURITY & COMPLIANCE LAYER

- Authentication (OAuth / JWT).
- Authorization (RBAC).
- Multi-Tenancy.
- Data Encryption.
- Audit Logs.
- Compliance (GDPR, ISO 27001).
- Secrets Management.
- API Security.

#### 8. DEVELOPMENT ROADMAP

خريطة تطوير تدريجية من الأساسيات إلى التوسع والتحسين المستمر، مقسمة إلى **مراحل مرقّمة من Phase 1
إلى Phase 7**.

#### 9. JOURNEY / EXECUTION

Planning → Analysis → Design → Development → Testing → Security Audit → Staging → Production →
Monitoring → Scaling → **Optimization** → Continuous Improvement.

#### 10. EXTERNAL INTEGRATIONS

- Payment Providers.
- Shipping Providers.
- KYC / Identity Verification.
- Tax / E-Invoicing.
- Email / SMS / Push Providers.
- Maps / Geolocation.
- Social Login.
- Accounting / ERP.

#### 11. FINAL DELIVERABLES

- Complete Source Code.
- Database Schema & Migrations.
- API Documentation.
- User & Admin Panels.
- Mobile Apps.
- Deployment Scripts.
- Environment Configurations.
- Test Suites.
- User Documentation.
- Technical Documentation.
- Training (Optional).

#### 12. OPERATIONS & SUPPORT

- Monitoring & Alerting.
- Performance Optimization.
- Backup & Disaster Recovery.
- Maintenance & Updates.
- Support & SLA.

---

### 2.2 REFERENCE B — المخطط الثاني

**العنوان**: `WASIT BUSINESS GLOBAL — FULL BUILD PLAN (FROM ZERO TO PRODUCTION)`
**عدد الأقسام الرئيسية**: 10

#### 1. USERS & CHANNELS

- Customers.
- Merchants.
- Suppliers.
- Administrators.
- Mobile Apps.
- Web App.
- Partners / API Clients.
- AI Agents.

#### 2. ACCESS & EDGE LAYER

- Global CDN.
- WAF / DDoS Protection.
- Load Balancer.
- API Gateway.
- Rate Limiting.
- Request Validation.
- Security Headers.

#### 3. APPLICATION & INTEGRATION LAYER

- Web App (React).
- Mobile Apps (iOS / Android).
- tRPC / REST API.
- Type-safe APIs.
- WebSocket / Real-time.
- Third-party Integrations.

#### 4. CORE BUSINESS SERVICES LAYER

**Marketplace**: Products · Categories · Search · Filters · Reviews.

**Orders & Transactions**: Orders · Order Status · Returns · Invoices.

**Wasit Money**: Wallet · Balance · Transactions · Ledger.

**Payments**: Payment Methods · Payment Gateway · Payment Status · Refunds.

**Bank Transfers**: Transfer Requests · Verification · Records.

**Shipping & Logistics**: Carriers · Tracking · Rates · Zones.

**Suppliers**: Supplier Profile · Products · Orders · Analytics.

**Merchants**: Merchant Profile · Store Management · Products · Analytics.

**Customers**: Profile · Addresses · Preferences · Notifications.

**Digital Products**: Products · Files · Secure Delivery · Access Control.

**Learn (Education)**: Courses · Lessons · Students · Certificates.

**Services & Ads**: Services · Freelance · Ads Platform · Campaigns.

**Subscriptions**: Plans · Subscriptions · Billing · Renewals.

**Analytics**: Dashboards · Reports · KPIs · Data Insights.

**AI & Intelligence**: Recommendations · AI Assistant · Matching · Predictions.

**Notifications**: In-App · Email · SMS · Push.

**Support & Tickets**: Tickets · Chat · Knowledge Base · SLA.

#### 5. DATA & STORAGE LAYER

- PostgreSQL Database.
- Drizzle ORM.
- Row Level Security (RLS).
- Redis Cache.
- Supabase Storage.
- Search Engine.
- Real-time Subscriptions.

#### 6. INFRASTRUCTURE & DEVOPS LAYER

- Docker & Containers.
- Kubernetes (Optional).
- CI / CD Pipeline.
- Git Repository.
- Environments: Dev → Staging → Production.
- Monitoring (Prometheus / Grafana).
- Logging.
- Backup & Disaster Recovery.

#### 7. SECURITY & COMPLIANCE LAYER

- Authentication (OAuth / JWT).
- Authorization (RBAC).
- Multi-Tenancy.
- Data Encryption.
- Audit Logs.
- Compliance.
- Secrets Management.
- API Security.

#### 8. DEVELOPMENT ROADMAP

خريطة تطوير تتضمن **ثماني مراحل**: التأسيس والبنية الأساسية → الخدمات التجارية → الخدمات المتقدمة →
التحويلات والمالية → التسويق والإعلانات → التشغيل والتكاملات → التوسع → التحسين المستمر.

#### 9. JOURNEY / EXECUTION

Planning → Analysis → Design → Development → Testing → Security Audit → Staging → Production →
Monitoring → Scaling → Continuous Improvement.

#### 10. FINAL DELIVERABLES & PRODUCTION OPERATIONS

- Complete Source Code.
- Database Schema & Migrations.
- API Documentation.
- User & Admin Panels.
- Mobile Apps.
- Deployment Scripts.
- Docker Compose.
- Environment Configurations.
- Test Suites.
- User Documentation.
- Technical Documentation.
- Training (Optional).
- Monitoring & Alerting.
- Performance Optimization.
- Backup & Disaster Recovery.
- Maintenance & Updates.
- Support & SLA.

---

### 2.3 الفروق البنيوية الكاملة بين A و B (13 بنداً)

> يجب أن يسجّل السجل هذه الفروق كلها. لا يُفترض أن أحدهما «النسخة النهائية».

| # | الوظيفة | Reference A | Reference B | التصنيف |
|---|---|---|---|---|
| 1 | Payments | `Payments (No Wallet)` | `Payments` (مستقلة عن Wallet) | **تعارض مباشر** — يحسمه D3 (Wallet = EXCLUDED) |
| 2 | Wasit Money / Wallet | **لا** | **نعم** (Wallet · Balance · Transactions · Ledger) | **تعارض مباشر** — يحسمه D3 |
| 3 | Bank Transfers | غير موجودة كقسم مستقل | **نعم** (Transfer Requests · Verification · Records) | بند B إضافي → `NEEDS_DECISION` |
| 4 | Invoicing Engine | **نعم، مستقل ومفصل** (Generation · Tax Rules by Country · PDF/Email/Print · E-Invoicing Compliance) | غير ظاهر كقسم مستقل | فرق نطاق وظيفي |
| 5 | Tax Rules / E-Invoicing | **مفصّلة** | غير مفصّلة | فرق تفصيل |
| 6 | Logistics | `Logistics Integration` (Carriers · Shipping Rates · Create Shipment · Tracking · Shipping Zones) | `Shipping & Logistics` (Carriers · Tracking · Rates · Zones) | نفس الوظيفة بصياغتين + A يضيف `Create Shipment` و`Shipping Rates` |
| 7 | Digital Products | **نعم** (Products · Files · Secure Delivery · Access Control) | **نعم** (نفسها) | متطابق |
| 8 | Services | `Services` **منفصل** ويشمل **Freelance + Appointments + Bookings** | `Services & Ads` **مدمج** وبلا Appointments/Bookings | **فرق وظيفي** (لا تنظيمي) |
| 9 | Learn / Education | **لا** | **نعم** (Courses · Lessons · Students · Certificates) | بند B إضافي → `NEEDS_DECISION` |
| 10 | Advertising | `Advertising & Promotions` **وحدة مستقلة** وتشمل **Banners + Coupons** | `Services & Ads` مدمج وبلا Banners/Coupons | **فرق وظيفي** (لا تنظيمي) |
| 11 | Storage | `Object Storage (S3 Compatible)` | `Supabase Storage` | فرق مزوّد |
| 12 | External Integrations | **قسم مستقل** (§10، 8 بنود) | `Third-party Integrations` (بند داخل §3) | فرق تنظيمي |
| 13 | طبقة النهاية | `Operations & Support` (قسم مستقل §12) | `Production & Operations` (مدمج في §10) | فرق تنظيمي |

### 2.4 فروق إضافية في الطبقات الأخرى

| البند | Reference A | Reference B | التصنيف |
|---|---|---|---|
| عدد الأقسام الرئيسية | 12 | 10 | فرق بنيوي |
| مراحل Roadmap | Phase 1 → Phase 7 (7 مراحل) | 8 مراحل | فرق عدد |
| Journey / Execution | يشمل **Optimization** | **بلا Optimization** | فرق خطوة |
| AI & Intelligence | Recommendations · AI Assistants · Predictions | Recommendations · AI Assistant · **Matching** · Predictions | B يضيف `Matching` |
| Final Deliverables | 11 بنداً | 12 بنداً (**+ Docker Compose**) + Production & Operations (5 بنود) | B أوسع |
| Compliance | `GDPR, ISO 27001` (مسمّى) | `Compliance` (عام) | A أكثر تحديداً |
| API صياغة | `REST / tRPC API` | `tRPC / REST API` | فرق ترتيب صياغة |

---

## 3. القرارات الحاكمة D1–D8

> **إطار حاكم:** هذه القرارات الثمانية **تتقدّم على أي عنصر متعارض في المخططين معاً**. هي **ليست**
> ترجيحاً للمخطط A على B، بل قرارات رسمية ملزمة تحكم كلا المخططين. أي عنصر في A أو B يخالفها
> يُصنَّف `EXCLUDED` مع الإشارة إلى القرار الحاكم.

| # | القرار | النص الملزم | الحالة | الدليل في المستودع |
|---|---|---|---|---|
| **D1** | **WASIT وسيط تجاري فقط** | تربط العملاء بالتجار والموردين والشركات، وتسهّل التواصل والبحث والعروض والطلبات والمعاملات. **ليست بائعاً أو مشترياً أصلياً** في الصفقات لمجرد أنها وسيط. | ✅ حاكم | `docs/ARCHITECTURE.md` §4 · `docs/REVENUE_MODEL.md` |
| **D2** | **لا تجمع ولا تحتفظ بالأموال** | WASIT لا تجمع أموال العملاء أو التجار لحسابها، ولا تحتفظ بها، ولا تدير أرصدة مالية، ولا تعمل كحافظ أموال أو محفظة. الدفع يتم **مباشرة بين الأطراف** عبر مزودي الدفع المعتمدين وفق ترتيبات التعاقد والامتثال. **وجود Payment Intent أو Payment Status أو سجل Ledger لا يعني أن WASIT استلمت الأموال أو حازتها.** | ✅ حاكم | لا جدول `wallet` · `modules/revenue/service.ts:17` («No Wallet / No User Funds») · لا escrow/custody في الكود |
| **D3** | **Ledger Only / No Wallet** | لا Wasit Money Wallet · لا Customer Wallet · لا Merchant Wallet · لا أرصدة قابلة للسحب أو التخزين داخل المنصة. **Ledger سجل محاسبي** للعمولات والمعاملات والالتزامات، **وليس حساب أموال للمستخدمين**. | ✅ حاكم (يحسم فرق A/B) | AD-007 · `docs/ARCHITECTURE.md:43` · `docs/REVENUE_MODEL.md:41` |
| **D4** | **Payout ليس Wallet** | وجود وحدة Payout **لا يمنح WASIT صلاحية الاحتفاظ بأموال المستخدمين أو إدارتها**. يجب مراجعة دورها الفعلي وتحديد ما إذا كان التحويل يتم مباشرة عبر مزود خارجي بين الأطراف. **لا تفترض أن وجود Payout يعني أن WASIT تملك أو تدير أموالاً.** | ✅ حاكم | `modules/payouts/engine.ts` («Payout is an INDEPENDENT lifecycle… proven by a provider transfer reference») |
| **D5** | **WASIT ليست شركة توصيل** | لا تمتلك أسطول توصيل كخدمة أساسية · لا تنقل البضائع بنفسها · لا تقدّم نفسها كناقل · **لا تتحمل مسؤولية التسليم بصفتها شركة نقل**. يجوز توفير **تكامل مع شركات شحن مستقلة** (أسعار، تتبّع، حالة الشحنة). مسؤولية النقل والتسليم تقع على **شركة الشحن والطرف المتعاقد** وفق الاتفاقات المعمول بها. | ✅ حاكم | `docs/REVENUE_MODEL.md` §5 (سياسات الشحن خارج نطاق WASIT) · لا وحدة logistics/carrier |
| **D6** | **العمولة 4%** | الإجمالية **4%**: **2% على البائع + 2% على المشتري**. **رسوم مزود الدفع منفصلة** عن عمولة WASIT. السياسة **قابلة للإدارة عبر Policy Engine**، لا عبر قيم ثابتة غير قابلة للتعديل. | ✅ حاكم | AD-042 · `lib/commission.ts:83` · `db/schema/engine.ts:38` |
| **D7** | **الدور التجاري** | القيمة التي توفرها WASIT للتاجر: العثور على موردين جدد · الوصول إلى مشترين جدد · مقارنة الأسعار والعروض · التسويق والترويج · إنشاء المحتوى والفيديوهات الإعلانية · تنظيم الطلبات والمعاملات · توسيع الوصول إلى الأسواق. | ✅ حاكم | مطابق لقدرات المنصة (بحث/مقارنة/إعلانات/تحليلات/AI) |
| **D8** | **التوسع** | تفعيل الدول والأسواق حسب **الجاهزية القانونية والتشغيلية والتكاملات**، وليس لمجرد وجودها في الخريطة. | ✅ حاكم | AD-022 (سوق ثانٍ candidate) · AD-023 (تفعيل من Admin) |

### 3.1 توضيح إضافي ملزم لـ D2/D3/D4 (وظيفة Payout الفعلية وحدودها)

- **Payout ليس محفظة ولا حساب أموال.** هو **دورة حياة مستقلة** تُثبت أن **صافي مبلغ البائع** تم
  تحويله فعلاً، بدليل **مرجع تحويل من مزوّد خارجي** (`payoutRef`)، ولا يُستنتج من حالة الدفع أو
  التسوية.
- **الحالات الفصلية (مثبتة في الكود):** `Payment = PAID` (مال المشتري وصل المزوّد) · `Ledger = SETTLED`
  (الأموال تحرّكت على مستوى المزوّد/البنك) · `Payout = COMPLETED` (صافي البائع حُوّل فعلاً بمرجع
  مزوّد). **التسوية وحدها لا تُكمل Payout، و`CREATED` لا يعني أبداً `COMPLETED`.**
- **الحدود:** وجود وحدة Payout في الكود **ليس دليلاً** على أن WASIT تحتفظ بأموال أو تدير تحويلات
  المستخدمين. WASIT **لا تحتفظ بأرصدة**؛ التحويل يتم عبر **مزوّد خارجي معتمد**.
- **دليل:** `modules/payouts/engine.ts` · `tests/payout-engine.test.ts` · `tests/payout-provider.test.ts`
  · `docs/PROJECT_BASELINE.md` §10.

### 3.2 تحقّق آلي مؤيد للقرارات

| القرار | الفحص | النتيجة |
|---|---|---|
| D2/D3 | جدول `wallet` في `db/schema/*.ts` | **غير موجود** |
| D2/D3 | وحدة `wallet` في `src/modules/` | **غير موجودة** |
| D2/D3 | المصطلحات `FLOUCI_WALLET` / `MOBILE_WALLET` | **schemes داخل method** لا محافظ مستخدمين (AD-024) |
| D2 | `escrow` / `custody` / `client funds` في الكود | **غير موجود** |
| D6 | `lib/commission.ts` + `db/schema/engine.ts` | العمولة من Policy Engine (fail-closed، لا نسبة في الكود) |
| D5 | وحدة logistics/carrier | **غير موجودة** (فقط `GET /deliveries` داخل orders) |

---

## 4. بنية هذا المرجع (وثيقة واحدة مكتفية بذاتها)

> **هذه الوثيقة هي المرجع الموحّد الوحيد.** لا تعتمد على أي ملف مرجعي آخر ولا تشير إليه. كل ما
> يلزم لفهم نطاق WASIT ووظائفها وحالتها موجود داخل هذه الوثيقة: المخططان المرجعيان كاملان (§2)،
> القرارات الحاكمة (§3)، منهجية التصنيف (§6)، وظائف NEEDS_DECISION (§7)، والمقارنة التقنية مع الكود (§8).

**خريطة الوثيقة الداخلية:**

| القسم | المحتوى |
|---|---|
| [§0](#0-إفصاح-إلزامي-عن-مصادر-المخططين-a-و-b) | إفصاح مصادر المخططين A و B وحدود التحقق |
| [§1](#1-الغرض-والنطاق) | الغرض والنطاق والمبادئ الحاكمة |
| [§2](#2-المخططات-المرجعية-الكاملة-كما-وصلت-من-صاحب-المشروع) | المخططان A و B كاملين + الفروق (13 بنداً + 7 إضافية) |
| [§3](#3-القرارات-الحاكمة-d1d8) | القرارات الحاكمة D1–D8 + وظيفة Payout وحدودها + تحقّق آلي |
| [§5](#5-الوضع-العام-ملخص-تنفيذي) | الملخص التنفيذي + الأرقام ومصادرها |
| [§6](#6-منهجية-التصنيف-خمسة-مستويات-منفصلة) | منهجية التصنيف (5 مستويات) والتصنيفات الثمانية |
| [§7](#7-وظائف-تحتاج-قراراً-خاصاً-needs_decision) | وظائف NEEDS_DECISION (6 بنود) |
| [§8](#8-مقارنة-تقنية-عناصر-المواصفات-مقابل-الكود) | المقارنة التقنية الكاملة مقابل الكود (9 أقسام) |
| [§9](#9-حدود-هذه-المراجعة) | حدود هذه المراجعة |

> **ملاحظة نطاق:** سجل المتطلبات التفصيلي (بمعرّفات `REQ-###`)، وسجل الفجوات المرتّب، وخريطة فريق
> AI، وحالة التكاملات الخارجية، وقائمة القرارات الموسّعة — **كلها مُدمجة داخل هذه الوثيقة** (§3، §6،
> §7، §8) بدل توزيعها على ملفات منفصلة. أي توسّع مستقبلي يُضاف هنا، أو يُنشأ في ملفات منفصلة بأمر
> صريح منفصل.

---

## 5. الوضع العام (ملخص تنفيذي)

**ما هي WASIT فعلياً اليوم؟** منصة وساطة تجارية B2B/B2C (Monorepo: `server` + `shared` + `web`) تُدير
دورة الصفقة كاملة: التسجيل والتوثيق → العرض والطلب → العمولة → الدفع → الدفتر → التسوية → الصرف،
مع طبقات ثقة/مخاطر/نزاعات/إشعارات/تحليلات/AI/إدارة.

**بحكم D1/D2/D5:** WASIT **ليست بنكاً، ولا حافظ أموال، ولا شركة توصيل** — وسيط تجاري فقط.

### 5.1 الأرقام — المصدر وحدود التحقق

> **تحذير:** أرقام الإنجاز الواردة في الصورتين **ليست حقائق تنفيذية**. الأرقام أدناه مصدرها **فحص
> المستودع**، وكل رقم يحمل حالة تحقق.

| المقياس | القيمة | المصدر | حالة التحقق |
|---|---|---|---|
| وحدات Backend | 36 | `ls src/modules` | ✅ مُتحقَّق مباشرة |
| جداول قاعدة البيانات | 98 | `grep pgTable` | ✅ مُتحقَّق مباشرة |
| enums | 40 | `grep pgEnum` | ✅ مُتحقَّق مباشرة |
| migrations | 32 | `ls db/migrations/*.sql` | ✅ مُتحقَّق مباشرة |
| نقاط تركيب المسارات | 46 | `grep app.route` | ✅ مُتحقَّق مباشرة |
| صفحات الواجهة | 40 | `ls src/pages` | ✅ مُتحقَّق مباشرة |
| مسارات الواجهة | 77 | WASIT-00 | ⚠️ من تقرير WASIT-00 (لم يُعد فحصه الآن) |
| دوال API في `lib/api.ts` | 177 | WASIT-00 | ⚠️ من تقرير WASIT-00 (لم يُعد فحصه الآن) |
| أدوار | 10 | `shared/constants/roles.ts` | ✅ مُتحقَّق مباشرة |
| صلاحيات | 110 | `shared/constants/permissions.ts` | ✅ مُتحقَّق مباشرة |
| وكلاء AI في الكتالوج | 20 | `grep key:` في `catalogue.ts` | ✅ مُتحقَّق مباشرة (+ Copilot منفصل) |
| أدوات مربوطة (Gateway) | 10 | `lib/ai/tool-registry.ts` | ✅ مُتحقَّق مباشرة |
| أدوات معلنة غير مربوطة | 10 | `UNBOUND_DECLARED_TOOLS` | ✅ مُتحقَّق مباشرة |
| اختبارات server | 89 ملف `*.test.ts` | `ls tests/` | ✅ مُتحقَّق مباشرة |
| مواصفات E2E | 41 spec | `ls e2e/` | ✅ مُتحقَّق مباشرة |

**توزيع الحالة العام:** مصدره **تصنيف WASIT-00** (فحص كود)، لا أرقام الصور — ويُعرض تفصيله في
[القسم 8](#8-مقارنة-تقنية-عناصر-المواصفات-مقابل-الكود) أدناه (حالة كل عنصر مقابل الكود).

**الفصل الجوهري:** الكود مكتمل إلى حد بعيد، لكن **جاهزية التشغيل التجاري منخفضة** بسبب غياب
credentials/عقود/بيئة إنتاج/اعتماد قانوني (وفق `PROJECT_BASELINE`، مع التحفظ على أرقامها النسبية).

---

## 6. منهجية التصنيف (خمسة مستويات منفصلة)

> المواصفات §5 تطلب الفصل بين **خمسة** مستويات. هذا المرجع يفصل بينها صراحةً في كل سجل.

| المستوى | السؤال | كيف يُثبت |
|---|---|---|
| **L1 — وجود الكود** | هل يوجد ملف/جدول/مسار؟ | مسار الملف + رقم السطر |
| **L2 — نجاح الاختبارات** | هل هناك اختبار يغطّيه؟ | مسار ملف الاختبار |
| **L3 — العمل الفعلي** | هل يعمل عند التشغيل؟ | اختبار تكامل حقيقي / E2E |
| **L4 — جاهزية الإنتاج** | هل يعمل في الإنتاج؟ | تهيئة بيئة/أسرار/نشر |
| **L5 — الاعتماد القانوني/التعاقدي** | هل يوجد عقد/مزوّد/موافقة؟ | عقد/credential/موافقة |

### 6.1 تصنيفات الحالة الثمانية

| التصنيف | المعنى |
|---|---|
| `REQUIRED` | مطلوب في الرؤية (ورد في أحد المخططين). |
| `IMPLEMENTED` | موجود ومدعوم بأدلة كود + اختبار. |
| `PARTIAL` | منفَّذ جزئياً. |
| `MISSING` | لا يوجد تنفيذ مثبت (بعد فحص البدائل). |
| `BLOCKED` | ينتظر تكاملاً أو موافقة خارجية. |
| `UNVERIFIED` | لا توجد أدلة كافية. |
| `EXCLUDED` | مستبعد بقرار صريح (D1–D8). |
| `NEEDS_DECISION` | يتطلب قراراً من صاحب المشروع. |

### 6.2 حقول السجل

| الحقل | الوصف |
|---|---|
| ID | معرّف فريد ثابت (`REQ-###`) لا يُعاد استخدامه. |
| Requirement | اسم المتطلب. |
| Source | `Diagram A` / `Diagram B` / `A+B` / `WASIT-00`. |
| Status | أحد التصنيفات الثمانية. |
| Code Evidence | مسار الملف/المسار/الاختبار — أو `—`. |
| Levels | L1–L5 (أي مستوى مثبت). |
| Runtime Readiness | جاهز / يحتاج تهيئة خارجية / غير جاهز. |
| Dependencies | متطلبات أخرى يعتمد عليها. |
| Notes | ملاحظات/تعارض/بدائل مفحوصة. |

---

## 7. وظائف تحتاج قراراً خاصاً (NEEDS_DECISION)

> لا تُحذف هذه الوظائف ولا يُفترض اعتمادها النهائي. تُصنَّف `NEEDS_DECISION` ما لم يوجد قرار سابق
> معتمد أو تنفيذ واضح يثبت نطاقها.

| # | الوظيفة | المصدر | الوضع في الكود | التصنيف |
|---|---|---|---|---|
| 1 | **التعليم الإلكتروني** (Courses / Lessons / Students / Certificates) | B (§4 Learn) | صفر أثر (لا وحدة/جدول/مسار) | `NEEDS_DECISION` |
| 2 | **الحجوزات والمواعيد** (Appointments / Bookings) | A (§4 Services) | صفر أثر (`RESERVATION` = حجز مخزون فقط) | `NEEDS_DECISION` |
| 3 | **المنتجات الرقمية** (Products / Files / Secure Delivery / Access Control) | A+B | `media_assets` موجود؛ **لا علم «منتج رقمي»** في `products` | `NEEDS_DECISION` |
| 4 | **التحويلات البنكية** كوظيفة مستقلة (Transfer Requests / Verification / Records) | B (§4) | مسار `manual` موجود (bank transfer)؛ **لا قسم مستقل** | `NEEDS_DECISION` |
| 5 | **التطبيقات الأصلية للهاتف** (iOS / Android) | A+B | لا `swift/kt/dart`؛ الوثائق تذكرها «مستقبلاً» فقط | `NEEDS_DECISION` |
| 6 | **الخدمات المستقلة والعمل الحر** (Freelance) | A+B | صفر أثر | `NEEDS_DECISION` |

**ملاحظة:** `Wasit Money (Wallet)` **ليس** في هذه القائمة — بل `EXCLUDED` بقرار D3 الحاكم.

---

## 8. مقارنة تقنية: عناصر المواصفات مقابل الكود

> أدلة كل حالة: مسار الملف + الوظيفة + الاختبارات ذات الصلة. غياب كلمة/ملف **لا يُعتبر حكماً نهائياً**
> قبل فحص البدائل (يُذكر البديل المفحوص في الملاحظات).

### 8.1 USERS & CHANNELS

| العنصر | الحالة | الدليل (مسارات) | ملاحظات |
|---|---|---|---|
| Customers | ✅ IMPLEMENTED | `modules/auth`, `modules/customer-library`, `modules/privacy` | — |
| Merchants | ✅ IMPLEMENTED | `modules/merchants`, `modules/directory` | — |
| Suppliers | ✅ IMPLEMENTED | `modules/suppliers`, `modules/directory` | — |
| Administrators | ✅ IMPLEMENTED | `modules/admin`, `shared/constants/roles.ts` (10 أدوار) | — |
| Mobile Apps | ⚠️ `NEEDS_DECISION` | — | لا مشروع iOS/Android؛ الوثائق: PWA لاحقاً |
| Web App | ✅ IMPLEMENTED | `packages/web` (React 18 + Vite), `App.tsx` (77 مساراً) | — |
| Partners / API Clients | ⚠️ PARTIAL | API موجود (`app.ts`) | لا برنامج شركاء/مفاتيح API مخصّصة |
| AI Agents | ✅ IMPLEMENTED | `modules/ai/catalogue.ts` (20 وكيلاً), `lib/ai/*` | Copilot منفصل (`COPILOT_KEY`) |

### 8.2 ACCESS & EDGE LAYER

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Rate Limiting | ✅ IMPLEMENTED | `middleware/rate-limit.ts`, `lib/rate-limit/resolve.ts`, `tests/rate-limit.test.ts` | AD-038 (مخزن Postgres) |
| Request Validation | ✅ IMPLEMENTED | `middleware/validate.ts` (Zod) | — |
| Security Headers | ✅ IMPLEMENTED | `middleware/security-headers.ts` (CSP/HSTS/XFO/nosniff) | — |
| API Gateway | ❌ MISSING | — | طبقة نشر خارج الريبو (لم تُفحص بيئة النشر) |
| Global CDN | ❌ MISSING | — | طبقة نشر |
| WAF / DDoS Protection | ❌ MISSING | — | طبقة نشر |
| Load Balancer | ❌ MISSING | — | طبقة نشر |

### 8.3 APPLICATION & INTEGRATION LAYER

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Web App (React) | ✅ IMPLEMENTED | `packages/web` | — |
| REST API | ✅ IMPLEMENTED | `app.ts` (46 نقطة تركيب) | Hono (AD-004) |
| tRPC | ❌ MISSING | لا اعتمادية tRPC | البديل المفحوص: REST + Zod |
| Type-safe APIs | ✅ IMPLEMENTED | Zod + TS في الطرفين | — |
| WebSocket / Real-time | ❌ MISSING | صفر أثر (لا WS/SSE؛ لا اعتمادية socket) | — |
| Mobile Apps (iOS/Android) | ⚠️ `NEEDS_DECISION` | — | — |
| Third-party integrations | ⚠️ PARTIAL | انظر §8.8 | — |

### 8.4 CORE BUSINESS SERVICES

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Marketplace: Products | ✅ IMPLEMENTED | `modules/products`, `db/schema/products.ts` | — |
| Marketplace: Categories | ✅ IMPLEMENTED | `modules/categories` | — |
| Marketplace: Search | ✅ IMPLEMENTED | `modules/search` | — |
| Marketplace: Filters | ⚠️ PARTIAL | `modules/search` (نوع/بلد/صفحة) | لا فلاتر متقدمة |
| Marketplace: Reviews | ⚠️ SKELETON | جدول `reviews` في `db/schema/trust.ts:94` | **لا routes**؛ يُقرأ فقط في `modules/ai/executors.ts:33` |
| Orders: Orders | ✅ IMPLEMENTED | `modules/orders` | — |
| Orders: Order Status | ✅ IMPLEMENTED | `shared` enums (10 حالات) | — |
| Orders: Invoices | ⚠️ PARTIAL | `invoices` في `db/schema/subscriptions.ts:77` | فواتير **اشتراكات**، لا فواتير طلبات |
| Orders: Returns | ❌ MISSING | — | لا وحدة/جدول returns |
| Orders: Cancellations | ✅ IMPLEMENTED | `modules/orders/service.ts` | — |
| Payments: Methods | ✅ IMPLEMENTED | `modules/payments`, `lib/payments/port.ts` | — |
| Payments: Gateway | ✅ IMPLEMENTED | `lib/payments/providers.ts`, `flouci.ts`, `sandbox-payment.ts` | sandbox harness |
| Payments: Status | ✅ IMPLEMENTED | `modules/payments/service.ts` | — |
| Payments: Refunds | ✅ IMPLEMENTED | `modules/payments/routes.ts` (`refunds`) | — |
| **Wasit Money (Wallet/Balance)** | 🚫 `EXCLUDED` | — | **D3** يحسمه؛ `EXCLUDED` لا `NEEDS_DECISION` |
| Bank Transfers | ⚠️ `NEEDS_DECISION` | `modules/payments/service.ts:936` (مسار `manual`) | مسار موجود؛ لا قسم مستقل |
| Invoicing Engine: Invoice Generation | ⚠️ PARTIAL | `lib/ids.ts:40` (`generateInvoiceNumber`) | لأرقام الفواتير |
| Invoicing Engine: Tax Rules by Country | ✅ IMPLEMENTED | `modules/tax`, `db/schema/tax.ts` (`taxJurisdictions`, `orderTaxDecisions`), `tests/tax-engine.test.ts` | — |
| Invoicing Engine: PDF / Email / Print | ❌ MISSING | لا `pdfkit`/`puppeteer`/PDF | — |
| Invoicing Engine: E-Invoicing Compliance | ❌ MISSING | — | — |
| Logistics (Carriers/Rates/Shipment/Tracking/Zones) | ❌ MISSING | فقط `GET /deliveries` في `modules/orders` | **D5**: WASIT ليست ناقلاً |
| Suppliers (Profile/Products/Orders/Analytics) | ✅ IMPLEMENTED | `modules/suppliers`, `modules/directory` | — |
| Merchants (Profile/Store/Products/Analytics) | ✅ IMPLEMENTED | `modules/merchants` | — |
| Customers (Profile/Addresses/Preferences/Notifications) | ✅ IMPLEMENTED | `modules/customer-library`, `modules/notifications` | — |
| Digital Products (Files/Secure Delivery/Access Control) | ⚠️ `NEEDS_DECISION` | `db/schema/media.ts` (`mediaAssets`) | لا علم «منتج رقمي» في `products` |
| Services | ⚠️ `NEEDS_DECISION` | — | صفر أثر |
| Freelance | ⚠️ `NEEDS_DECISION` | — | صفر أثر |
| Appointments | ⚠️ `NEEDS_DECISION` | — | صفر أثر |
| Bookings | ⚠️ `NEEDS_DECISION` | — | صفر أثر |
| Learn (Courses/Lessons/Students/Certificates) | ⚠️ `NEEDS_DECISION` | — | صفر أثر |
| Advertising: Ads Platform | ✅ IMPLEMENTED | `modules/ads`, `db/schema/ads.ts` | — |
| Advertising: Campaigns | ✅ IMPLEMENTED | `db/schema/ads.ts` (`campaigns`) | — |
| Advertising: Banners | ❌ MISSING | — | صفر أثر |
| Advertising: Coupons | ❌ MISSING | — | صفر أثر |
| Subscriptions (Plans/Billing/Renewals) | ✅ IMPLEMENTED | `modules/subscriptions`, `tests/subscriptions*.test.ts` | — |
| Analytics & Reports (Dashboards/Reports/KPIs/Insights) | ✅ IMPLEMENTED | `modules/analytics`, `modules/admin` (unit-economics/cohorts) | — |
| AI: Recommendations | ⚠️ PARTIAL | إشارات في `modules/ai/*` | لا توصيات منتج مخصّصة للمستخدم |
| AI: Assistants | ✅ IMPLEMENTED | `modules/ai`, `AdminCopilotPage.tsx` | — |
| AI: Matching | ❌ MISSING | ما عدا reconciliation matching (`modules/reconciliation`) | لا مطابقة B2B |
| AI: Predictions | ❌ MISSING | — | صفر أثر |
| Notifications (In-App/Email/SMS/Push) | ✅ IMPLEMENTED | `modules/notifications`, `lib/notifications/`, `tests/notifications-engine.test.ts` | محرّك PR-09 |
| Support & Tickets (Tickets/Chat/KB/SLA) | ⚠️ MISSING | لا وحدة support | فقط `support-agent` (AI) في `catalogue.ts` |

### 8.5 DATA & STORAGE LAYER

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| PostgreSQL Database | ✅ IMPLEMENTED | `db/`, Drizzle | — |
| Drizzle ORM | ✅ IMPLEMENTED | AD-003 | — |
| Row Level Security (RLS) | ❌ MISSING | لا RLS في أي migration | البديل المفحوص: RBAC على مستوى التطبيق (AD-005) |
| Redis Cache | ❌ MISSING | لا اعتمادية redis | **AD-038 يرفض Redis صراحةً** (مخزن Postgres) |
| Object Storage (S3 Compatible) | ⚠️ PARTIAL | `lib/media/local-storage.ts` | تخزين **محلي**، لا S3 |
| Supabase Storage | ❌ MISSING | صفر أثر supabase | — |
| Search Engine | ⚠️ PARTIAL | `modules/search/service.ts` (Postgres ILIKE) | لا محرّك بحث مخصّص |
| Real-time Subscriptions | ❌ MISSING | لا WS/SSE | — |

### 8.6 INFRASTRUCTURE & DEVOPS LAYER

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Docker & Containers | ✅ IMPLEMENTED | `Dockerfile`, `Dockerfile.web`, `docker-compose.yml` | — |
| Kubernetes | ❌ MISSING | لا ملفات k8s | موصوف كـ «Optional» في المخطط |
| CI / CD Pipeline | ✅ IMPLEMENTED | `.github/workflows/ci.yml` | AD-030 |
| Git Repository | ✅ IMPLEMENTED | — | — |
| Dev → Staging → Production | ⚠️ PARTIAL | `.env.staging.example` | لا بيئة مستضافة (E1) |
| Monitoring (Prometheus) | ✅ IMPLEMENTED | `lib/observability/metrics.ts`, `modules/observability/routes.ts` (`/metrics`), `tests/observability.test.ts` | AD-039 |
| Monitoring (Grafana) | ❌ MISSING | — | AD-039: بلا منصة خارجية |
| Logging | ✅ IMPLEMENTED | `middleware/observability.ts` | — |
| Backup & Disaster Recovery | ⚠️ PARTIAL | موثّق في `docs/DEPLOYMENT.md` | التنفيذ الفعلي خارج الريبو (E4) |

### 8.7 SECURITY & COMPLIANCE LAYER

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Authentication (JWT) | ✅ IMPLEMENTED | AD-016 (HttpOnly cookie + Bearer) | — |
| Authentication (OAuth) | ❌ MISSING | لا oauth/passport | فقط حقل `passport` في seed (بيانات) |
| Authorization (RBAC) | ✅ IMPLEMENTED | AD-005, `shared/constants/permissions.ts` (110) | — |
| Multi-Tenancy | ⚠️ `NEEDS_DECISION` | نطاق tenant على مستوى تطبيق AI (`modules/ai/scope.ts`) | لا بنية multi-tenant كاملة |
| Data Encryption | ⚠️ PARTIAL | hashing كلمات المرور (argon2) | **لا تشفير at-rest** |
| Audit Logs | ✅ IMPLEMENTED | `db/schema/audit.ts` (`auditLogs`) | — |
| Compliance (GDPR) | ⚠️ PARTIAL | التقاط موافقة (`CookieConsent.tsx`, `PUT /api/privacy/consents`) | «ليس ادعاء امتثال كامل»؛ LC-01 مفتوح |
| Compliance (ISO 27001) | ❌ MISSING | صفر أثر | — |
| Secrets Management | ⚠️ PARTIAL | env-based (`lib/env.ts`) | لا vault |
| API Security | ✅ IMPLEMENTED | rate-limit + validation + headers | — |

### 8.8 EXTERNAL INTEGRATIONS

| العنصر | الحالة | الدليل | ملاحظات |
|---|---|---|---|
| Payment Providers | ⚠️ `BLOCKED` | `lib/payments/*`, `docs/PAYMENT_PROVIDERS.md` | adapters موجودة؛ **لا مفاتيح/عقود** (sandbox) |
| Shipping Providers | ❌ MISSING | — | **D5** |
| KYC / Identity Verification | ⚠️ PARTIAL | `modules/verification` | تحقق **داخلي**؛ لا مزوّد KYC خارجي |
| Tax / E-Invoicing | ⚠️ PARTIAL | `modules/tax` | محرّك ضرائب داخلي؛ لا e-invoicing |
| Email / SMS / Push Providers | ⚠️ PARTIAL | `lib/notifications/`, `tests/mail.test.ts`, `tests/sms.test.ts` | ports موجودة؛ **لا مزوّد إنتاجي مُهيّأ** |
| Maps / Geolocation | ❌ MISSING | `modules/geo` = بيانات دول/مدن فقط | لا خرائط |
| Social Login | ❌ MISSING | — | — |
| Accounting / ERP | ❌ MISSING | إشارة webhook عام فقط (`lib/notifications/webhook.ts`) | لا تكامل |

> **تحذير متعلق بالتحقق:** لا يُوصف أي تكامل خارجي بأنه «يعمل فعلياً» دون دليل اتصال واختبار حقيقي.
> كل «PARTIAL/BLOCKED» أعلاه يعني: كود موجود، لكن **لا اتصال إنتاجي مُثبت**.

### 8.9 DEVELOPMENT ROADMAP · JOURNEY · DELIVERABLES

| العنصر | الحالة | ملاحظة |
|---|---|---|
| Roadmap (A: 7 مراحل · B: 8 مراحل) | ✅ IMPLEMENTED (بصيغة PHASE) | `docs/DEVELOPMENT_ROADMAP.md` (PHASE 0–21 + إضافات) — تحقّق مقابل الكود |
| Journey / Execution | ⚠️ PARTIAL | خطوات Planning→Production موثّقة عبر المراحل؛ **لا سجلّ Journey رسمي واحد** |
| Final Deliverables | ⚠️ PARTIAL | المصدر والاختبارات والنشر موجودة؛ **Mobile Apps** و**Training** غير منفّذين |

---

## 9. حدود هذه المراجعة

1. **لم أفحص أي ملف صورة بنفسي** — محتوى A و B وصل نصياً من صاحب المشروع (القسم 0).
2. **لم أُشغّل أي اختبار أو E2E** في هذه المهمة (اعتمدت على ملفات الاختبار كأدلة وجود).
3. **لم أتصل بأي مزوّد خارجي** — «مختبر» تعني اختبار وحدة داخلي؛ الإنتاج = `UNVERIFIED`.
4. **لم أستعلم عن قاعدة بيانات حيّة**، ولم أُشغّل migrations/seeds.
5. **لم أتحقق من عمل كل مسار واجهة فعلياً** — فحص ساكن فقط.
6. **مسارات الواجهة (77) ودوال API (177)** من تقرير WASIT-00 ولم يُعد فحصهما الآن (مُوسَمان ⚠️).
7. **طبقات النشر** (CDN/WAF/LB/API Gateway) خارج الريبو — `MISSING` تعني «لا أثر في الكود»، لا حكم على بيئة النشر.
8. كل استنتاج لا سند كودي له مُوسَم `UNVERIFIED` أو `NEEDS_DECISION` صراحةً.

---

*آخر تحديث: 2026-10-31 · HEAD: `1cccbe8` · الفرع: `ci/repair-sandbox-2u-g-20261020-190057`*
