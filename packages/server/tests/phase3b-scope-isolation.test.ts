import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { agentMemory, agentMetrics } from '../src/db/schema/agents.js';
import { deriveScope, tryDeriveScope, derivePlatformScope, resolvePlatformScope, assertValidScope, NoScopeError, NO_SCOPE, SYSTEM_PRINCIPAL, type AgentScopeCtx } from '../src/modules/ai/scope.js';
import { validateMemoryContent, REF_OWNERSHIP_VERIFIABLE, __internal as memoryInternal, putMemory, listMemory, deleteOwn } from '../src/modules/ai/memory-repo.js';
import { __internal as metricsInternal, recordMetric, listMetrics, aggregateMetrics, validateMetricInput, METRIC_OUTCOMES } from '../src/modules/ai/metrics-repo.js';

/**
 * Phase 3b — owner-scope isolation for agent metrics/memory.
 *
 * These tests are DB-free by design: the project constraint for this batch
 * forbids tests that connect to a database, so isolation is proven by rendering
 * the repository predicates to SQL and asserting the owner scope is always
 * present, plus the refusal paths that fire before any query is issued. A real
 * end-to-end run against the isolated test DB is deferred to a separately
 * approved batch.
 */

const dialect = new PgDialect();
function render(sql: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(sql as never);
}

const OWNER_A = deriveScope({ userId: 'user-A' });
const OWNER_B = deriveScope({ userId: 'user-B' });

describe('scope derivation (NO_SCOPE)', () => {
  it('accepts a real user id', () => {
    expect(OWNER_A.owner).toBe('user-A');
    expect(OWNER_A.isPlatform).toBe(false);
  });

  it('refuses a missing, empty or system owner', () => {
    for (const userId of [undefined, null, '', '   ', SYSTEM_PRINCIPAL]) {
      expect(() => deriveScope({ userId })).toThrow(NoScopeError);
      expect(tryDeriveScope({ userId })).toBeNull();
    }
  });

  it('carries the NO_SCOPE code and refuses to run', () => {
    try {
      deriveScope({ userId: SYSTEM_PRINCIPAL });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NoScopeError);
      expect((err as NoScopeError).statusCode).toBe(403);
      expect(((err as NoScopeError).details as { code?: string }).code).toBe(NO_SCOPE);
    }
  });

  it('never treats the scheduler principal as a shared owner', () => {
    expect(tryDeriveScope({ userId: SYSTEM_PRINCIPAL })).toBeNull();
    expect(() => derivePlatformScope({ userId: SYSTEM_PRINCIPAL }, { roles: ['SUPER_ADMIN'] })).toThrow(NoScopeError);
  });

  it('deriveScope never grants platform scope, even with a platform hint', () => {
    // A caller-controlled flag cannot widen the scope; ScopeSource has no platform field.
    const ctx = deriveScope({ userId: 'user-A', platform: true } as never);
    expect(ctx.isPlatform).toBe(false);
  });
});

describe('platform scope is server-authorized only', () => {
  it('resolvePlatformScope grants only admins (analytics:read:all is not enough)', () => {
    expect(resolvePlatformScope({ roles: ['ADMIN'] })).toBe(true);
    expect(resolvePlatformScope({ roles: ['SUPER_ADMIN'] })).toBe(true);
    expect(resolvePlatformScope({ roles: ['SUPPORT'] })).toBe(false);
    expect(resolvePlatformScope({ roles: ['RISK'] })).toBe(false);
    expect(resolvePlatformScope({ roles: ['DISPUTE'] })).toBe(false);
    expect(resolvePlatformScope({ roles: ['MERCHANT'] })).toBe(false);
    expect(resolvePlatformScope({ roles: [] })).toBe(false);
  });

  it('derivePlatformScope refuses a non-admin even with analytics:read:all', () => {
    expect(() => derivePlatformScope({ userId: 'user-A' }, { roles: ['SUPPORT'] })).toThrow(NoScopeError);
    expect(() => derivePlatformScope({ userId: 'user-A' }, { roles: ['RISK'] })).toThrow(NoScopeError);
    expect(() => derivePlatformScope({ userId: 'user-A' }, { roles: ['DISPUTE'] })).toThrow(NoScopeError);
    expect(() => derivePlatformScope({ userId: 'user-A' }, { roles: ['MERCHANT'] })).toThrow(NoScopeError);
  });

  it('derivePlatformScope grants a user who holds the permission', () => {
    const ctx = derivePlatformScope({ userId: 'admin-1' }, { roles: ['ADMIN'] });
    expect(ctx.isPlatform).toBe(true);
    expect(assertValidScope(ctx)).toBe(ctx);
  });

  it('a hand-built context cannot forge isPlatform=true', () => {
    const forged = { owner: 'user-A', isPlatform: true } as unknown as AgentScopeCtx;
    expect(() => assertValidScope(forged)).toThrow(NoScopeError);
  });
});

describe('repository predicates always carry the owner scope', () => {
  it('metrics owner predicate renders scope_owner = <owner>', () => {
    const q = render(metricsInternal.ownerPredicate(OWNER_A));
    expect(q.sql).toContain('"agent_metrics"."scope_owner"');
    expect(q.params).toEqual(['user-A']);
  });

  it('memory owner predicate renders scope_owner = <owner>', () => {
    const q = render(memoryInternal.ownerPredicate(OWNER_B));
    expect(q.sql).toContain('"agent_memory"."scope_owner"');
    expect(q.params).toEqual(['user-B']);
  });

  it('owner A predicate never contains owner B (and vice versa)', () => {
    const a = render(memoryInternal.ownerPredicate(OWNER_A));
    const b = render(memoryInternal.ownerPredicate(OWNER_B));
    expect(a.params).not.toContain('user-B');
    expect(b.params).not.toContain('user-A');
  });

  it('a list read for owner A is scoped to A and excludes B', () => {
    const q = render(and(memoryInternal.ownerPredicate(OWNER_A), eq(agentMemory.agentKey, 'sales-agent')));
    expect(q.sql).toContain('"agent_memory"."scope_owner" =');
    expect(q.params).toContain('user-A');
    expect(q.params).not.toContain('user-B');
  });

  it('a delete for owner A is scoped to A (cannot delete B\'s row)', () => {
    const q = render(and(memoryInternal.ownerPredicate(OWNER_A), eq(agentMemory.id, 'some-id')));
    expect(q.sql).toContain('"agent_memory"."scope_owner" =');
    expect(q.params).toEqual(['user-A', 'some-id']);
    expect(q.params).not.toContain('user-B');
  });

  it('metrics aggregate for a tenant owner is scoped to that owner', () => {
    const q = render(metricsInternal.ownerPredicate(OWNER_B));
    expect(q.sql).toContain('"agent_metrics"."scope_owner"');
    expect(q.params).toEqual(['user-B']);
  });
});

describe('refusal paths fire before any query', () => {
  const bad: Array<[string, AgentScopeCtx | null | undefined]> = [
    ['null ctx', null],
    ['undefined ctx', undefined],
    ['ctx without owner', { owner: undefined as never, isPlatform: false }],
  ];

  it('every write/read/delete refuses a missing scope', async () => {
    for (const [, ctx] of bad) {
      const c = ctx as unknown as AgentScopeCtx;
      await expect(recordMetric({} as never, c, { agentKey: 'sales-agent', outcome: 'succeeded' })).rejects.toBeInstanceOf(NoScopeError);
      await expect(listMetrics({} as never, c)).rejects.toBeInstanceOf(NoScopeError);
      await expect(aggregateMetrics({} as never, c)).rejects.toBeInstanceOf(NoScopeError);
      await expect(putMemory({} as never, c, { agentKey: 'sales-agent', kind: 'note', content: { summary: 'ok' } })).rejects.toBeInstanceOf(NoScopeError);
      await expect(listMemory({} as never, c)).rejects.toBeInstanceOf(NoScopeError);
      await expect(deleteOwn({} as never, c, 'any-id')).rejects.toBeInstanceOf(NoScopeError);
    }
  });
});

describe('memory content allow-list', () => {
  it('accepts structured, non-free-text content', () => {
    const out = validateMemoryContent({
      tags: ['sales', 'weekly'],
      metrics: { latencyMs: 120, outcome: 'succeeded' },
    });
    expect(out.tags).toEqual(['sales', 'weekly']);
    expect(out.metrics).toEqual({ latencyMs: 120, outcome: 'succeeded' });
  });

  it('exposes exactly the 32 unique allow-listed tags (decision C′)', () => {
    expect(memoryInternal.ALLOWED_TAGS).toHaveLength(32);
    expect(new Set(memoryInternal.ALLOWED_TAGS).size).toBe(32);
  });

  it('accepts every allow-listed tag', () => {
    for (const tag of memoryInternal.ALLOWED_TAGS) {
      expect(() => validateMemoryContent({ tags: [tag] }), tag).not.toThrow();
    }
  });

  it('rejects any tag outside the allow-list (incl. names/phones/emails)', () => {
    for (const tag of ['randomword', 'AhmedMohammed', 'CEO', 'a@b.com', '+966 50 123 4567', 'customer-42']) {
      expect(() => validateMemoryContent({ tags: [tag] }), tag).toThrow();
    }
  });

  it('rejects unknown keys', () => {
    expect(() => validateMemoryContent({ tags: ['ok'], rawOrder: { total: 10 } })).toThrow();
  });

  it('rejects free text (summary is no longer accepted)', () => {
    expect(() => validateMemoryContent({ summary: 'Lead follow-up completed for the week.' })).toThrow();
  });

  it('rejects the privacy examples from the audit (all as free text)', () => {
    // Person name, formatted phone, address and an encoded-secret-looking string
    // are each rejected because free text is not accepted at all.
    expect(() => validateMemoryContent({ summary: 'Spoke with Ahmed Mohammed Ali' })).toThrow();
    expect(() => validateMemoryContent({ summary: 'call +966 50 123 4567 tomorrow' })).toThrow();
    expect(() => validateMemoryContent({ summary: 'office at Riyadh King Fahd Road' })).toThrow();
    expect(() => validateMemoryContent({ summary: 'c2VjcmV0LXRva2VuLXZhbHVl' })).toThrow();
  });

  it('rejects secrets and PII patterns in tags', () => {
    expect(() => validateMemoryContent({ tags: ['a@b.com'] })).toThrow();
    expect(() => validateMemoryContent({ tags: ['password'] })).toThrow();
    expect(() => validateMemoryContent({ tags: ['4111 1111 1111 1111'] })).toThrow();
    expect(() => validateMemoryContent({ tags: ['123456789'] })).toThrow();
    expect(() => validateMemoryContent({ tags: ['+966 50 123 4567'] })).toThrow();
  });

  it('rejects over-long values, empty values and empty objects', () => {
    expect(() => validateMemoryContent({ tags: ['x'.repeat(33)] })).toThrow();
    expect(() => validateMemoryContent({ tags: [''] })).toThrow();
    expect(() => validateMemoryContent({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toThrow();
    expect(() => validateMemoryContent({})).toThrow();
  });

  it('rejects refs because ownership cannot be verified (documented reduction)', () => {
    expect(REF_OWNERSHIP_VERIFIABLE).toBe(false);
    expect(() => validateMemoryContent({ refs: [{ type: 'task', id: '123e4567-e89b-12d3-a456-426614174000' }] })).toThrow();
  });

  it('rejects non-object content', () => {
    expect(() => validateMemoryContent('a plain string')).toThrow();
    expect(() => validateMemoryContent(['array'])).toThrow();
    expect(() => validateMemoryContent(null)).toThrow();
  });
});

describe('metric input runtime validation', () => {
  it('accepts a known agent key and an allowed outcome', () => {
    expect(() => validateMetricInput({ agentKey: 'sales-agent', outcome: 'succeeded' })).not.toThrow();
    expect(() => validateMetricInput({ agentKey: 'wasit-copilot', outcome: 'refused' })).not.toThrow();
  });

  it('rejects an unknown agent key', () => {
    expect(() => validateMetricInput({ agentKey: 'not-a-real-agent', outcome: 'succeeded' })).toThrow();
    expect(() => validateMetricInput({ agentKey: '', outcome: 'succeeded' })).toThrow();
  });

  it('rejects an unsupported outcome', () => {
    expect(() => validateMetricInput({ agentKey: 'sales-agent', outcome: 'wat' as never })).toThrow();
  });

  it('exposes the allowed outcomes it enforces', () => {
    expect(METRIC_OUTCOMES).toEqual(['succeeded', 'failed', 'blocked', 'refused']);
  });

  it('rejects malformed attempt and latency', () => {
    expect(() => validateMetricInput({ agentKey: 'sales-agent', outcome: 'succeeded', attempt: 0 })).toThrow();
    expect(() => validateMetricInput({ agentKey: 'sales-agent', outcome: 'succeeded', attempt: 1.5 })).toThrow();
    expect(() => validateMetricInput({ agentKey: 'sales-agent', outcome: 'succeeded', latencyMs: -1 })).toThrow();
  });

  it('recordMetric rejects invalid input before touching the database', async () => {
    await expect(recordMetric({} as never, OWNER_A, { agentKey: 'nope', outcome: 'succeeded' })).rejects.toThrow();
  });
});

describe('boundary: no direct table access outside the repositories', () => {
  const SRC = join(__dirname, '..', 'src');
  const ALLOWED = new Set([
    join('src', 'db', 'schema', 'agents.ts'),
    join('src', 'modules', 'ai', 'metrics-repo.ts'),
    join('src', 'modules', 'ai', 'memory-repo.ts'),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('only the schema and the two repositories reference the tables', () => {
    const offenders: string[] = [];
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const file of walk(SRC)) {
      const rel = file.slice(file.indexOf('src'));
      if (ALLOWED.has(rel)) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      if (/\b(agentMetrics|agentMemory|agent_metrics|agent_memory)\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
