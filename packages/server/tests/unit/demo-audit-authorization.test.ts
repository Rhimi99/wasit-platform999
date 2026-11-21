import { describe, it, expect } from 'vitest';
import { canOpenDemoPersona, DEMO_AUDIT_PERSONA_IDS, resolveDemoAuditPersona } from '../../src/lib/demo-account.js';

/**
 * DEMO-SEC-01 — the Owner Audit Center is an operator tool.
 *
 * `canOpenDemoPersona` is the whole authorization rule, so it is asserted
 * directly: staff only, and a persona may never outrank the caller. Without the
 * second half an ADMIN could climb to SUPER_ADMIN through a UI convenience.
 */
describe('canOpenDemoPersona', () => {
  it('refuses every caller without a staff role', () => {
    for (const roles of [[], ['CUSTOMER'], ['MERCHANT'], ['SUPPLIER'], ['COMPANY'], ['SUPPORT']]) {
      for (const id of DEMO_AUDIT_PERSONA_IDS) {
        expect(canOpenDemoPersona(roles, resolveDemoAuditPersona(id)!.role)).toBe(false);
      }
    }
  });

  it('lets an ADMIN open trade and ADMIN desks, but never SUPER_ADMIN', () => {
    expect(canOpenDemoPersona(['ADMIN'], 'CUSTOMER')).toBe(true);
    expect(canOpenDemoPersona(['ADMIN'], 'MERCHANT')).toBe(true);
    expect(canOpenDemoPersona(['ADMIN'], 'ADMIN')).toBe(true);
    expect(canOpenDemoPersona(['ADMIN'], 'SUPER_ADMIN')).toBe(false);
  });

  it('lets a SUPER_ADMIN open every desk', () => {
    for (const id of DEMO_AUDIT_PERSONA_IDS) {
      expect(canOpenDemoPersona(['SUPER_ADMIN'], resolveDemoAuditPersona(id)!.role)).toBe(true);
    }
  });

  it('reads the highest role held, not the first one', () => {
    expect(canOpenDemoPersona(['CUSTOMER', 'SUPER_ADMIN'], 'SUPER_ADMIN')).toBe(true);
    expect(canOpenDemoPersona(['MERCHANT', 'ADMIN'], 'SUPER_ADMIN')).toBe(false);
  });

  it('does not accept look-alike role names', () => {
    expect(canOpenDemoPersona(['admin'], 'CUSTOMER')).toBe(false);
    expect(canOpenDemoPersona(['SUPERADMIN'], 'CUSTOMER')).toBe(false);
  });
});
