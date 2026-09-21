import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../env.js';
import type { RenderSpec, RenderedVideo, VideoGenerationProvider } from './video-types.js';

/**
 * Resolves the ffmpeg binary: an explicit override first, then the bundled
 * `ffmpeg-static` package. Resolved lazily so deployments that use an external
 * video vendor never need the local renderer installed.
 */
function resolveFfmpegPath(): string | null {
  if (env.VIDEO_FFMPEG_PATH && existsSync(env.VIDEO_FFMPEG_PATH)) return env.VIDEO_FFMPEG_PATH;
  const candidates = [
    // System package (the API image installs ffmpeg + libass via apt).
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    path.resolve(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'),
    path.resolve(process.cwd(), '../../node_modules/ffmpeg-static/ffmpeg'),
    path.resolve(process.cwd(), '../node_modules/ffmpeg-static/ffmpeg'),
    '/workspace/project/node_modules/ffmpeg-static/ffmpeg',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Directory holding the bundled fonts passed to libass (Arabic shaping). */
function resolveFontsDir(): string {
  if (env.VIDEO_FONTS_DIR && existsSync(env.VIDEO_FONTS_DIR)) return env.VIDEO_FONTS_DIR;
  const candidates = [
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), '../../packages/server/assets/fonts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return '';
}

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 16, timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr?.toString().slice(-400) || err.message}`));
        return;
      }
      resolve();
    });
  });
}

/** Escapes text for the ASS event field (libass markup uses braces). */
function assEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

/** ASS colours are `&HAABBGGRR`. */
function assColor(rgb: [number, number, number], alpha = 0): string {
  const [r, g, b] = rgb;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `&H${hex(alpha)}${hex(b)}${hex(g)}${hex(r)}`;
}

function rgbHex(rgb: [number, number, number]): string {
  return `0x${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const STYLE_PALETTE: Record<
  RenderSpec['style'],
  { bg: [number, number, number]; fg: [number, number, number]; accent: [number, number, number] }
> = {
  MODERN: { bg: [15, 23, 42], fg: [241, 245, 249], accent: [37, 99, 235] },
  MINIMAL: { bg: [248, 250, 252], fg: [15, 23, 42], accent: [71, 85, 105] },
  BOLD: { bg: [124, 45, 18], fg: [255, 247, 237], accent: [234, 88, 12] },
  ELEGANT: { bg: [30, 27, 75], fg: [238, 242, 255], accent: [124, 58, 237] },
};

const COPY: Record<
  RenderSpec['language'],
  { intro: string; cta: string; audienceB2b: string; audienceB2c: string }
> = {
  ar: { intro: 'جديد على وسيط', cta: 'اطلب الآن عبر وسيط', audienceB2b: 'للتجار والشركات', audienceB2c: 'للعملاء' },
  fr: { intro: 'Nouveau sur WASIT', cta: 'Commandez sur WASIT', audienceB2b: 'Pour les professionnels', audienceB2c: 'Pour les clients' },
  en: { intro: 'New on WASIT', cta: 'Order now on WASIT', audienceB2b: 'For businesses', audienceB2c: 'For customers' },
  zh: { intro: 'WASIT 新品', cta: '立即在 WASIT 下单', audienceB2b: '面向企业', audienceB2c: '面向客户' },
};

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Arabic needs a shaping-capable font; everything else uses the Latin font. */
function fontFor(spec: RenderSpec): string {
  return spec.language === 'ar' || ARABIC_RE.test(spec.productName)
    ? env.VIDEO_ARABIC_FONT
    : env.VIDEO_FONT;
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

function buildAss(spec: RenderSpec, width: number, height: number, slideSeconds: number): string {
  const palette = STYLE_PALETTE[spec.style];
  const copy = COPY[spec.language];
  const font = fontFor(spec);
  const titleSize = Math.round(height / 16);
  const bodySize = Math.round(height / 24);

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,${font},${titleSize},${assColor(palette.fg)},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,5,40,40,40,1`,
    `Style: Body,${font},${bodySize},${assColor(palette.fg)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,60,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const priceLine = spec.price ? `${spec.price} ${spec.currencyCode}` : '';
  const sellerLine = spec.sellerName ?? '';
  const audienceLine = spec.audience === 'B2B' ? copy.audienceB2b : copy.audienceB2c;

  const slides: Array<{ style: string; text: string }> = [
    { style: 'Title', text: `${assEscape(copy.intro)}\\N${assEscape(spec.productName)}` },
    { style: 'Body', text: assEscape(spec.description.slice(0, 240)) },
    { style: 'Title', text: assEscape([priceLine, sellerLine].filter(Boolean).join('\\N') || spec.productName) },
    { style: 'Title', text: `${assEscape(audienceLine)}\\N${assEscape(copy.cta)}` },
  ];

  slides.forEach((s, i) => {
    const start = i * slideSeconds;
    const end = start + slideSeconds;
    lines.push(`Dialogue: 0,${fmtTime(start)},${fmtTime(end)},${s.style},,0,0,0,,${s.text}`);
  });

  return lines.join('\n');
}

/**
 * Structural video renderer — a real, deterministic MP4 renderer built on
 * ffmpeg + libass (FriBidi/HarfBuzz shaping, so Arabic renders correctly).
 *
 * It composes the brand palette, the product name, description, price and CTA
 * into a short vertical video. It is NOT a generative AI model, so it is
 * labelled `structural` everywhere rather than presented as AI output.
 */
export class StructuralVideoProvider implements VideoGenerationProvider {
  readonly id = 'structural';
  readonly isAsync = false;

  async isAvailable(): Promise<boolean> {
    return resolveFfmpegPath() !== null;
  }

  unavailableReason(): string | null {
    return resolveFfmpegPath() === null
      ? 'Local ffmpeg renderer is not installed (set VIDEO_FFMPEG_PATH or install ffmpeg-static)'
      : null;
  }

  async render(spec: RenderSpec): Promise<RenderedVideo> {
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) throw new Error(this.unavailableReason() ?? 'Video renderer unavailable');

    const width = env.VIDEO_WIDTH;
    const height = env.VIDEO_HEIGHT;
    const fps = env.VIDEO_FPS;
    const duration = spec.durationSeconds;
    const slideSeconds = duration / 4;
    const palette = STYLE_PALETTE[spec.style];
    const fontsDir = resolveFontsDir();

    const dir = await mkdtemp(path.join(os.tmpdir(), 'wasit-video-'));
    const assPath = path.join(dir, 'slides.ass');
    const outPath = path.join(dir, 'out.mp4');
    await writeFile(assPath, buildAss(spec, width, height, slideSeconds), 'utf8');

    const assFilter = `ass=${assPath}${fontsDir ? `:fontsdir=${fontsDir}` : ''}`;

    try {
      await run(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `color=c=${rgbHex(palette.accent)}:s=${width}x${height}:r=${fps}:d=${duration}`,
        '-vf', assFilter,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-t', String(duration),
        '-y', outPath,
      ]);
      const bytes = await readFile(outPath);
      return {
        bytes,
        mimeType: 'video/mp4',
        extension: 'mp4',
        width,
        height,
        durationSeconds: duration,
        provider: this.id,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Noop renderer — a wiring harness for deployments without a renderer. */
export class NoopVideoProvider implements VideoGenerationProvider {
  readonly id = 'noop';
  readonly isAsync = false;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  unavailableReason(): string | null {
    return 'The noop video renderer does not produce real video output';
  }
  async render(): Promise<RenderedVideo> {
    throw new Error('Video generation is disabled (VIDEO_PROVIDER=noop)');
  }
}