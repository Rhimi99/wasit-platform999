import type { PayloadRule } from './types';

/**
 * Payload signatures.
 *
 * Pure functions: they answer "does this text look like an attempt" and nothing
 * else. A hit is a signal to be correlated, never a block — the route's own
 * validation and the database driver's parameterisation remain the actual
 * defence, and WCDC does not pretend otherwise.
 *
 * The evidence returned is the *pattern name* only. The payload itself is never
 * stored or logged: it may contain a password, a token or a customer's data, and
 * a security tool must not become the leak.
 */

export interface PayloadHit {
  rule: PayloadRule;
  pattern: string;
  field: 'path' | 'query' | 'body';
}

type Signature = { rule: PayloadRule; pattern: string; test: RegExp };

const SIGNATURES: readonly Signature[] = [
  // SQL injection
  { rule: 'SQL_INJECTION', pattern: 'union-select', test: /\bunion\b[\s\S]{0,30}\bselect\b/i },
  // A quote before the operator is what separates `' OR 1=1` from prose such as
  // "and 5 = 5 pieces available".
  { rule: 'SQL_INJECTION', pattern: 'quoted-tautology', test: /['"]\s*(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i },
  { rule: 'SQL_INJECTION', pattern: 'or-one-equals-one', test: /\bor\s+1\s*=\s*1\b/i },
  { rule: 'SQL_INJECTION', pattern: 'stacked-drop', test: /;\s*drop\s+(table|database|schema)\b/i },
  { rule: 'SQL_INJECTION', pattern: 'time-based', test: /\b(pg_sleep|sleep|benchmark)\s*\(\s*\d+/i },
  { rule: 'SQL_INJECTION', pattern: 'catalog-probe', test: /\b(information_schema|pg_catalog|pg_shadow|pg_authid)\b/i },
  { rule: 'SQL_INJECTION', pattern: 'shell-extension', test: /\bxp_cmdshell\b/i },

  // Cross-site scripting
  { rule: 'XSS', pattern: 'script-tag', test: /<\s*script[\s>]/i },
  { rule: 'XSS', pattern: 'iframe-tag', test: /<\s*iframe[\s>]/i },
  { rule: 'XSS', pattern: 'js-uri', test: /javascript\s*:/i },
  { rule: 'XSS', pattern: 'event-handler', test: /\bon(error|load|mouseover|focus|submit)\s*=/i },
  { rule: 'XSS', pattern: 'svg-onload', test: /<\s*svg[\s\S]{0,40}onload/i },
  { rule: 'XSS', pattern: 'cookie-theft', test: /document\s*\.\s*cookie/i },

  // Path traversal / command injection
  { rule: 'PATH_TRAVERSAL', pattern: 'dot-dot-slash', test: /(\.\.[\\/]){2,}/ },
  { rule: 'PATH_TRAVERSAL', pattern: 'encoded-traversal', test: /(%2e%2e|%252e%252e)[%/\\]/i },
  { rule: 'PATH_TRAVERSAL', pattern: 'etc-passwd', test: /\/etc\/(passwd|shadow)/i },
  { rule: 'PATH_TRAVERSAL', pattern: 'shell-chain', test: /[;&|]\s*(cat|ls|rm|curl|wget|nc|bash|sh|python)\s+/i },
  { rule: 'PATH_TRAVERSAL', pattern: 'command-substitution', test: /\$\([^)]+\)|`[^`]{2,}`/ },
];

/** Decodes percent-escapes once so an encoded attempt is still read as text. */
export function decodeForScan(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Longest value the scanner will look at; a body beyond this is not inspected. */
export const MAX_SCAN_CHARS = 8_192;

export function scanValue(value: string, field: PayloadHit['field']): PayloadHit[] {
  if (!value || value.length > MAX_SCAN_CHARS * 4) return [];
  const decoded = decodeForScan(value).slice(0, MAX_SCAN_CHARS);
  const hits: PayloadHit[] = [];
  for (const signature of SIGNATURES) {
    if (signature.test.test(decoded)) {
      hits.push({ rule: signature.rule, pattern: signature.pattern, field });
    }
  }
  return hits;
}

export interface RequestPayload {
  path: string;
  query: string;
  body?: string | null;
}

/** Scans every user-controlled part of a request once, de-duplicated by rule. */
export function scanRequest(payload: RequestPayload): PayloadHit[] {
  const hits: PayloadHit[] = [
    ...scanValue(payload.path, 'path'),
    ...scanValue(payload.query, 'query'),
    ...(payload.body ? scanValue(payload.body, 'body') : []),
  ];
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.rule}:${hit.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
