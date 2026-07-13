import {
  UnsupportedFileFormatError,
  type Connector,
  type ParseResult,
  type RawBody,
  type SettlementFileParseResult,
  type StandardizedTransaction,
} from "@pay-normalize/core";

import {
  verifyNombaSignature,
  headerValue,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type NombaSignedFields,
} from "./signature";
import { parseNombaWebhook, PROVIDER } from "./parse-webhook";

/**
 * @pay-normalize/nomba — the flagship connector.
 *
 * Provenance: signature scheme validated byte-for-byte against Nomba's
 * published golden vector; transaction-record fixtures are SANITIZED REAL
 * production records. Webhook fixtures remain docs-derived until real
 * captures are donated — status graduates per NOT_DOING.md §11 when they are.
 *
 * Operational facts encoded:
 *  - Retry on any non-2xx: up to 5 redeliveries at ~2m/5m/11m/24m/53m.
 *    Duplicates guaranteed under transient failure -> dedupeKey + rank guard.
 *  - requestId = per-delivery UUID -> providerEventId.
 *  - The signature covers metadata ONLY; the AMOUNT IS UNSIGNED. See
 *    signature.ts for the full finding and required host mitigations.
 */
export const nomba: Connector = {
  provider: PROVIDER,
  version: "0.1.0",

  /**
   * Nomba signs a canonical string of payload fields + the nomba-timestamp
   * HEADER — so verification needs both headers and (parsed-from-raw) body.
   */
  verifyWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    secret: string;
  }): boolean {
    const providedSignature = headerValue(input.headers, SIGNATURE_HEADER);
    const nombaTimestamp = headerValue(input.headers, TIMESTAMP_HEADER);
    if (!providedSignature || !nombaTimestamp) return false;

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      return false;
    }
    if (typeof json !== "object" || json === null) return false;
    const env = json as {
      event_type?: unknown;
      requestId?: unknown;
      data?: { merchant?: Record<string, unknown>; transaction?: Record<string, unknown> };
    };
    const merchant = env.data?.merchant ?? {};
    const txn = env.data?.transaction ?? {};

    const fields: NombaSignedFields = {
      eventType: str(env.event_type),
      requestId: str(env.requestId),
      merchantUserId: str(merchant.userId),
      merchantWalletId: str(merchant.walletId),
      transactionId: str(txn.transactionId),
      transactionType: str(txn.type),
      transactionTime: str(txn.time),
      responseCode: str(txn.responseCode),
      nombaTimestamp,
    };
    return verifyNombaSignature({ signedFields: fields, providedSignature, secret: input.secret });
  },

  parseWebhook(rawBody: RawBody): ParseResult {
    return parseNombaWebhook(rawBody);
  },

  parseSettlementFile(_file: Buffer): SettlementFileParseResult {
    throw new UnsupportedFileFormatError(
      "Nomba settlement export parsing is not yet fixture-verified. " +
        "For API-fetched transaction lists, use parseNombaTransactionRecord per result row.",
      PROVIDER
    );
  },

  dedupeKey(txn: StandardizedTransaction): string {
    return txn.dedupeKey;
  },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export {
  verifyNombaSignature,
  buildNombaCanonicalString,
  signNombaCanonicalString,
  headerValue,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type NombaSignedFields,
} from "./signature";
export { parseNombaWebhook, PROVIDER } from "./parse-webhook";
export { parseNombaTransactionRecord } from "./parse-transaction-record";
export { EVENT_MAP } from "./mapping";
