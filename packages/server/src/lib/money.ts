import { Decimal } from 'decimal.js';
import { ApiError } from '@wasit/shared';

Decimal.set({ precision: 40 });

export function toDecimal(value: string | number): Decimal {
  return new Decimal(value.toString());
}

export function fmt(value: string | number | Decimal): string {
  const d = value instanceof Decimal ? value : toDecimal(value);
  return d.toFixed(4);
}

export function isNegative(value: string | number | Decimal): boolean {
  const d = value instanceof Decimal ? value : toDecimal(value);
  return d.isNegative();
}

export function assertNonNegative(value: string | number, field = 'amount'): void {
  const d = toDecimal(value);
  if (d.isNegative()) {
    throw ApiError.validation([{ field, message: 'Must not be negative', code: 'VALIDATION_FAILED' }]);
  }
}

export function roundMoney(value: string | number | Decimal): Decimal {
  const d = value instanceof Decimal ? value : toDecimal(value);
  return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export interface MoneyParts {
  amount: Decimal;
  currencyCode: string;
}