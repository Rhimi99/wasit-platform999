import type { LlmDraftOutput, LlmFact } from './contract';

/**
 * Grounding: the rule that a generated sentence may not introduce a fact.
 *
 * A language model is useful for phrasing, not for arithmetic. So every claim it
 * makes has to point at a fact the executor actually read from the database, and
 * every money-shaped number it writes has to already exist in those facts. An
 * unsupported amount is not "probably fine": it is a fabricated price, stock
 * level or commission, and it makes the draft unusable.
 */

/** Digits-only normalisation so `1,200.50 TND` and `1200.50` compare equal. */
function normaliseNumber(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (cleaned.length === 0) return '';
  const [whole, ...rest] = cleaned.split('.');
  const fraction = rest.join('').slice(0, 4).replace(/0+$/, '');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  return fraction.length > 0 ? `${trimmedWhole}.${fraction}` : trimmedWhole;
}

/**
 * Every numeric value the facts can legitimately support, normalised.
 *
 * `moneyOnly` keeps just the string-valued facts. Money columns are read from
 * PostgreSQL `numeric` and therefore arrive as strings, while counts arrive as
 * numbers — so a currency-marked figure can only be grounded by a money column,
 * and a count of 1 can never be promoted into a price of 1 TND.
 */
export function groundedNumbers(facts: LlmFact[], moneyOnly = false): Set<string> {
  const out = new Set<string>();
  for (const fact of facts) {
    if (typeof fact.value === 'number' && Number.isFinite(fact.value)) {
      if (!moneyOnly) out.add(normaliseNumber(String(fact.value)));
    } else if (typeof fact.value === 'string') {
      const n = normaliseNumber(fact.value);
      if (n.length > 0 && /\d/.test(fact.value)) out.add(n);
    }
  }
  return out;
}

/**
 * Money-shaped tokens in generated text: a currency marker next to a number, or
 * any number with four or more digits (an amount, not a count of days or steps).
 * Small plain integers ("3 issues") are deliberately allowed — pinning every
 * small number would make normal prose impossible and would not protect a price.
 */
export function extractAmounts(text: string): { currency: string[]; plain: string[] } {
  const currency = new Set<string>();
  const plain = new Set<string>();
  const marked = /(?:TND|USD|EUR|DT|\$|€|£)\s?\d[\d.,]*|\d[\d.,]*\s?(?:TND|USD|EUR|DT|\$|€|£)/gi;
  for (const m of text.matchAll(marked)) currency.add(m[0]);
  for (const m of text.matchAll(/\d[\d,]{3,}(?:\.\d+)?/g)) {
    if (![...currency].some((c) => c.includes(m[0]))) plain.add(m[0]);
  }
  return { currency: [...currency], plain: [...plain] };
}

export interface AmountCheck {
  supported: string[];
  unsupported: string[];
}

/** Splits the amounts in `text` into ones the facts support and ones they do not. */
export function checkAmounts(text: string, facts: LlmFact[]): AmountCheck {
  const anyFact = groundedNumbers(facts);
  const moneyFact = groundedNumbers(facts, true);
  const supported: string[] = [];
  const unsupported: string[] = [];
  const { currency, plain } = extractAmounts(text);
  for (const raw of currency) {
    const n = normaliseNumber(raw);
    if (n.length === 0) continue;
    if (moneyFact.has(n)) supported.push(raw);
    else unsupported.push(raw);
  }
  for (const raw of plain) {
    const n = normaliseNumber(raw);
    if (n.length === 0) continue;
    if (anyFact.has(n)) supported.push(raw);
    else unsupported.push(raw);
  }
  return { supported, unsupported };
}

export interface EvidenceCheck {
  accepted: { key: string; value: string; source: string }[];
  rejected: { key: string; reason: 'unknown_key' | 'value_mismatch' }[];
}

/** Accepts an evidence entry only when it names a supplied fact and repeats its value. */
export function checkEvidence(
  evidence: LlmDraftOutput['evidence'],
  facts: LlmFact[],
): EvidenceCheck {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const accepted: EvidenceCheck['accepted'] = [];
  const rejected: EvidenceCheck['rejected'] = [];
  for (const entry of evidence) {
    const fact = byKey.get(entry.key);
    if (!fact) {
      rejected.push({ key: entry.key, reason: 'unknown_key' });
      continue;
    }
    const expected = fact.value === null ? '' : String(fact.value);
    const same =
      expected.trim() === entry.value.trim() ||
      (expected.length > 0 && normaliseNumber(expected) === normaliseNumber(entry.value));
    if (!same) {
      rejected.push({ key: entry.key, reason: 'value_mismatch' });
      continue;
    }
    accepted.push({ key: entry.key, value: expected, source: fact.source });
  }
  return { accepted, rejected };
}

/**
 * The facts block the model reads. Rendered as explicit `key = value (source)`
 * lines rather than raw JSON so a long fact cannot be mistaken for a nested
 * instruction object.
 */
export function renderFacts(facts: LlmFact[]): string {
  return facts
    .map((f) => `${f.key} = ${f.value === null ? '(none)' : String(f.value)} (source: ${f.source})`)
    .join('\n');
}
