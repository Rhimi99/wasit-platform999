import { useEffect, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { LegalAcceptanceHistoryEntry, LegalAcceptanceState } from '@/lib/types';

/**
 * Legal acceptance page (LC-01).
 *
 * Shows the documents currently in force that the signed-in user must accept,
 * lets them accept each version, and lists their own acceptance history. While
 * no document is published the pending list is empty and the page says so — it
 * never presents an unapproved draft as binding, and never asks for an
 * acceptance the backend would refuse.
 */
export function LegalAcceptancePage() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LegalAcceptanceState | null>(null);
  const [history, setHistory] = useState<LegalAcceptanceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const lang: 'ar' | 'en' = locale === 'en' ? 'en' : 'ar';

  useEffect(() => {
    setLoading(true);
    Promise.all([apiCall(() => api.legalAcceptances()), apiCall(() => api.legalAcceptanceHistory())]).then(
      ([stateRes, historyRes]) => {
        setState(stateRes.data ?? null);
        setHistory(historyRes.data?.items ?? []);
        setError(stateRes.error ?? historyRes.error);
        setLoading(false);
      },
    );
  }, [reloadKey]);

  const accept = async (code: string, version: string) => {
    setBusy(code);
    setNotice(null);
    const res = await apiCall(() => api.acceptLegalDocument(code, version, locale));
    if (res.error) {
      setError(res.error);
    } else {
      setNotice(t('legal.accepted'));
      setReloadKey((k) => k + 1);
    }
    setBusy(null);
  };

  const pending = state?.pendingAcceptances ?? [];

  return (
    <AppLayout>
      <SectionHeader title={t('legal.acceptanceTitle')} subtitle={t('legal.acceptanceSubtitle')} />
      {notice && (
        <p className="mb-3 text-sm text-green-700" role="status" data-testid="legal-acceptance-notice">
          {notice}
        </p>
      )}
      {error && <ErrorState message={error} />}
      {loading ? (
        <Spinner />
      ) : (
        <>
          <Card testId="legal-pending-card">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">{t('legal.pendingTitle')}</h3>
            {pending.length === 0 ? (
              <EmptyState title={t('legal.nothingPending')} hint={t('legal.nothingPendingHint')} />
            ) : (
              <ul className="space-y-3">
                {pending.map((d) => (
                  <li
                    key={d.code}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-800">{d.title[lang] || d.title.en}</p>
                      <p className="text-xs text-slate-400">
                        {t('legal.version')} {d.version}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy === d.code}
                      onClick={() => accept(d.code, d.version)}
                      data-testid={`legal-accept-${d.code}`}
                    >
                      {t('legal.accept')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="mt-4" testId="legal-history-card">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">{t('legal.historyTitle')}</h3>
            {history.length === 0 ? (
              <EmptyState title={t('legal.noHistory')} />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('legal.document')}</th>
                    <th>{t('legal.version')}</th>
                    <th>{t('legal.acceptedAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={`${h.documentCode}-${h.version}-${i}`}>
                      <td>{h.documentCode}</td>
                      <td>
                        <Badge color="teal">{h.version}</Badge>
                      </td>
                      <td dir="ltr">{h.acceptedAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </AppLayout>
  );
}
