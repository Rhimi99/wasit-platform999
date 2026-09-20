import { describe, it, expect } from 'vitest';
import { recommendedActionFor } from '../../src/lib/risk-engine.js';

describe('recommendedActionFor (pure)', () => {
  it('maps each risk level to its recommended action', () => {
    expect(recommendedActionFor('LOW')).toBe('ALLOW');
    expect(recommendedActionFor('MEDIUM')).toBe('REVIEW');
    expect(recommendedActionFor('HIGH')).toBe('ESCALATE');
    expect(recommendedActionFor('SEVERE')).toBe('BLOCK');
  });

  it('always returns a non-empty action string', () => {
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'SEVERE'] as const) {
      expect(recommendedActionFor(level).length).toBeGreaterThan(0);
    }
  });
});