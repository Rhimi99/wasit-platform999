import { useEffect, useMemo, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, Spinner } from '@/components/ui';
import type { AiSpendGuard, AiSpendLimitRow, AiSpendOverview } from '@/lib/types';

/**
 * AI consumption and spend control (AI-05).
 *
 * Everything shown here is read from recorded request rows. The panel never
 * receives a prompt, a key or a customer record — only counts, tokens and money,
 * labelled as vendor-reported or catalogue-estimated.
 */
const WINDOWS = [
  { days: 1, key: 'adminAi.spend.window.today' },
  { days: 7, key: 'adminAi.spend.window.week' },
  { days: 30, key: 'adminAi.spend.window.month' },
];

const STATE_COLOR: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  OK: 'green',
  WARNING: 'amber',
  BLOCKED: 'red',
};

function money(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toFixed(n === 0 ? 2 : 4);
}

export function AiSpendPanel({ environment }: { environment?: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<AiSpendOverview | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState<AiSpendGuard | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [guardNotice, setGuardNotice] = useState<string | null>(null);
  const [guardDraft, setGuardDraft] = useState({ dailyMaxCost: '', monthlyMaxCost: '', currencyCode: 'USD' });
  const [draft, setDraft] = useState({
    scope: 'PROVIDER' as 'GLOBAL' | 'PROVIDER' | 'AGENT',
    targetKey: '',
    period: 'MONTHLY' as 'DAILY' | 'MONTHLY',
    maxCost: '',
    maxRequests: '',
    warnRatio: '0.8',
  });

  const load = async () => {
    setError(null);
    // No environment means "the one this server manages"; the response names it.
    const res = await apiCall(() => api.adminAiSpend({ days, environment }));
    if (res.data) setData(res.data);
    setError(res.error ?? null);
    const guardRes = await apiCall(() => api.adminAiSpendGuard(environment));
    if (guardRes.data) {
      setGuard(guardRes.data);
      setGuardDraft((d) => ({
        dailyMaxCost: d.dailyMaxCost || (guardRes.data?.caps.daily?.maxCost ?? ''),
        monthlyMaxCost: d.monthlyMaxCost || (guardRes.data?.caps.monthly?.maxCost ?? ''),
        currencyCode: guardRes.data?.caps.daily?.currencyCode ?? d.currencyCode,
      }));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [days, environment]);

  const limitRows = useMemo(() => data?.limits ?? [], [data]);

  async function createLimit() {
    setBusy(true);
    setNotice(null);
    const res = await apiCall(() =>
      api.adminUpsertAiSpendLimit({
        environment: environment ?? data?.environment,
        scope: draft.scope,
        targetKey: draft.scope === 'GLOBAL' ? '' : draft.targetKey.trim(),
        period: draft.period,
        maxCost: draft.maxCost.trim() === '' ? null : draft.maxCost.trim(),
        maxRequests: draft.maxRequests.trim() === '' ? null : Number(draft.maxRequests),
        warnRatio: draft.warnRatio,
      }),
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(t('adminAi.spend.limitSaved'));
    setDraft((d) => ({ ...d, targetKey: '', maxCost: '', maxRequests: '' }));
    await load();
  }

  async function saveGuard() {
    setGuardBusy(true);
    setGuardError(null);
    setGuardNotice(null);
    const res = await apiCall(() =>
      api.adminSetAiSpendGuard({
        environment: environment ?? data?.environment,
        dailyMaxCost: guardDraft.dailyMaxCost.trim(),
        monthlyMaxCost: guardDraft.monthlyMaxCost.trim(),
        currencyCode: guardDraft.currencyCode.trim().toUpperCase(),
      }),
    );
    setGuardBusy(false);
    if (res.error || !res.data) {
      setGuardError(res.error ?? t('adminAi.spend.guard.saveFailed'));
      return;
    }
    setGuard(res.data);
    setGuardNotice(t('adminAi.spend.guard.saved'));
  }

  async function removeLimit(row: AiSpendLimitRow) {
    setBusy(true);
    const res = await apiCall(() => api.adminDeleteAiSpendLimit(row.id));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(t('adminAi.spend.limitDeleted'));
    await load();
  }

  if (loading) return <Spinner />;
  if (error && !data) return <ErrorState message={error} />;
  if (!data) return <EmptyState title={t('adminAi.spend.empty')} />;

  return (
    <div className="space-y-4" data-testid="ai-spend-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border border-slate-200 p-0.5" role="group">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${days === w.days ? 'bg-wasit-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              {t(w.key)}
            </button>
          ))}
        </div>
        <Badge color="slate">{t('adminAi.spend.environment')}: {data.environment}</Badge>
        <span className="text-xs text-slate-500">
          {formatDate(data.from)} → {formatDate(data.to)}
        </span>
      </div>

      {notice && <p className="text-xs text-emerald-700" role="status">{notice}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{t('adminAi.spend.guard.title')}</h3>
            <p className="max-w-3xl text-xs text-slate-500">{t('adminAi.spend.guard.hint')}</p>
          </div>
          <Badge color={guard?.ready ? 'green' : 'red'} testId="ai-spend-guard-state">
            {guard?.ready ? t('adminAi.spend.guard.ready') : t('adminAi.spend.guard.notReady')}
          </Badge>
        </div>

        {guard && (
          <>
            <p className="mt-2 text-xs text-slate-600" data-testid="ai-spend-guard-detail">
              {guard.ready
                ? `${t('adminAi.spend.guard.daily')}: ${money(guard.caps.daily?.maxCost ?? '0')} ${guard.caps.daily?.currencyCode ?? ''} · ${t('adminAi.spend.guard.monthly')}: ${money(guard.caps.monthly?.maxCost ?? '0')} ${guard.caps.monthly?.currencyCode ?? ''}`
                : `${t('adminAi.spend.guard.missing')} ${guard.missing
                    .map((p) => t(`adminAi.spend.guard.period.${p}`))
                    .join(' + ')}`}
            </p>

            <ul className="mt-2 space-y-1 text-xs">
              {guard.providers
                .filter((p) => p.paid)
                .map((p) => (
                  <li key={p.key} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{p.key}</span>
                    <Badge color={p.enabled ? 'green' : 'slate'}>
                      {p.enabled ? t('adminAi.spend.guard.providerEnabled') : t('adminAi.spend.guard.providerDisabled')}
                    </Badge>
                    {p.isDefault && <Badge color="amber">{t('adminAi.spend.guard.providerDefault')}</Badge>}
                    <span className="text-slate-500">
                      {t('adminAi.spend.guard.key')}: {p.keySource}
                    </span>
                  </li>
                ))}
            </ul>

            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <input
                className="input-base"
                inputMode="decimal"
                placeholder={t('adminAi.spend.guard.daily')}
                value={guardDraft.dailyMaxCost}
                onChange={(e) => setGuardDraft((d) => ({ ...d, dailyMaxCost: e.target.value }))}
                data-testid="ai-spend-guard-daily"
              />
              <input
                className="input-base"
                inputMode="decimal"
                placeholder={t('adminAi.spend.guard.monthly')}
                value={guardDraft.monthlyMaxCost}
                onChange={(e) => setGuardDraft((d) => ({ ...d, monthlyMaxCost: e.target.value }))}
                data-testid="ai-spend-guard-monthly"
              />
              <input
                className="input-base"
                maxLength={3}
                placeholder="USD"
                value={guardDraft.currencyCode}
                onChange={(e) => setGuardDraft((d) => ({ ...d, currencyCode: e.target.value.toUpperCase() }))}
                aria-label={t('adminAi.spend.guard.currency')}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={guardBusy || !guardDraft.dailyMaxCost.trim() || !guardDraft.monthlyMaxCost.trim()}
                onClick={() => void saveGuard()}
                data-testid="ai-spend-guard-save"
              >
                {t('adminAi.spend.guard.save')}
              </button>
            </div>
            {guardError && <p className="mt-2 text-xs text-red-700">{guardError}</p>}
            {guardNotice && (
              <p className="mt-2 text-xs text-emerald-700" role="status">
                {guardNotice}
              </p>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-slate-500">{t('adminAi.spend.requests')}</p>
          <p className="mt-1 text-2xl font-semibold" data-testid="ai-spend-requests">{data.totals.requests}</p>
          <p className="text-xs text-slate-500">
            {t('adminAi.spend.succeeded')}: {data.totals.succeeded} · {t('adminAi.spend.failed')}: {data.totals.failed}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('adminAi.spend.estimatedCost')}</p>
          <p className="mt-1 text-2xl font-semibold" data-testid="ai-spend-estimated">{money(data.totals.estimatedCost)}</p>
          <p className="text-xs text-slate-500">{t('adminAi.spend.estimatedHint')}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('adminAi.spend.vendorCost')}</p>
          <p className="mt-1 text-2xl font-semibold" data-testid="ai-spend-vendor">{money(data.totals.vendorCost)}</p>
          <p className="text-xs text-slate-500">{t('adminAi.spend.vendorHint')}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('adminAi.spend.tokens')}</p>
          <p className="mt-1 text-2xl font-semibold">
            {data.totals.tokensInput + data.totals.tokensOutput}
          </p>
          <p className="text-xs text-slate-500">
            {t('adminAi.spend.localRequests')}: {data.totals.localRequests} · {t('adminAi.spend.unknownCost')}:{' '}
            {data.totals.unknownCostRequests}
          </p>
        </Card>
      </div>

      <Card>
        <h3 className="mb-2 text-sm font-semibold">{t('adminAi.spend.byAgent')}</h3>
        {data.byAgent.length === 0 ? (
          <p className="text-xs text-slate-500">{t('adminAi.spend.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminAi.spend.agent')}</th>
                  <th>{t('adminAi.spend.provider')}</th>
                  <th>{t('adminAi.spend.model')}</th>
                  <th>{t('adminAi.spend.requests')}</th>
                  <th>{t('adminAi.spend.failed')}</th>
                  <th>{t('adminAi.spend.tokens')}</th>
                  <th>{t('adminAi.spend.estimatedCost')}</th>
                  <th>{t('adminAi.spend.vendorCost')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byAgent.map((row, i) => (
                  <tr key={`${row.agentKey}-${row.providerKey}-${row.vendorModel}-${i}`}>
                    <td className="font-mono text-xs">{row.agentKey}</td>
                    <td>{row.providerKey}</td>
                    <td className="font-mono text-xs">{row.vendorModel}</td>
                    <td>{row.requests}</td>
                    <td>{row.failed}</td>
                    <td>{row.tokensInput + row.tokensOutput}</td>
                    <td>{money(row.estimatedCost)}</td>
                    <td>{money(row.vendorCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-semibold">{t('adminAi.spend.byProvider')}</h3>
        {data.byProviderModel.length === 0 ? (
          <p className="text-xs text-slate-500">{t('adminAi.spend.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminAi.spend.provider')}</th>
                  <th>{t('adminAi.spend.model')}</th>
                  <th>{t('adminAi.spend.environment')}</th>
                  <th>{t('adminAi.spend.requests')}</th>
                  <th>{t('adminAi.spend.failed')}</th>
                  <th>{t('adminAi.spend.tokens')}</th>
                  <th>{t('adminAi.spend.estimatedCost')}</th>
                  <th>{t('adminAi.spend.vendorCost')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byProviderModel.map((row, i) => (
                  <tr key={`${row.providerKey}-${row.vendorModel}-${row.environment}-${i}`}>
                    <td>{row.providerKey}</td>
                    <td className="font-mono text-xs">{row.vendorModel}</td>
                    <td>{row.environment}</td>
                    <td>{row.requests}</td>
                    <td>{row.failed}</td>
                    <td>{row.tokensInput + row.tokensOutput}</td>
                    <td>{money(row.estimatedCost)}</td>
                    <td>{money(row.vendorCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-1 text-sm font-semibold">{t('adminAi.spend.limits')}</h3>
        <p className="mb-2 text-xs text-slate-500">{t('adminAi.spend.limitsHint')}</p>
        {limitRows.length === 0 ? (
          <p className="text-xs text-slate-500" data-testid="ai-spend-no-limits">{t('adminAi.spend.noLimits')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminAi.spend.scope')}</th>
                  <th>{t('adminAi.spend.target')}</th>
                  <th>{t('adminAi.spend.period')}</th>
                  <th>{t('adminAi.spend.spent')}</th>
                  <th>{t('adminAi.spend.cap')}</th>
                  <th>{t('adminAi.spend.state')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {limitRows.map((row) => (
                  <tr key={row.id} data-testid={`ai-spend-limit-${row.id}`}>
                    <td>{t(`adminAi.spend.scopeValue.${row.scope}`)}</td>
                    <td className="font-mono text-xs">{row.targetKey || '—'}</td>
                    <td>{t(`adminAi.spend.periodValue.${row.period}`)}</td>
                    <td>
                      {money(row.spent)} {row.currencyCode} ({row.requests})
                    </td>
                    <td>
                      {row.maxCost ? `${money(row.maxCost)} ${row.currencyCode}` : '—'}
                      {row.maxRequests !== null ? ` / ${row.maxRequests}` : ''}
                    </td>
                    <td>
                      <Badge color={STATE_COLOR[row.state] ?? 'slate'}>{t(`adminAi.spend.stateValue.${row.state}`)}</Badge>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-xs text-red-700 hover:underline"
                        disabled={busy}
                        onClick={() => void removeLimit(row)}
                      >
                        {t('adminAi.spend.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-6">
          <select
            className="input-base"
            value={draft.scope}
            onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as typeof d.scope }))}
            aria-label={t('adminAi.spend.scope')}
          >
            <option value="GLOBAL">{t('adminAi.spend.scopeValue.GLOBAL')}</option>
            <option value="PROVIDER">{t('adminAi.spend.scopeValue.PROVIDER')}</option>
            <option value="AGENT">{t('adminAi.spend.scopeValue.AGENT')}</option>
          </select>
          <input
            className="input-base"
            placeholder={t('adminAi.spend.target')}
            value={draft.targetKey}
            disabled={draft.scope === 'GLOBAL'}
            onChange={(e) => setDraft((d) => ({ ...d, targetKey: e.target.value }))}
          />
          <select
            className="input-base"
            value={draft.period}
            onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value as typeof d.period }))}
            aria-label={t('adminAi.spend.period')}
          >
            <option value="DAILY">{t('adminAi.spend.periodValue.DAILY')}</option>
            <option value="MONTHLY">{t('adminAi.spend.periodValue.MONTHLY')}</option>
          </select>
          <input
            className="input-base"
            inputMode="decimal"
            placeholder={t('adminAi.spend.cap')}
            value={draft.maxCost}
            onChange={(e) => setDraft((d) => ({ ...d, maxCost: e.target.value }))}
          />
          <input
            className="input-base"
            inputMode="numeric"
            placeholder={t('adminAi.spend.maxRequests')}
            value={draft.maxRequests}
            onChange={(e) => setDraft((d) => ({ ...d, maxRequests: e.target.value }))}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void createLimit()}
            data-testid="ai-spend-add-limit"
          >
            {t('adminAi.spend.addLimit')}
          </button>
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-semibold">{t('adminAi.spend.alerts')}</h3>
        {data.alerts.length === 0 ? (
          <p className="text-xs text-slate-500">{t('adminAi.spend.noAlerts')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge color={a.level === 'BLOCKED' ? 'red' : 'amber'}>
                  {t(`adminAi.spend.levelValue.${a.level}`)}
                </Badge>
                <span className="font-mono">{a.scope}:{a.targetKey || '—'}</span>
                <span>
                  {money(a.spent)}
                  {a.limitAmount ? ` / ${money(a.limitAmount)}` : ''} {a.currencyCode}
                </span>
                <span className="text-slate-500">{a.period}</span>
                <span className="text-slate-500">{formatDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
