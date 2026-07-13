import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawBody } from "@pay-normalize/core";

export const SIGNATURE_HEADER = "monnify-signature";

/**
 * Monnify webhook signature.
 *
 * Scheme — the signature census, five providers in:
 *   Paystack:    header, HMAC-SHA512 (SHA-2), raw body,         hex
 *   Monnify:     header, HMAC-SHA512 (SHA-2), raw body,         hex
 *   Nomba:       header, HMAC-SHA256,          canonical string, base64
 *   Flutterwave: header, HMAC-SHA256,          raw body,         base64
 * Monnify and Paystack share an algorithm (HMAC-SHA512/hex) but differ in the
 * secret used (Monnify: your CLIENT SECRET key; Paystack: your secret key) and
 * the header name.
 *
 * ⚠️ DOCS CONTRADICTION, RESOLVED EMPIRICALLY:
 * Monnify's prose says "SHA-512(client secret key + object of request body)"
 * (a plain SHA-512 of a concatenation), while their Node sample calls
 * `sha512.hmac(secret, JSON.stringify(body, null, 2))` — HMAC-SHA512 over a
 * PRETTY-PRINTED body. Neither reproduces their own published golden hash.
 * Computing all four candidates against their documented example
 * (secret `91MUDL9N6U3BQRXBQ2PJ9M0PW4J22M1Y`, hash `f04fb635…aedcd3c`) shows
 * the truth is:
 *
 *     HMAC-SHA512(clientSecret, COMPACT JSON body) → hex
 *
 * i.e. their prose (not-HMAC) is wrong AND their sample (pretty-print) is
 * wrong; the real scheme is HMAC over the compact serialization. Since the
 * signature is over the compact bytes, verifying over the RAW REQUEST BYTES is
 * correct **provided Monnify transmits the same bytes it signed** (the normal
 * webhook contract). The golden-vector test pins the byte-for-byte hash.
 *
 * ⚠️ GRADUATION CAVEAT: the wire serialization is unconfirmed without a real
 * captured delivery (headers + exact bytes). If Monnify ever transmits
 * pretty-printed bytes while signing compact ones, raw-body verification would
 * fail and the host must reconstruct the compact form — a one-line change and a
 * fixture, not a redesign. When donating fixtures, CAPTURE THE HEADERS AND THE
 * EXACT BYTES.
 *
 * Their samples compare with `===`; we use timingSafeEqual.
 */
export function verifyMonnifySignature(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: RawBody;
  /** Your Monnify CLIENT SECRET key. An argument, never an env read. */
  secret: string;
}): boolean {
  const provided = headerValue(input.headers, SIGNATURE_HEADER);
  if (!provided || !input.secret) return false;

  const expected = createHmac("sha512", input.secret).update(input.rawBody).digest("hex");
  const providedBuf = Buffer.from(provided.trim().toLowerCase(), "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Case-insensitive header lookup; tolerates string[] (Node duplicates). */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
