/**
 * Dedupe keys — idempotency for a world where providers retry webhooks.
 *
 * Webhook delivery is at-least-once everywhere: providers retry on timeout with
 * exponential backoff, and some (OPay callbacks, observed) simply double-fire.
 * The ONLY reliable defense is idempotent ingestion:
 *
 *   CREATE UNIQUE INDEX ux_txn_dedupe ON transactions (dedupe_key);
 *
 * then INSERT ... ON CONFLICT DO NOTHING (or the equivalent upsert guarded by
 * shouldApplyStatusTransition for status updates). Enforcing uniqueness in
 * application code alone is a race condition — two workers processing the same
 * redelivered webhook concurrently will both pass an "does it exist?" check.
 * The database constraint is the lock.
 *
 * Key shape: `${provider}:${providerReference}` — namespaced so Paystack ref
 * "TX123" and Nomba ref "TX123" never collide. Connectors may override
 * dedupeKey() when a provider's reference is not unique per transaction
 * (e.g. one reference spanning multiple settlement rows) — that quirk knowledge
 * lives in the connector, backed by fixtures.
 */
export function composeDedupeKey(provider: string, providerReference: string): string {
  const p = provider.trim().toLowerCase();
  const r = providerReference.trim();
  if (!p || !r) {
    throw new Error(
      `composeDedupeKey requires non-empty provider and reference, got provider="${provider}" reference="${providerReference}"`
    );
  }
  return `${p}:${r}`;
}
