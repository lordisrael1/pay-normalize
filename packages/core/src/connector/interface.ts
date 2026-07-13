import type { RawBody } from "../util/raw-body";
import type { ParseResult, SettlementFileParseResult } from "./result";
import type { StandardizedTransaction } from "../schema/transaction";

/**
 * Connector — the constitution. One implementation per provider, in its own
 * package (@scope/nomba, @scope/paystack, ...), each independently semver'd:
 * a Paystack format change is a paystack@2.0.0, and nobody's Nomba code moves.
 *
 * Design constraints (enforced by NOT_DOING.md, restated here because this is
 * the file contributors actually read):
 *  - PURE. No HTTP calls, no polling, no provider SDKs, no env vars, no clocks
 *    (timestamps come from payloads). Same input, same output, forever.
 *  - STATELESS. Dedupe enforcement, status transitions, retries, backpressure,
 *    and queueing are the host's (or the future hosted product's) concern.
 *  - SECRETS ARE ARGUMENTS. Passed in per call, never read, stored, or logged.
 */
export interface Connector {
  /** Lowercase identifier matching StandardizedTransaction.provider: 'nomba', 'paystack'... */
  readonly provider: string;

  /** Semver of this connector implementation, surfaced for host diagnostics/logging. */
  readonly version: string;

  /**
   * Verify the webhook came from the provider. MUST compute over the raw bytes
   * (RawBody brand exists precisely because express.json() destroys them) and
   * MUST use a constant-time comparison (crypto.timingSafeEqual) — string `===`
   * on HMACs leaks timing.
   *
   * Returns boolean rather than throwing: "unverified" is a routine hostile-
   * internet event (host responds 401), not an exceptional program state.
   */
  verifyWebhookSignature(input: {
    /** Node-style header map; connectors do case-insensitive lookups internally. */
    headers: Record<string, string | string[] | undefined>;
    rawBody: RawBody;
    /** The provider webhook secret. An argument, never an env read. */
    secret: string;
  }): boolean;

  /**
   * Normalize one webhook delivery. Total function over arbitrary bytes:
   * malformed input returns { kind: 'parse_error' }, never throws.
   * Call ONLY after verifyWebhookSignature returned true — parsing unverified
   * payloads is processing attacker-controlled input by choice.
   */
  parseWebhook(rawBody: RawBody): ParseResult;

  /**
   * Normalize a settlement/statement export (CSV/XLSX bytes). Row-isolated:
   * bad rows become parse_error results, good rows still flow. Throws
   * UnsupportedFileFormatError only when the FILE ITSELF is not a format this
   * connector version knows (wrong provider's file, new column layout) —
   * that is a configuration/version problem, not a data problem.
   */
  parseSettlementFile(file: Buffer): SettlementFileParseResult;

  /**
   * Identity for idempotent ingestion. Default composition is
   * `${provider}:${providerReference}` via composeDedupeKey; connectors
   * override when a provider's reference is not 1:1 with a transaction —
   * a quirk that must be documented and fixture-proven in the connector.
   */
  dedupeKey(txn: StandardizedTransaction): string;
}
