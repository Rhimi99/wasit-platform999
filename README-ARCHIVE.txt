# WASIT BUSINESS GLOBAL — Full Archive

هذا الأرشيف كامل: الشيفرة المصدرية + الاعتماديات (node_modules) + migrations + الاختبارات + الوثائق.

## المحتويات

- `packages/server` — الـ Core الكامل (Hono + TypeScript + Drizzle + PostgreSQL)
- `packages/shared` — الثوابت المشتركة (أدوار، صلاحيات، أخطاء)
- `packages/web` — الواجهة (بنية React)
- `node_modules` — كل الاعتماديات مثبتة
- `docs/` — 14 ملف توثيق
- `AGENTS.md` — ذاكرة الوكيل وحالة المشروع

## البداية السريعة

```bash
# 1) فك الضغط
unzip wasit-business-global-full.zip -d wasit-business-global
cd wasit-business-global

# 2) إصلاح الروابط الرمزية (اختياري) — إذا كانت node_modules/@wasit روابط لا تعمل على نظامك
rm -rf node_modules
npm install

# 3) إعداد المتغيرات
cd packages/server
cp .env.example .env          # عدّل القيم
# أنشئ قاعدتي البيانات:
createdb wasit_dev
createdb wasit_test

# 4) المهاجرة + البذرة
npm run db:migrate
npm run db:seed

# 5) الاختبارات (تتطلب PostgreSQL)
npm test

# 6) التشغيل
npm run dev                    # → http://localhost:3000
```

## ملاحظات أمنية

- ملف `.env` (الأسرار الحقيقية) **ليس** داخل الأرشيف — استخدم `.env.example`.
- لا تضع الأسرار في أي مستودع عام.