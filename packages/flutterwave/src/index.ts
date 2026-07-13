import {
  UnsupportedFileFormatError,
  type Connector,
  type ParseResult,
  type RawBody,
  type SettlementFileParseResult,
  type StandardizedTransaction,
} from "@pay-normalize/core";
import { verifyFlutterwaveSignature } from "./signature";
import { parseFlutterwaveWebhook, PROVIDER } from "./parse-webhook";

/**
 * @pay-normalize/flutterwave — STATUS: EXPERIMENTAL (docs-derived fixtures;
 * v4 API surface). Graduation per NOT_DOING.md §11 requires sanitized
 * production captures — WITH HEADERS, because of the signature-scheme
 * contradiction pinned in signature.ts.
 *
 * Operational facts encoded:
 *  - Retries: 3 attempts, 30-minute intervals — and ONLY if enabled on the
 *    dashboard. A host that misses delivery + has retries off never hears
 *    about the event again; their docs therefore prescribe a backup polling
 *    job on pending transactions (host-side; normalize results with
 *    parseFlutterwaveCharge).
 *  - 60s webhook timeout; ACK 200 fast, work later.
 *  - "We might send the same webhook event more than once" — their words.
 *    wbk_* delivery ids + dedupeKey absorb it.
 */
export const flutterwave: Connector = {
  provider: PROVIDER,
  version: "0.1.0",

  verifyWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    secret: string;
  }): boolean {
    return verifyFlutterwaveSignature(input);
  },

  parseWebhook(rawBody: RawBody): ParseResult {
    return parseFlutterwaveWebhook(rawBody);
  },

  parseSettlementFile(_file: Buffer): SettlementFileParseResult {
    throw new UnsupportedFileFormatError(
      "Flutterwave settlement CSV export parsing is not yet fixture-verified. " +
        "For API-fetched settlements, use parseFlutterwaveSettlementList / parseFlutterwaveSettlement.",
      PROVIDER
    );
  },

  dedupeKey(txn: StandardizedTransaction): string {
    return txn.dedupeKey;
  },
};

export { verifyFlutterwaveSignature, SIGNATURE_HEADER } from "./signature";
export {
  parseFlutterwaveWebhook,
  chargeDedupeKey,
  PROVIDER,
  CHARGE_EVENT_TYPE,
} from "./parse-webhook";
export { parseFlutterwaveCharge, parseFlutterwaveChargeAt } from "./parse-charge";
export {
  parseFlutterwaveSettlement,
  parseFlutterwaveSettlementList,
} from "./parse-settlement";
export { resolveFlwTimestamp } from "./mapping";
