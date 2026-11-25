import { env } from '../env';
import { rateLimitStoreRequired } from './resolve';

/**
 * AI-RATE-LIMIT-01 — one place that decides how hard each AI surface may be hit.
 *
 * The AI APIs are the only part of WASIT where a request can cost money: a
 * feature call may reach a vendor, an agent task runs an executor, a provider
 * probe opens a socket. A single flat limit cannot express that — it is either
 * too loose for the money paths or too tight for the read paths — so every AI
 * route is assigned to a class with its own ceiling.
 *
 * The table below is the whole policy. It is mounted once from `app.ts` through
 * `aiRateLimitMounts()`, and `tests/ai-rate-limit-01.test.ts` asserts that every
 * non-GET route registered under `/api/ai` and `/api/admin/ai` is matched by a
 * rule here, so a new route cannot silently ship unlimited.
 */

export type AiLimitClassId =
  | 'ai.read'
  | 'ai.feature'
  | 'ai.agent'
  | 'ai.memory'
  | 'ai.admin.read'
  | 'ai.admin.control'
  | 'ai.provider';

/** What the limiter does when the counter store cannot answer. */
export type StoreErrorMode = 'closed' | 'open';

export interface AiLimitClass {
  /** Whether a call in this class can spend provider money. */
  paid: boolean;
  /** Whether platform staff get the bounded `AI_RATE_LIMIT_ADMIN_MULTIPLIER`. */
  staffMultiplier: boolean;
  /** Fail closed on a store outage for anything that can cost money. */
  onStoreError: StoreErrorMode;
  /** Ceiling per window, before the staff multiplier. */
  max: () => number;
  description: string;
}

/**
 * Defaults are deliberately conservative for money paths and roomy for reads.
 * Every one is an env knob (see `env.ts`); nothing here is a hidden constant.
 */
function readMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_READ_MAX;
}
function featureMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_FEATURE_MAX;
}
function agentMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_AGENT_MAX;
}
function memoryMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_MEMORY_MAX;
}
function adminReadMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_ADMIN_READ_MAX;
}
function adminControlMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_ADMIN_CONTROL_MAX;
}
function providerMax(): number {
  return env.RATE_LIMIT_AI_MAX ?? env.AI_RATE_LIMIT_PROVIDER_MAX;
}

export const AI_LIMIT_CLASSES: Readonly<Record<AiLimitClassId, AiLimitClass>> = {
  'ai.read': {
    paid: false,
    staffMultiplier: false,
    onStoreError: 'open',
    max: readMax,
    description: 'Read-only AI surfaces: status, models, task and memory listings, activity.',
  },
  'ai.feature': {
    paid: true,
    staffMultiplier: false,
    onStoreError: 'closed',
    max: featureMax,
    description: 'Vendor-backed AI features: run, smart search, recommendations, price/sales intelligence.',
  },
  'ai.agent': {
    paid: true,
    staffMultiplier: false,
    onStoreError: 'closed',
    max: agentMax,
    description: 'Agent work: creating tasks and deciding approvals (each runs an executor).',
  },
  'ai.memory': {
    paid: false,
    staffMultiplier: false,
    onStoreError: 'open',
    max: memoryMax,
    description: 'Local agent memory writes (DB only, no provider call).',
  },
  'ai.admin.read': {
    paid: false,
    staffMultiplier: true,
    onStoreError: 'open',
    max: adminReadMax,
    description: 'Admin AI dashboards: usage, runs, metrics, budgets, kill switch reads.',
  },
  'ai.admin.control': {
    paid: true,
    staffMultiplier: true,
    onStoreError: 'closed',
    max: adminControlMax,
    description: 'Admin AI writes: budgets, models, spend limits/guard, kill switch, runs, purges.',
  },
  'ai.provider': {
    paid: true,
    // No staff allowance here: a probe opens a socket to the vendor and can
    // cost money, so an admin account gets the same ceiling as the policy says.
    staffMultiplier: false,
    onStoreError: 'closed',
    max: providerMax,
    description: 'Provider configuration: enabling, key storage and live connection probes.',
  },
};

export interface AiLimitRule {
  /** Hono path pattern. */
  pattern: string;
  /** Methods this rule covers; other methods fall through untouched. */
  methods: readonly string[];
  id: AiLimitClassId;
  /** Prefixes never counted against this rule (avoids double-counting). */
  exemptPaths?: readonly string[];
}

const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Route → class. Ordered most specific first; the two catch-alls at the bottom
 * exist so a route added tomorrow is still limited by its method (reads) while
 * the coverage test forces an explicit class for any new write.
 */
export const AI_LIMIT_RULES: readonly AiLimitRule[] = [
  // --- agent work (money) ---------------------------------------------------
  { pattern: '/api/ai/agents/:agentKey/tasks', methods: ['POST'], id: 'ai.agent' },
  { pattern: '/api/ai/tasks/:taskId/approve', methods: ['POST'], id: 'ai.agent' },
  { pattern: '/api/ai/tasks/:taskId/reject', methods: ['POST'], id: 'ai.agent' },

  // --- vendor-backed features (money) --------------------------------------
  { pattern: '/api/ai/run', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/smart-search', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/recommendations', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/market-analysis', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/supplier-recommendations', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/price-intelligence', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/sales-intelligence', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/ads-recommendations', methods: ['POST'], id: 'ai.feature' },
  { pattern: '/api/ai/analyze/product', methods: ['POST'], id: 'ai.feature' },

  // --- local memory writes (cheap) -----------------------------------------
  { pattern: '/api/ai/memory', methods: ['POST'], id: 'ai.memory' },
  { pattern: '/api/ai/memory/:memoryId', methods: ['PATCH', 'DELETE'], id: 'ai.memory' },

  // --- everything else that only reads -------------------------------------
  { pattern: '/api/ai/*', methods: ['GET'], id: 'ai.read' },

  // --- admin ---------------------------------------------------------------
  { pattern: '/api/admin/ai/providers/*', methods: WRITE, id: 'ai.provider' },
  {
    pattern: '/api/admin/ai/*',
    methods: WRITE,
    id: 'ai.admin.control',
    exemptPaths: ['/api/admin/ai/providers'],
  },
  { pattern: '/api/admin/ai/*', methods: ['GET'], id: 'ai.admin.read' },
];

/** Per-IP backstop shared by every AI surface (bounds account rotation). */
export const AI_IP_BACKSTOP_PATTERNS: readonly string[] = ['/api/ai/*', '/api/admin/ai/*'];

export function aiLimitWindowSeconds(): number {
  return env.RATE_LIMIT_AI_WINDOW_SECONDS;
}

/**
 * Whether paid AI classes must run on a shared counter store. True in production
 * and staging without any way to opt out: with the in-process store, N instances
 * each allow the full ceiling, so the effective limit is N × max and the
 * guarantee is gone. Locally it follows `AI_RATE_LIMIT_REQUIRE_DURABLE`.
 */
export function requireDurableAiStore(): boolean {
  return rateLimitStoreRequired();
}

/** Bounded staff allowance — a multiplier, never an exemption. */
export function aiStaffMultiplier(): number {
  return env.AI_RATE_LIMIT_ADMIN_MULTIPLIER;
}

/** True when `path` is covered by at least one rule for `method`. */
export function isAiPathCovered(path: string, method: string): boolean {
  const upper = method.toUpperCase();
  return AI_LIMIT_RULES.some(
    (rule) => rule.methods.includes(upper) && matchPattern(rule.pattern, path),
  );
}

/** Hono-style pattern match (`:param` = one segment, `*` = any tail). */
function matchPattern(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  for (let i = 0; i < patternParts.length; i += 1) {
    const part = patternParts[i];
    if (part === '*') return true;
    if (i >= pathParts.length) return false;
    if (part.startsWith(':') || part === pathParts[i]) continue;
    return false;
  }
  return patternParts.length === pathParts.length;
}
