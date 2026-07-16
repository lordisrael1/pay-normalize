import {
  UnsupportedFileFormatError,
  type Connector,
  type ParseResult,
  type RawBody,
  type SettlementFileParseResult,
  type StandardizedTransaction,
} from "@pay-normalize/core";
import { verifyPaystackSignature } from "./signature";
import { parsePaystackWebhook, PROVIDER } from "./parse-webhook";

/**
 * @pay-normalize/paystack — STATUS: charge.success (card, bank_transfer) is
 * SUPPORTED, backed by real captured-and-sanitized webhook deliveries
 * (prod.sanitized.* fixtures), not just docs. transfer.* and
 * refund.processed are backed by docs-derived fixtures only, per
 * NOT_DOING.md §11 — until a real delivery for those event types is donated.
 * Docs describe the happy path; production teaches the quirks. Donate
 * sanitized payloads via the fixture scrubber.
 *
 * Operational facts encoded here (from Paystack's own docs):
 *  - Delivery is at-least-once with aggressive retry: every 3 minutes for the
 *    first 4 attempts, then hourly for 72 hours until you return 200 OK.
 *    Duplicates are therefore GUARANTEED under any transient failure —
 *    dedupeKey + your unique index are not optional.
 *  - Respond 200 immediately; do heavy work after ACK (their 30s timeout in
 *    test mode turns slow handlers into retry storms).
 *  - Optionally allowlist their published source IPs at your edge; that is
 *    host/WAF configuration, not library scope.
 */
export const paystack: Connector = {
  provider: PROVIDER,
  version: "0.1.0",

  verifyWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    secret: string;
  }): boolean {
    return verifyPaystackSignature(input);
  },

  parseWebhook(rawBody: RawBody): ParseResult {
    return parsePaystackWebhook(rawBody);
  },

  parseSettlementFile(_file: Buffer): SettlementFileParseResult {
    // Honest unsupported > silently wrong. Ships when a sanitized real export
    // exists in fixtures/ to pin the column layout (NOT_DOING.md §11).
    throw new UnsupportedFileFormatError(
      "Paystack settlement export parsing is not yet fixture-verified. " +
        "Donate a sanitized settlement CSV to enable it.",
      PROVIDER
    );
  },

  dedupeKey(txn: StandardizedTransaction): string {
    return txn.dedupeKey;
  },
};

export { verifyPaystackSignature, SIGNATURE_HEADER } from "./signature";
export { parsePaystackWebhook, chargeDedupeKey, PROVIDER } from "./parse-webhook";
export { parsePaystackVerification } from "./parse-verification";
