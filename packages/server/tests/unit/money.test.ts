import { describe, it, expect } from 'vitest';
import { toDecimal, fmt, isNegative, assertNonNegative, roundMoney } from '../../src/lib/money.js';

describe('money helpers (pure)', () => {
  it('toDecimal normalizes strings and numbers without precision loss', () => {
    expect(toDecimal('0.1').plus('0.2').toString()).toBe('0.3');
    expect(toDecimal(10).toString()).toBe('10');
    expect(toDecimal('123.4500').equals('123.45')).toBe(true);
  });

  it('fmt fixes monetary values to 4 decimal places', () => {
    expect(fmt('3')).toBe('3.0000');
    expect(fmt(1.5)).toBe('1.5000');
    expect(fmt(toDecimal('12.345678'))).toBe('12.3457');
  });

  it('isNegative detects sign for each accepted input shape', () => {
    expect(isNegative('-1')).toBe(true);
    expect(isNegative('-0.0001')).toBe(true);
    expect(isNegative('0')).toBe(false);
    expect(isNegative(5)).toBe(false);
    expect(isNegative(toDecimal('-2.5'))).toBe(true);
  });

  it('assertNonNegative throws on negative and accepts zero/positive', () => {
    expect(() => assertNonNegative('-1')).toThrow();
    expect(() => assertNonNegative('0')).not.toThrow();
    expect(() => assertNonNegative(10)).not.toThrow();
  });

  it('roundMoney uses ROUND_HALF_UP at 4 decimals', () => {
    expect(roundMoney('0.00005').toFixed(4)).toBe('0.0001');
    expect(roundMoney('0.00004').toFixed(4)).toBe('0.0000');
    expect(roundMoney('2.55555').toFixed(4)).toBe('2.5556');
  });
});