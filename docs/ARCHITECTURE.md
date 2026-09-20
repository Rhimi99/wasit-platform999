# WASIT BUSINESS GLOBAL — Architecture

المنصة التجارية الرقمية العالمية: **الوسيط التجاري العالمي** تونس أولاً، قابلة للتوسع عالمياً.

## 1. الرؤية المعمارية

تربط WASIT الموردين والشركات وكبار التجار بصغار التجار والعملاء، عبر طبقة وساطة رقمية موثوقة تحقق:

- **Marketplace** — منتجات حقيقية قابلة للتسوق
- **B2B + B2C** — صفقات بين أعمال ونحو العملاء
- **Commerce** — طلبات ومعاملات وعمولات
- **Trust** — درجات ثقة قابلة للتفسير
- **AI** — توصيات ومساعدة مقيدة بالصلاحيات وبميزانية
- **Advertising** — حملات إعلانية
- **Analytics** — مؤشرات أداء

البنية التقنية مصممة **Global-first**: لا يوجد تونس Hardcoded في الـ Core؛ الدول واللغات والعملات كيانات قابلة للتكوين.

## 2. Monorepo

```
packages/
  server/   TypeScript + Hono + Drizzle ORM + PostgreSQL
  shared/   الثوابت المشتركة: أدوار، صلاحيات، أخطاء، أدوات RBAC
  web/      (واجهة المستخدم — React، قيد التطوير)
```

## 3. الطبقات

```
HTTP (Hono Routes)
   → Middleware (Core / Auth / Rate Limit / Validate / Errors)
   → Services (Business Logic)
   → Data Access (Drizzle ORM)
      → PostgreSQL (Schema موحّد)
```

## 4. المبادئ الأساسية

- **لا Fake backend/API** في الوظائف الأساسية — كل وظيفة تمر عبر Service يعالج Database فعلي.
- **Policy Engine** — القواعد التجارية (عمولة، حدود، تحقق، خطر، نزاعات، إعلانات، اشتراكات) في DB وليست Hardcoded.
- **Commission Engine** — العمولة الأساسية **4%** من قيمة الصفقة، مقسّمة **2% على البائع + 2% على المشتري** (لا عمولة أساسية إضافية). سياسة `BASE` قابلة للتعديل إدارياً ومسجلة في Audit Log.
- **Transaction Ledger** — لا Wallet. WASIT ليس بنكاً ولا يحتفظ بأرصدة؛ يسجل الوسطاء والعمولات والرسوم فقط.
- **Trust منفصل عن Risk** — درجتان مستقلتان بقواعد وقرارات مختلفة.
- **AI Core** مقيد بصلاحيات الممثل وميزانية AI قابلة للرصد (AI Cost Control).
- **RBAC فعلي داخل Backend** — إخفاء واجهة لا يمثل منع صلاحية.
- **أمان**: hashing لكلمات المرور، جلسات آمنة، Rate Limiting، Validation، Audit Trail، عدم كشف الأسرار في الريبو.

## 5. الوحدات

| Module | Route prefix | الحالة |
| --- | --- | --- |
| Auth | `/api/auth` | ✅ Registration / Login / Session |
| Users | `/api/users` | قيد التنفيذ |
| Categories | `/api/categories` | ✅ CRUD محمي |
| Products | `/api/products` | ✅ CRUD + بحث + تصنيف |
| Suppliers | `/api/suppliers` | ✅ CRUD + RBAC (SUPPLIER) |
| Merchants | `/api/merchants` | ✅ CRUD + RBAC (MERCHANT) |
| Companies | `/api/companies` | ✅ CRUD + RBAC (COMPANY) |
| Search | `/api/search` | ✅ بحث موحّد (منتجات/موردون/تجار/شركات/فئات) |
| Orders | `/api/orders` | ✅ إنشاء مع MOQ + عمولة + Ledger |
| Transactions | `/api/transactions` | ✅ مسارات إدارية |
| Inventory | `/api/inventory` | هيكل، قيد التنفيذ |
| Messaging | `/api/messages` | هيكل، قيد التنفيذ |
| Notifications | `/api/notifications` | هيكل، قيد التنفيذ |
| Verification | `/api/verification` | هيكل، قيد التنفيذ |
| Trust | `/api/trust` | هيكل، قيد التنفيذ |
| Risk | `/api/risk` | هيكل، قيد التنفيذ |
| Disputes | `/api/disputes` | هيكل، قيد التنفيذ |
| Ads | `/api/ads` | هيكل، قيد التنفيذ |
| AI | `/api/ai` | هيكل، قيد التنفيذ |
| Analytics | `/api/analytics` | هيكل، قيد التنفيذ |
| Admin | `/api/admin` | ✅ KPIs/Users/Orders/Products/Ledger/Audit مع RBAC |
| Geo | `/api/geo` | هيكل (دول/مناطق/مدن/عملات/لغات) |
| SEO | `/sitemap.xml`, `/robots.txt`, `/api/seo` | ✅ sitemap ديناميكي + robots + JSON-LD (عام، بيانات ACTIVE فقط) |

## 6. نمط Module

كل Module يلتزم:

```
src/modules/<name>/
  routes.ts     ← تحديد المسارات + Middleware (Auth/Role/Permission/Validation)
  service.ts    ← منطق الأعمال + Audit + أخطاء ApiError
```

الاستجابة الموحدة:
- نجاح: `{ success: true, data }`
- خطأ: `{ success: false, error: { code, message, fieldErrors?, traceId? } }`

## 7. معالجة الأخطاء

- `ApiError` (كود + statusCode + message + fieldErrors + traceId)
- `app.onError` يترجم `ApiError` → status صحيح (403/409/422/500...)
- `Error Handler` يحول `ZodError` → 422 مع fieldErrors
- كل خطأ غير متوقع: 500 مع traceId (للتشخيص) دون كشف التفاصيل

## 8. الأمان

- كلمات مرور `argon2` (اعتماد hash قوي)
- جلسة عبر HttpOnly cookie / Bearer
- `requireAuth` + `requireRole` + `requirePermission`
- `Rate Limit` على مسارات المصادقة
- `Validation` عبر zod على كل body
- Audit Trail لأي تغيير مهم (who/what/old/new/date/reason)
- CORS مقيّد بالأصل
- أسرار من Env (لا توجد Secrets في الكود)

## 9. التوسع المستقبلي

- PWA / Android / iOS — Backend و APIs جاهزون لإعادة الاستخدام
- AI Search/Agents — Architecture تفصل AI Core عن Providers
- دول جديدة — التكوين جغرافي وعملاتي داخل Data