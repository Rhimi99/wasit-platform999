import { randomUUID, randomInt } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Human-friendly number generator for business documents.
 *
 * The date prefix repeats for every document issued on the same day and an
 * in-process counter would restart at 0 with each process, so uniqueness cannot
 * come from those parts: a fresh process would reissue numbers a previous one
 * already used, fail the unique index, and surface as a 500 on order creation.
 * The suffix therefore carries real entropy — 36^8 ≈ 2.8e12 values per day,
 * drawn from the CSPRNG to avoid same-millisecond collisions too.
 */
export function generateBusinessNumber(prefix: string, date = new Date()): string {
  const y = date.getUTCFullYear().toString().slice(2);
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += ALPHABET[randomInt(36)];
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