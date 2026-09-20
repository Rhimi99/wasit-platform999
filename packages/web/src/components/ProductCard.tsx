import { Link } from 'react-router-dom';
import type { ProductSummary } from '@/lib/types';
import { formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge } from './ui';

export function ProductCard({ product, compact = false }: { product: ProductSummary; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      to={`/products/${product.id}`}
      className={`card group flex flex-col overflow-hidden transition-shadow hover:shadow-md ${compact ? 'p-3' : 'p-0'}`}
    >
      {product.image ? (
        <img src={product.image} alt={product.name} className="h-40 w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-40 w-full items-center justify-center bg-slate-100 text-slate-400">
          {t('product.noImage')}
        </div>
      )}
      <div className="flex flex-1 flex-col p-3">
        <div className="mb-1 flex items-center gap-2">
          {product.purchaseIntent && (
            <Badge color="indigo">{product.purchaseIntent === 'B2B' ? 'B2B' : 'B2C'}</Badge>
          )}
          <span className="text-xs text-slate-400">{product.sellerType}</span>
        </div>
        <h3 className="line-clamp-2 text-sm font-semibold text-slate-800 group-hover:text-wasit-700">
          {product.name}
        </h3>
        {product.brand && <p className="text-xs text-slate-400">{product.brand}</p>}
        <div className="mt-auto flex items-baseline justify-between pt-2">
          <span className="text-base font-bold text-wasit-700">{formatMoney(product.basePrice, product.currencyCode)}</span>
          {product.moq ? (
            <span className="text-xs text-slate-400">{t('marketplace.moq')}: {product.moq}</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}