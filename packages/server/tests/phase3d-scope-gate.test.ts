import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRole } from '@wasit/shared';
import { AGENT_CATALOGUE, allAgentSpecs, findAgentSpec } from '../src/modules/ai/catalogue.js';
import { resolvePlatformScope, SYSTEM_PRINCIPAL, deriveScope, NoScopeError } from '../src/modules/ai/scope.js';
import {
  SUPPLIER_READ_OWN,
  UNBOUND_DECLARED_TOOLS,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';

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
  'compliance-agent',
] as const;

// Executors that keep an inline executor-level gate (they read owner-scoped or
// single-tenant data and still self-check). Empty after G5 Phase 1 moved the two
// remaining inline-gated executors behind the gateway (see below).
const INLINE_GATED_EXECUTOR_FUNCS: Record<string, string> = {};

// G5 Phase 1 — executors whose cross-owner reads now go through the central Tool
// Gateway while KEEPING their own defence-in-depth `requirePlatformGate`. The
// gateway re-enforces admin-only platform scope, and the inline gate stays as a
// second, unchanged check. Neither grants new authority.
const GATEWAY_ROUTED_WITH_INLINE_GATE: Record<string, string> = {
  'ads-agent': 'execAdsAgent',
  'development-agent': 'execDevelopmentAgent',
};

// Executors whose cross-owner reads were moved behind the central Tool Gateway
// (AI-02.1 / AI-02.1-R1). They no longer run a direct query; the gateway enforces
// admin-only platform scope before any handler runs.
const GATEWAY_ROUTED_EXECUTOR_FUNCS: Record<string, string> = {
  'risk-agent': 'execRiskAgent',
  'dispute-assistant': 'execDisputeAssistant',
  'finance-agent': 'execFinanceAgent',
  'operations-agent': 'execOperationsAgent',
  'analytics-agent': 'execAnalyticsAgent',
  'payment-settlement-agent': 'execPaymentSettlementAgent',
  'compliance-agent': 'execComplianceAgent',
  // AI-03.6: market-research-agent's platform aggregates moved behind the
  // gateway's `market.read_overview` (admin-only); its own slice comes from
  // `market.read_own`. It keeps no inline gate — the gateway is the boundary.
  'market-research-agent': 'execMarketResearchAgent',
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

  it('every inline-gated executor calls requirePlatformGate before querying', () => {
    for (const [agentKey, fn] of Object.entries(INLINE_GATED_EXECUTOR_FUNCS)) {
      const body = bodyOf(fn);
      expect(body.includes('requirePlatformGate('), `${fn} (${agentKey}) must gate`).toBe(true);
    }
  });

  it('G5 Phase 1: ads/development read through the gateway AND keep their inline gate, with no direct query', () => {
    for (const [agentKey, fn] of Object.entries(GATEWAY_ROUTED_WITH_INLINE_GATE)) {
      const body = bodyOf(fn);
      expect(body.includes('invokeTool('), `${fn} (${agentKey}) must route through the Tool Gateway`).toBe(true);
      // The defence-in-depth gate is preserved unchanged.
      expect(body.includes('requirePlatformGate('), `${fn} (${agentKey}) must keep its inline gate`).toBe(true);
      // No direct cross-owner Drizzle read remains.
      expect(body.includes('.from('), `${fn} (${agentKey}) must not query tables directly`).toBe(false);
    }
  });

  it('every gateway-routed executor reads through invokeTool (no direct cross-owner query)', () => {
    for (const [agentKey, fn] of Object.entries(GATEWAY_ROUTED_EXECUTOR_FUNCS)) {
      const body = bodyOf(fn);
      expect(body.includes('invokeTool('), `${fn} (${agentKey}) must route through the Tool Gateway`).toBe(true);
      // The admin-only decision is the gateway's; a routed executor must not keep
      // a stale direct gate that could drift from it.
      expect(body.includes('requirePlatformGate('), `${fn} (${agentKey}) must not inline-gate`).toBe(false);
    }
  });

  it('the inline gate is the same admin predicate (no inline widening)', () => {
    // requirePlatformGate delegates to canReadPlatformData, which is admin-only.
    expect(SRC.includes('async function requirePlatformGate(')).toBe(true);
    expect(SRC.includes('await canReadPlatformData(db, userId, agent)')).toBe(true);
  });
});

describe('G5 Phase 2 (A1) — supplier agent is routed through the gateway (owner-scoped)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');

  function bodyOf(name: string): string {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('registers supplier.read_owned as a read-only, owner-scoped tool with a bound handler', () => {
    const tool = findTool(SUPPLIER_READ_OWN);
    expect(tool, SUPPLIER_READ_OWN).toBeTruthy();
    expect(tool?.effect).toBe('read');
    // Owner-scoped: NOT platform-scoped, so the gateway does not require an admin.
    expect(tool?.platformScoped).toBe(false);
    expect(isRegisteredTool(SUPPLIER_READ_OWN)).toBe(true);
    expect(registeredToolIds()).toContain(SUPPLIER_READ_OWN);
    expect(getToolHandler(SUPPLIER_READ_OWN)).toBeTruthy();
  });

  it('grants supplier.read_owned to supplier-agent ONLY (no widening)', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      if (agent.key === 'supplier-agent') expect(grant, agent.key).toContain(SUPPLIER_READ_OWN);
      else expect(grant, agent.key).not.toContain(SUPPLIER_READ_OWN);
    }
  });

  it('does not touch the shared CATALOG_TOOLS group (marketing/product/merchant unchanged)', () => {
    // supplier-agent keeps its catalogue tools PLUS the new own-scoped read.
    const supplier = findAgentSpec('supplier-agent')!;
    expect(supplier.allowedTools).toEqual(['platform.read_catalog', 'platform.metrics', 'report.generate', SUPPLIER_READ_OWN]);
    // The sibling CATALOG_TOOLS consumers are untouched (still no supplier tool).
    for (const key of ['marketing-agent', 'product-agent', 'merchant-agent']) {
      expect(toolGrantForAgent(findAgentSpec(key)!), key).not.toContain(SUPPLIER_READ_OWN);
    }
  });

  it('execSupplierAgent reads ONLY through invokeTool (no direct query, no inline platform gate)', () => {
    const body = bodyOf('execSupplierAgent');
    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes('.from(')).toBe(false);
    expect(body.includes('listOwnedSellerEntities(')).toBe(false);
    // The supplier agent is owner-scoped, never platform-gated.
    expect(body.includes('requirePlatformGate(')).toBe(false);
  });

  it('does not change supplier-agent permissions, scope or approval declarations', () => {
    const supplier = findAgentSpec('supplier-agent')!;
    expect(supplier.permissionsRequired).toEqual(['ai:use']);
    expect(supplier.requiresPlatformScope).not.toBe(true);
    expect(supplier.approvalActions).toEqual([]);
    expect(supplier.requiresHumanApproval).toBe(false);
  });

  it('the new tool is registered, not left in the unbound list', () => {
    expect(UNBOUND_DECLARED_TOOLS).not.toContain(SUPPLIER_READ_OWN);
  });
});

describe('the scheduler principal cannot be used as an owner', () => {
  it('SYSTEM_PRINCIPAL is refused as an owner scope', () => {
    expect(() => deriveScope({ userId: SYSTEM_PRINCIPAL })).toThrow(NoScopeError);
  });
});
