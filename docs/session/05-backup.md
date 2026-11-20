# 5. النسخ الاحتياطي المستقل — Git bundle

## لماذا bundle؟

GitHub مصدر دائم، لكنه ليس النسخة الوحيدة الممكنة: حساب قد يتغيّر، وشبكة قد
تنقطع، ومستودع قد يُغلق. الـbundle ملف واحد يحتوي **كل** المراجع، ويُستعاد
بـ`git clone` بلا شبكة.

## الإنشاء

```bash
./scripts/session/session backup
./scripts/session/session backup --label before-obs-02 --dest /mnt/external/wasit
```

| الخيار | الافتراضي |
| --- | --- |
| `--dest` | `<repo>/backups/git` (مستثنى من Git) أو `$WASIT_BUNDLE_DIR` |
| `--label` | بلا لاحقة — يظهر في اسم الملف |
| `--keep N` | 10 |
| `--prune` | معطّل |
| `--unshallow` | يكمل التاريخ أولًا إن كان الـclone ضحلًا (انظر أدناه) |

الخطوات الداخلية:

1. إن كان الـclone ضحلًا: تحذير، أو `git fetch --unshallow` مع `--unshallow`.
2. `git bundle create <file>.partial --all` ثم `git bundle verify`.
3. **اختبار استعادة حقيقي**: `git clone` للـbundle في مجلد مؤقت ومقارنة HEAD؛
   إن فشل يُحذف الـbundle ويُعاد الخطأ (لا يُسجَّل في الـmanifest).
4. إعادة التسمية فقط بعد نجاح التحقق (لا يبقى ملف نصف مكتمل باسم صالح).
5. `sha256sum` + الحجم + HEAD + الفرع + عدد المراجع.
6. سطر جديد في `manifest.tsv`.

## تحذير: clone ضحل (shallow)

`git bundle verify` **لا يكفي**. bundle مأخوذ من clone ضحل يمرّ من `verify` ثم
يفشل عند `git clone` بـ:

```
error: Could not read <sha>
fatal: Failed to traverse parents of commit <sha>
fatal: remote did not send all necessary objects
```

السبب: آباء الحدّ الضحل غير موجودة في الحزمة. الحل:

```bash
git rev-parse --is-shallow-repository        # true؟
./scripts/session/session backup --unshallow
```

أثر `--unshallow` (مُقاس في هذه المساحة): `commits 37 → 136`،
`shallow true → false`، **HEAD والمراجع والشجرة بلا تغيير**. يضيف كائنات فقط،
لا يعيد كتابة تاريخ ولا يلمس ملفًا.

لهذا صار `session-backup` يجري استنساخًا تجريبيًا قبل قبول أي حزمة: النسخة التي
لا تُستعاد ليست نسخة.


## الـmanifest

```
timestamp            sha256    size_bytes  head  branch  refs  bundle
20261120T192954Z     85d859…   1196…       fc4c… master  6     wasit-….bundle
```

هو سجل التدقيق: منه تُعرف النسخة الصحيحة لأي bundle.

## التحقق الدوري (drill)

```bash
./scripts/session/session recovery \
  --bundle backups/git/wasit-<stamp>.bundle \
  --sha256 <من manifest> \
  --target /tmp/restore-drill-$(date +%s)
```

النجاح = HEAD المستعاد يساوي HEAD المذكور في الـmanifest، وشجرة نظيفة.

## مكان التخزين

| الخيار | الحالة |
| --- | --- |
| `<repo>/backups/git` | يعمل الآن، مستثنى من Git، يبقى على القرص نفسه (ليس حماية من فقدان الحاوية) |
| قرص/Volume مثبّت (`/mnt/...`) | أفضل — `--dest` |
| مستودع خاص منفصل | **مثالي، لكنه يتطلب موافقة المالك** وصلاحيات إنشاء مستودع |
| تخزين كائنات (S3/R2…) | يتطلب بيانات اعتماد وموافقة |

## قواعد أمنية

- **ممنوع** رفع أي `.bundle` إلى مستودع WASIT العام: قد يحتوي تاريخًا كاملًا
  وملفات لم تعد على الفرع الحالي.
- الـbundle **لا يحتوي** `.env` أو dumps أو وسائط (كلها غير متتبعة)، لكنه يحتوي
  التاريخ — تعامل معه كملف حساس.
- لا تُطبع محتويات الـmanifest في قنوات عامة.
- صلاحيات: `0700` للمجلد، `0600` للـmanifest (تضبطها الأداة).

## ماذا لو فقدت الحاوية ومعها `backups/git`؟

الحماية الحقيقية هي نسخة **خارج** الحاوية. إن لم تكن موجودة، المصدر الوحيد هو
GitHub. لهذا يوصي الدليل بتنفيذ `backup` مع نسخ الـbundle إلى قرص خارجي في كل
يوم عمل، أو عند توفّر مستودع خاص.
