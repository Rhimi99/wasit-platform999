/**
 * Parses a numeric query parameter that must be a positive integer.
 *
 * Returns `undefined` for anything that is not one — absent, blank, non-numeric
 * (`"abc"`), non-finite (`"Infinity"`), zero, negative, or fractional. Callers
 * read `undefined` as "not supplied" and fall back to their own default, the
 * same convention the enum filters on these routes already use for an
 * unrecognised value.
 *
 * The distinction is not cosmetic. `Number("abc")` is `NaN`, and `NaN` survives
 * both `Math.max` and `Math.min` unchanged, so a single malformed query string
 * would otherwise reach `LIMIT`/`OFFSET` as `NaN` — which PostgreSQL accepts as
 * an unbounded limit, silently returning every row a caller asked to be capped.
 * `"Infinity"` is worse: it raises a driver error and turns the request into a
 * 500. Refusing the value here keeps the cap the caller sees equal to the cap
 * the database applies.
 */
export function parsePositiveIntParam(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}
