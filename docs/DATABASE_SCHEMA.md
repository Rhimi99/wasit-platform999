# DATABASE SCHEMA — WASIT BUSINESS GLOBAL

PostgreSQL + Drizzle ORM. 70 جدولاً منظمة في مجموعات Schema.

## 1. المصادقة والهوية (`schema/auth.ts`)

- `users` — الحسابات (email, phone, passwordHash, emailVerified, phoneVerified, isActive, isLocked, locale, mfaEnabled, lastLoginAt, timestamps)
- `roles` — الأدوار (CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER, SUPPORT, RISK, DISPUTE, ADMIN, SUPER_ADMIN)
- `permissions` — الصلاحيات (من `PERMISSIONS` في shared)
- `rolePermissions` — ربط دور ↔ صلاحية
- `userRoles` — ربط مستخدم ↔ دور
- `sessions` — الجلسات (token, expiresAt, ip, userAgent, revoked)
- `emailVerificationTokens` / `passwordResetTokens` — Tokens مؤقتة (hash, expiresAt, used)
- `phoneVerificationTokens` — أكواد تحقق الهاتف (hash للكود فقط، `attempts`، expiresAt، used) — migration `0015`
- `authenticatorApp` — سر TOTP وأكواد الاسترداد (hash) لكل مستخدم، وحالة التفعيل
- `mfaChallenges` — تحديات الدخول الثنائي (hash للتوكن فقط، `attempts`, `expiresAt`, `consumedAt`, ip/userAgent) — migration `0019`
- `securitySettings` — إعدادات الأمان لكل مستخدم
- `consents` — الموافقات والخصوصية

## 2. الجغرافيا (`schema/geo.ts`)

- `countries` / `regions` / `cities` — هرم جغرافي (بما فيه governorates)
- `currencies` — رمز/اسم/رمز/قواعد عشرية/نشطة
- `exchangeRates` — صرف (base, quote, rate, date, validity)
- `languages` — اللغات المدعومة (ar/fr/en)

## 3. المنتجات (`schema/products.ts`)

- `categories` — شجرة تصنيفات (parentId, slug, isActive, names متعددة اللغات, icon, sortOrder)
- `products` — ال SKU الأساسي (sellerId, sellerType, sku, barcode, basePrice, currencyCode, moq, quantity, unit, countryId, brand, status, purchaseIntent B2B/B2C)
- `productVariants` — تباين (sku, price, attributes)
- `productImages` — صور (url, alt, sortOrder, isPrimary)

## 4. الكيانات التجارية (`schema/trade.ts`)

- `suppliers` / `merchants` / `companies` — ملفات تجارية (verified, isActive, country/city, تواصل)
- `supplierContacts` — مخاطبون
- `companyBranches` — فروع شركة
- `reviews` — تقييمات

## 5. التجارة (`schema/commerce.ts`)

- `orders` / `orderItems` — طلبات (buyerId, sellerId, currency, itemsTotal, commission, paymentFee, grandTotal, status/PAYMENT/REFUND/SETTLEMENT)
- `transactions` — معاملة لكل طلب (totalValue, commission, paymentFee, status 'PAID')
- `transactionLedger` — سجل الحركات (entryType: TRANSACTION_VALUE/COMMISSION/PAYMENT_FEE..., direction, amount, payerId, beneficiaryId, paymentProvider, status)
- `payments` — دفعات (paymentMethodId, status, amount, fee)
- `refunds` — استردادات (amount, reason, status)

## 6. المخزون (`schema/commerce_extras.ts`)

- `inventoryItems` — Stock (productId, quantity, lowStockThreshold, itemLocation)
- `inventoryMovements` — حركة (type: PURCHASE/SALE/ADJUSTMENT, from/to, quantity, reference)

## 7. المحركات (`schema/engine.ts`)

- `commissionPolicies` — سياسات عمولة (policyType, rate, conditions, isActive, priority)
- `commissions` — عمولات فعلية (transactionId, policyId, rate, amount, status)
- `paymentFeePolicies` — رسوم دفع قابلة للتكوين
- `policies` — سياسات عامة (scope, code, name, rules, isActive, version) مثال: ANTI_FEE_EVASION. الـscope enum يشمل `COUNTRY`/`DISPUTE`/`PRIVACY`. السياسة قد تكون عالمية (`country_id = null`) أو تجاوزًا لدولة؛ الحل عبر `resolveMergedPolicy` (country → global) وغياب صف الدولة يُسجَّل في `countryPolicyGaps` كـ`DECISION_REQUIRED`.
- `countryPolicyGaps` — قواعد دولة غير مُعرّفة (scope, code, countryId, status, reason, detectedAt) — تُغلق عند إضافة صف الدولة. مثال: `PRIVACY/DATA_RETENTION` (الاحتفاظ بالبيانات) و`DISPUTE/DISPUTE_RESOLUTION`.

## 8. الاشتراكات (`schema/subscriptions.ts`)

- `subscriptionPlans` — خطط (code, planTarget, priceMonthly/Yearly, currencyCode, features, limits, isActive)
- `subscriptions` — اشتراك مستخدم/كيان (planId, status, period)
- `invoices` — فواتير

## 9. الاتصالات (`schema/messaging.ts`)

- `threads` / `threadParticipants` — محادثات ومشاركون
- `messages` — رسائل (senderId, body, status: SENT/DELIVERED/READ, attachments readiness)
- `notifications` / `notificationPreferences` — إشعارات وتفضيلات

## 10. الثقة والمخاطر (`schema/trust.ts`, `schema/risk.ts`)

- `verification_level` enum (نوع ENUM في `trust.ts`): NONE/BASIC/VERIFIED/BUSINESS_VERIFIED/INTERNATIONAL_VERIFIED — مستويات التحقق (+ شروط كل مستوى في Policy Engine بقسم `VERIFICATION_*`)
- `verificationRequests` — طلبات تحقق (targetLevel, status SUBMITTED/APPROVED/REJECTED, reviewedBy, reviewedAt, reviewNotes)
- `verificationDocuments` — وثائق الطلب (type, ref, verified, uploadedAt)
- `trustScores` — درجة (score 0-100, level LOW/MEDIUM/HIGH, factors JSON, summary قابل للتفسير, effectiveAt)
- `riskEvents` — أحداث خطر (type, severity, score, reasonCode, recommendedAction, outcome)
- `riskProfiles` — ملف خطر لكل حساب

## 11. النزاعات (`schema/disputes.ts`)

- `disputes` (orderId, initiatorId, category, status OPEN/UNDER_REVIEW/DECIDED/CLOSED, rules, decision, decidedBy, assignedToId, assignedAt)
- `disputeEvents` — سجل أحداث (eventType CREATED/MESSAGE_ADDED/EVIDENCE_ADDED/STATUS_CHANGED/ASSIGNED/DECIDED/APPEALED/REOPENED, actor, before/after JSON)
- `disputeMessages` / `disputeEvidence` (files, description)
- `disputeAppeals` (disputeId, appealedById, reason, status PENDING/ACCEPTED/REJECTED, decidedBy, decisionNote, decidedAt, createdAt, updatedAt) — Migration `0010` أضافت `decision_note`/`decided_at`/`updated_at` + فهرس `status`
- Migration `0003`: `dispute_events` + `disputes.assigned_to_id`/`assigned_at` + فهارس

## 12. الإعلانات (`schema/ads.ts`)

- `campaigns` (name, adType: PRODUCT/STORE/SUPPLIER/COMPANY/TOP_SEARCH, budget, targeting, duration, status, billing)
- `adCreatives` (title, media, url, cta)
- `adEvents` (impress/clicks/conversions, sessionId, cost)

## 13. AI (`schema/ai.ts`)

- `aiRequests` (action, input tokens, output tokens, cost, model, provider, status)
- `aiUsage` (aggregate per user/date)
- `aiBudgets` (budgetMonth, spentAmount, status)

## 14. Analytics (`schema/analytics.ts`)

- `analyticsEvents` (event, entityType, entityId, metadata)
- `dailyKpis` (date, metric, value)
- `dashboardReports` (title, type, config, data)

## 15. السجل والمراجعة (`schema/audit.ts`)

- `auditLogs` (actorId, action, entityType, entityId, before, after, ipAddress, userAgent, metadata)
- `favorites` / `savedItems` / `searchHistory` — تفضيلات المستخدم

## 16. الملفات الشخصية (`schema/auth.ts` + `schema/trade.ts`)

- `profiles` — بيانات إضافية (bio, avatar, phone, consents)

## 17. حدّ المعدل (`schema/rate_limit.ts`)

- `rateLimitCounters` (`bucketKey` PK, `count`, `expiresAt`, `expiresAtMs` + فهرس, timestamps) — عدّادات نوافذ حدّ المعدل. لا PII؛ المفتاح `prefix:user:<id>` أو `prefix:ip:<ip>`. تُستخدم فقط عند `RATE_LIMIT_STORE=postgres`.

## 18. الملاحظة (`schema/observability.ts`)

- `alertEvents` (`id` PK, `rule`, `severity`, `status` FIRING/RESOLVED, `summary`, `details` jsonb, `notifiedChannel`/`notifiedResult`, `startedAt`, `resolvedAt`, `createdAt` + فهارس rule/status/createdAt) — سجل انتقالات قواعد التنبيه فقط (لا صف لكل تقييم)، فأثناء بقاء التنبيه firing لا تُضاف صفوف. يُملأ من محرك `lib/observability/alerts.ts`. — migration `0017`

## علاقات مفتاحية

- `orders.buyerId / sellerId` → users/entities
- `transactions.orderId` → orders
- `transactionLedger.transactionId` → transactions
- `commissions.transactionId + policyId`
- `trustScores.userId` + `riskProfiles.userId`
- `disputes.orderId`
- `subscriptions.userId + planId`
- `messages.threadId`

## ملاحظة

- الأرقام المالية: `numeric(18,4)` (تم اعتماد دقة 4 خانات عشرية للتوافق مع الحسابات).
- كل الجداول الأساسية لها `createdAt` (وغالباً `updatedAt`).
- التحكم بالنزاهة عبر Foreign Keys + فهارس للأداء (email, slug, tx, user indexes).