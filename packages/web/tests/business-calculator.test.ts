import { describe, it, expect } from 'vitest';
import { DEFAULT_RATES, computeBusiness, round4 } from '../src/lib/business-calculator';
import { LOCALES, translate, type Locale } from '../src/lib/i18n';

/**
 * PR-05 — business calculator (isolated, no DOM, no DB).
 *
 * Pins the money model the calculator mirrors: seller commission on the
 * subtotal, buyer commission added to the buyer total, the payment fee charged
 * to the seller, and `sellerNet = subtotal − seller commission − payment fee`.
 * Also pins the i18n contract (no raw-key fallback in any of the four locales).
 */

describe('PR-05 — calculator money model', () => {
  it('splits the base 4% commission and 2% fee on a single unit', () => {
    const r = computeBusiness(100, 1, DEFAULT_RATES)!;
    expect(r.itemsTotal).toBe(100);
    expect(r.sellerCommission).toBe(2);
    expect(r.buyerCommission).toBe(2);
    expect(r.paymentFee).toBe(2);
    expect(r.buyerTotal).toBe(102);
    expect(r.sellerNet).toBe(96);
    expect(r.wasitGross).toBe(6);
    expect(r.effectiveRate).toBe(5.8824);
  });

  it('scales with quantity', () => {
    const r = computeBusiness(50, 3, DEFAULT_RATES)!;
    expect(r.itemsTotal).toBe(150);
    expect(r.sellerCommission).toBe(3);
    expect(r.paymentFee).toBe(3);
    expect(r.buyerTotal).toBe(153);
    expect(r.sellerNet).toBe(144);
    expect(r.wasitGross).toBe(9);
  });

  it('adds a flat payment fee to the seller side only', () => {
    const r = computeBusiness(100, 1, { ...DEFAULT_RATES, paymentFeeFlat: 1.5 })!;
    expect(r.paymentFee).toBe(3.5); // 2% of 100 + 1.5
    expect(r.sellerNet).toBe(94.5); // 100 − 2 − 3.5
    expect(r.buyerTotal).toBe(102); // buyer total is unaffected by the fee
  });

  it('rounds to 4 decimal places, half-up', () => {
    expect(round4(1.00005)).toBe(1.0001);
    expect(round4(2.34565)).toBe(2.3457);
    const r = computeBusiness(33.3333, 3, DEFAULT_RATES)!;
    expect(r.itemsTotal).toBe(99.9999);
  });
});

describe('PR-05 — calculator rejects inputs that cannot describe an order', () => {
  it('rejects non-positive price or quantity', () => {
    expect(computeBusiness(0, 1)).toBeNull();
    expect(computeBusiness(-5, 1)).toBeNull();
    expect(computeBusiness(10, 0)).toBeNull();
  });

  it('rejects a non-integer quantity', () => {
    expect(computeBusiness(10, 1.5)).toBeNull();
  });

  it('rejects negative rates', () => {
    expect(computeBusiness(100, 1, { ...DEFAULT_RATES, sellerCommissionRate: -1 })).toBeNull();
    expect(computeBusiness(100, 1, { ...DEFAULT_RATES, paymentFeeRate: -1 })).toBeNull();
    expect(computeBusiness(100, 1, { ...DEFAULT_RATES, paymentFeeFlat: -1 })).toBeNull();
  });

  it('rejects a fee/commission set that would leave the seller with nothing', () => {
    // 60% seller commission + 50% fee = 110% of the subtotal > items total.
    expect(
      computeBusiness(100, 1, { ...DEFAULT_RATES, sellerCommissionRate: 60, paymentFeeRate: 50 }),
    ).toBeNull();
  });
});

describe('PR-05 — calculator i18n contract', () => {
  const keys = [
    'nav.businessCalculator',
    'calc.title',
    'calc.subtitle',
    'calc.inputsTitle',
    'calc.pricePerUnit',
    'calc.quantity',
    'calc.ratesTitle',
    'calc.sellerCommissionRate',
    'calc.buyerCommissionRate',
    'calc.paymentFeeRate',
    'calc.paymentFeeFlat',
    'calc.currency',
    'calc.ratesNote',
    'calc.resultsTitle',
    'calc.itemsTotal',
    'calc.sellerCommission',
    'calc.paymentFee',
    'calc.buyerCommission',
    'calc.buyerTotal',
    'calc.sellerNet',
    'calc.wasitGross',
    'calc.invalid',
    'calc.disclaimer',
  ];

  it('every calculator key is translated in all four locales (no raw-key fallback)', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        const value = translate(locale.code, key);
        expect(value, `${locale.code}:${key}`).not.toBe(key);
        expect(value.trim().length, `${locale.code}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('Arabic is RTL and the other three are LTR', () => {
    expect(LOCALES.find((l) => l.code === 'ar')!.dir).toBe('rtl');
    for (const code of ['en', 'fr', 'zh'] as Locale[]) {
      expect(LOCALES.find((l) => l.code === code)!.dir).toBe('ltr');
    }
  });
});
