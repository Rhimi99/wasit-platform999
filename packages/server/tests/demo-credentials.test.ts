import { describe, it, expect } from 'vitest';
import {
  demoAccountEnvKey,
  demoStaffEnvKey,
  resolveDemoAccountPassword,
  resolveDemoStaffPassword,
  shouldRotateDemoPassword,
} from '../src/lib/demo-credentials';
import { DEMO_PUBLISHED_PASSWORD } from '../src/lib/demo-account';

/**
 * DEMO-SEC-03 — the demo fixtures must never share one credential again, and a
 * re-seed must reproduce whatever the rotation script wrote instead of falling
 * back to the published password. These are pure functions, so they are asserted
 * directly (no database, no process.env mutation).
 */
describe('demo credential resolution', () => {
  it('maps each demo account to its own env key', () => {
    expect(demoAccountEnvKey('customer1@wasit.tn')).toBe('DEMO_ACCOUNT_PASSWORD_CUSTOMER1');
    expect(demoAccountEnvKey('SupplierA@wasit.tn')).toBe('DEMO_ACCOUNT_PASSWORD_SUPPLIERA');
    expect(demoAccountEnvKey('merchantA@wasit.tn')).toBe('DEMO_ACCOUNT_PASSWORD_MERCHANTA');
    expect(demoAccountEnvKey('companyA@wasit.tn')).toBe('DEMO_ACCOUNT_PASSWORD_COMPANYA');
    expect(demoAccountEnvKey('demo@wasit.tn')).toBe('DEMO_ACCOUNT_PASSWORD_DEMO');
    expect(demoAccountEnvKey('someone@example.com')).toBeNull();
  });

  it('gives staff their own keys', () => {
    expect(demoStaffEnvKey('admin')).toBe('DEMO_STAFF_PASSWORD_ADMIN');
    expect(demoStaffEnvKey('admin2')).toBe('DEMO_STAFF_PASSWORD_ADMIN2');
  });

  it('prefers the per-account secret over the shared one', () => {
    const env = {
      DEMO_ACCOUNT_PASSWORD: 'shared-secret',
      DEMO_ACCOUNT_PASSWORD_CUSTOMER1: 'customer-only-secret',
    };
    expect(resolveDemoAccountPassword('customer1@wasit.tn', env)).toBe('customer-only-secret');
    expect(resolveDemoAccountPassword('merchantA@wasit.tn', env)).toBe('shared-secret');
  });

  it('never hands two accounts the same secret when overrides exist', () => {
    const env = {
      DEMO_ACCOUNT_PASSWORD_CUSTOMER1: 'one',
      DEMO_ACCOUNT_PASSWORD_MERCHANTA: 'two',
      DEMO_ACCOUNT_PASSWORD_SUPPLIERA: 'three',
    };
    const secrets = ['customer1@wasit.tn', 'merchantA@wasit.tn', 'supplierA@wasit.tn'].map((email) =>
      resolveDemoAccountPassword(email, env),
    );
    expect(new Set(secrets).size).toBe(3);
  });

  it('falls back to the published password only when nothing is configured', () => {
    expect(resolveDemoAccountPassword('customer1@wasit.tn', {})).toBe(DEMO_PUBLISHED_PASSWORD);
    expect(shouldRotateDemoPassword('customer1@wasit.tn', {})).toBe(false);
    expect(shouldRotateDemoPassword('customer1@wasit.tn', { DEMO_ACCOUNT_PASSWORD: 'x' })).toBe(true);
    expect(shouldRotateDemoPassword('customer1@wasit.tn', { DEMO_ACCOUNT_PASSWORD_CUSTOMER1: 'y' })).toBe(true);
  });

  it('resolves staff per-account first, then shared, then the caller fallback', () => {
    expect(resolveDemoStaffPassword('admin', 'generated', { DEMO_STAFF_PASSWORD_ADMIN: 'admin-secret' })).toBe(
      'admin-secret',
    );
    expect(resolveDemoStaffPassword('admin2', 'generated', { DEMO_STAFF_PASSWORD: 'shared' })).toBe('shared');
    expect(resolveDemoStaffPassword('admin2', 'generated', {})).toBe('generated');
  });

  it('ignores blank values so an empty key cannot wipe a credential', () => {
    const env = { DEMO_ACCOUNT_PASSWORD_CUSTOMER1: '   ', DEMO_ACCOUNT_PASSWORD: 'shared' };
    expect(resolveDemoAccountPassword('customer1@wasit.tn', env)).toBe('shared');
  });
});
