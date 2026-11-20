# 4. الاستعادة بعد فقدان الحاوية

> السيناريو: جلسة جديدة، `/workspace/project/wasit-platform999` غير موجود أو فارغ.
> **لا تنشئ مشروعًا يدويًا ولا تنسخ فوق مجلد قائم.**

## 0. لا تفعل

- لا `git clone` داخل مجلد موجود.
- لا تحذف مجلدًا قديمًا «للتّنظيف».
- لا تنشئ مستودعًا جديدًا.
- لا تبدأ العمل قبل التحقق من تطابق HEAD مع `origin`.

## 1. حدّد المصدر

| الحالة | المصدر |
| --- | --- |
| الشبكة تعمل | GitHub (الافتراضي) |
| لا شبكة، ويوجد bundle | ملف `.bundle` + SHA-256 |
| لا شبكة ولا bundle | توقّف واطلب النسخة — لا تخمّن |

البحث عن النسخ المتاحة:

```bash
ls -1t /workspace/recovery/*.bundle 2>/dev/null
ls -1t /workspace/project/wasit-platform999/backups/git/*.bundle 2>/dev/null
cat /workspace/project/wasit-platform999/backups/git/manifest.tsv 2>/dev/null
```

## 2. استعادة من GitHub

```bash
./scripts/session/session recovery --target /workspace/project/wasit-platform999-restored
```

الأداة:
1. ترفض الهدف إن كان موجودًا وغير فارغ؛
2. تستنسخ الفرع المطلوب (`--branch master` افتراضيًا)؛
3. تتحقق أن HEAD == `origin/<branch>`؛
4. تطبع تقريرًا.

ثم:

```bash
cd /workspace/project/wasit-platform999-restored
./scripts/session/session start
```

## 3. استعادة من bundle

```bash
./scripts/session/session recovery \
  --bundle /workspace/recovery/wasit-t53.bundle \
  --sha256 <القيمة من manifest أو من مصدر موثوق> \
  --repo https://github.com/Rhimi99/wasit-platform999.git \
  --branch master \
  --target /workspace/project/restored-from-bundle
```

- إن لم يُمرَّر `--sha256` ترفض الأداة (إلا مع `--allow-unverified`).
- `git bundle verify` يجب أن ينجح قبل أي كتابة.
- بعد الاستعادة تُضبط `origin` على المستودع الحقيقي ويُجلب الفرع.

## 4. تحقق بعد الاستعادة

| الفحص | الأمر | المتوقع |
| --- | --- | --- |
| HEAD | `git rev-parse HEAD` | يساوي `git rev-parse origin/master` |
| آخر commit | `git log -1 --oneline` | الرسالة المتوقعة |
| عدد commits | `git rev-list --count HEAD` | ≥ آخر رقم معروف |
| نظافة الشجرة | `git status --porcelain` | فارغ |
| بوابة الجلسة | `./scripts/session/session start` | SAFE |

## 5. ما لا يمكن استعادته من Git

هذه ملفات مقصود ألا تكون في Git، ولا تُستعاد تلقائيًا:

| الملف | كيف يُستعاد |
| --- | --- |
| `.env` / `.env.demo` | من مدير الأسرار أو نسخة خارجية آمنة |
| `backups/*.dump` | نسخ PostgreSQL الخارجية (`scripts/restore-db.sh`) |
| `packages/server/.wasit-media/` | تُعاد توليدها |
| `e2e/.auth/` | يُعاد توليدها بتشغيل E2E |
| `node_modules/` | `npm ci` |

## 6. عند وجود نسخة قديمة سليمة

لا تحذفها ولا تستبدلها. قارن:

```bash
git -C <القديمة> rev-parse HEAD
git -C <الجديدة> rev-parse HEAD
git -C <القديمة> status --porcelain
```

إن كانت القديمة تحمل commits غير مدفوعة، احمها أولًا:

```bash
cd <القديمة>
./scripts/session/session backup --dest /workspace/recovery
./scripts/session/session checkpoint --push-only   # إن كان الفرع موجودًا على origin
```

ثم انقل العمل يدويًا (cherry-pick) على المساحة الجديدة، ووثّق ما فعلت.

## 7. تقرير الاستعادة

كل استعادة تنتهي بتقرير يذكر: المصدر، الـSHA المتوقع/الفعلي، الفرع، عدد
commits، وحالة الشجرة. احتفظ به في وصف المهمة أو في commit وثائقي.
