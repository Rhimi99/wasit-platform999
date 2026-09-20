# PERMISSIONS MATRIX — WASIT BUSINESS GLOBAL

مصفوفة الأدوار ↔ الصلاحيات. المصدر الفعلي الوحيد: `packages/shared/src/constants/rbac.ts` (`ROLE_PERMISSIONS`) — ReadOnlySet صريح لكل دور.

## الأدوار

CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER, SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN.

## المبدأ

- **الأقل صلاحية (Principle of Least Privilege)**: كل دور يُمنح الصلاحيات صراحةً — لا وراثة تلقائية.
- **إنفاذ في الخادم حصراً**: `requirePermission(PERMISSIONS.X)` / `requireRole('X')` في routes. الواجهة لا تمثل حماية.

## ملخص المصفوفة الفعلية (تفصيل كامل في الكود)

| الدور | أبرز الصلاحيات |
| --- | --- |
| CUSTOMER | قراءة منتجات/موردين/تجار/شركات، بحث عام، إنشاء طلب، قراءة طلبه/معاملته، رسائل، إثبات، قراءة Trust/نزاعاته، مكتبته (`favorite:manage`/`saved:manage`/`search:history:manage`)، اشتراك |
| MERCHANT | كل ما لدى CUSTOMER + إنشاء/تعديل/حذف منتجات، قراءة/تحديث ملفه، معاملات، مدفوعات، عمولات، مخزون (قراءة/تحديث/حركة)، إعلانات/حملات، AI، Analytics |
| SUPPLIER | مثل MERCHANT تقريباً (بدل merchant: update/read) + عرض مورديه، قراءة تجار |
| COMPANY | منتجات + ملفه + شراء من موردين، قراءة موردين/تجار، Orders مرتبطة بشركته (تفصيل في الكود) |
| MARKETER / SUPPORT / RISK / DISPUTE | صلاحيات وظيفية منفصلة (كود المصدر) |
| ADMIN / SUPER_ADMIN | كل صلاحيات الإدارة (user/commission/policy/ad/admin...) + SUPPORT/RISK/DISPUTE subsets حيث ملائم |

## مثال تطبيقي (مُختبَر فعلياً)

| المسار | الدوال المسموح لها | الاختبار |
| --- | --- | --- |
| POST /api/suppliers | SUPPLIER | CUSTOMER→403 |
| POST /api/merchants | MERCHANT | CUSTOMER→403 |
| POST /api/companies | COMPANY | CUSTOMER→403 |
| POST /api/categories | PRODUCT_MANAGE | — |
| POST /api/products | PRODUCT_MANAGE | SUPPLIER→201 |
| /api/admin/* | ADMIN, SUPER_ADMIN | ADMIN→200/ CUSTOMER→403 |
| GET /api/library/favorites | FAVORITE_MANAGE | CUSTOMER→200 / زائر→401 |
| DELETE /api/library/favorites/:type/:id (ملك مستخدم آخر) | FAVORITE_MANAGE | غير المالك→404 (عزل بمعرّف الجلسة) |

## الحفاظ على المصفوفة

- التعديل يتم عبر seed (rolePermissions) وملف rbac.ts.
- أي إضافة صلاحية لدور تتطلب تحديث مصفوفة ROLE_PERMISSIONS مع اختبار RBAC مغطى.