# 2. الحفظ المرحلي — `session-checkpoint`

## الفكرة

checkpoint = **commit صغير + دفع فوري**. لا تنتظر نهاية المهمة: كل جزء مكتمل
ومُختبَر يستحق checkpoint. الفارق بين checkpoint و«لاحقًا» هو الفارق بين فقدان
دقائق وفقدان يوم عمل.

## التشغيل

```bash
# على فرع مهمة (المُفضّل)
git switch -c task/obs-02
./scripts/session/session checkpoint -m "feat(obs-02): add retry budget table"

# على master عندما يكون مسار المشرف المعتمد fast-forward مباشرًا
./scripts/session/session checkpoint --allow-master -m "docs: …"

# دفع commit موجود دون إنشاء commit جديد (بعد انقطاع شبكة مثلًا)
./scripts/session/session checkpoint --push-only
```

| الخيار | الأثر |
| --- | --- |
| `-m, --message` | رسالة الـcommit (إلزامية إلا مع `--push-only`) |
| `--no-push` | commit محلي فقط — **ليس نسخة احتياطية**، ويُطبع تحذير |
| `--push-only` | يدفع HEAD الحالي ويتحقق من التطابق |
| `--allow-master` | يسمح بالحفظ على master (ممنوع افتراضيًا) |
| `--co-author "A <a@b>"` | يضيف `Co-authored-by` |
| `--dry-run` | يعرض المحتوى ولا ينفّذ |
| `-- paths…` | يحفظ مسارات محددة بدل `git add -A` |

## ما يفعله بالترتيب

1. يرفض العمل على `master` إلا بموافقة صريحة، ويرفض detached HEAD.
2. `git add -A` (بلا `-f`) — لذلك **لا يمكن** أن يدخل ملف متجاهَل مثل `.env`.
3. يعرض `--stat` لما سيُحفظ.
4. **بوابة الأسرار**: يفحص السطور المضافة فقط في الـstaged diff.
5. ينشئ الـcommit.
6. يدفع `HEAD:refs/heads/<branch>` بلا `force`، ثم يتحقق أن
   `origin/<branch>` يساوي HEAD محليًا.

## بوابة الأسرار

تُرفض الأنماط عالية الثقة: مفاتيح خاصة، `ghp_…`، `github_pat_…`، `sk-…`،
`AKIA…`، `xox…`، `AIza…`، وأي إسناد لقيمة طويلة لاسم يحتوي
`TOKEN/SECRET/PASSWORD/API_KEY`. كما تُرفض أسماء ملفات مثل `.env` أو `*.pem`.

عند الرفض:

```
✖ checkpoint refused — the staged changes look like they contain secrets:
  • config.ts (github-token)
```
- لا تُطبع القيمة نفسها أبدًا.
- لا يُنشأ commit ولا يُدفع شيء.
- الملفات تبقى staged.

**الحل**: انقل القيمة إلى متغيّر بيئة، أو استخدم قيمة وهمية في الاختبار
(`ghp_` + حروف وهمية)، أو — إن كانت قيمة مراجعة وآمنة فعلًا — أضفها إلى
`scripts/session/secret-allowlist.txt` مع تعليق يوضّح سبب أمانها.

## التحقق بعد الدفع

```
✔ committed 1a2b3c4 — feat(obs-02): …
✔ origin/task/obs-02 == 1a2b3c4
```

إذا ظهر:
```
✖ push rejected — the commit exists locally but is NOT on GitHub.
```
فالـcommit محفوظ محليًا لكنه **ليس آمنًا بعد**. اقرأ
[معالجة التعارضات](06-conflict-handling.md) ثم أعد المحاولة بـ`--push-only`.
لا تستخدم `--force` أبدًا.

## إيقاع مقترح

| اللحظة | الإجراء |
| --- | --- |
| نهاية كل وحدة قابلة للاختبار | checkpoint |
| قبل تشغيل اختبار طويل/ترحيل | checkpoint |
| قبل أي عملية خطرة (migration, rebase) | checkpoint + backup |
| كل ~30–60 دقيقة عمل | checkpoint حتى لو كان العمل جزئيًا |
