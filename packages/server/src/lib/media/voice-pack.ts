import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { isVideoLanguage, type VideoLanguage } from './tts.js';

/**
 * A voice pack is a set of human recordings that stands in for a TTS engine.
 *
 * It exists because no Tunisian Arabic voice is licensed for commercial use:
 * the public Derja models are CC-BY-NC-4.0 or carry no licence at all. A
 * recorded pack is the only path that is both authentic and lawful, so the
 * loader refuses anything that does not carry an explicit commercial grant and
 * a signed release.
 */
export interface VoicePackLicense {
  /** Who owns the recording (speaker or studio). */
  holder: string;
  /** Where the grant can be read (contract URL, contract id, file in the deal room). */
  terms: string;
  /** Must be `true`; a pack that is only licensed for evaluation is refused. */
  commercialUse: boolean;
  territory?: string | null;
  /** ISO date after which the grant lapses; `null` means no expiry. */
  validUntil?: string | null;
}

export interface VoicePackClip {
  text: string;
  file: string;
}

export interface VoicePackManifest {
  language: VideoLanguage;
  speaker: string;
  /** True only when the speaker is a native speaker of the dialect itself. */
  dialectNative: boolean;
  recordedAt: string;
  sampleRate: number;
  license: VoicePackLicense;
  consent: { reference: string; signedAt?: string | null };
  clips: VoicePackClip[];
}

export interface VoicePackEntry extends VoicePackClip {
  /** Absolute path on disk. */
  path: string;
  /** Stable key used by the lookup: sha256 of the normalised line. */
  key: string;
}

export interface LoadedVoicePack {
  manifest: VoicePackManifest;
  dir: string;
  entries: Map<string, VoicePackEntry>;
}

export type VoicePackLoad =
  | { ok: true; pack: LoadedVoicePack }
  | { ok: false; reason: string };

/** Collapses whitespace and normalises Unicode so a re-typed line still matches. */
export function normaliseVoiceLine(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function voiceLineKey(text: string): string {
  return createHash('sha256').update(normaliseVoiceLine(text), 'utf8').digest('hex');
}

export function voicePackRoot(): string {
  // Read at call time so tests (and a re-exported deployment) can point the
  // loader at another root without re-parsing the whole env schema.
  const override = process.env.VOICE_PACK_DIR ?? env.VOICE_PACK_DIR;
  if (override) return override;
  const candidates = [
    path.resolve(process.cwd(), 'vendor/voices'),
    path.resolve(process.cwd(), 'packages/server/vendor/voices'),
    path.resolve(process.cwd(), '../../vendor/voices'),
  ];
  return candidates.find((c) => existsSync(c)) ?? path.resolve(process.cwd(), 'vendor/voices');
}

export function voicePackDir(language: VideoLanguage): string {
  return path.join(voicePackRoot(), language);
}

function fail(reason: string): VoicePackLoad {
  return { ok: false, reason };
}

/** Reads and validates `<root>/<language>/manifest.json`; never throws. */
export function loadVoicePack(language: VideoLanguage): VoicePackLoad {
  const dir = voicePackDir(language);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return fail(`No voice pack for ${language} (${manifestPath} is missing).`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return fail(`Voice pack manifest for ${language} is not valid JSON: ${(error as Error).message}`);
  }

  const manifest = raw as Partial<VoicePackManifest>;
  if (!isVideoLanguage(manifest.language)) return fail('Voice pack manifest has no valid language.');
  if (manifest.language !== language) {
    return fail(`Voice pack at ${dir} declares ${manifest.language}, not ${language}.`);
  }
  if (!manifest.speaker || typeof manifest.speaker !== 'string') return fail('Voice pack manifest has no speaker.');
  if (!manifest.license || typeof manifest.license !== 'object') return fail('Voice pack manifest has no licence block.');
  if (manifest.license.commercialUse !== true) {
    return fail('Voice pack is not licensed for commercial use (license.commercialUse must be true).');
  }
  if (!manifest.license.holder || !manifest.license.terms) {
    return fail('Voice pack licence must name the holder and point at the grant (holder, terms).');
  }
  if (!manifest.consent || !manifest.consent.reference) {
    return fail('Voice pack has no signed release (consent.reference is empty).');
  }
  if (manifest.license.validUntil) {
    const until = Date.parse(manifest.license.validUntil);
    if (Number.isFinite(until) && until < Date.now()) {
      return fail(`Voice pack licence expired on ${manifest.license.validUntil}.`);
    }
  }
  // A Tunisian advert needs a Tunisian speaker; an MSA recording wearing the
  // ar-TN label is exactly the false claim the gate exists to stop.
  if (language === 'ar-TN' && manifest.dialectNative !== true) {
    return fail('Voice pack for ar-TN must be recorded by a native Tunisian speaker (dialectNative: true).');
  }
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0) return fail('Voice pack has no clips.');

  const entries = new Map<string, VoicePackEntry>();
  for (const clip of manifest.clips) {
    if (!clip || typeof clip.text !== 'string' || typeof clip.file !== 'string') {
      return fail('Voice pack clip entries need both text and file.');
    }
    const key = voiceLineKey(clip.text);
    if (entries.has(key)) return fail(`Voice pack has two recordings for the same line: "${clip.text}".`);
    const file = path.resolve(dir, clip.file);
    if (!existsSync(file) || !statSync(file).isFile()) {
      return fail(`Voice pack clip is missing on disk: ${clip.file}.`);
    }
    entries.set(key, { ...clip, path: file, key });
  }

  return { ok: true, pack: { manifest: manifest as VoicePackManifest, dir, entries } };
}

/** Returns the recording for `text`, or null when the line was never recorded. */
export function lookupVoiceClip(pack: LoadedVoicePack, text: string): VoicePackEntry | null {
  return pack.entries.get(voiceLineKey(text)) ?? null;
}

/** Lines from `lines` that the pack cannot speak — the operator's to-record list. */
export function missingVoiceLines(pack: LoadedVoicePack, lines: readonly string[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = voiceLineKey(line);
    if (pack.entries.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(normaliseVoiceLine(line));
  }
  return missing;
}

export interface VoicePackStatus {
  language: VideoLanguage;
  available: boolean;
  reason: string | null;
  speaker: string | null;
  clips: number;
  dialectNative: boolean;
}

export function voicePackStatus(language: VideoLanguage): VoicePackStatus {
  const loaded = loadVoicePack(language);
  if (!loaded.ok) {
    return { language, available: false, reason: loaded.reason, speaker: null, clips: 0, dialectNative: false };
  }
  return {
    language,
    available: true,
    reason: null,
    speaker: loaded.pack.manifest.speaker,
    clips: loaded.pack.entries.size,
    dialectNative: loaded.pack.manifest.dialectNative === true,
  };
}
