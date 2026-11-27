/**
 * Music bed for marketing videos, synthesised in-process.
 *
 * The bed is built from oscillators only — no samples, no third-party tracks —
 * so the platform owns it outright and the video carries no music licence
 * obligation. It is a slow four-chord pad with a soft pulse and a swell at
 * scene boundaries: enough that an advert never sounds like a silent slide
 * show, quiet enough not to fight the voiceover.
 */

export interface MusicBedOptions {
  durationSeconds: number;
  sampleRate?: number;
  /** Scene boundaries in seconds, where the bed lifts slightly. */
  sceneBoundaries?: readonly number[];
  /** Root of the progression in Hz (220 = A3). */
  rootHz?: number;
}

const DEFAULT_SAMPLE_RATE = 44_100;

/** i – VI – III – VII in A minor, as semitone offsets from the root. */
const PROGRESSION: ReadonlyArray<readonly [number, number, number]> = [
  [0, 3, 7],
  [-4, 0, 3],
  [-9, -5, -2],
  [-2, 2, 5],
];

function frequency(rootHz: number, semitones: number): number {
  return rootHz * 2 ** (semitones / 12);
}

/** Soft attack and release inside each bar, so the pad never clicks. */
function barEnvelope(positionInBar: number): number {
  const attack = Math.min(1, positionInBar / 0.18);
  const release = Math.min(1, (1 - positionInBar) / 0.22);
  return Math.sin(attack * (Math.PI / 2)) * release;
}

/** Renders the bed as 16-bit stereo PCM WAV. */
export function renderMusicBed(options: MusicBedOptions): Buffer {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const duration = Math.max(1, options.durationSeconds);
  const root = options.rootHz ?? 220;
  const frames = Math.ceil(duration * sampleRate);
  const barSeconds = 60 / 66; // 66 BPM: slow and editorial
  const boundaries = options.sceneBoundaries ?? [];
  const data = Buffer.alloc(frames * 4);

  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const bar = Math.floor(t / barSeconds);
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const envelope = 0.45 + 0.55 * barEnvelope((t % barSeconds) / barSeconds);

    let sample = 0;
    for (let index = 0; index < chord.length; index += 1) {
      const freq = frequency(root, chord[index]);
      sample += Math.sin(2 * Math.PI * freq * t + index * 0.7) * (0.5 - index * 0.08);
      // A quiet octave partial keeps the pad from sounding like a test tone.
      sample += Math.sin(2 * Math.PI * freq * 2 * t) * 0.06;
    }

    const nearBoundary = boundaries.some((b) => t > b - 0.5 && t < b);
    const swell = nearBoundary ? 1.12 : 1;
    const fadeIn = Math.min(1, t / 1.2);
    const fadeOut = Math.min(1, (duration - t) / 1.6);
    const gain = 0.11 * envelope * swell * fadeIn * fadeOut;

    const value = Math.max(-1, Math.min(1, sample * gain));
    const pcm = Math.round(value * 32_767);
    data.writeInt16LE(pcm, i * 4);
    data.writeInt16LE(pcm, i * 4 + 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** Provenance recorded in every render, so the music licence is auditable. */
export const MUSIC_PROVENANCE = {
  provider: 'wasit-generated',
  license: 'Owned by WASIT — synthesised in-process, no samples',
  commercialUse: true,
} as const;
