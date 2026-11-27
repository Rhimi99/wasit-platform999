import { describe, expect, it } from 'vitest';
import { MARKETING_VIDEO_DURATION } from '@wasit/shared';
import { buildVideoScript, ctaFor, type ProductFacts } from '../../src/lib/media/video-script.js';
import { fitTitle, planTimeline, wrapForSubtitle } from '../../src/lib/media/marketing-video.js';
import type { VideoLanguage } from '../../src/lib/media/tts.js';

const FACTS: ProductFacts = {
  name: 'Café Arabica 1kg',
  brand: 'Maison Tunis',
  description: 'Café en grains torréfié artisanalement, emballé sous vide pour préserver les arômes.',
  price: '42.500',
  currencyCode: 'TND',
  sellerName: 'Maison Tunis',
};

const LANGUAGES: VideoLanguage[] = ['ar', 'ar-TN', 'fr', 'en', 'zh'];

describe('marketing video script', () => {
  it('writes five scenes that end on the call to action', () => {
    for (const language of LANGUAGES) {
      const script = buildVideoScript({ language, objective: 'SALES', audience: 'B2C', facts: FACTS });
      expect(script.scenes.map((s) => s.kind)).toEqual(['hook', 'value', 'detail', 'trust', 'cta']);
      expect(script.scenes[4].headline).toBe(ctaFor(language));
      expect(script.scenes[4].voiceover).toContain(ctaFor(language));
      expect(script.scenes.every((s) => s.voiceover.trim().length > 10)).toBe(true);
    }
  });

  it('states only numbers that exist in the product data', () => {
    const source = [FACTS.name, FACTS.brand, FACTS.description, FACTS.price, FACTS.currencyCode].join(' ');
    const allowed = new Set((source.match(/\d+(?:[.,]\d+)?/g) ?? []).flatMap((n) => [n, n.replace(',', '.'), n.replace('.', ',')]));
    for (const language of LANGUAGES) {
      const script = buildVideoScript({ language, objective: 'SALES', audience: 'B2C', facts: FACTS });
      const text = script.scenes.map((s) => s.voiceover).join(' ');
      for (const number of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
        expect(allowed.has(number), `${language}: ${number} is not in the product data`).toBe(true);
      }
    }
  });

  it('does not invent a discount, a rating or a delivery promise', () => {
    const script = buildVideoScript({ language: 'en', objective: 'SALES', audience: 'B2C', facts: FACTS });
    const text = script.scenes.map((s) => s.voiceover).join(' ').toLowerCase();
    for (const claim of ['free', 'discount', '%', 'stars', 'rating', 'guarantee', 'fastest', 'best price']) {
      expect(text).not.toContain(claim);
    }
  });

  it('writes Tunisian Arabic for ar-TN and MSA for ar', () => {
    const tunisian = buildVideoScript({ language: 'ar-TN', objective: 'SALES', audience: 'B2C', facts: FACTS });
    const msa = buildVideoScript({ language: 'ar', objective: 'SALES', audience: 'B2C', facts: FACTS });

    expect(tunisian.dialect).toBe('TUNISIAN');
    expect(msa.dialect).toBe('MSA');
    const tunisianText = tunisian.scenes.map((s) => s.voiceover).join(' ');
    expect(['توا', 'توّا', 'تنجّم', 'علاش', 'باش', 'إلّي'].filter((m) => tunisianText.includes(m)).length).toBeGreaterThan(2);
    expect(msa.scenes.map((s) => s.voiceover).join(' ')).not.toContain('تنجّم');
  });

  it('localises the objective and the audience without changing the facts', () => {
    const launch = buildVideoScript({ language: 'fr', objective: 'LAUNCH', audience: 'B2B', facts: FACTS });
    const sales = buildVideoScript({ language: 'fr', objective: 'SALES', audience: 'B2C', facts: FACTS });
    expect(launch.scenes[0].voiceover).not.toBe(sales.scenes[0].voiceover);
    for (const script of [launch, sales]) {
      expect(script.facts.map((f) => f.value)).toContain('42.500');
      expect(script.facts.map((f) => f.value)).toContain('TND');
    }
  });
});

describe('marketing video timeline', () => {
  const script = buildVideoScript({ language: 'en', objective: 'SALES', audience: 'B2C', facts: FACTS });

  it('never goes below the 35s floor, even with no voice', () => {
    const plan = planTimeline(script, new Map(), 20);
    expect(plan.totalSeconds).toBeGreaterThanOrEqual(MARKETING_VIDEO_DURATION.min - 0.01);
  });

  it('never exceeds the 120s ceiling', () => {
    const plan = planTimeline(script, new Map(), 500);
    expect(plan.totalSeconds).toBeLessThanOrEqual(MARKETING_VIDEO_DURATION.max + 0.01);
  });

  it('gives each scene room for its real voice length', () => {
    const voice = new Map([
      [1, 4],
      [2, 6],
      [3, 7],
      [4, 5],
      [5, 3],
    ]);
    const plan = planTimeline(script, voice, 60);
    for (const scene of plan.scenes) {
      const spoken = voice.get(scene.index) ?? 0;
      expect(scene.voiceoverDurationSeconds).toBe(spoken);
      expect(scene.voiceoverStartSeconds).toBeGreaterThanOrEqual(scene.startSeconds);
      expect(scene.voiceoverStartSeconds + spoken).toBeLessThanOrEqual(scene.endSeconds + 0.01);
      expect(scene.durationSeconds).toBeGreaterThanOrEqual(spoken);
    }
    expect(plan.totalSeconds).toBeCloseTo(60, 0);
  });

  it('keeps the closing scene long enough to read the CTA', () => {
    const plan = planTimeline(script, new Map(), 35);
    expect(plan.scenes[plan.scenes.length - 1].durationSeconds).toBeGreaterThanOrEqual(4.5);
  });
});

describe('subtitle and title fitting', () => {
  it('wraps Latin copy to the subtitle width', () => {
    const lines = wrapForSubtitle(
      'Tous les détails utiles sont affichés sur la fiche produit, avant votre achat.',
      34,
      'fr',
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 34)).toBe(true);
  });

  it('wraps Chinese by glyph because it has no spaces', () => {
    const lines = wrapForSubtitle('购买前即可在产品页面看到所有需要的详细信息。', 8, 'zh');
    expect(lines.every((line) => line.length <= 8)).toBe(true);
    expect(lines.join('')).toBe('购买前即可在产品页面看到所有需要的详细信息。');
  });

  it('shrinks a long headline instead of letting it clip', () => {
    const size = fitTitle('Ce qui le distingue vraiment de tout le reste', 98, 620, 'fr', 1280);
    expect(size).toBeLessThan(98);
    expect(size).toBeGreaterThanOrEqual(Math.round(1280 / 28));
  });

  it('leaves a short headline at full size', () => {
    expect(fitTitle('Prix', 98, 620, 'fr', 1280)).toBe(98);
  });
});
