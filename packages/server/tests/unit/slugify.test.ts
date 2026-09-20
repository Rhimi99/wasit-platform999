import { describe, it, expect } from 'vitest';
import { slugify } from '../../src/modules/products/service.js';

describe('slugify (pure)', () => {
  it('lowercases and hyphenates ASCII words', () => {
    expect(slugify('Olive Oil')).toBe('olive-oil');
    expect(slugify('Fresh   Tomatoes')).toBe('fresh-tomatoes');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugify('Café & Thé (Bio)!')).toBe('caf-th-bio');
    expect(slugify('---leading and trailing---')).toBe('leading-and-trailing');
  });

  it('preserves Arabic letters (U+0600–U+06FF)', () => {
    expect(slugify('زيت الزيتون')).toBe('زيت-الزيتون');
    expect(slugify('منتج عربي 100')).toBe('منتج-عربي-100');
  });

  it('caps the result at 200 characters', () => {
    const long = 'a'.repeat(300);
    expect(slugify(long).length).toBe(200);
  });

  it('returns an empty string when nothing survives normalization', () => {
    expect(slugify('!!!')).toBe('');
  });
});