import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { Card, Spinner } from '@/components/ui';
import type { QuoteIssue, QuoteResult } from '@/lib/types';

/**
 * The cart page.
 *
 * A signed-in buyer sees the server's own quote: current price, free stock,
 * per-seller grouping, commission and grand total. A guest sees the cached
 * snapshot and is told the totals are confirmed after signing in — the server
 * is the only thing that ever prices an order.
 */
export function CartPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { lines, count, items, setQuantity, remove, clear } = useCart();
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One quote request at a time: rapid stepper clicks must not land out of order.
  const requestSeq = useRef(0);

  const signature = useMemo(() => items.map((i) => `${i.productId}:${i.quantity}`).join(','), [items]);

  useEffect(() => {
    if (!user || items.length === 0) {
      setQuote(null);
      return;
    }
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    apiCall(() => api.quoteOrder(items)).then((res) => {
      if (requestSeq.current !== seq) return;
      setQuote(res.data);
      setError(res.error);
      setLoading(false);
    });
    // `signature` captures every field the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, signature]);

  const issuesByProduct = useMemo(() => {
    const map = new Map<string, QuoteIssue>();
    for (const issue of quote?.issues ?? []) map.set(issue.productId, issue);
    return map;
  }, [quote]);

  const quotedLine = (productId: string) => {
    for (const seller of quote?.sellers ?? []) {
      const line = seller.lines.find((l) => l.productId === productId);
      if (line) return line;
    }
    return null;
  };

  const hasIssues = (quote?.issues.length ?? 0) > 0;
  const canCheckout = Boolean(user) && items.length > 0 && !hasIssues && !loading;

  return (
    <PublicLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-10" data-testid="cart-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            {t('cart.title')} {count > 0 && <span className="text-slate-400">({count})</span>}
          </h1>
          {lines.length > 0 && (
            <button type="button" onClick={clear} className="text-sm text-slate-500 hover:text-red-600" data-testid="cart-clear">
              {t('cart.clear')}
            </button>
          )}
        </div>

        {lines.length === 0 ? (
          <Card className="mt-6 p-8 text-center" testId="cart-empty">
            <p className="text-slate-700">{t('cart.empty')}</p>
            <p className="mt-1 text-sm text-slate-400">{t('cart.emptyHint')}</p>
            <Link to="/marketplace" className="btn-primary mt-4 inline-flex">{t('cart.browse')}</Link>
          </Card>
        ) : (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-3">
              {lines.map((line) => {
                const q = quotedLine(line.productId);
                const issue = issuesByProduct.get(line.productId);
                const unitPrice = q?.unitPrice ?? line.price;
                const currency = quote?.currencyCode ?? line.currencyCode;
                const lineTotal = q?.lineTotal ?? String(Number(unitPrice) * line.quantity);
                const maxAvailable = q?.available;
                return (
                  <Card key={line.productId} className="p-3 sm:p-4" testId="cart-line">
                    <div className="flex gap-3">
                      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                        {(q?.image ?? line.image) ? (
                          <img src={(q?.image ?? line.image) as string} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <Link to={`/products/${line.productId}`} className="block truncate font-medium text-slate-800 hover:text-wasit-700">
                          {q?.name ?? line.name}
                        </Link>
                        <p className="text-xs text-slate-400" data-testid="cart-line-price">
                          {formatMoney(unitPrice, currency)}
                          {line.sellerType ? ` · ${line.sellerType}` : ''}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <div className="inline-flex items-center rounded-lg border border-slate-200">
                            <button
                              type="button"
                              className="h-8 w-8 text-slate-600 hover:text-wasit-700"
                              aria-label={t('cart.decrease')}
                              onClick={() => setQuantity(line.productId, line.quantity - 1)}
                            >
                              −
                            </button>
                            <input
                              type="number"
                              className="h-8 w-14 border-x border-slate-200 text-center text-sm"
                              min={q?.moq ?? line.moq ?? 1}
                              value={line.quantity}
                              onChange={(e) => setQuantity(line.productId, Number(e.target.value) || 1)}
                              aria-label={t('common.quantity')}
                              data-testid="cart-line-qty"
                            />
                            <button
                              type="button"
                              className="h-8 w-8 text-slate-600 hover:text-wasit-700"
                              aria-label={t('cart.increase')}
                              onClick={() => setQuantity(line.productId, line.quantity + 1)}
                            >
                              +
                            </button>
                          </div>
                          <button
                            type="button"
                            className="text-xs text-slate-500 hover:text-red-600"
                            onClick={() => remove(line.productId)}
                            data-testid="cart-line-remove"
                          >
                            {t('cart.remove')}
                          </button>
                        </div>
                        {q && q.moq > 1 && (
                          <p className="mt-1 text-xs text-slate-400">{t('cart.moq')}: {q.moq}</p>
                        )}
                        {typeof maxAvailable === 'number' && !issue && (
                          <p className="mt-1 text-xs text-slate-400" data-testid="cart-line-available">
                            {t('cart.available')}: {maxAvailable}
                          </p>
                        )}
                        {issue && (
                          <p className="mt-1 text-xs text-red-600" role="alert" data-testid="cart-line-issue" data-code={issue.code}>
                            {issue.code === 'INSUFFICIENT_STOCK'
                              ? `${t('cart.outOfStock')}${typeof issue.available === 'number' ? ` (${t('cart.available')}: ${issue.available})` : ''}`
                              : issue.code === 'MOQ_VIOLATION'
                                ? `${t('cart.moq')}: ${issue.moq ?? ''}`
                                : issue.code === 'PRODUCT_UNAVAILABLE' || issue.code === 'PRODUCT_NOT_FOUND'
                                  ? t('cart.unavailable')
                                  : t('cart.currencyMismatch')}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-end">
                        <p className="font-semibold text-slate-800" data-testid="cart-line-total" data-value={lineTotal}>
                          {formatMoney(lineTotal, currency)}
                        </p>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <Card className="h-fit p-4" testId="cart-summary">
              <h2 className="text-sm font-semibold text-slate-700">{t('cart.summary')}</h2>
              {!user ? (
                <p className="mt-3 text-xs text-slate-500" data-testid="cart-guest-note">{t('cart.signInForTotals')}</p>
              ) : loading && !quote ? (
                <div className="mt-3"><Spinner /></div>
              ) : quote ? (
                <dl className="mt-3 space-y-1 text-sm" data-testid="cart-totals">
                  <div className="flex justify-between text-slate-600">
                    <dt>{t('cart.itemsTotal')}</dt>
                    <dd data-testid="cart-items-total" data-value={quote.itemsTotal}>{formatMoney(quote.itemsTotal, quote.currencyCode ?? '')}</dd>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <dt>{t('order.buyerCommission')}</dt>
                    <dd>{formatMoney(quote.commissionBuyer, quote.currencyCode ?? '')}</dd>
                  </div>
                  {Number(quote.paymentFee) > 0 && (
                    <div className="flex justify-between text-xs text-slate-500">
                      <dt>{t('order.fee')}</dt>
                      <dd>{formatMoney(quote.paymentFee, quote.currencyCode ?? '')}</dd>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold text-slate-900">
                    <dt>{t('order.grandTotal')}</dt>
                    <dd data-testid="cart-grand-total" data-value={quote.grandTotal}>{formatMoney(quote.grandTotal, quote.currencyCode ?? '')}</dd>
                  </div>
                  <div className="flex justify-between text-xs text-slate-400">
                    <dt>{t('cart.sellers')}</dt>
                    <dd data-testid="cart-seller-count">{quote.sellerCount}</dd>
                  </div>
                </dl>
              ) : null}
              {error && <p className="mt-3 rounded bg-red-50 p-2 text-xs text-red-600" role="alert">{error}</p>}
              {hasIssues && (
                <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-700" data-testid="cart-issues">
                  {t('cart.fixIssues')}
                </p>
              )}
              <div className="mt-4 space-y-2">
                <Link
                  to={canCheckout ? '/checkout?cart=1' : '/cart'}
                  aria-disabled={!canCheckout}
                  onClick={(e) => { if (!canCheckout) e.preventDefault(); }}
                  className={`btn-primary w-full text-center ${canCheckout ? '' : 'pointer-events-none opacity-50'}`}
                  data-testid="cart-checkout"
                >
                  {t('cart.checkout')}
                </Link>
                <Link to="/marketplace" className="block text-center text-xs text-slate-500 hover:text-wasit-700">
                  {t('cart.continueShopping')}
                </Link>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{t('cart.priceNote')}</p>
            </Card>
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
