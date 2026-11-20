import { describe, it, expect } from 'vitest';
import {
  classifyListing,
  normalizeForMatch,
  isPublishable,
  GOODS_RULES,
} from '../src/lib/prohibited-goods.js';

/**
 * LC-03 — the prohibited/restricted goods classifier, in isolation.
 *
 * These are the framework-free halves of the policy: normalisation (evasion
 * resistance) and classification (severity precedence). No database is touched.
 */
describe('LC-03 normalizeForMatch', () => {
  it('folds case, latin diacritics and Arabic letter variants to one form', () => {
    expect(normalizeForMatch('  CAFÉ  ')).toBe('cafe');
    // أ / إ / آ all fold to ا, and ة folds to ه.
    expect(normalizeForMatch('أسلحة')).toBe(normalizeForMatch('اسلحه'));
  });

  it('defeats letter-spacing, punctuation and zero-width characters', () => {
    expect(normalizeForMatch('m-a-r-i\u200Bjuana')).toBe('m a r ijuana'.replace(/ /g, ' ').trim());
    expect(normalizeForMatch('m-a-r-i-juana')).toContain('juana');
    // Intra-word punctuation/space must not hide a token.
    expect(normalizeForMatch('g.u.n')).toBe('g u n');
  });
});

describe('LC-03 classifyListing', () => {
  it('allows ordinary B2B goods', () => {
    const c = classifyListing({ name: 'Premium Organic Olive Oil 5L', description: 'Cold pressed, pallet of 48' });
    expect(c.severity).toBe('ALLOWED');
    expect(isPublishable(c)).toBe(true);
  });

  it('flags weapons and ammunition as prohibited', () => {
    expect(classifyListing({ name: 'AK-47 rifle' }).severity).toBe('PROHIBITED');
    expect(classifyListing({ name: '9mm ammunition bulk' }).severity).toBe('PROHIBITED');
    expect(classifyListing({ nameAr: 'أسلحة وذخيرة' }).severity).toBe('PROHIBITED');
  });

  it('flags controlled substances as prohibited', () => {
    expect(classifyListing({ description: 'wholesale cocaine' }).severity).toBe('PROHIBITED');
    expect(classifyListing({ name: 'marijuana seeds' }).severity).toBe('PROHIBITED');
  });

  it('flags licensed/regulated goods as restricted (review, not rejection)', () => {
    expect(classifyListing({ name: 'Imported French wine' }).severity).toBe('RESTRICTED');
    expect(classifyListing({ name: 'prescription antibiotic' }).severity).toBe('RESTRICTED');
    expect(classifyListing({ name: 'Fireworks display pack' }).severity).toBe('RESTRICTED');
  });

  it('lets the strictest match win regardless of field order', () => {
    // A listing that mentions both a restricted and a prohibited term is prohibited.
    const c = classifyListing({ name: 'wine', description: 'contains cocaine' });
    expect(c.severity).toBe('PROHIBITED');
    expect(c.ruleId).toBe('drugs.controlled');
  });

  it('matches only whole tokens, so a benign word is not a false positive', () => {
    expect(classifyListing({ name: 'Beginner gun-safety course book' }).severity).toBe('ALLOWED');
    expect(classifyListing({ name: 'Started a new business' }).severity).toBe('ALLOWED');
  });

  it('inspects extra free text (variants, image alt text, specs)', () => {
    const c = classifyListing({
      name: 'Assorted goods',
      extraTexts: ['variant: 12 gauge ammunition'],
    });
    expect(c.severity).toBe('PROHIBITED');
  });

  it('has no duplicate rule ids and every rule carries a reason', () => {
    const ids = GOODS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of GOODS_RULES) expect(r.reason.length).toBeGreaterThan(0);
  });
});
