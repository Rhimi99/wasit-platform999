# 1. بداية الجلسة — `session-start`

## الغرض

قبل أن تلمس أي ملف، يجيب الأمر عن سؤال واحد: **هل هذه المساحة آمنة للعمل؟**
إذا كانت هناك أعمال غير محفوظة أو commits غير مدفوعة أو نسخة محلية متأخرة،
يجب حمايتها أولًا — لا البدء فوقها.

## التشغيل

```bash
cd /workspace/project/wasit-platform999
./scripts/session/session start
```

الخيارات:

| الخيار | الأثر |
| --- | --- |
| `--report-only` | يطبع التقرير ويخرج بـ0 دائمًا (للفحص البشري فقط) |
| `--no-fetch` | لا يتصل بـGitHub؛ الحالة البعيدة تصبح `UNVERIFIED` والنتيجة UNSAFE |

رموز الخروج: `0` آمن · `1` غير آمن (الأسباب مطبوعة) · `3` لسنا داخل مستودع.

## ما يفحصه

| الفحص | لماذا |
| --- | --- |
| المسار والفرع وHEAD | التأكد أنك في المستودع الصحيح |
| `git fetch origin` | آخر حالة على GitHub |
| upstream / ahead / behind | commits محلية غير مدفوعة، أو نسخة متأخرة |
| staged / unstaged / untracked | عمل لم يدخل Git بعد |
| conflicts / stashes | عمل مخفي أو غير مدمج |
| ignored-but-important | ملفات لن يحميها Git أبدًا (`.env`، dumps، وسائط) |
| bundles المتاحة | هل توجد نسخة مستقلة عن GitHub؟ |

## كيف تقرأ النتيجة

```
✔ SAFE — workspace matches GitHub, nothing unsaved
```
استمر.

```
✖ UNSAFE — do not start new work until these are resolved:
  • 2 local commit(s) are not on origin/master — push them or protect them first
```

| السبب | الإجراء الصحيح |
| --- | --- |
| commits غير مدفوعة | `./scripts/session/session checkpoint --push-only` |
| شجرة غير نظيفة | راجع الملفات، ثم checkpoint (أو bundle إن كانت لا تُرفع) |
| متأخر عن البعيد (behind) | `git pull --ff-only` ثم أعد الفحص |
| detached HEAD | `git switch -c rescue/<name>` قبل أي شيء |
| stash موجود | `git stash list` وراجعها، أو اعتمدها `--ack-stash` عند الإغلاق فقط |
| لا يوجد bundle | `./scripts/session/session backup` |

> `UNSAFE` ليس خطأً في الأداة؛ هو المنع المقصود. لا تتجاوزْه بـ`--report-only`.

## عند العمل داخل حاوية جديدة

إذا كان المسار غير موجود أو فارغ، لا تنشئ مشروعًا يدويًا: اذهب إلى
[دليل الاستعادة](04-container-recovery.md).
