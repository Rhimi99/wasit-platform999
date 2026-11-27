import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegBin, ffprobeBin, ffprobeProblem } from './binaries.js';

const run = promisify(execFile);
const PROBE_TIMEOUT_MS = 60_000;
const DECODE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface Mp4Probe {
  ok: boolean;
  formatName: string | null;
  durationSeconds: number | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  frameRate: string | null;
  frames: number | null;
  error: string | null;
}

/**
 * Inspects a file with ffprobe. Trusting the `.mp4` extension is not evidence;
 * this reads the container and the video stream that are actually inside it.
 */
export async function probeMp4File(file: string): Promise<Mp4Probe> {
  const problem = ffprobeProblem();
  if (problem) {
    return {
      ok: false,
      formatName: null,
      durationSeconds: null,
      codec: null,
      width: null,
      height: null,
      frameRate: null,
      frames: null,
      error: problem,
    };
  }
  try {
    const { stdout } = await run(
      ffprobeBin(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT },
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video') ?? {};
    const format = parsed.format ?? {};
    return {
      ok: Boolean(video.codec_name),
      formatName: (format.format_name as string | undefined) ?? null,
      durationSeconds: format.duration === undefined ? null : Number(format.duration),
      codec: (video.codec_name as string | undefined) ?? null,
      width: video.width === undefined ? null : Number(video.width),
      height: video.height === undefined ? null : Number(video.height),
      frameRate: (video.r_frame_rate as string | undefined) ?? null,
      frames: video.nb_frames === undefined ? null : Number(video.nb_frames),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      formatName: null,
      durationSeconds: null,
      codec: null,
      width: null,
      height: null,
      frameRate: null,
      frames: null,
      error: messageOf(error),
    };
  }
}

/**
 * Decodes the whole file to null. A truncated or corrupt stream makes ffmpeg
 * exit non-zero, so this is the difference between "a file exists" and "the
 * video plays".
 */
export async function decodeMp4File(file: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await run(ffmpegBin(), ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      timeout: DECODE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, detail: 'full decode completed with no errors' };
  } catch (error) {
    return { ok: false, detail: messageOf(error).slice(-500) };
  }
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (stderr) return String(stderr).slice(-500);
  }
  return error instanceof Error ? error.message : String(error);
}
