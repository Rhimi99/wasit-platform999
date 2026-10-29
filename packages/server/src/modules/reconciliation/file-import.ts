import { ApiError } from '@wasit/shared';
import { toDecimal } from '../../lib/money';
import type { BankFeedLine, ProviderFeedLine } from './engine';

/**
 * PS-04 (appendix a.5-1) — reconciliation **file** ingestion.
 *
 * The a.5-1 gap was that reconciliation feeds could only be typed as JSON by
 * hand. This module turns an uploaded provider/bank statement file into the very
 * same `ProviderFeedLine`/`BankFeedLine` values the existing import service
 * already consumes — it adds no new financial rule and never derives a match.
 *
 * Everything here is pure and DB-free so the format rules can be proven without
 * persistence. All validation happens on the server; the UI's checks are only a
 * convenience and are never trusted.
 *
 * Deliberate boundaries:
 *  - Only the external evidence (provider/bank) is importable. The ledger side is
 *    internal: accepting it from a file would let uploaded content assert a
 *    financial fact, which is exactly what this layer must not allow.
 *  - Nothing here writes settlement/payout state. An import records evidence and
 *    the engine's classification; a MISMATCH stays a MISMATCH.
 */

export const RECON_FILE_LIMITS = {
  /** Uploaded statement size cap (bytes). */
  maxBytes: 1_048_576, // 1 MiB
  /** Row cap, checked before any matching work is done. */
  maxLines: 5_000,
  /** Max characters in a single cell. */
  maxFieldLength: 200,
  /** Max distinct columns in a header row. */
  maxColumns: 32,
} as const;

export const RECON_FILE_EXTENSIONS = ['.csv', '.tsv', '.json'] as const;
export type ReconFileFormat = 'csv' | 'tsv' | 'json';

/** Column/field names, per source, in the order they may appear in a header. */
const PROVIDER_REQUIRED = ['reference', 'grossAmount', 'providerFee', 'netAmount'] as const;
const BANK_REQUIRED = ['reference', 'amount'] as const;
const OPTIONAL_FIELDS = ['settlementRef', 'payoutRef', 'currencyCode', 'occurredAt'] as const;

export interface ParseFileInput {
  filename: string;
  /** Raw file bytes; never decoded by the caller. */
  bytes: Uint8Array;
  source: 'PROVIDER' | 'BANK';
  /** File-level currency; a row may override it, otherwise this applies. */
  currencyCode: string;
}

export interface ParsedFeed {
  format: ReconFileFormat;
  source: 'PROVIDER' | 'BANK';
  currencyCode: string;
  rowCount: number;
  provider: ProviderFeedLine[];
  bank: BankFeedLine[];
}

function fail(field: string, message: string, code = 'VALIDATION_FAILED'): never {
  throw ApiError.validation([{ field, message, code }]);
}

/** Lower-cases the extension and returns it, or '' when the name has none. */
function extensionOf(filename: string): string {
  const name = filename ?? '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Decodes strictly as UTF-8. A byte sequence that is not valid UTF-8 is rejected
 * rather than silently replaced with U+FFFD, so a mis-encoded statement cannot
 * be imported with corrupted references/amounts.
 */
function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('file', 'File is not valid UTF-8 text', 'INVALID_ENCODING');
  }
  // A NUL byte means binary content, not a statement.
  if (text.includes('\u0000')) fail('file', 'File contains binary data', 'INVALID_ENCODING');
  // Strip a single leading BOM so the first header cell is not "﻿reference".
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Rejects control characters and spreadsheet formula triggers in a text cell. */
function safeText(value: string, field: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(field, 'Value contains control characters', 'UNSAFE_VALUE');
  }
  // A leading =, +, @ (or a lone -/\t) is a formula/CSV-injection trigger once the
  // value reaches a spreadsheet. References are opaque ids, so reject them.
  if (/^[=+@]/.test(value) || value.startsWith('\t') || value.startsWith('\r')) {
    fail(field, 'Value must not start with a spreadsheet formula character', 'UNSAFE_VALUE');
  }
  if (value.length > RECON_FILE_LIMITS.maxFieldLength) {
    fail(field, `Value exceeds ${RECON_FILE_LIMITS.maxFieldLength} characters`, 'VALUE_TOO_LONG');
  }
  return value;
}

function normalizeCurrency(value: string, field: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail(field, 'Currency must be a 3-letter ISO code', 'INVALID_CURRENCY');
  return code;
}

/** A money cell: required, a real decimal, not negative. */
function moneyCell(value: string, field: string): string {
  const raw = value.trim();
  if (raw === '') fail(field, 'Amount is required', 'REQUIRED');
  let d;
  try {
    d = toDecimal(raw);
  } catch {
    fail(field, 'Amount is not a valid number', 'INVALID_NUMBER');
  }
  if (!d.isFinite()) fail(field, 'Amount is not a valid number', 'INVALID_NUMBER');
  if (d.isNegative()) fail(field, 'Amount must not be negative', 'INVALID_NUMBER');
  return raw;
}

/** An optional cell: empty becomes null, otherwise it is validated as text. */
function optionalText(value: string | undefined, field: string): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  return safeText(raw, field);
}

function referenceCell(value: string, field: string): string {
  const raw = value.trim();
  if (raw === '') fail(field, 'Reference is required', 'REQUIRED');
  return safeText(raw, field);
}

/** An optional ISO-8601 timestamp; an unparseable value is rejected, not dropped. */
function occurredAtCell(value: string | undefined, field: string): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  safeText(raw, field);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) fail(field, 'Timestamp is not a valid ISO-8601 date', 'INVALID_DATE');
  return d.toISOString();
}

/** Minimal RFC-4180-style reader: quoted fields, "" escapes, CRLF or LF. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat CRLF and a lone CR as one line break.
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (inQuotes) fail('file', 'Unterminated quoted field', 'MALFORMED_FILE');
  // A trailing newline produces a final empty cell only; do not emit a phantom row.
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/** Maps a delimited document to feed lines for one source. */
function linesFromDelimited(text: string, delimiter: string, input: ParseFileInput): ParsedFeed {
  const rows = parseDelimited(text, delimiter);
  const nonBlank = rows.filter((r) => !isBlankRow(r));
  if (nonBlank.length === 0) fail('file', 'File has no header row', 'EMPTY_FILE');

  const header = nonBlank[0].map((h) => h.trim());
  if (header.length > RECON_FILE_LIMITS.maxColumns) {
    fail('file', `Header has more than ${RECON_FILE_LIMITS.maxColumns} columns`, 'TOO_MANY_COLUMNS');
  }
  const seen = new Set<string>();
  for (const col of header) {
    if (col === '') fail('file', 'Header contains an empty column name', 'INVALID_HEADER');
    const key = col.toLowerCase();
    if (seen.has(key)) fail('file', `Header repeats column '${col}'`, 'DUPLICATE_COLUMN');
    seen.add(key);
  }

  const required = input.source === 'PROVIDER' ? PROVIDER_REQUIRED : BANK_REQUIRED;
  const index = new Map<string, number>();
  header.forEach((h, i) => index.set(h.toLowerCase(), i));
  for (const col of required) {
    if (!index.has(col.toLowerCase())) fail('file', `Header is missing required column '${col}'`, 'MISSING_COLUMN');
  }
  // Any column that is neither required nor optional is a typo — reject rather
  // than silently ignore a column the operator believes is being imported.
  const allowed = new Set<string>([...required, ...OPTIONAL_FIELDS].map((c) => c.toLowerCase()));
  for (const h of header) {
    if (!allowed.has(h.toLowerCase())) fail('file', `Unknown column '${h}'`, 'UNKNOWN_COLUMN');
  }

  const dataRows = nonBlank.slice(1);
  if (dataRows.length > RECON_FILE_LIMITS.maxLines) {
    fail('file', `File has more than ${RECON_FILE_LIMITS.maxLines} rows`, 'TOO_MANY_ROWS');
  }
  if (dataRows.length === 0) fail('file', 'File has a header but no data rows', 'EMPTY_FILE');

  const cell = (r: string[], name: string): string => {
    const i = index.get(name.toLowerCase());
    return i === undefined ? '' : (r[i] ?? '');
  };

  const provider: ProviderFeedLine[] = [];
  const bank: BankFeedLine[] = [];
  const refRow = new Map<string, number>();

  dataRows.forEach((r, i) => {
    const rowNo = i + 2; // 1-based, header is row 1
    const where = `row ${rowNo}`;
    const reference = referenceCell(cell(r, 'reference'), `${where}.reference`);
    if (refRow.has(reference)) {
      fail(`${where}.reference`, `Duplicate reference '${reference}' (first seen on row ${refRow.get(reference)})`, 'DUPLICATE_REFERENCE');
    }
    refRow.set(reference, rowNo);

    const rowCurrency = cell(r, 'currencyCode').trim();
    const currencyCode = rowCurrency === '' ? input.currencyCode : normalizeCurrency(rowCurrency, `${where}.currencyCode`);
    const settlementRef = optionalText(cell(r, 'settlementRef'), `${where}.settlementRef`);
    const payoutRef = optionalText(cell(r, 'payoutRef'), `${where}.payoutRef`);
    const occurredAt = occurredAtCell(cell(r, 'occurredAt'), `${where}.occurredAt`);

    if (input.source === 'PROVIDER') {
      provider.push({
        reference,
        settlementRef,
        payoutRef,
        grossAmount: moneyCell(cell(r, 'grossAmount'), `${where}.grossAmount`),
        providerFee: moneyCell(cell(r, 'providerFee'), `${where}.providerFee`),
        netAmount: moneyCell(cell(r, 'netAmount'), `${where}.netAmount`),
        currencyCode,
        occurredAt,
      });
    } else {
      bank.push({
        reference,
        settlementRef,
        payoutRef,
        amount: moneyCell(cell(r, 'amount'), `${where}.amount`),
        currencyCode,
        occurredAt,
      });
    }
  });

  return {
    format: delimiter === '\t' ? 'tsv' : 'csv',
    source: input.source,
    currencyCode: input.currencyCode,
    rowCount: dataRows.length,
    provider,
    bank,
  };
}

/** Maps a JSON array of line objects to feed lines for one source. */
function linesFromJson(text: string, input: ParseFileInput): ParsedFeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('file', 'File is not valid JSON', 'MALFORMED_FILE');
  }
  if (!Array.isArray(parsed)) fail('file', 'JSON file must contain an array of lines', 'MALFORMED_FILE');
  if (parsed.length > RECON_FILE_LIMITS.maxLines) {
    fail('file', `File has more than ${RECON_FILE_LIMITS.maxLines} rows`, 'TOO_MANY_ROWS');
  }
  if (parsed.length === 0) fail('file', 'File contains no lines', 'EMPTY_FILE');

  const allowed = new Set<string>(
    [...(input.source === 'PROVIDER' ? PROVIDER_REQUIRED : BANK_REQUIRED), ...OPTIONAL_FIELDS].map((c) =>
      c.toLowerCase(),
    ),
  );
  const required = input.source === 'PROVIDER' ? PROVIDER_REQUIRED : BANK_REQUIRED;

  const provider: ProviderFeedLine[] = [];
  const bank: BankFeedLine[] = [];
  const refRow = new Map<string, number>();

  parsed.forEach((entry, i) => {
    const rowNo = i + 1;
    const where = `line ${rowNo}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(where, 'Each JSON line must be an object', 'MALFORMED_FILE');
    }
    const obj = entry as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key.toLowerCase())) fail(`${where}.${key}`, `Unknown field '${key}'`, 'UNKNOWN_COLUMN');
    }
    const get = (name: string): string => {
      const v = obj[name];
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string') fail(`${where}.${name}`, 'Value must be a string', 'INVALID_TYPE');
      return v;
    };

    for (const col of required) {
      if (obj[col] === undefined || obj[col] === null || (typeof obj[col] === 'string' && (obj[col] as string).trim() === '')) {
        fail(`${where}.${col}`, `Field '${col}' is required`, 'REQUIRED');
      }
    }

    const reference = referenceCell(get('reference'), `${where}.reference`);
    if (refRow.has(reference)) {
      fail(`${where}.reference`, `Duplicate reference '${reference}' (first seen on line ${refRow.get(reference)})`, 'DUPLICATE_REFERENCE');
    }
    refRow.set(reference, rowNo);

    const rowCurrency = get('currencyCode').trim();
    const currencyCode = rowCurrency === '' ? input.currencyCode : normalizeCurrency(rowCurrency, `${where}.currencyCode`);
    const settlementRef = optionalText(get('settlementRef'), `${where}.settlementRef`);
    const payoutRef = optionalText(get('payoutRef'), `${where}.payoutRef`);
    const occurredAt = occurredAtCell(get('occurredAt'), `${where}.occurredAt`);

    if (input.source === 'PROVIDER') {
      provider.push({
        reference,
        settlementRef,
        payoutRef,
        grossAmount: moneyCell(get('grossAmount'), `${where}.grossAmount`),
        providerFee: moneyCell(get('providerFee'), `${where}.providerFee`),
        netAmount: moneyCell(get('netAmount'), `${where}.netAmount`),
        currencyCode,
        occurredAt,
      });
    } else {
      bank.push({
        reference,
        settlementRef,
        payoutRef,
        amount: moneyCell(get('amount'), `${where}.amount`),
        currencyCode,
        occurredAt,
      });
    }
  });

  return { format: 'json', source: input.source, currencyCode: input.currencyCode, rowCount: parsed.length, provider, bank };
}

/**
 * Parses and fully validates an uploaded statement. Throws an `ApiError` with a
 * field-level reason for anything it refuses; it never drops a bad row silently
 * and never returns a partially-validated feed.
 */
export function parseReconciliationFile(input: ParseFileInput): ParsedFeed {
  const extension = extensionOf(input.filename);
  if (!(RECON_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    fail('file', `Unsupported file type '${extension || '(none)'}'. Allowed: ${RECON_FILE_EXTENSIONS.join(', ')}`, 'UNSUPPORTED_FILE_TYPE');
  }
  if (input.bytes.length === 0) fail('file', 'File is empty', 'EMPTY_FILE');
  if (input.bytes.length > RECON_FILE_LIMITS.maxBytes) {
    fail('file', `File exceeds the ${Math.floor(RECON_FILE_LIMITS.maxBytes / 1024)} KiB limit`, 'FILE_TOO_LARGE');
  }
  const currencyCode = normalizeCurrency(input.currencyCode, 'currencyCode');
  const text = decodeUtf8(input.bytes);
  const scoped: ParseFileInput = { ...input, currencyCode };

  if (extension === '.json') return linesFromJson(text, scoped);
  return linesFromDelimited(text, extension === '.tsv' ? '\t' : ',', scoped);
}
