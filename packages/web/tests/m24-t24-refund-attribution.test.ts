import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { LOCALES, translate, type Locale } from '../src/lib/i18n';
import { I18nProvider } from '../src/lib/i18n-context';
import { RefundAttributionPanel } from '../src/components/RefundAttributionPanel';
import {
  hasUncountedRefund,
  refundOutcomeLabelKey,
  refundStatusTone,
  sellerHasNoRefunds,
  sellerRefundOutcome,
} from '../src/lib/refund-attribution';
import type { OrderRefundAttribution, RefundAttributionSeller } from '../src/lib/types';

/**
 * M2.4-T2.4 — the per-seller refund attribution surface.
 *
 * Two layers, both real (no mocks):
 *  1. the translation contract — every key the panel uses resolves in all four
 *     locales, so the admin desk never shows a raw key;
 *  2. the view model and the rendered markup — the panel classifies what the
 *     server sent (NONE / PARTIAL / FULL, counted vs not-counted) and renders the
 *     per-seller numbers verbatim. The panel is presentational, so it is rendered
 *     with `renderToStaticMarkup` (react-dom/server) rather than a DOM: the web
 *     package has no jsdom/testing-library stack, and none is needed to prove the
 *     markup — the interactive wiring is exercised by the server tests and e2e.
 */

const PANEL_KEYS = [
  'admin.refundAttr.title',
  'admin.refundAttr.hint',
  'admin.refundAttr.readOnly',
  'admin.refundAttr.error',
  'admin.refundAttr.legacy',
  'admin.refundAttr.noRefunds',
  'admin.refundAttr.order.heading',
  'admin.refundAttr.order.grandTotal',
  'admin.refundAttr.order.refundedTotal',
  'admin.refundAttr.order.remainingTotal',
  'admin.refundAttr.order.fullyRefunded',
  'admin.refundAttr.sellers.heading',
  'admin.refundAttr.seller.status',
  'admin.refundAttr.seller.settlement',
  'admin.refundAttr.seller.cap',
  'admin.refundAttr.seller.refunded',
  'admin.refundAttr.seller.remaining',
  'admin.refundAttr.seller.commission',
  'admin.refundAttr.seller.commissionReversed',
  'admin.refundAttr.seller.fullyRefunded',
  'admin.refundAttr.seller.partial',
  'admin.refundAttr.seller.none',
  'admin.refundAttr.seller.lineItems',
  'admin.refundAttr.seller.noRefunds',
  'admin.refundAttr.refunds.heading',
  'admin.refundAttr.refund.amount',
  'admin.refundAttr.refund.status',
  'admin.refundAttr.refund.counted',
  'admin.refundAttr.refund.notCounted',
  'admin.refundAttr.refund.reason',
  'admin.refundAttr.refund.externalRef',
  'admin.refundAttr.refund.createdAt',
  'admin.refundAttr.refund.updatedAt',
  'admin.refundAttr.refund.allocatedTo',
  'admin.refundAttr.refund.none',
  'common.yes',
  'common.no',
  'common.cancel',
  'common.loading',
] as const;

function render(node: ReactNode, locale: Locale = 'en'): string {
  // `I18nProvider` reads localStorage inside a `useState` initialiser; guard it so
  // the provider can mount under react-dom/server where `window` is absent, and
  // seed the requested locale (the provider defaults to Arabic otherwise).
  const g = globalThis as unknown as { window?: { localStorage: { getItem: (k: string) => string | null; setItem: () => void } } };
  g.window = { localStorage: { getItem: () => locale, setItem: () => {} } };
  return renderToStaticMarkup(createElement(I18nProvider, null, node));
}

function seller(over: Partial<RefundAttributionSeller> = {}): RefundAttributionSeller {
  return {
    sellerOrderId: 'sub-1',
    sellerOrderNumber: 'ORD-1-S1',
    sellerId: 'seller-1',
    sellerType: 'SUPPLIER',
    status: 'DELIVERED',
    settlementStatus: 'PENDING',
    refundableCap: '10.2000',
    refundedAmount: '0.0000',
    remainingAmount: '10.2000',
    sellerCommission: '0.2000',
    sellerCommissionReversed: '0.0000',
    fullyRefunded: false,
    lineItems: [],
    refunds: [],
    ...over,
  };
}

const sample: OrderRefundAttribution = {
  order: {
    id: 'ord-1',
    orderNumber: 'ORD-1',
    currencyCode: 'TND',
    status: 'DELIVERED',
    paymentStatus: 'PARTIALLY_REFUNDED',
    refundStatus: 'COMPLETED',
    grandTotal: '30.6000',
    refundedTotal: '5.1000',
    remainingTotal: '25.5000',
    fullyRefunded: false,
  },
  refunds: [
    {
      id: 'ref-1',
      amount: '5.1000',
      currencyCode: 'TND',
      status: 'COMPLETED',
      reason: 'damaged',
      externalRef: 'acq-ref-1',
      requestedById: 'admin-1',
      processedById: null,
      createdAt: '2026-01-02T10:00:00.000Z',
      updatedAt: '2026-01-02T11:00:00.000Z',
      allocatedTo: ['sub-1'],
    },
  ],
  sellers: [
    seller({
      refundedAmount: '5.1000',
      remainingAmount: '5.1000',
      sellerCommissionReversed: '0.1000',
      refunds: [
        {
          refundId: 'ref-1',
          status: 'COMPLETED',
          amount: '5.1000',
          counted: true,
          reason: 'damaged',
          externalRef: 'acq-ref-1',
          createdAt: '2026-01-02T10:00:00.000Z',
          updatedAt: '2026-01-02T11:00:00.000Z',
        },
      ],
    }),
    seller({
      sellerOrderId: 'sub-2',
      sellerOrderNumber: 'ORD-1-S2',
      sellerId: 'seller-2',
      refundableCap: '20.4000',
      remainingAmount: '20.4000',
      sellerCommission: '0.4000',
    }),
  ],
  legacy: false,
};

describe('M2.4-T2.4 — refund attribution i18n contract', () => {
  it('every panel key is translated in all four locales (no raw-key fallback)', () => {
    for (const { code } of LOCALES) {
      for (const key of PANEL_KEYS) {
        const value = translate(code, key);
        expect(value, `${code} / ${key}`).toBeTruthy();
        expect(value, `${code} / ${key}`).not.toBe(key);
      }
    }
  });

  it('the Arabic locale is the primary one and renders Arabic labels', () => {
    expect(translate('ar', 'admin.refundAttr.title')).toContain('استرداد');
    expect(translate('ar', 'admin.refundAttr.seller.commissionReversed')).toContain('العمولة');
  });
});

describe('M2.4-T2.4 — refund attribution view model', () => {
  it('classifies a seller with no refund rows as NONE', () => {
    const s = seller({ refunds: [] });
    expect(sellerRefundOutcome(s)).toBe('NONE');
    expect(sellerHasNoRefunds(s)).toBe(true);
    expect(refundOutcomeLabelKey('NONE')).toBe('admin.refundAttr.seller.none');
  });

  it('classifies a partially refunded seller as PARTIAL', () => {
    const s = seller({ fullyRefunded: false, refunds: [sample.sellers[0].refunds[0]] });
    expect(sellerRefundOutcome(s)).toBe('PARTIAL');
    expect(refundOutcomeLabelKey('PARTIAL')).toBe('admin.refundAttr.seller.partial');
  });

  it('classifies a fully refunded seller as FULL', () => {
    const s = seller({ fullyRefunded: true, refundedAmount: '10.2000', remainingAmount: '0.0000', refunds: [sample.sellers[0].refunds[0]] });
    expect(sellerRefundOutcome(s)).toBe('FULL');
    expect(refundOutcomeLabelKey('FULL')).toBe('admin.refundAttr.seller.fullyRefunded');
  });

  it('maps statuses to badge tones without inventing any', () => {
    expect(refundStatusTone('COMPLETED')).toBe('green');
    expect(refundStatusTone('REFUNDED')).toBe('green');
    expect(refundStatusTone('FAILED')).toBe('red');
    expect(refundStatusTone('PROCESSING')).toBe('amber');
    expect(refundStatusTone('NONE')).toBe('slate');
  });

  it('flags an order that carries a non-completed refund', () => {
    const withPending: OrderRefundAttribution = {
      ...sample,
      refunds: [{ ...sample.refunds[0], id: 'ref-2', status: 'PROCESSING' }],
    };
    expect(hasUncountedRefund(withPending)).toBe(true);
    expect(hasUncountedRefund(sample)).toBe(false);
  });
});

describe('M2.4-T2.4 — refund attribution panel rendering', () => {
  it('renders per-seller amounts and statuses from the server payload', () => {
    const html = render(createElement(RefundAttributionPanel, { data: sample }));
    expect(html).toContain('data-testid="admin-refund-attribution"');
    expect(html).toContain('admin-refund-attribution-seller-sub-1');
    expect(html).toContain('admin-refund-attribution-seller-sub-2');
    // Seller 1 shows a partial refund and a reversed commission; seller 2 none.
    expect(html).toContain('Partial refund');
    expect(html).toContain('No refund');
    // The read-only notice is always present.
    expect(html).toContain('admin-refund-attribution-readonly');
    // The refund log lists the order's refund with its external reference.
    expect(html).toContain('acq-ref-1');
    expect(html).toContain('Counted (completed)');
  });

  it('renders the legacy notice and no sellers when the order has no suborders', () => {
    const legacy: OrderRefundAttribution = { ...sample, sellers: [], legacy: true };
    const html = render(createElement(RefundAttributionPanel, { data: legacy }));
    expect(html).toContain('admin-refund-attribution-legacy');
    expect(html).not.toContain('admin-refund-attribution-sellers');
  });

  it('renders the empty-refunds message when the order has no refunds', () => {
    const none: OrderRefundAttribution = { ...sample, refunds: [] };
    const html = render(createElement(RefundAttributionPanel, { data: none }));
    expect(html).toContain('No refunds on this order.');
  });

  it('renders an error message when loading failed', () => {
    const html = render(createElement(RefundAttributionPanel, { data: null, error: 'boom' }));
    expect(html).toContain('admin-refund-attribution-error');
    expect(html).toContain('boom');
  });

  it('renders in Arabic without a raw key leaking into the markup', () => {
    const html = render(createElement(RefundAttributionPanel, { data: sample }), 'ar');
    expect(html).toContain('تخصيص الاسترداد لكل بائع');
    expect(html).not.toContain('admin.refundAttr.');
  });
});
