import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminDisputePolicy, AdminRetentionPolicy, CountryPolicyGap } from '@/lib/types';

type CountryOption = { id: string; code: string; name: string; nameAr: string | null; isActive: boolean };
type AdminCountry = {
  id: string; code: string; name: string; nameAr: string | null; currencyCode: string;
  defaultLanguage: string; isActive: boolean; activatedAt: string | null;
};

const NUMERIC_FIELDS = [
  'openWindowDays',
  'evidenceDeadlineDays',
  'decisionDeadlineDays',
  'appealWindowDays',
  'maxAppeals',
  'autoEscalateDays',
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];
type RulesDraft = Partial<Record<NumericField, string>>;

export function AdminPoliciesPage() {
  const { t } = useI18n();
  const [policies, setPolicies] = useState<AdminDisputePolicy[]>([]);
  const [gaps, setGaps] = useState<CountryPolicyGap[]>([]);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [marketRows, setMarketRows] = useState<AdminCountry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<RulesDraft>({});
  const [marketReason, setMarketReason] = useState<Record<string, string>>({});

  // Data-retention policy editor (privacy retention window, per country).
  const [retentionRows, setRetentionRows] = useState<AdminRetentionPolicy[]>([]);
  const [retentionGaps, setRetentionGaps] = useState<CountryPolicyGap[]>([]);
  const [retentionTarget, setRetentionTarget] = useState<string>('');
  const [retentionDays, setRetentionDays] = useState('');
  const [retentionPreserves, setRetentionPreserves] = useState('');
  const [retentionReason, setRetentionReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [policyRes, countryRes, retentionRes] = await Promise.all([
      apiCall(() => api.adminDisputePolicies()),
      apiCall(() => api.listAdminCountries()),
      apiCall(() => api.adminRetentionPolicies()),
    ]);
    setLoading(false);
    if (policyRes.error) {
      setError(policyRes.error);
      return;
    }
    setPolicies(policyRes.data!.items);
    setGaps(policyRes.data!.gaps);
    setCountries(policyRes.data!.countries);
    if (countryRes.data) setMarketRows(countryRes.data.items);
    if (retentionRes.data) {
      setRetentionRows(retentionRes.data.items);
      setRetentionGaps(retentionRes.data.gaps);
    }
  }, []);

  async function toggleMarket(country: AdminCountry) {
    setError(null);
    setInfo(null);
    const reasonText = (marketReason[country.id] ?? '').trim();
    if (reasonText.length < 5) {
      setError(t('markets.reasonRequired'));
      return;
    }
    const res = await apiCall(() =>
      api.setCountryActivation(country.id, { isActive: !country.isActive, reason: reasonText }),
    );
    if (res.error) {
      setError(res.error);
      return;
    }
    setInfo(country.isActive ? t('markets.deactivated') : t('markets.activated'));
    setMarketReason((m) => ({ ...m, [country.id]: '' }));
    load();
  }

  useEffect(() => {
    load();
  }, [load]);

  function selectTarget(countryId: string) {
    setTarget(countryId);
    setInfo(null);
    const existing = policies.find((p) => p.countryId === (countryId || null));
    const rules = (existing?.rules ?? {}) as Record<string, number>;
    const next: RulesDraft = {};
    for (const field of NUMERIC_FIELDS) {
      next[field] = rules[field] !== undefined ? String(rules[field]) : '';
    }
    setDraft(next);
  }

  async function save() {
    setError(null);
    setInfo(null);
    const rules: Record<string, number> = {};
    for (const field of NUMERIC_FIELDS) {
      const raw = draft[field]?.trim();
      if (raw) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          setError(`${field}: ${t('policies.invalidNumber')}`);
          return;
        }
        rules[field] = n;
      }
    }
    if (Object.keys(rules).length === 0) {
      setError(t('policies.noRules'));
      return;
    }
    if (reason.trim().length < 5) {
      setError(t('policies.reasonRequired'));
      return;
    }
    const countryId = target || null;
    const existing = policies.find((p) => p.countryId === countryId);
    const res = await apiCall(() =>
      api.saveAdminDisputePolicy({
        countryId,
        name: existing?.name ?? (countryId ? `Dispute Policy ${countries.find((c) => c.id === countryId)?.code ?? ''}` : 'Global Dispute Resolution Policy'),
        description: existing?.description ?? null,
        rules,
        reason: reason.trim(),
      }),
    );
    if (res.error) {
      setError(res.error);
      return;
    }
    setInfo(res.data!.created ? t('policies.created') : t('policies.updated'));
    setReason('');
    load();
  }

  function selectRetentionTarget(countryId: string) {
    setRetentionTarget(countryId);
    setInfo(null);
    const existing = retentionRows.find((p) => p.countryId === (countryId || null));
    const rules = (existing?.rules ?? {}) as Record<string, unknown>;
    setRetentionDays(rules.defaultRetentionDays !== undefined ? String(rules.defaultRetentionDays) : '');
    setRetentionPreserves(Array.isArray(rules.preserves) ? (rules.preserves as string[]).join(', ') : '');
  }

  async function saveRetention() {
    setError(null);
    setInfo(null);
    const days = retentionDays.trim();
    if (days) {
      const n = Number(days);
      if (!Number.isInteger(n) || n <= 0 || n > 3650) {
        setError(`${t('policies.field.defaultRetentionDays')}: ${t('policies.invalidNumber')}`);
        return;
      }
    }
    if (retentionReason.trim().length < 5) {
      setError(t('policies.reasonRequired'));
      return;
    }
    const countryId = retentionTarget || null;
    const existing = retentionRows.find((p) => p.countryId === countryId);
    const preserves = retentionPreserves
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rules: { defaultRetentionDays?: number; legalHoldFinanciallyRequired?: boolean; preserves?: string[] } = {
      legalHoldFinanciallyRequired: true,
    };
    if (days) rules.defaultRetentionDays = Number(days);
    if (preserves.length) rules.preserves = preserves;
    const res = await apiCall(() =>
      api.saveAdminRetentionPolicy({
        countryId,
        name:
          existing?.name ??
          (countryId
            ? `Retention Policy ${countries.find((c) => c.id === countryId)?.code ?? ''}`
            : 'Global Data Retention Policy'),
        description: existing?.description ?? null,
        rules,
        reason: retentionReason.trim(),
      }),
    );
    if (res.error) {
      setError(res.error);
      return;
    }
    setInfo(res.data!.created ? t('policies.created') : t('policies.updated'));
    setRetentionReason('');
    load();
  }

  const openGaps = gaps.filter((g) => g.status === 'DECISION_REQUIRED');
  const targetCountry = countries.find((c) => c.id === target);

  return (
    <AppLayout>
      <SectionHeader title={t('policies.title')} />
      {error && <ErrorState message={error} />}
      {info && <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{info}</div>}

      <Card className="mb-4 p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('markets.title')}</h3>
        {marketRows.length === 0 ? (
          <p className="text-sm text-slate-500">{t('markets.empty')}</p>
        ) : (
          <ul className="space-y-3">
            {marketRows.map((m) => (
              <li key={m.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Badge color={m.isActive ? 'green' : 'slate'}>{m.code}</Badge>
                    <span className="text-sm font-medium">{m.nameAr || m.name}</span>
                    <span className="text-xs text-slate-500">
                      {m.currencyCode} · {m.defaultLanguage}
                    </span>
                    {m.isActive && m.activatedAt && (
                      <span className="text-xs text-slate-400">{formatDate(m.activatedAt)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="w-56 rounded-md border px-2 py-1 text-xs"
                      placeholder={t('markets.reasonPlaceholder')}
                      value={marketReason[m.id] ?? ''}
                      onChange={(e) => setMarketReason((r) => ({ ...r, [m.id]: e.target.value }))}
                    />
                    <button className={m.isActive ? 'btn-secondary px-3 py-1 text-xs' : 'btn-primary px-3 py-1 text-xs'} onClick={() => toggleMarket(m)}>
                      {m.isActive ? t('markets.deactivate') : t('markets.activate')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold">{t('policies.openGaps')}</h3>
        {openGaps.length === 0 ? (
          <p className="text-sm text-slate-500">{t('policies.noGaps')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {openGaps.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3">
                <span>
                  <Badge color="amber">{g.countryCode ?? g.countryId}</Badge>{' '}
                  <span className="text-slate-600">{g.reason ?? t('policies.gapReason')}</span>
                </span>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={() => selectTarget(g.countryId)}
                >
                  {t('policies.define')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-4 p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('policies.edit')}</h3>
        <label className="mb-1 block text-xs text-slate-500">{t('policies.scope')}</label>
        <select
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          value={target}
          onChange={(e) => selectTarget(e.target.value)}
        >
          <option value="">{t('policies.globalDefault')}</option>
          {countries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.nameAr || c.name}{c.isActive ? '' : ` (${t('policies.inactive')})`}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC_FIELDS.map((field) => (
            <div key={field}>
              <label className="mb-1 block text-xs text-slate-500">{t(`policies.field.${field}`)}</label>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border px-3 py-2 text-sm"
                value={draft[field] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                placeholder={t('policies.optional')}
              />
            </div>
          ))}
        </div>

        <label className="mb-1 mt-3 block text-xs text-slate-500">{t('policies.reason')}</label>
        <textarea
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('policies.reasonPlaceholder')}
        />
        <button type="button" className="btn-primary" onClick={save}>
          {t('policies.save')}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          {targetCountry
            ? `${t('policies.countryHint')} ${targetCountry.code}`
            : t('policies.globalHint')}
        </p>
      </Card>

      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold">{t('retention.title')}</h3>
        {retentionGaps.filter((g) => g.status === 'DECISION_REQUIRED').length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {retentionGaps
              .filter((g) => g.status === 'DECISION_REQUIRED')
              .map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3">
                  <span>
                    <Badge color="amber">{g.countryCode ?? g.countryId}</Badge>{' '}
                    <span className="text-slate-600">{g.reason ?? t('policies.gapReason')}</span>
                  </span>
                  <button
                    type="button"
                    className="btn-secondary px-2 py-1 text-xs"
                    onClick={() => selectRetentionTarget(g.countryId)}
                  >
                    {t('policies.define')}
                  </button>
                </li>
              ))}
          </ul>
        )}
        <label className="mb-1 block text-xs text-slate-500">{t('policies.scope')}</label>
        <select
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          value={retentionTarget}
          onChange={(e) => selectRetentionTarget(e.target.value)}
        >
          <option value="">{t('policies.globalDefault')}</option>
          {countries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.nameAr || c.name}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-500">
              {t('policies.field.defaultRetentionDays')}
            </label>
            <input
              type="number"
              min={1}
              max={3650}
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder={t('policies.optional')}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">{t('retention.preserves')}</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={retentionPreserves}
              onChange={(e) => setRetentionPreserves(e.target.value)}
              placeholder={t('retention.preservesPlaceholder')}
            />
          </div>
        </div>
        <label className="mb-1 mt-3 block text-xs text-slate-500">{t('policies.reason')}</label>
        <textarea
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          rows={2}
          value={retentionReason}
          onChange={(e) => setRetentionReason(e.target.value)}
          placeholder={t('policies.reasonPlaceholder')}
        />
        <button type="button" className="btn-primary" onClick={saveRetention}>
          {t('policies.save')}
        </button>
        <p className="mt-2 text-xs text-slate-500">{t('retention.hint')}</p>
        {retentionRows.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-slate-600">
            {retentionRows.map((r) => {
              const rules = r.rules as Record<string, unknown>;
              return (
                <li key={r.id} className="flex items-center gap-2">
                  {r.countryCode ? <Badge color="indigo">{r.countryCode}</Badge> : <Badge color="slate">{t('policies.global')}</Badge>}
                  <span>
                    {String(rules.defaultRetentionDays ?? '-')} {t('retention.days')} · v{r.version}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {loading ? (
        <Spinner />
      ) : policies.length === 0 ? (
        <EmptyState title={t('policies.empty')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{t('policies.scope')}</th>
                <th className="px-4 py-2 text-start">{t('policies.name')}</th>
                <th className="px-4 py-2 text-start">{t('policies.rules')}</th>
                <th className="px-4 py-2 text-start">{t('policies.version')}</th>
                <th className="px-4 py-2 text-start">{t('policies.updatedAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {policies.map((p) => {
                const rules = p.rules as Record<string, number>;
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-2">
                      {p.countryCode ? <Badge color="indigo">{p.countryCode}</Badge> : <Badge color="slate">{t('policies.global')}</Badge>}
                    </td>
                    <td className="px-4 py-2">{p.name}</td>
                    <td className="px-4 py-2 font-mono text-xs" dir="ltr">
                      {NUMERIC_FIELDS.filter((f) => rules[f] !== undefined).map((f) => `${f}=${rules[f]}`).join(' · ')}
                    </td>
                    <td className="px-4 py-2">v{p.version}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDate(p.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}