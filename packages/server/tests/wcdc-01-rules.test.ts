import { describe, expect, it } from 'vitest';
import { decodeForScan, scanRequest, scanValue } from '../src/lib/wcdc/signatures';
import {
  FORBIDDEN_ACTIONS,
  RESPONSE_ACTION_TYPES,
  SECURITY_RULES,
  fingerprintOf,
  isForbiddenAction,
  isResponseActionType,
  postureLevel,
  riskScore,
} from '../src/lib/wcdc/types';
import { ACTION_SPECS } from '../src/lib/wcdc/response';

/**
 * WCDC-01 — detection signatures and authority limits, without a database.
 *
 * Two properties matter as much as detection: a normal Arabic/French sentence
 * must not be flagged, and the action catalogue must not contain a way for the
 * system to change its own authority.
 */

function rulesIn(value: string): string[] {
  return scanValue(value, 'query').map((hit) => hit.rule);
}

describe('WCDC payload signatures', () => {
  it('detects SQL injection attempts', () => {
    expect(rulesIn("1 UNION SELECT password FROM users")).toContain('SQL_INJECTION');
    expect(rulesIn("' OR 1=1 --")).toContain('SQL_INJECTION');
    expect(rulesIn("1; drop table users")).toContain('SQL_INJECTION');
    expect(rulesIn("1 and pg_sleep(5)")).toContain('SQL_INJECTION');
    expect(rulesIn('select * from information_schema.tables')).toContain('SQL_INJECTION');
  });

  it('detects cross-site scripting payloads', () => {
    expect(rulesIn('<script>alert(1)</script>')).toContain('XSS');
    expect(rulesIn('javascript:alert(document.cookie)')).toContain('XSS');
    expect(rulesIn('<img src=x onerror=alert(1)>')).toContain('XSS');
    expect(rulesIn('<svg onload=alert(1)>')).toContain('XSS');
  });

  it('detects path traversal and command injection', () => {
    expect(rulesIn('../../etc/passwd')).toContain('PATH_TRAVERSAL');
    expect(rulesIn('%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toContain('PATH_TRAVERSAL');
    expect(rulesIn('file.txt; cat /etc/passwd')).toContain('PATH_TRAVERSAL');
    expect(rulesIn('$(whoami)')).toContain('PATH_TRAVERSAL');
  });

  it('decodes an encoded payload before matching', () => {
    expect(decodeForScan('%3Cscript%3E')).toBe('<script>');
    expect(decodeForScan('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('does not flag ordinary Arabic, French or English text', () => {
    const benign = [
      'زيت زيتون بكر ممتاز 5 لتر - تونس',
      "L'huile d'olive vierge extra, récolte 2026 — 5 litres",
      'Ordinateur portable or argent, écran 15"',
      'and 5 = 5 pieces available',
      'price < 100 and quantity > 2',
      'قال لي: اشترِ 3 وخذ 4',
      'search?q=café&sort=price_desc&page=2',
      'select a category from the list',
    ];
    for (const text of benign) {
      expect(rulesIn(text), text).toEqual([]);
    }
  });

  it('scans path, query and body once each and de-duplicates by rule', () => {
    const hits = scanRequest({
      path: '/api/search',
      query: 'q=<script>alert(1)</script>',
      body: JSON.stringify({ title: '<script>x</script>' }),
    });
    expect(hits.filter((h) => h.rule === 'XSS')).toHaveLength(1);
    expect(hits[0].field).toBe('query');
  });

  it('ignores a body larger than the scan ceiling instead of truncating it into a miss', () => {
    const huge = 'a'.repeat(40_000) + '<script>alert(1)</script>';
    expect(scanValue(huge, 'body')).toEqual([]);
  });
});

describe('WCDC risk and posture', () => {
  it('keeps the score inside 0..100 and grows with repetition', () => {
    const once = riskScore({ severity: 'HIGH', eventCount: 1, status: 'OPEN' });
    const many = riskScore({ severity: 'HIGH', eventCount: 500, status: 'OPEN' });
    expect(once).toBeGreaterThanOrEqual(60);
    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThanOrEqual(100);
    expect(riskScore({ severity: 'CRITICAL', eventCount: 10_000, status: 'OPEN' })).toBeLessThanOrEqual(100);
  });

  it('maps a score to a posture level', () => {
    expect(postureLevel(0)).toBe('CALM');
    expect(postureLevel(25)).toBe('ELEVATED');
    expect(postureLevel(55)).toBe('HIGH');
    expect(postureLevel(80)).toBe('CRITICAL');
  });

  it('produces a stable fingerprint and separates different subjects', () => {
    expect(fingerprintOf(['a', 'b'])).toBe(fingerprintOf(['a', 'b']));
    expect(fingerprintOf(['a', 'b'])).not.toBe(fingerprintOf(['a', 'c']));
  });
});

describe('WCDC authority limits', () => {
  it('names every rule with a usable threshold and window', () => {
    for (const rule of Object.values(SECURITY_RULES)) {
      expect(rule.threshold).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThan(0);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(rule.severity);
    }
  });

  it('only allows request-level containment to run automatically', () => {
    const autoEligible = RESPONSE_ACTION_TYPES.filter((action) => ACTION_SPECS[action].autoEligible);
    expect(autoEligible.sort()).toEqual(['BLOCK_IP', 'RATE_LIMIT_TIGHTEN']);
    for (const action of ['REVOKE_SESSION', 'QUARANTINE_ASSET', 'AI_KILL_SWITCH'] as const) {
      expect(ACTION_SPECS[action].requiresApproval).toBe(true);
      expect(ACTION_SPECS[action].autoEligible).toBe(false);
    }
  });

  it('refuses to recognise an operation that would change its own authority', () => {
    for (const forbidden of FORBIDDEN_ACTIONS) {
      expect(isForbiddenAction(forbidden)).toBe(true);
      expect(isResponseActionType(forbidden)).toBe(false);
    }
    expect(isForbiddenAction('BLOCK_IP')).toBe(false);
    expect(isResponseActionType('BLOCK_IP')).toBe(true);
    expect(isResponseActionType('GRANT_PERMISSION')).toBe(false);
  });
});
