import { ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { writeAudit } from '../audit';
import { getAgentRunContext, requireAction, ActionNotAuthorizedError } from './agent-run-context';
import {
  findTool,
  isRegisteredTool,
  rolesAllowPlatformScope,
  rolesHoldPermission,
  type ToolDefinition,
} from './tool-registry';
import { getToolHandler } from './tool-handlers';

/**
 * Central Tool Gateway (AI-02.1).
 *
 * The single, mandatory chokepoint every agent tool invocation must pass
 * through. It composes the AI-01.1 trusted run context (`requireAction`,
 * `getAgentRunContext`) with RBAC, data-scope, schema validation, an execution
 * deadline and audit logging — it does NOT create a parallel permission system.
 *
 * Fail-closed by construction: an unknown tool, an absent run context, an
 * ungranted action, a missing role/permission, a platform-scoped tool reached by
 * a non-admin, or an invalid argument all throw BEFORE the handler runs, and
 * every attempt (allowed or refused) is written to the audit log.
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
}

export interface ToolInvocationResult {
  readonly toolId: string;
  readonly effect: ToolDefinition['effect'];
  readonly data: Record<string, unknown>;
  readonly latencyMs: number;
}

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
 * The single entry point for invoking a registered tool.
 *
 * Order of checks (each fails closed, and each refusal is audited):
 *  1. the tool id must be registered (no dynamic/unregistered invocation);
 *  2. a trusted run context must be present (identity is never taken from args);
 *  3. the run's server-derived grant list must include the tool id
 *     (`requireAction` — reuses AI-01.1, no parallel system);
 *  4. the requester's roles must satisfy the tool's permission;
 *  5. a platform-scoped tool requires an admin requester;
 *  6. the args must satisfy the tool's Zod schema;
 *  7. the handler runs under a deadline; success is audited with timing.
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

  // (1) Registration is mandatory — an unknown tool can never run.
  const tool = findTool(toolId);
  if (!tool || !isRegisteredTool(toolId)) {
    return refuse('TOOL_NOT_REGISTERED', `Tool "${toolId}" is not registered with the gateway`);
  }

  // (2) A trusted run context is required; identity/scope never come from args.
  if (!ctx) {
    return refuse('NO_RUN_CONTEXT', 'Tool invocation requires a trusted agent run context');
  }

  // (3) The run must have been granted this tool id. The grant list is the
  // agent's registry-bound `allowedTools`, carried on the trusted run context —
  // reusing AI-01.1's `requireAction` (no parallel permission system). The
  // `'tools'` scope selects the trusted tool list; no caller-supplied array is
  // accepted, so a forged grant list cannot widen authority.
  try {
    requireAction(toolId, 'tools');
  } catch (err) {
    if (err instanceof ActionNotAuthorizedError) {
      return refuse('ACTION_NOT_AUTHORIZED', `Action "${toolId}" is not granted to this run`);
    }
    throw err;
  }

  const roles = (ctx.requesterRoles ?? []) as UserRole[];

  // (4) RBAC: the requester must hold the tool's permission.
  if (!rolesHoldPermission(roles, tool.permission, ROLE_PERMISSIONS as unknown as Record<string, ReadonlySet<string>>)) {
    return refuse('PERMISSION_DENIED', `Requester lacks permission "${tool.permission}" for tool "${toolId}"`);
  }

  // (5) Platform-scoped tools are admin-only. The scheduler principal is not an
  // admin and is refused for cross-tenant tools (it may only run a tool that
  // explicitly opts in via `schedulerAllowed`).
  if (tool.platformScoped && !rolesAllowPlatformScope(roles)) {
    return refuse('PLATFORM_SCOPE_DENIED', `Tool "${toolId}" requires an admin role for platform-wide data`);
  }

  // (6) Validate the caller's args against the tool's schema BEFORE execution.
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return refuse('INVALID_INPUT', `Invalid input for tool "${toolId}": ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`);
  }

  // (7) Execute under a deadline. A handler failure or timeout is audited as a
  // refusal/failure (never a silent success) and re-thrown.
  const handler = getToolHandler(toolId);
  if (!handler) {
    return refuse('TOOL_NOT_IMPLEMENTED', `Tool "${toolId}" has no bound implementation`);
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

  await writeAudit(db, auditCtx, {
    action: 'AI.TOOL_EXECUTED',
    entityType: 'TOOL',
    entityId: toolId,
    metadata: { ...auditBase, effect: tool.effect, permission: tool.permission, platformScoped: tool.platformScoped, latencyMs },
  }).catch(() => undefined);

  return { toolId, effect: tool.effect, data, latencyMs };
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
