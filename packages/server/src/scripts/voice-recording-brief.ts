import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MARKETING_OBJECTIVES, buildVideoScript, type MarketingObjective, type ProductFacts } from '../lib/media/video-script.js';
import { VIDEO_LANGUAGES, isVideoLanguage, type VideoLanguage } from '../lib/media/tts.js';
import { normaliseVoiceLine, voiceLineKey, voicePackDir } from '../lib/media/voice-pack.js';

/**
 * Writes the recording script for a human voice pack.
 *
 * A pack can only speak lines that were recorded, so the brief must list every
 * line the generator can produce — one per objective × audience × scene. It is
 * the contract handed to the studio: record these, name them like this, sign
 * the release, drop the manifest in `vendor/voices/<language>/`.
 */

const FIXTURE: ProductFacts = {
  name: 'منتج تجريبي',
  brand: 'علامة تجريبية',
  description: 'وصف تجريبي قصير للمنتج يوضّح ماذا يقدّم ولمن.',
  price: '12.500',
  currencyCode: 'TND',
  sellerName: 'بائع تجريبي',
};

interface BriefLine {
  id: string;
  objective: MarketingObjective;
  audience: 'B2B' | 'B2C';
  scene: string;
  text: string;
  words: number;
  chars: number;
  key: string;
  file: string;
}

function linesForLanguage(language: VideoLanguage): BriefLine[] {
  const byKey = new Map<string, BriefLine>();
  for (const objective of MARKETING_OBJECTIVES) {
    for (const audience of ['B2C', 'B2B'] as const) {
      const script = buildVideoScript({ language, objective, audience, facts: FIXTURE });
      for (const scene of script.scenes) {
        const text = normaliseVoiceLine(scene.voiceover);
        if (!text) continue;
        const key = voiceLineKey(text);
        if (byKey.has(key)) continue;
        byKey.set(key, {
          id: `${objective}-${audience}-${scene.kind}`,
          objective,
          audience,
          scene: scene.kind,
          text,
          words: text.split(/\s+/).length,
          chars: text.length,
          key,
          file: `${String(byKey.size + 1).padStart(3, '0')}-${key.slice(0, 8)}.wav`,
        });
      }
    }
  }
  return [...byKey.values()];
}

/** Languages whose copy is fixed enough for a recorded pack to cover it. */
export function packReadyLanguages(): VideoLanguage[] {
  return VIDEO_LANGUAGES.filter((language) => {
    const lines = linesForLanguage(language);
    // A dynamic line is one whose text changes with the product row; the
    // fixture name appears in it only when the copy interpolates the product.
    return !lines.some((line) => line.text.includes(FIXTURE.name));
  });
}

function renderBrief(language: VideoLanguage, lines: BriefLine[]): string {
  const words = lines.reduce((sum, line) => sum + line.words, 0);
  const minutes = words / 140;
  const rows = lines
    .map((line) => `| \`${line.file}\` | ${line.scene} | ${line.objective} / ${line.audience} | ${line.words} | ${line.text} |`)
    .join('\n');

  return `# نص التسجيل — حزمة صوت ${language}

**عدد الأسطر:** ${lines.length} · **عدد الكلمات:** ${words} · **زمن التسجيل التقديري:** ${minutes.toFixed(1)} دقيقة كلام صافٍ

## ما يُطلب من الاستوديو

1. متحدث أصلي باللهجة المطلوبة (لا فصحى مقروءة بلكنة).
2. تسجيل كل سطر أدناه مرة واحدة، بصوت طبيعي كما في إعلان، بلا موسيقى ولا ضجيج.
3. صيغة WAV/PCM، 48 kHz، أحادي أو ستيريو، بلا ضغط وبلا تطبيع ساكن (سنتولى نحن التطبيع).
4. صمت ثانيتين قبل وبعد كل سطر، ونطق السطر كما هو مكتوب تمامًا (النص هو مفتاح المطابقة).
5. اسم الملف كما في العمود الأول.

## ما يُطلب قانونيًا قبل الاستخدام

- عقد يمنح WASIT **استخدامًا تجاريًا عالميًا** للتسجيلات، مع حق إعادة الإنتاج داخل فيديوهات المنصة.
- إقرار موقّع من المتحدث (release) يحدد النطاق والمدة والمقابل.
- \`license.commercialUse\` في \`manifest.json\` يجب أن يكون \`true\`، و\`consent.reference\` معرّف العقد الموقّع.
- للهجة التونسية: \`dialectNative: true\`، وهو إقرار أن المتحدث تونسي أصلي.

## الملفات

- \`manifest.json\` في \`vendor/voices/${language}/\` (انظر القالب أدناه).
- ملفات WAV في المجلد نفسه.

\`\`\`json
{
  "language": "${language}",
  "speaker": "اسم المتحدث",
  "dialectNative": true,
  "recordedAt": "2026-12-01",
  "sampleRate": 48000,
  "license": { "holder": "WASIT", "terms": "contract-2026-XX", "commercialUse": true, "territory": "worldwide", "validUntil": null },
  "consent": { "reference": "release-2026-XX", "signedAt": "2026-12-01" },
  "clips": [ { "text": "…", "file": "001-xxxxxxxx.wav" } ]
}
\`\`\`

## الأسطر

| الملف | المشهد | الاستخدام | كلمات | النص |
| --- | --- | --- | --- | --- |
${rows}
`;
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--language='));
  const requested = arg?.split('=')[1];
  if (requested && !isVideoLanguage(requested)) throw new Error(`Unknown language: ${requested}`);
  const languages: VideoLanguage[] = requested && isVideoLanguage(requested) ? [requested] : packReadyLanguages();

  const outRoot = path.resolve(process.cwd(), 'artifacts/voice-packs');
  for (const language of languages) {
    const lines = linesForLanguage(language);
    const dir = path.join(outRoot, language);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'lines.json'), `${JSON.stringify({ language, lines }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, 'brief.md'), renderBrief(language, lines), 'utf8');
    const words = lines.reduce((sum, line) => sum + line.words, 0);
    console.log(
      `${language.padEnd(6)} ${String(lines.length).padStart(3)} lines · ${String(words).padStart(4)} words · ` +
        `${(words / 140).toFixed(1)} min · target ${voicePackDir(language)}`,
    );
  }
  console.log(`brief: ${outRoot}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
