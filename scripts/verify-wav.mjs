#!/usr/bin/env node
/**
 * Verifies a WAV file without ffprobe: container shape, PCM format, duration
 * and signal level. Used by `scripts/install-tts.sh` so the voice engine can be
 * proven on a machine that only has the bundled ffmpeg (no system ffprobe).
 *
 * Usage: node scripts/verify-wav.mjs <file> [--min-seconds N] [--expect-rate HZ]
 * Exit codes: 0 ok, 1 invalid file, 2 usage error.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/verify-wav.mjs <file> [--min-seconds N] [--expect-rate HZ]');
  process.exit(2);
}
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const minSeconds = flag('--min-seconds') ? Number(flag('--min-seconds')) : 0;
const expectRate = flag('--expect-rate') ? Number(flag('--expect-rate')) : null;

async function readWav(target) {
  const handle = await open(target, 'r');
  try {
    const head = Buffer.alloc(12);
    if ((await handle.read(head, 0, 12, 0)).bytesRead < 12) return null;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let fmt = null;
    let dataOffset = null;
    let dataBytes = 0;
    for (let guard = 0; guard < 64; guard += 1) {
      const header = Buffer.alloc(8);
      if ((await handle.read(header, 0, 8, offset)).bytesRead < 8) break;
      const id = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      offset += 8;
      if (id === 'fmt ') {
        const body = Buffer.alloc(Math.min(size, 40));
        await handle.read(body, 0, body.length, offset);
        fmt = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          byteRate: body.readUInt32LE(8),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (id === 'data') {
        dataOffset = offset;
        dataBytes = size;
        break;
      }
      offset += size + (size % 2);
    }
    if (!fmt || dataOffset === null || dataBytes === 0) return null;

    let peak = null;
    if (fmt.bitsPerSample === 16) {
      const bytes = Math.min(dataBytes - (dataBytes % 2), 8 * 1024 * 1024);
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, dataOffset);
      let highest = 0;
      for (let i = 0; i < bytes / 2; i += 1) {
        const magnitude = Math.abs(buffer.readInt16LE(i * 2)) / 32768;
        if (magnitude > highest) highest = magnitude;
      }
      peak = highest;
    }

    const byteRate = fmt.byteRate > 0 ? fmt.byteRate : fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
    return { ...fmt, dataBytes, durationSeconds: dataBytes / byteRate, peak };
  } finally {
    await handle.close();
  }
}

let info = null;
try {
  info = await readWav(file);
} catch (error) {
  console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!info) {
  console.error(`not a readable PCM WAV: ${file}`);
  process.exit(1);
}
const problems = [];
if (info.audioFormat !== 1) problems.push(`audio format ${info.audioFormat} is not PCM`);
if (info.durationSeconds < minSeconds) problems.push(`duration ${info.durationSeconds.toFixed(2)}s is below ${minSeconds}s`);
if (expectRate !== null && info.sampleRate !== expectRate) problems.push(`sample rate ${info.sampleRate} != ${expectRate}`);
if (info.peak !== null && info.peak <= 0.01) problems.push('audio is silent (peak <= 0.01)');

console.log(
  JSON.stringify({
    file: path.basename(file),
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    durationSeconds: Number(info.durationSeconds.toFixed(3)),
    peak: info.peak === null ? null : Number(info.peak.toFixed(4)),
  }),
);
if (problems.length > 0) {
  console.error(`invalid voiceover: ${problems.join('; ')}`);
  process.exit(1);
}
