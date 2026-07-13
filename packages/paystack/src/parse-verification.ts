import { z } from "zod";
import {
  asKobo,
  MalformedPayloadError,
  AmountParseError,
  parseKoboInteger,
  validateTransaction,
  type ParseResult,
} from "@pay-normalize/core";
import { mapChannel, mapChargeStatus } from "./mapping";
import { chargeDedupeKey, PROVIDER } from "./parse-webhook";

/**
 * Normalize a GET /transaction/verify/:reference response — the
 * VERIFY-BEFORE-VALUE primitive. The HOST makes the API call (its
 * credentials, its HTTP — NOT_DOING.md bans network I/O here); this function
 * normalizes what came back.
 *
 * Why this exists as a first-class parser:
 *  1. Paystack's own guidance: confirm status server-side before giving value.
 *  2. Webhooks can be missed for 72h+ (or forever, post-retry-window). Verify
 *     is how a host backfills a transaction it never heard about — the
 *     "missing money" recovery path.
 *  3. IDENTITY: output shares the webhook's dedupeKey (chargeDedupeKey), so a
 *     verify-sourced row and a webhook-sourced row for the same charge upsert
 *     into ONE row, with STATUS_RANK arbitrating which status wins. Recon
 *     collapses into a unique index, same pattern as Nomba records.
 *
 * Money model, confirmed by Paystack's documented sample:
 *   amount(40333) - fees(10283) = requested_amount(30050)
 * i.e. when fees are passed to the customer, `amount` is the grossed-up
 * charge and net = amount - fees recovers exactly what the merchant asked
 * for. The schema invariant IS Paystack's arithmetic.
 */

const EnvelopeSchema = z.object({
  status: z.boolean(),
  message: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const VerifyDataSchema = z
  .object({
    reference: z.string().min(1),
    status: z.unknown(),
    amount: z.union([z.number(), z.string()]),
    fees: z.union([z.number(), z.string()]).nullish(),
    currency: z.string().nullish(),
    channel: z.unknown(),
    paid_at: z.string().nullish(),
    paidAt: z.string().nullish(),
    created_at: z.string().nullish(),
    createdAt: z.string().nullish(),
    transaction_date: z.string().nullish(),
    requested_amount: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

export function parsePaystackVerification(response: unknown): ParseResult {
  const envelope = EnvelopeSchema.safeParse(response);
  if (!envelope.success) {
    return err("verification response missing { status, message, data } envelope", response);
  }
  if (!envelope.data.status || !envelope.data.data) {
    // API-level failure (bad reference, auth, etc.) — not a transaction state.
    return err(
      `verification lookup failed: ${envelope.data.message ?? "no message"}`,
      response
    );
  }

  const d = VerifyDataSchema.safeParse(envelope.data.data);
  if (!d.success) {
    return err(
      `verification data malformed: ${d.error.issues[0]?.message ?? ""} at data.${d.error.issues[0]?.path.join(".") ?? "?"}`,
      response
    );
  }

  try {
    const status = mapChargeStatus(d.data.status);
    if (!status) return err(`unmapped verification status: ${String(d.data.status)}`, response);

    const amountInKobo = parseKoboInteger(d.data.amount);
    const feeInKobo = d.data.fees != null ? parseKoboInteger(d.data.fees) : asKobo(0);

    const occurred = firstTimestamp([
      d.data.paid_at,
      d.data.paidAt,
      d.data.transaction_date,
      d.data.created_at,
      d.data.createdAt,
    ]);
    if (!occurred) return err("verification data has no parseable timestamp", response);

    const transaction = validateTransaction({
      dedupeKey: chargeDedupeKey(d.data.reference), // SAME identity as the webhook row
      provider: PROVIDER,
      providerReference: d.data.reference,
      amountInKobo,
      feeInKobo,
      netAmountInKobo: amountInKobo - feeInKobo,
      currency: (d.data.currency ?? "NGN").toUpperCase(),
      status,
      channel: mapChannel(d.data.channel),
      direction: "credit",
      occurredAt: occurred.date,
      occurredAtRaw: occurred.raw,
      settlementDate: null,
      rawProviderPayload: response,
    });
    return { kind: "transaction", transaction };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: response };
    }
    return err(e instanceof Error ? e.message : "unexpected verification parse failure", response);
  }
}

function firstTimestamp(
  candidates: Array<string | null | undefined>
): { date: Date; raw: string } | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const parsed = new Date(c);
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, raw: c };
  }
  return undefined;
}

function err(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
