import { describe, it, expect } from 'vitest';
import {
  MEMORY_TYPES,
  MEMORY_ENTITY_TYPES,
  DEFAULT_TTL_DAYS,
  scanMemoryText,
  resolveTtlDays,
  memoryChecksum,
} from '../../src/modules/ai/memory.js';
import { env } from '../../src/lib/env.js';

/**
 * AI-MEM-01 — the pure policy of the memory layer.
 *
 * These tests pin the rules that must hold no matter which surface calls the
 * service: what may be written, how long it lives, and what makes a row
 * verifiably unmodified.
 */

describe('AI-MEM-01 — memory policy (pure)', () => {
  it('declares exactly the four operational memory types', () => {
    expect([...MEMORY_TYPES]).toEqual(['operational', 'contextual', 'procedural', 'task_result']);
    expect(Object.keys(DEFAULT_TTL_DAYS).sort()).toEqual([...MEMORY_TYPES].sort());
    expect(MEMORY_ENTITY_TYPES).toContain('order');
    expect(MEMORY_ENTITY_TYPES).toContain('product');
  });

  it('accepts ordinary operational notes', () => {
    for (const text of [
      'Supplier invoices are reconciled every Tuesday.',
      'Customer prefers delivery before noon.',
      'Order ORD-2024-0001 was split into two shipments.',
      'Median basket for the Tunis region is 84 TND.',
    ]) {
      expect(scanMemoryText(text)).toEqual({ ok: true });
    }
  });

  it('refuses credentials, keys and payment data', () => {
    // Fixtures are assembled at runtime so this file never contains a
    // credential-shaped literal that a secret scanner would (rightly) flag.
    const pem = `-----BEGIN ${'RSA'} PRIVATE KEY-----\nMIIE...`;
    const githubToken = `gh${'p'}_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
    const cases: Array<[string, string]> = [
      [pem, 'PRIVATE_KEY'],
      ['token sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'API_TOKEN'],
      [`use ${githubToken}`, 'API_TOKEN'],
      ['session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'API_TOKEN'],
      ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'BEARER_TOKEN'],
      ['password=Hunter2!', 'CREDENTIAL_ASSIGNMENT'],
      ['api_key: 1234567890abcdef', 'CREDENTIAL_ASSIGNMENT'],
      ['pay to 4111 1111 1111 1111', 'PAYMENT_CARD'],
      ['IBAN FR14 2004 1010 0505 0001 3M02 606', 'BANK_ACCOUNT'],
      ['contact buyer at someone@example.com', 'EMAIL_ADDRESS'],
    ];
    for (const [text, reason] of cases) {
      expect(scanMemoryText(text)).toEqual({ ok: false, reason });
    }
  });

  it('does not flag a long digit run that is not a valid card number', () => {
    expect(scanMemoryText('internal reference 1234 5678 9012 3456')).toEqual({ ok: true });
    expect(scanMemoryText('tracking 1234567890123')).toEqual({ ok: true });
  });

  it('bounds retention by type and by the configured maximum', () => {
    expect(resolveTtlDays('contextual', null)).toBe(DEFAULT_TTL_DAYS.contextual);
    expect(resolveTtlDays('procedural', undefined)).toBe(DEFAULT_TTL_DAYS.procedural);
    expect(resolveTtlDays('operational', 0)).toBe(1);
    expect(resolveTtlDays('operational', -30)).toBe(1);
    expect(resolveTtlDays('operational', 10_000)).toBe(env.AI_MEMORY_MAX_TTL_DAYS);
    expect(resolveTtlDays('task_result', 45)).toBe(45);
  });

  it('binds a checksum to agent, owner, type, revision and text', () => {
    const base = { agentKey: 'analytics-agent', ownerId: 'owner-1', type: 'operational', revision: 1, text: 'hello' };
    const sum = memoryChecksum(base);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(memoryChecksum({ ...base })).toBe(sum);
    expect(memoryChecksum({ ...base, ownerId: 'owner-2' })).not.toBe(sum);
    expect(memoryChecksum({ ...base, agentKey: 'sales-agent' })).not.toBe(sum);
    expect(memoryChecksum({ ...base, type: 'procedural' })).not.toBe(sum);
    expect(memoryChecksum({ ...base, revision: 2 })).not.toBe(sum);
    expect(memoryChecksum({ ...base, text: 'hello!' })).not.toBe(sum);
  });
});
