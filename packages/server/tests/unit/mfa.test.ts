import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateMfaSecret,
  generateMfaQrUri,
  generateRecoveryCodes,
  generateTotp,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
} from '../../src/lib/mfa.js';

describe('MFA pure helpers (RFC 6238 TOTP)', () => {
  it('generateMfaSecret returns a 32-char base32 secret and a distinct raw secret', () => {
    const { secret, secretBase32 } = generateMfaSecret();
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret.length).toBeGreaterThan(0);
    expect(generateMfaSecret().secretBase32).not.toBe(secretBase32);
  });

  it('generateMfaQrUri builds an otpauth TOTP URI with issuer and secret', () => {
    const uri = generateMfaQrUri('user@wasit.tn', 'ABCDEFGHIJKLMNOP');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=ABCDEFGHIJKLMNOP');
    expect(uri).toContain('issuer=WASIT');
  });

  it('generateTotp/verifyTotp agree for the same timestamp', () => {
    const { secretBase32 } = generateMfaSecret();
    const ts = 1_700_000_000_000;
    expect(verifyTotp(secretBase32, generateTotp(secretBase32, ts), ts)).toBe(true);
  });

  it('verifyTotp accepts codes within the ±1 step window', () => {
    const { secretBase32 } = generateMfaSecret();
    const ts = 1_700_000_000_000;
    const atPrev = generateTotp(secretBase32, ts - 30_000);
    expect(verifyTotp(secretBase32, atPrev, ts)).toBe(true);
  });

  it('verifyTotp rejects codes outside the window and malformed codes', () => {
    const { secretBase32 } = generateMfaSecret();
    const ts = 1_700_000_000_000;
    const far = generateTotp(secretBase32, ts - 300_000);
    expect(verifyTotp(secretBase32, far, ts)).toBe(false);
    expect(verifyTotp(secretBase32, '12345', ts)).toBe(false);
    expect(verifyTotp(secretBase32, 'abcdef', ts)).toBe(false);
  });

  it('generateRecoveryCodes returns the requested number of distinct codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(generateRecoveryCodes(5)).toHaveLength(5);
  });

  it('hashRecoveryCode stores a salted digest that never contains the raw code', () => {
    const stored = hashRecoveryCode('my-code');
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(stored).not.toContain('my-code');
    expect(hashRecoveryCode('my-code')).not.toBe(stored); // unique salt each time
  });

  it('verifyRecoveryCode validates salted digests and flags legacy format', () => {
    const code = 'secret-code';
    const salted = hashRecoveryCode(code);
    expect(verifyRecoveryCode(code, salted)).toEqual({ valid: true, legacy: false });
    expect(verifyRecoveryCode('wrong', salted).valid).toBe(false);

    // Legacy unsalted format: bare sha256 hex of the code.
    const legacyStored = hashTokenForTest(code);
    expect(verifyRecoveryCode(code, legacyStored)).toEqual({ valid: true, legacy: true });
  });
});

// Local helper mirroring the legacy digest (sha256 of the raw code) to test the
// backward-compatibility branch without depending on internal constants.
function hashTokenForTest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}