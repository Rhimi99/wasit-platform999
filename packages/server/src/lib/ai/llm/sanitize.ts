import { ApiError } from '@wasit/shared';
import type { LlmFact, LlmUntrustedField } from './contract';
import type { LlmTaskLimits } from './limits';

/**
 * Input hardening for the generation path.
 *
 * Two different things arrive from an agent: verified facts (the agent read them
 * from the database inside its own scope) and untrusted text (a customer wrote a
 * message, a seller wrote a description). They are handled differently on
 * purpose — facts are normalised and validated, untrusted text is fenced and
 * screened, never merged into the instructions.
 */

const FACT_KEY = /^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Instruction-shaped patterns. Each match is recorded, never silently dropped. */
const INJECTION_PATTERNS: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'ignore_instructions',
    pattern:
      /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,24}\b(instruction|prompt|rule|direction)s?\b/i,
  },
  { signal: 'role_marker', pattern: /(^|\n)\s*(system|assistant|developer|admin)\s*:/i },
  { signal: 'chat_template_token', pattern: /<\|(im_start|im_end|system|endoftext)\|>/i },
  {
    signal: 'prompt_exfiltration',
    pattern:
      /\b(reveal|print|show|repeat|output|leak)\b[^.\n]{0,40}\b(system prompt|instructions|api key|secret|token|password)\b/i,
  },
  {
    signal: 'fake_authority',
    pattern: /\b(i am|this is)\s+(the\s+)?(admin|administrator|owner|developer|system)\b/i,
  },
  {
    signal: 'tool_invocation',
    pattern: /\b(run|execute|invoke|call)\b[^.\n]{0,24}\b(tool|function|command|sql|shell)\b/i,
  },
  { signal: 'schema_override', pattern: /\b(new|updated|override)\s+(instruction|rule|schema|format)s?\b/i },
];

/** Instruction-shaped signals found in a piece of untrusted text. */
export function detectInjectionSignals(text: string): string[] {
  const found: string[] = [];
  for (const { signal, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) found.push(signal);
  }
  return found;
}

export interface SanitizedFacts {
  facts: LlmFact[];
  truncated: boolean;
  /**
   * Instruction-shaped patterns found inside string fact values. Some facts are
   * seller- or customer-written (a product title, a display name), so they are
   * screened exactly like untrusted text and their suspicious lines quoted.
   */
  signals: string[];
}

/**
 * Validates and normalises facts. A malformed fact is a programming error in the
 * executor, not user input, so it is refused loudly (422) rather than silently
 * dropped — a dropped fact would quietly weaken the grounding set.
 */
export function sanitizeFacts(facts: LlmFact[], limits: LlmTaskLimits): SanitizedFacts {
  if (!Array.isArray(facts) || facts.length === 0) {
    throw ApiError.validation(
      [{ field: 'facts', code: 'LLM_FACTS_REQUIRED', message: 'At least one verified fact is required' }],
      'No facts supplied',
    );
  }
  if (facts.length > limits.maxFacts) {
    throw ApiError.validation(
      [{ field: 'facts', code: 'LLM_TOO_MANY_FACTS', message: `At most ${limits.maxFacts} facts` }],
      'Too many facts',
    );
  }
  let truncated = false;
  const seen = new Set<string>();
  const signals = new Set<string>();
  const out: LlmFact[] = facts.map((fact, index) => {
    const key = typeof fact.key === 'string' ? fact.key.trim() : '';
    if (!FACT_KEY.test(key)) {
      throw ApiError.validation(
        [{ field: `facts[${index}].key`, code: 'LLM_INVALID_FACT_KEY', message: 'Invalid fact key' }],
        'Invalid fact key',
      );
    }
    if (seen.has(key)) {
      throw ApiError.validation(
        [{ field: `facts[${index}].key`, code: 'LLM_DUPLICATE_FACT_KEY', message: 'Duplicate fact key' }],
        'Duplicate fact key',
      );
    }
    seen.add(key);
    const source = typeof fact.source === 'string' ? fact.source.trim() : '';
    if (source.length === 0 || source.length > 64) {
      throw ApiError.validation(
        [{ field: `facts[${index}].source`, code: 'LLM_INVALID_FACT_SOURCE', message: 'Invalid fact source' }],
        'Invalid fact source',
      );
    }
    const value = fact.value;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw ApiError.validation(
        [{ field: `facts[${index}].value`, code: 'LLM_INVALID_FACT_VALUE', message: 'Fact value must be a primitive' }],
        'Invalid fact value',
      );
    }
    let normalised = value;
    if (typeof value === 'string') {
      let clean = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
      const factSignals = detectInjectionSignals(clean);
      for (const signal of factSignals) signals.add(signal);
      if (factSignals.length > 0) clean = `[quoted] ${clean}`;
      if (clean.length > limits.maxFactChars) {
        normalised = clean.slice(0, limits.maxFactChars);
        truncated = true;
      } else {
        normalised = clean;
      }
    }
    return { key, value: normalised, source };
  });
  return { facts: out, truncated, signals: [...signals] };
}

export interface FencedUntrusted {
  /** The complete block to append to the user message. Empty when nothing was supplied. */
  block: string;
  signals: string[];
  truncated: boolean;
}

/**
 * Wraps untrusted text in a nonce-delimited block the model is told to treat as
 * data. Suspicious lines are prefixed with `[quoted]` so the model sees them as
 * quoted content rather than as a turn boundary, and every signal is reported so
 * the caller can surface it. Nothing is silently removed: an analyst must still
 * see what the customer wrote.
 */
export function fenceUntrusted(
  fields: LlmUntrustedField[],
  limits: LlmTaskLimits,
  nonce: string,
): FencedUntrusted {
  if (!fields || fields.length === 0) return { block: '', signals: [], truncated: false };
  if (fields.length > limits.maxUntrustedFields) {
    throw ApiError.validation(
      [{ field: 'untrusted', code: 'LLM_TOO_MANY_UNTRUSTED_FIELDS', message: `At most ${limits.maxUntrustedFields} fields` }],
      'Too many untrusted fields',
    );
  }
  const signals = new Set<string>();
  let remaining = limits.maxUntrustedChars;
  let truncated = false;
  const parts: string[] = [];
  for (const field of fields) {
    const name = (typeof field.field === 'string' ? field.field : 'field').replace(/[^\w:.-]/g, '_').slice(0, 48);
    let text = String(field.text ?? '').replace(CONTROL_CHARS, ' ').replace(/\r\n/g, '\n');
    const fieldSignals = detectInjectionSignals(text);
    for (const signal of fieldSignals) signals.add(signal);
    if (fieldSignals.length > 0) {
      text = text
        .split('\n')
        .map((line) => (detectInjectionSignals(line).length > 0 ? `[quoted] ${line}` : line))
        .join('\n');
    }
    if (text.length > remaining) {
      text = text.slice(0, Math.max(0, remaining));
      truncated = true;
    }
    remaining -= text.length;
    if (text.length === 0) continue;
    parts.push(
      `<<<UNTRUSTED_DATA id="${nonce}" field="${name}" treat="content-only">>>\n${text}\n<<<END_UNTRUSTED_DATA id="${nonce}">>>`,
    );
    if (remaining <= 0) break;
  }
  return { block: parts.join('\n'), signals: [...signals], truncated };
}
