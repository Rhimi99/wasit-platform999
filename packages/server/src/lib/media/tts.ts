import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env.js';
import { ffmpegBin, ffprobeBin } from './binaries.js';
import { loadVoicePack, lookupVoiceClip, missingVoiceLines } from './voice-pack.js';
import { readWavInfo } from './wav.js';

const run = promisify(execFile);

/** Runs a binary, feeding `input` on stdin (piper reads the text from there). */
function runWithInput(bin: string, args: string[], input: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`TTS timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`piper exited ${code}: ${stderr.slice(-400)}`));
    });
    child.stdin.end(input);
  });
}

/**
 * Languages a marketing video can be produced in.
 *
 * `ar` is Modern Standard Arabic and `ar-TN` is Tunisian Arabic. They are two
 * separate products, not a translation pair: the copy, the voice and the
 * quality gate differ, and a Tunisian video may never ship with an MSA voice.
 */
export type VideoLanguage = 'ar' | 'ar-TN' | 'fr' | 'en' | 'zh';

export const VIDEO_LANGUAGES: readonly VideoLanguage[] = ['ar', 'ar-TN', 'fr', 'en', 'zh'];

export function isVideoLanguage(value: unknown): value is VideoLanguage {
  return typeof value === 'string' && (VIDEO_LANGUAGES as readonly string[]).includes(value);
}

export interface VoiceDefinition {
  id: string;
  /** Piper voice file stem inside `TTS_VOICES_DIR` (no extension). */
  model: string;
  language: VideoLanguage;
  /** BCP-47 locale the voice was trained on — the basis of the language check. */
  locale: string;
  label: string;
  engine: 'piper' | 'voicepack';
  license: string;
  /** False for anything that may not be used in a commercial advert. */
  commercialUse: boolean;
  /** True only when the voice was trained on the dialect itself. */
  dialectNative: boolean;
}

/**
 * The voices this deployment can actually speak with.
 *
 * Every entry is a Piper (MIT) model that runs offline, so no product data ever
 * leaves the platform. A language with no entry is not "unsupported copy" — it
 * is a hard gate failure, and the caller must report it as such.
 */
export const VOICE_CATALOGUE: readonly VoiceDefinition[] = [
  {
    id: 'piper-ar-jo-kareem',
    model: 'ar_JO-kareem-medium',
    language: 'ar',
    locale: 'ar-JO',
    label: 'Arabic (MSA) — Kareem',
    engine: 'piper',
    license: 'MIT (Piper voice)',
    commercialUse: true,
    dialectNative: false,
  },
  {
    id: 'piper-fr-fr-upmc',
    model: 'fr_FR-upmc-medium',
    language: 'fr',
    locale: 'fr-FR',
    label: 'Français — UPMC',
    engine: 'piper',
    license: 'MIT (Piper voice)',
    commercialUse: true,
    dialectNative: false,
  },
  {
    id: 'piper-en-us-lessac',
    model: 'en_US-lessac-medium',
    language: 'en',
    locale: 'en-US',
    label: 'English (US) — Lessac',
    engine: 'piper',
    license: 'MIT (Piper voice)',
    commercialUse: true,
    dialectNative: false,
  },
  {
    id: 'piper-zh-cn-huayan',
    model: 'zh_CN-huayan-medium',
    language: 'zh',
    locale: 'zh-CN',
    label: '简体中文 — Huayan',
    engine: 'piper',
    license: 'MIT (Piper voice)',
    commercialUse: true,
    dialectNative: false,
  },
];

/**
 * Why a language has no voice.
 *
 * Tunisian Arabic is the one real gap: the public Tunisian TTS models are
 * either CC-BY-NC (non-commercial) or carry no licence at all, so neither can
 * be used in a commercial advert. Recording an MSA voice and calling it
 * Tunisian would be a false claim, which the gate rejects.
 */
const VOICE_GAPS: Partial<Record<VideoLanguage, string>> = {
  'ar-TN':
    'No commercially licensed Tunisian Arabic voice is available: the public Tunisian TTS models are CC-BY-NC-4.0 or unlicensed (see docs/VOICE-TUNISIAN.md). '
    + 'Producing an MSA voiceover and labelling it Tunisian would be a false claim, so the video is withheld. '
    + 'Record a licensed pack into VOICE_PACK_DIR, or produce the advert in ar, fr, en or zh — the pipeline never substitutes a voice silently.',
};

function piperPath(): string | null {
  const candidates = [
    env.TTS_PIPER_PATH,
    path.resolve(process.cwd(), 'vendor/piper/piper'),
    path.resolve(process.cwd(), 'packages/server/vendor/piper/piper'),
    path.resolve(process.cwd(), '../../vendor/piper/piper'),
    '/workspace/tts/piper/piper',
    '/opt/piper/piper',
  ].filter((c): c is string => Boolean(c));
  // A directory named `piper` (an unflattened archive) is not the binary.
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function voicesDir(): string {
  if (env.TTS_VOICES_DIR && existsSync(env.TTS_VOICES_DIR)) return env.TTS_VOICES_DIR;
  const candidates = [
    path.resolve(process.cwd(), 'vendor/piper/voices'),
    path.resolve(process.cwd(), 'packages/server/vendor/piper/voices'),
    path.resolve(process.cwd(), '../../vendor/piper/voices'),
    '/workspace/tts/voices',
  ];
  return candidates.find((c) => existsSync(c)) ?? '';
}

export interface VoiceResolution {
  voice: VoiceDefinition | null;
  /** Populated when no voice can speak this language. */
  reason: string | null;
  engineAvailable: boolean;
}

export function resolveVoice(language: VideoLanguage): VoiceResolution {
  const engineAvailable = env.TTS_ENGINE === 'piper' && piperPath() !== null;
  if (env.TTS_ENGINE === 'none') {
    return { voice: null, reason: 'Voiceover is disabled (TTS_ENGINE=none).', engineAvailable: false };
  }

  // A licensed human pack wins over any synthetic voice: it is the only lawful
  // way to speak a dialect no TTS model covers commercially.
  const pack = loadVoicePack(language);
  if (pack.ok) {
    return {
      voice: {
        id: `pack-${language}-${pack.pack.manifest.speaker.replace(/\s+/g, '-').toLowerCase()}`,
        model: '.',
        language,
        locale: pack.pack.manifest.dialectNative ? language : 'und',
        label: `Recorded pack — ${pack.pack.manifest.speaker}`,
        engine: 'voicepack',
        license: pack.pack.manifest.license.terms,
        commercialUse: pack.pack.manifest.license.commercialUse === true,
        dialectNative: pack.pack.manifest.dialectNative === true,
      },
      reason: null,
      engineAvailable: true,
    };
  }

  const voice = VOICE_CATALOGUE.find((v) => v.language === language && v.commercialUse) ?? null;
  if (!voice) {
    return { voice: null, reason: VOICE_GAPS[language] ?? `No voice is configured for ${language}.`, engineAvailable };
  }
  if (!engineAvailable) {
    return {
      voice: null,
      reason: 'The local TTS engine is not installed (set TTS_PIPER_PATH or run scripts/install-tts.sh).',
      engineAvailable: false,
    };
  }
  const dir = voicesDir();
  const modelPath = path.join(dir, `${voice.model}.onnx`);
  if (!dir || !existsSync(modelPath)) {
    return {
      voice: null,
      reason: `The voice model for ${voice.locale} is missing (expected ${voice.model}.onnx in the voices directory).`,
      engineAvailable,
    };
  }
  return { voice, reason: null, engineAvailable };
}

export interface SynthesizedClip {
  /** Absolute path to the WAV file. Caller owns the directory. */
  file: string;
  durationSeconds: number;
  bytes: number;
  voice: VoiceDefinition;
}

export interface SynthesizeOptions {
  text: string;
  language: VideoLanguage;
  outFile: string;
  /** Piper's naturalness knob; 0.667 is the upstream default. */
  noiseScale?: number;
  lengthScale?: number;
}

/**
 * Speaks `text` with the resolved voice and writes a 22.05 kHz mono WAV.
 *
 * Long lines are split on sentence boundaries first: piper degrades on very
 * long inputs and a single 400-character line produces an unnatural read.
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<SynthesizedClip> {
  const { voice, reason } = resolveVoice(options.language);
  if (!voice) throw new Error(reason ?? `No voice for ${options.language}`);

  if (voice.engine === 'voicepack') {
    const pack = loadVoicePack(options.language);
    if (!pack.ok) throw new Error(pack.reason);
    const clip = lookupVoiceClip(pack.pack, options.text);
    if (!clip) {
      const missing = missingVoiceLines(pack.pack, [options.text]);
      throw new Error(
        `The ${options.language} voice pack has no recording for this line: "${missing[0]}". ` +
          'Run `npm run voices:brief -w @wasit/server` to regenerate the recording script.',
      );
    }
    // Match piper's output shape (22.05 kHz mono) so the mixer sees one format.
    await run(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-i', clip.path,
      '-ac', '1', '-ar', '22050', '-y', options.outFile], { timeout: 120_000 });
    const durationSeconds = await probeAudioDuration(options.outFile);
    const bytes = (await readFile(options.outFile)).byteLength;
    return { file: options.outFile, durationSeconds, bytes, voice };
  }

  const bin = piperPath();
  if (!bin) throw new Error('piper binary not found');
  const modelPath = path.join(voicesDir(), `${voice.model}.onnx`);

  const chunks = splitForSpeech(options.text, options.language);
  if (chunks.length === 0) throw new Error('Nothing to synthesize');

  const dir = path.dirname(options.outFile);
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const part = path.join(dir, `part-${i}-${path.basename(options.outFile)}`);
    await runWithInput(bin, [
      '-m', modelPath,
      '-f', part,
      '--length-scale', String(options.lengthScale ?? 1),
      '--noise-scale', String(options.noiseScale ?? 0.667),
    ], chunks[i]);
    parts.push(part);
  }

  if (parts.length === 1) {
    await rename(parts[0], options.outFile);
  } else {
    // Join the per-sentence clips with a short pause so the read breathes.
    const listFile = path.join(dir, `concat-${path.basename(options.outFile)}.txt`);
    await writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    await run(
      ffmpegBin(),
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-y', options.outFile],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }

  const durationSeconds = await probeAudioDuration(options.outFile);
  const bytes = (await readFile(options.outFile)).byteLength;
  for (const p of parts) await rm(p, { force: true }).catch(() => undefined);
  return { file: options.outFile, durationSeconds, bytes, voice };
}

/** Splits copy into sentence-sized chunks (Arabic/Chinese punctuation included). */
export function splitForSpeech(text: string, language: VideoLanguage): string[] {
  const maxChars = language === 'zh' ? 90 : 200;
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?؟。！？;؛])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if ((current + ' ' + sentence).length <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function probeAudioDuration(file: string): Promise<number> {
  // Voiceover output is PCM WAV, whose header carries an exact duration, so the
  // audio path does not depend on a system ffprobe. Anything else falls back to
  // the probe and reports what to install instead of a bare ENOENT.
  const wav = await readWavInfo(file).catch(() => null);
  if (wav && wav.durationSeconds > 0) return wav.durationSeconds;

  const probe = ffprobeBin();
  let stdout: string;
  try {
    ({ stdout } = await run(probe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read the duration of ${path.basename(file)}: not a PCM WAV, and ${probe} failed (${reason}). ` +
        'Install the media toolchain (ffmpeg provides ffprobe) or set TTS_FFPROBE_PATH.',
    );
  }
  const value = Number(String(stdout).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Unreadable audio duration for ${path.basename(file)}`);
  return value;
}

/** True when this deployment can speak at all (used by health/readiness output). */
export function ttsStatus(): {
  engine: string;
  binary: boolean;
  voicesDir: string;
  languages: Array<{ language: VideoLanguage; voice: string | null; reason: string | null }>;
} {
  return {
    engine: env.TTS_ENGINE,
    binary: piperPath() !== null,
    voicesDir: voicesDir() || '(not found)',
    languages: VIDEO_LANGUAGES.map((language) => {
      const resolved = resolveVoice(language);
      return { language, voice: resolved.voice?.id ?? null, reason: resolved.reason };
    }),
  };
}

/** Creates a scratch directory for one render; caller removes it. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wasit-tts-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
