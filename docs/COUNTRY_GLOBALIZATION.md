# COUNTRY GLOBALIZATION — WASIT BUSINESS GLOBAL

الهدف: تبدأ من تونس لكن البنية **Global-first** — لا تونس Hardcoded في الـ Core.

## 1. نمذجة البيانات الجغرافية

```
countries (isocode / name / nameAr / nameFr / isActive / flag / phoneCode)
  → regions (countryId / name / type e.g. governorate)
    → cities (regionId / name / lat/lng)
currencies (code / symbol / decimalPlaces / isActive / isDefault?)
exchangeRates (from / to / rate / date / status)
languages (code ar|fr|en / isActive / direction rtl|ltr / isDefault)
```

All configurable via Admin/Policy — country policies (قوانين تحقق، نزاعات، إعلانات، عمولات) قابلة للتخزين بوصف JSON في `countries` أو `policies`.

## 2. التكوين الحالي (Seed)

- تونس: دول/مناطق/مدن/عملة TND/لغات (ar/fr/en) تتضمن seed.
- العملة الافتراضية للتطوير TND (ولكن كل معاملة تسجل عملتها الخاصة).

## 3. اللغات

- **RTL (ar)** + **LTR (fr, en)**.
- Translation Keys (لا نصوص مباشرة داخل Components).
- `locale` في users (default 'ar') وجاهزية `Accept-Language`.

## 4. العملات

- Currency Engine: `code / symbol / decimalPlaces` + `exchangeRates` readiness.
- الفصل بين **Display Currency** و **Transaction Currency** موضح في الوثائق.

## 5. سياسات كل دولة (readiness)

- Verification Rules / Risk Rules / Dispute Rules / Advertising Rules / Subscription Rules — بنية Policies تسمح بالتفريق حسب `countryId`.
- Payment Provider Configuration — قابل للإضافة (لا توجد افتراضية مزود واحد).

## 6. خطوات إضافة سوق جديد (بدون إعادة بناء Core)

1. إدراج البلد/المناطق/المدن عبر Admin (أو seed).
2. تفعيل العملة والمعدل.
3. تحديد سياسة التحقق/العمولة/الخطر/النزاع الخاصة به.
4. ضبط Provider دفع (إن وُجد تكامل).
5. تفعيل الدولة في `policies` (Country Activation).

## 7. مبدأ

أي ميزة ترتبط بدولة يجب أن تقرأ config من DB، لا أن تعتمد if (country === 'TN').