import type { StandardizedTransaction } from "../schema/transaction";
import type { MalformedPayloadError, AmountParseError } from "../errors";

/**
 * Every parse returns one of these — connectors NEVER throw on weird input and
 * NEVER return null. The type system enforces NOT_DOING.md §9:
 * "no swallowing unknown events."
 *
 * Host handling guidance:
 *  - 'transaction'   -> idempotent upsert (unique dedupeKey + STATUS_RANK guard), ACK 200.
 *  - 'unknown_event' -> log + store raw, ACK 200. Unknown ≠ error: providers add
 *                       event types without notice; NACKing them makes the provider
 *                       retry forever (their backoff, your log spam).
 *  - 'parse_error'   -> the poison-message case. ACK 200 (do NOT make the provider
 *                       retry a payload that will fail identically), park the raw
 *                       payload in your own dead-letter store, alert. This library
 *                       ships no queue (NOT_DOING.md §6) — the DLQ is yours.
 */
export type ParseResult =
  | { kind: "transaction"; transaction: StandardizedTransaction }
  | {
      kind: "unknown_event";
      provider: string;
      /** Provider's own event-type string when discoverable, else "unrecognized". */
      eventType: string;
      raw: unknown;
    }
  | {
      kind: "parse_error";
      provider: string;
      error: MalformedPayloadError | AmountParseError;
      raw: unknown;
    };

/**
 * Result of parsing a settlement/statement file. Row-level isolation: one
 * mangled row (bank exports love those) yields one parse_error result — the
 * other 4,999 rows still normalize. All-or-nothing file parsing punishes the
 * host for the provider's data quality.
 */
export interface SettlementFileParseResult {
  provider: string;
  /** e.g. 'nomba-settlement-csv-v1' — which fixture-tested format matched. */
  format: string;
  rows: ParseResult[];
  /** Row counts by outcome, so hosts can alert on anomaly ratios cheaply. */
  summary: { transactions: number; unknown: number; errors: number };
}

export function summarizeRows(rows: ParseResult[]): SettlementFileParseResult["summary"] {
  const summary = { transactions: 0, unknown: 0, errors: 0 };
  for (const r of rows) {
    if (r.kind === "transaction") summary.transactions++;
    else if (r.kind === "unknown_event") summary.unknown++;
    else summary.errors++;
  }
  return summary;
}
