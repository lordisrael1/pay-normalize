import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Nomba webhook signature (nomba-signature-version 1.0.0).
 *
 * Scheme — the THIRD distinct pattern across three Nigerian providers, which
 * is the entire reason this library exists:
 *   - Paystack: header-carried, HMAC-SHA512 (SHA-2) over RAW BODY, hex
 *   - OPay:     body-carried,   HMAC-SHA3-512 over CANONICAL STRING, hex
 *   - Nomba:    header-carried, HMAC-SHA256 over CANONICAL STRING, BASE64
 *
 * Canonical string (colon-joined, 9 fields, validated byte-for-byte against
 * the worked example in Nomba's own docs — see the golden-vector test):
 *
 *   event_type : requestId : merchant.userId : merchant.walletId :
 *   transaction.transactionId : transaction.type : transaction.time :
 *   transaction.responseCode : nomba-timestamp
 *
 * Quirks encoded from their reference implementation:
 *   - responseCode of literal string "null" is treated as "" before hashing.
 *   - nomba-timestamp comes from the HEADER, not the payload — meaning the
 *     signature binds each delivery to its send time. Hosts can (should)
 *     reject stale timestamps to shrink the replay window.
 *   - Their Go sample compares signatures with strings.EqualFold —
 *     case-insensitive, which is sloppy for base64 (case-sensitive alphabet).
 *     We compare exact bytes, constant-time.
 *
 * ⚠️ SECURITY FINDING — READ THIS TWICE:
 * The canonical string contains ONLY routing/identity metadata. The AMOUNT is
 * NOT signed. Neither is the fee, the sender, nor the account number. A party
 * able to modify the payload in transit (or replay-tamper it) can change
 * `transactionAmount` from 120 to 120000 and the signature still verifies.
 * Consequences for hosts:
 *   1. TLS on your webhook endpoint is not optional — it is the only thing
 *      authenticating the amount.
 *   2. For material credits, confirm the amount via Nomba's transaction
 *      lookup API (host-side call, outside this library) before releasing
 *      value. The webhook tells you SOMETHING happened to transactionId X;
 *      treat the unsigned fields as a hint of WHAT.
 * There is a test that demonstrates the tampered-amount case verifying.
 */

export const SIGNATURE_HEADER = "nomba-signature";
export const TIMESTAMP_HEADER = "nomba-timestamp";

export interface NombaSignedFields {
  eventType: string;
  requestId: string;
  merchantUserId: string;
  merchantWalletId: string;
  transactionId: string;
  transactionType: string;
  transactionTime: string;
  responseCode: string;
  nombaTimestamp: string;
}

export function buildNombaCanonicalString(f: NombaSignedFields): string {
  const responseCode = f.responseCode === "null" ? "" : f.responseCode;
  return [
    f.eventType,
    f.requestId,
    f.merchantUserId,
    f.merchantWalletId,
    f.transactionId,
    f.transactionType,
    f.transactionTime,
    responseCode,
    f.nombaTimestamp,
  ].join(":");
}

export function signNombaCanonicalString(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("base64");
}

export function verifyNombaSignature(input: {
  signedFields: NombaSignedFields;
  providedSignature: string | undefined;
  secret: string;
}): boolean {
  if (!input.providedSignature || !input.secret) return false;
  const expected = signNombaCanonicalString(
    buildNombaCanonicalString(input.signedFields),
    input.secret
  );
  const providedBuf = Buffer.from(input.providedSignature.trim(), "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Case-insensitive header lookup (Nomba's docs explicitly warn about header casing). */
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
