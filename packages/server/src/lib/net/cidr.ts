import net from 'node:net';

/**
 * Minimal, dependency-free CIDR handling for the trusted-proxy allowlist
 * (LC-08).
 *
 * Addresses are compared numerically, not as strings, so `10.0.0.1` cannot slip
 * past a `10.0.0.0/24` rule by prefix tricks and boundary addresses are exact.
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is treated as IPv4 so one allowlist entry
 * covers both socket forms the Node runtime can report.
 */

export interface Cidr {
  family: 4 | 6;
  /** Network address, masked to `prefix`. */
  network: bigint;
  bits: 32 | 128;
  prefix: number;
  /** The original entry, for diagnostics. */
  source: string;
}

export interface ParsedAddress {
  /** IPv4 value, present for IPv4 literals and IPv4-mapped IPv6. */
  v4: bigint | null;
  /** Always the full 128-bit IPv6 value (IPv4 is mapped to `::ffff:0:0/96`). */
  v6: bigint;
}

const V4_MASK_32 = 0xffffffffn;

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map(Number);
  return (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]);
}

/** The `::ffff:0:0/96` mapping of an IPv4 value into the IPv6 space. */
function mappedV6(v4: bigint): bigint {
  return (0xffffn << 32n) | v4;
}

function isIpv4Mapped(ip: string): boolean {
  const s = ip.toLowerCase();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7));
}

/** Expands a validated IPv6 literal to its 128-bit value, or null. */
function expandIpv6(ip: string): bigint | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!net.isIPv6(addr)) return null;

  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    const v4 = addr.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const parts = v4.split('.').map(Number);
    const g1 = ((parts[0] << 8) | parts[1]).toString(16);
    const g2 = ((parts[2] << 8) | parts[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Parses an IP literal into both its IPv4 (when applicable) and IPv6 values. */
export function toAddress(ip: string): ParsedAddress | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (net.isIPv4(s)) {
    const v4 = ipv4ToBigInt(s);
    return { v4, v6: mappedV6(v4) };
  }
  if (net.isIPv6(s)) {
    const v6 = expandIpv6(s);
    if (v6 === null) return null;
    const v4 = v6 >> 32n === 0xffffn ? v6 & V4_MASK_32 : null;
    return { v4, v6 };
  }
  return null;
}

function maskFor(bits: 32 | 128, prefix: number): bigint {
  if (prefix <= 0) return 0n;
  const all = (1n << BigInt(bits)) - 1n;
  if (prefix >= bits) return all;
  return all ^ ((1n << BigInt(bits - prefix)) - 1n);
}

/**
 * Parses one allowlist entry — `a.b.c.d`, `a.b.c.d/nn`, an IPv6 literal, or an
 * IPv6 CIDR — into a `Cidr`, or null when it is not a valid network. A bare
 * address is treated as a host route (`/32` or `/128`).
 */
export function parseCidr(entry: string): Cidr | null {
  const raw = entry.trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const addrPart = slash === -1 ? raw : raw.slice(0, slash);
  const prefixPart = slash === -1 ? null : raw.slice(slash + 1);
  if (slash !== -1 && prefixPart === '') return null;

  let family: 4 | 6;
  let base: bigint;
  if (net.isIPv4(addrPart)) {
    family = 4;
    base = ipv4ToBigInt(addrPart);
  } else if (isIpv4Mapped(addrPart)) {
    // A mapped literal is IPv4; a prefix would be in the 128-bit space and does
    // not map cleanly onto 32 bits, so only the bare host route is accepted.
    if (prefixPart !== null) return null;
    family = 4;
    base = ipv4ToBigInt(addrPart.slice(7));
  } else if (net.isIPv6(addrPart)) {
    const expanded = expandIpv6(addrPart);
    if (expanded === null) return null;
    family = 6;
    base = expanded;
  } else {
    return null;
  }

  const bits: 32 | 128 = family === 4 ? 32 : 128;
  let prefix: number = bits;
  if (prefixPart !== null) {
    if (!/^\d+$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix < 0 || prefix > bits) return null;
  }

  return { family, network: base & maskFor(bits, prefix), bits, prefix, source: raw };
}

/** Whether `ip` falls inside `cidr` (families must agree). */
export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const addr = toAddress(ip);
  if (!addr) return false;
  if (cidr.family === 4) {
    if (addr.v4 === null) return false;
    return (addr.v4 & maskFor(32, cidr.prefix)) === cidr.network;
  }
  return (addr.v6 & maskFor(128, cidr.prefix)) === cidr.network;
}

export interface CidrList {
  cidrs: Cidr[];
  /** Entries that looked like they were meant to be networks but were invalid. */
  invalid: string[];
}

/** Splits a comma/whitespace-separated list into valid networks and rejects. */
export function parseCidrList(raw: string | undefined): CidrList {
  const cidrs: Cidr[] = [];
  const invalid: string[] = [];
  if (!raw) return { cidrs, invalid };
  for (const token of raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)) {
    const cidr = parseCidr(token);
    if (cidr) cidrs.push(cidr);
    else invalid.push(token);
  }
  return { cidrs, invalid };
}
