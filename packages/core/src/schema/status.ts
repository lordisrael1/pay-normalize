import { z } from "zod";

/**
 * The four terminal-ish states every provider vocabulary maps down to.
 * Connectors own the mapping table (e.g. OPay "SUCCESS", Paystack "success",
 * Monnify "PAID" -> SUCCESSFUL) — explicitly, per NOT_DOING.md §9:
 * no status inference from amount presence or absence of error fields.
 */
export const TransactionStatusSchema = z.enum([
  "PENDING",
  "FAILED",
  "SUCCESSFUL",
  "REVERSED",
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

/**
 * STATUS_RANK — the ordering that makes out-of-order webhook delivery safe.
 *
 * Why this exists (distributed-systems reality, not theory):
 *  - Providers deliver webhooks with retries + exponential backoff. Retries mean
 *    DUPLICATES; parallel delivery paths + network partitions mean REORDERING.
 *    A "pending" emitted at T0 can arrive AFTER the "successful" emitted at T1.
 *  - You cannot fix this with timestamps: provider clocks skew, and several
 *    providers send unlabeled local-time (WAT) strings. Ordering by rank is
 *    deterministic; ordering by clock is a race condition wearing a watch.
 *
 * REVERSED outranks SUCCESSFUL deliberately: success->reversal is a legitimate
 * forward progression (refunds, chargebacks). PENDING can never overwrite anything.
 * FAILED -> SUCCESSFUL is allowed (rank 1 -> 2): some providers emit a failure
 * then succeed on an internal retry under the same reference.
 */
export const STATUS_RANK: Readonly<Record<TransactionStatus, number>> = Object.freeze({
  PENDING: 0,
  FAILED: 1,
  SUCCESSFUL: 2,
  REVERSED: 3,
});

export function statusRank(status: TransactionStatus): number {
  return STATUS_RANK[status];
}

/**
 * The one-line correctness rule for host applications:
 *
 *   if (!shouldApplyStatusTransition(stored.status, incoming.status)) skip;
 *
 * Equal rank returns false — re-delivery of the same status is a no-op
 * (idempotency). Host must pair this with:
 *   1. a UNIQUE index on dedupeKey (hard idempotency at the storage layer), and
 *   2. optimistic locking (version column / compare-and-swap) or
 *      SELECT ... FOR UPDATE when applying the transition, because two webhook
 *      deliveries for the same transaction WILL race on concurrent workers.
 * This library is stateless by design (NOT_DOING.md §6) — it hands you the
 * rule; your database enforces it.
 */
export function shouldApplyStatusTransition(
  current: TransactionStatus,
  incoming: TransactionStatus
): boolean {
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}
