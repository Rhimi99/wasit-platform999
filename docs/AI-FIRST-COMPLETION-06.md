# AI-FIRST COMPLETION 06 — فيديو تسويقي تجاري حقيقي (تعليق صوتي + موسيقى + بوابة جودة)

**التاريخ:** 2026-11-20 · **الفرع:** `ai-first-completion`
**السابق:** `AI-FIRST-COMPLETION-05` (واجهات تشغيل الفيديو وشركاء B2B + احتفاظ مصنَّف)

---

## 1. النطاق

الهدف: تحويل `marketing-video-agent` من مونتاج شرائح صامت إلى **إعلان تجاري قابل للاستخدام**:
سيناريو مكتوب، تعليق صوتي بلغات المنصة، موسيقى خلفية، ترجمة نصية محروقة، وبوابة جودة تمنع
تسليم أي ملف ناقص. لا خدمات خارجية ولا مدفوعة.

| ما كان | ما صار |
| --- | --- |
| 5 شرائح نصية ثابتة، بلا صوت | 5 مشاهد (hook / value / detail / trust / cta) بتوقيت محسوب من طول الصوت الفعلي |
| بلا تعليق صوتي | Piper TTS محلي (`vendor/piper`) بأصوات ar / fr / en / zh + مسار `ar-TN` يُرفض بوضوح |
| بلا موسيقى | موسيقى مولَّدة إجرائيًا (ffmpeg) بمزاج حسب النمط، مع ducking تحت الصوت |
| بلا ترجمة | ASS subtitles محروقة (libass) بعرض سطر حسب اللغة + دعم RTL وCJK |
| تسليم الملف كما هو | **بوابة 18 فحصًا** قبل التخزين: لا ملف يُسلَّم إن فشل أي فحص إلزامي |
| بلا نص قابل للمراجعة | `video-script.ts` يبني السيناريو من بيانات المنتج الحقيقية فقط |

---

## 2. الطبقات الجديدة

| ملف | الدور |
| --- | --- |
| `src/lib/media/video-script.ts` | مخطط السيناريو: مشاهد، عناوين، bullets، نص التعليق، CTA، لهجة (MSA/Tunisian)، قائمة الحقائق المستخدمة |
| `src/lib/media/tts.ts` (موسَّع) | Piper: `resolveVoice(language)`، `ttsStatus()`، تحقق أن المسار ملف تنفيذي (ليس مجلد أرشيف) |
| `src/lib/media/music.ts` | مولّد موسيقى إجرائي (نغمات + إيقاع) عبر ffmpeg، بلا ملفات صوتية محفوظة الحقوق |
| `src/lib/media/audio-mix.ts` | خلط الصوت: loudnorm، ducking للموسيقى، تحويل إلى AAC stereo 44.1kHz |
| `src/lib/media/marketing-video.ts` | `produceMarketingVideo()` + `planTimeline()` + `buildMarketingAss()` + `fitTitle()` |
| `src/lib/media/video-quality.ts` | `evaluateMarketingVideo()` — 18 فحصًا + ملخّص قرار |
| `src/scripts/verify-marketing-videos.ts` | إنتاج إعلان لكل لغة + تقرير `report.json` / `report.md` |
| `scripts/install-tts.sh` | تثبيت Piper قابل للتكرار (يفكّ الأرشيف في مكانه الصحيح) |

---

## 3. البوابة (لماذا لا يُسلَّم كل ملف)

| فحص | لماذا إلزامي |
| --- | --- |
| `audio.voiceover` | إعلان بلا تعليق صوتي = شريحة صامتة، لا إعلان |
| `audio.loudness` | -16…-13 LUFS، وإلا رُفض من منصات الإعلان |
| `audio.truepeak` | ≤ -1 dBTP لتفادي التشويه بعد الترميز |
| `video.codec/duration/dimensions/fps` | h264 + yuv420p + 720×1280 + 25fps |
| `video.audioTrack` | AAC stereo 44.1kHz |
| `subtitle.cues` | ترجمة محروقة مطابقة للسيناريو |
| `copy.facts` | كل رقم في النص موجود في بيانات المنتج |
| `copy.language` | النص بلغة الطلب فعلًا (كشف الحروف) |
| `render.artifacts` | لا إطارات سوداء/صامتة مقصودة |

`ar-TN`: لا صوت تونسي مرخَّص تجاريًا (النماذج العامة CC-BY-NC أو بلا ترخيص) ⇒ الوكيل **يرفض**
بحقل `reason` صريح بدل تسمية صوت فصحى "تونسيًا". البوابة تُرجع `audio.voiceover` فاشلًا
والملف لا يُخزَّن.

---

## 4. الواجهة (`/dashboard/agent-video`)

- لغة (5 خيارات) + هدف (SALES/AWARENESS/LAUNCH/RETENTION) + جمهور + نمط + مدة (35–120).
- حالة الصوت لكل لغة من `GET /api/ai/voice-capabilities`: زر البدء معطّل للغة بلا صوت، والسبب معروض.
- المراحل: `precheck_renderer → precheck_voice → produce → quality_gate → read → store`.
- بطاقة بوابة الجودة: القرار، LUFS، المشاهد بصوت، عدد الترجمة، وكل فحص بسببه.
- **المعاينة والتنزيل يظهران فقط عند `qualityGate.passed === true`**؛ وإلا رسالة "لم يُخزَّن أي ملف".

---

## 5. الأدلة (تشغيل حقيقي)

```
ar     DELIVERED 37.3s  voice=piper-ar-jo-kareem   gate=pass
ar-TN  WITHHELD  35.0s  voice=none                 gate=audio.voiceover
fr     DELIVERED 35.0s  voice=piper-fr-fr-upmc     gate=pass
en     DELIVERED 35.0s  voice=piper-en-us-lessac   gate=pass
zh     DELIVERED 35.0s  voice=piper-zh-cn-huayan   gate=pass
```

- المنتج في التقرير من قاعدة البيانات (`products` نشط)، لا بيانات وهمية.
- القياس: 720×1280، h264 + aac stereo 44.1kHz، ≈ -15.5 LUFS، 4.9–6.7 MB لكل لغة.
- التقرير الكامل: `packages/server/artifacts/marketing-videos/report.md` (مخرج بناء، غير متعقَّب).

أوامر:

```bash
npm run install:tts -w @wasit/server     # Piper + أصوات ar/en/fr/zh
npm run verify:videos -w @wasit/server   # 5 إعلانات + تقرير
```

---

## 6. الاختبارات

| ملف | الحالات |
| --- | --- |
| `tests/unit/marketing-video-script.test.ts` | 13 — سيناريو، أرقام من البيانات فقط، لا ادعاءات مخترعة، لهجة تونسية مقابل فصحى، التوقيت 35–120، التفاف الترجمة، تصغير العنوان |
| `tests/ai-video-agent.test.ts` | 6 — تخطيط من منتج حقيقي، رندر فعلي، تقييد المدة، صلاحية الأدمن، حجب المنتج غير المملوك |
| `tests/agent-video-download.test.ts` | 6 — تنزيل المالك، Range، موظف الدعم، تدقيق، ملكية |

`tsc --noEmit` = 0 أخطاء (server + web).

---

## 7. ما لم يُنفَّذ (مقصود)

- **ar-TN**: يحتاج صوتًا مرخَّصًا تجاريًا أو عقد تسجيل بشري — مسجَّل كقرار مطلوب، لا يُلفّق.
- **ترجمة بلغات إضافية**: الصوت متاح ar/fr/en/zh فقط؛ لا إعلان بلغة بلا صوت.
- **نشر تلقائي**: الوكيل لا ينشر على منصات إعلانية؛ يُنتج ملفًا فقط (`publishes: false`).
