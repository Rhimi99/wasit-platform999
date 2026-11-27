import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../env.js';
import { ffmpegBin, ffprobeBin, ffprobeProblem } from './binaries.js';
import { MARKETING_VIDEO_DURATION } from '@wasit/shared';
import type { ProducedVideo, SceneTimeline } from './marketing-video.js';
import type { VideoLanguage } from './tts.js';

const run = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface QualityCheck {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  detail: string;
}

export interface QualityReport {
  passed: boolean;
  /** First failing required check, as a stable code the API can return. */
  reason: string | null;
  message: string | null;
  checks: QualityCheck[];
  metrics: {
    durationSeconds: number | null;
    video: {
      codec: string | null;
      width: number | null;
      height: number | null;
      frameRate: number | null;
      pixelFormat: string | null;
      frames: number | null;
    };
    audio: {
      present: boolean;
      codec: string | null;
      sampleRate: number | null;
      channels: number | null;
      loudnessLufs: number | null;
      loudnessRangeLu: number | null;
      truePeakDb: number | null;
      longestSilenceSeconds: number | null;
    };
    scenes: Array<{
      index: number;
      hasVoiceover: boolean;
      rmsDb: number | null;
      silenceRatio: number | null;
      seconds: number;
    }>;
    subtitleCues: number;
    blackSegments: number;
    decodedFully: boolean;
  };
}

interface ProbeResult {
  durationSeconds: number | null;
  video: QualityReport['metrics']['video'];
  audio: { present: boolean; codec: string | null; sampleRate: number | null; channels: number | null };
}

async function probe(file: string): Promise<ProbeResult> {
  // Fail closed with an actionable reason: an unverifiable file is not a
  // passing file.
  const problem = ffprobeProblem();
  if (problem) throw new Error(problem);
  const { stdout } = await run(
    ffprobeBin(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 60_000, maxBuffer: MAX_OUTPUT },
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video') ?? {};
  const audio = streams.find((s) => s.codec_type === 'audio');
  const frameRate = (video.r_frame_rate as string | undefined) ?? null;
  const fps = frameRate && frameRate.includes('/')
    ? Number(frameRate.split('/')[0]) / Number(frameRate.split('/')[1] || 1)
    : frameRate
      ? Number(frameRate)
      : null;

  return {
    durationSeconds: parsed.format?.duration === undefined ? null : Number(parsed.format.duration),
    video: {
      codec: (video.codec_name as string | undefined) ?? null,
      width: video.width === undefined ? null : Number(video.width),
      height: video.height === undefined ? null : Number(video.height),
      frameRate: fps,
      pixelFormat: (video.pix_fmt as string | undefined) ?? null,
      frames: video.nb_frames === undefined ? null : Number(video.nb_frames),
    },
    audio: {
      present: Boolean(audio),
      codec: (audio?.codec_name as string | undefined) ?? null,
      sampleRate: audio?.sample_rate === undefined ? null : Number(audio.sample_rate),
      channels: audio?.channels === undefined ? null : Number(audio.channels),
    },
  };
}

async function decodesFully(file: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await run(ffmpegBin(), ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      timeout: 180_000,
      maxBuffer: MAX_OUTPUT,
    });
    return { ok: true, detail: 'full decode completed with no errors' };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    return { ok: false, detail: String(stderr ?? (error as Error).message).slice(-400) };
  }
}

interface Loudness {
  integratedLufs: number | null;
  rangeLu: number | null;
  truePeakDb: number | null;
}

async function measureLoudness(file: string): Promise<Loudness> {
  const { stderr } = await run(ffmpegBin(), ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    timeout: 180_000,
    maxBuffer: MAX_OUTPUT,
  }).catch((error: { stderr?: Buffer | string }) => ({ stdout: '', stderr: String(error.stderr ?? '') }));

  const text = String(stderr);
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const integrated = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  const range = /LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/.exec(summary);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    rangeLu: range ? Number(range[1]) : null,
    truePeakDb: peak ? Number(peak[1]) : null,
  };
}

interface SilenceGap {
  start: number;
  end: number;
}

async function detectSilence(file: string, thresholdDb = -45, minSeconds = 0.6): Promise<SilenceGap[]> {
  const { stderr } = await run(
    ffmpegBin(),
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=n=${thresholdDb}dB:d=${minSeconds}`, '-f', 'null', '-'],
    { timeout: 180_000, maxBuffer: MAX_OUTPUT },
  ).catch((error: { stderr?: Buffer | string }) => ({ stdout: '', stderr: String(error.stderr ?? '') }));

  const gaps: SilenceGap[] = [];
  const pattern = /silence_start:\s*(-?\d+(?:\.\d+)?)[\s\S]*?silence_end:\s*(-?\d+(?:\.\d+)?)/g;
  const text = String(stderr);
  let match = pattern.exec(text);
  while (match) {
    gaps.push({ start: Number(match[1]), end: Number(match[2]) });
    match = pattern.exec(text);
  }
  return gaps;
}

async function countBlackSegments(file: string): Promise<number> {
  const { stderr } = await run(
    ffmpegBin(),
    // 0.03, not ffmpeg's 0.10 default: the brand's dark navy (#0B1220) sits at
    // ~0.06 luma and is a deliberate background, not a blank frame.
    ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.03', '-f', 'null', '-'],
    { timeout: 180_000, maxBuffer: MAX_OUTPUT },
  ).catch((error: { stderr?: Buffer | string }) => ({ stdout: '', stderr: String(error.stderr ?? '') }));
  return (String(stderr).match(/black_start:/g) ?? []).length;
}

/** RMS of one window; the number the gate uses to prove a scene is not silent. */
async function windowRms(file: string, startSeconds: number, durationSeconds: number): Promise<number | null> {
  if (durationSeconds <= 0.15) return null;
  const { stderr } = await run(
    ffmpegBin(),
    [
      '-hide_banner', '-nostats',
      '-ss', startSeconds.toFixed(3), '-t', durationSeconds.toFixed(3),
      '-i', file,
      '-af', 'astats=metadata=1:reset=0',
      '-f', 'null', '-',
    ],
    { timeout: 120_000, maxBuffer: MAX_OUTPUT },
  ).catch((error: { stderr?: Buffer | string }) => ({ stdout: '', stderr: String(error.stderr ?? '') }));

  const matches = [...String(stderr).matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1];
  return last === '-inf' ? -100 : Number(last);
}

const TUNISIAN_MARKERS = ['توا', 'توّا', 'تنجّم', 'تنجم', 'برشا', 'شنية', 'شنوّة', 'علاش', 'باش', 'إلّي', 'اللي', 'منيح', 'خاطر', 'السوم', 'كمّن', 'ياخي'];
const MSA_ONLY_MARKERS = ['يمكنك', 'بإمكانك', 'اشترِ الآن', 'نقدّم لكم', 'يُعدّ', 'الآن يمكنك'];

const ARABIC_RE = /[\u0600-\u06FF]/g;
const LATIN_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;
const CJK_RE = /[\u4E00-\u9FFF]/g;

function scriptLanguageIssue(language: VideoLanguage, text: string): string | null {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 'the script has no letters';
  const share = (re: RegExp) => ((text.match(re) ?? []).length / letters.length) * 100;

  if (language === 'ar' || language === 'ar-TN') {
    const arabic = share(ARABIC_RE);
    return arabic >= 55 ? null : `only ${arabic.toFixed(0)}% of the letters are Arabic`;
  }
  if (language === 'zh') {
    const cjk = share(CJK_RE);
    // Brand and product names stay in Latin script, so the share alone cannot
    // be the test; the copy must also read as Chinese sentences.
    const functionWords = ['的', '在', '即', '和', '是', '可', '并'].filter((w) => text.includes(w)).length;
    if (cjk >= 25 && functionWords >= 2) return null;
    return `only ${cjk.toFixed(0)}% of the letters are Chinese and ${functionWords} Chinese function word(s) found`;
  }
  const latin = share(LATIN_RE);
  if (latin < 55) return `only ${latin.toFixed(0)}% of the letters are Latin`;
  if (language === 'fr') {
    const french = /\b(le|la|les|des|du|et|vous|votre|sur|avec|pour)\b/i.test(text);
    const englishOnly = /\b(the|and|your|order now|price)\b/i.test(text);
    if (!french) return 'the copy has no French function words';
    if (englishOnly && !/\b(votre|vous|prix|commande)\b/i.test(text)) return 'the copy reads as English, not French';
  }
  if (language === 'en' && !/\b(the|and|your|order|price|now)\b/i.test(text)) {
    return 'the copy has no English function words';
  }
  return null;
}

function dialectIssue(text: string): string | null {
  const hits = TUNISIAN_MARKERS.filter((marker) => text.includes(marker));
  const msa = MSA_ONLY_MARKERS.filter((marker) => text.includes(marker));
  if (msa.length > 0) return `the copy mixes in MSA-only phrasing (${msa.join(', ')})`;
  if (hits.length < 3) return `only ${hits.length} Tunisian markers found; the copy is not written in the dialect`;
  return null;
}

/** Numbers the copy is allowed to state, taken from the product itself. */
function allowedNumbers(source: string): Set<string> {
  const numbers = source.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const set = new Set<string>();
  for (const raw of numbers) {
    set.add(raw);
    set.add(raw.replace(',', '.'));
    set.add(raw.replace('.', ','));
    set.add(raw.replace(/[.,]/g, ''));
  }
  return set;
}

function untraceableNumbers(copy: string, allowed: Set<string>): string[] {
  const found = copy.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(found)].filter((n) => {
    const variants = [n, n.replace(',', '.'), n.replace('.', ','), n.replace(/[.,]/g, '')];
    return !variants.some((v) => allowed.has(v));
  });
}

export interface EvaluateInput {
  file: string;
  produced: ProducedVideo;
  expected: { language: VideoLanguage; width: number; height: number; fps: number };
  /** Product text the copy may quote; used to trace every number it states. */
  productSource: string;
}

/**
 * The delivery gate.
 *
 * Nothing is published until this returns `passed: true`: a file that exists is
 * not the same thing as an advert that plays, speaks the right language, keeps
 * the voice audible, stays inside the 35–120 s window and closes on a CTA.
 */
export async function evaluateMarketingVideo(input: EvaluateInput): Promise<QualityReport> {
  const { produced, expected } = input;
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string, required = true) => {
    checks.push({ id, label, required, passed, detail });
  };

  const probed = await probe(input.file);
  const decoded = await decodesFully(input.file);
  const loudness = await measureLoudness(input.file);
  const silences = await detectSilence(input.file);
  const blackSegments = await countBlackSegments(input.file);

  const duration = probed.durationSeconds;
  add(
    'duration.window',
    'المدة داخل النطاق التعاقدي',
    duration !== null && duration >= MARKETING_VIDEO_DURATION.min - 0.15 && duration <= MARKETING_VIDEO_DURATION.max + 0.15,
    `${duration ?? 'unknown'}s (allowed ${MARKETING_VIDEO_DURATION.min}–${MARKETING_VIDEO_DURATION.max}s)`,
  );
  add(
    'duration.match',
    'المدة تطابق الخطة',
    duration !== null && Math.abs(duration - produced.timeline.totalSeconds) <= 1,
    `file ${duration ?? 'unknown'}s vs plan ${produced.timeline.totalSeconds.toFixed(2)}s`,
  );
  add('container.playable', 'الملف قابل للتشغيل كاملاً', decoded.ok, decoded.detail);
  add(
    'video.codec',
    'ترميز الفيديو',
    probed.video.codec === 'h264' && probed.video.pixelFormat === 'yuv420p',
    `${probed.video.codec ?? 'none'} / ${probed.video.pixelFormat ?? 'none'}`,
  );
  add(
    'video.resolution',
    'دقة الفيديو',
    probed.video.width === expected.width && probed.video.height === expected.height,
    `${probed.video.width ?? '?'}x${probed.video.height ?? '?'} (expected ${expected.width}x${expected.height})`,
  );
  add(
    'video.frame_rate',
    'معدل الإطارات',
    probed.video.frameRate !== null && Math.abs(probed.video.frameRate - expected.fps) < 0.05,
    `${probed.video.frameRate ?? '?'} fps (expected ${expected.fps})`,
  );
  add(
    'video.black_frames',
    'لا شاشة سوداء غير مقصودة',
    blackSegments === 0,
    `${blackSegments} black segment(s)`,
  );

  add(
    'audio.stream',
    'مسار صوتي صالح',
    probed.audio.present && probed.audio.codec === 'aac' && probed.audio.channels === 2,
    probed.audio.present
      ? `${probed.audio.codec} ${probed.audio.sampleRate}Hz ${probed.audio.channels}ch`
      : 'no audio stream',
  );
  add(
    'audio.loudness',
    'مستوى الصوت ضمن المدى الإذاعي',
    loudness.integratedLufs !== null && loudness.integratedLufs >= -24 && loudness.integratedLufs <= -9,
    `${loudness.integratedLufs ?? '?'} LUFS, LRA ${loudness.rangeLu ?? '?'} LU, peak ${loudness.truePeakDb ?? '?'} dBFS`,
  );
  add(
    'audio.true_peak',
    'لا تشويه (قمة حقيقية)',
    loudness.truePeakDb !== null && loudness.truePeakDb <= -0.5,
    `${loudness.truePeakDb ?? '?'} dBFS (must be ≤ -0.5)`,
  );

  // Per-scene energy: a scene that was planned with speech but plays at the
  // level of the music bed alone is a silent scene, whatever the plan says.
  const sceneMetrics: QualityReport['metrics']['scenes'] = [];
  for (const scene of produced.timeline.scenes) {
    const window = scene.hasVoiceover
      ? { start: scene.voiceoverStartSeconds + 0.15, duration: Math.max(0.4, scene.voiceoverDurationSeconds - 0.3) }
      : { start: scene.startSeconds + 0.6, duration: Math.max(0.5, Math.min(2, scene.durationSeconds - 1)) };
    const rms = await windowRms(input.file, window.start, window.duration);
    const silenceRatio = scene.hasVoiceover
      ? silenceOverlapRatio(silences, window.start, window.start + window.duration)
      : null;
    sceneMetrics.push({
      index: scene.index,
      hasVoiceover: scene.hasVoiceover,
      rmsDb: rms,
      silenceRatio,
      seconds: scene.durationSeconds,
    });
  }

  const voicedScenes = sceneMetrics.filter((s) => s.hasVoiceover);
  const silentScenes = voicedScenes.filter((s) => s.rmsDb === null || s.rmsDb < -38);
  add(
    'audio.voiceover',
    'تعليق صوتي مسموع في كل مشهد',
    voicedScenes.length > 0 && silentScenes.length === 0,
    voicedScenes.length === 0
      ? 'no scene carries a voiceover'
      : `${voicedScenes.length - silentScenes.length}/${voicedScenes.length} voiced scenes above -38 dB`,
  );
  const choppyScenes = voicedScenes.filter((s) => (s.silenceRatio ?? 0) > 0.45);
  add(
    'audio.speech_continuity',
    'الكلام غير مبتور',
    choppyScenes.length === 0,
    choppyScenes.length === 0
      ? 'every voice window is at least 55% speech'
      : `silence covers >45% of the voice window in scene(s) ${choppyScenes.map((s) => s.index).join(', ')}`,
  );

  const voice = produced.voice;
  const voiceLocaleOk = voice !== null && voice.language === expected.language;
  add(
    'audio.voice_language',
    'لغة الصوت تطابق اللغة المختارة',
    voiceLocaleOk,
    voice
      ? `voice ${voice.id} (${voice.locale}) for requested ${expected.language}`
      : produced.voiceGap ?? 'no voice was available',
  );
  add(
    'audio.dialect_native',
    'الصوت أصلي للهجة',
    expected.language !== 'ar-TN' ? true : Boolean(voice?.dialectNative),
    expected.language !== 'ar-TN'
      ? 'not a dialect request'
      : voice?.dialectNative
        ? 'native dialect voice'
        : produced.voiceGap ?? 'no native Tunisian voice available',
    expected.language === 'ar-TN',
  );

  const fullText = produced.script.scenes.map((s) => s.voiceover).join(' ');
  const languageIssue = scriptLanguageIssue(expected.language, fullText);
  add('text.script_language', 'نص السيناريو باللغة المطلوبة', languageIssue === null, languageIssue ?? 'script matches the requested language');

  if (expected.language === 'ar-TN') {
    const issue = dialectIssue(fullText);
    add('text.dialect', 'النص باللهجة التونسية دون خلط', issue === null, issue ?? 'Tunisian copy, no MSA-only phrasing');
  }

  const ctaScene = produced.script.scenes[produced.script.scenes.length - 1];
  const ctaPresent = ctaScene.voiceover.includes(produced.script.cta) || ctaScene.headline.includes(produced.script.cta);
  add('text.cta', 'دعوة واضحة لاتخاذ إجراء', ctaPresent, ctaPresent ? `CTA: ${produced.script.cta}` : 'no CTA in the closing scene');

  const allowed = allowedNumbers(input.productSource);
  const stray = untraceableNumbers(fullText, allowed);
  add(
    'text.claims',
    'لا أرقام أو ادعاءات غير مسنودة',
    stray.length === 0,
    stray.length === 0 ? 'every number traces back to product data' : `untraceable number(s): ${stray.join(', ')}`,
  );

  const subtitleIssue = subtitleSyncIssue(produced.timeline.scenes, produced.subtitleCues);
  add('text.subtitles', 'ترجمة نصية متزامنة', subtitleIssue === null, subtitleIssue ?? `${produced.subtitleCues} cues inside their scene windows`);

  const failed = checks.filter((c) => c.required && !c.passed);
  return {
    passed: failed.length === 0,
    reason: failed[0]?.id ?? null,
    message: failed[0] ? `${failed[0].label}: ${failed[0].detail}` : null,
    checks,
    metrics: {
      durationSeconds: duration,
      video: probed.video,
      audio: {
        ...probed.audio,
        loudnessLufs: loudness.integratedLufs,
        loudnessRangeLu: loudness.rangeLu,
        truePeakDb: loudness.truePeakDb,
        longestSilenceSeconds:
          silences.length === 0 ? 0 : Math.max(...silences.map((gap) => gap.end - gap.start)),
      },
      scenes: sceneMetrics,
      subtitleCues: produced.subtitleCues,
      blackSegments,
      decodedFully: decoded.ok,
    },
  };
}

function silenceOverlapRatio(gaps: readonly SilenceGap[], start: number, end: number): number {
  const window = end - start;
  if (window <= 0) return 0;
  let covered = 0;
  for (const gap of gaps) {
    const overlap = Math.min(end, gap.end) - Math.max(start, gap.start);
    if (overlap > 0) covered += overlap;
  }
  return Math.min(1, covered / window);
}

function subtitleSyncIssue(scenes: readonly SceneTimeline[], cues: number): string | null {
  const voiced = scenes.filter((s) => s.hasVoiceover);
  if (voiced.length === 0) return 'no voiced scene, so there is nothing to caption';
  // Every voiced scene contributes a caption plus its headline and bullets;
  // a count below the number of voiced scenes means captions were dropped.
  if (cues < voiced.length) return `only ${cues} cues for ${voiced.length} voiced scenes`;
  for (const scene of voiced) {
    if (scene.voiceoverStartSeconds < scene.startSeconds) {
      return `scene ${scene.index} caption starts before the scene`;
    }
    if (scene.voiceoverStartSeconds + scene.voiceoverDurationSeconds > scene.endSeconds + 0.35) {
      return `scene ${scene.index} caption runs past its scene`;
    }
  }
  return null;
}

/** Human-readable one-liner for logs and the UI. */
export function summarizeQuality(report: QualityReport): string {
  const failed = report.checks.filter((c) => c.required && !c.passed);
  if (failed.length === 0) return `all ${report.checks.length} checks passed`;
  return `${failed.length}/${report.checks.length} checks failed: ${failed.map((c) => c.id).join(', ')}`;
}

/** Exposed so callers can report the configured target without importing env. */
export function loudnessTarget(): number {
  return env.VIDEO_LOUDNESS_TARGET_LUFS;
}
