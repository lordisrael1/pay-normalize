import {
  shouldApplyStatusTransition,
  type StandardizedTransaction,
} from "@pay-normalize/core";

/**
 * Reference idempotent ledger — the host-side machinery the library
 * deliberately does NOT provide (it is stateless by design). This in-memory
 * implementation is the executable form of docs/INTEGRATION.md §4:
 *
 *   - the Map keyed by `dedupeKey` stands in for a `UNIQUE INDEX` on dedupe_key
 *     (the hard idempotency lock);
 *   - `shouldApplyStatusTransition` is the out-of-order / redelivery guard.
 *
 * In production this is Postgres with `INSERT ... ON CONFLICT (dedupe_key) DO
 * UPDATE ... WHERE rank(EXCLUDED.status) > rank(current.status)` under a row
 * lock. The logic is identical; only the storage differs.
 */
export type IngestOutcome = "inserted" | "updated" | "ignored";

export class InMemoryLedger {
  private readonly rows = new Map<string, StandardizedTransaction>();

  /** Idempotent upsert. Returns what actually happened, so callers can assert it. */
  ingest(txn: StandardizedTransaction): IngestOutcome {
    const existing = this.rows.get(txn.dedupeKey);
    if (!existing) {
      this.rows.set(txn.dedupeKey, txn);
      return "inserted";
    }
    // Same identity already stored. Apply the incoming state only if it
    // outranks what we have — a late/duplicate/lower-rank delivery is a no-op.
    if (shouldApplyStatusTransition(existing.status, txn.status)) {
      this.rows.set(txn.dedupeKey, txn);
      return "updated";
    }
    return "ignored";
  }

  get(dedupeKey: string): StandardizedTransaction | undefined {
    return this.rows.get(dedupeKey);
  }

  get size(): number {
    return this.rows.size;
  }
}
