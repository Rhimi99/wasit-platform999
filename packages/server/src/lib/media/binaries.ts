import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../env.js';

/**
 * Where the media pipeline finds its binaries.
 *
 * Precedence is explicit configuration first, then the system tool, then the
 * bundled `ffmpeg-static`. Keeping the system tool ahead of the bundle means a
 * deployment that installs ffmpeg (the Docker image does, with the fonts the
 * renderer needs) behaves exactly as before; a clean development checkout that
 * has only npm dependencies falls through to the bundled binary instead of
 * failing with ENOENT.
 *
 * `ffmpeg-static`'s binary is not restored by `npm rebuild` on npm 12+, which
 * blocks dependency install scripts; `npm run media:setup` installs and
 * verifies it.
 */

function usableFile(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** Resolves an executable through PATH without spawning anything. */
function onPath(binary: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here (or not executable): keep looking.
    }
  }
  return null;
}

let cachedFfmpeg: string | null = null;
let cachedFfprobe: string | null = null;

export function ffmpegBin(): string {
  cachedFfmpeg ??=
    usableFile(env.TTS_FFMPEG_PATH) ??
    usableFile(env.VIDEO_FFMPEG_PATH) ??
    onPath('ffmpeg') ??
    usableFile(ffmpegStatic) ??
    'ffmpeg';
  return cachedFfmpeg;
}

/**
 * Why the quality gate cannot inspect a file, or null when ffprobe resolves.
 *
 * `ffprobe` ships with the system ffmpeg package, not with `ffmpeg-static`, so a
 * machine that installed only npm dependencies can render a video but cannot
 * verify it. The gate must say that plainly; a raw `spawn ffprobe ENOENT` reads
 * like a code fault and invites someone to skip the check.
 */
export function ffprobeProblem(): string | null {
  const resolved = ffprobeBin();
  const present = resolved === 'ffprobe' ? onPath('ffprobe') !== null : usableFile(resolved) !== null;
  if (present) return null;
  return (
    'ffprobe is not installed, so the video quality gate cannot verify the file. ' +
    'Install the system ffmpeg package (it ships ffprobe) or set FFPROBE_PATH.'
  );
}

export function ffprobeBin(): string {
  cachedFfprobe ??= usableFile(env.TTS_FFPROBE_PATH) ?? usableFile(env.FFPROBE_PATH) ?? onPath('ffprobe') ?? 'ffprobe';
  return cachedFfprobe;
}
