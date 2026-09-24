import { describe, it, expect } from 'vitest';
import {
  reconcile,
  type BankFeedLine,
  type LedgerFeedLine,
  type ProviderFeedLine,
} from '../src/modules/reconciliation/engine.js';
import { applyReceiptEvidence } from '../src/modules/reconciliation/receipt.js';

/**
 * PS-04 — Reconciliation / Treasury.
 *
 * The engine compares three independent sources (provider, bank, ledger) and
 * classifies every difference instead of turning it into a success. It is pure,
 * so the same feeds always yield the same decisions (idempotent replay).
 */

function providerLine(over: Partial<ProviderFeedLine> = {}): ProviderFeedLine {
  return {
    reference: 'ext_1',
    settlementRef: 'trf_1',
    grossAmount: '1020.0000',
    providerFee: '4.2000',
    netAmount: '1015.8000',
    currencyCode: 'TND',
    ...over,
  };
}
function bankLine(over: Partial<BankFeedLine> = {}): BankFeedLine {
  return { reference: 'ext_1', settlementRef: 'trf_1', amount: '1015.8000', currencyCode: 'TND', ...over };
}
function ledgerLine(over: Partial<LedgerFeedLine> = {}): LedgerFeedLine {
  return {
    reference: 'ext_1',
    grossAmount: '1020.0000',
    providerFee: '4.2000',
    netAmount: '1015.8000',
    currencyCode: 'TND',
    settled: true,
    ...over,
  };
}

describe('PS-04 — three-way matching', () => {
  it('marks a line MATCHED only when all three sources agree', () => {
    const report = reconcile('TND', [providerLine()], [bankLine()], [ledgerLine()]);
    expect(report.matched).toBe(1);
    expect(report.mismatched).toBe(0);
    expect(report.decisions[0].status).toBe('MATCHED');
    expect(report.decisions[0].mismatches).toEqual([]);
  });

  it('classifies a missing ledger line instead of succeeding', () => {
    const report = reconcile('TND', [providerLine()], [bankLine()], []);
    expect(report.decisions[0].status).toBe('MISMATCH');
    expect(report.decisions[0].mismatches).toContain('MISSING_IN_LEDGER');
  });

  it('classifies a missing bank line instead of succeeding', () => {
    const report = reconcile('TND', [providerLine()], [], [ledgerLine()]);
    expect(report.decisions[0].mismatches).toContain('MISSING_IN_BANK');
  });

  it('classifies a missing provider line instead of succeeding', () => {
    const report = reconcile('TND', [], [bankLine()], [ledgerLine()]);
    expect(report.decisions[0].mismatches).toContain('MISSING_IN_PROVIDER');
  });

  it('classifies amount, fee, net and currency differences separately', () => {
    const report = reconcile(
      'TND',
      [providerLine({ grossAmount: '999.0000', providerFee: '9.0000', netAmount: '990.0000', currencyCode: 'EUR' })],
      [bankLine()],
      [ledgerLine()],
    );
    const m = report.decisions[0].mismatches;
    expect(m).toContain('AMOUNT_MISMATCH');
    expect(m).toContain('FEE_MISMATCH');
    expect(m).toContain('NET_MISMATCH');
    expect(m).toContain('CURRENCY_MISMATCH');
    expect(report.decisions[0].status).toBe('MISMATCH');
  });

  it('flags a provider/bank movement the ledger never settled', () => {
    const report = reconcile('TND', [providerLine()], [bankLine()], [ledgerLine({ settled: false })]);
    expect(report.decisions[0].mismatches).toContain('NOT_SETTLED_IN_LEDGER');
  });

  it('is idempotent: the same feeds yield identical decisions', () => {
    const a = reconcile('TND', [providerLine()], [bankLine()], [ledgerLine()]);
    const b = reconcile('TND', [providerLine()], [bankLine()], [ledgerLine()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects a duplicate reference in a single feed', () => {
    expect(() => reconcile('TND', [providerLine(), providerLine()], [bankLine()], [ledgerLine()])).toThrow(
      /Duplicate feed reference/,
    );
  });
});

describe('WASIT Receipt — RECEIVED requires statement evidence', () => {
  it('promotes to RECEIVED only with a reference, amount and currency', () => {
    const decision = applyReceiptEvidence(
      { reference: 'stmt_1', amount: '40.0000', currencyCode: 'TND', source: 'BANK_STATEMENT' },
      { amount: '40.0000', currencyCode: 'TND' },
    );
    expect(decision.status).toBe('RECEIVED');
    expect(decision.reference).toBe('stmt_1');
  });

  it('rejects receipt without a reference', () => {
    const err = (() => {
      try {
        applyReceiptEvidence(
          { reference: '  ', amount: '40.0000', currencyCode: 'TND', source: 'BANK_STATEMENT' },
          { amount: '40.0000', currencyCode: 'TND' },
        );
        return null;
      } catch (e) {
        return e as { fieldErrors?: { message: string }[] };
      }
    })();
    expect(JSON.stringify(err?.fieldErrors)).toContain('auditable reference');
  });

  it('rejects a mismatching amount or currency', () => {
    expect(() =>
      applyReceiptEvidence(
        { reference: 'stmt_1', amount: '1.0000', currencyCode: 'TND', source: 'BANK_STATEMENT' },
        { amount: '40.0000', currencyCode: 'TND' },
      ),
    ).toThrow(/amount/);
    expect(() =>
      applyReceiptEvidence(
        { reference: 'stmt_1', amount: '40.0000', currencyCode: 'EUR', source: 'BANK_STATEMENT' },
        { amount: '40.0000', currencyCode: 'TND' },
      ),
    ).toThrow(/currency/);
  });
});
