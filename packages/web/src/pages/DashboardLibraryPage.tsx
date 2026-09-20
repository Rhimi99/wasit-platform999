import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { FavoriteRow, LibraryEntityType, SavedItemRow, SearchHistoryRow } from '@/lib/types';

type Tab = 'favorites' | 'saved' | 'history';

const entityPath = (type: LibraryEntityType, id: string): string => {
  switch (type) {
    case 'PRODUCT': return `/products/${id}`;
    case 'SUPPLIER': return `/suppliers/${id}`;
    case 'MERCHANT': return `/merchants/${id}`;
    case 'COMPANY': return `/companies/${id}`;
  }
};

export function DashboardLibraryPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('favorites');
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [saved, setSaved] = useState<SavedItemRow[]>([]);
  const [history, setHistory] = useState<SearchHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    if (tab === 'favorites') {
      const res = await apiCall(() => api.listFavorites());
      setFavorites(res.data?.items ?? []);
      setError(res.error);
    } else if (tab === 'saved') {
      const res = await apiCall(() => api.listSavedItems());
      setSaved(res.data?.items ?? []);
      setError(res.error);
    } else {
      const res = await apiCall(() => api.listSearchHistory({ pageSize: 100 }));
      setHistory(res.data?.items ?? []);
      setError(res.error);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeFavorite = async (row: FavoriteRow) => {
    const res = await apiCall(() => api.removeFavorite(row.entityType, row.entityId));
    setNotice(res.error ?? t('library.removed'));
    void load();
  };

  const removeSaved = async (row: SavedItemRow) => {
    const res = await apiCall(() => api.removeSavedItem(row.itemType, row.itemId));
    setNotice(res.error ?? t('library.removed'));
    void load();
  };

  const deleteHistoryEntry = async (row: SearchHistoryRow) => {
    await apiCall(() => api.deleteSearchHistoryEntry(row.id));
    void load();
  };

  const clearHistory = async () => {
    const res = await apiCall(() => api.clearSearchHistory());
    setNotice(res.error ?? t('library.cleared'));
    void load();
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'favorites', label: t('library.favorites') },
    { key: 'saved', label: t('library.saved') },
    { key: 'history', label: t('library.searchHistory') },
  ];

  return (
    <AppLayout>
      <SectionHeader
        title={t('library.favorites')}
        action={tab === 'history' && history.length > 0 ? (
          <button type="button" className="btn-secondary" onClick={clearHistory}>{t('library.clearHistory')}</button>
        ) : undefined}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => { setTab(x.key); setNotice(null); }}
            className={tab === x.key ? 'btn-primary' : 'btn-secondary'}
          >
            {x.label}
          </button>
        ))}
      </div>

      {notice && <p className="mb-3 text-sm text-wasit-700">{notice}</p>}

      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : tab === 'history' ? (
        history.length === 0 ? <EmptyState title={t('library.emptyHistory')} /> : (
          <Card>
            <ul className="divide-y divide-slate-100">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <Link to={`/search?q=${encodeURIComponent(h.query)}`} className="text-wasit-700 hover:underline">{h.query}</Link>
                    <p className="text-xs text-slate-400">
                      {String(h.createdAt).slice(0, 10)}
                      {h.resultsCount != null && ` · ${h.resultsCount}`}
                    </p>
                  </div>
                  <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => deleteHistoryEntry(h)}>
                    {t('common.delete')}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )
      ) : tab === 'favorites' ? (
        favorites.length === 0 ? <EmptyState title={t('library.empty')} /> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {favorites.map((f) => (
              <Card key={f.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge color="indigo">{t(`library.type.${f.entityType}`)}</Badge>
                      {!f.available && <Badge color="red">{t('library.unavailable')}</Badge>}
                    </div>
                    {f.available ? (
                      <Link to={entityPath(f.entityType, f.entityId)} className="font-medium text-wasit-700 hover:underline">
                        {f.title ?? f.entityId}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-400">{f.title ?? f.entityId}</span>
                    )}
                    {f.subtitle && <p className="text-xs text-slate-400">{f.subtitle}</p>}
                  </div>
                  <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => removeFavorite(f)}>
                    {t('library.remove')}
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        saved.length === 0 ? <EmptyState title={t('library.empty')} /> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {saved.map((s) => (
              <Card key={s.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge color="teal">{t(`library.type.${s.itemType}`)}</Badge>
                      {!s.available && <Badge color="red">{t('library.unavailable')}</Badge>}
                    </div>
                    {s.available ? (
                      <Link to={entityPath(s.itemType, s.itemId)} className="font-medium text-wasit-700 hover:underline">
                        {s.title ?? s.itemId}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-400">{s.title ?? s.itemId}</span>
                    )}
                    {s.notes && <p className="mt-1 text-xs text-slate-500">{s.notes}</p>}
                  </div>
                  <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => removeSaved(s)}>
                    {t('library.remove')}
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )
      )}
    </AppLayout>
  );
}