# PERM-01C — DEAD PERMISSIONS & RBAC ENFORCEMENT CLEANUP

تاريخ: 2026-11-04 · الحالة: **COMPLETED (Phase 3)** · لا حذف صلاحيات · لا تغيير مصفوفة الأدوار

مرجع التحليل: Phase 1 read-only audit (هذا المستند هو Phase 3 التنفيذي).

---

## 1. ملخّص

| البند | قبل | بعد |
| --- | --- | --- |
| إجمالي الصلاحيات المعرّفة | 111 | 111 (لا تغيير) |
| صلاحيات مُشار إليها عبر رمز (`PERMISSIONS.*`) في الخادم | 54 | **60** (+6 من R1) |
| صلاحيات بلا إشارة رمزية في الخادم | 57 | 51 |
| منها مُنفَّذة بآلية أخرى (لا رمز) | 2 | 1 (`ad:create`) |
| صلاحيات غير مستخدمة فعلاً (تحتاج قراراً) | — | 50 (موثّقة أدناه) |

**R1** جعل ست صلاحيات كانت معرّفة-فقط مُنفَّذة فعلياً: `supplier:create`, `supplier:update`,
`merchant:create`, `merchant:update`, `company:create`, `company:update`.

---

## 2. R4 — تصنيف الصلاحيات غير المُشار إليها (50)

**لا حُذفت أي صلاحية.** التصنيف يشرح سبب الإبقاء ومستوى الإنفاذ الحقيقي.

### 2.1 `ENFORCED_BY_OTHER_MECHANISM` (1)
| الصلاحية | آلية الإنفاذ |
| --- | --- |
| `ad:create` | قدرة وكيل AI: `ai/agents.ts` (`permissionsRequired: ['ai:use','ad:create']`) يُفرض في `createAgentTask` عبر `ROLE_PERMISSIONS` — لا عبر رمز `PERMISSIONS.*` |

### 2.2 `PUBLIC_BY_DESIGN` (7) — قراءة عامة، لا حارس مطلوب
| الصلاحية | السبب |
| --- | --- |
| `product:read`, `product:list` | `GET /api/products` عام (كتالوج) |
| `supplier:read`, `merchant:read`, `company:read`, `company:list` | `GET /api/{suppliers,merchants,companies}` عام (أدلّة) |
| `search:public` | `GET /api/search` عام (optionalAuth) |

**القرار:** الإبقاء — الصلاحية وثائقية (تصف ما هو عام)، وحذفها يفقد مصفوفة RBAC تعبيرها عن السطح العام.

### 2.3 `OWNERSHIP_BY_DESIGN` (10) — `requireAuth` + فحص ملكية داخل الخدمة
| الصلاحية | الحارس الفعلي |
| --- | --- |
| `auth:read:own`, `auth:update:own` | `requireAuth` على مسارات auth |
| `user:read:own` | `requireAuth` على `/api/auth/me` |
| `product:create`, `product:update`, `product:delete` | `assertSellerOwnership` في `products/service.ts` |
| `order:create`, `order:read`, `order:update` | فحص `buyerId`/`ownedSellerIds` في `orders/service.ts` |
| `payment:create` | `assertOrderAccess` في `payments/service.ts` |

**القرار:** الإبقاء — الملكية أقوى من الصلاحية هنا (لا يُسمح حتى لـADMIN بتجاوزها). الصلاحية تسمية وظيفية.

### 2.4 `ROLE_GUARD_BY_DESIGN` (3) — إنشاء بالدور+الصلاحية، حذف بلا مسار
| الصلاحية | السبب |
| --- | --- |
| `supplier:delete`, `merchant:delete`, `company:delete` | **لا مسار DELETE** للكيانات (ممنوع إنشاء عمليات حذف جديدة) |

**القرار:** الإبقاء — تُشير إلى قدرة حذف مُعلَّقة (FUTURE). حذفها يفقد تعبير المصفوفة عن دورة حياة الكيان.

### 2.5 `REDUNDANT_DEFENCE` (20) — محميّة بالحارس الإداري العام
| الصلاحية | لماذا "زائدة" |
| --- | --- |
| `user:read`, `user:create`, `user:update`, `user:delete`, `user:list` | كل `/api/admin/*` محميّ بـ`requireRole('ADMIN','SUPER_ADMIN')` أولاً |
| `transaction:read`, `transaction:list`, `ledger:read` | `/api/admin/transactions|ledger` خلف الحارس العام |
| `admin:users`, `admin:ads`, `admin:commissions`, `admin:subscriptions`, `admin:verification`, `admin:trust`, `admin:risk`, `admin:disputes` | عائلة `admin:*` الفرعية بلا فحص صريح؛ الحارس العام يغطّيها |
| `audit:log:read` | `/api/admin/audit-logs` خلف الحارس العام |
| `audit:log:export` | لا endpoint تصدير؛ ADMIN فقط يحملها |
| `ai:cost:read`, `analytics:read:all` | `/api/admin/ai|analytics` خلف الحارس العام + صلاحية `admin:ai`/`admin:analytics` |

**القرار:** الإبقاء — دفاع في العمق. ملاحظة مهمة: من يحملها من الأدوار المتخصصة
(`SUPPORT`/`RISK`/`DISPUTE`) **لا يستطيع الوصول فعلاً** لأن الحارس العام يرفضه (انظر R5).

### 2.6 `DEAD` (10) — لا مسار/واجهة/اختبار يستهلكها
| الصلاحية | السبب | التوصية |
| --- | --- | --- |
| `order:delete` | لا حذف طلبات | FUTURE/إزالة عند قرار |
| `order:list` | `GET /api/orders` يستخدم `listMyOrders` بالملكية لا الصلاحية | مرشّح ربط |
| `commission:read` | لا سطح عرض عمولة مستقل | FUTURE (خطة عرض عمولة) |
| `verification:manage` | `verification:review/approve/reject` تغطّي المكتب | مرشّح إزالة |
| `risk:review` | مكرّرة مع `risk:manage` | مرشّح إزالة |
| `dispute:resolve` | مكرّرة مع `dispute:decide` | مرشّح إزالة |
| `ad:manage` | لا مسار يستخدمها (`campaign:manage` تغطّي الإعلانات) | مرشّح ربط/إزالة |
| `search:advanced` | `SEARCH_PUBLIC` يغطّي البحث | FUTURE (بحث متقدّم) |
| `revenue:manage` | `revenue:read`/`revenue:simulate` فقط مُنفَّذتان | مرشّح إزالة |
| `report:read` | لا مسار يستخدمها؛ التقارير تُحرَس بـ`admin:reports` | مرشّح إزالة |

**القرار:** الإبقاء هذه المرحلة (ممنوع الحذف) + توثيق. أي إزالة تحتاج قراراً إدارياً منفصلاً.

---

## 3. R5 — مصفوفة الأدوار المتخصصة (توثيق، بلا تغيير صلاحيات)

**قاعدة غير قابلة للتفاوض:** لم يُمنح `SUPPORT`/`RISK`/`DISPUTE` أي وصول جديد إلى المستخدمين أو
السجلات المالية أو سجلات التدقيق. الحارس العام `/api/admin/*` ما زال يرفضهم (403) على كل مسار غير مكتبهم.

### 3.1 SUPPORT
- **يملك:** `user:read`, `user:list`, `order:read`, `order:list`, `transaction:read`, `transaction:list`,
  `dispute:read|review|manage`, `verification:read`, `trust:read`, `analytics:read:all`, `product:read/list`, `supplier/merchant/company:read|list`, `ai:use`.
- **مسارات يستطيع الوصول إليها فعلاً:** مكاتب trust/disputes (عبر `adminEnginesRoutes`)، والمسارات العامة.
- **صلاحيات بلا مسار قابل للوصول:** `user:read`, `user:list`, `transaction:read`, `transaction:list`,
  `analytics:read:all` (كلها خلف الحارس العام على `/api/admin/*` → 403 لـSUPPORT).
- **السبب/القرار:** الإبقاء — قد تُصبح قابلة للوصول لو أُضيف مكتب «users/transactions» لاحقاً. تحتاج قراراً إدارياً.

### 3.2 RISK
- **يملك:** `user:read`, `user:list`, `transaction:read`, `transaction:list`, `order:read`, `order:list`,
  `risk:read|manage|review`, `verification:read`, `trust:read|read:all`, `admin:risk`, `report:read`,
  `audit:log:read`, `analytics:read:all`, `ai:use`.
- **مسارات يستطيع الوصول إليها فعلاً:** مكاتب risk/trust.
- **صلاحيات بلا مسار قابل للوصول:** `user:read/list`, `transaction:read/list`, `report:read`, `audit:log:read`,
  `analytics:read:all`, `admin:risk` (الحارس العام يرفض RISK على المسار العام).
- **السبب/القرار:** الإبقاء + توثيق. `audit:log:read` عند RISK بلا مسار تدقيق قابل للوصول — قرار إداري مطلوب.

### 3.3 DISPUTE
- **يملك:** `user:read`, `order:read`, `dispute:create|read|read:own|review|assign|manage|decide|resolve`,
  `message:send|read:own`, `transaction:read`, `audit:log:read`, `analytics:read:all`, `ai:use`.
- **مسارات يستطيع الوصول إليها فعلاً:** مكتب disputes.
- **صلاحيات بلا مسار قابل للوصول:** `user:read`, `transaction:read`, `audit:log:read`, `analytics:read:all`.
- **السبب/القرار:** الإبقاء + توثيق. `dispute:resolve` ميتة (مكرّرة مع `dispute:decide`) — مرشّح إزالة لاحقاً.

**ملاحظة تصميمية:** هذه الصلاحيات «بلا مسار» ليست ثغرة (لا تفتح شيئاً — الحارس العام يرفض)، لكنها
**مُضلِّلة**: توحي بقدرات لا يمكن ممارستها. تحتاج قراراً: (أ) فتح مكاتب مخصّصة، (ب) إزالة الصلاحية، (ج) الإبقاء الموثّق.

---

## 4. الملفات المعدّلة في Phase 3

| الملف | التغيير |
| --- | --- |
| `packages/server/src/middleware/auth.ts` | إضافة `requireRoleOrPermission(role, permission)` |
| `packages/server/src/modules/suppliers/routes.ts` | CREATE عبر `requireRoleOrPermission('SUPPLIER', SUPPLIER_CREATE)`؛ contacts عبر `SUPPLIER_UPDATE` |
| `packages/server/src/modules/merchants/routes.ts` | CREATE عبر `requireRoleOrPermission('MERCHANT', MERCHANT_CREATE)`؛ PATCH عبر `MERCHANT_UPDATE` |
| `packages/server/src/modules/companies/routes.ts` | CREATE عبر `requireRoleOrPermission('COMPANY', COMPANY_CREATE)`؛ PATCH عبر `COMPANY_UPDATE` |
| `packages/server/src/modules/tax/routes.ts` | الحارس العام من `ADMIN_REPORTS` → `ADMIN_POLICIES` |
| `packages/server/src/modules/admin/analytics-routes.ts` | `/reports` (GET/POST) يحملان `ADMIN_REPORTS` صراحةً |
| `packages/web/src/lib/demo-owner-catalog.ts` | probe التقارير → `/api/admin/analytics/reports` |
| `packages/web/src/lib/rbac.ts` | إزالة ميزة `payment.view` الشبحية |
| `packages/server/tests/perm01c-rbac-cleanup.test.ts` | اختبارات R7 (جديد) |

---

## 5. ما تبقّى (قرارات مطلوبة)

1. **إزالة الصلاحيات الميتة العشر** (`order:delete`, `order:list`, `commission:read`, `verification:manage`,
   `risk:review`, `dispute:resolve`, `ad:manage`, `search:advanced`, `revenue:manage`, `report:read`) — أو ربطها.
2. **الصلاحيات المُضلِّلة للموظفين المتخصصين** (R5): قرار فتح مكاتب أم إزالة صلاحيات.
3. ~~**`revenue:manage`/`report:read` لـADMIN**: هل تُمنح أم تبقى حصرية؟~~ **حُسمت (WASIT-EXECUTION-006، PERM-01 → `COMPLETE_VERIFIED`):** `revenue:read` **لا تُمنح لـADMIN** (منع مقصود مُوثَّق ومُتحقَّق حياً — `docs/management/guide.html` §8)؛ `report:read` **ليست فجوة** (لا مسار يستهلكها؛ مكتب التقارير محروس بـ`admin:reports` الذي يملكه ADMIN) وتُوثَّق كصلاحية ميتة/مُسمّاة خطأً. لا تغيير مصفوفة. الأدلة: `docs/GAP_REGISTER.md` (§2/§6/§9) + `docs/SECURITY_MODEL.md` §2 + `packages/server/tests/perm01-admin-revenue-report.test.ts` (17/17).
4. **`ad:manage`**: ربط بـads أو إزالة.
