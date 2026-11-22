import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadVoicePack,
  lookupVoiceClip,
  missingVoiceLines,
  normaliseVoiceLine,
  voiceLineKey,
  voicePackStatus,
} from '../../src/lib/media/voice-pack.js';
import { resolveVoice } from '../../src/lib/media/tts.js';
import { packReadyLanguages } from '../../src/scripts/voice-recording-brief.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/voice-pack');
const MANIFEST = JSON.parse(readFileSync(path.join(FIXTURE, 'ar-TN/manifest.json'), 'utf8')) as {
  clips: Array<{ text: string; file: string }>;
};

let root: string;
let previousRoot: string | undefined;

/** Copies the fixture pack into a scratch root and lets a test mutate it. */
function scratchPack(mutate?: (manifest: Record<string, unknown>, dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wasit-pack-'));
  cpSync(path.join(FIXTURE, 'ar-TN'), path.join(dir, 'ar-TN'), { recursive: true });
  const manifestPath = path.join(dir, 'ar-TN/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  // The fixture is an MSA placeholder; scratch copies attest native speech so
  // each guard test can fail on the rule it targets rather than on this one.
  manifest.dialectNative = true;
  mutate?.(manifest, path.join(dir, 'ar-TN'));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

beforeAll(() => {
  previousRoot = process.env.VOICE_PACK_DIR;
  // The shipped fixture is a Piper MSA placeholder, so it is refused for ar-TN.
  // The active pack here is a scratch copy that carries the native attestation,
  // which lets the resolution tests exercise the licensed path.
  root = scratchPack((manifest) => {
    manifest.speaker = 'Test speaker';
  });
  process.env.VOICE_PACK_DIR = root;
});

afterAll(() => {
  if (previousRoot === undefined) delete process.env.VOICE_PACK_DIR;
  else process.env.VOICE_PACK_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('voice pack — matching', () => {
  it('normalises whitespace and Unicode before hashing', () => {
    expect(normaliseVoiceLine('  مرحبا   بك \n')).toBe('مرحبا بك');
    expect(voiceLineKey('مرحبا  بك')).toBe(voiceLineKey('مرحبا بك'));
  });

  it('finds a recorded line by its exact text', () => {
    const loaded = loadVoicePack('ar-TN');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const clip = lookupVoiceClip(loaded.pack, MANIFEST.clips[0].text);
    expect(clip?.file).toBe(MANIFEST.clips[0].file);
  });

  it('finds the line even when spacing differs', () => {
    const loaded = loadVoicePack('ar-TN');
    if (!loaded.ok) throw new Error(loaded.reason);
    const spaced = `  ${MANIFEST.clips[0].text.replace(' ', '   ')}  `;
    expect(lookupVoiceClip(loaded.pack, spaced)).not.toBeNull();
  });

  it('reports the lines a pack still has to record', () => {
    const loaded = loadVoicePack('ar-TN');
    if (!loaded.ok) throw new Error(loaded.reason);
    const missing = missingVoiceLines(loaded.pack, [MANIFEST.clips[0].text, 'سطر لم يُسجَّل بعد']);
    expect(missing).toEqual(['سطر لم يُسجَّل بعد']);
  });

  it('reports a complete pack for every generated Tunisian line', () => {
    const lines = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/voice-pack/ar-TN/manifest.json'), 'utf8')) as {
      clips: Array<{ text: string }>;
    };
    const loaded = loadVoicePack('ar-TN');
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(missingVoiceLines(loaded.pack, lines.clips.map((c) => c.text))).toEqual([]);
  });
});

describe('voice pack — licence guards', () => {
  it('refuses the shipped MSA placeholder as a Tunisian voice', () => {
    const previous = process.env.VOICE_PACK_DIR;
    process.env.VOICE_PACK_DIR = FIXTURE;
    try {
      const loaded = loadVoicePack('ar-TN');
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.reason).toMatch(/native Tunisian speaker/i);
    } finally {
      process.env.VOICE_PACK_DIR = previous;
    }
  });

  const cases: Array<[string, (m: Record<string, unknown>, dir: string) => void, RegExp]> = [
    [
      'refuses a pack that is not cleared for commercial use',
      (m) => {
        (m.license as Record<string, unknown>).commercialUse = false;
      },
      /not licensed for commercial use/i,
    ],
    [
      'refuses a pack with no signed release',
      (m) => {
        m.consent = { reference: '' };
      },
      /signed release/i,
    ],
    [
      'refuses a Tunisian pack recorded by a non-native speaker',
      (m) => {
        m.dialectNative = false;
      },
      /native Tunisian speaker/i,
    ],
    [
      'refuses an expired grant',
      (m) => {
        (m.license as Record<string, unknown>).validUntil = '2020-01-01';
      },
      /expired/i,
    ],
    [
      'refuses a clip that is not on disk',
      (m, dir) => {
        (m.clips as Array<{ file: string }>)[0].file = 'missing.wav';
        rmSync(path.join(dir, 'missing.wav'), { force: true });
      },
      /missing on disk/i,
    ],
    [
      'refuses two recordings of the same line',
      (m) => {
        const clips = m.clips as Array<{ text: string; file: string }>;
        clips[1].text = clips[0].text;
      },
      /two recordings for the same line/i,
    ],
    [
      'refuses a manifest that declares another language',
      (m) => {
        m.language = 'fr';
      },
      /declares fr/i,
    ],
  ];

  for (const [name, mutate, message] of cases) {
    it(name, () => {
      const dir = scratchPack(mutate);
      const previous = process.env.VOICE_PACK_DIR;
      process.env.VOICE_PACK_DIR = dir;
      try {
        const loaded = loadVoicePack('ar-TN');
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.reason).toMatch(message);
      } finally {
        process.env.VOICE_PACK_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('reports an absent pack instead of throwing', () => {
    const loaded = loadVoicePack('fr');
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/No voice pack for fr/);
  });
});

describe('voice pack — voice resolution', () => {
  it('offers a licensed pack as the voice for its language', () => {
    const resolved = resolveVoice('ar-TN');
    expect(resolved.voice?.engine).toBe('voicepack');
    expect(resolved.voice?.dialectNative).toBe(true);
    expect(resolved.reason).toBeNull();
  });

  it('reports the pack in the status summary', () => {
    const status = voicePackStatus('ar-TN');
    expect(status.available).toBe(true);
    expect(status.clips).toBe(MANIFEST.clips.length);
  });

  it('keeps piper for the other languages', () => {
    expect(resolveVoice('fr').voice?.engine).toBe('piper');
  });
});

describe('recording brief', () => {
  it('marks only Tunisian as pack-ready, because its copy carries no product data', () => {
    expect(packReadyLanguages()).toEqual(['ar-TN']);
  });
});
