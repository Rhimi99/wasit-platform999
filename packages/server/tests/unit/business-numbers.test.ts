import { describe, it, expect } from 'vitest';
import { generateBusinessNumber, generateOrderNumber, generateTransactionNumber } from '../../src/lib/ids';

// Drawing n values from the 36^8 suffix space is a birthday problem: the
// expected number of collisions is n(n-1)/(2*36^8), i.e. ~0.002 at 100k draws
// and ~0.04 at 500k. Demanding zero collisions would fail ~4% of runs against a
// correct generator, so allow a small tolerance — it still catches the real
// regression by an enormous margin (a 1296-value suffix space yields ~1296
// distinct numbers, not ~500k).
const COLLISION_TOLERANCE = 10;

describe('business document numbers', () => {
  it('is unique across many draws on the same day', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(generateBusinessNumber('ORD'));
    expect(seen.size).toBeGreaterThanOrEqual(100_000 - COLLISION_TOLERANCE);
  });

  it('does not collide when many issuers share a day prefix', () => {
    // Regression: the old suffix had only 1296 random values plus a per-process
    // counter, so a fresh process could reissue a document number another process
    // already used, failing the unique index as a 500 on order creation.
    const date = new Date('2026-09-21T00:00:00Z');
    const seen = new Set<string>();
    for (let i = 0; i < 500_000; i++) seen.add(generateBusinessNumber('TXN', date));
    expect(seen.size).toBeGreaterThanOrEqual(500_000 - COLLISION_TOLERANCE);
  });

  it('keeps the human-friendly ORD/TXN prefixes and stays within the column width', () => {
    const ord = generateOrderNumber();
    const txn = generateTransactionNumber();
    expect(ord).toMatch(/^ORD-\d{6}-[0-9A-Z]{8}$/);
    expect(txn).toMatch(/^TXN-\d{6}-[0-9A-Z]{8}$/);
    expect(ord.length).toBeLessThanOrEqual(40);
  });
});
