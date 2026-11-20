import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env';
import { logger } from '../observability/logger';
import { parseCidrList, ipInCidr, toAddress, type Cidr } from './cidr';

/**
 * Trusted client-IP resolution — the single source of truth for "which address
 * is this request from".
 *
 * The raw socket peer is the only value a direct client cannot forge. Forwarded
 * headers (`X-Forwarded-For`, `X-Real-IP`) are attacker-controlled unless the
 * request provably arrived from a proxy *we* operate, so they are ignored unless
 * an operator explicitly allowlists that proxy's network (`TRUSTED_PROXY_CIDRS`)
 * and declares how many proxies sit in front (`TRUSTED_PROXY_HOPS`).
 *
 * Trust is granted per network, never inferred: loopback, RFC1918 and ULA are
 * **not** trusted implicitly, because on a shared host or a flat private network
 * they would let a co-tenant forge client addresses. With the default empty
 * allowlist, nothing is trusted and the socket peer always wins.
 *
 * Every consumer that needs an address — rate limiting, audit records — must go
 * through here so no two parts of the system disagree about the client.
 */

/** Bucket key used when no address can be established safely (fail-closed). */
export const UNKNOWN_CLIENT_KEY = 'unknown';

// Bounds so a hostile header cannot cost unbounded work or memory.
const MAX_FORWARDED_LENGTH = 2048;
const MAX_HOPS = 20;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

function isIpv4(value: string): boolean {
  const match = IPV4_RE.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || !IPV6_RE.test(value)) return false;
  return value.split(':').every((group) => group.length <= 4);
}

/** Whether a token is a syntactically plausible IPv4/IPv6 literal. */
export function isIpLiteral(value: string): boolean {
  const token = value.toLowerCase();
  if (token.startsWith('::ffff:') && isIpv4(token.slice(7))) return true;
  return isIpv4(token) || isIpv6(token);
}

/** The real TCP peer address, or null when the runtime exposes none. */
export function socketAddress(c: Context): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return address ? address : null;
  } catch {
    return null;
  }
}

/**
 * Canonical form of an address for use as a bucket key: an IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`) is rendered as its IPv4 form so the same client
 * yields one key regardless of which socket form the runtime reported.
 */
export function canonicalIp(address: string | null): string | null {
  if (!address) return null;
  if (!address.includes(':')) return address;
  const parsed = toAddress(address);
  if (!parsed || parsed.v4 === null) return address;
  const v4 = parsed.v4;
  return [v4 >> 24n, (v4 >> 16n) & 0xffn, (v4 >> 8n) & 0xffn, v4 & 0xffn].map(String).join('.');
}

// The allowlist is rebuilt whenever the raw setting changes, so tests that
// override the env pick up the new value without an explicit reset.
let cachedRaw: string | undefined;
let cachedCidrs: Cidr[] = [];

function trustedProxyCidrs(): Cidr[] {
  const raw = env.TRUSTED_PROXY_CIDRS;
  if (raw !== cachedRaw) {
    const { cidrs, invalid } = parseCidrList(raw);
    cachedRaw = raw;
    cachedCidrs = cidrs;
    if (invalid.length > 0) {
      logger.warn('ignoring invalid TRUSTED_PROXY_CIDRS entries', { invalid });
    }
  }
  return cachedCidrs;
}

/**
 * Whether an address is an explicitly allowlisted proxy. With no configured
 * networks this is always false — no implicit loopback/private trust.
 */
export function isTrustedPeer(address: string): boolean {
  const cidrs = trustedProxyCidrs();
  if (cidrs.length === 0) return false;
  return cidrs.some((cidr) => ipInCidr(address, cidr));
}

/**
 * Parses an `X-Forwarded-For` header into ordered hop addresses, or null when it
 * is absent, oversized, too long, or contains anything that is not an IP
 * literal. A malformed chain is never partially trusted.
 */
export function parseForwardedFor(raw: string | undefined): string[] | null {
  if (!raw || raw.length > MAX_FORWARDED_LENGTH) return null;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_HOPS) return null;
  if (!parts.every(isIpLiteral)) return null;
  return parts;
}

/**
 * Resolves the address to attribute this request to.
 *
 * - `TRUSTED_PROXY_HOPS=0` (default): the socket peer, and nothing else. A
 *   direct client cannot influence its own address.
 * - `TRUSTED_PROXY_HOPS=N>0`: the forwarded chain is consulted **only** when the
 *   socket peer matches a configured `TRUSTED_PROXY_CIDRS` network. The client
 *   is then the entry `N` from the right (everything the client prepended is
 *   discarded). A short or malformed chain yields null rather than a guess.
 * - A declared proxy hop with an empty allowlist trusts nothing: the socket peer
 *   is used, so a misconfiguration cannot silently enable header trust.
 *
 * Returns null when no trustworthy address exists; callers must fail closed.
 */
export function resolveClientIp(c: Context): string | null {
  const socket = socketAddress(c);
  const hops = env.TRUSTED_PROXY_HOPS;

  if (hops <= 0) return canonicalIp(socket);
  // Not a proxy we declared → this is the direct client; never read the chain.
  if (!socket || !isTrustedPeer(socket)) return canonicalIp(socket);

  const forwarded = parseForwardedFor(c.req.header('x-forwarded-for'));
  if (forwarded === null || forwarded.length < hops) return null;
  // Right-to-left: the rightmost entries were appended by our own proxies; the
  // client sits `hops` entries in from the right.
  return canonicalIp(forwarded[forwarded.length - hops] ?? null);
}
