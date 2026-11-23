import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { IMAGE_EXTENSIONS, probeImage, type SupportedImageMime } from './image-probe.js';

const run = promisify(execFile);

export interface ImageDerivative {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  extension: string;
  width: number;
  height: number;
}

/**
 * Produces a display-sized copy of an uploaded image.
 *
 * The storefront never needs the full-resolution original, and shipping a
 * 4000 px photo to every card is the difference between a usable catalog and a
 * slow one. The conversion is **best effort**: if the bundled ffmpeg cannot
 * decode the format (or is missing from a slim deployment), the caller keeps
 * the already-validated original instead of failing the upload.
 */
export async function buildImageDerivative(
  bytes: Buffer,
  mimeType: SupportedImageMime,
  maxDimension: number,
): Promise<ImageDerivative | null> {
  const original = probeImage(bytes);
  if (!original) return null;
  if (maxDimension <= 0) return null;
  if (original.width <= maxDimension && original.height <= maxDimension) return null;
  if (!ffmpegPath) return null;

  const dir = await mkdtemp(path.join(tmpdir(), 'wasit-image-'));
  const extension = IMAGE_EXTENSIONS[mimeType];
  const input = path.join(dir, `input.${extension}`);
  const output = path.join(dir, `output.${extension}`);
  try {
    await writeFile(input, bytes);
    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-map_metadata',
        '-1',
        '-frames:v',
        '1',
        '-vf',
        `scale=w='min(${maxDimension},iw)':h='min(${maxDimension},ih)':force_original_aspect_ratio=decrease`,
        ...(mimeType === 'image/jpeg' ? ['-q:v', '3'] : []),
        ...(mimeType === 'image/webp' ? ['-quality', '82'] : []),
        output,
      ],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const resized = await readFile(output);
    const probe = probeImage(resized);
    if (!probe || probe.mimeType !== mimeType) return null;
    return {
      bytes: resized,
      mimeType: probe.mimeType,
      extension: probe.extension,
      width: probe.width,
      height: probe.height,
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
