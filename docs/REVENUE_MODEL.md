# REVENUE MODEL — WASIT BUSINESS GLOBAL

## 1. المصادر الحالية

1. **العمولة (Commission)**
   - النموذج الأساسي: **4% من قيمة الصفقة**, مقسّمة **2% على البائع + 2% على المشتري**.
     - **غير Hardcoded** — سياسة `BASE` في `commission_policies` (`rate = 0.04`, `seller_rate = 0.02`, `buyer_rate = 0.02`).
     - قابل للتخصيص لاحقاً حسب: Account Type، B2B/B2C، Transaction Value، Volume، Country، Currency، Sector، Product، Subscription، Verification، Activity — عبر Policy Engine (مع Audit).
   - لا توجد عمولة Wasit أساسية إضافية. المحرك يفشل مغلقاً (`COMMISSION_POLICY_MISSING`) إذا لم تطابق أي سياسة فعالة.
2. **رسوم معالجة الدفع (Payment Processing Fees)**
   - منفصلة عن العمولة، من `payment_fee_policies`.
   - المتطلب: شفافية Payer/Beneficiary لكل حركة.
3. **الإعلانات (Advertising)**
   - Product Ads / Store Ads / Supplier Ads / Company Ads / B2B / B2C / Top Ads / Sponsored Search.
   - تحصيل عبر Campaigns + Billing (في الطريق).
4. **الاشتراكات (Subscriptions)**
   - CUSTOMER (FREE) — مجاني
   - SMALL MERCHANT — مدفوع منخفض (seed: 19 TND/شهر)
   - COMPANY — 99 TND/شهر (seed)
   - PRO MAX — 299 TND/شهر (seed)
   - أسعار قابلة للتعديل من Admin (في DB وليست Hardcoded).
5. **AI Revenue** (اختياري مستقبلاً) — عبر AI Budgets / tiered usage.

## 2. معادلات محاسبية (يمثلها نظام Ledger)

```
Transaction Value  = Σ (unitPrice × quantity)
Commission         = TransactionValue × policyRate
Payment Fee        = من payment_fee_policies (أو فاتورة المُعالج)
Net to Seller      = TransactionValue − Commission − PaymentFee (حسب الشروط)
Payer / Beneficiary = مسجل في ledger لكل حركة
```

## 3. نمذجة القرار (Model)

- كل Transaction: رقم مرجعي + عملة + عمولة + رسوم + حالة PAID + أطراف + مزود دفع.
- العمولة تُسجل كـ `commission` policy مرجعية (policyId) — قابلة للتدقيق.

## 4. قرارات مالية محفوظة

- **لا Wallet**: WASIT لا يحتفظ برصيد عملاء — إشراف RegTech أبسط وأأمن قانونياً.
- **العملة**: TND أساس عمليات dev؛ Currency Engine يدعم Display/Transaction Currency لاحقاً.
- **رسوم الدفع**: منفصلة تماماً عن العمولة (حسب Model المرجعي والرؤية).

## 5. DECISION REQUIRED (غير محسومة)

- من يتحمل رسوم الدفع افتراضياً (البائع/المشتري/الطرفين) في كل سوق؟
- تحصيل العمولة: خصم تلقائي من التسوية أم فاتورة منفصلة؟
- متى تُحصَّل الاشتراكات (بطاقة/تحويل/وسيط محلي) — حسب كل دولة؟
- سياسات الإرجاع والشحن (خارج نطاق WASIT حسب التعليمات حتى يُحدد).
- KYC/AML وشكليات الدفع القانونية لكل بلد.

> لا تُتخذ هذه القرارات من الوكيل؛ تُرفع للجهة المالكة.