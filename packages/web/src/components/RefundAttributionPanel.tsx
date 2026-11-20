import { useI18n } from '@/lib/i18n-context';
import { formatDate, formatMoney } from '@/lib/api';
import { Badge, Card } from '@/components/ui';
import type { OrderRefundAttribution, RefundAttributionSeller } from '@/lib/types';
import { refundOutcomeLabelKey, refundStatusTone, sellerRefundOutcome } from '@/lib/refund-attribution';

/**
 * M2.4-T2.4 — read-only per-seller refund attribution panel (admin desk).
 *
 * Presentational only: it renders exactly what the server sent. It never
 * computes a money value, never changes order state, and offers no
 * money-moving action — issuing or completing a refund stays on the existing
 * privileged route, not here.
 */
export function RefundAttributionPanel({
  data,
  error,
  loading,
  onClose,
}: {
  data: OrderRefundAttribution | null;
  error?: string | null;
  loading?: boolean;
  onClose?: () => void;
}) {
  const { t } = useI18n();

  return (
    <Card className="mt-4" testId="admin-refund-attribution">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-slate-900">
            {t('admin.refundAttr.title')}
            {data ? ` — ${data.order.orderNumber}` : ''}
          </h3>
          <p className="mt-1 text-xs text-slate-500">{t('admin.refundAttr.hint')}</p>
          <p className="mt-1 text-xs font-medium text-slate-400" data-testid="admin-refund-attribution-readonly">
            {t('admin.refundAttr.readOnly')}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:underline">
            {t('common.cancel')}
          </button>
        )}
      </div>

      {loading && <p className="mt-3 text-sm text-slate-500">{t('common.loading')}</p>}

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert" data-testid="admin-refund-attribution-error">
          {error}
        </p>
      )}

      {data && !loading && (
        <div className="mt-3 space-y-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3" data-testid="admin-refund-attribution-order">
            <h4 className="mb-2 text-xs font-semibold text-slate-700">{t('admin.refundAttr.order.heading')}</h4>
            <dl className="grid grid-cols-2 gap-2 text-xs text-slate-700 sm:grid-cols-4">
              <div>
                <dt className="text-slate-500">{t('admin.refundAttr.order.grandTotal')}</dt>
                <dd className="font-semibold">{formatMoney(data.order.grandTotal, data.order.currencyCode)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('admin.refundAttr.order.refundedTotal')}</dt>
                <dd className="font-semibold">{formatMoney(data.order.refundedTotal, data.order.currencyCode)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('admin.refundAttr.order.remainingTotal')}</dt>
                <dd className="font-semibold">{formatMoney(data.order.remainingTotal, data.order.currencyCode)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('admin.refundAttr.order.fullyRefunded')}</dt>
                <dd>
                  <Badge color={data.order.fullyRefunded ? 'green' : 'slate'}>
                    {data.order.fullyRefunded ? t('common.yes') : t('common.no')}
                  </Badge>
                </dd>
              </div>
            </dl>
          </div>

          {data.legacy ? (
            <p className="text-xs text-slate-500" data-testid="admin-refund-attribution-legacy">
              {t('admin.refundAttr.legacy')}
            </p>
          ) : (
            <div data-testid="admin-refund-attribution-sellers">
              <h4 className="mb-2 text-xs font-semibold text-slate-700">{t('admin.refundAttr.sellers.heading')}</h4>
              <ul className="space-y-3">
                {data.sellers.map((seller) => (
                  <SellerRow key={seller.sellerOrderId} seller={seller} currencyCode={data.order.currencyCode} />
                ))}
              </ul>
            </div>
          )}

          <div data-testid="admin-refund-attribution-refunds">
            <h4 className="mb-2 text-xs font-semibold text-slate-700">{t('admin.refundAttr.refunds.heading')}</h4>
            {data.refunds.length === 0 ? (
              <p className="text-xs text-slate-500">{t('admin.refundAttr.noRefunds')}</p>
            ) : (
              <ul className="space-y-2">
                {data.refunds.map((refund) => (
                  <li
                    key={refund.id}
                    data-testid={`admin-refund-attribution-refund-${refund.id}`}
                    className="rounded-md border border-slate-200 p-2 text-xs text-slate-700"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{formatMoney(refund.amount, refund.currencyCode)}</span>
                      <Badge color={refundStatusTone(refund.status)}>{refund.status}</Badge>
                      <Badge color={refund.status === 'COMPLETED' ? 'green' : 'slate'}>
                        {refund.status === 'COMPLETED'
                          ? t('admin.refundAttr.refund.counted')
                          : t('admin.refundAttr.refund.notCounted')}
                      </Badge>
                    </div>
                    <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                      <div>
                        <dt className="text-slate-400">{t('admin.refundAttr.refund.reason')}</dt>
                        <dd>{refund.reason ?? '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">{t('admin.refundAttr.refund.externalRef')}</dt>
                        <dd dir="ltr">{refund.externalRef ?? t('admin.refundAttr.refund.none')}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">{t('admin.refundAttr.refund.createdAt')}</dt>
                        <dd>{formatDate(refund.createdAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">{t('admin.refundAttr.refund.updatedAt')}</dt>
                        <dd>{formatDate(refund.updatedAt)}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-slate-400">{t('admin.refundAttr.refund.allocatedTo')}</dt>
                        <dd dir="ltr" className="font-mono">
                          {refund.allocatedTo.length > 0 ? refund.allocatedTo.join(', ') : '—'}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function SellerRow({ seller, currencyCode }: { seller: RefundAttributionSeller; currencyCode: string }) {
  const { t } = useI18n();
  const outcome = sellerRefundOutcome(seller);

  return (
    <li
      data-testid={`admin-refund-attribution-seller-${seller.sellerOrderId}`}
      className="rounded-md border border-slate-200 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-slate-700">{seller.sellerOrderNumber}</span>
        <Badge
          color={outcome === 'FULL' ? 'green' : outcome === 'PARTIAL' ? 'amber' : 'slate'}
          testId={`admin-refund-attribution-outcome-${seller.sellerOrderId}`}
        >
          {t(refundOutcomeLabelKey(outcome))}
        </Badge>
        <Badge color={refundStatusTone(seller.status)}>{seller.status}</Badge>
        <span className="text-xs text-slate-400">
          {t('admin.refundAttr.seller.settlement')}: {seller.settlementStatus}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-700 sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">{t('admin.refundAttr.seller.cap')}</dt>
          <dd className="font-semibold">{formatMoney(seller.refundableCap, currencyCode)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('admin.refundAttr.seller.refunded')}</dt>
          <dd className="font-semibold" data-testid={`admin-refund-attribution-refunded-${seller.sellerOrderId}`}>
            {formatMoney(seller.refundedAmount, currencyCode)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('admin.refundAttr.seller.remaining')}</dt>
          <dd className="font-semibold">{formatMoney(seller.remainingAmount, currencyCode)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('admin.refundAttr.seller.commission')}</dt>
          <dd>{formatMoney(seller.sellerCommission, currencyCode)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('admin.refundAttr.seller.commissionReversed')}</dt>
          <dd data-testid={`admin-refund-attribution-reversed-${seller.sellerOrderId}`}>
            {formatMoney(seller.sellerCommissionReversed, currencyCode)}
          </dd>
        </div>
      </dl>

      {seller.lineItems.length > 0 && (
        <div className="mt-2 text-xs text-slate-600">
          <span className="text-slate-400">{t('admin.refundAttr.seller.lineItems')}: </span>
          <span dir="ltr" className="font-mono">
            {seller.lineItems
              .map((line) => `${line.orderItemId} (${formatMoney(line.refundedAmount, currencyCode)})`)
              .join(', ')}
          </span>
        </div>
      )}

      {seller.refunds.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">{t('admin.refundAttr.seller.noRefunds')}</p>
      ) : (
        <ul className="mt-2 space-y-1" data-testid={`admin-refund-attribution-seller-refunds-${seller.sellerOrderId}`}>
          {seller.refunds.map((refund) => (
            <li key={refund.refundId} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="font-semibold">{formatMoney(refund.amount, currencyCode)}</span>
              <Badge color={refundStatusTone(refund.status)}>{refund.status}</Badge>
              <span className="text-slate-400">{formatDate(refund.createdAt)}</span>
              {refund.reason && <span>— {refund.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
