import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, ApiClientError, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { Category, ProductDetail, ProductSummary } from '@/lib/types';

interface EditProductModalProps {
  productId: string;
  onClose: () => void;
  onSaved: () => void;
}

function EditProductModal({ productId, onClose, onSaved }: EditProductModalProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [moq, setMoq] = useState(1);
  const [unit, setUnit] = useState('piece');
  const [purchaseIntent, setPurchaseIntent] = useState<'B2B' | 'B2C'>('B2B');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [prod, cats] = await Promise.all([
        apiCall(() => api.getProduct(productId)),
        apiCall(() => api.listCategories()),
      ]);
      if (cancelled) return;
      if (prod.error || !prod.data) {
        setError(prod.error ?? t('common.error'));
      } else {
        const p: ProductDetail = prod.data;
        setName(p.name);
        setNameAr(p.nameAr ?? '');
        setCategoryId(p.categoryId);
        setBasePrice(p.basePrice);
        setMoq(p.moq ?? 1);
        setUnit(p.unit ?? 'piece');
        setPurchaseIntent(p.purchaseIntent ?? 'B2B');
        setDescription(p.description ?? '');
      }
      setCategories(cats.data ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [productId, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const res = await apiCall(() => api.updateProduct(productId, {
      name, nameAr, categoryId, basePrice, moq, unit, purchaseIntent, description,
    }));
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold text-slate-800">{t('form.editProduct')}</h3>
        {loading ? <Spinner /> : (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="product-edit-form">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="ep-name">{t('form.name')} *</label>
              <input id="ep-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
            </div>
            <div>
              <label className="label" htmlFor="ep-name-ar">{t('form.nameAr')}</label>
              <input id="ep-name-ar" className="input" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="ep-category">{t('nav.categories')} *</label>
              <select id="ep-category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nameAr ?? c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ep-price">{t('common.price')} *</label>
              <input id="ep-price" type="number" step="0.001" className="input" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="ep-moq">{t('form.moq')}</label>
              <input id="ep-moq" type="number" min={1} className="input" value={moq} onChange={(e) => setMoq(Number(e.target.value) || 1)} />
            </div>
            <div>
              <label className="label" htmlFor="ep-unit">{t('form.unit')}</label>
              <input id="ep-unit" className="input" value={unit} onChange={(e) => setUnit(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="ep-intent">{t('form.intent')}</label>
              <select id="ep-intent" className="input" value={purchaseIntent} onChange={(e) => setPurchaseIntent(e.target.value as never)}>
                <option value="B2B">B2B</option><option value="B2C">B2C</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="ep-description">{t('form.description')}</label>
              <textarea id="ep-description" rows={3} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error && <p className="sm:col-span-2 text-sm text-red-600" role="alert">{error}</p>}
            <div className="flex items-center justify-end gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
              <button type="submit" className="btn-primary disabled:opacity-50" disabled={saving || !name.trim()}>
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function DashboardProductsPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiCall(() => api.listMyProducts({ pageSize: 100 }));
    setProducts(res.data?.items ?? []);
    setError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(id: string, status: 'ACTIVE' | 'INACTIVE') {
    setBusyId(id);
    const res = await apiCall(() => api.updateProductStatus(id, status));
    if (res.error) setError(res.error);
    setBusyId(null);
    await load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.products')} action={<Link className="btn-primary text-sm" to="/dashboard/products/new">{t('form.newProduct')}</Link>} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : products.length === 0 ? (
        <EmptyState title={t('common.noData')} hint={t('form.newProduct')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('nav.products')}</th><th>SKU</th><th>{t('common.price')}</th><th>{t('common.status')}</th><th>{t('common.date')}</th><th /></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="text-xs">{p.sku}</td>
                  <td>{formatMoney(p.basePrice, p.currencyCode)}</td>
                  <td><Badge color={p.status === 'ACTIVE' ? 'green' : 'slate'}>{p.status}</Badge></td>
                  <td className="text-xs">{String(p.createdAt ?? '').slice(0, 10)}</td>
                  <td>
                    <div className="flex items-center justify-end gap-2">
                      {p.status === 'SUSPENDED' ? (
                        <span className="text-xs text-amber-700" data-testid={`product-suspended-${p.id}`}>{t('product.suspendedNotice')}</span>
                      ) : (
                        <button
                          type="button"
                          data-testid={`product-status-${p.id}`}
                          disabled={busyId === p.id}
                          onClick={() => void setStatus(p.id, p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')}
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700 disabled:opacity-50"
                        >
                          {p.status === 'ACTIVE' ? t('form.unpublish') : t('form.publish')}
                        </button>
                      )}
                      {p.status !== 'SUSPENDED' && (
                        <button
                          type="button"
                          data-testid={`product-edit-${p.id}`}
                          onClick={() => setEditId(p.id)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700"
                        >
                          {t('common.edit')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {editId && (
        <EditProductModal
          productId={editId}
          onClose={() => setEditId(null)}
          onSaved={() => { void load(); }}
        />
      )}
    </AppLayout>
  );
}

export function DashboardCreateProductPage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [entities, setEntities] = useState<Array<{ id: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; name: string }>>([]);
  const [loadingEntities, setLoadingEntities] = useState(true);
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [sku, setSku] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [currencyCode, setCurrencyCode] = useState('TND');
  const [moq, setMoq] = useState(1);
  const [unit, setUnit] = useState('piece');
  const [sellerType, setSellerType] = useState<'MERCHANT' | 'SUPPLIER' | 'COMPANY'>('MERCHANT');
  const [sellerId, setSellerId] = useState('');
  const [description, setDescription] = useState('');
  const [purchaseIntent, setPurchaseIntent] = useState<'B2B' | 'B2C'>('B2B');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiCall(() => api.listCategories()).then((res) => setCategories(res.data ?? []));
    apiCall(() => api.listMySellerEntities()).then((res) => {
      const items = res.data?.items ?? [];
      setEntities(items);
      if (items.length > 0) {
        setSellerId((current) => current || items[0].id);
        setSellerType((current) => (items.some((i) => i.sellerType === current) ? current : items[0].sellerType));
      }
      setLoadingEntities(false);
    });
  }, []);

  // Keep the selected type in sync with the chosen entity.
  const onSelectEntity = (id: string) => {
    setSellerId(id);
    const found = entities.find((e) => e.id === id);
    if (found) setSellerType(found.sellerType);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sellerId) {
      setError(t('form.noSellerEntity'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.createProduct({ sellerId, sellerType, categoryId, name, nameAr, sku, basePrice, currencyCode, moq, unit, purchaseIntent, description });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <SectionHeader title={t('form.newProduct')} />
      <Card className="max-w-2xl p-6">
        {done ? (
          <p className="rounded bg-green-50 p-3 text-sm text-green-800">{t('product.createSuccess')}</p>
        ) : loadingEntities ? (
          <Spinner />
        ) : entities.length === 0 ? (
          <div className="space-y-2 text-sm text-slate-600">
            <p>{t('form.noSellerEntity')}</p>
            <Link to="/onboarding" className="btn-primary inline-block text-sm">{t('form.createEntity')}</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="p-name">{t('form.name')} *</label>
              <input id="p-name" value={name} onChange={(e) => setName(e.target.value)} className="input" required minLength={2} />
            </div>
            <div>
              <label className="label" htmlFor="p-name-ar">{t('form.nameAr')}</label>
              <input id="p-name-ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="input" dir="rtl" />
            </div>
            <div>
              <label className="label" htmlFor="p-sku">{t('field.sku')} *</label>
              <input id="p-sku" value={sku} onChange={(e) => setSku(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label" htmlFor="p-category">{t('nav.categories')} *</label>
              <select id="p-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input" required>
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nameAr ?? c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="p-seller">{t('form.sellerEntity')} *</label>
              <select id="p-seller" value={sellerId} onChange={(e) => onSelectEntity(e.target.value)} className="input" required>
                {entities.map((e2) => (
                  <option key={e2.id} value={e2.id}>{e2.name} — {e2.sellerType}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="p-price">{t('common.price')} *</label>
              <input id="p-price" type="number" step="0.001" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label">{t('common.currency')}</label>
              <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="input">
                <option>TND</option><option>EUR</option><option>USD</option><option>CNY</option>
              </select>
            </div>
            <div>
              <label className="label">{t('form.moq')}</label>
              <input type="number" min={1} value={moq} onChange={(e) => setMoq(Number(e.target.value) || 1)} className="input" />
            </div>
            <div>
              <label className="label">{t('form.unit')}</label>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">{t('form.intent')}</label>
              <select value={purchaseIntent} onChange={(e) => setPurchaseIntent(e.target.value as never)} className="input">
                <option value="B2B">B2B</option><option value="B2C">B2C</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">{t('form.description')}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input" />
            </div>
            {error && <p className="sm:col-span-2 text-sm text-red-600" role="alert">{error}</p>}
            <button type="submit" disabled={submitting} className="btn-primary sm:col-span-2">
              {submitting ? t('common.loading') : t('common.save')}
            </button>
          </form>
        )}
      </Card>
    </AppLayout>
  );
}