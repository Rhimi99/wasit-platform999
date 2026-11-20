import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/lib/i18n-context';
import { Card } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { formatMoney } from '@/lib/api';
import { DEFAULT_RATES, computeBusiness, type CalculatorRates } from '@/lib/business-calculator';

function parseNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

interface RateFieldProps {
  id: string;
  label: string;
  value: number;
  suffix: string;
  onChange: (v: number) => void;
  testId: string;
}

function RateField({ id, label, value, suffix, onChange, testId }: RateFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={testId}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.1"
          dir="ltr"
          className="input"
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(parseNumber(e.target.value))}
        />
        <span className="shrink-0 text-sm text-slate-500">{suffix}</span>
      </div>
    </div>
  );
}

export function BusinessCalculatorPage() {
  const { t } = useI18n();
  const [price, setPrice] = useState('100');
  const [quantity, setQuantity] = useState('1');
  const [rates, setRates] = useState<CalculatorRates>(DEFAULT_RATES);

  const priceNum = parseNumber(price);
  const quantityNum = parseNumber(quantity);
  const result = useMemo(
    () => computeBusiness(priceNum, quantityNum, rates),
    [priceNum, quantityNum, rates],
  );

  const setRate = (key: keyof CalculatorRates) => (v: number) =>
    setRates((r) => ({ ...r, [key]: v }));

  const rows: Array<{ key: string; label: string; value: number; emphasis?: boolean }> = result
    ? [
        { key: 'itemsTotal', label: t('calc.itemsTotal'), value: result.itemsTotal },
        { key: 'sellerCommission', label: t('calc.sellerCommission'), value: -result.sellerCommission },
        { key: 'paymentFee', label: t('calc.paymentFee'), value: -result.paymentFee },
        { key: 'buyerCommission', label: t('calc.buyerCommission'), value: result.buyerCommission },
      ]
    : [];

  return (
    <PublicLayout>
      <SeoHead title={`${t('calc.title')} · WASIT`} description={t('calc.subtitle')} />
      <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">{t('calc.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">{t('calc.subtitle')}</p>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-6" testId="calc-inputs">
            <h2 className="text-lg font-bold text-slate-900">{t('calc.inputsTitle')}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="calc-price" className="label">{t('calc.pricePerUnit')}</label>
                <input
                  id="calc-price"
                  data-testid="calc-price"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  dir="ltr"
                  className="input"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="calc-quantity" className="label">{t('calc.quantity')}</label>
                <input
                  id="calc-quantity"
                  data-testid="calc-quantity"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step="1"
                  dir="ltr"
                  className="input"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            </div>

            <p className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-400">{t('calc.ratesTitle')}</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <RateField
                id="calc-seller-rate"
                testId="calc-seller-rate"
                label={t('calc.sellerCommissionRate')}
                value={rates.sellerCommissionRate}
                suffix="%"
                onChange={setRate('sellerCommissionRate')}
              />
              <RateField
                id="calc-buyer-rate"
                testId="calc-buyer-rate"
                label={t('calc.buyerCommissionRate')}
                value={rates.buyerCommissionRate}
                suffix="%"
                onChange={setRate('buyerCommissionRate')}
              />
              <RateField
                id="calc-fee-rate"
                testId="calc-fee-rate"
                label={t('calc.paymentFeeRate')}
                value={rates.paymentFeeRate}
                suffix="%"
                onChange={setRate('paymentFeeRate')}
              />
              <RateField
                id="calc-fee-flat"
                testId="calc-fee-flat"
                label={t('calc.paymentFeeFlat')}
                value={rates.paymentFeeFlat}
                suffix={t('calc.currency')}
                onChange={setRate('paymentFeeFlat')}
              />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-400">{t('calc.ratesNote')}</p>
          </Card>

          <Card className="p-6" testId="calc-results">
            <h2 className="text-lg font-bold text-slate-900">{t('calc.resultsTitle')}</h2>
            {result ? (
              <>
                <dl className="mt-4 space-y-3">
                  {rows.map((r) => (
                    <div key={r.key} className="flex items-center justify-between gap-4 text-sm">
                      <dt className="text-slate-600">{r.label}</dt>
                      <dd className="font-medium tabular-nums text-slate-800" dir="ltr">{formatMoney(r.value)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-5 space-y-3 border-t border-slate-200 pt-5">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-sm font-semibold text-slate-700">{t('calc.buyerTotal')}</dt>
                    <dd data-testid="calc-buyer-total" className="text-base font-bold tabular-nums text-slate-900" dir="ltr">
                      {formatMoney(result.buyerTotal)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-sm font-semibold text-slate-700">{t('calc.sellerNet')}</dt>
                    <dd data-testid="calc-seller-net" className="text-base font-bold tabular-nums text-teal-700" dir="ltr">
                      {formatMoney(result.sellerNet)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-sm text-slate-600">{t('calc.wasitGross')}</dt>
                    <dd data-testid="calc-wasit-gross" className="text-sm tabular-nums text-slate-700" dir="ltr">
                      {formatMoney(result.wasitGross)}
                      <span className="ms-2 text-xs text-slate-400">({result.effectiveRate}%)</span>
                    </dd>
                  </div>
                </div>
              </>
            ) : (
              <p data-testid="calc-invalid" className="mt-4 text-sm text-red-600">{t('calc.invalid')}</p>
            )}
            <p className="mt-6 text-xs leading-relaxed text-slate-400">{t('calc.disclaimer')}</p>
            <p className="mt-4 text-sm">
              <Link to="/marketplace" className="text-brand-700 hover:underline">{t('nav.marketplace')}</Link>
            </p>
          </Card>
        </div>
      </div>
    </PublicLayout>
  );
}
