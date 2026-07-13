import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawBody } from "@pay-normalize/core";

export const SIGNATURE_HEADER = "x-paystack-signature";

/**
 * Paystack signs each event with HMAC-SHA512 over the payload, using your
 * secret key, delivered in the `x-paystack-signature` header (hex).
 *
 * Two deliberate departures from Paystack's own sample code:
 *
 * 1. We HMAC the RAW BYTES, not `JSON.stringify(req.body)`. Their sample
 *    re-serializes the parsed body and compares — which only works while
 *    stringify happens to reproduce the exact bytes they signed. Unicode
 *    escaping and number formatting make that a "works until it doesn't" bug.
 *    The signature was computed over bytes; verify over bytes.
 *
 * 2. `timingSafeEqual`, not `==`. String comparison short-circuits on the
 *    first differing character, leaking timing information about how much of
 *    a forged signature is correct.
 */
export function verifyPaystackSignature(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: RawBody;
  secret: string;
}): boolean {
  const provided = headerValue(input.headers, SIGNATURE_HEADER);
  if (!provided || !input.secret) return false;

  const expectedHex = createHmac("sha512", input.secret)
    .update(input.rawBody)
    .digest("hex");

  // Both are hex; compare as buffers of equal length or fail fast.
  const providedBuf = Buffer.from(provided.trim().toLowerCase(), "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Case-insensitive header lookup; tolerates string[] (Node duplicates). */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}
