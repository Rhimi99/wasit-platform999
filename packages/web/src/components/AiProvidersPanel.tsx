import { useEffect, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, ErrorState, Spinner } from '@/components/ui';
import type { AiAdminModel, AiProviderList, AiProviderRow, AiProviderTestResult } from '@/lib/types';

/**
 * AI provider administration (AI-04).
 *
 * The panel only ever receives a description of a key — presence, source and a
 * short fingerprint. There is no field that can read a key back, because the
 * server never returns one.
 */
const TEST_COLOR: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'teal'> = {
  OK: 'green',
  CONFIG_ONLY: 'teal',
  FAILED: 'red',
  BLOCKED: 'amber',
  NEVER: 'slate',
};

export function AiProvidersPanel({ catalogue }: { catalogue: AiAdminModel[] }) {
  const { t } = useI18n();
  const [data, setData] = useState<AiProviderList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { model: string; baseUrl: string; keyEnvVar: string }>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, AiProviderTestResult>>({});

  const load = async () => {
    setError(null);
    const res = await apiCall(() => api.adminAiProviders());
    if (res.data) {
      setData(res.data);
      setDrafts(
        Object.fromEntries(
          res.data.items.map((p) => [
            p.key,
            { model: p.model ?? '', baseUrl: p.baseUrl ?? '', keyEnvVar: p.keyState.envVar ?? '' },
          ]),
        ),
      );
    }
    setError(res.error ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  async function run(key: string, fn: () => Promise<unknown>, doneKey: string) {
    setBusy(key);
    setNotice(null);
    const res = await apiCall(fn as () => Promise<unknown>);
    setBusy(null);
    if (res.error) {
      setError(res.error);
      return false;
    }
    setNotice(t(doneKey));
    await load();
    return true;
  }

  function patch(key: string, body: Parameters<typeof api.adminUpdateAiProvider>[1]) {
    return run(key, () => api.adminUpdateAiProvider(key, body), 'adminAi.providers.saved');
  }

  async function saveSecret(provider: AiProviderRow) {
    const value = (secrets[provider.key] ?? '').trim();
    if (!value) return;
    const ok = await run(provider.key, () => api.adminSetAiProviderSecret(provider.key, value), 'adminAi.providers.keySaved');
    if (ok) setSecrets((s) => ({ ...s, [provider.key]: '' }));
  }

  async function test(provider: AiProviderRow, mode: 'CONFIG' | 'LIVE') {
    setBusy(`${provider.key}:${mode}`);
    setNotice(null);
    const res = await apiCall(() => api.adminTestAiProvider(provider.key, mode));
    setBusy(null);
    if (res.data) {
      setResults((r) => ({ ...r, [provider.key]: res.data as AiProviderTestResult }));
      await load();
    }
    setError(res.error ?? null);
  }

  if (loading) return <Spinner />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge color="indigo">{t('adminAi.providers.environment')}: {data.environment}</Badge>
          <Badge color={data.secretStorage.available ? 'green' : 'amber'}>
            {data.secretStorage.available
              ? t('adminAi.providers.secretStorageOn')
              : t('adminAi.providers.secretStorageOff')}
          </Badge>
          <Badge color={data.liveTestAllowed ? 'green' : 'slate'}>
            {data.liveTestAllowed ? t('adminAi.providers.liveTestOn') : t('adminAi.providers.liveTestOff')}
          </Badge>
          <span className="text-slate-500">{t('adminAi.providers.hint')}</span>
        </div>
      </Card>

      {notice && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {data.items.map((p) => {
        const draft = drafts[p.key] ?? { model: p.model ?? '', baseUrl: p.baseUrl ?? '', keyEnvVar: p.keyState.envVar ?? '' };
        const modelsForProvider = catalogue.filter((m) =>
          p.key === 'local-heuristic' ? m.provider === 'local' || m.provider === 'local-heuristic' : m.provider === p.key,
        );
        const result = results[p.key];
        const lastTest = p.lastTest;
        return (
          <Card key={p.key} testId={`ai-provider-${p.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{p.displayName}</h3>
                  <Badge color={p.kind === 'vendor' ? 'indigo' : p.kind === 'local' ? 'teal' : 'slate'}>{p.kind}</Badge>
                  <Badge color={p.enabled || p.activeFromEnv ? 'green' : 'slate'}>
                    {p.enabled || p.activeFromEnv ? t('common.active') : t('common.inactive')}
                  </Badge>
                  {p.activeFromEnv && <Badge color="amber">{t('adminAi.providers.activeFromEnv')}</Badge>}
                  {p.isDefault && <Badge color="indigo">{t('adminAi.providers.roleDefault')}</Badge>}
                  {p.isFallback && <Badge color="amber">{t('adminAi.providers.roleFallback')}</Badge>}
                  <Badge color={p.keyState.present ? 'green' : 'red'}>
                    {p.keyState.present
                      ? `${t('adminAi.providers.keyPresent')} · ${p.keyState.source}`
                      : t('adminAi.providers.keyMissing')}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {p.keyState.fingerprint
                    ? `${t('adminAi.providers.fingerprint')}: ${p.keyState.fingerprint}`
                    : p.keyState.envVar
                      ? `${t('adminAi.providers.envVar')}: ${p.keyState.envVar}`
                      : t('adminAi.providers.noKeySource')}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void patch(p.key, { enabled: !p.enabled })}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {p.enabled ? t('common.deactivate') : t('common.activate')}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void patch(p.key, { role: p.isDefault ? 'NONE' : 'DEFAULT' })}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {p.isDefault ? t('adminAi.providers.clearDefault') : t('adminAi.providers.makeDefault')}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void patch(p.key, { role: p.isFallback ? 'NONE' : 'FALLBACK' })}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {p.isFallback ? t('adminAi.providers.clearFallback') : t('adminAi.providers.makeFallback')}
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <label className="text-xs text-slate-600">
                {t('adminAi.providers.model')}
                <select
                  value={draft.model}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: { ...draft, model: e.target.value } }))}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">—</option>
                  {modelsForProvider.map((m) => (
                    <option key={m.key} value={m.key}>{m.displayName} ({m.key})</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600">
                {t('adminAi.providers.baseUrl')}
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: { ...draft, baseUrl: e.target.value } }))}
                  placeholder="https://api.example.com/v1"
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-slate-600">
                {t('adminAi.providers.envVar')}
                <input
                  value={draft.keyEnvVar}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: { ...draft, keyEnvVar: e.target.value } }))}
                  placeholder="AI_OPENAI_API_KEY"
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void patch(p.key, {
                    model: draft.model || undefined,
                    baseUrl: draft.baseUrl.trim() === '' ? null : draft.baseUrl.trim(),
                    keyEnvVar: draft.keyEnvVar.trim() === '' ? null : draft.keyEnvVar.trim(),
                  })
                }
                className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            </div>

            {p.requiresKey && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 text-xs text-slate-600">
                    {t('adminAi.providers.newKey')}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={secrets[p.key] ?? ''}
                      onChange={(e) => setSecrets((s) => ({ ...s, [p.key]: e.target.value }))}
                      placeholder="sk-…"
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy !== null || !(secrets[p.key] ?? '').trim() || !data.secretStorage.available}
                    onClick={() => void saveSecret(p)}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {t('adminAi.providers.saveKey')}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null || p.keyState.source !== 'DB'}
                    onClick={() => void run(p.key, () => api.adminClearAiProviderSecret(p.key), 'adminAi.providers.keyRemoved')}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 disabled:opacity-50"
                  >
                    {t('adminAi.providers.removeKey')}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{t('adminAi.providers.keyHint')}</p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void test(p, 'CONFIG')}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {t('adminAi.providers.testConfig')}
              </button>
              <button
                type="button"
                disabled={busy !== null || !data.liveTestAllowed}
                onClick={() => void test(p, 'LIVE')}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {t('adminAi.providers.testLive')}
              </button>
              <Badge color={TEST_COLOR[lastTest.status] ?? 'slate'}>
                {t('adminAi.providers.lastTest')}: {lastTest.status}
                {lastTest.testedAt ? ` · ${new Date(lastTest.testedAt).toLocaleString()}` : ''}
              </Badge>
            </div>

            {result && (
              <ul className="mt-2 space-y-1 text-[11px]">
                {result.checks.map((c) => (
                  <li key={c.id} className={c.ok ? 'text-emerald-700' : 'text-red-700'}>
                    {c.ok ? '✓' : '✗'} {c.id}: {c.detail}
                  </li>
                ))}
              </ul>
            )}

            {p.usage && (
              <div className="mt-3 grid gap-2 text-[11px] text-slate-600 md:grid-cols-4">
                <div>{t('adminAi.providers.usageRequests')}: <strong>{p.usage.requests}</strong></div>
                <div>{t('adminAi.providers.usageTokens')}: <strong>{p.usage.tokensInput + p.usage.tokensOutput}</strong></div>
                <div>{t('adminAi.providers.usageCost')}: <strong>{p.usage.cost}</strong></div>
                <div>{t('adminAi.providers.usageAgents')}: <strong>{p.usage.agents.length}</strong></div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
