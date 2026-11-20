import { describe, it, expect } from 'vitest';
import { LOCALES, translate } from '../src/lib/i18n';

/**
 * LC-01 — the public legal surface's translation contract.
 *
 * The /legal page and the footer link must never fall back to a raw key in any
 * locale; these cases pin that.
 */
const LEGAL_KEYS = [
  'nav.legal',
  'footer.legal',
  'legal.title',
  'legal.empty',
  'legal.version',
  'legal.effectiveDate',
  'legal.notInForce',
  // LC-01.1 — the acceptance surface
  'legal.navAcceptance',
  'legal.acceptanceTitle',
  'legal.acceptanceSubtitle',
  'legal.pendingTitle',
  'legal.nothingPending',
  'legal.nothingPendingHint',
  'legal.accept',
  'legal.accepted',
  'legal.historyTitle',
  'legal.noHistory',
  'legal.document',
  'legal.acceptedAt',
] as const;

describe('LC-01 — legal surface i18n', () => {
  it('every legal key is translated in all four locales (no raw-key fallback)', () => {
    for (const { code } of LOCALES) {
      for (const key of LEGAL_KEYS) {
        const value = translate(code, key);
        expect(value, `${code} / ${key}`).toBeTruthy();
        expect(value, `${code} / ${key}`).not.toBe(key);
      }
    }
  });
});
