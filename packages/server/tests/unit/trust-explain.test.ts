import { describe, it, expect } from 'vitest';
import { explainTrustScore } from '../../src/lib/trust-engine.js';
import type { TrustFactors } from '../../src/lib/trust-engine.js';

const factors: TrustFactors = {
  accountAgeDays: 45,
  emailVerified: true,
  phoneVerified: false,
  verificationLevel: 2,
  successfulTransactions: 8,
  totalTransactions: 10,
  disputeCount: 1,
  complaintsCount: 0,
  profileCompleteness: 50,
  businessVerified: false,
};

describe('explainTrustScore (pure)', () => {
  it('is deterministic for the same inputs', () => {
    expect(explainTrustScore(72, factors)).toBe(explainTrustScore(72, factors));
  });

  it('includes the score and every explanatory factor', () => {
    const text = explainTrustScore(72, factors);
    expect(text).toContain('72');
    expect(text).toContain('45 days');
    expect(text).toContain('email verified');
    expect(text).toContain('phone not verified');
    expect(text).toContain('Verification level 2');
    expect(text).toContain('8/10 successful transactions');
    expect(text).toContain('Disputes: 1');
  });

  it('reflects negative verification states', () => {
    const text = explainTrustScore(20, { ...factors, emailVerified: false, verificationLevel: 0 });
    expect(text).toContain('email not verified');
    expect(text).toContain('Verification level 0');
  });
});