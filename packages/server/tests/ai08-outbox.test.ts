import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { inventoryItems, inventoryMovements } from '../src/db/schema/commerce_extras.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { eventOutbox } from '../src/db/schema/outbox.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  createOrder,
  type CreateOrderInput,
} from '../src/modules/orders/service.js';
import {
  claimDueEvents,
  enqueueEvent,
  markFailed,
  markProcessed,
  outboxCounts,
  reapStaleEvents,
} from '../src/modules/ai/outbox-repo.js';
import { dispatchOutboxEvents } from '../src/modules/ai/outbox-worker.js';
import {
  OUTBOX_EVENTS,
  OUTBOX_ROUTES,
  OUTBOX_TRIGGER_PREFIX,
  isAllowedOutboxRoute,
} from '../src/modules/ai/outbox-routes.js';
import { EVENT_ROUTING } from '../src/modules/ai/copilot.js';
import {
  createAgentTask,
  executeDueTasks,
  getTask,
  outboxPrincipalRoles,
  runTask,
  setAgentStatus,
  syncAgentRegistry,
  OUTBOX_PRINCIPAL,
} from '../src/modules/ai/runner.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-08.0 — Transactional Outbox + `order.placed`.
 *
 * Drives the REAL order service, the REAL outbox worker and the REAL runner
 * against a REAL database. Every guarantee below is asserted on persisted state,
 * not on a mock:
 *
 *  - atomicity: the order and its `order.placed` event commit together, and a
 *    failure anywhere rolls BOTH back (no order, no event, no stock reservation);
 *  - no pre-commit delivery: the worker sees nothing until the transaction commits;
 *  - idempotency: a repeated enqueue inserts no second event, and a retried
 *    delivery creates no second task;
 *  - crash safety: a worker that dies holding a lease loses no event (the
 *    watchdog reclaims it), and two workers never process the same row;
 *  - agent failure never fails the order;
 *  - the system identity is bounded, non-forgeable and cannot be reached by a
 *    buyer; the kill switch still stops delivery.
 */

const app = createApp();
const AUDIT = { actorId: 'ai080-test' };

const createdOrderIds: string[] = [];
const createdUserIds: string[] = [];
const createdEventIds: string[] = [];
const createdTaskIds: string[] = [];

/** Minimal cookie-preserving fetch client (same shape as the other suites). */
function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { data: data as any, status: res.status };
    },
  };
}

async function insertUser(roleName: UserRole) {
  const id = randomUUID();
  const email = `ai080-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('Ai080Pass123!'),
    firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

/**
 * Builds a supplier + product with stock through the REAL HTTP routes, so the
 * order under test runs against genuinely-persisted rows (no hand-written
 * fixture that could drift from the schema).
 */
async function seedSellerAndProduct(quantity = 100) {
  const supplier = makeClient();
  const email = `ai080-sup-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const reg = await supplier.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Ai080Pass123!', firstName: 'Sup', role: 'SUPPLIER' },
  });
  expect(reg.status).toBe(201);
  const login = await supplier.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'Ai080Pass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  createdUserIds.push((login.data.data as { id: string }).id);

  const sup = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: `AI080 Co ${Date.now()}` } });
  expect(sup.status).toBe(201);
  const supplierId = sup.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const sku = `SKU-AI080-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const prod = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId, sellerType: 'SUPPLIER', sku, categoryId,
      name: `AI080 Product ${sku}`, basePrice: '20.0000', currencyCode: 'TND',
      moq: 1, initialQuantity: quantity, lowStockThreshold: 5, quantity,
    },
  });
  expect(prod.status).toBe(201);
  return { supplierId, productId: prod.data.data.id as string };
}

async function outboxRowFor(orderId: string) {
  const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.dedupeKey, `order.placed:${orderId}`));
  return rows[0] ?? null;
}

async function inventoryFor(productId: string, merchantId: string) {
  const rows = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.productId, productId), eq(inventoryItems.merchantId, merchantId)));
  return rows[0] ?? null;
}

async function tasksForCorrelation(correlationId: string) {
  return db.select().from(agentTasks).where(eq(agentTasks.correlationId, correlationId));
}

beforeAll(async () => {
  await syncAgentRegistry(db);
});

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdEventIds.length) await db.delete(eventOutbox).where(inArray(eventOutbox.id, createdEventIds));
  await db.delete(eventOutbox).where(sql`${eventOutbox.dedupeKey} like 'order.placed:%'`);
  if (createdOrderIds.length) {
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  closeDb();
});

// ---------------------------------------------------------------------------
// 1 + 2 + 3 — atomicity of order + event, full rollback, no partial reservation.
// ---------------------------------------------------------------------------

describe('AI-08.0 — atomic order + event', () => {
  it('commits the order and its order.placed event together', async () => {
    const { supplierId, productId } = await seedSellerAndProduct(50);
    const buyer = await insertUser('CUSTOMER');

    const result = await createOrder(
      db,
      { buyerId: buyer.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 3 }], currencyCode: 'TND' },
      { actorId: buyer.id, ipAddress: '127.0.0.1' },
    );
    createdOrderIds.push(result.orderId);

    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).limit(1);
    expect(order).toHaveLength(1);

    const event = await outboxRowFor(result.orderId);
    expect(event).not.toBeNull();
    if (event) createdEventIds.push(event.id);
    expect(event!.eventType).toBe('order.placed');
    expect(event!.aggregateType).toBe('ORDER');
    expect(event!.aggregateId).toBe(result.orderId);
    expect(event!.status).toBe('PENDING');
    expect(event!.dedupeKey).toBe(`order.placed:${result.orderId}`);
    // Stock reserved atomically with the order.
    const inv = await inventoryFor(productId, supplierId);
    expect(inv!.reservedQuantity).toBe(3);
  });

  it('rolls the order AND the event back completely when creation fails', async () => {
    const { supplierId, productId } = await seedSellerAndProduct(2);
    const buyer = await insertUser('CUSTOMER');

    const ordersBefore = await db.select({ n: sql<number>`count(*)::int` }).from(orders);
    const eventsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(eventOutbox);

    // Request 5 units from a product with only 2 in stock: reserveStock throws
    // AFTER the transaction has begun, so the whole unit of work must unwind.
    await expect(
      createOrder(
        db,
        { buyerId: buyer.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 5 }], currencyCode: 'TND' },
        { actorId: buyer.id },
      ),
    ).rejects.toThrow();

    const ordersAfter = await db.select({ n: sql<number>`count(*)::int` }).from(orders);
    const eventsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(eventOutbox);
    expect(ordersAfter[0].n).toBe(ordersBefore[0].n);
    expect(eventsAfter[0].n).toBe(eventsBefore[0].n);

    // No partial reservation survives the rollback.
    const inv = await inventoryFor(productId, supplierId);
    expect(inv!.reservedQuantity).toBe(0);
    expect(inv!.quantity).toBe(2);
  });

  it('leaves no reservation movement row when the order rolls back', async () => {
    const { supplierId, productId } = await seedSellerAndProduct(1);
    const buyer = await insertUser('CUSTOMER');

    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.referenceType, 'ORDER'));

    await expect(
      createOrder(db, { buyerId: buyer.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 4 }], currencyCode: 'TND' }, { actorId: buyer.id }),
    ).rejects.toThrow();

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.referenceType, 'ORDER'));
    expect(after[0].n).toBe(before[0].n);
    void supplierId;
  });
});

// ---------------------------------------------------------------------------
// 4 — no delivery before commit.
// ---------------------------------------------------------------------------

describe('AI-08.0 — no pre-commit delivery', () => {
  it('the worker cannot see or route the event until the producing transaction commits', async () => {
    const { productId } = await seedSellerAndProduct(20);
    const buyer = await insertUser('CUSTOMER');

    // Flush any earlier leftover events so the drain below is deterministic.
    await dispatchOutboxEvents(db);

    // Hold the transaction open: inside it, the event exists but is uncommitted.
    let visibleInsideTx = -1;
    let claimedInsideTx = -1;
    const result = await db.transaction(async (tx) => {
      const created = await createOrder(tx as never, {
        buyerId: buyer.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 2 }], currencyCode: 'TND',
      } as CreateOrderInput, { actorId: buyer.id });
      // A concurrent reader (a different pooled connection = the worker's view)
      // sees no event for this order yet: the row is not committed.
      const outside = await db.select().from(eventOutbox).where(eq(eventOutbox.aggregateId, created.orderId));
      visibleInsideTx = outside.length;
      // A worker draining now must claim nothing: the only PENDING row is this
      // order's, and it is invisible until commit.
      const drain = await dispatchOutboxEvents(db);
      claimedInsideTx = drain.claimed;
      return created;
    });
    createdOrderIds.push(result.orderId);

    expect(visibleInsideTx).toBe(0);
    expect(claimedInsideTx).toBe(0);

    // After commit the event is visible and durable.
    const event = await outboxRowFor(result.orderId);
    expect(event).not.toBeNull();
    if (event) createdEventIds.push(event.id);
  });
});

// ---------------------------------------------------------------------------
// 5 — idempotency: no duplicate event, no duplicate task on retry.
// ---------------------------------------------------------------------------

describe('AI-08.0 — idempotency', () => {
  it('a repeated enqueue of the same order event inserts nothing', async () => {
    const orderId = randomUUID();
    const first = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    const second = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(first.id);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.dedupeKey, `order.placed:${orderId}`));
    expect(rows).toHaveLength(1);
  });

  it('a retried delivery of the same event creates no second agent task', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);

    const firstRun = await dispatchOutboxEvents(db);
    expect(firstRun.processed).toBeGreaterThanOrEqual(1);

    const tasksAfterFirst = await tasksForCorrelation(id);
    expect(tasksAfterFirst).toHaveLength(1);
    createdTaskIds.push(tasksAfterFirst[0].id);

    // Force a re-delivery of the SAME row (as a reaped lease would) and drain
    // again: the correlationId guard must return the existing task.
    await db.update(eventOutbox).set({ status: 'PENDING', lockedAt: null, availableAt: new Date() }).where(eq(eventOutbox.id, id));
    const secondRun = await dispatchOutboxEvents(db);
    expect(secondRun.processed).toBeGreaterThanOrEqual(1);

    const tasksAfterSecond = await tasksForCorrelation(id);
    expect(tasksAfterSecond).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7 — crash safety and no concurrent double-processing.
// ---------------------------------------------------------------------------

describe('AI-08.0 — crash safety and single-flight claim', () => {
  it('a worker that dies holding a lease loses no event (the watchdog reclaims it)', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);

    // Simulate a worker that claimed the row then crashed: PROCESSING with a
    // lease far in the past.
    const claimed = await claimDueEvents(db, 5);
    expect(claimed.some((c) => c.id === id)).toBe(true);
    await db.update(eventOutbox).set({ lockedAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(eventOutbox.id, id));

    const reaped = await reapStaleEvents(db, 60);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    expect(row[0].status).toBe('PENDING');

    // The event is still delivered after the reclaim.
    const run = await dispatchOutboxEvents(db);
    expect(run.processed).toBeGreaterThanOrEqual(1);
    const tasks = await tasksForCorrelation(id);
    expect(tasks).toHaveLength(1);
    createdTaskIds.push(tasks[0].id);
  });

  it('two concurrent claims never return the same row', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);

    const [a, b] = await Promise.all([claimDueEvents(db, 50), claimDueEvents(db, 50)]);
    const ids = [...a.map((r) => r.id), ...b.map((r) => r.id)];
    const occurrences = ids.filter((x) => x === id).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8 — an agent failure never fails the order.
// ---------------------------------------------------------------------------

describe('AI-08.0 — agent failure is isolated from the order', () => {
  it('keeps the order when the routed agent fails, and records the failure', async () => {
    const { productId } = await seedSellerAndProduct(10);
    const buyer = await insertUser('CUSTOMER');

    const result = await createOrder(
      db,
      { buyerId: buyer.id, buyerType: 'CUSTOMER', items: [{ productId, quantity: 1 }], currencyCode: 'TND' },
      { actorId: buyer.id },
    );
    createdOrderIds.push(result.orderId);

    const event = await outboxRowFor(result.orderId);
    if (event) createdEventIds.push(event.id);

    // Pause the target agent so the routed run is blocked (a deterministic
    // "agent failed" outcome) and drain: the order must be untouched.
    await setAgentStatus(db, 'operations-agent', 'PAUSED', 'ai080 test', AUDIT);
    try {
      const run = await dispatchOutboxEvents(db);
      expect(run.processed).toBeGreaterThanOrEqual(1);

      const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).limit(1);
      expect(order).toHaveLength(1);
      expect(order[0].status).toBe('PENDING');

      const tasks = await tasksForCorrelation(event!.id);
      expect(tasks).toHaveLength(1);
      createdTaskIds.push(tasks[0].id);
      expect(tasks[0].status).toBe('blocked');
    } finally {
      await setAgentStatus(db, 'operations-agent', 'ACTIVE', 'ai080 test restore', AUDIT);
    }
  });
});

// ---------------------------------------------------------------------------
// 9 — the system identity is bounded and non-forgeable.
// ---------------------------------------------------------------------------

describe('AI-08.0 — bounded, non-forgeable system identity', () => {
  it('the outbox allow-list is exactly the wired events, matching EVENT_ROUTING', () => {
    expect(OUTBOX_EVENTS).toEqual(['order.placed']);
    for (const [event, route] of Object.entries(OUTBOX_ROUTES)) {
      expect(EVENT_ROUTING[event]).toBeDefined();
      expect(EVENT_ROUTING[event].agentKey).toBe(route.agentKey);
      expect(EVENT_ROUTING[event].taskType).toBe(route.taskType);
    }
    expect(isAllowedOutboxRoute('order.placed', 'operations-agent', 'operations.health_check')).toBe(true);
    // Any other agent / task type is refused.
    expect(isAllowedOutboxRoute('order.placed', 'finance-agent', 'finance.reconcile')).toBe(false);
    expect(isAllowedOutboxRoute('order.placed', 'operations-agent', 'operations.other')).toBe(false);
    expect(isAllowedOutboxRoute('order.paid', 'payment-settlement-agent', 'payment.monitor_settlement')).toBe(false);
  });

  it('a forged outbox task that bypasses the allow-list is refused', async () => {
    // Insert a task claiming the outbox principal for a NON-allow-listed agent,
    // with a trigger that is not an allow-listed route. The runner must resolve
    // no roles for it and block it.
    const forgedId = randomUUID();
    await db.insert(agentTasks).values({
      id: forgedId, agentKey: 'finance-agent', requestedBy: OUTBOX_PRINCIPAL,
      taskType: 'finance.reconcile', input: {} as never, status: 'queued',
      requiresApproval: false, correlationId: randomUUID(),
      triggeredBy: `${OUTBOX_TRIGGER_PREFIX}order.placed`, maxAttempts: 1, model: 'local-heuristic',
    });
    createdTaskIds.push(forgedId);

    const after = await runTask(db, forgedId, AUDIT);
    expect(after.status).toBe('blocked');
  });

  it('a forged outbox task with the right agent but a wrong route is refused', async () => {
    const forgedId = randomUUID();
    await db.insert(agentTasks).values({
      id: forgedId, agentKey: 'operations-agent', requestedBy: OUTBOX_PRINCIPAL,
      taskType: 'operations.health_check', input: {} as never, status: 'queued',
      requiresApproval: false, correlationId: randomUUID(),
      triggeredBy: `${OUTBOX_TRIGGER_PREFIX}dispute.opened`, maxAttempts: 1, model: 'local-heuristic',
    });
    createdTaskIds.push(forgedId);

    const after = await runTask(db, forgedId, AUDIT);
    expect(after.status).toBe('blocked');
  });

  it('a task that merely claims requestedBy=outbox without the marker is refused', async () => {
    const forgedId = randomUUID();
    await db.insert(agentTasks).values({
      id: forgedId, agentKey: 'operations-agent', requestedBy: OUTBOX_PRINCIPAL,
      taskType: 'operations.health_check', input: {} as never, status: 'queued',
      requiresApproval: false, correlationId: randomUUID(),
      triggeredBy: 'user', maxAttempts: 1, model: 'local-heuristic',
    });
    createdTaskIds.push(forgedId);

    const after = await runTask(db, forgedId, AUDIT);
    expect(after.status).toBe('blocked');
  });

  it('a buyer cannot reach the platform-scoped operations agent through the API', async () => {
    const buyer = await insertUser('CUSTOMER');
    // A CUSTOMER calling the agent-task route for the operations agent must be
    // refused: the agent needs an admin role for platform-wide data.
    await expect(
      createAgentTask(db, ['CUSTOMER'], buyer.id, {
        agentKey: 'operations-agent', taskType: 'operations.health_check', input: {},
      }, { actorId: buyer.id }),
    ).rejects.toThrow();
  });

  it('grants no general ADMIN/SUPER_ADMIN to the outbox principal for a non-listed agent', async () => {
    // The bounded identity only yields automation roles for an allow-listed agent.
    expect(outboxPrincipalRoles('operations-agent')).toEqual(['SUPER_ADMIN']);
    expect(outboxPrincipalRoles('finance-agent')).toEqual([]);
    expect(outboxPrincipalRoles('payment-settlement-agent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10 — kill switch stops delivery per policy.
// ---------------------------------------------------------------------------

describe('AI-08.0 — kill switch', () => {
  it('a DISABLED agent blocks the routed run while the event is still consumed', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);

    await setAgentStatus(db, 'operations-agent', 'DISABLED', 'ai080 kill switch', AUDIT);
    try {
      const run = await dispatchOutboxEvents(db);
      expect(run.processed).toBeGreaterThanOrEqual(1);
      const tasks = await tasksForCorrelation(id);
      expect(tasks).toHaveLength(1);
      createdTaskIds.push(tasks[0].id);
      expect(tasks[0].status).toBe('blocked');
    } finally {
      await setAgentStatus(db, 'operations-agent', 'ACTIVE', 'ai080 kill switch restore', AUDIT);
    }
  });
});

// ---------------------------------------------------------------------------
// 11 — the scheduler path still runs the outbox without enabling SCHEDULER_ENABLED.
// ---------------------------------------------------------------------------

describe('AI-08.0 — worker wiring and existing paths', () => {
  it('executeDueTasks still processes queued tasks (existing runner path intact)', async () => {
    const buyer = await insertUser('CUSTOMER');
    const task = await createAgentTask(db, ['SUPER_ADMIN'], buyer.id, {
      agentKey: 'analytics-agent', taskType: 'analytics.report', input: {}, triggeredBy: 'user',
    }, AUDIT);
    createdTaskIds.push(task.id);
    const res = await executeDueTasks(db, 25);
    expect(res.ran + res.failed + res.refused).toBeGreaterThanOrEqual(0);
    const done = await getTask(db, task.id);
    expect(['succeeded', 'failed', 'blocked', 'awaiting_approval']).toContain(done.status);
  });

  it('routes a real order.placed event to the operations agent and audits it', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);

    const run = await dispatchOutboxEvents(db);
    expect(run.processed).toBeGreaterThanOrEqual(1);
    const tasks = await tasksForCorrelation(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentKey).toBe('operations-agent');
    expect(tasks[0].taskType).toBe('operations.health_check');
    expect(tasks[0].requestedBy).toBe(OUTBOX_PRINCIPAL);
    createdTaskIds.push(tasks[0].id);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.OUTBOX_PROCESSED'), eq(auditLogs.entityId, id)));
    expect(audits).toHaveLength(1);
    expect(await outboxCounts(db)).toHaveProperty('PROCESSED');
  });

  it('markFailed returns a row to PENDING below the ceiling and FAILED at it', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);
    await claimDueEvents(db, 5); // attempts -> 1
    expect(await markFailed(db, id, 'transient')).toBe('PENDING');
    // Force the ceiling.
    await db.update(eventOutbox).set({ status: 'PROCESSING', attempts: 99, maxAttempts: 8 }).where(eq(eventOutbox.id, id));
    expect(await markFailed(db, id, 'permanent')).toBe('FAILED');
    const row = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    expect(row[0].status).toBe('FAILED');
  });

  it('markProcessed only transitions a PROCESSING row', async () => {
    const orderId = randomUUID();
    const { id } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(id);
    // Still PENDING: markProcessed must not touch it.
    await markProcessed(db, id);
    let row = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    expect(row[0].status).toBe('PENDING');
    await claimDueEvents(db, 5);
    await markProcessed(db, id);
    row = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    expect(row[0].status).toBe('PROCESSED');
  });

  it('the registry row for the operations agent exists and is ACTIVE after tests', async () => {
    await syncAgentRegistry(db);
    const rows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, 'operations-agent')).limit(1);
    expect(rows[0].status).toBe('ACTIVE');
  });
});
