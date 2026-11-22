import { describe, expect, it } from 'vitest';
import { buildAss, planRenderSlides } from '../../src/lib/media/video-provider.js';
import type { RenderSpec } from '../../src/lib/media/video-types.js';

/**
 * The Marketing Video agent shows a plan; the renderer draws one. Both read the
 * same slide list (`planRenderSlides`), so a plan can never describe a video the
 * renderer would not produce.
 */

const baseSpec: RenderSpec = {
  productId: 'p-1',
  productName: 'Olive Oil 1L',
  description: 'Cold-pressed extra virgin olive oil from Sfax.',
  brand: 'WASIT',
  price: '24.5000',
  currencyCode: 'TND',
  sellerName: 'Sfax Groves',
  imageUrl: null,
  language: 'en',
  audience: 'B2B',
  style: 'MODERN',
  durationSeconds: 60,
};

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({ ...baseSpec, ...over });

describe('AI — marketing video render plan', () => {
  it('lays out four contiguous slides covering the whole duration', () => {
    for (const duration of [35, 60, 120]) {
      const slideSeconds = duration / 4;
      const slides = planRenderSlides(spec({ durationSeconds: duration }), slideSeconds);
      expect(slides).toHaveLength(4);
      expect(slides.map((s) => s.index)).toEqual([1, 2, 3, 4]);
      expect(slides[0].startSeconds).toBe(0);
      expect(slides[3].endSeconds).toBe(duration);
      for (let i = 1; i < slides.length; i += 1) {
        expect(slides[i].startSeconds).toBe(slides[i - 1].endSeconds);
      }
      for (const slide of slides) {
        expect(slide.lines.length).toBeGreaterThan(0);
        expect(slide.lines.every((line) => line.trim().length > 0)).toBe(true);
      }
    }
  });

  it('carries the product, price, seller and audience into the right slides', () => {
    const slides = planRenderSlides(spec(), 15);
    expect(slides[0].lines).toEqual(['New on WASIT', 'Olive Oil 1L']);
    expect(slides[1].lines[0]).toContain('Cold-pressed');
    expect(slides[2].lines).toEqual(['24.5000 TND', 'Sfax Groves']);
    expect(slides[3].lines).toEqual(['For businesses', 'Order now on WASIT']);
  });

  it('uses the B2C audience copy and falls back to the product name', () => {
    const slides = planRenderSlides(spec({ audience: 'B2C', price: null, sellerName: null }), 15);
    expect(slides[2].lines).toEqual(['Olive Oil 1L']);
    expect(slides[3].lines[0]).toBe('For customers');
  });

  it('uses Arabic copy for an Arabic video', () => {
    const slides = planRenderSlides(spec({ language: 'ar' }), 15);
    expect(slides[0].lines[0]).toBe('جديد على وسيط');
    expect(slides[3].lines[1]).toBe('اطلب الآن عبر وسيط');
  });

  it('renders the price/seller slide with a real ASS line break, not a literal \\N', () => {
    const ass = buildAss(spec(), 720, 1280, 15);
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(4);
    // Slide 3 is the price/seller card: two lines joined by one ASS `\N`.
    expect(dialogues[2]).toContain('24.5000 TND\\NSfax Groves');
    // `\\N` (an escaped backslash followed by N) would print the characters.
    expect(ass).not.toContain('\\\\N');
  });
});
