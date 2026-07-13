import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawBody } from "@pay-normalize/core";

export const SIGNATURE_HEADER = "flutterwave-signature";

/**
 * Flutterwave v4 webhook signature: HMAC-SHA256 over the RAW BODY, using the
 * secret hash you configure on the dashboard, BASE64-encoded, delivered in
 * the `flutterwave-signature` header.
 *
 * The signature-scheme census across this library, five providers in:
 *   Paystack:    header, HMAC-SHA512  (SHA-2), raw body,         hex
 *   OPay:        body,   HMAC-SHA3-512,        canonical string, hex
 *   Nomba:       header, HMAC-SHA256,          canonical string, base64
 *   Flutterwave: header, HMAC-SHA256,          raw body,         base64
 * Four providers, four schemes. This table is the library's reason to exist.
 *
 * ⚠️ DOCS CONTRADICTION, PINNED (docs-derived connector, remember):
 * Flutterwave's "Verifying Webhook Signatures" section documents the HMAC
 * scheme above — their own sample code HMACs rawBody and compares base64.
 * But the "Examples" section of the SAME page compares the header DIRECTLY
 * to the plain secret (`signature !== secretHash`, no HMAC) — the legacy v3
 * `verif-hash` behavior wearing a v4 header name. Both cannot be true for
 * one delivery. We implement the documented HMAC scheme; the first sanitized
 * production webhook (headers included!) arbitrates. If reality turns out to
 * be plain-secret comparison, that is a one-line connector fix and a
 * fixture — not a redesign. When donating fixtures for this provider,
 * CAPTURE THE HEADERS.
 *
 * Their Node sample also compares with `===` — we use timingSafeEqual.
 */
export function verifyFlutterwaveSignature(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: RawBody;
  secret: string;
}): boolean {
  const provided = headerValue(input.headers, SIGNATURE_HEADER);
  if (!provided || !input.secret) return false;

  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("base64");
  const providedBuf = Buffer.from(provided.trim(), "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
