import {
  UnsupportedFileFormatError,
  type Connector,
  type ParseResult,
  type RawBody,
  type SettlementFileParseResult,
  type StandardizedTransaction,
} from "@pay-normalize/core";
import { verifyMonnifySignature } from "./signature";
import { parseMonnifyWebhook, PROVIDER } from "./parse-webhook";

/**
 * @pay-normalize/monnify — STATUS: EXPERIMENTAL (docs-derived fixtures).
 * Per NOT_DOING.md §11, graduation requires sanitized production captures —
 * WITH HEADERS AND EXACT BYTES, because of the signature-serialization
 * question pinned in signature.ts.
 *
 * Operational facts encoded (from Monnify's docs):
 *  - Signature: HMAC-SHA512 of the request body keyed by your CLIENT SECRET,
 *    hex, in the `monnify-signature` header. (Their prose and their sample code
 *    both misstate this; the scheme was confirmed against their golden hash.)
 *  - ACK 200 fast, process later — their notifications time out.
 *  - Duplicate notifications happen; dedupeKey + your unique index absorb them.
 *  - Whitelisting Monnify's source IPs is host/WAF configuration, not our scope.
 */
export const monnify: Connector = {
  provider: PROVIDER,
  version: "0.1.0",

  verifyWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    secret: string;
  }): boolean {
    return verifyMonnifySignature(input);
  },

  parseWebhook(rawBody: RawBody): ParseResult {
    return parseMonnifyWebhook(rawBody);
  },

  parseSettlementFile(_file: Buffer): SettlementFileParseResult {
    throw new UnsupportedFileFormatError(
      "Monnify settlement export parsing is not yet fixture-verified. " +
        "For API-fetched settlement/transaction data, use parseMonnifyTransaction.",
      PROVIDER
    );
  },

  dedupeKey(txn: StandardizedTransaction): string {
    return txn.dedupeKey;
  },
};

export { verifyMonnifySignature, SIGNATURE_HEADER } from "./signature";
export {
  parseMonnifyWebhook,
  transactionDedupeKey,
  disbursementDedupeKey,
  settlementDedupeKey,
  PROVIDER,
} from "./parse-webhook";
export { parseMonnifyTransaction } from "./parse-transaction";
export {
  mapCollectionStatus,
  mapDisbursementStatus,
  mapPaymentMethod,
  parseMonnifyTimestamp,
} from "./mapping";
