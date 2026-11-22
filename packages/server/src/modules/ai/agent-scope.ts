import { getTableName } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { getAgentRunContext, type AgentRunContext } from '../../lib/ai/agent-run-context';
import {
  SYSTEM_PRINCIPAL,
  deriveScope,
  deriveSystemScope,
  assertValidScope,
} from './scope.js';

/**
 * A2 — Production Agent Scope Enforcement (least privilege + data isolation).
 *
 * ONE central, reusable, server-side contract that bounds what each WASIT agent
 * may touch, enforced at the ACTUAL data-access boundary — the `db` handle the
 * executor is given — not in the UI and not only in tests.
 *
 * The contract answers, per agent: identity, specialization, allowed data
 * domains, allowed tables (entity types), tenant boundary, read/write authority,
 * prohibited domains, delegation and context boundaries.
 *
 * Enforcement model (fail-closed at every step):
 *  - Business tables are **read-only** and only the tables the agent's executor
 *    actually needs. A read of any other table is refused.
 *  - Platform accounting tables (`ai_models`/`ai_requests`/`ai_usage`/
 *    `ai_budgets`) are runtime-owned and allowed for every agent (the AI ledger
 *    is infrastructure, not agent data).
 *  - A hard-deny set (credentials, sessions, financial mutation, audit) is
 *    refused for EVERY agent, even if a contract listed it by mistake.
 *  - Owner-scoped tables (`agent_metrics`/`agent_memory`) additionally require a
 *    validated owner scope from `scope.ts` (the tenant boundary).
 *  - A missing/unknown run context, an unknown agent, an unidentifiable table, a
 *    write to a business table, raw SQL, a transaction or a relational query are
 *    all refused. Nothing is widened by default.
 *
 * The grant (allowed tables) is read from the TRUSTED run context
 * (`allowedTables`, server-derived in `buildRunContext` from this contract) or,
 * failing that, derived here from the trusted `agentKey` — never from task
 * `input`. So a caller cannot widen its own scope by naming another agent or
 * passing parameters.
 */

/** The data domains an agent scope may reference. */
export const AGENT_DATA_DOMAINS = [
  'COMMERCE',
  'MARKETPLACE',
  'ADS',
  'MESSAGING',
  'ANALYTICS',
  'B2B',
  'RISK',
  'DISPUTE',
  'TRUST',
  'OPS',
  'MEDIA',
] as const;
export type AgentDataDomain = (typeof AGENT_DATA_DOMAINS)[number];

/** The unified scope contract for one agent. */
export interface AgentScopeContract {
  /** Agent identity — the registry key. */
  readonly agentKey: string;
  /** What the agent specialises in (from the catalogue, not the name alone). */
  readonly specialization: string;
  /** Data domains the agent may read. */
  readonly allowedDomains: readonly AgentDataDomain[];
  /** Exact tables (entity types) the agent's executor may read. */
  readonly allowedTables: readonly string[];
  /** Agents never mutate business data. */
  readonly readOnly: true;
  /** Domains the agent must never touch (all domains it is not allowed). */
  readonly prohibitedDomains: readonly AgentDataDomain[];
  /** No agent may hand off to, or run as, another agent. */
  readonly canDelegate: false;
  /** Whether the run must carry a validated owner (tenant) scope. */
  readonly ownerScoped: true;
}

/**
 * Platform accounting/infrastructure tables owned by the AI runtime. Allowed for
 * every agent because every executor routes its call through `runAIFeature`,
 * which reads the model catalogue and writes the request/usage ledger. These are
 * NOT agent business data, so allowing them does not widen any data domain.
 */
export const PLATFORM_INFRA_TABLES: ReadonlySet<string> = new Set([
  'ai_models',
  'ai_requests',
  'ai_usage',
  'ai_budgets',
]);

/**
 * Tables refused for EVERY agent regardless of contract — credentials, secrets,
 * sessions, audit and financial-mutation tables. A defence in depth: even a
 * mistaken contract entry can never open one of these.
 */
export const HARD_DENY_TABLES: ReadonlySet<string> = new Set([
  // credentials / sessions / secrets
  'sessions',
  'password_reset_tokens',
  'email_verification_tokens',
  'phone_verification_tokens',
  'mfa_challenges',
  'authenticator_apps',
  'security_settings',
  'rate_limit_counters',
  'profiles',
  // authorization internals
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
  // audit / compliance / legal
  'audit_logs',
  'consent_events',
  'consents',
  'policies',
  'data_export_requests',
  'data_deletion_requests',
  'verification_documents',
  'verification_requests',
  // money movement / financial records (agents are advisory, never financial)
  'payment_intents',
  'payments',
  'payment_webhook_events',
  'payouts',
  'refunds',
  'refund_allocations',
  'seller_settlements',
  'seller_orders',
  'transaction_ledger',
  'commissions',
  'commission_policies',
  'reconciliation_decisions',
  'reconciliation_imports',
  'reconciliation_lines',
  'revenue_accounts',
  'invoices',
  'wasit_receipts',
  'tax_jurisdictions',
  'order_tax_decisions',
  // platform internals
  'event_outbox',
  'alert_events',
  'notification_deliveries',
  'scenario_reports',
  'dashboard_reports',
]);

/**
 * Tables that are owner (tenant) scoped: a read is only permitted when the run
 * carries a validated owner scope (see `scope.ts`). Kept separate from the
 * per-agent allow-list so the tenant boundary is enforced structurally.
 */
export const OWNER_SCOPED_TABLES: ReadonlySet<string> = new Set(['agent_metrics', 'agent_memory']);

/** The sentinel used when a data source cannot be identified as a table. */
export const UNIDENTIFIED_TABLE = '__unidentified__';

const ALL = AGENT_DATA_DOMAINS;
const prohibited = (allowed: readonly AgentDataDomain[]): readonly AgentDataDomain[] =>
  ALL.filter((d) => !allowed.includes(d));

/**
 * The 11 production agents, each bounded to the tables its executor actually
 * reads. Least privilege: no agent gets a platform-wide table set, and no two
 * agents share a blanket "everything" scope.
 */
export const AGENT_SCOPE_CONTRACTS: Record<string, AgentScopeContract> = {
  'sales-agent': {
    agentKey: 'sales-agent',
    specialization: 'Sales / lead identification',
    allowedDomains: ['COMMERCE', 'MARKETPLACE', 'B2B', 'TRUST'],
    allowedTables: ['orders', 'order_items', 'products', 'suppliers', 'merchants', 'companies', 'trust_scores'],
    readOnly: true,
    prohibitedDomains: prohibited(['COMMERCE', 'MARKETPLACE', 'B2B', 'TRUST']),
    canDelegate: false,
    ownerScoped: true,
  },
  'marketing-agent': {
    agentKey: 'marketing-agent',
    specialization: 'Marketing content & channel mix',
    allowedDomains: ['MARKETPLACE', 'MEDIA'],
    // suppliers/merchants/companies are read only to resolve which listings
    // the requester owns; every product query is filtered by that ownership.
    allowedTables: ['products', 'categories', 'media_assets', 'suppliers', 'merchants', 'companies'],
    readOnly: true,
    prohibitedDomains: prohibited(['MARKETPLACE', 'MEDIA']),
    canDelegate: false,
    ownerScoped: true,
  },
  'marketing-video-agent': {
    agentKey: 'marketing-video-agent',
    specialization: 'Marketing video planning',
    allowedDomains: ['MARKETPLACE', 'MEDIA', 'B2B'],
    // Reads the product it is planning for, its seller's display name and the
    // videos already produced for it. It cannot write any of them: a render is
    // an audited business write and stays in the media module (A2).
    allowedTables: ['products', 'media_assets', 'suppliers', 'merchants', 'companies'],
    readOnly: true,
    prohibitedDomains: prohibited(['MARKETPLACE', 'MEDIA', 'B2B']),
    canDelegate: false,
    ownerScoped: true,
  },
  'ads-agent': {
    agentKey: 'ads-agent',
    specialization: 'Advertising budget & placement',
    allowedDomains: ['ADS'],
    allowedTables: ['campaigns', 'ad_events'],
    readOnly: true,
    prohibitedDomains: prohibited(['ADS']),
    canDelegate: false,
    ownerScoped: true,
  },
  'product-agent': {
    agentKey: 'product-agent',
    specialization: 'Product listing analysis',
    allowedDomains: ['MARKETPLACE'],
    // suppliers/merchants/companies resolve product ownership for the requester.
    allowedTables: ['products', 'categories', 'product_variants', 'product_images', 'inventory_items', 'suppliers', 'merchants', 'companies'],
    readOnly: true,
    prohibitedDomains: prohibited(['MARKETPLACE']),
    canDelegate: false,
    ownerScoped: true,
  },
  'support-agent': {
    agentKey: 'support-agent',
    specialization: 'Customer support drafting',
    allowedDomains: ['MESSAGING', 'OPS'],
    allowedTables: ['threads', 'messages', 'users'],
    readOnly: true,
    prohibitedDomains: prohibited(['MESSAGING', 'OPS']),
    canDelegate: false,
    ownerScoped: true,
  },
  'analytics-agent': {
    agentKey: 'analytics-agent',
    specialization: 'Business KPI reporting',
    allowedDomains: ['ANALYTICS', 'COMMERCE', 'MARKETPLACE', 'B2B'],
    allowedTables: ['users', 'products', 'suppliers', 'merchants', 'companies', 'orders', 'order_items', 'daily_kpis'],
    readOnly: true,
    prohibitedDomains: prohibited(['ANALYTICS', 'COMMERCE', 'MARKETPLACE', 'B2B']),
    canDelegate: false,
    ownerScoped: true,
  },
  'market-research-agent': {
    agentKey: 'market-research-agent',
    specialization: 'Market & category research',
    allowedDomains: ['MARKETPLACE', 'ANALYTICS'],
    allowedTables: ['products', 'categories', 'orders', 'suppliers', 'merchants'],
    readOnly: true,
    prohibitedDomains: prohibited(['MARKETPLACE', 'ANALYTICS']),
    canDelegate: false,
    ownerScoped: true,
  },
  'b2b-agent': {
    agentKey: 'b2b-agent',
    specialization: 'B2B partner matching',
    allowedDomains: ['B2B'],
    allowedTables: ['suppliers', 'merchants', 'companies'],
    readOnly: true,
    prohibitedDomains: prohibited(['B2B']),
    canDelegate: false,
    ownerScoped: true,
  },
  'risk-agent': {
    agentKey: 'risk-agent',
    specialization: 'Risk assessment',
    allowedDomains: ['RISK'],
    allowedTables: ['risk_profiles', 'risk_events'],
    readOnly: true,
    prohibitedDomains: prohibited(['RISK']),
    canDelegate: false,
    ownerScoped: true,
  },
  'dispute-assistant': {
    agentKey: 'dispute-assistant',
    specialization: 'Dispute context summarisation',
    allowedDomains: ['DISPUTE'],
    allowedTables: ['disputes', 'dispute_messages'],
    readOnly: true,
    prohibitedDomains: prohibited(['DISPUTE']),
    canDelegate: false,
    ownerScoped: true,
  },
  'development-agent': {
    agentKey: 'development-agent',
    specialization: 'Platform maintenance & repair diagnosis',
    allowedDomains: ['OPS', 'ANALYTICS', 'COMMERCE', 'ADS'],
    // The run/task tables are what a real diagnosis reads. Alert events and audit
    // logs stay hard-denied to every agent, so the diagnosis is built from the
    // agent layer's own state instead of the operator's audit trail.
    allowedTables: [
      'users',
      'products',
      'orders',
      'campaigns',
      'daily_kpis',
      'agent_tasks',
      'agent_runs',
      'agent_run_steps',
    ],
    readOnly: true,
    prohibitedDomains: prohibited(['OPS', 'ANALYTICS', 'COMMERCE', 'ADS']),
    canDelegate: false,
    ownerScoped: true,
  },
  'finance-agent': {
    agentKey: 'finance-agent',
    specialization: 'Finance & cost accounting (read-only aggregates)',
    // Orders carry the recorded commission/fee, so accounting never needs the
    // ledger or the commission policy table — both are hard-denied on purpose.
    allowedDomains: ['COMMERCE', 'ADS', 'OPS'],
    allowedTables: ['orders', 'campaigns', 'ad_events'],
    readOnly: true,
    prohibitedDomains: prohibited(['COMMERCE', 'ADS', 'OPS']),
    canDelegate: false,
    ownerScoped: true,
  },
  'outreach-acquisition-agent': {
    agentKey: 'outreach-acquisition-agent',
    specialization: 'Global growth & acquisition (market discovery over platform data)',
    allowedDomains: ['MARKETPLACE', 'B2B', 'COMMERCE', 'ANALYTICS'],
    allowedTables: ['countries', 'categories', 'products', 'suppliers', 'merchants', 'companies', 'orders'],
    readOnly: true,
    prohibitedDomains: prohibited(['MARKETPLACE', 'B2B', 'COMMERCE', 'ANALYTICS']),
    canDelegate: false,
    ownerScoped: true,
  },
};

/** Thrown when an agent attempts an operation outside its scope. */
export class AgentScopeError extends ApiError {
  constructor(message = 'Agent scope violation — operation refused.') {
    super(403, 'FORBIDDEN', message, { details: { code: 'AGENT_SCOPE' } });
    this.name = 'AgentScopeError';
  }
}

/** The contract for an agent, or `undefined` when none is defined. */
export function getAgentScopeContract(agentKey: string): AgentScopeContract | undefined {
  return AGENT_SCOPE_CONTRACTS[agentKey];
}

/**
 * The contract for an agent, or throws {@link AgentScopeError}. Used on the
 * production path so an agent without a declared scope can never execute
 * (fail-closed: no scope ⇒ no authority).
 */
export function assertAgentScopeContract(agentKey: string): AgentScopeContract {
  const contract = AGENT_SCOPE_CONTRACTS[agentKey];
  if (!contract) throw new AgentScopeError(`No scope contract is defined for agent "${agentKey}".`);
  return contract;
}

/** Resolves a Drizzle table (or anything passed to `from`/`join`) to its name. */
function tableNameOf(table: unknown): string {
  try {
    return getTableName(table as never);
  } catch {
    return UNIDENTIFIED_TABLE;
  }
}

/**
 * The effective allow-list for a run: the INTERSECTION of the trusted run
 * context's `allowedTables` (server-derived in `buildRunContext`) and the
 * agent's contract. The context may only ever NARROW the contract — it can never
 * widen it — so even a context that lists a table the agent does not declare
 * cannot grant access. Never derived from task `input`.
 */
function allowedTablesFor(ctx: AgentRunContext, contract: AgentScopeContract): readonly string[] {
  if (!Array.isArray(ctx.allowedTables)) return contract.allowedTables;
  const declared = new Set(contract.allowedTables);
  return ctx.allowedTables.filter((t) => declared.has(t));
}

/**
 * Validates the owner (tenant) scope for a run's requester, using `scope.ts` as
 * the single source of truth. Fails closed (throws `NoScopeError`) when no
 * trustworthy owner can be established. Called on EVERY production run (from
 * `buildRunContext`) so the tenant boundary is established before any data
 * access, and again at the data boundary for owner-scoped tables.
 */
export function assertRunOwnerScope(requestedBy: string | undefined | null): void {
  if (typeof requestedBy !== 'string' || requestedBy.length === 0) {
    throw new AgentScopeError('An owner scope is required but the run has no requester.');
  }
  const scope = requestedBy === SYSTEM_PRINCIPAL ? deriveSystemScope() : deriveScope({ userId: requestedBy });
  assertValidScope(scope);
}

/**
 * Validates the owner (tenant) scope for a run that touches an owner-scoped
 * table, using `scope.ts` as the single source of truth. Fails closed when no
 * trustworthy owner can be established.
 */
function assertOwnerScope(ctx: AgentRunContext): void {
  assertRunOwnerScope(ctx.requestedBy);
}

/**
 * The single access decision. Refuses (throws {@link AgentScopeError}) unless the
 * current run's agent is permitted to perform `op` on `table`.
 */
export function assertTableAccess(
  ctx: AgentRunContext | undefined,
  table: string,
  op: 'read' | 'write',
): void {
  if (!ctx || typeof ctx.agentKey !== 'string' || ctx.agentKey.length === 0) {
    throw new AgentScopeError('No trusted agent run scope — refusing data access.');
  }
  if (table === UNIDENTIFIED_TABLE) {
    throw new AgentScopeError('Unidentifiable data source — refusing data access.');
  }
  if (HARD_DENY_TABLES.has(table)) {
    throw new AgentScopeError(`Data source "${table}" is prohibited for every agent.`);
  }
  if (PLATFORM_INFRA_TABLES.has(table)) return;

  const contract = assertAgentScopeContract(ctx.agentKey);
  const allowed = allowedTablesFor(ctx, contract);

  if (OWNER_SCOPED_TABLES.has(table)) {
    assertOwnerScope(ctx);
    if (!allowed.includes(table)) {
      throw new AgentScopeError(`Agent "${ctx.agentKey}" is not permitted to access "${table}".`);
    }
    return;
  }

  if (!allowed.includes(table)) {
    throw new AgentScopeError(`Agent "${ctx.agentKey}" is not permitted to access "${table}".`);
  }
  if (op === 'write') {
    throw new AgentScopeError(`Agent "${ctx.agentKey}" is read-only and may not write "${table}".`);
  }
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Returns a `db` handle that enforces the current run's agent scope on every
 * table access. Handed to executors at the single execution boundary
 * (`executeAgentTask`), so an executor cannot read a table outside its scope,
 * write business data, run raw SQL or open a transaction — no matter which
 * executor, task, agent key or parameter is used.
 *
 * Every table-bearing call (`from`, joins, `insert`/`update`/`delete`) is
 * checked; anything else passes through unchanged, so ordinary query building
 * and execution are untouched.
 */
export function withAgentDataScope(db: DB): DB {
  const wrapBuilder = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, prop) {
        if (
          prop === 'from' ||
          prop === 'innerJoin' ||
          prop === 'leftJoin' ||
          prop === 'rightJoin' ||
          prop === 'fullJoin'
        ) {
          return (table: unknown, on?: unknown) => {
            assertTableAccess(getAgentRunContext(), tableNameOf(table), 'read');
            const next = (target as Record<string, AnyFn>)[prop as string](table, on);
            return next && typeof next === 'object' ? wrapBuilder(next as object) : next;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
      },
    });

  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === 'select') {
        return (...args: unknown[]) =>
          wrapBuilder((target as unknown as { select: AnyFn }).select(...args) as object);
      }
      if (prop === 'insert' || prop === 'update' || prop === 'delete') {
        return (table: unknown) => {
          assertTableAccess(getAgentRunContext(), tableNameOf(table), 'write');
          return (target as unknown as Record<string, AnyFn>)[prop as string](table);
        };
      }
      if (prop === 'execute' || prop === 'transaction' || prop === 'query') {
        return () => {
          throw new AgentScopeError(
            'Raw SQL, transactions and relational queries are not available to an agent run.',
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
    },
  }) as unknown as DB;
}

/** The full scope contract map (read-only view) — for admin/oversight surfaces. */
export function listAgentScopes(): AgentScopeContract[] {
  return Object.values(AGENT_SCOPE_CONTRACTS);
}
