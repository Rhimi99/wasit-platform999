import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

function baseN(num: number, base = 36): string {
  return num.toString(base);
}

const counter = { c: 0 };

/** Deterministic-ish human-friendly number generator for business documents. */
export function generateBusinessNumber(prefix: string, date = new Date()): string {
  const y = date.getUTCFullYear().toString().slice(2);
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  counter.c = (counter.c + 1) % 46655;
  const rand = Math.floor(Math.random() * 1296);
  const suffix = baseN(rand) + baseN(counter.c, 36);
  return `${prefix}-${y}${m}${d}-${suffix}`.toUpperCase();
}

export function generateOrderNumber(): string {
  return generateBusinessNumber('ORD');
}

export function generateTransactionNumber(): string {
  return generateBusinessNumber('TXN');
}

export function generateDisputeNumber(): string {
  return generateBusinessNumber('DSP');
}

export function generateInvoiceNumber(): string {
  return generateBusinessNumber('INV');
}