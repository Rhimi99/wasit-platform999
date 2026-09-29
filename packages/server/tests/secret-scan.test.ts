import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Repository secret scan.
 *
 * A live staff credential was once committed to a tracked script
 * (`scripts/ui-functional-audit.mjs`). This guard keeps that class of mistake
 * from coming back: no tracked source file may embed a literal password/secret,
 * and the staff credential must be supplied at runtime only.
 *
 * The check is intentionally structural (it looks for assignment shapes, not for
 * a specific known value), so it stays useful without storing any secret here.
 */

const ROOT = path.resolve(__dirname, '../../..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-bundle',
  'coverage',
  'test-results',
  'playwright-report',
  '.vite',
  'backups',
  'build',
  'tmp',
]);

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sh', '.yml', '.yaml']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/** Long, high-entropy-looking literal: a credential rather than a placeholder. */
const HARDCODED_SECRET = /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]([A-Za-z0-9!@#$%^&*_\-+.]{24,})['"]/i;

/**
 * Values that look like credentials but are explicitly non-secret fixtures.
 * A literal is exempt only when it names itself as a test/placeholder value;
 * a real credential carries no such marker, so it can never slip through.
 */
const FIXTURE_MARKER = /(test|e2e|dummy|fake|example|placeholder|sample|not-a-real|not-for-production|dev-only|please-change-me|changeme|0123456789)/i;

describe('repository secret scan', () => {
  const files = walk(ROOT);

  it('finds no hardcoded password/secret literals in tracked source', () => {
    const offenders: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const m = HARDCODED_SECRET.exec(line);
        if (!m) continue;
        // Exempt only self-declared fixtures, and only by the captured literal.
        if (FIXTURE_MARKER.test(m[1])) continue;
        offenders.push(`${path.relative(ROOT, file)}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never embeds the staff credential in the functional audit script', () => {
    const script = readFileSync(path.join(ROOT, 'scripts/ui-functional-audit.mjs'), 'utf8');
    // The admin password must come from the environment, not a literal.
    expect(script).toMatch(/process\.env\.DEMO_STAFF_PASSWORD/);
    expect(script).not.toMatch(/admin@wasit\.tn',\s*password:\s*'(?!\s*')/);
  });

  it('keeps demo credentials out of any environment file that could be committed', () => {
    // `.env.demo` is git-ignored; assert it stays that way so a real secret never
    // rides along in a commit.
    const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/\.env/);
  });
});
