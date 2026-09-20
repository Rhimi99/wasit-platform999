/**
 * Currency exponent lookup used by payment adapters that speak in minor units.
 * Kept tiny and dependency-free so the payment layer never imports the DB.
 * Unknown currencies default to 2 (the ISO 4217 common case); TND is 3.
 */
const DECIMALS: Record<string, number> = {
  TND: 3,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  IQD: 3,
  LYD: 3,
  EUR: 2,
  USD: 2,
  GBP: 2,
  MAD: 2,
  DZD: 2,
  EGP: 2,
  SAR: 2,
  AED: 2,
  JPY: 0,
};

export function currencyDecimals(currencyCode: string): number {
  return DECIMALS[currencyCode.trim().toUpperCase()] ?? 2;
}