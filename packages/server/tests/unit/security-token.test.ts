import { describe, it, expect } from 'vitest';
import { hashToken, parseBearerToken, signToken, verifyToken } from '../../src/lib/security.js';

describe('security token helpers (pure)', () => {
  it('hashToken is deterministic SHA-256 hex', () => {
    const h = hashToken('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(h);
    expect(hashToken('abd')).not.toBe(h);
  });

  it('parseBearerToken extracts a token and rejects malformed headers', () => {
    expect(parseBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearerToken('Bearer   spaced  ')).toBe('spaced');
    expect(parseBearerToken('Basic abc')).toBeNull();
    expect(parseBearerToken('Bearer ')).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it('signToken/verifyToken round-trips a payload', () => {
    const token = signToken({ sub: 'user-1', role: 'ADMIN' }, 3600);
    const payload = verifyToken<{ sub: string; role: string; exp: number }>(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.role).toBe('ADMIN');
    expect(payload?.exp).toBeTypeOf('number');
  });

  it('verifyToken rejects a tampered signature', () => {
    const token = signToken({ sub: 'user-1' }, 3600);
    const [h, b] = token.split('.');
    expect(verifyToken(`${h}.${b}.deadbeef`)).toBeNull();
  });

  it('verifyToken rejects malformed tokens', () => {
    expect(verifyToken('not.a.valid.token')).toBeNull();
    expect(verifyToken('only-one-part')).toBeNull();
  });

  it('verifyToken rejects an expired token', () => {
    const expired = signToken({ sub: 'user-1' }, -10);
    expect(verifyToken(expired)).toBeNull();
  });
});