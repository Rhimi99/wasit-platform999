import { describe, it, expect } from 'vitest';
import { LOCALES, translate } from '../src/lib/i18n';

/**
 * M2.3-T2 — the seller-suborder settlement surface's translation contract.
 *
 * The Admin Finance Desk's re-processing panel must never fall back to a raw key
 * in any locale; these cases pin that, mirroring the legal-surface contract.
 */
const M23_KEYS = [
  'adminFin.suborder.heading',
  'adminFin.suborder.hint',
  'adminFin.suborder.orderId',
  'adminFin.suborder.orderIdPlaceholder',
  'adminFin.suborder.none',
  'adminFin.submit.reconcile',
  'adminFin.notice.reconciled',
] as const;

describe('M2.3-T2 — seller suborder settlement i18n', () => {
  it('every M2.3 key is translated in all four locales (no raw-key fallback)', () => {
    for (const { code } of LOCALES) {
      for (const key of M23_KEYS) {
        const value = translate(code, key);
        expect(value, `${code} / ${key}`).toBeTruthy();
        expect(value, `${code} / ${key}`).not.toBe(key);
      }
    }
  });
});
