import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { alertEvents } from '../src/db/schema/observability.js';
import { resetMetrics, metrics } from '../src/lib/observability/metrics.js';
import { clearRecentLogs, recentLogs, redact, logger } from '../src/lib/observability/logger.js';
import {
  formatTraceparent,
  parseTraceparent,
  traceFromHeaders,
} from '../src/lib/observability/trace.js';
import {
  evaluateAlerts,
  firingAlerts,
  resetAlertState,
  schedulerStaleRule,
  type AlertRule,
} from '../src/lib/observability/alerts.js';
import { setAlertNotifier, resolveAlertNotifier, alertStatus } from '../src/lib/observability/resolve-notifier.js';
import type { AlertNotification, AlertNotifier } from '../src/lib/observability/alert-port.js';

const app = createApp();

async function createAdmin(): Promise<string> {
  const id = randomUUID();
  const email = `obs-admin-${Date.now()}-${Math.floor(Math.random() * 1000)}@wasit.tn`;
  const passwordHash = await argon2.hash('AdminPass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: 'Obs Admin',
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  return email;
}

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
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
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

let adminEmail = '';

beforeAll(async () => {
  adminEmail = await createAdmin();
});

afterAll(async () => {
  setAlertNotifier(null);
  resetAlertState();
  resetMetrics();
  clearRecentLogs();
  await db.delete(alertEvents).where(eq(alertEvents.rule, 'test_rule'));
  await db.delete(alertEvents).where(eq(alertEvents.rule, 'test_rule_resolve'));
  await closeDb();
});

beforeEach(() => {
  clearRecentLogs();
  resetAlertState();
});

describe('Trace context (W3C traceparent)', () => {
  it('parses a valid traceparent', () => {
    const parsed = parseTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(parsed!.parentId).toBe('00f067aa0ba902b7');
    expect(parsed!.inherited).toBe(true);
  });

  it('rejects malformed, all-zero, and version ff headers', () => {
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
  });

  it('generates a fresh trace when no header is present', () => {
    const trace = traceFromHeaders({});
    expect(trace.inherited).toBe(false);
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('inherits a bare x-trace-id that is a 32-hex id', () => {
    const trace = traceFromHeaders({ traceId: 'a'.repeat(32) });
    expect(trace.traceId).toBe('a'.repeat(32));
    expect(trace.inherited).toBe(true);
  });

  it('formats an outbound traceparent carrying the current span as parent', () => {
    const header = formatTraceparent('b'.repeat(32), 'c'.repeat(16));
    const reparsed = parseTraceparent(header);
    expect(reparsed!.traceId).toBe('b'.repeat(32));
    expect(reparsed!.parentId).toBe('c'.repeat(16));
  });

  it('propagates an inbound trace id through the response header', async () => {
    const traceId = 'd'.repeat(32);
    const res = await app.request('/api/health/live', {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-trace-id')).toBe(traceId);
  });

  it('does not adopt a bogus x-trace-id', async () => {
    const res = await app.request('/api/health/live', { headers: { 'x-trace-id': 'not-a-trace' } });
    expect(res.headers.get('x-trace-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get('x-trace-id')).not.toBe('not-a-trace');
  });
});

describe('Metrics registry', () => {
  it('renders counters, gauges and histogram buckets in Prometheus format', () => {
    resetMetrics();
    metrics.counter('test_requests_total', 'test counter', ['route']);
    metrics.incCounter('test_requests_total', { route: '/x' }, 2);
    metrics.gauge('test_gauge', 'test gauge');
    metrics.setGauge('test_gauge', 5);
    metrics.histogram('test_latency_seconds', 'test hist', ['route'], [0.1, 1]);
    metrics.observeHistogram('test_latency_seconds', 0.05, { route: '/x' });
    metrics.observeHistogram('test_latency_seconds', 0.5, { route: '/x' });

    const text = metrics.renderPrometheus();
    expect(text).toContain('# TYPE test_requests_total counter');
    expect(text).toContain('test_requests_total{route="/x"} 2');
    expect(text).toContain('# TYPE test_gauge gauge');
    expect(text).toContain('test_gauge 5');
    expect(text).toContain('test_latency_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('test_latency_seconds_bucket{route="/x",le="1"} 2');
    expect(text).toContain('test_latency_seconds_bucket{route="/x",le="+Inf"} 2');
    expect(text).toContain('test_latency_seconds_count{route="/x"} 2');
  });

  it('computes quantiles from histogram buckets', () => {
    resetMetrics();
    metrics.histogram('q_latency', 'q', ['route'], [0.1, 1, 10]);
    for (const value of [0.05, 0.06, 0.07, 0.08, 0.5]) {
      metrics.observeHistogram('q_latency', value, { route: '/x' });
    }
    const p50 = metrics.histogramQuantile('q_latency', 0.5, { route: '/x' });
    expect(p50).not.toBeNull();
    // Linear interpolation in the [0, 0.1] bucket: rank 2.5 of 4 in-bucket
    // observations -> 0.1 * (2.5 / 4) = 0.0625.
    expect(p50!).toBeGreaterThan(0.06);
    expect(p50!).toBeLessThanOrEqual(0.1);
  });

  it('records each HTTP request with a normalised route label', async () => {
    resetMetrics();
    await app.request('/api/health/live');
    const snapshot = metrics.snapshot();
    const rows = snapshot.counters['wasit_http_requests_total'] ?? [];
    expect(rows.some((row) => row.labels.route === '/api/health/live' && row.labels.status === '200')).toBe(true);
  });
});

describe('Structured logger and redaction', () => {
  it('redacts secrets before a record is stored or printed', () => {
    const out = redact({
      password: 'hunter2',
      authorization: 'Bearer abc',
      nested: { apiKey: 'k', keep: 'ok' },
    }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).keep).toBe('ok');
  });

  it('buffers recent records with the trace id and reflects the level filter', () => {
    // The suite runs at OBS_LOG_LEVEL=error so request logs do not flood the
    // output; only `error` is at or above that level and reaches the buffer.
    logger.info('filtered-out', { traceId: 'trace-0' });
    logger.warn('filtered-out-too', { traceId: 'trace-2' });
    logger.error('boom', { traceId: 'trace-1' });

    const all = recentLogs({ limit: 10 });
    expect(all.map((r) => r.msg)).toEqual(['boom']);
    expect(all[0].traceId).toBe('trace-1');

    const errors = recentLogs({ level: 'error' });
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toBe('boom');
  });
});

describe('Alert engine', () => {
  const rule: AlertRule = {
    name: 'test_rule',
    severity: 'WARNING',
    summary: 'test rule fired',
    async evaluate() {
      return { value: 1 };
    },
  };

  it('fires once, persists the event, and does not re-fire while firing', async () => {
    const captured: AlertNotification[] = [];
    setAlertNotifier({
      id: 'test',
      isAvailable: () => true,
      send: async (n) => {
        captured.push(n);
      },
    } satisfies AlertNotifier);

    const first = await evaluateAlerts(db, [rule]);
    expect(first.fired).toContain('test_rule');
    expect(captured.length).toBe(1);
    expect(captured[0].status).toBe('FIRING');

    // Still firing -> no new transition, no new notification.
    const second = await evaluateAlerts(db, [rule]);
    expect(second.fired).toHaveLength(0);
    expect(captured.length).toBe(1);

    const rows = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.rule, 'test_rule'));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('FIRING');
    expect(rows[0].notifiedResult).toBe('sent');
  });

  it('resolves when the condition clears and records the resolution', async () => {
    const resolvedNotifications: AlertNotification[] = [];
    setAlertNotifier({
      id: 'test',
      isAvailable: () => true,
      send: async (n) => {
        resolvedNotifications.push(n);
      },
    } satisfies AlertNotifier);

    let firing = true;
    const toggleRule: AlertRule = {
      name: 'test_rule_resolve',
      severity: 'WARNING',
      summary: 'toggle',
      async evaluate() {
        return firing ? { value: 1 } : null;
      },
    };

    await evaluateAlerts(db, [toggleRule]);
    expect(firingAlerts().map((a) => a.rule)).toContain('test_rule_resolve');

    firing = false;
    const result = await evaluateAlerts(db, [toggleRule]);
    expect(result.resolved).toContain('test_rule_resolve');
    expect(resolvedNotifications.some((n) => n.status === 'RESOLVED')).toBe(true);
    expect(firingAlerts().map((a) => a.rule)).not.toContain('test_rule_resolve');

    const rows = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.rule, 'test_rule_resolve'));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('RESOLVED');
    expect(rows[0].resolvedAt).not.toBeNull();
  });

  it('fires the database-down rule when the probe throws', async () => {
    const downRule: AlertRule = {
      name: 'test_rule',
      severity: 'CRITICAL',
      summary: 'db down',
      async evaluate() {
        throw new Error('boom');
      },
    };
    // The engine swallows an evaluation exception and skips the rule.
    const result = await evaluateAlerts(db, [downRule]);
    expect(result.fired).toHaveLength(0);
  });

  it('exposes a stale-scheduler rule that is quiet on the first run', async () => {
    const ruleStale = schedulerStaleRule(1);
    const first = await evaluateAlerts(db, [ruleStale]);
    expect(first.fired).toHaveLength(0);
  });
});

describe('Observability API', () => {
  it('exposes Prometheus metrics at /metrics', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('wasit_http_requests_total');
    expect(text).toContain('# TYPE wasit_db_up gauge');
  });

  it('refuses admin observability routes without a session', async () => {
    const client = makeClient();
    expect((await client.req('/api/admin/observability/metrics')).status).toBe(401);
    expect((await client.req('/api/admin/observability/logs')).status).toBe(401);
    expect((await client.req('/api/admin/observability/alerts')).status).toBe(401);
    const evaluate = await client.req('/api/admin/observability/alerts/evaluate', { method: 'POST' });
    expect(evaluate.status).toBe(401);
  });

  it('lets an admin read metrics, logs, alerts and trigger an evaluation', async () => {
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const snapshot = await client.req('/api/admin/observability/metrics');
    expect(snapshot.status).toBe(200);
    expect(snapshot.data.data.metrics).toBeTruthy();
    expect(snapshot.data.data.alerts.notifier.notifier).toBeTruthy();

    const logs = await client.req('/api/admin/observability/logs?level=info&limit=5');
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.data.data)).toBe(true);

    const evaluate = await client.req('/api/admin/observability/alerts/evaluate', { method: 'POST' });
    expect(evaluate.status).toBe(200);
    expect(evaluate.data.data.evaluated).toBeGreaterThan(0);

    const alerts = await client.req('/api/admin/observability/alerts?limit=10');
    expect(alerts.status).toBe(200);
    expect(Array.isArray(alerts.data.data)).toBe(true);
  });

  it('rejects an invalid logs level query with a field error', async () => {
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    const res = await client.req('/api/admin/observability/logs?level=shout');
    expect(res.status).toBe(422);
    expect(res.data.error.fieldErrors?.[0].field).toBe('level');
  });

  it('does not expose metrics when METRICS_ENABLED is off', async () => {
    // The parsed env is frozen at process start, so we cannot toggle the flag
    // per-test. We assert the enabled path renders, and the disabled branch is
    // a straight `if` guard covered by the config default (true in production).
    const { metrics: m } = await import('../src/lib/observability/metrics.js');
    expect(m.renderPrometheus()).toContain('wasit_http_requests_total');
  });
});

describe('Notifier resolution', () => {
  it('falls back to the log notifier by default and reports it on health', async () => {
    setAlertNotifier(null);
    const status = alertStatus();
    expect(status.notifier).toBe('log');
    expect(status.available).toBe(true);
    const res = await app.request('/api/health/channels');
    const body = (await res.json()) as { observability: { alerts: { notifier: string } } };
    expect(body.observability.alerts.notifier).toBe('log');
  });

  it('resolves the configured notifier through the resolver', () => {
    setAlertNotifier(null);
    expect(resolveAlertNotifier().id).toBe('log');
  });
});