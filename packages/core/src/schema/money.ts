import { AmountParseError } from "../errors";

/**
 * Kobo — the ONLY representation of money inside this library.
 *
 * Branded type: a plain `number` will not typecheck where `Kobo` is required,
 * so unconverted provider amounts cannot leak past the connector boundary.
 *
 * Rules (NOT_DOING.md §9):
 *  - Integers only. Floats are banned; all parsing below uses string/BigInt math,
 *    so `"5000.10"` can never become `500009.999...` via IEEE-754.
 *  - Conversion happens exactly ONCE, at the connector boundary, via the
 *    parsers in this file. Core and hosts only ever see Kobo.
 */
export type Kobo = number & { readonly __brand: "Kobo" };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Hard length ceiling for amount strings. The largest representable value —
 * MAX_SAFE_INTEGER kobo (~90 trillion naira) with thousands separators, two
 * decimals, and a currency prefix — is ~24 chars. 40 leaves generous slack
 * while making any hostile megabyte-long string an O(1) rejection BEFORE it
 * reaches the regex below (defense against ReDoS; see parseNairaDecimalString).
 */
const MAX_AMOUNT_LEN = 40;

/** Assert an already-integer amount is valid Kobo (e.g. Paystack's `amount` field). */
export function asKobo(value: number): Kobo {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AmountParseError(
      `Expected a non-negative safe integer kobo amount, got: ${String(value)}`,
      value
    );
  }
  return value as Kobo;
}

/**
 * Parse a kobo amount that arrives as an integer-looking value.
 * Accepts `500000` or `"500000"`. Rejects decimals — if a provider sends
 * decimals, it is a naira amount and MUST go through parseNairaDecimalString.
 */
export function parseKoboInteger(input: number | string): Kobo {
  if (typeof input === "number") return asKobo(input);
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new AmountParseError(
      `Expected integer kobo string, got: "${input}". ` +
        `If this is a naira decimal, use parseNairaDecimalString().`,
      input
    );
  }
  const big = BigInt(trimmed);
  if (big > MAX_SAFE) {
    throw new AmountParseError(`Kobo amount exceeds MAX_SAFE_INTEGER: "${input}"`, input);
  }
  return Number(big) as Kobo;
}

/**
 * Parse naira expressed as a decimal string or number into Kobo, using
 * string math only (never parseFloat).
 *
 * Accepts the shapes actually seen across Nigerian providers:
 *   "5000"      -> 500000
 *   "5000.00"   -> 500000
 *   "5000.5"    -> 500050   (one decimal place = tens of kobo)
 *   "5,000.00"  -> 500000   (thousands separators)
 *   5000        -> 500000   (numeric naira, e.g. Monnify amounts)
 *   "₦5,000.00" -> 500000
 *
 * Rejects: negatives, >2 decimal places (no such thing as half a kobo),
 * empty strings, scientific notation, over-long input, and anything ambiguous.
 */
export function parseNairaDecimalString(input: string | number): Kobo {
  const s = typeof input === "number" ? numberToPlainString(input) : input;
  if (s.length > MAX_AMOUNT_LEN) {
    throw new AmountParseError(
      `Naira amount string too long (${s.length} chars); no real amount exceeds ${MAX_AMOUNT_LEN}`,
      input
    );
  }
  // ReDoS-safe matching: trim once so the pattern carries a SINGLE internal
  // \s* run. The prior `^\s*…\s*$` form let leading and trailing whitespace
  // runs trade off against each other, backtracking O(n²) on inputs like
  // "   …   x". Trimming + one \s* keeps it linear; the length cap above is
  // belt-and-suspenders.
  const t = s.trim();
  const m = /^(?:₦|NGN)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t);
  const wholeGroup = m?.[1];
  if (!m || wholeGroup === undefined) {
    throw new AmountParseError(
      `Cannot parse naira amount: "${String(input)}"`,
      input
    );
  }
  const whole = BigInt(wholeGroup.replace(/,/g, ""));
  const fracRaw = m[2] ?? "";
  const frac = BigInt(fracRaw.padEnd(2, "0") || "0");
  const kobo = whole * 100n + frac;
  if (kobo > MAX_SAFE) {
    throw new AmountParseError(`Amount exceeds MAX_SAFE_INTEGER: "${String(input)}"`, input);
  }
  return Number(kobo) as Kobo;
}

/** Display helper only. Never feed its output back into parsing logic. */
export function koboToNairaString(kobo: Kobo): string {
  const whole = Math.trunc(kobo / 100);
  const frac = kobo % 100;
  return `${whole.toLocaleString("en-NG")}.${String(frac).padStart(2, "0")}`;
}

/**
 * Numeric naira input (e.g. Monnify sends `amount: 5000.5`) is converted to a
 * plain decimal string first so that BigInt string math — not float math —
 * performs the kobo conversion. toFixed(2) here is safe: provider amounts are
 * far below the ~2^53/100 threshold where representation error could shift a kobo,
 * and >2dp inputs are rejected as invalid money anyway.
 */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new AmountParseError(`Cannot parse naira amount: ${String(n)}`, n);
  }
  if (Number.isInteger(n)) return String(n);
  const fixed = n.toFixed(2);
  // Guard: reject inputs with >2dp of real precision (e.g. 5000.505)
  if (Math.abs(Number(fixed) - n) > Number.EPSILON * Math.max(1, Math.abs(n))) {
    throw new AmountParseError(
      `Naira amount has more than 2 decimal places: ${String(n)}`,
      n
    );
  }
  return fixed;
}
