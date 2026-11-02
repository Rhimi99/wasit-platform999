import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { reconciliationDecisions, reconciliationImports } from '../src/db/schema/reconciliation.js';
import { parseReconciliationFile, RECON_FILE_LIMITS } from '../src/modules/reconciliation/file-import.js';

/**
 * PS-04 (appendix a.5-1) — reconciliation **file** import.
 *
 * Two layers are proven:
 *  1. the pure parser (format/encoding/limits/field rules), DB-free; and
 *  2. the HTTP routes, end-to-end through the real app (session → permission →
 *     service → database), proving a file can neither bypass validation nor
 *     change a financial outcome.
 */

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Layer 1 — pure parser
// ---------------------------------------------------------------------------

function parse(filename: string, content: string | Uint8Array, source: 'PROVIDER' | 'BANK' = 'PROVIDER', currencyCode = 'TND') {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return parseReconciliationFile({ filename, bytes, source, currencyCode });
}

/**
 * The parser fails with `ApiError.validation`, whose generic `message` is
 * "Validation failed" while the specific reason lives in `fieldErrors`. This
 * asserts on the human-readable field reasons, which is what an operator sees.
 */
function rejectMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as { message?: string; fieldErrors?: { message: string }[] };
    return [e.message, ...(e.fieldErrors ?? []).map((f) => f.message)].filter(Boolean).join(' | ');
  }
  throw new Error('expected the call to throw, but it returned');
}

function expectReject(fn: () => unknown, pattern: RegExp): void {
  expect(rejectMessage(fn)).toMatch(pattern);
}

describe('reconciliation file parser — accepted formats', () => {
  it('parses a valid multi-row provider CSV', () => {
    const csv = [
      'reference,grossAmount,providerFee,netAmount,settlementRef',
      'ref-1,100.0000,2.0000,98.0000,set-1',
      'ref-2,50.5000,1.0100,49.4900,set-2',
    ].join('\n');
    const parsed = parse('provider.csv', csv);
    expect(parsed.format).toBe('csv');
    expect(parsed.rowCount).toBe(2);
    expect(parsed.provider).toHaveLength(2);
    expect(parsed.provider[1]).toMatchObject({ reference: 'ref-2', grossAmount: '50.5000', netAmount: '49.4900' });
    expect(parsed.bank).toHaveLength(0);
  });

  it('parses a valid bank TSV', () => {
    const tsv = ['reference\tamount\tcurrencyCode', 'ref-1\t98.0000\tTND'].join('\n');
    const parsed = parse('bank.tsv', tsv, 'BANK');
    expect(parsed.format).toBe('tsv');
    expect(parsed.bank).toEqual([
      expect.objectContaining({ reference: 'ref-1', amount: '98.0000', currencyCode: 'TND' }),
    ]);
  });

  it('parses a valid JSON array of lines', () => {
    const json = JSON.stringify([
      { reference: 'ref-1', grossAmount: '10.0000', providerFee: '0.2000', netAmount: '9.8000' },
    ]);
    const parsed = parse('provider.json', json);
    expect(parsed.format).toBe('json');
    expect(parsed.provider[0].netAmount).toBe('9.8000');
  });

  it('honours RFC-4180 quoting and CRLF, and strips a leading BOM', () => {
    const csv = '\uFEFFreference,grossAmount,providerFee,netAmount\r\n"ref,1",100.0000,2.0000,98.0000\r\n';
    const parsed = parse('provider.csv', csv);
    expect(parsed.provider[0].reference).toBe('ref,1');
  });

  it('lets a row override the file currency and defaults to the file currency', () => {
    const csv = ['reference,grossAmount,providerFee,netAmount,currencyCode', 'a,1,0,1,EUR', 'b,1,0,1,'].join('\n');
    const parsed = parse('provider.csv', csv, 'PROVIDER', 'TND');
    expect(parsed.provider[0].currencyCode).toBe('EUR');
    expect(parsed.provider[1].currencyCode).toBe('TND');
  });
});

describe('reconciliation file parser — rejections', () => {
  it('rejects an unsupported extension', () => {
    expectReject(() => parse('statement.xlsx', 'a,b\n1,2'), /Unsupported file type/);
    expectReject(() => parse('statement', 'a,b\n1,2'), /Unsupported file type/);
  });

  it('rejects an empty file', () => {
    expectReject(() => parse('empty.csv', ''), /empty/i);
  });

  it('rejects a header-only file (no data rows)', () => {
    expectReject(() => parse('h.csv', 'reference,grossAmount,providerFee,netAmount'), /no data rows/i);
  });

  it('rejects a file that is not valid UTF-8', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x42]);
    expectReject(() => parse('bad.csv', bad), /UTF-8|binary/i);
  });

  it('rejects corrupt JSON', () => {
    expectReject(() => parse('x.json', '{not json'), /valid JSON/);
    expectReject(() => parse('x.json', '{"a":1}'), /array of lines/);
  });

  it('rejects an unterminated quoted field', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\n"a,1,2,3'), /Unterminated/);
  });

  it('rejects a missing required column', () => {
    expectReject(() => parse('x.csv', 'reference,providerFee,netAmount\nr,1,2'), /missing required column 'grossAmount'/i);
  });

  it('rejects an unknown column (e.g. an attempt to assert `settled`)', () => {
    const csv = 'reference,grossAmount,providerFee,netAmount,settled\nr,1,0,1,true';
    expectReject(() => parse('x.csv', csv), /Unknown column 'settled'/);
  });

  it('rejects a duplicate column header', () => {
    expectReject(() => parse('x.csv', 'reference,reference,grossAmount,providerFee,netAmount\nr,r,1,0,1'), /repeats column/i);
  });

  it('rejects a row with a missing reference', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\n,1,0,1'), /Reference is required/);
  });

  it('rejects a non-numeric amount', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\nr,abc,0,1'), /not a valid number/);
  });

  it('rejects a negative amount', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\nr,-1,0,1'), /negative/);
  });

  it('rejects a spreadsheet-formula reference', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\n=cmd(),1,0,1'), /formula/i);
  });

  it('rejects a bad row currency', () => {
    const csv = 'reference,grossAmount,providerFee,netAmount,currencyCode\nr,1,0,1,TNDX';
    expectReject(() => parse('x.csv', csv), /3-letter ISO code/);
  });

  it('rejects duplicate references within one file', () => {
    const csv = 'reference,grossAmount,providerFee,netAmount\nr,1,0,1\nr,2,0,2';
    expectReject(() => parse('x.csv', csv), /Duplicate reference/);
  });

  it('rejects a file over the row limit', () => {
    const header = 'reference,grossAmount,providerFee,netAmount';
    const rows = Array.from({ length: RECON_FILE_LIMITS.maxLines + 1 }, (_, i) => `r-${i},1,0,1`);
    expectReject(() => parse('big.csv', [header, ...rows].join('\n')), /more than .* rows/i);
  });

  it('rejects a file over the byte limit', () => {
    const big = 'x'.repeat(RECON_FILE_LIMITS.maxBytes + 1);
    expectReject(() => parse('big.csv', big), /exceeds the/i);
  });

  it('rejects a bad file-level currency', () => {
    expectReject(() => parse('x.csv', 'reference,grossAmount,providerFee,netAmount\nr,1,0,1', 'PROVIDER', 'TT'), 
      /3-letter ISO code/,
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — HTTP routes (real app + database)
// ---------------------------------------------------------------------------

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    cookie: () => cookie,
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.body === undefined
            ? undefined
            : options.body instanceof FormData
              ? options.body
              : JSON.stringify(options.body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function staffClient(roleName: 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `recon-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('StaffPass123!'),
    firstName: roleName,
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return c;
}

function upload(filename: string, content: string, type = 'text/csv'): FormData {
  const fd = new FormData();
  fd.set('file', new File([content], filename, { type }));
  return fd;
}

const PROVIDER_CSV = [
  'reference,grossAmount,providerFee,netAmount',
  'ref-http-1,100.0000,2.0000,98.0000',
  'ref-http-2,50.0000,1.0000,49.0000',
].join('\n');

describe('reconciliation file routes — permission', () => {
  it('refuses an unauthenticated caller', async () => {
    const c = makeClient();
    const r = await c.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('p.csv', PROVIDER_CSV),
    });
    expect(r.status).toBe(401);
  });

  it('refuses a CUSTOMER and a MERCHANT', async () => {
    for (const role of ['CUSTOMER', 'MERCHANT'] as const) {
      const c = await staffClient(role);
      const r = await c.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
        method: 'POST',
        body: upload('p.csv', PROVIDER_CSV),
      });
      expect(r.status, role).toBe(403);
    }
  });
});

describe('reconciliation file routes — preview (writes nothing)', () => {
  it('previews a valid file and classifies every row against the (empty) ledger', async () => {
    const admin = await staffClient('ADMIN');
    const before = await db.select().from(reconciliationImports);
    const r = await admin.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('p.csv', PROVIDER_CSV),
    });
    expect(r.status).toBe(200);
    expect(r.data.data.rowCount).toBe(2);
    expect(r.data.data.report.decisions).toHaveLength(2);
    // A file cannot assert a ledger fact, so every row is MISSING_IN_LEDGER —
    // i.e. MISMATCH, never a fabricated success.
    expect(r.data.data.report.mismatched).toBe(2);
    expect(r.data.data.report.decisions.every((d: { status: string }) => d.status === 'MISMATCH')).toBe(true);
    const after = await db.select().from(reconciliationImports);
    expect(after.length).toBe(before.length);
  });

  it('rejects an unsupported extension and a non-multipart body', async () => {
    const admin = await staffClient('ADMIN');
    const bad = await admin.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('statement.xlsx', 'a,b\n1,2', 'application/vnd.ms-excel'),
    });
    expect(bad.status).toBe(422);

    const notMultipart = await admin.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: { source: 'PROVIDER' },
    });
    expect(notMultipart.status).toBe(422);
  });

  it('rejects a missing file and an invalid source', async () => {
    const admin = await staffClient('ADMIN');
    const noFile = await admin.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: new FormData(),
    });
    expect(noFile.status).toBe(422);

    const badSource = await admin.req('/api/admin/finance/reconciliation/preview-file?source=NONSENSE&currencyCode=TND', {
      method: 'POST',
      body: upload('p.csv', PROVIDER_CSV),
    });
    expect(badSource.status).toBe(422);
  });

  it('rejects an oversized upload with FILE_TOO_LARGE', async () => {
    const admin = await staffClient('ADMIN');
    const big = `reference,grossAmount,providerFee,netAmount\nr,1,0,1\n${'#'.repeat(1024 * 1024 + 64)}`;
    const res = await admin.req('/api/admin/finance/reconciliation/preview-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('big.csv', big),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.data)).toMatch(/FILE_TOO_LARGE|too large/);
  });
});

describe('reconciliation file routes — import', () => {
  it('imports a valid file, persists MISMATCH decisions, and is idempotent on replay', async () => {
    const admin = await staffClient('ADMIN');
    const key = `imp-${randomUUID().slice(0, 8)}`;
    const path = `/api/admin/finance/reconciliation/import-file?source=PROVIDER&currencyCode=TND&importKey=${key}`;
    const content = `${PROVIDER_CSV}\n`.replace('ref-http-1', `ref-http-1-${key}`).replace('ref-http-2', `ref-http-2-${key}`);

    const first = await admin.req(path, { method: 'POST', body: upload('p.csv', content) });
    expect(first.status).toBe(200);
    expect(first.data.data.duplicate).toBe(false);
    expect(first.data.data.insertedLines).toBe(2);

    // Replaying the identical bytes returns the same import, no second effect.
    const second = await admin.req(path, { method: 'POST', body: upload('p.csv', content) });
    expect(second.status).toBe(200);
    expect(second.data.data.duplicate).toBe(true);
    expect(second.data.data.insertedLines).toBe(0);
    expect(second.data.data.importId).toBe(first.data.data.importId);

    // The stored decisions keep MISMATCH; nothing was upgraded to a match.
    const stored = await db
      .select()
      .from(reconciliationDecisions)
      .where(eq(reconciliationDecisions.importId, first.data.data.importId));
    expect(stored).toHaveLength(2);
    expect(stored.every((d) => d.status === 'MISMATCH')).toBe(true);
    expect(stored.every((d) => (d.mismatches as string[]).includes('MISSING_IN_LEDGER'))).toBe(true);
  });

  it('rejects a file with duplicate references', async () => {
    const admin = await staffClient('ADMIN');
    const dup = 'reference,grossAmount,providerFee,netAmount\nsame,1,0,1\nsame,2,0,2';
    const r = await admin.req('/api/admin/finance/reconciliation/import-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('dup.csv', dup),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toMatch(/Duplicate reference/);
  });

  it('rejects an attempt to smuggle a ledger `settled` column', async () => {
    const admin = await staffClient('ADMIN');
    const csv = 'reference,grossAmount,providerFee,netAmount,settled\nr,1,0,1,true';
    const r = await admin.req('/api/admin/finance/reconciliation/import-file?source=PROVIDER&currencyCode=TND', {
      method: 'POST',
      body: upload('smuggle.csv', csv),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toMatch(/Unknown column/);
  });

  it('records an audit trail and does not touch settlement/payout state', async () => {
    const admin = await staffClient('ADMIN');
    const key = `audit-${randomUUID().slice(0, 8)}`;
    const content = `reference,grossAmount,providerFee,netAmount\nref-${key},10.0000,0.2000,9.8000\n`;
    const r = await admin.req(
      `/api/admin/finance/reconciliation/import-file?source=PROVIDER&currencyCode=TND&importKey=${key}`,
      { method: 'POST', body: upload('p.csv', content) },
    );
    expect(r.status).toBe(200);
    // The import row exists with the source/currency the operator declared.
    const [row] = await db
      .select()
      .from(reconciliationImports)
      .where(and(eq(reconciliationImports.id, r.data.data.importId), eq(reconciliationImports.source, 'PROVIDER')));
    expect(row.currencyCode).toBe('TND');
    expect(row.lineCount).toBe(1);
  });
});
