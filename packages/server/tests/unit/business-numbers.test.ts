import { describe, it, expect } from 'vitest';
import { generateBusinessNumber, generateOrderNumber, generateTransactionNumber } from '../../src/lib/ids';

describe('business document numbers', () => {
  it('is unique across many draws on the same day', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(generateBusinessNumber('ORD'));
    expect(seen.size).toBe(100_000);
  });

  it('does not collide when many issuers share a day prefix', () => {
    // Regression: the old suffix had only 1296 random values plus a per-process
    // counter, so a fresh process could reissue a document number another process
    // already used, failing the unique index as a 500 on order creation.
    const date = new Date('2026-09-21T00:00:00Z');
    const seen = new Set<string>();
    for (let i = 0; i < 500_000; i++) seen.add(generateBusinessNumber('TXN', date));
    expect(seen.size).toBe(500_000);
  });

  it('keeps the human-friendly ORD/TXN prefixes and stays within the column width', () => {
    const ord = generateOrderNumber();
    const txn = generateTransactionNumber();
    expect(ord).toMatch(/^ORD-\d{6}-[0-9A-Z]{8}$/);
    expect(txn).toMatch(/^TXN-\d{6}-[0-9A-Z]{8}$/);
    expect(ord.length).toBeLessThanOrEqual(40);
  });
});
