import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, apiCall, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { Badge, Card, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { AdSlot } from '@/components/AdSlot';
import { SeoHead } from '@/components/SeoHead';
import type { JsonLd, ProductDetail } from '@/lib/types';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function ProductDetailsPage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [libBusy, setLibBusy] = useState(false);
  const [jsonLd, setJsonLd] = useState<JsonLd | null>(null);

  useEffect(() => {
    let mounted = true;
    apiCall(() => api.getProduct(id)).then((res) => {
      if (!mounted) return;
      setProduct(res.data);
      setError(res.error);
      if (res.data?.moq) setQty(res.data.moq);
    });
    apiCall(() => api.getStructuredData('PRODUCT', id)).then((res) => {
      if (mounted) setJsonLd(res.data ?? null);
    });
    return () => {
      mounted = false;
    };
  }, [id]);

  useEffect(() => {
    if (!user) return;
    let mounted = true;
    apiCall(() => api.listFavorites({ entityType: 'PRODUCT', pageSize: 100 })).then((res) => {
      if (mounted && res.data) setIsFavorite(res.data.items.some((f) => f.entityId === id));
    });
    apiCall(() => api.listSavedItems({ itemType: 'PRODUCT', pageSize: 100 })).then((res) => {
      if (mounted && res.data) setIsSaved(res.data.items.some((s) => s.itemId === id));
    });
    return () => {
      mounted = false;
    };
  }, [user, id]);

  const toggleFavorite = async () => {
    if (libBusy) return;
    setLibBusy(true);
    const res = isFavorite
      ? await apiCall(() => api.removeFavorite('PRODUCT', id))
      : await apiCall(() => api.addFavorite('PRODUCT', id));
    if (!res.error) setIsFavorite(!isFavorite);
    setLibBusy(false);
  };

  const toggleSaved = async () => {
    if (libBusy) return;
    setLibBusy(true);
    const res = isSaved
      ? await apiCall(() => api.removeSavedItem('PRODUCT', id))
      : await apiCall(() => api.saveItem('PRODUCT', id));
    if (!res.error) setIsSaved(!isSaved);
    setLibBusy(false);
  };

  if (error) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-3xl px-4 py-10">
          <ErrorState message={error} />
        </div>
      </PublicLayout>
    );
  }
  if (!product) return <Spinner />;

  const primaryImage = product.images.find((i) => i.isPrimary) ?? product.images[0];
  const orderUrl = `/checkout?productId=${product.id}`;

  return (
    <PublicLayout>
      <SeoHead
        title={`${product.name} — LE WASSIT`}
        description={product.description ?? undefined}
        canonicalPath={`/products/${product.id}`}
        jsonLd={jsonLd}
      />
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Images */}
          <div>
            {primaryImage ? (
              <img src={primaryImage.url} alt={product.name} className="aspect-square w-full rounded-lg object-cover" />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-slate-100 text-slate-400">
                {t('product.noImage')}
              </div>
            )}
            {product.images.length > 1 && (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {product.images.map((img) => (
                  <img key={img.id} src={img.url} alt={img.altText ?? product.name} className="h-16 w-16 rounded object-cover" />
                ))}
              </div>
            )}
          </div>

          {/* Info */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              {product.purchaseIntent && <Badge color="indigo">{product.purchaseIntent}</Badge>}
              <span className="text-xs text-slate-400">{product.sellerType}</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">{product.name}</h1>
            {product.brand && <p className="mt-1 text-sm text-slate-500">{t('product.brand')}: {product.brand}</p>}

            <p className="mt-4 text-3xl font-bold text-wasit-700">{formatMoney(product.basePrice, product.currencyCode)}</p>

            <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-600">
              <div><span className="font-medium">{t('product.sku')}: </span>{product.sku}</div>
              {product.moq ? <div><span className="font-medium">{t('marketplace.moq')}: </span>{product.moq} {product.unit}</div> : null}
              {product.category && <div><span className="font-medium">{t('nav.categories')}: </span>{product.category.name}</div>}
            </div>

            {product.description && (
              <p className="mt-4 text-sm leading-relaxed text-slate-700">{product.description}</p>
            )}

            {/* Order Qty */}
            <div className="mt-6 flex items-center gap-3">
              <label className="label mb-0">{t('common.quantity')}</label>
              <input
                type="number"
                min={product.moq ?? 1}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="input w-28"
              />
            </div>
            {product.moq && qty < product.moq && (
              <p className="mt-1 text-xs text-amber-600">{t('marketplace.moq')} ≥ {product.moq}</p>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              {user ? (
                <a href={orderUrl} className="btn-primary">{t('product.addToOrder')}</a>
              ) : (
                <a href="/login" className="btn-primary">{t('auth.login')} {t('product.addToOrder')}</a>
              )}
              {user && (
                <>
                  <button type="button" className="btn-secondary" onClick={toggleFavorite} disabled={libBusy}>
                    {isFavorite ? '★' : '☆'} {t('library.favorites')}
                  </button>
                  <button type="button" className="btn-secondary" onClick={toggleSaved} disabled={libBusy}>
                    {isSaved ? '✓' : '+'} {t('library.saved')}
                  </button>
                </>
              )}
            </div>

            {/* Trust placeholder (trust engine is separate; score rendered when backend available) */}
            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">{t('trust.explanation')}</p>
            </div>
          </div>
        </div>

        {/* Variants/Specs */}
        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          {product.variants.length > 0 && (
            <Card>
              <SectionHeader title={t('product.variants')} />
              <table className="table-base">
                <thead><tr><th>SKU</th><th>Name</th><th>{t('common.price')}</th></tr></thead>
                <tbody>
                  {product.variants.map((v) => (
                    <tr key={v.id}>
                      <td>{v.sku}</td>
                      <td>{v.name}</td>
                      <td>{formatMoney(v.price, product.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {product.specifications && Object.keys(product.specifications).length > 0 && (
            <Card>
              <SectionHeader title={t('product.specifications')} />
              <table className="table-base">
                <tbody>
                  {Object.entries(product.specifications).map(([k, v]) => (
                    <tr key={k}>
                      <td className="font-medium">{k}</td>
                      <td>{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        <p className="mt-8 text-xs text-slate-400">{product.barcode ? `Barcode: ${product.barcode}` : ''}</p>
        <p className="text-xs text-slate-400">Created: {formatDate(product.createdAt)}</p>

        <AdSlot placement="PRODUCT_DETAILS" className="mt-10" />
      </div>
    </PublicLayout>
  );
}