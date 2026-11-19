import { z } from 'zod';
import type { UserRole } from '@wasit/shared';
import type { AgentDefinition } from './types';
import { resolvePlatformScope } from '../../modules/ai/scope';
import { HARD_DENY_TABLES, PLATFORM_INFRA_TABLES } from '../../modules/ai/agent-scope';

/**
 * Central Tool Gateway registry.
 *
 * Every tool an agent may invoke is declared here exactly once, with a stable
 * id, a Zod input schema the gateway validates BEFORE execution, the exact
 * tables the handler reads, the platform permission the caller must hold, and
 * whether the tool returns platform-wide data (admin-only).
 *
 * Three states are distinguished, and the distinction is enforced at load time:
 *
 *  - REGISTERED — declared here AND bound to a handler. Invocable through the
 *    gateway. Read-only in this phase: no tool has a write effect.
 *  - UNBOUND — declared by an agent's catalogue but deliberately NOT registered.
 *    Inert: no handler exists, so the gateway refuses it. `finance.read_ledger`,
 *    `payments.read_settlements` and `operations.read_health` live here because
 *    their data sources are hard-denied (money movement, payouts) or need raw
 *    SQL; the outreach surface lives here because external sending is not built.
 *  - UNKNOWN — not declared anywhere. Always refused.
 *
 * Registration is NOT authorization: the trusted run context, the grant list,
 * RBAC, platform scope, the schema and the table guard all still apply on top.
 */

export type ToolEffect = 'read';

export interface ToolDefinition {
  /** Stable tool id; also the action id the run context must grant. */
  readonly id: string;
  readonly description: string;
  /** Read-only in this phase — no write effect exists. */
  readonly effect: ToolEffect;
  /** Zod schema validated against the caller's args before execution. */
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  /**
   * The exact tables the bound handler reads. The registry refuses to load a
   * tool that names a hard-denied or platform-infrastructure table, so a
   * mistaken definition can never open a sensitive data source.
   */
  readonly tables: readonly string[];
  /** Platform permission the requester must hold (admins bypass). */
  readonly permission: string;
  /** True when the tool returns platform-wide data → admin roles only. */
  readonly platformScoped: boolean;
  /**
   * True when repeating the same call with the same args is guaranteed to
   * return the same result, so the gateway may serve a replay from its
   * idempotency cache instead of re-running the handler.
   */
  readonly idempotent: boolean;
}

// ---------------------------------------------------------------- tool ids
export const PLATFORM_METRICS = 'platform.metrics';
export const PLATFORM_READ_ORDERS = 'platform.read_orders';
export const OPERATIONS_READ_HEALTH = 'operations.read_health';
export const RISK_READ_OVERVIEW = 'risk.read_overview';
export const DISPUTES_READ_SUMMARY = 'disputes.read_summary';
export const PAYMENTS_READ_SETTLEMENTS = 'payments.read_settlements';
export const FINANCE_READ_LEDGER = 'finance.read_ledger';
export const COMPLIANCE_READ_PLATFORM = 'compliance.read_platform';
export const MARKET_READ_OVERVIEW = 'market.read_overview';
export const MARKET_READ_OWN = 'market.read_own';
export const ADS_READ_CAMPAIGNS = 'ads.read_campaigns';
export const DEVELOPMENT_READ_PLATFORM = 'development.read_platform';
export const SUPPLIER_READ_OWN = 'supplier.read_owned';
export const MERCHANT_READ_OWN = 'merchant.read_owned';
export const SALES_READ_ORDERS_OWN = 'sales.read_orders_owned';
export const SALES_READ_ORDERS_PLATFORM = 'sales.read_orders_platform';
export const SALES_READ_MARKET_TOTALS = 'sales.read_market_totals';
export const PRODUCT_READ_PUBLIC = 'product.read_public';
export const PRODUCT_READ_OWNED = 'product.read_owned';
export const PRODUCT_READ_PLATFORM = 'product.read_platform';
export const MARKETING_READ_CATALOGUE_OWNED = 'marketing.read_catalogue_owned';
export const MARKETING_READ_CATALOGUE_PLATFORM = 'marketing.read_catalogue_platform';
export const MARKETING_READ_VIDEOS_OWNED = 'marketing.read_videos_owned';

/** `{ limit?: int }` — a bounded page size, the only knob most read tools take. */
const limit = (max: number) => z.number().int().min(1).max(max).optional();
/** Like {@link limit} but coerces a numeric string (the agents always did). */
const coerceLimit = (max: number) => z.coerce.number().int().min(1).max(max).optional();
const periodDays = () => z.coerce.number().int().min(1).max(365).optional();
/** A tolerant id: an id the caller cannot see yields "not found", never a crash. */
const entityId = () => z.string().min(1).max(64).optional();

const TOOL_LIST: readonly ToolDefinition[] = [
  {
    id: PLATFORM_METRICS,
    description: 'Platform-wide KPIs (users, products, orders, GMV, commission).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['users', 'products', 'suppliers', 'merchants', 'companies', 'orders', 'order_items', 'daily_kpis'],
    permission: 'analytics:read:all',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: PLATFORM_READ_ORDERS,
    description: 'Platform order summary — counts per status and totals.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(100) }).strict(),
    tables: ['orders'],
    permission: 'order:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: RISK_READ_OVERVIEW,
    description: 'Risk overview — top risk profiles and recent risk events.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['risk_profiles', 'risk_events'],
    permission: 'risk:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: DISPUTES_READ_SUMMARY,
    description: 'Dispute summary — open disputes and recent messages (read-only).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['disputes', 'dispute_messages'],
    permission: 'dispute:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: COMPLIANCE_READ_PLATFORM,
    description:
      'Platform compliance scan — unverified entities and open disputes (platform-wide aggregates).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['suppliers', 'merchants', 'companies', 'disputes'],
    permission: 'order:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: MARKET_READ_OVERVIEW,
    description:
      'Platform market overview — product/category/price aggregates and total order value.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['products', 'suppliers', 'merchants', 'orders'],
    permission: 'analytics:read:all',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: MARKET_READ_OWN,
    description:
      "The caller's own market slice — owned-catalogue product count and own-sales order value.",
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    tables: ['products', 'orders'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: ADS_READ_CAMPAIGNS,
    description:
      'Platform ad book — campaign budget/spend rows plus impression/click/conversion counts (admin-only).',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    tables: ['campaigns', 'ad_events'],
    permission: 'ad:manage',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: DEVELOPMENT_READ_PLATFORM,
    description:
      'Platform build context — user/product/order/campaign counts and the latest daily KPI (admin-only).',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    tables: ['users', 'products', 'orders', 'campaigns', 'daily_kpis'],
    permission: 'analytics:read:all',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: SUPPLIER_READ_OWN,
    description:
      "The caller's own supplier entities — id, name, country, verification and active flag. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
    effect: 'read',
    inputSchema: z.object({ supplierId: entityId(), limit: coerceLimit(100) }).strict(),
    tables: ['suppliers'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: MERCHANT_READ_OWN,
    description:
      "The caller's own merchant entities — id, name, country, verification and active flag. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
    effect: 'read',
    inputSchema: z.object({ merchantId: entityId(), limit: coerceLimit(100) }).strict(),
    tables: ['merchants', 'orders'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: SALES_READ_ORDERS_OWN,
    description:
      "The caller's own order book — KPI totals and recent orders, scoped to orders where the caller is the buyer or owns the seller entity. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
    effect: 'read',
    inputSchema: z.object({ periodDays: periodDays(), limit: coerceLimit(100) }).strict(),
    tables: ['orders'],
    permission: 'order:read:own',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: SALES_READ_ORDERS_PLATFORM,
    description:
      'Platform-wide order book — KPI totals and recent orders across every owner. Admin-only: the gateway refuses a non-admin requester.',
    effect: 'read',
    inputSchema: z.object({ periodDays: periodDays(), limit: coerceLimit(100) }).strict(),
    tables: ['orders'],
    permission: 'order:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: SALES_READ_MARKET_TOTALS,
    description:
      'Public market totals — active product/supplier/merchant/company counts and the average trust score. Aggregate figures only: no rows, ids or per-tenant detail.',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    tables: ['products', 'suppliers', 'merchants', 'companies', 'trust_scores'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: PRODUCT_READ_PUBLIC,
    description:
      'Public catalogue listing — a single published/ACTIVE product (or a sample when no id is given) with its category, variants, images and total stock. Public visibility only.',
    effect: 'read',
    inputSchema: z.object({ productId: entityId() }).strict(),
    tables: ['products', 'categories', 'product_variants', 'product_images', 'inventory_items'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: PRODUCT_READ_OWNED,
    description:
      "The caller's own product listings — a single product the caller owns (any status), or a sample of their own catalogue. Owner-scoped: the owner is resolved from the trusted run context, never the args.",
    effect: 'read',
    inputSchema: z.object({ productId: entityId() }).strict(),
    tables: ['products', 'categories', 'product_variants', 'product_images', 'inventory_items'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: PRODUCT_READ_PLATFORM,
    description:
      'Platform-wide catalogue — a single product of any owner and status (or a sample when no id is given). Admin-only: the gateway refuses a non-admin requester.',
    effect: 'read',
    inputSchema: z.object({ productId: entityId() }).strict(),
    tables: ['products', 'categories', 'product_variants', 'product_images', 'inventory_items'],
    permission: 'product:read',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: MARKETING_READ_CATALOGUE_OWNED,
    description:
      "The caller's own catalogue snapshot — count of published products and top categories/brands, scoped to listings the caller owns. Owner-scoped.",
    effect: 'read',
    inputSchema: z.object({ limit: coerceLimit(10) }).strict(),
    tables: ['products', 'categories'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
  {
    id: MARKETING_READ_CATALOGUE_PLATFORM,
    description:
      'Platform-wide catalogue snapshot — count of published products and top categories/brands across every seller. Admin-only.',
    effect: 'read',
    inputSchema: z.object({ limit: coerceLimit(10) }).strict(),
    tables: ['products', 'categories'],
    permission: 'analytics:read:all',
    platformScoped: true,
    idempotent: true,
  },
  {
    id: MARKETING_READ_VIDEOS_OWNED,
    description:
      "The caller's own generated marketing videos — recent assets with signed preview/download URLs. Owner-scoped.",
    effect: 'read',
    inputSchema: z.object({ limit: coerceLimit(10) }).strict(),
    tables: ['media_assets'],
    permission: 'ai:use',
    platformScoped: false,
    idempotent: true,
  },
];

/**
 * Tools declared in an agent's catalogue `allowedTools` with no bound
 * implementation. An id here is inert: it is not registered, has no handler, and
 * the gateway refuses it with `TOOL_NOT_REGISTERED`. Listing it keeps the
 * declaration honest instead of silently missing.
 *
 * Why each is unbound:
 *  - `finance.read_ledger`     — its source is `transaction_ledger` /
 *                                `commission_policies`, both hard-denied. It must
 *                                be served by an authorised pre-aggregate, not a
 *                                direct read (see FUTURE_TOOL_CONTRACTS).
 *  - `payments.read_settlements` — its source is `payouts` /
 *                                `payment_webhook_events`, both hard-denied, and
 *                                the reference handler used raw SQL.
 *  - `operations.read_health`  — needs raw SQL for the low-stock predicate and
 *                                reads `agent_tasks`, which no A2 contract grants.
 *  - `platform.read_catalog` / `report.generate` — aggregate surfaces not built.
 *  - `outreach.*`              — external discovery/sending is not enabled.
 */
export const UNBOUND_DECLARED_TOOLS: readonly string[] = [
  'platform.read_catalog',
  'report.generate',
  FINANCE_READ_LEDGER,
  PAYMENTS_READ_SETTLEMENTS,
  OPERATIONS_READ_HEALTH,
  'outreach.discover_entities',
  'outreach.verify_entity',
  'outreach.classify_fit',
  'outreach.persist_prospects',
  'messaging.draft_outreach',
  'outreach.persist_drafts',
  'outreach.record_outcome',
  'outreach.refer',
];

/**
 * Declaration-only contracts for tools that must NOT be bound to a live data
 * source yet. These are documentation objects, not executable definitions: they
 * carry no handler, are absent from the registry, and cannot be invoked.
 *
 * `finance.read_ledger` is the first entry. The approved shape is an aggregate
 * read served from an authorised financial summary — it must never touch
 * `transaction_ledger`, `commission_policies`, `payouts`, `refunds` or any other
 * hard-denied table directly.
 */
export interface FutureToolContract {
  readonly id: string;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  /** The response shape the future implementation must return. */
  readonly outputContract: readonly string[];
  /** Why the tool cannot be bound yet. */
  readonly blockedBy: string;
}

export const FUTURE_TOOL_CONTRACTS: readonly FutureToolContract[] = [
  {
    id: FINANCE_READ_LEDGER,
    description:
      'Aggregated financial summary — commission, payment fees, refunds and settlement totals per currency, plus the active commission policy names and rates.',
    effect: 'read',
    inputSchema: z
      .object({ currencyCode: z.string().min(1).max(8).optional() })
      .strict(),
    outputContract: [
      'currencyCode: string',
      'totals.commission: string',
      'totals.paymentFees: string',
      'totals.refunds: string',
      'totals.settlement: string',
      'activePolicies: { name: string; policyType: string; rate: string }[]',
    ],
    blockedBy:
      'Requires an authorised pre-aggregated financial source. Direct reads of transaction_ledger and commission_policies are hard-denied for every agent.',
  },
  {
    id: PAYMENTS_READ_SETTLEMENTS,
    description:
      'Aggregated settlement status — counts of payment intents, webhook deliveries and payouts per status.',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    outputContract: [
      'intentsByStatus: { status: string; count: number }[]',
      'webhooksByStatus: { status: string; count: number }[]',
      'payoutsByStatus: { status: string; count: number }[]',
      'anomalies.deadLetteredWebhooks: number',
      'anomalies.failedPayouts: number',
    ],
    blockedBy:
      'Requires a settlement aggregate view. payouts and payment_webhook_events are hard-denied, and the previous implementation used raw SQL.',
  },
  {
    id: OPERATIONS_READ_HEALTH,
    description:
      'Operational health — order pipeline counts, failed agent tasks, open disputes and low-stock items.',
    effect: 'read',
    inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }).strict(),
    outputContract: [
      'orderPipeline: { status: string; count: number }[]',
      'failedAgentTasks: number',
      'openDisputes: number',
      'lowStockItems: number',
    ],
    blockedBy:
      'The low-stock predicate needs a Drizzle expression instead of raw SQL, and agent_tasks needs its own A2 contract. Neither is in scope for R2.',
  },
];

const REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map(TOOL_LIST.map((t) => [t.id, t]));

// ------------------------------------------------------------------ invariants
// Structural errors surface at load time rather than at call time.
const UNBOUND = new Set(UNBOUND_DECLARED_TOOLS);
for (const tool of TOOL_LIST) {
  if (UNBOUND.has(tool.id)) {
    throw new Error(`Tool Gateway: "${tool.id}" is both registered and unbound`);
  }
  if (tool.effect !== 'read') {
    throw new Error(`Tool Gateway: "${tool.id}" declares a non-read effect; writes are not enabled`);
  }
  for (const table of tool.tables) {
    if (HARD_DENY_TABLES.has(table)) {
      throw new Error(`Tool Gateway: "${tool.id}" reads hard-denied table "${table}"`);
    }
    if (PLATFORM_INFRA_TABLES.has(table)) {
      throw new Error(`Tool Gateway: "${tool.id}" reads platform-infra table "${table}"`);
    }
  }
}
for (const contract of FUTURE_TOOL_CONTRACTS) {
  if (REGISTRY.has(contract.id)) {
    throw new Error(`Tool Gateway: future contract "${contract.id}" must not be registered`);
  }
}

/** The registered tool ids, in declaration order (for tests and docs). */
export function registeredToolIds(): string[] {
  return TOOL_LIST.map((t) => t.id);
}

/** All registered tool definitions. */
export function allTools(): readonly ToolDefinition[] {
  return TOOL_LIST;
}

/** Looks up a registered tool, or `undefined` when the id is unknown. */
export function findTool(id: string): ToolDefinition | undefined {
  return REGISTRY.get(id);
}

/** True when `id` is a registered tool. */
export function isRegisteredTool(id: string): boolean {
  return REGISTRY.has(id);
}

/** True when `id` is declared by a catalogue but deliberately not bound. */
export function isUnboundTool(id: string): boolean {
  return UNBOUND.has(id);
}

/** Every tool id the catalogue declares: registered + unbound. */
export function declaredToolIds(): string[] {
  return [...TOOL_LIST.map((t) => t.id), ...UNBOUND_DECLARED_TOOLS];
}

/**
 * The registered tools an agent's catalogue binds it to — `allowedTools`
 * intersected with the registry.
 *
 * This is a *scoping* list, NOT an authority: it only bounds which registered
 * tools the agent may even attempt. `allowedTools` alone never authorizes
 * execution — the gateway still enforces registration, the trusted run context,
 * RBAC, platform scope, the schema and the table guard on top, so a
 * declared-but-unregistered id is inert.
 */
export function toolGrantForAgent(agent: AgentDefinition): string[] {
  return (agent.allowedTools ?? []).filter((id) => REGISTRY.has(id));
}

/** The declared tools of an agent that are unbound (inert) — for honest reporting. */
export function unboundToolsForAgent(agent: AgentDefinition): string[] {
  return (agent.allowedTools ?? []).filter((id) => UNBOUND.has(id));
}

/** True when the role set may read platform-wide data (admins only). */
export function rolesAllowPlatformScope(roles: readonly UserRole[]): boolean {
  return resolvePlatformScope({ roles: roles as UserRole[] });
}

/** True when a role set satisfies a permission (admins bypass, as elsewhere). */
export function rolesHoldPermission(
  roles: readonly UserRole[],
  permission: string,
  rolePermissions: Record<string, ReadonlySet<string>>,
): boolean {
  if (roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) return true;
  return roles.some((r) => rolePermissions[r]?.has(permission));
}
