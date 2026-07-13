import { z } from "zod";
import { TransactionStatusSchema } from "./status";
import { PaymentChannelSchema } from "./channel";
import type { Kobo } from "./money";

/**
 * StandardizedTransaction v1 — the single output shape of every connector.
 *
 * SCHEMA VERSIONING CONTRACT (NOT_DOING.md §9): v1 fields are frozen.
 * Additions ship as OPTIONAL fields in minor versions; renames/removals are v2
 * and a new major of every package (semver is the API contract here — hosts
 * pin `@scope/core@^1` and must never be broken by a minor).
 */

const KoboSchema = z
  .number()
  .int("money must be integer kobo — parse at the connector boundary, never float")
  .nonnegative();

export const StandardizedTransactionSchema = z
  .object({
    /** Deterministic identity for idempotency: `${provider}:${providerReference}` (see util/dedupe). */
    dedupeKey: z.string().min(3),

    /** Connector identifier, lowercase: 'nomba' | 'paystack' | 'monnify' | 'opay' | 'palmpay' | 'flutterwave' | ... open set by design — new providers must not require a core release. */
    provider: z.string().min(1).regex(/^[a-z0-9_-]+$/),

    /** The provider's own transaction reference (txref / transactionReference / orderNo...). */
    providerReference: z.string().min(1),

    /** Provider's per-DELIVERY event id when one exists — distinguishes redelivery of one event from two events about one transaction. */
    providerEventId: z.string().min(1).optional(),

    /** Money — integer kobo only. Branded at the type level. */
    amountInKobo: KoboSchema,
    feeInKobo: KoboSchema,
    /** MUST equal amountInKobo - feeInKobo; enforced below so no connector can drift. */
    netAmountInKobo: KoboSchema,

    /** ISO-4217 uppercase. Non-NGN is tagged and passed through untouched — no FX, no conversion (NOT_DOING.md §10). */
    currency: z.string().regex(/^[A-Z]{3}$/),

    status: TransactionStatusSchema,
    channel: PaymentChannelSchema,

    /** credit = money in (collections, VA funding); debit = money out rows encountered when parsing bank statements. Parsing debits ≠ initiating them. */
    direction: z.enum(["credit", "debit"]),

    /**
     * When the provider says it happened. CLOCK SKEW WARNING: provider clocks
     * are not your clock, and several send unlabeled WAT strings. Connectors
     * apply an explicit, fixture-tested timezone rule per provider. Hosts must
     * NEVER use this for ordering decisions — that is what STATUS_RANK is for.
     */
    occurredAt: z.date(),
    /** The provider's original timestamp string, preserved verbatim for audit/debugging. */
    occurredAtRaw: z.string().optional(),

    /** Settlement date when the payload/file carries one; null when unknown. Crucial for recon + accounting. */
    settlementDate: z.date().nullable(),

    /**
     * The untouched provider payload (or file row). The escape hatch that makes
     * the schema non-lossy (NOT_DOING.md §9). Contains PII — hosts own
     * encryption-at-rest and retention policy for whatever column stores this.
     */
    rawProviderPayload: z.unknown(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.netAmountInKobo !== t.amountInKobo - t.feeInKobo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["netAmountInKobo"],
        message: `netAmountInKobo (${t.netAmountInKobo}) must equal amountInKobo (${t.amountInKobo}) - feeInKobo (${t.feeInKobo})`,
      });
    }
  });

export type StandardizedTransaction = Omit<
  z.infer<typeof StandardizedTransactionSchema>,
  "amountInKobo" | "feeInKobo" | "netAmountInKobo"
> & {
  amountInKobo: Kobo;
  feeInKobo: Kobo;
  netAmountInKobo: Kobo;
};

/** Runtime gate every connector output passes through before leaving the library. */
export function validateTransaction(input: unknown): StandardizedTransaction {
  return StandardizedTransactionSchema.parse(input) as StandardizedTransaction;
}
