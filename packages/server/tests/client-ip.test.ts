import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { setContext, setDb } from '../src/lib/request-context';
import { rateLimit, resetRateLimitStore } from '../src/middleware/rate-limit';
import { errorBody } from '../src/middleware/errors';
import { MemoryRateLimitStore } from '../src/lib/rate-limit/memory';
import { setRateLimitStore } from '../src/lib/rate-limit/resolve';
import {
  canonicalIp,
  isIpLiteral,
  isTrustedPeer,
  parseForwardedFor,
  resolveClientIp,
} from '../src/lib/net/client-ip';
import { parseCidr, parseCidrList, ipInCidr, toAddress } from '../src/lib/net/cidr';
import { env } from '../src/lib/env';

/**
 * LC-08 — trusted client IP / anti-XFF spoofing.
 *
 * The socket peer is injected through Hono's `app.request(path, init, env)`,
 * which `@hono/node-server`'s `getConnInfo` reads (`env.incoming.socket`). That
 * is the same seam the real runtime uses, so these tests exercise the real
 * resolution path, not a mock.
 */

/** Runs `fn` with `TRUSTED_PROXY_HOPS` (and any other key) temporarily overridden. */
async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

const socketEnv = (address: string) => ({
  incoming: { socket: { remoteAddress: address, remotePort: 0, remoteFamily: 'IPv4' } },
});

/** Minimal app whose only job is to echo the resolved client IP. */
function echoIpApp() {
  const app = new Hono();
  app.get('/', (c) => c.json({ ip: resolveClientIp(c) }));
  return app;
}

async function resolvedIp(address: string, headers: Record<string, string> = {}): Promise<string | null> {
  const res = await echoIpApp().request('/', { headers }, socketEnv(address) as never);
  return ((await res.json()) as { ip: string | null }).ip;
}

beforeAll(() => {
  resetRateLimitStore();
});

afterAll(() => {
  setRateLimitStore(null);
});

// ---------------------------------------------------------------------------
// Pure parsing / classification
// ---------------------------------------------------------------------------
describe('LC-08 — pure helpers', () => {
  it('accepts only real IP literals', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('::ffff:1.2.3.4')).toBe(true);
    expect(isIpLiteral('2001:db8::1')).toBe(true);
    expect(isIpLiteral('999.1.1.1')).toBe(false);
    expect(isIpLiteral('not-an-ip')).toBe(false);
    expect(isIpLiteral('1.2.3.4:80')).toBe(false);
    expect(isIpLiteral('<script>')).toBe(false);
  });

  it('trusts nothing when the allowlist is empty (no implicit private trust)', async () => {
    await withEnv({ TRUSTED_PROXY_CIDRS: '' }, () => {
      for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.9', '172.16.0.1', 'fd00::1', '8.8.8.8']) {
        expect(isTrustedPeer(ip), ip).toBe(false);
      }
    });
  });

  it('trusts only addresses inside the configured networks', async () => {
    await withEnv({ TRUSTED_PROXY_CIDRS: '10.20.0.0/24, 2001:db8::/32' }, () => {
      for (const ip of ['10.20.0.1', '10.20.0.255', '::ffff:10.20.0.9', '2001:db8::1', '2001:db8:ffff::9']) {
        expect(isTrustedPeer(ip), ip).toBe(true);
      }
      for (const ip of ['10.20.1.1', '10.19.255.255', '10.0.0.5', '127.0.0.1', '192.168.1.1', '2001:db9::1']) {
        expect(isTrustedPeer(ip), ip).toBe(false);
      }
    });
  });

  it('parses a valid XFF chain and rejects malformed or oversized ones', () => {
    expect(parseForwardedFor('1.2.3.4')).toEqual(['1.2.3.4']);
    expect(parseForwardedFor('1.2.3.4, 5.6.7.8')).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(parseForwardedFor(undefined)).toBeNull();
    expect(parseForwardedFor('')).toBeNull();
    expect(parseForwardedFor('1.2.3.4, garbage')).toBeNull();
    expect(parseForwardedFor('1.2.3.4,')).toBeNull();
    expect(parseForwardedFor('1.2.3.4'.repeat(400))).toBeNull();
    expect(parseForwardedFor(Array.from({ length: 25 }, (_, i) => `10.0.0.${i % 255}`).join(','))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CIDR parsing and matching
// ---------------------------------------------------------------------------
describe('LC-08 — CIDR helpers', () => {
  it('parses bare addresses as host routes and CIDRs with a prefix', () => {
    expect(parseCidr('10.0.0.1')?.prefix).toBe(32);
    expect(parseCidr('10.0.0.0/24')?.prefix).toBe(24);
    expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
    expect(parseCidr('2001:db8::/32')?.prefix).toBe(32);
    expect(parseCidr('::ffff:10.0.0.1')?.family).toBe(4);
    expect(parseCidr('::ffff:10.0.0.1')?.prefix).toBe(32);
  });

  it('rejects malformed entries', () => {
    for (const bad of ['', 'garbage', '10.0.0.0/33', '10.0.0.0/-1', '2001:db8::/129', '10.0.0.0/24/8', '1.2.3.4:80', '10.0.0.0/', '::ffff:10.0.0.0/104']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it('matches boundaries exactly and never a neighbour', () => {
    const cidr = parseCidr('10.20.0.0/24')!;
    expect(ipInCidr('10.20.0.0', cidr)).toBe(true);
    expect(ipInCidr('10.20.0.255', cidr)).toBe(true);
    expect(ipInCidr('::ffff:10.20.0.9', cidr)).toBe(true);
    expect(ipInCidr('10.20.1.0', cidr)).toBe(false);
    expect(ipInCidr('10.19.255.255', cidr)).toBe(false);
    expect(ipInCidr('2001:db8::1', cidr)).toBe(false); // family mismatch
  });

  it('matches IPv6 CIDRs and treats mapped IPv4 consistently', () => {
    const v6 = parseCidr('2001:db8::/32')!;
    expect(ipInCidr('2001:db8::1', v6)).toBe(true);
    expect(ipInCidr('2001:db8:ffff::1', v6)).toBe(true);
    expect(ipInCidr('2001:db9::1', v6)).toBe(false);
    expect(ipInCidr('10.0.0.1', v6)).toBe(false);
  });

  it('splits a list and reports invalid entries without dropping valid ones', () => {
    const { cidrs, invalid } = parseCidrList('10.0.0.0/8, bad, 2001:db8::/32');
    expect(cidrs.map((c) => c.source)).toEqual(['10.0.0.0/8', '2001:db8::/32']);
    expect(invalid).toEqual(['bad']);
    expect(parseCidrList(undefined)).toEqual({ cidrs: [], invalid: [] });
  });

  it('normalises IPv4-mapped IPv6 to a single IPv4 key', () => {
    expect(canonicalIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(canonicalIp('203.0.113.7')).toBe('203.0.113.7');
    expect(canonicalIp('2001:db8::1')).toBe('2001:db8::1');
    expect(canonicalIp(null)).toBeNull();
    expect(toAddress('::ffff:10.0.0.1')?.v4).toBe(toAddress('10.0.0.1')?.v4);
  });
});

// ---------------------------------------------------------------------------
// Default (no proxy configured): the socket, and nothing else
// ---------------------------------------------------------------------------
describe('LC-08 — default trust policy (TRUSTED_PROXY_HOPS=0)', () => {
  it('uses the socket peer and ignores a forged X-Forwarded-For', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 0 }, async () => {
      expect(await resolvedIp('203.0.113.10', { 'x-forwarded-for': '1.2.3.4' })).toBe('203.0.113.10');
    });
  });

  it('ignores a forged X-Real-IP', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 0 }, async () => {
      expect(await resolvedIp('203.0.113.10', { 'x-real-ip': '9.9.9.9' })).toBe('203.0.113.10');
    });
  });

  it('ignores both headers together', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 0 }, async () => {
      expect(
        await resolvedIp('203.0.113.10', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '9.9.9.9' }),
      ).toBe('203.0.113.10');
    });
  });

  it('canonicalises an IPv4-mapped IPv6 socket address to one IPv4 key', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 0 }, async () => {
      expect(await resolvedIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(await resolvedIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    });
  });
});

// ---------------------------------------------------------------------------
// Trusted proxy configured
// ---------------------------------------------------------------------------
describe('LC-08 — trusted proxy (TRUSTED_PROXY_HOPS>0 with an allowlist)', () => {
  const PROXY = '10.20.0.9';

  it('reads the client from the chain right-to-left (one proxy)', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp(PROXY, { 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
    });
  });

  it('discards a client-supplied prefix in a multi-proxy chain', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 2, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      // Attacker sent "1.2.3.4"; our two proxies appended "10.20.0.1, 10.20.0.2".
      // With 2 hops the client is the 2nd from the right — never the forged head.
      expect(await resolvedIp(PROXY, { 'x-forwarded-for': '1.2.3.4, 10.20.0.1, 10.20.0.2' })).toBe('10.20.0.1');
    });
  });

  it('does not trust a private proxy that is not in the allowlist', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      // 10.30.0.9 is RFC1918 but NOT allowlisted → treated as the direct client.
      expect(await resolvedIp('10.30.0.9', { 'x-forwarded-for': '203.0.113.5' })).toBe('10.30.0.9');
      expect(await resolvedIp('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })).toBe('127.0.0.1');
    });
  });

  it('trusts nothing when hops are declared but the allowlist is empty', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '' }, async () => {
      expect(await resolvedIp('10.20.0.9', { 'x-forwarded-for': '203.0.113.5' })).toBe('10.20.0.9');
    });
  });

  it('does not trust a CIDR entry on its own (hops still required)', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 0, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp('10.20.0.9', { 'x-forwarded-for': '203.0.113.5' })).toBe('10.20.0.9');
    });
  });

  it('refuses a chain shorter than the configured hop count (no guessing)', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 3, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp(PROXY, { 'x-forwarded-for': '203.0.113.5' })).toBeNull();
    });
  });

  it('refuses a malformed chain', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp(PROXY, { 'x-forwarded-for': '1.2.3.4, not-an-ip' })).toBeNull();
    });
  });

  it('refuses the chain when it is absent', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp(PROXY)).toBeNull();
    });
  });

  it('does not trust a forwarded header when the peer is not a proxy', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      // A direct internet client is never a proxy.
      expect(await resolvedIp('8.8.8.8', { 'x-forwarded-for': '1.2.3.4' })).toBe('8.8.8.8');
    });
  });

  it('matches an IPv6 proxy network and returns the client', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '2001:db8::/32' }, async () => {
      expect(await resolvedIp('2001:db8::9', { 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
      expect(await resolvedIp('2001:db9::9', { 'x-forwarded-for': '203.0.113.5' })).toBe('2001:db9::9');
    });
  });

  it('matches an IPv4-mapped proxy address against an IPv4 allowlist entry', async () => {
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      expect(await resolvedIp('::ffff:10.20.0.9', { 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
    });
  });

  it('reads the real client behind an allowlisted loopback proxy (public-demo topology)', async () => {
    // The published demo serves the API only through the local web proxy, so the
    // socket peer is always `::ffff:127.0.0.1`. Left undeclared, every visitor
    // resolves to the same `ip:127.0.0.1` and shares one rate-limit bucket, so
    // aggregate traffic trips the per-IP login limit and real users get 429.
    // Declaring the loopback proxy makes the client come from the chain instead.
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '127.0.0.0/8' }, async () => {
      expect(await resolvedIp('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.10' })).toBe('203.0.113.10');
      expect(await resolvedIp('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.11' })).toBe('203.0.113.11');
      // A peer that is not the allowlisted proxy is still never trusted.
      expect(await resolvedIp('::ffff:198.51.100.7', { 'x-forwarded-for': '203.0.113.10' })).toBe('198.51.100.7');
    });
  });
});

// ---------------------------------------------------------------------------
// Rate-limit integration
// ---------------------------------------------------------------------------
function limitedApp(max: number, userId?: string) {
  const app = new Hono();
  app.onError((err, c) => errorBody(err, c));
  app.use('*', async (c: Context, next: Next) => {
    setDb(c, {} as never);
    setContext(c, {
      db: {} as never,
      user: userId
        ? { id: userId, email: 'u@wasit.tn', emailVerified: true, isActive: true, mfaEnabled: false, roles: ['CUSTOMER'] }
        : null,
      traceId: 'test',
      ipAddress: null,
      userAgent: null,
    });
    await next();
  });
  app.use('/limited', rateLimit({ windowSeconds: 60, max, keyPrefix: 'lc08' }));
  app.get('/limited', (c) => c.json({ ok: true }));
  return app;
}

describe('LC-08 — rate limiting cannot be bypassed by spoofing', () => {
  it('reaches 429 at the real limit and ignores a rotating XFF', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(3);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/limited',
        { headers: { 'x-forwarded-for': `1.2.3.${i}` } },
        socketEnv('198.51.100.7') as never,
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it('treats different socket peers as different subjects', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(1);
    const first = await app.request('/limited', {}, socketEnv('198.51.100.1') as never);
    const second = await app.request('/limited', {}, socketEnv('198.51.100.2') as never);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('fails closed: no resolvable address shares one bucket instead of a fresh key', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(2);
    // No socket env and no trusted proxy ⇒ address is null; requests still share
    // the `unknown` bucket, so a flood cannot mint new keys.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/limited', { headers: { 'x-forwarded-for': `1.2.3.${i}` } });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200);
    expect(statuses[2]).toBe(429);
  });

  it('keeps an authenticated subject keyed by user id, even with a forged XFF', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(2, 'user-abc');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        '/limited',
        { headers: { 'x-forwarded-for': `1.2.3.${i}` } },
        socketEnv('198.51.100.7') as never,
      );
      statuses.push(res.status);
    }
    expect(statuses[2]).toBe(429);
  });

  it('does not leak the client IP or header value in the 429 body', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(1);
    await app.request('/limited', { headers: { 'x-forwarded-for': '1.2.3.4' } }, socketEnv('198.51.100.7') as never);
    const res = await app.request('/limited', { headers: { 'x-forwarded-for': '1.2.3.4' } }, socketEnv('198.51.100.7') as never);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain('198.51.100.7');
    expect(text).not.toContain('1.2.3.4');
  });

  it('keys by the real client behind an allowlisted proxy and ignores its rotating XFF prefix', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(2);
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        // The proxy (10.20.0.9) appends the real client last; the attacker's
        // leading XFF values change but must not move the bucket key.
        const res = await app.request(
          '/limited',
          { headers: { 'x-forwarded-for': `9.9.9.${i}, 203.0.113.77` } },
          socketEnv('10.20.0.9') as never,
        );
        statuses.push(res.status);
      }
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).toBe(200);
      expect(statuses[2]).toBe(429);
    });
  });

  it('keeps an unlisted private peer as its own subject (no chain trust)', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const app = limitedApp(1);
    await withEnv({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_CIDRS: '10.20.0.0/24' }, async () => {
      const first = await app.request('/limited', { headers: { 'x-forwarded-for': '1.2.3.4' } }, socketEnv('10.30.0.9') as never);
      // Second request from the same unlisted peer, a different XFF: still the
      // same bucket because the header is ignored → 429.
      const second = await app.request('/limited', { headers: { 'x-forwarded-for': '5.6.7.8' } }, socketEnv('10.30.0.9') as never);
      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });
  });
});
