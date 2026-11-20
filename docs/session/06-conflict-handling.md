# 6. معالجة التعارضات

## القاعدة الأولى

**احمِ العمل، ثم توقّف.** لا تُصلح تعارضًا بأمر تدميري.

ممنوع دائمًا: `git push --force` · `git reset --hard` · `git clean -fd` ·
حذف فرع · استبدال مجلد · `git checkout -- .` فوق تغييرات غير محفوظة.

## قبل أي محاولة إصلاح

```bash
./scripts/session/session status          # ما الذي يختلف؟
./scripts/session/session backup --label before-conflict-fix
```

الـbundle هو شبكة الأمان: إن ساءت الأمور، يمكن الاستعادة منه إلى مجلد جديد.

## الحالة 1 — الدفع مرفوض (non-fast-forward)

```
! [rejected] master -> master (fetch first)
✖ push rejected — the commit exists locally but is NOT on GitHub.
```

المعنى: GitHub لديه commits ليست عندك. **لا تدفع بالقوة.**

```bash
git fetch origin
git log --oneline --left-right origin/master...HEAD   # ما الفرق؟
git diff origin/master...HEAD --stat
```

- إن كانت تغييراتك لا تتعارض: `git pull --ff-only` (إن أمكن) أو
  `git rebase origin/master` ثم أعد الاختبارات ثم `--push-only`.
- إن تعارضت: افتح فرعًا للمهمة، حلّ التعارض يدويًا، اختبر، ثم ادمج بـfast-forward.

## الحالة 2 — تعارض دمج/rebass ظاهر

```bash
git status            # Unmerged paths
```
1. افتح كل ملف وابحث عن `<<<<<<<`.
2. قرّر المحتوى الصحيح يدويًا (لا «ours/theirs» عشوائيًا).
3. `git add <file>` ثم أكمل العملية.
4. شغّل الاختبارات.
5. checkpoint.

إن لم تكن متأكدًا: `git rebase --abort` / `git merge --abort` — يعيدان الحالة
السابقة بلا فقدان commitsك، ثم اطلب مراجعة بشرية.

## الحالة 3 — HEAD detached

```bash
git switch -c rescue/<name>     # ثبّت العمل على فرع
```

## الحالة 4 — commits محلية على نسخة قديمة من الحاوية

1. في النسخة القديمة: `backup` + `checkpoint --push-only` إن أمكن.
2. في النسخة الجديدة: `git fetch` ثم `git cherry-pick <sha>` لكل commit.
3. اختبر، ثم checkpoint.

## الحالة 5 — ملفات متجاهَلة تتعارض مع بيئة جديدة

`.env` وdumps ليست في Git، فلا «تعارض» حقيقيًا. لا تنسخ فوق ملفات البيئة
الحديثة؛ قارن أولًا:

```bash
diff -u <القديم>/.env <الجديد>/.env | head -40
```

## الحالة 6 — فقدان commits «مخفية» في stash

```bash
git stash list
git stash show -p stash@{0} | head -50
git stash branch rescue/stash-0 stash@{0}   # يحوّلها إلى فرع آمن
```

## متى تتوقف وتطلب مراجعة

- تعارض في `packages/server/src/db/migrations/` أو `_journal.json`.
- تعارض في سياسات مالية (`commission_policies`, `payment_fee_policies`).
- اختلاف غير مفسَّر بين HEAD و`origin/master` بعد `fetch`.
- أي حالة تتطلب `--force` لحلها.

في هذه الحالات: bundle + تقرير بالأدلة، ثم توقّف.
