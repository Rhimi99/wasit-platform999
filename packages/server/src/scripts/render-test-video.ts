/**
 * Renders one real marketing video with the local renderer and inspects the
 * resulting file with ffprobe — not by trusting the `.mp4` extension.
 *
 *   npx tsx src/scripts/render-test-video.ts [--seconds=35] [--language=ar]
 *        [--audience=B2B] [--style=MODERN] [--out=<dir>]
 *
 * Writes the MP4 to `backups/media/` (git-ignored) and a JSON evidence report to
 * `docs/evidence/ai/`. Exit code is non-zero when the file is not a decodable
 * MP4 inside the 35–120s window.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/env.js';
import { ffmpegBin, ffprobeBin } from '../lib/media/binaries.js';
import { StructuralVideoProvider } from '../lib/media/video-provider.js';
import { measureMp4DurationSeconds } from '../lib/media/mp4.js';
import type { RenderSpec } from '../lib/media/video-types.js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')] as const;
  }),
);

const repoRoot = path.resolve(process.cwd(), '../..');
const seconds = Number(args.get('seconds') ?? 35);
const language = (args.get('language') ?? 'ar') as RenderSpec['language'];
const audience = (args.get('audience') ?? 'B2B') as RenderSpec['audience'];
const style = (args.get('style') ?? 'MODERN') as RenderSpec['style'];
const outDir = args.get('out') ?? path.join(repoRoot, 'backups', 'media');
const evidenceDir = path.join(repoRoot, 'docs', 'evidence', 'ai');

function ffprobe(file: string): Record<string, unknown> {
  const raw = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Decodes the whole file: a truncated or corrupt stream makes ffmpeg exit non-zero. */
function decodeCheck(file: string): { ok: boolean; detail: string } {
  try {
    execFileSync(ffmpegBin(), ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, detail: 'full decode completed with no errors' };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().slice(-400) ?? String(error);
    return { ok: false, detail: stderr };
  }
}

async function main(): Promise<void> {
  const provider = new StructuralVideoProvider();
  if (!(await provider.isAvailable())) {
    throw new Error(provider.unavailableReason() ?? 'renderer unavailable');
  }

  const spec: RenderSpec = {
    productId: 'evidence-product',
    productName: 'زيت زيتون بكر ممتاز 1 لتر',
    description: 'زيت زيتون بكر ممتاز معصور على البارد من صفاقس — عبوة زجاجية 1 لتر.',
    brand: 'WASIT',
    price: '24.500',
    currencyCode: 'TND',
    sellerName: 'WASIT Demo Supplier',
    imageUrl: null,
    language,
    audience,
    style,
    durationSeconds: seconds,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(outDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(outDir, `wasit-marketing-video-${stamp}.mp4`);

  const rendered = await provider.render(spec);
  await writeFile(file, rendered.bytes);

  const probe = ffprobe(file);
  const streams = (probe.streams ?? []) as Array<Record<string, unknown>>;
  const video = streams.find((s) => s.codec_type === 'video') ?? {};
  const format = (probe.format ?? {}) as Record<string, unknown>;
  const measuredFromBytes = measureMp4DurationSeconds(rendered.bytes);
  const decode = decodeCheck(file);
  const sha256 = createHash('sha256').update(rendered.bytes).digest('hex');

  const durationSeconds = Number(format.duration ?? 0);
  const report = {
    generatedAt: new Date().toISOString(),
    file,
    bytes: rendered.bytes.length,
    sha256,
    probe: {
      formatName: format.format_name ?? null,
      durationSeconds,
      sizeBytes: Number(format.size ?? rendered.bytes.length),
      video: {
        codec: video.codec_name ?? null,
        profile: video.profile ?? null,
        pixelFormat: video.pix_fmt ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        frameRate: video.r_frame_rate ?? null,
        frames: video.nb_frames ?? null,
      },
    },
    verification: {
      mp4HeaderDurationSeconds: measuredFromBytes,
      ffprobeDurationSeconds: durationSeconds,
      decode,
      withinWindow: durationSeconds >= 35 && durationSeconds <= 120,
    },
    materials: {
      background: 'ffmpeg lavfi colour source (generated, no external asset)',
      text: 'WASIT copy rendered by libass (no stock footage, no images)',
      fonts: {
        arabic: { family: env.VIDEO_ARABIC_FONT, license: 'SIL Open Font License 1.1 (per font name table)' },
        latin: { family: env.VIDEO_FONT, license: 'DejaVu (Bitstream Vera / public domain additions), system font' },
      },
      externalServices: false,
      paidServices: false,
    },
    renderer: {
      provider: provider.id,
      ffmpeg: execFileSync(ffmpegBin(), ['-version'], { encoding: 'utf8' }).split('\n')[0],
      width: env.VIDEO_WIDTH,
      height: env.VIDEO_HEIGHT,
      fps: env.VIDEO_FPS,
    },
  };

  const reportPath = path.join(evidenceDir, `marketing-video-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ report: reportPath, file, durationSeconds, sha256, decode: decode.ok }, null, 2));

  if (!existsSync(file) || !decode.ok || !report.verification.withinWindow || measuredFromBytes === null) {
    console.error('Video verification FAILED');
    process.exit(1);
  }
  if (Math.abs(measuredFromBytes - durationSeconds) > 0.5) {
    console.error(`Duration mismatch: moov says ${measuredFromBytes}s, ffprobe says ${durationSeconds}s`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
