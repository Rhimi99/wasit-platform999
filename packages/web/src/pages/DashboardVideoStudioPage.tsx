import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { MediaAsset, ProductSummary } from '@/lib/types';

const LANGUAGES = ['ar', 'fr', 'en', 'zh'] as const;
const AUDIENCES = ['B2B', 'B2C'] as const;
const STYLES = ['MODERN', 'MINIMAL', 'BOLD', 'ELEGANT'] as const;

export function DashboardVideoStudioPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const [productId, setProductId] = useState('');
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>('ar');
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]>('B2B');
  const [style, setStyle] = useState<(typeof STYLES)[number]>('MODERN');
  const [durationSeconds, setDurationSeconds] = useState(12);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, m] = await Promise.all([
      apiCall(() => api.listMyProducts({ pageSize: 100 })),
      apiCall(() => api.listMyMedia({ kind: 'MARKETING_VIDEO', limit: 50 })),
    ]);
    if (p.data) setProducts(p.data.items);
    if (m.data) setLibrary(m.data.items);
    setError(p.error && m.error ? p.error : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!productId) {
      setError(t('studio.noProducts'));
      return;
    }
    setGenerating(true);
    try {
      await api.generateMarketingVideo({ productId, language, audience, style, durationSeconds });
      setNotice(t('studio.generated'));
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const remove = async (id: string) => {
    const res = await apiCall(() => api.deleteMediaAsset(id));
    setNotice(res.error ?? t('studio.deleted'));
    await load();
  };

  if (loading) return <AppLayout><SectionHeader title={t('studio.title')} /><Spinner /></AppLayout>;

  return (
    <AppLayout>
      <SectionHeader title={t('studio.title')} subtitle={t('studio.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <form onSubmit={generate} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label">{t('studio.product')} *</label>
              <select value={productId} onChange={(e) => setProductId(e.target.value)} className="input" required>
                <option value="">{t('studio.selectProduct')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nameAr ?? p.name} — {p.status}
                  </option>
                ))}
              </select>
              {products.length === 0 && <p className="mt-1 text-xs text-amber-600">{t('studio.noProducts')}</p>}
            </div>
            <div>
              <label className="label">{t('studio.language')}</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value as never)} className="input">
                {LANGUAGES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('studio.audience')}</label>
              <select value={audience} onChange={(e) => setAudience(e.target.value as never)} className="input">
                {AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('studio.style')}</label>
              <select value={style} onChange={(e) => setStyle(e.target.value as never)} className="input">
                {STYLES.map((s2) => <option key={s2} value={s2}>{s2}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('studio.duration')}</label>
              <input
                type="number"
                min={4}
                max={60}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value) || 12)}
                className="input"
              />
            </div>
            <button
              type="submit"
              disabled={generating || products.length === 0}
              className="btn-primary sm:col-span-2"
            >
              {generating ? t('studio.generating') : t('studio.generate')}
            </button>
          </form>
          {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
          {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('studio.library')}</h3>
          {library.length === 0 ? (
            <EmptyState title={t('studio.libraryEmpty')} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {library.map((asset) => (
                <div key={asset.id} className="rounded-md border border-slate-200 p-2">
                  <p className="truncate text-xs font-medium text-slate-700">{asset.title}</p>
                  <div className="mt-1">
                    {asset.previewable && asset.previewUrl ? (
                      <video src={asset.previewUrl} controls className="h-32 w-full rounded-md bg-slate-900" />
                    ) : (
                      <p className="text-xs text-amber-600">{t('studio.notReady')}</p>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge color={asset.status === 'READY' ? 'green' : 'amber'}>{asset.status}</Badge>
                    <span className="text-[10px] text-slate-400">{asset.provider} · {asset.language}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {asset.downloadUrl && (
                      <a href={asset.downloadUrl} download className="rounded bg-wasit-600 px-2 py-1 text-[10px] text-white hover:bg-wasit-700">
                        {t('studio.download')}
                      </a>
                    )}
                    <button
                      onClick={() => void remove(asset.id)}
                      className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600 hover:border-red-400 hover:text-red-600"
                    >
                      {t('studio.delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AppLayout>
  );
}