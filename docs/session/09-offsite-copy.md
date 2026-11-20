# 9. نسخة خارج الحاوية (offsite)

> الحالة المُتحقَّقة في `2026-11-20`: **لا يوجد تخزين خارجي مصرَّح به**.
> النسخ الحالية محلية فقط. هذا الملف يشرح الواقع وخيارات النقل اليدوي وخطوات
> التحقق — لا يفترض وجود خدمة تخزين.

## الواقع المقاس

| العنصر | النتيجة |
| --- | --- |
| `/workspace` | جهاز كتلة مستقل `/dev/nvme0n2` (ext4، 25G، متاح 24G) — يبقى عند إعادة إنشاء الحاوية |
| `/` | overlay مؤقت — يُفقد بالكامل |
| `/mnt` `/media` `/srv` | فارغة (لا أقراص مثبّتة) |
| أدوات النقل | `rclone` `aws` `s3cmd` `gsutil` `restic` `borg` `rsync` `ssh` `scp` — **غير مثبّتة** |
| متغيّرات تخزين | لا شيء (`S3_*`/`AWS_*`/`R2_*` غير موجودة) |
| مستودع GitHub | **عام** ⇒ يُمنع رفع أي bundle إليه |

**الخلاصة:** `backups/git` ينجو من إعادة إنشاء الحاوية (لأنه على `/workspace`)،
لكنه لا ينجو من حذف/إعادة تهيئة الـvolume أو فقدان المضيف. الحماية الحقيقية تتطلب
نسخة **خارج** `/workspace`.

## قبل أي نقل

1. أنشئ أحدث نسخة: `./scripts/session/session backup --label offsite`
2. سجّل الـSHA من الـmanifest:
   ```bash
   tail -1 backups/git/manifest.tsv
   ```
3. انقل الملف **كما هو** (لا تعيد ضغطه ولا تعدّله).

## الخيار A — مستودع خاص للنسخ (الأفضل، يتطلب موافقة المالك)

> لا يُنشأ حساب أو مستودع دون موافقة صريحة. المستودع يجب أن يكون **خاصًا**.

```bash
# 1) بعد الموافقة: أنشئ مستودعًا خاصًا (مرة واحدة)
gh repo create Rhimi99/wasit-backups --private

# 2) ارفع الحزمة كملف عادي (12MB، أقل من حد GitHub 100MB)
mkdir -p /tmp/wasit-offsite && cd /tmp/wasit-offsite
git init -q && git remote add origin https://github.com/Rhimi99/wasit-backups.git
cp /workspace/project/wasit-platform999/backups/git/wasit-<stamp>.bundle .
git add . && git commit -qm "backup <stamp>" && git push -u origin HEAD:main

# 3) تحقّق من الطرف الآخر
git clone -q https://github.com/Rhimi99/wasit-backups.git /tmp/wasit-offsite-check
sha256sum /tmp/wasit-offsite-check/wasit-<stamp>.bundle
```

## الخيار B — تخزين كائنات (S3 / R2 / B2)

يتطلب تثبيت `rclone` وبيانات اعتماد من المالك:

```bash
rclone copy backups/git/wasit-<stamp>.bundle remote:wasit-backups/git/
rclone check backups/git/ remote:wasit-backups/git/ --include '*.bundle'
```

## الخيار C — نسخ يدوي من المالك

إن كان لديك وصول إلى الـvolume (أو أداة تنزيل ملفات من الحاوية):

```bash
# على المصدر
sha256sum backups/git/wasit-<stamp>.bundle
# على الهدف (بعد النقل)
sha256sum /path/to/wasit-<stamp>.bundle
```

يجب أن تتطابق القيمتان حرفيًا.

## التحقق بعد كل نقل

| الفحص | الأمر | المتوقع |
| --- | --- | --- |
| تطابق البصمة | `sha256sum` في الطرفين | نفس القيمة |
| سلامة الحزمة | `git bundle verify <file>` | `The bundle records a complete history` |
| قابلية الاستعادة | `./scripts/session/session recovery --bundle <file> --sha256 <sha> --target <dir جديد>` | HEAD = HEAD المذكور في الـmanifest |

## ممنوع

- رفع bundle إلى المستودع العام (`Rhimi99/wasit-platform999`).
- إنشاء مستودع/حساب/دلو تخزين دون موافقة.
- اعتبار `/workspace` «خارج الحاوية» — هو داخل الحاوية وإن كان على volume.

## سجل النقل (يُحدَّث يدويًا)

| التاريخ | الحزمة | sha256 | الوجهة | تحقق |
| --- | --- | --- | --- | --- |
| — | — | — | لا يوجد بعد | — |
