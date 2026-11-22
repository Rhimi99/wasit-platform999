import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MARKETING_VIDEO_DURATION } from '@wasit/shared';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AgentTaskRow, ProductSummary } from '@/lib/types';

const LANGUAGES = ['ar', 'ar-TN', 'fr', 'en', 'zh'] as const;
const AUDIENCES = ['B2B', 'B2C'] as const;
const STYLES = ['MODERN', 'MINIMAL', 'BOLD', 'ELEGANT'] as const;
const OBJECTIVES = ['SALES', 'AWARENESS', 'LAUNCH', 'RETENTION'] as const;

/** Every stage the executor reports, in the order it runs them. */
const STAGES = ['precheck_renderer', 'precheck_voice', 'produce', 'quality_gate', 'read', 'store'] as const;

interface QualityCheck {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  detail: string;
}

interface QualityGate {
  passed: boolean;
  reason: string | null;
  message: string | null;
  checks: QualityCheck[];
  metrics?: {
    durationSeconds: number | null;
    audio: { present: boolean; loudnessLufs: number | null; truePeakDb: number | null };
    scenes: Array<{ index: number; hasVoiceover: boolean; rmsDb: number | null }>;
    subtitleCues: number;
  };
}

interface VoiceLanguage {
  language: string;
  voice: string | null;
  available: boolean;
  reason: string | null;
}

interface VideoAdvice {
  product?: { id: string; name: string };
  plan?: {
    durationSeconds: number;
    language?: string;
    scenes?: Array<{ index: number; kind: string; from: number; to: number; headline: string; voiceover: string }>;
    voiceover?: { voiceId: string | null; locale?: string; reason?: string | null };
    music?: { provider: string; license: string } | null;
  };
  qualityGate?: QualityGate | null;
  render?: { status: string; error?: string; failedChecks?: string[]; provider?: string };
  steps?: Array<{ step: string; ok: boolean; ms: number; detail?: string }>;
  video?: {
    bytes: number;
    durationSeconds: number | null;
    codec: string | null;
    width: number | null;
    height: number | null;
    frames: number | null;
    verified: boolean;
    sha256: string;
  } | null;
  refused?: boolean;
  error?: { code: string; message: string };
  publish?: { available: boolean; reason: string };
}

function parseAdvice(task: AgentTaskRow | null): VideoAdvice | null {
  const advice = (task?.result as { advice?: unknown } | null)?.advice;
  if (typeof advice !== 'string') return null;
  try {
    return JSON.parse(advice) as VideoAdvice;
  } catch {
    return null;
  }
}

/** `awaiting_approval` is terminal for polling: a human must act first. */
const TERMINAL = new Set(['succeeded', 'approved', 'failed', 'rejected', 'awaiting_approval']);

interface TaskSummary {
  id: string;
  agentKey: string;
  status: string;
  createdAt: string;
}

const REFUSAL_KEYS: Record<string, string> = {
  PRODUCT_REQUIRED: 'agentVideo.err.productRequired',
  PRODUCT_NOT_FOUND: 'agentVideo.err.productNotFound',
  PRODUCT_NOT_OWNED: 'agentVideo.err.productNotOwned',
  PRODUCT_NOT_ACTIVE: 'agentVideo.err.productNotActive',
  REQUESTER_REQUIRED: 'agentVideo.err.requesterRequired',
};

export function DashboardAgentVideoPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [active, setActive] = useState<AgentTaskRow | null>(null);

  const [productId, setProductId] = useState('');
  const [voices, setVoices] = useState<VoiceLanguage[]>([]);
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>('ar');
  const [objective, setObjective] = useState<(typeof OBJECTIVES)[number]>('SALES');
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]>('B2B');
  const [style, setStyle] = useState<(typeof STYLES)[number]>('MODERN');
  const [durationSeconds, setDurationSeconds] = useState<number>(MARKETING_VIDEO_DURATION.default);

  const pollTimer = useRef<number | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [p, t2, v] = await Promise.all([
      apiCall(() => api.listMyProducts({ pageSize: 100 })),
      apiCall(() => api.aiMyTasks('marketing-video-agent')),
      apiCall(() => api.aiVoiceCapabilities()),
    ]);
    if (p.data) setProducts(p.data.items.filter((item) => item.status === 'ACTIVE'));
    if (t2.data) setTasks(t2.data.items);
    if (v.data) setVoices(v.data.languages);
    setLoadError(p.error ?? t2.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      alive.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [load]);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = useCallback((taskId: string) => {
    stopPolling();
    pollTimer.current = window.setTimeout(async () => {
      if (!alive.current) return;
      const res = await apiCall(() => api.aiTask(taskId));
      if (!alive.current) return;
      if (!res.data) {
        setActionError(res.error);
        return;
      }
      setActive(res.data);
      setTasks((prev) => prev.map((row) => (row.id === res.data!.id ? res.data! : row)));
      const terminal = TERMINAL.has(res.data.status);
      if (!terminal) poll(taskId);
      else void load();
    }, 3000);
  }, [load]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    if (!productId) {
      setActionError(t('agentVideo.err.pickProduct'));
      return;
    }
    const clamped = Math.min(
      Math.max(Math.round(durationSeconds), MARKETING_VIDEO_DURATION.min),
      MARKETING_VIDEO_DURATION.max,
    );
    setBusy(true);
    try {
      const created = await api.aiCreateAgentTask('marketing-video-agent', {
        productId,
        language,
        objective,
        audience,
        style,
        durationSeconds: clamped,
        render: true,
      });
      const full = await api.aiTask(created.id);
      setActive(full);
      setTasks((prev) => [full, ...prev.filter((row) => row.id !== full.id)]);
      if (!TERMINAL.has(full.status)) poll(full.id);
      else await load();
    } catch (err) {
      const code = err instanceof ApiClientError ? (err.details as { code?: string } | undefined)?.code : undefined;
      const adviceCode = code ?? (err instanceof ApiClientError ? err.code : '');
      const key = REFUSAL_KEYS[adviceCode];
      setActionError(key ? t(key) : err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const open = async (task: TaskSummary) => {
    setActionError(null);
    const res = await apiCall(() => api.aiTask(task.id));
    if (!res.data) {
      setActionError(res.error);
      return;
    }
    setActive(res.data);
    if (!TERMINAL.has(res.data.status)) poll(res.data.id);
  };

  const advice = useMemo(() => parseAdvice(active), [active]);
  const stageState = useMemo(() => {
    const done = new Map((advice?.steps ?? []).map((s) => [s.step, s]));
    return STAGES.map((stage) => {
      const step = done.get(stage);
      const state = step ? (step.ok ? 'ok' : 'failed') : active?.status === 'failed' ? 'skipped' : 'pending';
      return { stage, state, ms: step?.ms ?? null, detail: step?.detail ?? null };
    });
  }, [advice, active]);

  const renderStatus = advice?.render?.status ?? null;
  const completed = active?.status === 'succeeded' || active?.status === 'approved';
  // A file only counts as a video when the gate passed: that is the promise the
  // download button makes to whoever buys the advert.
  const gatePassed = advice?.qualityGate?.passed === true;
  const hasVideo = Boolean(advice?.video) && renderStatus === 'READY' && completed && gatePassed;
  const selectedVoice = voices.find((v) => v.language === language);
  const videoUrl = active ? api.aiTaskVideoUrl(active.id) : '';

  const renderError = useMemo(() => {
    if (!advice) return null;
    if (advice.refused && advice.error) {
      const key = REFUSAL_KEYS[advice.error.code];
      return key ? t(key) : `${advice.error.code}: ${advice.error.message}`;
    }
    if (renderStatus === 'UNAVAILABLE') return advice.render?.error ?? t('agentVideo.err.rendererUnavailable');
    if (renderStatus === 'FAILED') {
      const checks = advice.render?.failedChecks ?? [];
      return checks.length > 0 ? `${t('agentVideo.err.renderFailed')} ${checks.join(' · ')}` : advice.render?.error ?? t('agentVideo.err.renderFailed');
    }
    return null;
  }, [advice, renderStatus, t]);

  if (loading) return <AppLayout><SectionHeader title={t('agentVideo.title')} /><Spinner /></AppLayout>;

  return (
    <AppLayout>
      <SectionHeader title={t('agentVideo.title')} subtitle={t('agentVideo.subtitle')} />

      {loadError && <div className="mb-4"><ErrorState message={loadError} onRetry={() => void load()} /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <form onSubmit={start} className="grid gap-3 sm:grid-cols-2" data-testid="agent-video-form">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="av-product">{t('agentVideo.product')} *</label>
              <select
                id="av-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="input"
                required
                data-testid="agent-video-product"
              >
                <option value="">{t('agentVideo.selectProduct')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.nameAr ?? p.name}</option>
                ))}
              </select>
              {products.length === 0 && <p className="mt-1 text-xs text-amber-600">{t('studio.noProducts')}</p>}
            </div>
            <div>
              <label className="label" htmlFor="av-language">{t('agentVideo.language')}</label>
              <select id="av-language" value={language} onChange={(e) => setLanguage(e.target.value as never)} className="input" data-testid="agent-video-language">
                {LANGUAGES.map((l) => {
                  const entry = voices.find((v) => v.language === l);
                  return <option key={l} value={l}>{l.toUpperCase()}{entry && !entry.available ? ' — ✕' : ''}</option>;
                })}
              </select>
              {selectedVoice && (
                <p
                  className={`mt-1 text-xs ${selectedVoice.available ? 'text-green-700' : 'text-amber-700'}`}
                  data-testid="agent-video-voice-status"
                >
                  {selectedVoice.available
                    ? `${t('agentVideo.voice.available')} · ${selectedVoice.voice}`
                    : `${t('agentVideo.voice.missing')} ${selectedVoice.reason ?? ''}`}
                </p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="av-objective">{t('agentVideo.objective')}</label>
              <select id="av-objective" value={objective} onChange={(e) => setObjective(e.target.value as never)} className="input" data-testid="agent-video-objective">
                {OBJECTIVES.map((o) => <option key={o} value={o}>{t(`agentVideo.objective.${o}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="av-audience">{t('agentVideo.audience')}</label>
              <select id="av-audience" value={audience} onChange={(e) => setAudience(e.target.value as never)} className="input">
                {AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="av-style">{t('agentVideo.style')}</label>
              <select id="av-style" value={style} onChange={(e) => setStyle(e.target.value as never)} className="input">
                {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="av-duration">{t('agentVideo.duration')}</label>
              <input
                id="av-duration"
                type="number"
                min={MARKETING_VIDEO_DURATION.min}
                max={MARKETING_VIDEO_DURATION.max}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value) || MARKETING_VIDEO_DURATION.default)}
                className="input"
                data-testid="agent-video-duration"
              />
              <p className="mt-1 text-xs text-slate-500" data-testid="agent-video-duration-hint">
                {MARKETING_VIDEO_DURATION.min}–{MARKETING_VIDEO_DURATION.max}s
              </p>
            </div>
            <button
              type="submit"
              disabled={busy || products.length === 0 || (selectedVoice ? !selectedVoice.available : false)}
              className="btn-primary sm:col-span-2"
              data-testid="agent-video-start"
            >
              {busy ? t('agentVideo.starting') : t('agentVideo.start')}
            </button>
          </form>
          <p className="mt-3 text-xs text-slate-500">{t('agentVideo.noPublish')}</p>
          {actionError && <p className="mt-3 text-sm text-red-600" role="alert" data-testid="agent-video-error">{actionError}</p>}
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('agentVideo.runTitle')}</h3>
          {!active ? (
            <EmptyState title={t('agentVideo.noRun')} hint={t('agentVideo.noRunHint')} />
          ) : (
            <div className="space-y-3" data-testid="agent-video-run">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  color={completed ? 'green' : active.status === 'failed' || active.status === 'rejected' ? 'red' : 'amber'}
                  testId="agent-video-status"
                >
                  {t(`agentVideo.status.${active.status}`)}
                </Badge>
                <span className="text-[11px] text-slate-400">{active.createdAt}</span>
              </div>

              <ol className="space-y-1" data-testid="agent-video-stages">
                {stageState.map(({ stage, state, ms, detail }) => (
                  <li key={stage} className="flex items-start gap-2 text-xs">
                    <span aria-hidden className={state === 'ok' ? 'text-green-600' : state === 'failed' ? 'text-red-600' : 'text-slate-400'}>
                      {state === 'ok' ? '●' : state === 'failed' ? '✕' : '○'}
                    </span>
                    <span className="flex-1 text-slate-600">
                      {t(`agentVideo.stage.${stage}`)}
                      {ms !== null && <span className="ml-1 text-slate-400">({ms} ms)</span>}
                      {detail && state === 'failed' && <span className="block text-red-600">{detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>

              {active.status === 'awaiting_approval' && (
                <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800" data-testid="agent-video-approval">
                  <p>{t('agentVideo.awaitingApproval')}</p>
                  <button type="button" onClick={() => void open(active)} className="mt-1 underline">
                    {t('agentVideo.refresh')}
                  </button>
                </div>
              )}

              {renderError && (
                <p className="rounded-md bg-red-50 p-2 text-xs text-red-700" role="alert" data-testid="agent-video-render-error">{renderError}</p>
              )}

              {hasVideo && advice?.video && (
                <div className="space-y-2" data-testid="agent-video-result">
                  <video
                    key={active.id}
                    src={videoUrl}
                    controls
                    preload="metadata"
                    className="w-full rounded-md bg-slate-900"
                    data-testid="agent-video-preview"
                  />
                  <p className="text-[11px] text-slate-500" data-testid="agent-video-facts">
                    {advice.video.durationSeconds}s · {advice.video.codec} · {advice.video.width}×{advice.video.height} ·{' '}
                    {(advice.video.bytes / 1024).toFixed(0)} KB · {advice.video.verified ? t('agentVideo.verified') : t('agentVideo.unverified')}
                  </p>
                  <a
                    href={api.aiTaskVideoUrl(active.id, true)}
                    download
                    className="inline-block rounded bg-wasit-600 px-3 py-1.5 text-xs text-white hover:bg-wasit-700"
                    data-testid="agent-video-download"
                  >
                    {t('agentVideo.download')}
                  </a>
                </div>
              )}

              {advice?.qualityGate && (
                <div className="rounded-md border border-slate-200 p-2" data-testid="agent-video-gate">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-slate-700">{t('agentVideo.gate.title')}</h4>
                    <Badge color={advice.qualityGate.passed ? 'green' : 'red'} testId="agent-video-gate-status">
                      {advice.qualityGate.passed ? t('agentVideo.gate.passed') : t('agentVideo.gate.failed')}
                    </Badge>
                  </div>
                  {advice.qualityGate.metrics && (
                    <p className="mt-1 text-[11px] text-slate-500" data-testid="agent-video-gate-metrics">
                      {t('agentVideo.gate.loudness')}: {advice.qualityGate.metrics.audio.loudnessLufs ?? '—'} LUFS ·{' '}
                      {t('agentVideo.gate.scenes')}: {advice.qualityGate.metrics.scenes.filter((s) => s.hasVoiceover).length}/
                      {advice.qualityGate.metrics.scenes.length} · {t('agentVideo.gate.cues')}: {advice.qualityGate.metrics.subtitleCues}
                    </p>
                  )}
                  <ul className="mt-1 space-y-0.5">
                    {advice.qualityGate.checks.map((check) => (
                      <li key={check.id} className="flex items-start gap-1.5 text-[11px]">
                        <span aria-hidden className={check.passed ? 'text-green-600' : 'text-red-600'}>{check.passed ? '●' : '✕'}</span>
                        <span className="flex-1 text-slate-600">
                          {check.label}
                          {!check.passed && <span className="block text-red-600">{check.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!advice.qualityGate.passed && (
                    <p className="mt-1 text-[11px] text-red-700" data-testid="agent-video-gate-withheld">
                      {t('agentVideo.gate.withheld')}
                    </p>
                  )}
                </div>
              )}

              {advice?.plan?.scenes && advice.plan.scenes.length > 0 && (
                <details className="text-xs text-slate-600">
                  <summary className="cursor-pointer font-medium">{t('agentVideo.script')}</summary>
                  <ol className="mt-1 list-decimal space-y-1 ps-4" data-testid="agent-video-scenes">
                    {advice.plan.scenes.map((scene) => (
                      <li key={scene.index}>
                        <span className="text-slate-400">[{scene.kind}]</span> {scene.headline}
                        <span className="block text-slate-500">{scene.voiceover}</span>
                      </li>
                    ))}
                  </ol>
                  {advice.plan.voiceover && (
                    <p className="mt-1 text-[11px] text-slate-500" data-testid="agent-video-voice">
                      {t('agentVideo.voice.title')}: {advice.plan.voiceover.voiceId ?? advice.plan.voiceover.reason ?? '—'}
                    </p>
                  )}
                  {advice.plan.music && (
                    <p className="text-[11px] text-slate-500">{advice.plan.music.license}</p>
                  )}
                </details>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('agentVideo.history')}</h3>
        {tasks.length === 0 ? (
          <EmptyState title={t('agentVideo.historyEmpty')} />
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="agent-video-history">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <button
                  type="button"
                  onClick={() => void open(task)}
                  className="text-start text-slate-700 hover:text-wasit-700"
                  data-testid={`agent-video-task-${task.id}`}
                >
                  {task.createdAt}
                </button>
                <Badge color={task.status === 'succeeded' || task.status === 'approved' ? 'green' : task.status === 'failed' ? 'red' : 'amber'}>
                  {t(`agentVideo.status.${task.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppLayout>
  );
}
