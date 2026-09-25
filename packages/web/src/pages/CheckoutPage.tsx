import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiCall, ApiClientError, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { Card, ErrorState, Spinner } from '@/components/ui';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function CheckoutPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const productId = params.get('productId') ?? '';
  const [product, setProduct] = useState<Awaited<ReturnType<typeof api.getProduct>> | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{
    itemsTotal: string;
    commission: string;
    commissionSeller: string;
    commissionBuyer: string;
    paymentFee: string;
    grandTotal: string;
    currencyCode: string;
  } | null>(null);
  const [payment, setPayment] = useState<{ status: string; provider: string; checkoutUrl: string | null } | null>(null);
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<{ type: 'CARD' | 'MOBILE_WALLET'; scheme?: string }>({ type: 'CARD' });
  const [methods, setMethods] = useState<{ type: 'CARD' | 'MOBILE_WALLET'; scheme?: string; label: string }[]>([]);

  useEffect(() => {
    if (!user) return;
    apiCall(() => api.getPaymentMethods()).then((res) => {
      const active = res.data?.providers.find((p) => p.id === res.data!.active);
      const usable = (active?.methods ?? []).filter((m) => m.available);
      const seen = new Set<string>();
      const options: { type: 'CARD' | 'MOBILE_WALLET'; scheme?: string; label: string }[] = [];
      for (const m of usable) {
        // Prefer scheme-specific options over the generic family label.
        if (!m.method.scheme) continue;
        const key = `${m.method.type}:${m.method.scheme}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ type: m.method.type, scheme: m.method.scheme, label: `${m.method.type} · ${m.method.scheme}` });
      }
      if (options.length === 0) {
        for (const m of usable) {
          const key = m.method.type;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({ type: m.method.type, label: m.method.type });
        }
      }
      setMethods(options);
      if (options.length > 0 && !options.some((o) => o.type === method.type && o.scheme === method.scheme)) {
        setMethod({ type: options[0].type, scheme: options[0].scheme });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!productId) return;
    apiCall(() => api.getProduct(productId)).then((res) => {
      setProduct(res.data);
      setError(res.error);
      if (res.data?.moq) setQty(res.data.moq);
    });
  }, [productId]);

  if (!productId) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-md px-4 py-12 text-center">
          <p className="text-slate-500">{t('common.noData')}</p>
        </div>
      </PublicLayout>
    );
  }
  if (error) {
    return (
      <PublicLayout><div className="mx-auto max-w-3xl px-4 py-10"><ErrorState message={error} /></div></PublicLayout>
    );
  }
  if (!product) return <Spinner />;

  const lineTotal = Number(product.basePrice) * qty;

  const placeOrder = async () => {
    if (!user) {
      navigate('/login');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createOrder({
        buyerId: user.id,
        items: [{ productId: product.id, quantity: qty }],
        currencyCode: product.currencyCode,
        notes: `Order from web for product ${product.name}`,
      });
      setSuccessId(res.orderId);
      setPlaced({
        itemsTotal: res.itemsTotal,
        commission: res.commission,
        commissionSeller: res.commissionSeller,
        commissionBuyer: res.commissionBuyer,
        paymentFee: res.paymentFee,
        grandTotal: res.grandTotal,
        currencyCode: res.currencyCode,
      });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startPayment = async () => {
    if (!successId) return;
    setPaying(true);
    setError(null);
    try {
      // A stable key per order keeps retries from creating duplicate intents.
      const res = await api.createPaymentIntent(successId, `web_${successId}`, method);
      setPayment({ status: res.intent.status, provider: res.intent.provider, checkoutUrl: res.checkoutUrl });
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setPaying(false);
    }
  };

  return (
    <PublicLayout>
      <div className="mx-auto max-w-xl px-4 py-10">
        <Card className="p-6">
          <h1 className="text-xl font-bold text-slate-900">{t('order.items')}</h1>
          <div className="mt-4 flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <p className="font-medium text-slate-800">{product.name}</p>
              <p className="text-xs text-slate-400">{product.sku}</p>
            </div>
            <input
              type="number"
              min={product.moq ?? 1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="input w-24"
            />
          </div>
          <div className="mt-3 space-y-1 text-sm text-slate-600">
            <div className="flex justify-between"><span>{t('common.quantity')} × {qty}</span><span>{formatMoney(product.basePrice, product.currencyCode)}</span></div>
            <div className="flex justify-between font-semibold text-slate-800"><span>{t('common.total')}</span><span>{formatMoney(lineTotal, product.currencyCode)}</span></div>
            <div className="flex justify-between text-xs text-slate-400" data-testid="commission-pending"><span>{t('order.commission')}</span><span>{t('order.commissionPending')}</span></div>
          </div>
          {error && (
            <p className="mt-4 rounded bg-red-50 p-2 text-sm text-red-600" role="alert">{error}</p>
          )}
          {successId ? (
            <div className="mt-4 space-y-3">
              <div className="rounded bg-green-50 p-3 text-sm text-green-800" role="status">
                {t('order.createSuccess')} <Link to="/dashboard/orders" className="font-semibold underline">{t('order.myOrders')}</Link>
              </div>
              {placed && (
                <div
                  className="rounded border border-slate-200 p-3 text-sm"
                  data-testid="order-breakdown"
                  data-items-total={placed.itemsTotal}
                  data-commission={placed.commission}
                  data-commission-seller={placed.commissionSeller}
                  data-commission-buyer={placed.commissionBuyer}
                  data-grand-total={placed.grandTotal}
                  data-payment-fee={placed.paymentFee}
                >
                  <div className="flex justify-between text-slate-600"><span>{t('order.items')}</span><span>{formatMoney(placed.itemsTotal, placed.currencyCode)}</span></div>
                  <div className="mt-1 flex justify-between text-slate-600"><span>{t('order.commission')}</span><span>{formatMoney(placed.commission, placed.currencyCode)}</span></div>
                  <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{t('order.sellerCommission')}</span><span>{formatMoney(placed.commissionSeller, placed.currencyCode)}</span></div>
                  <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{t('order.buyerCommission')}</span><span>{formatMoney(placed.commissionBuyer, placed.currencyCode)}</span></div>
                  {Number(placed.paymentFee) > 0 && (
                    <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{t('order.fee')}</span><span>{formatMoney(placed.paymentFee, placed.currencyCode)}</span></div>
                  )}
                  <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 font-semibold text-slate-800"><span>{t('order.grandTotal')}</span><span>{formatMoney(placed.grandTotal, placed.currencyCode)}</span></div>
                </div>
              )}
              <div className="rounded border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-700">{t('payment.title')}</span>
                  <span className="text-slate-500" data-testid="payment-status">
                    {payment ? (payment.status === 'SUCCEEDED' ? t('payment.paid') : t('payment.awaiting')) : t('payment.status')}
                  </span>
                </div>
                {!payment && (
                  <>
                    {methods.length > 0 && (
                      <div className="mt-3">
                        <label className="text-xs font-medium text-slate-500" htmlFor="payment-method">
                          {t('payment.method')}
                        </label>
                        <select
                          id="payment-method"
                          data-testid="payment-method"
                          className="input mt-1 w-full"
                          value={`${method.type}:${method.scheme ?? ''}`}
                          onChange={(e) => {
                            const opt = methods.find((o) => `${o.type}:${o.scheme ?? ''}` === e.target.value);
                            if (opt) setMethod({ type: opt.type, scheme: opt.scheme });
                          }}
                        >
                          {methods.map((o) => (
                            <option key={`${o.type}:${o.scheme ?? ''}`} value={`${o.type}:${o.scheme ?? ''}`}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button onClick={startPayment} disabled={paying} className="btn-primary mt-3 w-full" data-testid="start-payment">
                      {paying ? t('common.loading') : t('payment.start')}
                    </button>
                  </>
                )}
                {payment && !payment.checkoutUrl && (
                  <p className="mt-2 text-xs text-slate-400">{t('payment.awaiting')} · {payment.provider}</p>
                )}
              </div>
            </div>
          ) : (
            <button onClick={placeOrder} disabled={submitting} className="btn-primary mt-4 w-full">
              {submitting ? t('common.loading') : t('order.place')}
            </button>
          )}
          {/* ملاحظة تجارية: العمولة تُحسب من Commission Engine في الـ Backend ويظهر الناتج في تفاصيل الطلب */}
          <p className="mt-3 text-xs text-slate-400">
            Commission: WASIT Base policy from Commission Engine — applied & audited server-side.
          </p>
        </Card>
      </div>
    </PublicLayout>
  );
}