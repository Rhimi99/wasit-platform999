import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Locale key guard for `packages/web/src/lib/i18n.ts`.
 *
 * N6: `common.date` existed in ar/en/fr but was missing from zh, so the admin
 * finance payout list (and any other `common.date` caller) fell back to English
 * on the Chinese locale. This test pins the key in all four locales so a missing
 * translation fails here rather than surfacing as an English word in the UI.
 *
 * DB-free: it parses the source file, like `secret-scan.test.ts` does for the
 * repository. The file is the single authority `translate()` reads at runtime.
 */

const I18N = path.resolve(__dirname, '../../web/src/lib/i18n.ts');
const SOURCE = readFileSync(I18N, 'utf8');

const LOCALES = ['ar', 'en', 'fr', 'zh'] as const;

/** The `const <locale>: Dict = { ... };` block for one locale, brace-matched. */
function localeBlock(locale: string): string {
  const start = SOURCE.indexOf(`const ${locale}: Dict = {`);
  if (start === -1) throw new Error(`locale block not found: ${locale}`);
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}') {
      depth--;
      if (depth === 0) return SOURCE.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated locale block: ${locale}`);
}

/** The literal value of `'<key>': '<value>',` (single- or double-quoted) in a block. */
function keyValue(block: string, key: string): string | null {
  const m = block.match(
    new RegExp(`'${key.replace('.', '\\.')}':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`),
  );
  return m ? (m[1] ?? m[2]) : null;
}

describe('i18n — common.date across locales', () => {
  it('exists in all four locales', () => {
    for (const locale of LOCALES) {
      expect(keyValue(localeBlock(locale), 'common.date'), locale).not.toBeNull();
    }
  });

  it('carries a real translation (not empty or the raw key) per locale', () => {
    for (const locale of LOCALES) {
      const value = keyValue(localeBlock(locale), 'common.date');
      expect(value, locale).toBeTruthy();
      expect(value, locale).not.toBe('common.date');
    }
  });

  it('pins the Chinese label fixed by N6 and leaves the others intact', () => {
    expect(keyValue(localeBlock('ar'), 'common.date')).toBe('التاريخ');
    expect(keyValue(localeBlock('en'), 'common.date')).toBe('Date');
    expect(keyValue(localeBlock('fr'), 'common.date')).toBe('Date');
    expect(keyValue(localeBlock('zh'), 'common.date')).toBe('日期');
  });
});

/**
 * AI-02.2 — the Admin Copilot desk's keys.
 *
 * The desk is a new surface (SUPER_ADMIN only) that ships in all four locales at
 * once. A key present in ar but missing from zh would render an English fallback
 * on the Chinese UI, exactly the N6 class of bug, so the whole `adminCopilot.*`
 * namespace plus the `admin.copilot` nav label is pinned across locales here.
 */
describe('i18n — adminCopilot keys across locales', () => {
  const COPILOT_KEYS = [
    'admin.copilot',
    'adminCopilot.title',
    'adminCopilot.subtitle',
    'adminCopilot.tab.control',
    'adminCopilot.tab.tasks',
    'adminCopilot.tab.agents',
    'adminCopilot.tab.approvals',
    'adminCopilot.tab.audit',
    'adminCopilot.preview.title',
    'adminCopilot.preview.hint',
    'adminCopilot.preview.event',
    'adminCopilot.preview.button',
    'adminCopilot.preview.confirm',
    'adminCopilot.preview.cancel',
    'adminCopilot.preview.agent',
    'adminCopilot.preview.runnable',
    'adminCopilot.preview.gated',
    'adminCopilot.preview.reason',
    'adminCopilot.preview.empty',
    'adminCopilot.routed',
    'adminCopilot.skipped',
    'adminCopilot.tasks.empty',
    'adminCopilot.task.agent',
    'adminCopilot.task.type',
    'adminCopilot.task.status',
    'adminCopilot.task.cost',
    'adminCopilot.task.createdAt',
    'adminCopilot.task.actions',
    'adminCopilot.task.result',
    'adminCopilot.task.error',
    'adminCopilot.task.attempts',
    'adminCopilot.task.approve',
    'adminCopilot.task.reject',
    'adminCopilot.task.run',
    'adminCopilot.task.approved',
    'adminCopilot.agents.empty',
    'adminCopilot.agent.pause',
    'adminCopilot.agent.resume',
    'adminCopilot.agent.disable',
    'adminCopilot.approvals.empty',
    'adminCopilot.approvals.count',
    'adminCopilot.audit.empty',
    'adminCopilot.audit.action',
    'adminCopilot.audit.actor',
    'adminCopilot.audit.entity',
    'adminCopilot.audit.time',
    'adminCopilot.notice.agentStatus',
    'adminCopilot.notice.approved',
    'adminCopilot.notice.rejected',
    'adminCopilot.notice.ran',
    'adminCopilot.notice.routed',
    'common.yes',
    'common.no',
  ];

  it('exists with a real translation in all four locales', () => {
    for (const locale of LOCALES) {
      const block = localeBlock(locale);
      for (const key of COPILOT_KEYS) {
        const value = keyValue(block, key);
        expect(value, `${locale} :: ${key}`).toBeTruthy();
        expect(value, `${locale} :: ${key}`).not.toBe(key);
      }
    }
  });
});
