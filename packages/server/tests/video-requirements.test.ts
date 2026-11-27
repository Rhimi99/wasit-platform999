import { describe, expect, it } from 'vitest';
import { TRANSITION_SECONDS, expectedCta, planTimeline } from '../src/lib/media/marketing-video.js';
import { resolveVoice } from '../src/lib/media/tts.js';
import type { VideoLanguage } from '../src/lib/media/tts.js';
import { buildVideoScript, type ProductFacts } from '../src/lib/media/video-script.js';

/**
 * The advert contract, checked per language without rendering a video:
 * five scenes ending on a CTA, a cut list inside 35–120 s, a voice window that
 * stays inside its scene (that is what keeps speech in sync with the picture),
 * and a Tunisian request that is refused rather than mislabelled.
 *
 * Rendering and file inspection are covered by `marketing-video.test.ts` and
 * `ai-video-agent.test.ts`, which produce real MP4s.
 */
const FACTS: ProductFacts = {
  name: 'Wasit Business Suite',
  brand: 'WASIT',
  description: 'Comptes fournisseurs, commandes et commission suivies au même endroit.',
  price: '149',
  currencyCode: 'TND',
  sellerName: 'Alpha Supplier',
};

const LANGUAGES: readonly VideoLanguage[] = ['ar', 'fr', 'en', 'zh'];

describe('marketing video requirements', () => {
  for (const language of LANGUAGES) {
    it(`plans a complete ${language} advert with a closing call to action`, () => {
      const script = buildVideoScript({ language, objective: 'SALES', audience: 'B2C', facts: FACTS });
      expect(script.language).toBe(language);
      expect(script.scenes.length).toBeGreaterThanOrEqual(4);
      expect(script.scenes[0].kind).toBe('hook');
      expect(script.scenes.at(-1)?.kind).toBe('cta');
      expect(script.scenes.at(-1)?.headline).toBe(expectedCta(language));
      for (const scene of script.scenes) {
        expect(scene.voiceover.trim().length, `scene ${scene.index} voiceover`).toBeGreaterThan(10);
      }
    });

    it(`keeps the ${language} cut list inside 35–120 s at every requested length`, () => {
      const script = buildVideoScript({ language, objective: 'SALES', audience: 'B2C', facts: FACTS });
      for (const target of [10, 35, 60, 120, 300]) {
        const plan = planTimeline(script, new Map(), target);
        expect(plan.totalSeconds).toBeGreaterThanOrEqual(35);
        expect(plan.totalSeconds).toBeLessThanOrEqual(120 + 0.001);
        for (const scene of plan.scenes) {
          expect(scene.durationSeconds).toBeGreaterThanOrEqual(scene.minSeconds);
        }
      }
    });

    it(`keeps the ${language} voice window inside its scene`, () => {
      const script = buildVideoScript({ language, objective: 'SALES', audience: 'B2C', facts: FACTS });
      const voiceSeconds = new Map(script.scenes.map((scene) => [scene.index, scene.minSeconds - 0.5]));
      const plan = planTimeline(script, voiceSeconds, 45);

      for (const scene of plan.scenes) {
        expect(scene.hasVoiceover).toBe(true);
        expect(scene.voiceoverStartSeconds).toBeGreaterThanOrEqual(scene.startSeconds);
        // Speech must finish before the scene's picture ends, otherwise the
        // voice runs over the next scene and the advert is out of sync.
        expect(scene.voiceoverStartSeconds + scene.voiceoverDurationSeconds).toBeLessThanOrEqual(
          scene.endSeconds + 1e-9,
        );
      }

      // Scenes follow each other with exactly one cross-fade and no gap.
      for (let i = 1; i < plan.scenes.length; i += 1) {
        expect(plan.scenes[i].startSeconds).toBeCloseTo(
          plan.scenes[i - 1].endSeconds - TRANSITION_SECONDS,
          6,
        );
      }
    });
  }

  it('refuses a Tunisian advert instead of passing MSA off as the dialect', () => {
    const resolved = resolveVoice('ar-TN');
    expect(resolved.voice).toBeNull();
    expect(resolved.reason).toMatch(/licensed/i);
    // The gap names the lawful alternatives, so an operator is never stuck.
    expect(resolved.reason).toMatch(/VOICE_PACK_DIR/);
    expect(resolved.reason).toMatch(/ar, fr, en or zh/);
  });
});
