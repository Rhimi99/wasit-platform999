import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PRINCIPAL,
  NO_SCOPE,
  NoScopeError,
  deriveScope,
  tryDeriveScope,
  deriveSystemScope,
  isSystemScope,
  resolvePlatformScope,
  derivePlatformScope,
  assertValidScope,
  type AgentScopeCtx,
  type OwnerId,
} from '../../src/modules/ai/scope.js';

/**
 * Agent owner-scope (tenant isolation) — database-free half.
 *
 * `scope.ts` is the barrier that binds every `agent_metrics` / `agent_memory`
 * operation to a single owner. This file pins the pure decisions: which sources
 * yield a trustworthy owner, which are refused, and which hand-built contexts
 * are rejected at runtime. The DB-backed platform lookup
 * (`userHasPlatformScope`) is exercised by the integration suite.
 */

describe('deriveScope — owner derivation', () => {
  it('derives an owner-only scope from a real user id', () => {
    const ctx = deriveScope({ userId: 'user-123' });
    expect(ctx.owner).toBe('user-123');
    expect(ctx.isPlatform).toBe(false);
    expect(ctx.isSystem).toBe(false);
  });

  it('fails closed when the identity is absent', () => {
    for (const source of [{}, { userId: null }, { userId: undefined }] as const) {
      expect(() => deriveScope(source)).toThrow(NoScopeError);
    }
  });

  it('fails closed on an empty or whitespace identity', () => {
    expect(() => deriveScope({ userId: '' })).toThrow(NoScopeError);
    expect(() => deriveScope({ userId: '   ' })).toThrow(NoScopeError);
  });

  it('refuses the shared scheduler principal as a human owner', () => {
    expect(() => deriveScope({ userId: SYSTEM_PRINCIPAL })).toThrow(NoScopeError);
  });

  it('surfaces the refusal as a 403 NO_SCOPE error', () => {
    try {
      deriveScope({ userId: '' });
      throw new Error('expected NoScopeError');
    } catch (err) {
      const e = err as NoScopeError;
      expect(e).toBeInstanceOf(NoScopeError);
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe('FORBIDDEN');
      expect((e.details as { code?: string }).code).toBe(NO_SCOPE);
    }
  });

  it('tryDeriveScope returns the context or null, never throws', () => {
    expect(tryDeriveScope({ userId: 'user-1' })?.owner).toBe('user-1');
    expect(tryDeriveScope({ userId: '' })).toBeNull();
    expect(tryDeriveScope({})).toBeNull();
  });
});

describe('assertValidScope — runtime barrier', () => {
  it('accepts a scope produced by deriveScope', () => {
    const ctx = deriveScope({ userId: 'user-1' });
    expect(assertValidScope(ctx)).toBe(ctx);
  });

  it('rejects a hand-built context that was never derived (forged isPlatform)', () => {
    const forged = { owner: 'user-1', isPlatform: true, isSystem: false } as unknown as AgentScopeCtx;
    expect(() => assertValidScope(forged)).toThrow(NoScopeError);
  });

  it('rejects a hand-built context that was never derived (forged owner)', () => {
    const forged = { owner: 'victim', isPlatform: false, isSystem: false } as unknown as AgentScopeCtx;
    expect(() => assertValidScope(forged)).toThrow(NoScopeError);
  });

  it('rejects null and undefined', () => {
    expect(() => assertValidScope(null)).toThrow(NoScopeError);
    expect(() => assertValidScope(undefined)).toThrow(NoScopeError);
  });

  it('accepts the derived system scope but rejects a forged system flag', () => {
    const sys = deriveSystemScope();
    expect(assertValidScope(sys)).toBe(sys);

    const forgedSystem = { owner: 'user-1', isPlatform: false, isSystem: true } as unknown as AgentScopeCtx;
    expect(() => assertValidScope(forgedSystem)).toThrow(NoScopeError);
  });
});

describe('platform scope — admin-only, server-authorized', () => {
  it('grants platform scope only to ADMIN and SUPER_ADMIN', () => {
    expect(resolvePlatformScope({ roles: ['ADMIN'] })).toBe(true);
    expect(resolvePlatformScope({ roles: ['SUPER_ADMIN'] })).toBe(true);
    expect(resolvePlatformScope({ roles: ['SUPPORT', 'ADMIN'] })).toBe(true);
  });

  it('never grants platform scope to non-admin roles', () => {
    for (const roles of [[], ['MERCHANT'], ['CUSTOMER'], ['SUPPORT'], ['RISK'], ['DISPUTE']] as const) {
      expect(resolvePlatformScope({ roles: [...roles] })).toBe(false);
    }
  });

  it('treats a missing roles array as no authority', () => {
    expect(resolvePlatformScope({} as never)).toBe(false);
  });

  it('derivePlatformScope refuses a non-admin even with a valid owner', () => {
    expect(() => derivePlatformScope({ userId: 'user-1' }, { roles: ['MERCHANT'] })).toThrow(NoScopeError);
  });

  it('derivePlatformScope refuses a missing owner even for an admin', () => {
    expect(() => derivePlatformScope({ userId: '' }, { roles: ['SUPER_ADMIN'] })).toThrow(NoScopeError);
  });

  it('derivePlatformScope grants platform scope to an admin', () => {
    const ctx = derivePlatformScope({ userId: 'admin-1' }, { roles: ['ADMIN'] });
    expect(ctx.isPlatform).toBe(true);
    expect(ctx.isSystem).toBe(false);
    expect(ctx.owner).toBe('admin-1');
    expect(assertValidScope(ctx)).toBe(ctx);
  });
});

describe('system scope — scheduler telemetry only', () => {
  it('names the system bucket and sets only the system flag', () => {
    const ctx = deriveSystemScope();
    expect(ctx.owner).toBe(SYSTEM_PRINCIPAL);
    expect(ctx.isSystem).toBe(true);
    expect(ctx.isPlatform).toBe(false);
    expect(isSystemScope(ctx)).toBe(true);
  });

  it('is never reachable from a human source', () => {
    // A human owner can never be the system principal.
    expect(tryDeriveScope({ userId: SYSTEM_PRINCIPAL })).toBeNull();
    expect(() => deriveScope({ userId: SYSTEM_PRINCIPAL })).toThrow(NoScopeError);
  });
});

describe('tenant isolation — distinct owners stay distinct', () => {
  it('keeps two owners as separate, non-interchangeable contexts', () => {
    const a = deriveScope({ userId: 'tenant-a' });
    const b = deriveScope({ userId: 'tenant-b' });
    expect(a.owner).not.toBe(b.owner);
    expect(a.owner).toBe('tenant-a');
    expect(b.owner).toBe('tenant-b');
  });

  it('a plain string cannot satisfy the branded owner at runtime', () => {
    // The brand is compile-time only; the runtime barrier is assertValidScope.
    const bare = 'tenant-a' as unknown as OwnerId;
    const forged = { owner: bare, isPlatform: false, isSystem: false } as unknown as AgentScopeCtx;
    expect(() => assertValidScope(forged)).toThrow(NoScopeError);
  });
});
