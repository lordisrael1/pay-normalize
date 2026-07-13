import { toRawBody } from "@pay-normalize/core";
import { paystack } from "@pay-normalize/paystack";
import { InMemoryLedger, type IngestOutcome } from "./ledger";

/**
 * The connective tissue between a raw HTTP webhook and your ledger — the four
 * steps from docs/INTEGRATION.md, in order:
 *
 *   1. capture raw bytes   (the caller hands us the exact Buffer)
 *   2. verify signature    (401 on failure — never parse unverified input)
 *   3. parse               (total function; malformed => parse_error, no throw)
 *   4. handle by kind      (idempotent ingest / log unknown / dead-letter)
 *
 * Returns an HTTP-shaped result so a thin server (node:http, Express, a Lambda,
 * a test) just maps it to a response. Note the ACK discipline: every verified
 * request returns 200 — including parse errors — so the provider stops retrying
 * a payload that would fail identically. Only a bad signature is a 401.
 */
export interface WebhookResult {
  status: 200 | 401;
  kind: "transaction" | "unknown_event" | "parse_error" | "unverified";
  outcome?: IngestOutcome;
  dedupeKey?: string;
  detail?: string;
}

export function handlePaystackWebhook(
  rawBytes: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  ledger: InMemoryLedger
): WebhookResult {
  const rawBody = toRawBody(rawBytes);

  if (!paystack.verifyWebhookSignature({ headers, rawBody, secret })) {
    return { status: 401, kind: "unverified" };
  }

  const result = paystack.parseWebhook(rawBody);

  switch (result.kind) {
    case "transaction": {
      const outcome = ledger.ingest(result.transaction);
      return { status: 200, kind: "transaction", outcome, dedupeKey: result.transaction.dedupeKey };
    }
    case "unknown_event":
      // Recognized but not money movement. Log + store raw; never NACK.
      return { status: 200, kind: "unknown_event", detail: result.eventType };
    case "parse_error":
      // Poison message: ACK 200, dead-letter result.raw elsewhere, alert.
      return { status: 200, kind: "parse_error", detail: result.error.code };
  }
}
