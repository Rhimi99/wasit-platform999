import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitForSpeech, synthesizeSpeech, ttsStatus } from '../src/lib/media/tts.js';
import { measureWavLevel, readWavInfo } from '../src/lib/media/wav.js';

/**
 * Proves the voiceover path produces real speech, not a placeholder.
 *
 * Every assertion runs against audio synthesized by piper in this process: the
 * WAV must be 22.05 kHz mono PCM, long enough for the sentence, non-silent, and
 * its header duration must agree with what the engine reported. A stub that
 * wrote a fixed file would fail the duration and level checks.
 *
 * The engine is a deployment prerequisite (see `scripts/install-tts.sh`), so
 * the suite skips — with the reason spelled out — when it is absent. It never
 * skips when piper is installed: a broken engine must fail here.
 */

const SAMPLES: Record<'ar' | 'fr' | 'en' | 'zh', string> = {
  ar: 'مرحبا بكم في منصة وسيط للأعمال.',
  fr: 'Bienvenue sur la plateforme WASIT.',
  en: 'Welcome to the WASIT trading platform.',
  zh: '欢迎来到 WASIT 贸易平台。',
};

const status = ttsStatus();
type SupportedLanguage = 'ar' | 'fr' | 'en' | 'zh';
const ALL_LANGUAGES: readonly SupportedLanguage[] = ['ar', 'fr', 'en', 'zh'];
const languages = ALL_LANGUAGES.filter((language) =>
  Boolean(status.languages.find((candidate) => candidate.language === language)?.voice),
);
const skipReason = !status.binary
  ? 'piper is not installed — run `npm run voices:setup`'
  : languages.length < 4
    ? `piper voice model missing for ${ALL_LANGUAGES.filter((l) => !languages.includes(l)).join(', ')}`
    : '';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wasit-voice-int-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(skipReason !== '')(
  `voiceover integration — real piper audio${skipReason ? ` (skipped: ${skipReason})` : ''}`,
  () => {
    it('reports an installed engine for every non-Tunisian language', () => {
      expect(status.binary).toBe(true);
      expect(languages).toEqual(['ar', 'fr', 'en', 'zh']);
    });

    for (const language of ALL_LANGUAGES) {
      it(`synthesizes valid, audible ${language} speech`, async () => {
        const outFile = path.join(dir, `${language}.wav`);
        const clip = await synthesizeSpeech({ text: SAMPLES[language], language, outFile });

        expect(clip.voice.engine).toBe('piper');
        expect(clip.voice.language).toBe(language);
        expect(clip.voice.commercialUse).toBe(true);
        expect(clip.durationSeconds).toBeGreaterThan(0.5);
        expect(clip.bytes).toBe(statSync(outFile).size);

        const info = await readWavInfo(outFile);
        expect(info, 'output must be a PCM WAV').not.toBeNull();
        if (!info) return;
        expect(info.sampleRate).toBe(22050);
        expect(info.channels).toBe(1);
        expect(info.bitsPerSample).toBe(16);
        expect(info.audioFormat).toBe(1);
        // The reported duration comes from the same header the file carries.
        expect(Math.abs(info.durationSeconds - clip.durationSeconds)).toBeLessThan(0.05);

        const level = await measureWavLevel(outFile);
        expect(level, 'level meter must read 16-bit PCM').not.toBeNull();
        if (!level) return;
        expect(level.peak).toBeGreaterThan(0.05);
        expect(level.rms).toBeGreaterThan(0.005);
      });
    }

    it('joins multi-sentence copy through the resolved ffmpeg', async () => {
      const text =
        'WASIT connects suppliers and buyers across borders. ' +
        'Every order is priced from the commission policy stored in the database, so the fee is auditable. ' +
        'Payment and settlement are recorded separately, which keeps the ledger honest. ' +
        'The voiceover engine reads each sentence and joins the clips into one track.';
      const chunks = splitForSpeech(text, 'en');
      expect(chunks.length).toBeGreaterThan(1);

      const outFile = path.join(dir, 'multi-en.wav');
      const clip = await synthesizeSpeech({ text, language: 'en', outFile });
      const single = await synthesizeSpeech({
        text: 'WASIT connects suppliers and buyers.',
        language: 'en',
        outFile: path.join(dir, 'single-en.wav'),
      });
      expect(clip.durationSeconds).toBeGreaterThan(single.durationSeconds);

      const info = await readWavInfo(outFile);
      expect(info?.sampleRate).toBe(22050);
      const level = await measureWavLevel(outFile);
      expect(level?.peak).toBeGreaterThan(0.05);
    });

    it('produces different audio for different sentences', async () => {
      const first = await synthesizeSpeech({
        text: SAMPLES.fr,
        language: 'fr',
        outFile: path.join(dir, 'distinct-a.wav'),
      });
      const second = await synthesizeSpeech({
        text: 'Le prix est confirmé par le vendeur.',
        language: 'fr',
        outFile: path.join(dir, 'distinct-b.wav'),
      });
      expect(first.bytes).toBeGreaterThan(0);
      expect(second.bytes).toBeGreaterThan(0);
      expect(Math.abs(first.durationSeconds - second.durationSeconds)).toBeGreaterThan(0.05);
    });
  },
);
