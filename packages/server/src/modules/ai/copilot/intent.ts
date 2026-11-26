import type { CopilotIntent, CopilotLocale } from './types';
import { COPILOT_DOMAIN_RULES } from './domains';

/**
 * Deterministic request understanding (the Local Heuristic half of the Copilot).
 *
 * It never calls a model and never guesses a missing fact. It answers three
 * questions the planner actually needs: what is the objective, which domains were
 * named, and is the request too vague to act on. Everything it extracts is
 * echoed back in the report so the General Manager can see what was understood.
 */

/** Constraint markers, per language. A sentence carrying one is a constraint. */
const CONSTRAINT_MARKERS: Record<CopilotLocale, string[]> = {
  ar: ['بدون', 'دون', 'لا ', 'بحد أقصى', 'حد أقصى', 'خلال', 'قبل', 'فقط', 'ممنوع'],
  fr: ['sans', 'ne pas', 'au plus', 'maximum', 'avant', 'uniquement', 'interdit'],
  en: ['without', 'do not', "don't", 'at most', 'maximum', 'within', 'before', 'only', 'must not'],
};

/** Output markers: a sentence naming one of these is an expected deliverable. */
const OUTPUT_MARKERS: Record<CopilotLocale, string[]> = {
  ar: ['تقرير', 'قائمة', 'ملخص', 'توصية', 'توصيات', 'خطة', 'تحليل'],
  fr: ['rapport', 'liste', 'résumé', 'resume', 'recommandation', 'plan', 'analyse'],
  en: ['report', 'list', 'summary', 'summarise', 'summarize', 'recommendation', 'plan', 'analysis'],
};

export function detectLocale(text: string): CopilotLocale {
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const letters = (text.match(/[A-Za-z\u0600-\u06FF]/g) ?? []).length || 1;
  if (arabic / letters > 0.3) return 'ar';
  const french = /\b(le|la|les|des|du|une|un|et|pour|avec|sur|dans|sans|nous|vous|je)\b/i.test(text);
  const accents = /[àâçéèêëîïôûùüÿœ]/i.test(text);
  if (french && (accents || /\b(rapport|ventes|marché|analyse|produits?)\b/i.test(text))) return 'fr';
  return 'en';
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/[\n.!?؟؛;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Domains named in the request, in catalogue order, never duplicated. */
export function detectSignals(text: string): string[] {
  const haystack = normalise(text);
  const hits: string[] = [];
  for (const rule of COPILOT_DOMAIN_RULES) {
    const keywords = [...rule.keywords.ar, ...rule.keywords.fr, ...rule.keywords.en];
    if (keywords.some((k) => haystack.includes(normalise(k)))) hits.push(rule.signal);
  }
  return hits;
}

/** One-line objective: the first sentence, bounded, without trailing noise. */
function extractGoal(text: string): string {
  const first = splitSentences(text)[0] ?? text.trim();
  const cleaned = first.replace(/\s+/g, ' ').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

function collectMarkers(
  sentences: string[],
  markers: Record<CopilotLocale, string[]>,
  locale: CopilotLocale,
): string[] {
  const list = markers[locale];
  const out: string[] = [];
  for (const sentence of sentences) {
    const low = normalise(sentence);
    if (!list.some((m) => low.includes(normalise(m)))) continue;
    const clipped = sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
    if (!out.includes(clipped)) out.push(clipped);
  }
  return out.slice(0, 10);
}

export function parseIntent(rawText: string, forcedLocale?: CopilotLocale): CopilotIntent {
  const text = rawText.trim();
  const locale = forcedLocale ?? detectLocale(text);
  const sentences = splitSentences(text);
  const signals = detectSignals(text);
  const goal = extractGoal(text);
  const constraints = collectMarkers(sentences, CONSTRAINT_MARKERS, locale);
  const expectedOutputs = collectMarkers(sentences, OUTPUT_MARKERS, locale);

  // Clarify only when the gap changes the plan: nothing recognisable to act on,
  // or a request too short to carry an object. A recognisable request is never
  // blocked on a missing detail the coordinator can state as an assumption.
  // Nothing recognised means nothing to delegate: that is a real gap, whatever
  // the length of the request. A recognised request is never blocked on a
  // missing detail the coordinator can state as an assumption.
  const needsClarification = signals.length === 0;

  return {
    goal: goal || text.slice(0, 200),
    constraints,
    expectedOutputs,
    locale,
    needsClarification,
    clarificationQuestion: needsClarification
      ? clarificationQuestionFor(locale)
      : null,
    signals,
  };
}

export function clarificationQuestionFor(locale: CopilotLocale): string {
  if (locale === 'ar') {
    return 'ما الهدف المحدد الذي تريد متابعته (المبيعات، الدعم، المنتجات، المخاطر…) وما الفترة الزمنية؟';
  }
  if (locale === 'fr') {
    return "Quel domaine voulez-vous suivre (ventes, support, produits, risques…) et sur quelle période ?";
  }
  return 'Which area should I look at (sales, support, products, risk…) and over which period?';
}
