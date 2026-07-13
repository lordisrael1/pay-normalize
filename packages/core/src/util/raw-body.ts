/**
 * RawBody — a branded Buffer that connectors require for signature verification.
 *
 * THE #1 INTEGRATION BUG THIS PREVENTS:
 * Providers compute webhook signatures (HMAC-SHA512 for Paystack, provider-specific
 * schemes elsewhere) over the EXACT BYTES they sent. If a host runs the request
 * through `express.json()` and later re-serializes (`JSON.stringify(req.body)`),
 * key order, whitespace, and unicode escaping can change — the HMAC no longer
 * matches, and the host spends a night debugging "invalid signature" on
 * perfectly valid webhooks.
 *
 * By requiring `RawBody` (constructible only from a Buffer via `toRawBody`),
 * a host that only has parsed JSON gets a COMPILE ERROR instead of a 2am mystery.
 *
 * Express hosts: mount `express.raw({ type: "application/json" })` on webhook
 * routes (route-scoped, before any json middleware), then `toRawBody(req.body)`.
 * Parse to JSON only AFTER verification, from these same bytes.
 */
export type RawBody = Buffer & { readonly __brand: "RawBody" };

export function toRawBody(buf: Buffer): RawBody {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError(
      "toRawBody expects a Buffer of the exact request bytes. " +
        "If you only have a parsed object, your middleware consumed the raw body — " +
        "use express.raw() (or your framework's equivalent) on webhook routes."
    );
  }
  return buf as RawBody;
}

/**
 * Escape hatch for tests and fixture replay ONLY. Constructing a RawBody from a
 * string in production risks re-serialization drift — fixtures store the
 * original bytes precisely so this stays faithful.
 */
export function rawBodyFromString(s: string, encoding: BufferEncoding = "utf8"): RawBody {
  return Buffer.from(s, encoding) as RawBody;
}
