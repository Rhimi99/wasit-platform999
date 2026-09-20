import { useEffect, useState } from 'react';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { Category, ProductSummary } from '@/lib/types';

export function DashboardProductsPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.listProducts({ pageSize: '50' })).then((res) => {
      setProducts(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.products')} action={<a className="btn-primary text-sm" href="#create-product">+ New</a>} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : products.length === 0 ? (
        <EmptyState title={t('common.noData')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('nav.products')}</th><th>SKU</th><th>{t('common.price')}</th><th>{t('common.status')}</th><th>{t('common.date')}</th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="text-xs">{p.sku}</td>
                  <td>{p.basePrice} {p.currencyCode}</td>
                  <td>{p.status}</td>
                  <td className="text-xs">{String(p.createdAt ?? '').slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function DashboardCreateProductPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
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
    if (user?.roles.includes('MERCHANT') && !sellerId) setSellerId('me');
  }, [user, sellerId]);

  // If the logged-in user owns a supplier/merchant/company entity fetched via APIs,
  // sellerId would come from those APIs. For now the create form asks explicitly.

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sellerId || sellerId === 'me') {
      setError('sellerId required: create your business entity first');
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
          <p className="rounded bg-green-50 p-3 text-sm text-green-800">{t('order.createSuccess')}</p>
        ) : (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label">{t('form.name')} *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" required minLength={2} />
            </div>
            <div>
              <label className="label">{t('form.nameAr')}</label>
              <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="input" dir="rtl" />
            </div>
            <div>
              <label className="label">{t('field.sku')} *</label>
              <input value={sku} onChange={(e) => setSku(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label">{t('nav.categories')} *</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input" required>
                <option value="">—</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nameAr ?? c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('form.sellerType')}</label>
              <select value={sellerType} onChange={(e) => setSellerType(e.target.value as never)} className="input">
                <option value="MERCHANT">MERCHANT</option>
                <option value="SUPPLIER">SUPPLIER</option>
                <option value="COMPANY">COMPANY</option>
              </select>
            </div>
            <div>
              <label className="label">{t('form.sellerId')} *</label>
              <input value={sellerId} onChange={(e) => setSellerId(e.target.value)} className="input" placeholder={t('form.sellerPlaceholder')} required />
            </div>
            <div>
              <label className="label">{t('common.price')} *</label>
              <input type="number" step="0.001" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} className="input" required />
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
        <p className="mt-3 text-xs text-slate-400">Requires an existing seller entity (supplier/merchant/company) owned by your account. Backend validates ownership.</p>
      </Card>
    </AppLayout>
  );
}