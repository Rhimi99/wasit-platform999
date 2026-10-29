import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRole } from '@wasit/shared';
import { allAgentSpecs, findAgentSpec } from '../src/modules/ai/catalogue.js';
import { resolvePlatformScope, SYSTEM_PRINCIPAL, deriveScope, NoScopeError } from '../src/modules/ai/scope.js';

/**
 * Phase 3D — platform-scope gate for agent executors.
 *
 * DB-free by design: isolation is proven by asserting the catalogue/scope
 * authority that the runner and executors both consult, plus a source-level
 * guard that every executor which returns cross-owner detail calls the
 * defence-in-depth gate. No database connection is opened.
 *
 * The runner (`assertAgentScope`) and the executor gate (`requirePlatformGate`)
 * both decide using the same rule as `resolvePlatformScope` (ADMIN/SUPER_ADMIN
 * only), so testing that single authority covers both call sites.
 */

// The executors whose queries span every owner's rows (campaigns, risk,
// disputes, users/orders/KPIs, the ledger, ops health). Each must be gated.
const PLATFORM_DATA_AGENTS = [
  'ads-agent',
  'risk-agent',
  'dispute-assistant',
  'development-agent',
  'finance-agent',
  'operations-agent',
  'analytics-agent',
] as const;

// The executors that must call the executor-level gate by name.
const GATED_EXECUTOR_FUNCS: Record<string, string> = {
  'ads-agent': 'execAdsAgent',
  'risk-agent': 'execRiskAgent',
  'dispute-assistant': 'execDisputeAssistant',
  'development-agent': 'execDevelopmentAgent',
  'finance-agent': 'execFinanceAgent',
  'operations-agent': 'execOperationsAgent',
};

const NON_ADMIN_ROLES: UserRole[][] = [
  ['CUSTOMER'],
  ['MERCHANT'],
  ['SUPPLIER'],
  ['COMPANY'],
  ['MARKETER'],
  ['SUPPORT'],
  ['RISK'],
  ['DISPUTE'],
  [],
  ['SUPPORT', 'RISK'],
  ['RISK', 'DISPUTE'],
];

describe('catalogue marks every platform-data executor as admin-only', () => {
  it('every cross-owner agent declares requiresPlatformScope', () => {
    for (const key of PLATFORM_DATA_AGENTS) {
      const spec = findAgentSpec(key);
      expect(spec, key).toBeTruthy();
      expect(spec?.requiresPlatformScope, key).toBe(true);
    }
  });

  it('owner-scoped agents are not marked platform (they stay runnable with owner data)', () => {
    for (const key of ['marketing-agent', 'market-research-agent', 'product-agent', 'supplier-agent', 'merchant-agent']) {
      expect(findAgentSpec(key)?.requiresPlatformScope, key).not.toBe(true);
    }
  });

  it('catalogue is still internally consistent (keys unique, permissions present)', () => {
    const specs = allAgentSpecs();
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of specs) expect(s.permissionsRequired.length, s.key).toBeGreaterThan(0);
  });
});

describe('platform scope authority (the rule both gates use)', () => {
  it('grants admins and super-admins', () => {
    for (const roles of [['ADMIN'], ['SUPER_ADMIN'], ['ADMIN', 'MERCHANT']] as UserRole[][]) {
      expect(resolvePlatformScope({ roles }), roles.join(',')).toBe(true);
    }
  });

  it('refuses every non-admin role set, including mixed staff', () => {
    for (const roles of NON_ADMIN_ROLES) {
      expect(resolvePlatformScope({ roles }), roles.join(',') || 'empty').toBe(false);
    }
  });
});

describe('executors enforce the gate in code (defence in depth)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');

  /** Extracts a function body from its `async function NAME(` to the next top-level async function. */
  function bodyOf(name: string): string {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('every gated executor calls requirePlatformGate before querying', () => {
    for (const [agentKey, fn] of Object.entries(GATED_EXECUTOR_FUNCS)) {
      const body = bodyOf(fn);
      expect(body.includes('requirePlatformGate('), `${fn} (${agentKey}) must gate`).toBe(true);
    }
  });

  it('the gate is the same admin predicate (no inline widening)', () => {
    // requirePlatformGate delegates to canReadPlatformData, which is admin-only.
    expect(SRC.includes('async function requirePlatformGate(')).toBe(true);
    expect(SRC.includes('await canReadPlatformData(db, userId, agent)')).toBe(true);
  });
});

describe('the scheduler principal cannot be used as an owner', () => {
  it('SYSTEM_PRINCIPAL is refused as an owner scope', () => {
    expect(() => deriveScope({ userId: SYSTEM_PRINCIPAL })).toThrow(NoScopeError);
  });
});
