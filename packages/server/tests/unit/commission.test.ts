import { describe, it, expect } from 'vitest';
import { commissionForAmount, commissionSplitForAmount } from '../../src/lib/commission.js';

describe('commissionForAmount (pure)', () => {
  it('applies the rate passed in (no hardcoded rate in the engine)', () => {
    const result = commissionForAmount('1000.0000', '0.04', 'TND');
    expect(result.amount).toBe('40.0000');
    expect(result.rate).toBe('0.04');
    expect(result.currencyCode).toBe('TND');
  });

  it('honours a non-default rate coming from policy', () => {
    expect(commissionForAmount('1000.0000', '0.05', 'TND').amount).toBe('50.0000');
    expect(commissionForAmount('1000.0000', '0', 'TND').amount).toBe('0.0000');
  });

  it('rounds half-up to 4 decimals', () => {
    // 333.3333 * 0.03 = 9.999999 -> 10.0000
    expect(commissionForAmount('333.3333', '0.03', 'TND').amount).toBe('10.0000');
    // 0.0001 * 0.03 = 0.000003 -> 0.0000
    expect(commissionForAmount('0.0001', '0.03', 'TND').amount).toBe('0.0000');
  });

  it('handles large values precisely (decimal, not float)', () => {
    expect(commissionForAmount('999999999.9999', '0.03', 'TND').amount).toBe('30000000.0000');
  });

  it('carries the currency through unchanged', () => {
    expect(commissionForAmount('10', '0.03', 'EUR').currencyCode).toBe('EUR');
  });
});

describe('commissionSplitForAmount (pure)', () => {
  it('splits the base 4% into 2% seller + 2% buyer', () => {
    const r = commissionSplitForAmount('1000.0000', { total: '0.04', seller: '0.02', buyer: '0.02' }, 'TND');
    expect(r.totalAmount).toBe('40.0000');
    expect(r.sellerAmount).toBe('20.0000');
    expect(r.buyerAmount).toBe('20.0000');
    expect(r.currencyCode).toBe('TND');
  });

  it('reconciles the total as seller + buyer shares', () => {
    const r = commissionSplitForAmount('310.0000', { total: '0.04', seller: '0.02', buyer: '0.02' }, 'TND');
    const sum = (Number(r.sellerAmount) + Number(r.buyerAmount)).toFixed(4);
    expect(sum).toBe(r.totalAmount);
  });

  it('supports an asymmetric split without any hardcoded share', () => {
    const r = commissionSplitForAmount('100.0000', { total: '0.05', seller: '0.01', buyer: '0.04' }, 'EUR');
    expect(r.sellerAmount).toBe('1.0000');
    expect(r.buyerAmount).toBe('4.0000');
    expect(r.totalAmount).toBe('5.0000');
  });
});