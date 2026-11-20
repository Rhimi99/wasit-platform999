# PS-01 — ADMIN FINANCE DESK

تاريخ: 2026-11-06 · الحالة: **IMPLEMENTED — TESTS WRITTEN, DB RUN BLOCKED (no PostgreSQL available)** · لا Commit/Push

مرجع: `docs/GAP_REGISTER.md` §2 (PS-01، P0/HIGH) + تقرير NEXT TASK SELECTION.

---

## 1. ملخّص

PS-01: لا واجهة إدارية لتشغيل طبقات حركة المال رغم وجود الخلفية الكاملة والمُختبرة. أُضيف
مكتب مالية على المسار `/admin/finance` يعرض ويسهّل العمليات الست: تأكيد التسوية، مزوّدو الدفع،
إنشاء/إرسال/مزامنة الدفعات، استيراد المواءمة، وتسجيل الإيصالات.

الواجهة **لا تُنفّذ أي منطق مالي خاص بها**: كل إجراء يستدعي نفس مسار الخلفية القائم تحت
`/api/admin/finance`، وكل نتيجة تُقرأ من ردّ الخادم. لا endpoint جديد، ولا تغيير في منطق الخدمات.

## 2. مبدأ التصميم — الواجهة تعكس القواعد ولا تخفيها

- **لا نجاح قبل الخادم:** لا تُعرض رسالة نجاح إلا بعد `{success:true}` من الخادم.
- **dispatch/sync لا يُكملان الدفعة:** تصل الدفعة إلى `PROCESSING` فقط؛ `COMPLETED` يتطلب دليل
  تحويل مطابقاً يتحقق منه الـBackend. الواجهة تُظهر الحالة الفعلية ولا تدّعي الإكمال.
- **التسوية تحتاج مرجعاً حقيقياً:** التحقق الإلزامي من `settlementRef` متروك للخادم (422) حتى
  تظهر رسالته الفعلية بدل تخمين العميل. الواجهة تتحقق فقط من الحقول التي تستطيع الحكم عليها.
- **المبلغ مُشتق لا مُمرَّر:** نموذج الدفعة لا يحتوي حقل مبلغ إطلاقاً.
- **لا محفظة/رصيد/حفظ أموال، ولا اتصال بمزوّد حي** — المزوّدون الحقيقيون يبقون production-disabled.

## 3. الملفات المعدّلة والجديدة

### جديدة (2)
| الملف | الغرض |
| --- | --- |
| `packages/web/src/pages/AdminFinancePages.tsx` | صفحة `/admin/finance` (5 تبويبات: settlement/payouts/reconciliation/receipts/providers) |
| `e2e/admin-finance.spec.ts` | اختبار E2E تشغيلي على الـBackend الحقيقي |

### معدّلة (6)
| الملف | التغيير |
| --- | --- |
| `packages/web/src/App.tsx` | مسار `/admin/finance` محروس بـ`RequireAuth`+`AdminOnly` + استيراد الصفحة |
| `packages/web/src/lib/api.ts` | 8 دوال جديدة تطابق مسارات `/api/admin/finance` 1:1 |
| `packages/web/src/lib/types.ts` | أنواع DTO لحركة المال (PayoutRecord، SettlementResult، ReconciliationReport، ReceiptResult…) |
| `packages/web/src/lib/i18n.ts` | مفاتيح `adminFin.*` و`admin.financeDesk` في ar/fr/en/zh |
| `packages/web/src/components/layouts/AppSidebar.tsx` | رابط «المالية والتسويات» في قائمة ADMIN_NAV |
| `packages/web/src/lib/demo-owner-catalog.ts` | وحدة `admin-finance` + تصحيح probe مجموعة finance إلى `/api/admin/finance/payout-providers` |

> لم تُمسّ أي صلاحية أو مصفوفة أدوار أو نموذج العمولة 4% أو منطق الخدمات المالية. لا تغيير في Backend.

## 4. المسارات المستخدمة (بلا تعديل)

| الإجراء | المسار | الصلاحية |
| --- | --- | --- |
| تأكيد التسوية | `POST /api/admin/finance/settlements/confirm` | `payment:read` أو `commission:manage` |
| مزوّدو الدفع | `GET /api/admin/finance/payout-providers` | نفسها |
| إنشاء دفعة | `POST /api/admin/finance/payouts` | نفسها |
| قراءة دفعة | `GET /api/admin/finance/payouts/:id` | نفسها |
| إرسال دفعة | `POST /api/admin/finance/payouts/:id/dispatch` | نفسها |
| مزامنة دفعة | `POST /api/admin/finance/payouts/:id/sync` | نفسها |
| استيراد المواءمة | `POST /api/admin/finance/reconciliation/import` | نفسها |
| تسجيل إيصال | `POST /api/admin/finance/receipts` | نفسها |

ADMIN/SUPER_ADMIN فقط (يملكان `payment:read`+`commission:manage`). الزائر → 401، غير المخوّل → 403.

## 5. الضوابط المالية والأمنية (مُطبَّقة)

- ADMIN/SUPER_ADMIN فقط بالصلاحيات القائمة؛ لا صلاحيات جديدة.
- الزائر 401، غير المخوّل 403 (على الواجهة والخادم).
- dispatch/sync لا يحوّلان إلى COMPLETED (اختبار صريح).
- لا اعتبار للطلب المرسل دليلاً على استلام الأموال.
- لا تأكيد تسوية دون مرجع (422 من الخادم).
- لا إيصال لمصدر غير معروف (enum على الطرفين: BANK_STATEMENT/ACQUIRER/PROVIDER).
- لا Wallet/رصيد/حفظ أموال؛ لا اتصال بمزوّد حي.
- الفصل Payment/Ledger/Settlement/Payout قائم في الخلفية ولم يُمسّ.

## 6. الاختبارات

### 6.1 E2E تشغيلي — `e2e/admin-finance.spec.ts`
11 حالة تغطي: الوصول (401 زائر/403 عميل/شاشة Forbidden)، تأكيد التسوية بمرجع صالح + تحقّق
من قيد `SETTLED` في الدفتر، رفض التسوية بلا مرجع (422) وإظهار الخطأ، عرض المزوّدين، إنشاء دفعة
(CREATED) + dispatch (PROCESSING) + sync (لا COMPLETED)، رفض دفعة لمعاملة غير مُسوّاة، استيراد
المواءمة وعرض التقرير، رفض JSON غير صالح، وإيصال بمصدر معروف + رفض مصدر مجهول.

تُبنى البيانات عبر الـAPI الحقيقي (طلب مدفوع + تسوية) كما في `admin-subscriptions.spec.ts`.

### 6.2 عائق التشغيل (BLOCKED — لم يُشغَّل)
`vitest`/Playwright يتطلبان PostgreSQL حيّاً (`wasit_dev` للـE2E، `wasit_test` للـBackend). في هذه
البيئة **لا PostgreSQL أصلي** و**daemon Docker متوقف**، والقيود تمنع تشغيلهما دون موافقة صريحة.

**أوامر التحقق** (بعد الموافقة):
```bash
# 1) PostgreSQL مؤقت معزول
docker run -d --name wasit-ps01-pg -e POSTGRES_USER=wasit -e POSTGRES_PASSWORD=wasit_dev_password \
  -e POSTGRES_DB=wasit_test -p 5432:5432 postgres:16
# 2) اختبارات الخلفية (تُعيد إنشاء wasit_test + migrations + seed)
cd packages/server && npx vitest run tests/finance-routes.test.ts
# 3) E2E (يحتاج قاعدتَي wasit_dev وwasit_test؛ راجع playwright.config.ts)
npm run test:e2e -- e2e/admin-finance.spec.ts
```
لم يُدَّعِ أي نجاح تشغيلي؛ 6.1 مكتوب ومنتظر.

## 7. معايير الإغلاق — الحالة

| المعيار | الحالة |
| --- | --- |
| تنفيذ الواجهة | ✅ |
| ربط App/api/types/i18n/sidebar/catalog | ✅ |
| TypeScript نظيف (server + web) | ✅ |
| البناء نظيف (server + web) | ✅ |
| اختبارات E2E مكتوبة | ✅ (11 حالة) |
| اجتياز الاختبارات فعلياً | ⛔ BLOCKED (لا PostgreSQL) |
| توثيق النتائج | ✅ هذا الملف |

## 8. ما لم يُنفَّذ (خارج النطاق)

- لا endpoint خلفي جديد (لم تُثبت الحاجة؛ القوائم المتاحة كافية).
- لا تعديل على `finance/routes.ts` أو الخدمات المالية.
- لا E2E ناجح مُدّعى بلا قاعدة بيانات حيّة.
