import { z } from 'zod';
import type { AgentDefinition } from './types';
import type { UserRole } from '@wasit/shared';
import { resolvePlatformScope } from '../../modules/ai/scope';

/**
 * Central Tool Gateway registry (AI-02.1).
 *
 * Every tool an agent may invoke is declared here, exactly once, with:
 *  - a stable `id` (also the action id the run context must grant),
 *  - a Zod input schema the gateway validates BEFORE execution,
 *  - the effect class (`read` only in this phase — no writes exist yet),
 *  - the platform permission a caller must hold,
 *  - whether the tool reads platform-wide data (admin-only) and whether it may
 *    run for the trusted scheduler principal.
 *
 * The registry is the single source of truth: the gateway refuses any id that is
 * not registered here, so an agent can never invoke an unregistered (or a
 * "declared but unbound") tool. Registration does NOT by itself authorize a
 * call — the run's server-derived grant list and the RBAC/scope checks still
 * apply on top.
 */

export type ToolEffect = 'read';

export interface ToolDefinition {
  /** Stable tool id; also the action id the run context must grant. */
  readonly id: string;
  readonly description: string;
  readonly effect: ToolEffect;
  /** Zod schema validated against the caller's args before execution. */
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  /** Platform permission the requester must hold (admins bypass). */
  readonly permission: string;
  /** True when the tool returns platform-wide data → admin roles only. */
  readonly platformScoped: boolean;
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
// G5 Phase 1: platform-scoped reads moved out of the two executors that kept an
// inline `requirePlatformGate` (ads-agent, development-agent). Each mirrors the
// exact cross-owner aggregates those executors already read, so routing them
// through the gateway changes no result and grants no new authority.
export const ADS_READ_CAMPAIGNS = 'ads.read_campaigns';
export const DEVELOPMENT_READ_PLATFORM = 'development.read_platform';
// G5 Phase 2 (A1): the supplier agent's owned-entity read moved behind the
// gateway. It mirrors the exact owner-scoped query `execSupplierAgent` already
// ran (owned supplier entities only), so routing it changes no result and grants
// no new authority — the owner is resolved from the trusted run context.
export const SUPPLIER_READ_OWN = 'supplier.read_owned';
// G5 Phase 2 (A2): the merchant agent's owned-entity read moved behind the
// gateway. It mirrors the exact owner-scoped query `execMerchantAgent` already
// ran (owned merchant entities only), so routing it changes no result and grants
// no new authority — the owner is resolved from the trusted run context.
export const MERCHANT_READ_OWN = 'merchant.read_owned';
// G5 Phase 2 (A3): the sales agent's reads moved behind the gateway. It is a
// dual-scope agent: its own order book (owner) and the platform-wide order book
// (admins) come from two tools, while the public catalogue/entity counts it
// always exposed come from a third. Each mirrors the exact query
// `execSalesAgent` already ran, so routing them changes no result and grants no
// new authority — the owner is resolved from the trusted run context.
export const SALES_READ_ORDERS_OWN = 'sales.read_orders_owned';
export const SALES_READ_ORDERS_PLATFORM = 'sales.read_orders_platform';
export const SALES_READ_MARKET_TOTALS = 'sales.read_market_totals';
// G5 Phase 2 (A4): the product agent's reads moved behind the gateway. The agent
// applies a three-tier product-visibility policy, so it is served by three tools
// instead of one: the public catalogue listing, the caller's OWN listings (any
// status), and the platform-wide catalogue (admins). Each mirrors the exact
// query `execProductAgent` already ran, so routing them changes no result and
// grants no new authority — the owner is resolved from the trusted run context.
export const PRODUCT_READ_PUBLIC = 'product.read_public';
export const PRODUCT_READ_OWNED = 'product.read_owned';
export const PRODUCT_READ_PLATFORM = 'product.read_platform';

/** `{ limit?: int }` — a bounded page size, the only knob the read tools take. */
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const TOOL_LIST: readonly ToolDefinition[] = [
  {
    id: PLATFORM_METRICS,
    description: 'Platform-wide KPIs (users, products, orders, GMV, commission).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'analytics:read:all',
    platformScoped: true,
  },
  {
    id: PLATFORM_READ_ORDERS,
    description: 'Platform order summary — counts per status and totals.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(100) }).strict(),
    permission: 'order:read',
    platformScoped: true,
  },
  {
    id: OPERATIONS_READ_HEALTH,
    description: 'Operational health — failed agent tasks, open disputes, low-stock items.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'ai:manage',
    platformScoped: true,
  },
  {
    id: RISK_READ_OVERVIEW,
    description: 'Risk overview — top risk profiles and recent risk events.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'risk:read',
    platformScoped: true,
  },
  {
    id: DISPUTES_READ_SUMMARY,
    description: 'Dispute summary — open disputes and recent messages (read-only).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'dispute:read',
    platformScoped: true,
  },
  {
    id: PAYMENTS_READ_SETTLEMENTS,
    description: 'Payment/settlement status — intents, webhook health, payouts.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(100) }).strict(),
    permission: 'payment:read',
    platformScoped: true,
  },
  {
    id: FINANCE_READ_LEDGER,
    description: 'Financial ledger summary — flows, active commission policies, recent entries.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(100), currencyCode: z.string().min(1).max(8).optional() }).strict(),
    permission: 'revenue:read',
    platformScoped: true,
  },
  {
    id: COMPLIANCE_READ_PLATFORM,
    description: 'Platform compliance scan — unverified entities and open disputes (platform-wide aggregates).',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'order:read',
    platformScoped: true,
  },
  {
    id: MARKET_READ_OVERVIEW,
    description: 'Platform market overview — product/category/price aggregates and total order value.',
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'analytics:read:all',
    platformScoped: true,
  },
  {
    id: MARKET_READ_OWN,
    description: "The caller's own market slice — owned-catalogue product count and own-sales order value.",
    effect: 'read',
    inputSchema: z.object({ limit: limit(50) }).strict(),
    permission: 'ai:use',
    platformScoped: false,
  },
  {
    id: ADS_READ_CAMPAIGNS,
    description: 'Platform ad book — campaign budget/spend rows plus impression/click/conversion counts (admin-only).',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    permission: 'ad:manage',
    platformScoped: true,
  },
  {
    id: DEVELOPMENT_READ_PLATFORM,
    description: 'Platform build context — user/product/order/campaign counts and the latest daily KPI (admin-only).',
    effect: 'read',
    inputSchema: z.object({}).strict(),
    permission: 'analytics:read:all',
    platformScoped: true,
  },
  {
    id: SUPPLIER_READ_OWN,
    description:
      "The caller's own supplier entities — id, name, country, verification and active flag. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
    effect: 'read',
    // Owner-scoped: any caller permitted to use AI may read their OWN entities.
    // `platformScoped: false` means the gateway does NOT require an admin; the
    // owner is taken from the trusted run context, so a caller can only ever
    // read the supplier entities they own.
    inputSchema: z
      .object({
        // Tolerant of a non-UUID id on purpose: an id the caller does not own
        // yields an empty scope (a "not found in your scope" note), never a
        // validation error and never another tenant's record.
        supplierId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict(),
      permission: 'ai:use',
      platformScoped: false,
    },
    {
      id: MERCHANT_READ_OWN,
      description:
        "The caller's own merchant entities — id, name, country, verification and active flag. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
      effect: 'read',
      // Owner-scoped: any caller permitted to use AI may read their OWN entities.
      // `platformScoped: false` means the gateway does NOT require an admin; the
      // owner is taken from the trusted run context, so a caller can only ever
      // read the merchant entities they own.
      inputSchema: z
        .object({
          // Tolerant of a non-UUID id on purpose: an id the caller does not own
          // yields an empty scope (a "not found in your scope" note), never a
          // validation error and never another tenant's record.
          merchantId: z.string().min(1).max(64).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict(),
      permission: 'ai:use',
      platformScoped: false,
    },
    {
      id: SALES_READ_ORDERS_OWN,
      description:
        "The caller's own order book — KPI totals (orders, GMV, commission, payment fees, net) and recent orders, scoped to orders where the caller is the buyer or owns the seller entity. Owner-scoped: the owner is resolved from the trusted run context, never from the args.",
      effect: 'read',
      // Owner-scoped: the caller reads only orders tied to entities they own (as
      // buyer or seller). `platformScoped: false` means the gateway does NOT
      // require an admin; the owner is taken from the trusted run context, so a
      // caller can never widen the read to another tenant's orders.
      inputSchema: z
        .object({
          periodDays: z.coerce.number().int().min(1).max(365).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict(),
      permission: 'order:read:own',
      platformScoped: false,
    },
    {
      id: SALES_READ_ORDERS_PLATFORM,
      description:
        'Platform-wide order book — KPI totals and recent orders across every owner. Admin-only: the gateway refuses a non-admin requester.',
      effect: 'read',
      inputSchema: z
        .object({
          periodDays: z.coerce.number().int().min(1).max(365).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict(),
      permission: 'order:read',
      platformScoped: true,
    },
    {
      id: SALES_READ_MARKET_TOTALS,
      description:
        'Public market totals — active product/supplier/merchant/company counts and the average trust score. Aggregate figures only: no rows, ids or per-tenant detail.',
      effect: 'read',
      // Public aggregates the sales agent has always surfaced to every caller.
      // Kept off the platform gate on purpose: it returns only summed counts, so
      // it leaks no tenant's detail and preserves the previous behaviour.
      inputSchema: z.object({}).strict(),
      permission: 'ai:use',
      platformScoped: false,
    },
    {
      id: PRODUCT_READ_PUBLIC,
      description:
        'Public catalogue listing — a single published/ACTIVE product (or a sample when no id is given) with its category, variants, images and total stock. Public visibility only: an unpublished or non-ACTIVE listing is invisible to a non-owner.',
      effect: 'read',
      // The public tier the product agent has always exposed to every caller. It
      // mirrors `pickProduct`'s `is_published AND status='ACTIVE'` predicate, so
      // it leaks no unpublished listing and preserves the previous behaviour.
      inputSchema: z
        .object({
          // Tolerant of a non-UUID id on purpose: an id the caller cannot see
          // yields an empty scope ("not found"), never a validation error.
          productId: z.string().min(1).max(64).optional(),
        })
        .strict(),
      permission: 'ai:use',
      platformScoped: false,
    },
    {
      id: PRODUCT_READ_OWNED,
      description:
        "The caller's own product listings — a single product the caller owns (any status), or a sample of their own catalogue when no id is given, with category, variants, images and total stock. Owner-scoped: the owner is resolved from the trusted run context, never the args.",
      effect: 'read',
      // Owner-scoped: the caller reads only listings tied to a seller entity they
      // own. `platformScoped: false` means the gateway does NOT require an admin;
      // the owner is taken from the trusted run context, so a caller can never
      // widen the read to another tenant's listing.
      inputSchema: z
        .object({
          productId: z.string().min(1).max(64).optional(),
        })
        .strict(),
      permission: 'ai:use',
      platformScoped: false,
    },
    {
      id: PRODUCT_READ_PLATFORM,
      description:
        'Platform-wide catalogue — a single product of any owner and status (or a sample when no id is given) with category, variants, images and total stock. Admin-only: the gateway refuses a non-admin requester.',
      effect: 'read',
      inputSchema: z
        .object({
          productId: z.string().min(1).max(64).optional(),
        })
        .strict(),
      permission: 'product:read',
      platformScoped: true,
    },
  ];

/**
 * Tools declared in agent `allowedTools` but with no bound implementation yet.
 *
 * This list MUST equal the set of declared ids that are absent from the registry
 * (see the `tool-gateway` spec, which derives that set from the catalogue). An
 * id here is inert: it is not registered, has no handler, and
 * `toolGrantForAgent` filters it out, so it can never be executed — listing it
 * only makes the declaration honest instead of silently missing.
 */
export const UNBOUND_DECLARED_TOOLS: readonly string[] = [
  'platform.read_catalog',
  'report.generate',
  'outreach.discover_entities',
  // Outreach acquisition surface declared by the `outreach-acquisition-agent`
  // but not yet implemented as gateway tools.
  'outreach.verify_entity',
  'outreach.classify_fit',
  'outreach.persist_prospects',
  'messaging.draft_outreach',
  'outreach.persist_drafts',
  'outreach.record_outcome',
  'outreach.refer',
];

const REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map(TOOL_LIST.map((t) => [t.id, t]));

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

/**
 * The registered tools an agent's catalogue binds it to — `allowedTools`
 * intersected with the registry.
 *
 * This is a *scoping* list, NOT an authority: it only bounds which registered
 * tools the agent may even attempt. `allowedTools` alone never authorizes
 * execution — the gateway still enforces registration, the trusted run context,
 * RBAC and data scope on top, so a declared-but-unregistered id is inert.
 */
export function toolGrantForAgent(agent: AgentDefinition): string[] {
  return (agent.allowedTools ?? []).filter((id) => REGISTRY.has(id));
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

