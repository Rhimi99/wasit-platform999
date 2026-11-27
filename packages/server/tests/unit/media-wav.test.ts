import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureWavLevel, readWavInfo } from '../../src/lib/media/wav.js';

/**
 * The WAV reader is what lets the voiceover path report an exact duration
 * without a system ffprobe. These are generated headers, not voice samples:
 * they pin the parser, and the audible-audio claim lives in
 * `tests/voice-piper-integration.test.ts`.
 */
function wavFile(sampleRate: number, channels: number, seconds: number, amplitude = 0): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataBytes = Math.round(byteRate * seconds);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  if (amplitude > 0) {
    for (let i = 0; i < dataBytes / 2; i += 1) {
      buffer.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, 44 + i * 2);
    }
  }
  return buffer;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wasit-wav-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wav reader', () => {
  it('reads an exact duration from the header', async () => {
    const file = path.join(dir, 'one-second.wav');
    writeFileSync(file, wavFile(22050, 1, 1));
    const info = await readWavInfo(file);
    expect(info).not.toBeNull();
    expect(info?.sampleRate).toBe(22050);
    expect(info?.channels).toBe(1);
    expect(info?.bitsPerSample).toBe(16);
    expect(info?.durationSeconds).toBeCloseTo(1, 3);
  });

  it('handles stereo and 48 kHz headers', async () => {
    const file = path.join(dir, 'stereo.wav');
    writeFileSync(file, wavFile(48000, 2, 2.5));
    const info = await readWavInfo(file);
    expect(info?.sampleRate).toBe(48000);
    expect(info?.channels).toBe(2);
    expect(info?.durationSeconds).toBeCloseTo(2.5, 3);
  });

  it('returns null for something that is not a WAV', async () => {
    const file = path.join(dir, 'not-audio.bin');
    writeFileSync(file, Buffer.from('this is not a wave file at all'));
    expect(await readWavInfo(file)).toBeNull();
  });

  it('measures silence as silence and a tone as signal', async () => {
    const silent = path.join(dir, 'silent.wav');
    writeFileSync(silent, wavFile(22050, 1, 1, 0));
    const quiet = await measureWavLevel(silent);
    expect(quiet?.peak).toBe(0);

    const tone = path.join(dir, 'tone.wav');
    writeFileSync(tone, wavFile(22050, 1, 1, 12000));
    const loud = await measureWavLevel(tone);
    expect(loud?.peak).toBeCloseTo(12000 / 32768, 3);
    expect(loud?.rms).toBeGreaterThan(0.3);
  });
});
