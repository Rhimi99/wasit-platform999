import { describe, it, expect } from 'vitest';
import { calculateScenario } from '../../src/modules/revenue/service.js';
import type { ScenarioInput } from '../../src/modules/revenue/types.js';

const base: ScenarioInput = {
  transactionVolume: '0',
  commissionRate: '0',
  paymentFeeRate: '0',
  expectedOrders: '0',
  avgOrderValue: '0',
  subscriptionRevenue: '0',
  advertisingRevenue: '0',
  aiCosts: '0',
  operationalExpenses: '0',
  refundRate: '0',
  currencyCode: 'TND',
};

describe('calculateScenario (pure simulation)', () => {
  it('computes gross revenue from volume x commission rate (percent input)', () => {
    const r = calculateScenario({ ...base, transactionVolume: '100000', commissionRate: '3' });
    expect(r.grossRevenue).toBe('3000.0000');
    expect(r.totalCosts).toBe('0.0000');
    expect(r.netRevenue).toBe('3000.0000');
    expect(r.contributionMargin).toBe('100.0000');
  });

  it('adds subscription and advertising to gross revenue', () => {
    const r = calculateScenario({
      ...base,
      transactionVolume: '100000',
      commissionRate: '3',
      subscriptionRevenue: '500',
      advertisingRevenue: '250',
    });
    expect(r.grossRevenue).toBe('3750.0000');
  });

  it('sums payment fees, refunds, AI costs and operational expenses into total costs', () => {
    const r = calculateScenario({
      ...base,
      transactionVolume: '100000',
      commissionRate: '3',
      paymentFeeRate: '2',
      refundRate: '0.5',
      aiCosts: '100',
      operationalExpenses: '400',
    });
    // costs = 2000 (payment) + 500 (refund) + 100 (ai) + 400 (opex) = 3000
    expect(r.totalCosts).toBe('3000.0000');
    expect(r.netRevenue).toBe('0.0000');
  });

  it('computes contribution margin as net / gross revenue percent', () => {
    const r = calculateScenario({
      ...base,
      transactionVolume: '10000',
      commissionRate: '10', // gross = 1000
      operationalExpenses: '250',
    });
    expect(r.grossRevenue).toBe('1000.0000');
    expect(r.netRevenue).toBe('750.0000');
    expect(r.contributionMargin).toBe('75.0000');
  });

  it('returns a 0% margin when gross revenue is zero', () => {
    const r = calculateScenario({ ...base, operationalExpenses: '100' });
    expect(r.grossRevenue).toBe('0.0000');
    expect(r.contributionMargin).toBe('0.0000');
    expect(r.netRevenue).toBe('-100.0000');
  });

  it('carries the currency into the explanatory comment', () => {
    const r = calculateScenario({ ...base, currencyCode: 'EUR' });
    expect(r.comment).toContain('EUR');
  });
});