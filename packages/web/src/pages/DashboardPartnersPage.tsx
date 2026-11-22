import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AgentTaskRow } from '@/lib/types';

const CONSENT = 'B2B_PARTNER_DISCOVERY';

interface Suggestion {
  partnerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY';
  partnerRef: string;
  displayName: string;
  countryId: string | null;
  verified: boolean;
  publishedProducts: number;
  score: number;
  reasons: string[];
}

interface PartnerAdvice {
  suggestions?: Suggestion[];
  consent?: { type: string; granted: boolean; optedInTenants: number; basis: string };
  contactPolicy?: string;
  refused?: boolean;
  error?: { code: string; message: string; howToGrant?: string };
}

function parseAdvice(task: AgentTaskRow | null): PartnerAdvice | null {
  const advice = (task?.result as { advice?: unknown } | null)?.advice;
  if (typeof advice !== 'string') return null;
  try {
    return JSON.parse(advice) as PartnerAdvice;
  } catch {
    return null;
  }
}

export function DashboardPartnersPage() {
  const { t } = useI18n();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [advice, setAdvice] = useState<PartnerAdvice | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiCall(() => api.privacyConsents());
    if (res.data) setGranted(res.data.find((c) => c.type === CONSENT)?.granted ?? false);
    else setLoadError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setConsent = async (next: boolean) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api.setPrivacyConsent(CONSENT, next);
      setGranted(next);
      setNotice(next ? t('partners.consent.grantedNotice') : t('partners.consent.withdrawnNotice'));
      if (!next) setAdvice(null);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadTask = async (taskId: string) => {
    const task = await api.aiTask(taskId);
    if (task.status === 'awaiting_approval') {
      setPendingTaskId(taskId);
      setNotice(t('partners.awaitingApproval'));
      return;
    }
    setPendingTaskId(null);
    const parsed = parseAdvice(task);
    setAdvice(parsed);
    if (parsed?.refused && parsed.error?.code === 'CONSENT_REQUIRED') {
      setActionError(t('partners.err.consentRequired'));
    }
  };

  const findPartners = async () => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const created = await api.aiCreateAgentTask('b2b-agent', { limit: 10 });
      await loadTask(created.id);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!pendingTaskId) return;
    setBusy(true);
    setActionError(null);
    try {
      await loadTask(pendingTaskId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <AppLayout><SectionHeader title={t('partners.title')} /><Spinner /></AppLayout>;

  const suggestions = advice?.suggestions ?? [];
  const consented = granted === true;

  return (
    <AppLayout>
      <SectionHeader title={t('partners.title')} subtitle={t('partners.subtitle')} />

      {loadError && <div className="mb-4"><ErrorState message={loadError} onRetry={() => void load()} /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-700">{t('partners.consent.title')}</h3>
            <Badge color={consented ? 'green' : 'slate'} testId="partners-consent-status">
              {consented ? t('partners.consent.active') : t('partners.consent.inactive')}
            </Badge>
          </div>

          <p className="mt-2 text-xs text-slate-600">{t('partners.consent.explain')}</p>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-slate-600">
            <li>{t('partners.consent.shows')}</li>
            <li>{t('partners.consent.hides')}</li>
            <li>{t('partners.consent.mutual')}</li>
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void setConsent(!consented)}
              disabled={busy}
              className={consented ? 'rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50' : 'btn-primary text-xs'}
              data-testid="partners-consent-toggle"
            >
              {consented ? t('partners.consent.withdraw') : t('partners.consent.grant')}
            </button>
            {pendingTaskId && (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={busy}
                className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-50"
                data-testid="partners-refresh"
              >
                {t('agentVideo.refresh')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void findPartners()}
              disabled={busy || !consented}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              data-testid="partners-find"
            >
              {busy ? t('partners.finding') : t('partners.find')}
            </button>
          </div>

          {notice && <p className="mt-3 text-xs text-green-700" data-testid="partners-notice">{notice}</p>}
          {actionError && <p className="mt-3 text-xs text-red-600" role="alert" data-testid="partners-error">{actionError}</p>}
          <p className="mt-3 text-[11px] text-slate-500">{t('partners.consent.withdrawHint')}</p>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('partners.results.title')}</h3>
          {!advice ? (
            <EmptyState title={t('partners.results.empty')} hint={t('partners.results.emptyHint')} />
          ) : advice.refused ? (
            <EmptyState title={t('partners.results.refused')} hint={advice.error?.message} />
          ) : suggestions.length === 0 ? (
            <EmptyState title={t('partners.results.none')} hint={t('partners.results.noneHint')} />
          ) : (
            <ul className="space-y-3" data-testid="partners-results">
              {suggestions.map((s) => (
                <li key={s.partnerRef} className="rounded-md border border-slate-200 p-3" data-testid={`partner-${s.partnerRef}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-800">{s.displayName}</span>
                    <span className="flex items-center gap-1">
                      {s.verified && <Badge color="green">{t('partners.verified')}</Badge>}
                      <Badge color="indigo">{s.score}/100</Badge>
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {t(`partners.type.${s.partnerType}`)} · {s.countryId ?? t('partners.countryUnknown')} ·{' '}
                    {t('partners.listings')}: {s.publishedProducts}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs text-slate-600">
                    {s.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {advice?.consent && (
            <p className="mt-3 text-[11px] text-slate-500" data-testid="partners-consent-summary">
              {t('partners.optedIn')}: {advice.consent.optedInTenants} · {advice.contactPolicy ?? ''}
            </p>
          )}
          <p className="mt-2 text-[11px] text-slate-400">{t('partners.noContact')}</p>
        </Card>
      </div>
    </AppLayout>
  );
}
