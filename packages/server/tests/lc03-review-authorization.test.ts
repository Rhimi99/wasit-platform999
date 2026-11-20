import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission } from '@wasit/shared';

/**
 * LC-03 — authorisation surface for restricted-listing review (database-free).
 *
 * The human review gate is only as strong as who may clear it. These specs pin
 * the RBAC matrix (only human reviewer roles hold the permission), the route
 * guard, and the rule that no automated agent definition can carry it.
 */
const ADMIN = 'ADMIN' as const;
const SUPER_ADMIN = 'SUPER_ADMIN' as const;
const SUPPORT = 'SUPPORT' as const;
const MERCHANT = 'MERCHANT' as const;
const CUSTOMER = 'CUSTOMER' as const;

describe('LC-03 catalog compliance permission', () => {
  it('is granted to human reviewer roles only', () => {
    expect(roleHasPermission(ADMIN, PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(true);
    expect(roleHasPermission(SUPER_ADMIN, PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(true);
    expect(roleHasPermission(SUPPORT, PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(false);
    expect(roleHasPermission(MERCHANT, PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(false);
    expect(roleHasPermission(CUSTOMER, PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(false);
  });

  it('is part of the full SUPER_ADMIN set (no permission is dropped by omission)', () => {
    expect(ROLE_PERMISSIONS[SUPER_ADMIN].has(PERMISSIONS.CATALOG_COMPLIANCE_REVIEW)).toBe(true);
    expect(ROLE_PERMISSIONS[SUPER_ADMIN].size).toBe(Object.values(PERMISSIONS).length);
  });

  it('is enforced on the review routes, and only there', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../src/modules/products/routes.ts'),
      'utf8',
    );
    // Both the queue and the decision route require the compliance permission.
    const guarded = src.match(/requirePermission\(PERM_COMPLIANCE_REVIEW\)/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(2);
    // The permission must not be attached to the ordinary seller status route.
    const statusRoute = src.slice(src.indexOf("productsRoutes.patch('/:id/status'"));
    expect(statusRoute.slice(0, statusRoute.indexOf('});'))).not.toContain('PERM_COMPLIANCE_REVIEW');
  });

  it('no AI agent definition is allowed to carry the compliance permission', () => {
    const agents = readFileSync(path.resolve(__dirname, '../src/modules/ai/agents.ts'), 'utf8');
    expect(agents).not.toContain(PERMISSIONS.CATALOG_COMPLIANCE_REVIEW);
  });
});
