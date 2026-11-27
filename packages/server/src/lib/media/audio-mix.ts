import { readFile, writeFile } from 'node:fs/promises';

/**
 * Minimal 16-bit PCM WAV reader/writer.
 *
 * Voice clips come out of Piper as 22.05 kHz mono PCM, and they have to land on
 * exact offsets in one continuous track. Doing that arithmetic here (rather
 * than in a hundred-input ffmpeg graph) keeps the placement exact and lets the
 * quality gate compare what was planned with what was actually mixed.
 */

export interface PcmClip {
  sampleRate: number;
  channels: number;
  /** Interleaved samples normalised to [-1, 1]. */
  samples: Float32Array;
}

function findChunk(buffer: Buffer, id: string): { start: number; size: number } | null {
  let offset = 12; // skip RIFF/size/WAVE
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunkId === id) return { start: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

export function parseWav(buffer: Buffer): PcmClip {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  const fmt = findChunk(buffer, 'fmt ');
  const data = findChunk(buffer, 'data');
  if (!fmt || !data) throw new Error('WAV is missing fmt/data chunks');

  const audioFormat = buffer.readUInt16LE(fmt.start);
  const channels = buffer.readUInt16LE(fmt.start + 2);
  const sampleRate = buffer.readUInt32LE(fmt.start + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.start + 14);
  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format (format=${audioFormat}, bits=${bitsPerSample})`);
  }

  const frames = Math.floor(data.size / (2 * channels));
  const samples = new Float32Array(frames * channels);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(data.start + i * 2) / 32_768;
  }
  return { sampleRate, channels, samples };
}

export function encodeWavStereo(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sampleAt(clip: PcmClip, frame: number): number {
  const total = clip.samples.length / clip.channels;
  if (frame < 0 || frame >= total) return 0;
  let sum = 0;
  for (let c = 0; c < clip.channels; c += 1) sum += clip.samples[frame * clip.channels + c];
  return sum / clip.channels;
}

export interface VoicePlacement {
  file: string;
  startSeconds: number;
}

/**
 * Lays every voice clip on one 44.1 kHz stereo track at its planned offset.
 *
 * Overlaps are summed rather than dropped; the planner keeps scenes apart, so
 * a sum here means a bug that the gate will hear as clipped audio.
 */
export async function mixVoiceoverTrack(
  placements: readonly VoicePlacement[],
  totalSeconds: number,
  outFile: string,
  sampleRate = 44_100,
): Promise<{ file: string; durationSeconds: number; clips: number; peak: number }> {
  const frames = Math.ceil(totalSeconds * sampleRate) + 1;
  const out = new Float32Array(frames * 2);

  for (const placement of placements) {
    const clip = parseWav(await readFile(placement.file));
    const ratio = clip.sampleRate / sampleRate;
    const clipFrames = Math.floor(clip.samples.length / clip.channels);
    const startFrame = Math.round(placement.startSeconds * sampleRate);
    const outFrames = Math.floor(clipFrames / ratio);

    for (let i = 0; i < outFrames; i += 1) {
      const sourceFrame = i * ratio;
      const whole = Math.floor(sourceFrame);
      const frac = sourceFrame - whole;
      const value = sampleAt(clip, whole) * (1 - frac) + sampleAt(clip, whole + 1) * frac;
      const target = startFrame + i;
      if (target * 2 + 1 >= out.length) break;
      out[target * 2] += value;
      out[target * 2 + 1] += value;
    }
  }

  let peak = 0;
  for (let i = 0; i < out.length; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  // Headroom: the final loudnorm pass brings the programme to broadcast level,
  // but a clipped mix cannot be repaired after the fact.
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (let i = 0; i < out.length; i += 1) out[i] *= scale;
    peak = 0.95;
  }

  await writeFile(outFile, encodeWavStereo(out, sampleRate));
  return { file: outFile, durationSeconds: frames / sampleRate, clips: placements.length, peak };
}
