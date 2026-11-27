import { mkdtempSync, readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffprobeProblem } from '../src/lib/media/binaries.js';
import { evaluateMarketingVideo } from '../src/lib/media/video-quality.js';
import { probeMp4File } from '../src/lib/media/verify.js';

/**
 * The quality gate must never certify a file it could not inspect.
 *
 * `ffprobe` ships with the system ffmpeg package, not with `ffmpeg-static`, so a
 * machine with only npm dependencies can render a video but cannot verify it.
 * The gate has to refuse with an actionable reason — an empty PATH here is the
 * exact state of that machine.
 *
 * This file runs with an empty PATH on purpose; vitest isolates modules per
 * file, so nothing else in the run observes it.
 */
const emptyDir = mkdtempSync(path.join(tmpdir(), 'wasit-nopath-'));
let savedPath: string | undefined;

beforeAll(() => {
  savedPath = process.env.PATH;
  process.env.PATH = emptyDir;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

describe('media toolchain — ffprobe discovery', () => {
  it('names the missing tool instead of surfacing a spawn error', async () => {
    expect(ffprobeProblem()).toMatch(/ffprobe is not installed/);
    expect(ffprobeProblem()).toMatch(/FFPROBE_PATH/);

    const probe = await probeMp4File(path.join(emptyDir, 'clip.mp4'));
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/ffprobe is not installed/);
  });

  it('refuses to certify a video it cannot inspect', async () => {
    await expect(
      evaluateMarketingVideo({
        file: path.join(emptyDir, 'clip.mp4'),
        produced: {} as never,
        expected: { language: 'ar', width: 720, height: 1280, fps: 25 },
        productSource: '',
      }),
    ).rejects.toThrow(/ffprobe is not installed/);
  });
});

/**
 * A bare `'ffmpeg'`/`'ffprobe'` anywhere in the media code silently reverts the
 * fix: on a machine that has only npm dependencies the spawn fails, and three of
 * the gate's measurements (silence, black frames, voice level) turn their
 * failure into a passing or failing verdict instead of an error. Scanning the
 * sources is the cheapest way to keep the resolver the only entry point.
 */
function mediaSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return mediaSources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('media toolchain — binary resolution is the only entry point', () => {
  it('never spawns a bare ffmpeg or ffprobe', () => {
    const pattern = /(run|execFile|execFileSync|spawn|spawnSync)\(\s*(['"])(ffmpeg|ffprobe)\2/;
    const offenders: string[] = [];
    for (const file of [...mediaSources('src/lib/media'), ...mediaSources('src/scripts')]) {
      if (file.endsWith('binaries.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (pattern.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
