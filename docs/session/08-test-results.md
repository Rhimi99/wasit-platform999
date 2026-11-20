# 8. سجل نتائج الاختبارات العملية

> كل ما في هذا الملف نتج عن تشغيل فعلي في `2026-11-20`، لا عن توقّع نظري.
> أمر الإعادة: `./scripts/session/session-selftest.sh`

## البيئة

| البند | القيمة |
| --- | --- |
| المضيف | حاوية OpenHands (Linux) |
| المستودع | `https://github.com/Rhimi99/wasit-platform999.git` |
| الفرع الأساسي | `master` @ `6e8e006` (وقت التشغيل) |
| فرع الاختبار | `session-selftest-20261120-193115` (ليس master) |
| مجلد العمل | `mktemp -d` تحت `/tmp` (حُذف بعد النجاح) |
| الشبكة | GitHub متاح (clone + push) |

## النتيجة

**22/22 ناجح · 0 فاشل** — تشغيلان متتاليان بنفس النتيجة
(`…193115` و`…192945`).

| # | السيناريو المطلوب | ما نُفِّذ | النتيجة |
| --- | --- | --- | --- |
| 1 | بدء جلسة من clone نظيف | `session-start` على clone جديد | ✅ SAFE |
| 2 | تعديل تجريبي في ملف اختبار | إنشاء/تعديل `docs/session/selftest-fixture.txt` | ✅ |
| 3 | إنشاء checkpoint | `session-checkpoint -m …` على فرع الاختبار | ✅ commit `da71a06` |
| 4 | دفعه إلى فرع اختبار آمن | `push -u origin HEAD:refs/heads/session-selftest-…` | ✅ |
| 5 | التحقق من وجوده على GitHub | `git ls-remote` | ✅ `da71a0669b82…` |
| 6 | محاكاة فقدان مجلد العمل | `mv repo-a repo-a-lost` (بلا حذف) | ✅ |
| 7 | إنشاء clone جديد | `git clone --branch session-selftest-…` | ✅ |
| 8 | استعادة التعديل والـcommit نفسه | `rev-parse HEAD` في النسخة الجديدة | ✅ نفس SHA |
| 9 | مقارنة SHA والملفات | `sha256sum` للملف + مقارنة HEAD | ✅ `580c85c7…9e347d` |
| 10 | اكتشاف الملفات غير المتتبعة | `session-status --strict` | ✅ خروج 1 + `untracked 1` |
| 11 | اكتشاف الملفات المتجاهَلة المهمة | إنشاء `.env` | ✅ يظهر تحت ignored-important |
| 12 | اكتشاف commits غير مدفوعة | commit محلي فقط | ✅ `ahead: 1` + خروج 1 |
| 13 | رفض الإغلاق مع تعديلات غير محفوظة | `session-close` | ✅ `NOT SAFE TO CLOSE` |
| 14 | رفض الحفظ عند اكتشاف أسرار | `ghp_` وهمي في ملف مُstage | ✅ رفض + لا commit + لا طباعة للقيمة |
| 15 | فشل الشبكة أثناء الدفع والتعافي | remote غير قابل للوصول ثم `--push-only` | ✅ commit محلي محفوظ، ثم دفع ناجح |
| 16 | استعادة bundle والتحقق من SHA-256 | `session-backup` ثم `session-recovery --bundle --sha256` | ✅ HEAD مطابق |
| 16b | bundle مُتلَف | تعديل بايت + SHA متوقع | ✅ رفض قبل أي كتابة |
| 16c | إغلاق آمن لمساحة سليمة | `session-close` على النسخة المستعادة | ✅ SAFE TO CLOSE |

## الأدلة القابلة للتحقق

```text
# الفرع على GitHub
c0aa1a394fd98730668fb6ba7fab850acb5a3629  refs/heads/session-selftest-20261120-193115

# تاريخ الفرع
c0aa1a3 test: push will fail          (الـcommit الذي فشل دفعه ثم نجح)
72aa826 test: local-only commit       (commit غير مدفوع، كشفه الفحص)
da71a06 test: session selftest checkpoint
6e8e006 fix(session): allow bundle destinations outside the work tree

# ملف الاختبار بعد الاستعادة
580c85c7bb8c5e1b0af04cadc4fc8ecf68266b0a6da83af8fbbc751e0f9e347d

# bundle الناتج
wasit-20261120T193125Z-selftest.bundle
4ffe374218a87df648d75e91ccadcbc99a770d0b9cc012917548f913629ff0f7  12970042 bytes  10 refs
```

سطر الـmanifest الفعلي:

```
20261120T193125Z  4ffe3742…ff0f7  12970042  c0aa1a39…3629  session-selftest-20261120-193115  10  wasit-20261120T193125Z-selftest.bundle
```

## Drill على النسخة الحقيقية (بعد إصلاح shallow)

| الخطوة | النتيجة |
| --- | --- |
| `session backup --label shallow-guard` على clone ضحل | ✅ رفض الحزمة (لا تُستنسخ) وحذفها، ولم تُسجَّل في manifest |
| `session backup --unshallow` | ✅ `restore-verified: a fresh clone reproduces f58f14b` |
| أثر unshallow | `commits 37 → 136`، `shallow true → false`، HEAD والمراجع بلا تغيير |
| bundle الإنتاجي | `wasit-20261120T193323Z-post-session-system.bundle` |
| sha256 | `57707a2ebc6bfb528835be210b1e9602e2075b82cef15d161df9b876b60f202d` |
| الحجم / المراجع | 12,204,760 bytes / 5 |
| `session recovery` من الـbundle | ✅ HEAD = `f58f14b…` = `origin/master`، شجرة نظيفة، 136 commit |

> هذا الـdrill كشف عيبًا حقيقيًا: `git bundle verify` ينجح على حزمة من clone
> ضحل بينما `git clone` منها يفشل. لذلك صار `session-backup` يستنسخ الحزمة
> تجريبيًا قبل قبولها، ويرفض ما لا يُستعاد.

## شفافية: التشغيلات السابقة وإصلاحاتها


| التشغيل | النتيجة | السبب | الإصلاح |
| --- | --- | --- | --- |
| #1 | 4 ناجح / 17 فاشل | الاختبار شغّل الأدوات من المستودع الأصلي لا من الـclone (فرفض checkpoint لأنه على master) | أُضيف `run_in <dir>` لتشغيل الأدوات داخل مساحة الاختبار |
| #2 | 19 ناجح / 2 فاشل | `session-backup` رفض وجهة `/tmp` لأنها ليست git-ignored | صار الحارس يطبَّق داخل المستودع فقط؛ الخارج مسموح |
| #3 | 22/22 | — | — |
| #4 | 22/22 | إعادة تأكيد | — |
| #5 | 22/22 | إعادة تشغيل **بعد** إصلاح الـbundle الضحل (فرع `…193410`) | لا تراجع |
| #6 | 22/22 | إعادة تشغيل بعد إصلاح ترتيب قاعدة `backups/git` (فرع `…193523`) | لا تراجع |

## ما لم يُختبر (بصراحة)

1. **فقدان الحاوية فعليًا**: محاكاة بـ`mv` داخل `/tmp`، لا بإعادة إنشاء حاوية.
   الفرق: بيئة الحاوية الجديدة قد تفتقد أدوات (git/شبكة) — لا Git نفسه.
2. **دفع متزامن من عمليتين**: لم يُختبر race على نفس الفرع.
3. **bundle أكبر من مساحة القرص**: لا اختبار لنقص المساحة أثناء الكتابة
   (الأداة تكتب باسم `.partial` فلا يبقى ملف صالح ناقص).
4. **مستودع خاص للنسخ**: يتطلب موافقة المالك (انظر [النسخ الاحتياطي](05-backup.md)).
5. **استعادة قاعدة البيانات**: مسار منفصل (`scripts/restore-db.sh`).

## فروع الاختبار على GitHub

أُنشئت فروع اختبار فقط (لا master):

- `session-selftest-20261120-192915`
- `session-selftest-20261120-192945`
- `session-selftest-20261120-193115`
- `session-selftest-20261120-193410` (بعد إصلاح shallow)
- `session-selftest-20261120-193523` (بعد إصلاح ترتيب القواعد)

لم تُحذف: الحذف ممنوع في سياسة هذه المهمة. يمكن للمالك حذفها من GitHub عند
الرغبة؛ لا تؤثر على `master`.
