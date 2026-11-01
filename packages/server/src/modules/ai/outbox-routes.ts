/**
 * The domain events the AI outbox is allowed to route (AI-08.0).
 *
 * This is deliberately a small, explicit allow-list — NOT the whole
 * `EVENT_ROUTING` table. Only events wired in this task appear here, so the
 * trusted outbox principal's authority is bounded to exactly these routes, even
 * though it still runs through the same RBAC, data-scope, kill-switch, budget
 * and Tool Gateway gates as any other run.
 *
 * Kept free of imports so both the runner (execution-time guard) and the outbox
 * worker (producer) can read it without an import cycle. A spec pins it to the
 * matching `EVENT_ROUTING` entry so the two tables cannot drift.
 */
export const OUTBOX_ROUTES: Record<string, { agentKey: string; taskType: string }> = {
  'order.placed': { agentKey: 'operations-agent', taskType: 'operations.health_check' },
};

/** The events this task wires, in declaration order. */
export const OUTBOX_EVENTS: string[] = Object.keys(OUTBOX_ROUTES);

/** The prefix that marks a task as enqueued by the trusted outbox worker. */
export const OUTBOX_TRIGGER_PREFIX = 'outbox:';

/** True when `event` maps to exactly this (agent, task type) in the allow-list. */
export function isAllowedOutboxRoute(event: string, agentKey: string, taskType: string | null): boolean {
  const route = OUTBOX_ROUTES[event];
  return !!route && route.agentKey === agentKey && route.taskType === taskType;
}

/** The distinct agent keys the outbox is permitted to reach. */
export function allowedOutboxAgentKeys(): string[] {
  return [...new Set(Object.values(OUTBOX_ROUTES).map((r) => r.agentKey))];
}
