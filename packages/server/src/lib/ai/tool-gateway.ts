import { ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { writeAudit } from '../audit';
import { getAgentRunContext, requireAction, ActionNotAuthorizedError } from './agent-run-context';
import { isAiExecutionEnabled } from './kill-switch';
import { assertTableAccess } from '../../modules/ai/agent-scope';
import {
  findTool,
  isRegisteredTool,
  isUnboundTool,
  rolesAllowPlatformScope,
  rolesHoldPermission,
  type ToolDefinition,
} from './tool-registry';
import { getToolHandler } from './tool-handlers';

/**
 * Central Tool Gateway.
 *
 * The single, mandatory chokepoint every agent tool invocation must pass
 * through. It composes the existing guards — it does NOT create a parallel
 * permission system:
 *
 *  - A1 trusted run context (`getAgentRunContext`, `requireAction`),
 *  - A1 kill switch (`isAiExecutionEnabled`),
 *  - A2 data scope (`assertTableAccess` over the tool's declared tables),
 *  - RBAC (`ROLE_PERMISSIONS` from `@wasit/shared`),
 *  - platform scope (`rolesAllowPlatformScope`).
 *
 * Fail-closed by construction: an unknown tool, an unbound tool, a stopped
 * platform, an absent run context, an ungranted action, a missing permission, a
 * platform-scoped tool reached by a non-admin, a table outside the agent's scope,
 * or an invalid argument all refuse BEFORE the handler runs — and every attempt,
 * allowed or refused, is written to the audit log.
 */

/** Thrown when the gateway refuses a tool invocation. `code` is a stable reason. */
export class ToolGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly toolId: string,
  ) {
    super(message);
    this.name = 'ToolGatewayError';
  }
}

export interface InvokeToolOptions {
  /**
   * The task id to attribute the audit entry to. Defaults to the trusted run
   * context's task id; the run context always wins when present.
   */
  readonly taskId?: string;
  /** Execution deadline in ms; defaults to 15s. */
  readonly timeoutMs?: number;
  /** Audit context (actor/ip/user-agent). The actor defaults to the run principal. */
  readonly audit?: { actorId?: string | null; ipAddress?: string | null; userAgent?: string | null };
  /**
   * Optional idempotency key. When supplied and the tool is `idempotent`, a
   * repeated call with the same key returns the cached result instead of
   * re-running the handler. Without a key, no caching happens.
   */
  readonly idempotencyKey?: string;
  /** The per-invocation idempotency cache; defaults to the process-wide one. */
  readonly cache?: IdempotencyCache;
}

export interface ToolInvocationResult {
  readonly toolId: string;
  readonly effect: ToolDefinition['effect'];
  readonly data: Record<string, unknown>;
  readonly latencyMs: number;
  /** True when the result was served from the idempotency cache. */
  readonly replayed: boolean;
}

/**
 * A bounded, TTL'd idempotency cache.
 *
 * Only `idempotent` (read-only, side-effect-free) tools are ever cached, so a
 * replay cannot skip a write — there are no writes to skip. Entries expire so a
 * long-lived process cannot serve arbitrarily stale data, and the cache is
 * bounded so a hostile key space cannot grow it without limit.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, { data: Record<string, unknown>; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): Record<string, unknown> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.data;
  }

  set(key: string, data: Record<string, unknown>): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The process-wide cache used when a caller does not supply one. */
export const defaultIdempotencyCache = new IdempotencyCache();

/** Resolves a promise with a rejection if it does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Best-effort redaction of argument values for the audit trail. Read-tool args
 * are bounded scalars (no secrets), but the value is length-capped so a hostile
 * payload cannot bloat the log.
 */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = v.length > 64 ? `${v.slice(0, 64)}…` : v;
    else out[k] = v;
  }
  return out;
}

/**
 * The single entry point for invoking a registered tool.
 *
 * Order of checks (each fails closed, and each refusal is audited):
 *  1. the tool id must be registered — an unbound or unknown id is refused;
 *  2. the platform kill switch must be ON;
 *  3. a trusted run context must be present (identity is never taken from args);
 *  4. the run's server-derived grant list must include the tool id
 *     (`requireAction` — reuses A1, no parallel system);
 *  5. the requester's roles must satisfy the tool's permission;
 *  6. a platform-scoped tool requires an admin requester;
 *  7. the args must satisfy the tool's Zod schema;
 *  8. every table the tool declares must be inside the run's A2 data scope;
 *  9. the handler runs under a deadline; success is audited with timing.
 */
export async function invokeTool(
  db: DB,
  toolId: string,
  args: Record<string, unknown> = {},
  opts: InvokeToolOptions = {},
): Promise<ToolInvocationResult> {
  const ctx = getAgentRunContext();
  const auditCtx = {
    actorId: opts.audit?.actorId ?? ctx?.requestedBy ?? null,
    ipAddress: opts.audit?.ipAddress ?? null,
    userAgent: opts.audit?.userAgent ?? null,
  };
  const auditTaskId = ctx?.taskId ?? opts.taskId ?? null;
  const auditBase = { toolId, taskId: auditTaskId, agentKey: ctx?.agentKey ?? null };

  const refuse = async (code: string, message: string): Promise<never> => {
    await writeAudit(db, auditCtx, {
      action: 'AI.TOOL_REFUSED',
      entityType: 'TOOL',
      entityId: toolId,
      metadata: { ...auditBase, code, message, args: redact(args) },
    }).catch(() => undefined);
    throw new ToolGatewayError(code, message, toolId);
  };

  // (1) Registration is mandatory — an unregistered or deliberately unbound tool
  // can never run, whether or not the catalogue declares it.
  if (isUnboundTool(toolId)) {
    return refuse(
      'TOOL_NOT_BOUND',
      `Tool "${toolId}" is declared but has no bound implementation on this build`,
    );
  }
  const tool = findTool(toolId);
  if (!tool || !isRegisteredTool(toolId)) {
    return refuse('TOOL_NOT_REGISTERED', `Tool "${toolId}" is not registered with the gateway`);
  }

  // (2) The emergency stop halts every attempt, before any identity or data work.
  if (!isAiExecutionEnabled()) {
    return refuse('AI_EXECUTION_DISABLED', 'AI execution is disabled by the platform kill switch');
  }

  // (3) A trusted run context is required; identity/scope never come from args.
  if (!ctx) {
    return refuse('NO_RUN_CONTEXT', 'Tool invocation requires a trusted agent run context');
  }

  // (4) The run must have been granted this tool id. The grant list is the
  // agent's registry-bound `allowedTools`, carried on the trusted run context —
  // reusing A1's `requireAction` (no parallel permission system). The `'tools'`
  // scope selects the trusted tool list; no caller-supplied array is accepted.
  try {
    requireAction(toolId, 'tools');
  } catch (err) {
    if (err instanceof ActionNotAuthorizedError) {
      return refuse('ACTION_NOT_AUTHORIZED', `Action "${toolId}" is not granted to this run`);
    }
    throw err;
  }

  const roles = (ctx.requesterRoles ?? []) as UserRole[];

  // (5) RBAC: the requester must hold the tool's permission.
  if (
    !rolesHoldPermission(
      roles,
      tool.permission,
      ROLE_PERMISSIONS as unknown as Record<string, ReadonlySet<string>>,
    )
  ) {
    return refuse('PERMISSION_DENIED', `Requester lacks permission "${tool.permission}" for tool "${toolId}"`);
  }

  // (6) Platform-scoped tools are admin-only. The scheduler principal is not an
  // admin and is refused for cross-tenant tools.
  if (tool.platformScoped && !rolesAllowPlatformScope(roles)) {
    return refuse('PLATFORM_SCOPE_DENIED', `Tool "${toolId}" requires an admin role for platform-wide data`);
  }

  // (7) Validate the caller's args against the tool's schema BEFORE execution.
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return refuse(
      'INVALID_INPUT',
      `Invalid input for tool "${toolId}": ${parsed.error.issues
        .map((i) => i.path.join('.') || '(root)')
        .join(', ')}`,
    );
  }

  // (8) A2: every declared table must be readable by this run. `assertTableAccess`
  // is the SAME boundary the scoped handle uses, so the gateway cannot become a
  // bypass around A2 — a tool whose data source is outside the agent's contract
  // is refused here, before the handler runs.
  for (const table of tool.tables) {
    try {
      assertTableAccess(ctx, table, 'read');
    } catch (err) {
      return refuse(
        'SCOPE_DENIED',
        `Tool "${toolId}" reads "${table}", which is outside the scope of agent "${ctx.agentKey}": ${
          (err as Error).message
        }`,
      );
    }
  }

  // (9) Execute under a deadline. A handler failure or timeout is audited as a
  // failure (never a silent success) and re-thrown.
  const handler = getToolHandler(toolId);
  if (!handler) {
    return refuse('TOOL_NOT_IMPLEMENTED', `Tool "${toolId}" has no bound implementation`);
  }

  const cache = opts.cache ?? defaultIdempotencyCache;
  const cacheKey =
    opts.idempotencyKey && tool.idempotent
      ? `${ctx.agentKey}|${ctx.taskId}|${toolId}|${opts.idempotencyKey}`
      : null;
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      await writeAudit(db, auditCtx, {
        action: 'AI.TOOL_REPLAYED',
        entityType: 'TOOL',
        entityId: toolId,
        metadata: { ...auditBase, effect: tool.effect, idempotencyKey: opts.idempotencyKey },
      }).catch(() => undefined);
      return { toolId, effect: tool.effect, data: cached, latencyMs: 0, replayed: true };
    }
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const started = Date.now();
  let data: Record<string, unknown>;
  try {
    data = await withTimeout(
      handler(db, parsed.data),
      timeoutMs,
      () => new ToolGatewayError('TOOL_TIMEOUT', `Tool "${toolId}" exceeded ${timeoutMs}ms`, toolId),
    );
  } catch (err) {
    const code = err instanceof ToolGatewayError ? err.code : 'TOOL_EXECUTION_FAILED';
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    await writeAudit(db, auditCtx, {
      action: 'AI.TOOL_FAILED',
      entityType: 'TOOL',
      entityId: toolId,
      metadata: { ...auditBase, code, message, latencyMs: Date.now() - started },
    }).catch(() => undefined);
    throw err instanceof ToolGatewayError ? err : new ToolGatewayError(code, message, toolId);
  }
  const latencyMs = Date.now() - started;

  if (cacheKey) cache.set(cacheKey, data);

  await writeAudit(db, auditCtx, {
    action: 'AI.TOOL_EXECUTED',
    entityType: 'TOOL',
    entityId: toolId,
    metadata: {
      ...auditBase,
      effect: tool.effect,
      permission: tool.permission,
      platformScoped: tool.platformScoped,
      tables: tool.tables,
      latencyMs,
    },
  }).catch(() => undefined);

  return { toolId, effect: tool.effect, data, latencyMs, replayed: false };
}
