import { open } from 'node:fs/promises';
import path from 'node:path';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioFormat: number;
  dataBytes: number;
  durationSeconds: number;
}

/**
 * Reads the RIFF header of a PCM WAV file.
 *
 * Piper and the recorded voice packs both emit 22.05 kHz mono PCM, whose
 * duration is exact from the header — no `ffprobe` process needed. Returning
 * `null` (rather than guessing) for anything else keeps the caller honest about
 * formats this reader does not understand.
 */
export async function readWavInfo(file: string): Promise<WavInfo | null> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if ((await handle.read(head, 0, 12, 0)).bytesRead < 12) return null;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number; byteRate: number } | null = null;
    let dataBytes: number | null = null;

    // Walk the chunk table; unknown chunks are skipped by their declared size.
    for (let guard = 0; guard < 64; guard += 1) {
      const header = Buffer.alloc(8);
      const read = await handle.read(header, 0, 8, offset);
      if (read.bytesRead < 8) break;
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
        dataBytes = size;
        // `data` is normally last; keep the declared size and stop.
        break;
      }
      offset += size + (size % 2);
    }

    if (!fmt || dataBytes === null || dataBytes === 0) return null;
    const byteRate = fmt.byteRate > 0 ? fmt.byteRate : fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
    if (!byteRate) return null;
    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      audioFormat: fmt.audioFormat,
      dataBytes,
      durationSeconds: dataBytes / byteRate,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Peak/RMS amplitude of 16-bit PCM samples, normalised to 0..1.
 *
 * A gate that only checks "the file exists and has a duration" would pass a
 * silent render. This measures the waveform so a mute voiceover is caught.
 */
export async function measureWavLevel(file: string): Promise<{ peak: number; rms: number } | null> {
  const info = await readWavInfo(file);
  if (!info || info.bitsPerSample !== 16) return null;
  const handle = await open(file, 'r');
  try {
    const headerSize = (await findDataOffset(file)) ?? null;
    if (headerSize === null) return null;
    const bytes = info.dataBytes - (info.dataBytes % 2);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, headerSize);
    let peak = 0;
    let sumSquares = 0;
    const samples = bytes / 2;
    for (let i = 0; i < samples; i += 1) {
      const value = buffer.readInt16LE(i * 2) / 32768;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += value * value;
    }
    return { peak, rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0 };
  } finally {
    await handle.close();
  }
}

async function findDataOffset(file: string): Promise<number | null> {
  const handle = await open(file, 'r');
  try {
    let offset = 12;
    for (let guard = 0; guard < 64; guard += 1) {
      const header = Buffer.alloc(8);
      const read = await handle.read(header, 0, 8, offset);
      if (read.bytesRead < 8) return null;
      const id = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      offset += 8;
      if (id === 'data') return offset;
      offset += size + (size % 2);
    }
    return null;
  } finally {
    await handle.close();
  }
}

export function wavSummary(info: WavInfo, file: string): string {
  return `${path.basename(file)}: ${info.sampleRate}Hz ${info.channels}ch ${info.bitsPerSample}bit ${info.durationSeconds.toFixed(2)}s`;
}
