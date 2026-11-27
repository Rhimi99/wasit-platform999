import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env.js';
import { mixVoiceoverTrack } from './audio-mix.js';
import { ffmpegBin } from './binaries.js';
import { MUSIC_PROVENANCE, renderMusicBed } from './music.js';
import { resolveVoice, synthesizeSpeech, type VideoLanguage, type VoiceDefinition } from './tts.js';
import {
  buildVideoScript,
  ctaFor,
  type MarketingObjective,
  type ProductFacts,
  type ScriptScene,
  type VideoScript,
} from './video-script.js';

const run = promisify(execFile);

/** Seconds of cross-fade between two scenes. */
export const TRANSITION_SECONDS = 0.5;

const PALETTES: Record<
  string,
  { from: string; to: string; fg: string; accent: string }
> = {
  MODERN: { from: '0x0B1220', to: '0x1D4ED8', fg: '0xF8FAFC', accent: '0x38BDF8' },
  MINIMAL: { from: '0xF8FAFC', to: '0xDCE3EC', fg: '0x0F172A', accent: '0x334155' },
  BOLD: { from: '0x7C2D12', to: '0xEA580C', fg: '0xFFF7ED', accent: '0xFDE68A' },
  ELEGANT: { from: '0x1E1B4B', to: '0x6D28D9', fg: '0xEEF2FF', accent: '0xC4B5FD' },
};

function paletteFor(style: string) {
  return PALETTES[style] ?? PALETTES.MODERN;
}

function assColour(hex: string, alpha = 0): string {
  const r = hex.slice(2, 4);
  const g = hex.slice(4, 6);
  const b = hex.slice(6, 8);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

function fontFor(language: VideoLanguage): string {
  if (language === 'ar' || language === 'ar-TN') return env.VIDEO_ARABIC_FONT;
  if (language === 'zh') return 'Noto Sans SC';
  return env.VIDEO_FONT;
}

/** Wraps copy to a readable width; CJK has no spaces, so it wraps by glyph. */
export function wrapForSubtitle(text: string, maxChars: number, language: VideoLanguage): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (language === 'zh') {
    // Chinese breaks between glyphs, but a Latin product name must not be cut
    // mid-word: keep runs of non-CJK characters together as one token.
    const tokens = clean.match(/[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]|[^\s\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]+|\s+/g) ?? [];
    const lines: string[] = [];
    let current = '';
    for (const token of tokens) {
      if (token.length > maxChars) {
        if (current.trim()) lines.push(current.trim());
        for (let i = 0; i < token.length; i += maxChars) lines.push(token.slice(i, i + maxChars));
        current = '';
        continue;
      }
      if ((current + token).length > maxChars) {
        if (current.trim()) lines.push(current.trim());
        current = token.trimStart();
      } else {
        current += token;
      }
    }
    if (current.trim()) lines.push(current.trim());
    return lines;
  }
  const lines: string[] = [];
  let current = '';
  for (const word of clean.split(' ')) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface SceneTimeline extends ScriptScene {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  voiceoverStartSeconds: number;
  voiceoverDurationSeconds: number;
  hasVoiceover: boolean;
}

export interface PlannedTimeline {
  scenes: SceneTimeline[];
  totalSeconds: number;
}

/**
 * Turns scene copy + real voice lengths into a cut list.
 *
 * The voice sets the pace: a scene is at least as long as its read plus a
 * breath, and any slack up to the requested duration is spread across scenes
 * instead of being dumped on the last frame. The result is clamped to the
 * contractual 35–120 s window.
 */
export function planTimeline(
  script: VideoScript,
  voiceSeconds: ReadonlyMap<number, number>,
  targetSeconds: number,
): PlannedTimeline {
  const transition = TRANSITION_SECONDS;
  const base = script.scenes.map((scene) => {
    const voice = voiceSeconds.get(scene.index) ?? 0;
    const natural = voice > 0 ? voice + 0.95 : scene.minSeconds;
    return Math.max(scene.minSeconds, natural);
  });

  const totalOf = (durations: number[]) => durations.reduce((a, b) => a + b, 0) - (durations.length - 1) * transition;

  let durations = [...base];
  let total = totalOf(durations);

  const target = Math.max(35, Math.min(120, targetSeconds));
  if (total < target) {
    const slack = target - total;
    const perScene = slack / durations.length;
    durations = durations.map((d) => d + perScene);
    total = totalOf(durations);
  }

  // The last scene holds the call to action; a sub-second hold reads as a glitch.
  if (durations[durations.length - 1] < 4.5) {
    const deficit = 4.5 - durations[durations.length - 1];
    durations[durations.length - 1] += deficit;
    total = totalOf(durations);
  }

  const scenes: SceneTimeline[] = [];
  let prefix = 0;
  script.scenes.forEach((scene, index) => {
    const start = prefix - index * transition;
    const duration = durations[index];
    const voiceDuration = voiceSeconds.get(scene.index) ?? 0;
    // Speech starts once the cross-fade has mostly resolved, never on a blur.
    const voiceStart = start + (index === 0 ? 0.35 : transition * 0.7 + 0.1);
    scenes.push({
      ...scene,
      startSeconds: start,
      endSeconds: start + duration,
      durationSeconds: duration,
      voiceoverStartSeconds: voiceStart,
      voiceoverDurationSeconds: voiceDuration,
      hasVoiceover: voiceDuration > 0,
    });
    prefix += duration;
  });

  return { scenes, totalSeconds: total };
}

export function buildMarketingAss(
  timeline: PlannedTimeline,
  language: VideoLanguage,
  style: string,
  width: number,
  height: number,
  facts?: { brand?: string | null; price?: string | null; currencyCode?: string | null },
): { ass: string; cues: number } {
  const palette = paletteFor(style);
  const font = fontFor(language);
  const subtitleChars = language === 'zh' ? 16 : 34;
  const margin = Math.round(width * 0.07);

  const titleBase = Math.round(height / 13);
  const bulletSize = Math.round(height / 30);
  const subtitleSize = Math.round(height / 32);
  const ctaSize = Math.round(height / 21);
  const priceSize = Math.round(height / 12);
  const brandSize = Math.round(height / 42);

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
    `Style: Brand,${font},${brandSize},${assColour(palette.accent)},&H64000000,&H00000000,1,0,0,0,100,100,3,0,1,2,0,7,${margin},${margin},${Math.round(height * 0.055)},1`,
    `Style: Title,${font},${titleBase},${assColour(palette.fg)},&H70000000,&H00000000,1,0,0,0,100,100,0,0,1,3,1,8,${margin},${margin},${Math.round(height * 0.15)},1`,
    `Style: Bullet,${font},${bulletSize},${assColour(palette.fg)},&H60000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,5,${margin},${margin},0,1`,
    `Style: Quote,${font},${bulletSize},${assColour(palette.accent)},&H60000000,&H00000000,0,1,0,0,100,100,0,0,1,2,1,5,${margin},${margin},0,1`,
    `Style: Price,${font},${priceSize},${assColour(palette.to)},${assColour(palette.accent)},&H00000000,1,0,0,0,100,100,0,0,3,${Math.round(height / 90)},0,5,${margin},${margin},0,1`,
    `Style: Cta,${font},${ctaSize},${assColour(palette.from)},&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,14,0,5,${margin},${margin},0,1`,
    `Style: Sub,${font},${subtitleSize},&H00FFFFFF,&H00000000,&H40000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,${Math.round(height * 0.075)},1`,
    `Style: Bar,${font},10,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  let cues = 0;
  const total = timeline.totalSeconds;

  // Wordmark and progress rail are drawn once and stay for the whole cut.
  lines.push(
    `Dialogue: 2,${assTime(0)},${assTime(total)},Brand,,0,0,0,,{\\fad(300,300)}WASIT`,
  );
  const barY = height - Math.round(height * 0.012);
  const barH = Math.max(4, Math.round(height * 0.006));

  for (let index = 0; index < timeline.scenes.length; index += 1) {
    const scene = timeline.scenes[index];
    const headlineStart = scene.startSeconds + 0.25;
    const headlineEnd = scene.endSeconds - 0.1;
    const progress = Math.round((width * (index + 1)) / timeline.scenes.length);

    lines.push(
      `Dialogue: 1,${assTime(scene.startSeconds)},${assTime(scene.endSeconds)},Bar,,0,0,0,,` +
        `{\\an7\\pos(0,${barY})\\p1\\c${assColour(palette.accent).replace('&H00', '&H')}}` +
        `m 0 0 l ${progress} 0 ${progress} ${barH} 0 ${barH}{\\p0}`,
    );

    if (scene.kind === 'cta') {
      // The button must sit inside the safe area; a CTA that bleeds off the
      // frame reads as a rendering bug, not as urgency.
      const fittedCta = fitTitle(scene.headline, ctaSize, width - margin * 3, language, height);
      lines.push(
        `Dialogue: 0,${assTime(headlineStart)},${assTime(headlineEnd)},Cta,,0,0,0,,` +
          `{\\fad(220,220)\\an5\\pos(${Math.round(width / 2)},${Math.round(height * 0.5)})\\fs${fittedCta}}${assEscape(scene.headline)}`,
      );
      cues += 1;
    } else {
      const fitted = fitTitle(scene.headline, titleBase, width - margin * 2.6, language, height);
      lines.push(
        `Dialogue: 0,${assTime(headlineStart)},${assTime(headlineEnd)},Title,,0,0,0,,` +
          `{\\fad(220,220)\\fs${fitted}}${assEscape(scene.headline)}`,
      );
      cues += 1;
    }

    // The hook carries the price tag: an advert that opens on a name and no
    // number gives the viewer nothing to judge.
    if (scene.kind === 'hook' && facts?.price) {
      // Number and currency live on separate lines: one mixed-direction line
      // gets re-ordered per font run and the price stops being readable.
      const priceText = facts.price;
      const fittedPrice = fitTitle(priceText, priceSize, width - margin * 4, language, height);
      lines.push(
        `Dialogue: 0,${assTime(headlineStart)},${assTime(headlineEnd)},Price,,0,0,0,,` +
          `{\\fad(260,260)\\fs${fittedPrice}\\pos(${Math.round(width / 2)},${Math.round(height * 0.45)})}${assEscape(priceText)}`,
      );
      cues += 1;
      const caption = [facts.currencyCode, facts.brand].filter(Boolean).join('  ·  ');
      if (caption) {
        lines.push(
          `Dialogue: 0,${assTime(headlineStart + 0.5)},${assTime(headlineEnd)},Quote,,0,0,0,,` +
            `{\\fad(260,260)\\an5\\pos(${Math.round(width / 2)},${Math.round(height * 0.525)})}${assEscape(caption)}`,
        );
        cues += 1;
      }
    }

    const bullets = scene.bullets.filter(Boolean);
    const bulletTop = Math.round(height * 0.52);
    bullets.forEach((bullet, bulletIndex) => {
      const start = headlineStart + 0.35 + bulletIndex * 0.55;
      if (start >= headlineEnd) return;
      const styleName = scene.kind === 'detail' ? 'Quote' : 'Bullet';
      // A leading bullet in RTL copy lands on the wrong side of the line; the
      // stacked layout already separates the items.
      const rtl = language === 'ar' || language === 'ar-TN';
      const prefix = scene.kind === 'detail' || rtl ? '' : '•  ';
      const y = bulletTop + bulletIndex * Math.round(height * 0.06);
      lines.push(
        `Dialogue: 0,${assTime(start)},${assTime(headlineEnd)},${styleName},,0,0,0,,` +
          `{\\fad(220,220)\\an5\\pos(${Math.round(width / 2)},${y})}${assEscape(prefix + bullet)}`,
      );
      cues += 1;
    });

    if (scene.hasVoiceover) {
      const subtitleEnd = Math.min(
        scene.endSeconds - 0.05,
        scene.voiceoverStartSeconds + scene.voiceoverDurationSeconds + 0.15,
      );
      const rtlLine = language === 'ar' || language === 'ar-TN' ? '\u200F' : '';
      const wrapped = wrapForSubtitle(scene.voiceover, subtitleChars, language)
        .map((line) => assEscape(rtlLine + line))
        .join('\\N');
      if (wrapped) {
        lines.push(
          `Dialogue: 3,${assTime(scene.voiceoverStartSeconds)},${assTime(subtitleEnd)},Sub,,0,0,0,,${wrapped}`,
        );
        cues += 1;
      }
    }
  }

  return { ass: lines.join('\n'), cues };
}

/** Shrinks a headline until it fits the frame instead of letting it clip. */
export function fitTitle(text: string, baseSize: number, maxWidth: number, language: VideoLanguage, height: number): number {
  const perGlyph = language === 'zh' ? 1 : 0.6;
  const estimated = Math.max(1, text.length) * perGlyph * baseSize;
  if (estimated <= maxWidth) return baseSize;
  return Math.max(Math.round(height / 28), Math.floor((baseSize * maxWidth) / estimated));
}

export interface ProduceInput {
  facts: ProductFacts;
  language: VideoLanguage;
  objective: MarketingObjective;
  audience: 'B2B' | 'B2C';
  style: string;
  targetSeconds: number;
  workDir: string;
  outFile: string;
}

export interface ProducedVideo {
  file: string;
  script: VideoScript;
  timeline: PlannedTimeline;
  voice: VoiceDefinition | null;
  /** Set when the language has no usable voice — the render still happens. */
  voiceGap: string | null;
  music: typeof MUSIC_PROVENANCE;
  subtitleCues: number;
  frames: { width: number; height: number; fps: number };
}

async function renderSceneClip(
  scene: SceneTimeline,
  palette: { from: string; to: string },
  outFile: string,
  width: number,
  height: number,
  fps: number,
  reverse: boolean,
): Promise<void> {
  const duration = scene.durationSeconds;
  const x1 = reverse ? 0 : width;
  const y1 = reverse ? 0 : height;
  const source =
    `gradients=s=${width}x${height}:c0=${palette.from}:c1=${palette.to}` +
    `:x0=${reverse ? width : 0}:y0=${reverse ? height : 0}:x1=${x1}:y1=${y1}` +
    `:d=${duration.toFixed(3)}:speed=0.06:r=${fps}`;

  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', source,
    '-vf',
    `vignette=PI/4.6,fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, duration - 0.4).toFixed(3)}:d=0.4,format=yuv420p`,
    '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-y', outFile,
  ], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Produces the finished advert: script → voiceover → cut → subtitles → mix.
 *
 * The render still happens when a language has no voice, because a silent cut
 * is the evidence that names the gap. It is never handed to the buyer as a
 * finished advert — the quality gate fails it and the caller withholds it.
 */
export async function produceMarketingVideo(input: ProduceInput): Promise<ProducedVideo> {
  const width = env.VIDEO_WIDTH;
  const height = env.VIDEO_HEIGHT;
  const fps = env.VIDEO_FPS;
  const palette = paletteFor(input.style);

  const script = buildVideoScript({
    language: input.language,
    objective: input.objective,
    audience: input.audience,
    facts: input.facts,
  });

  const resolved = resolveVoice(input.language);
  const voiceSeconds = new Map<number, number>();
  const voiceFiles: Array<{ index: number; file: string }> = [];

  if (resolved.voice) {
    for (const scene of script.scenes) {
      const outFile = path.join(input.workDir, `voice-${scene.index}.wav`);
      const clip = await synthesizeSpeech({ text: scene.voiceover, language: input.language, outFile });
      voiceSeconds.set(scene.index, clip.durationSeconds);
      voiceFiles.push({ index: scene.index, file: clip.file });
    }
  }

  const timeline = planTimeline(script, voiceSeconds, input.targetSeconds);
  const { ass, cues } = buildMarketingAss(timeline, input.language, input.style, width, height, {
    brand: input.facts.brand,
    price: input.facts.price,
    currencyCode: input.facts.currencyCode,
  });
  const assPath = path.join(input.workDir, 'overlay.ass');
  await writeFile(assPath, ass, 'utf8');

  const clipPaths: string[] = [];
  for (let i = 0; i < timeline.scenes.length; i += 1) {
    const scene = timeline.scenes[i];
    const clipPath = path.join(input.workDir, `scene-${scene.index}.mp4`);
    await renderSceneClip(scene, palette, clipPath, width, height, fps, i % 2 === 1);
    clipPaths.push(clipPath);
  }

  const musicPath = path.join(input.workDir, 'music.wav');
  await writeFile(
    musicPath,
    renderMusicBed({
      durationSeconds: timeline.totalSeconds,
      sceneBoundaries: timeline.scenes.slice(1).map((s) => s.startSeconds),
    }),
  );

  let voiceTrack: string | null = null;
  if (voiceFiles.length > 0) {
    const byIndex = new Map(voiceFiles.map((v) => [v.index, v.file]));
    const placements = timeline.scenes
      .filter((s) => s.hasVoiceover)
      .map((s) => ({ file: byIndex.get(s.index) as string, startSeconds: s.voiceoverStartSeconds }));
    voiceTrack = path.join(input.workDir, 'voice.wav');
    await mixVoiceoverTrack(placements, timeline.totalSeconds, voiceTrack);
  }

  const fontsDir = path.join(process.cwd(), 'assets', 'fonts');
  const total = timeline.totalSeconds.toFixed(3);
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];
  for (const clip of clipPaths) args.push('-i', clip);
  args.push('-i', musicPath);
  if (voiceTrack) args.push('-i', voiceTrack);

  const musicIndex = clipPaths.length;
  const voiceIndex = clipPaths.length + 1;

  const filters: string[] = [];
  if (clipPaths.length === 1) {
    filters.push('[0:v]null[vx]');
  } else {
    let offset = 0;
    let current = '[0:v]';
    for (let i = 1; i < clipPaths.length; i += 1) {
      offset += timeline.scenes[i - 1].durationSeconds - TRANSITION_SECONDS;
      const out = i === clipPaths.length - 1 ? '[vx]' : `[x${i}]`;
      filters.push(
        `${current}[${i}:v]xfade=transition=fade:duration=${TRANSITION_SECONDS}:offset=${offset.toFixed(3)}${out}`,
      );
      current = `[x${i}]`;
    }
  }
  filters.push(`[vx]ass=${assPath}:fontsdir=${fontsDir},format=yuv420p[v]`);

  const musicChain = `[${musicIndex}:a]volume=${env.VIDEO_MUSIC_GAIN_DB}dB,atrim=0:${total},afade=t=out:st=${(timeline.totalSeconds - 1.8).toFixed(3)}:d=1.8`;
  if (voiceTrack) {
    filters.push(`${musicChain}[mb]`);
    filters.push(`[mb][${voiceIndex}:a]sidechaincompress=threshold=0.03:ratio=8:attack=8:release=320[mbd]`);
    filters.push(`[mbd][${voiceIndex}:a]amix=inputs=2:duration=first:normalize=0[mix]`);
    filters.push(`[mix]loudnorm=I=${env.VIDEO_LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11,alimiter=limit=0.95[a]`);
  } else {
    filters.push(`${musicChain}[mix]`);
    filters.push(`[mix]loudnorm=I=${env.VIDEO_LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11,alimiter=limit=0.95[a]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart',
    '-t', total,
    '-y', input.outFile,
  );

  await run(ffmpegBin(), args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });

  return {
    file: input.outFile,
    script,
    timeline,
    voice: resolved.voice,
    voiceGap: resolved.reason,
    music: MUSIC_PROVENANCE,
    subtitleCues: cues,
    frames: { width, height, fps },
  };
}

/** The CTA line a finished advert must close on. */
export function expectedCta(language: VideoLanguage): string {
  return ctaFor(language);
}
