import { z } from "zod";
import {
  asKobo,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  validateTransaction,
  type ParseResult,
} from "@pay-normalize/core";
import {
  FlwFeeSchema,
  mapChargeStatus,
  mapPaymentMethodType,
  resolveFlwTimestamp,
  sumFlwFees,
} from "./mapping";
import { chargeDedupeKey, PROVIDER } from "./parse-webhook";

/**
 * Normalize a GET /charges/:id response — Flutterwave's verify-before-value,
 * and their docs are emphatic about it: "Before giving value to a customer
 * based on a webhook notification, always re-query our API." They even
 * recommend a backup polling job for pending transactions — HOST-side
 * machinery; this function normalizes whatever those host calls fetched.
 *
 * Envelope quirk census: Flutterwave wraps in { status: "success" } — a
 * STRING — where Paystack's verify wraps in { status: true } — a BOOLEAN.
 * Same concept, different type, per provider. Of course.
 *
 * Identity joins the webhook row: chargeDedupeKey(data.id), so a retrieve-
 * sourced row upserts against its webhook twin with STATUS_RANK arbitrating.
 */

const EnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const ChargeDataSchema = z
  .object({
    id: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    currency: z.string().min(1),
    status: z.unknown(),
    reference: z.string().nullish(),
    created_datetime: z.union([z.string(), z.number()]).nullish(),
    fees: z.array(FlwFeeSchema).nullish(),
    payment_method_details: z.object({ type: z.unknown() }).passthrough().nullish(),
    payment_method: z.object({ type: z.unknown() }).passthrough().nullish(),
  })
  .passthrough();

export function parseFlutterwaveCharge(response: unknown): ParseResult {
  const envelope = EnvelopeSchema.safeParse(response);
  if (!envelope.success) {
    return err("charge response missing { status, message, data } envelope", response);
  }
  if (envelope.data.status.toLowerCase() !== "success" || !envelope.data.data) {
    return err(`charge lookup failed: ${envelope.data.message ?? "no message"}`, response);
  }

  const d = ChargeDataSchema.safeParse(envelope.data.data);
  if (!d.success) {
    return err(
      `charge data malformed: ${d.error.issues[0]?.message ?? ""} at data.${d.error.issues[0]?.path.join(".") ?? "?"}`,
      response
    );
  }

  try {
    const status = mapChargeStatus(d.data.status);
    if (!status) return err(`unmapped charge status: ${String(d.data.status)}`, response);

    const amountInKobo = parseNairaDecimalString(d.data.amount);
    const method = d.data.payment_method_details ?? d.data.payment_method;

    // Retrieve responses may omit created_datetime entirely (their sample does).
    // A lookup the host just performed is "as of now" — but we do not stamp
    // clocks (no I/O, no Date.now() in a pure library). Absent any timestamp,
    // the host supplies its fetch time.
    const occurred = resolveFlwTimestamp(d.data.created_datetime);
    if (!occurred) {
      return {
        kind: "parse_error",
        provider: PROVIDER,
        error: new MalformedPayloadError(
          "charge data has no created_datetime; pass the host's fetch time via " +
            "the parseFlutterwaveChargeAt(response, fetchedAt) overload",
          response,
          "ERR_TIMESTAMP_MISSING"
        ),
        raw: response,
      };
    }

    return buildTransaction(d.data, status, amountInKobo, method, occurred, response);
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: response };
    }
    return err(e instanceof Error ? e.message : "unexpected charge parse failure", response);
  }
}

/** Overload with explicit host-supplied fetch time for timestamp-less responses. */
export function parseFlutterwaveChargeAt(
  response: unknown,
  fetchedAt: Date
): ParseResult {
  const first = parseFlutterwaveCharge(response);
  if (first.kind !== "parse_error" || first.error.code !== "ERR_TIMESTAMP_MISSING") {
    return first;
  }
  // Re-parse, injecting the host's clock as the occurrence time.
  const envelope = EnvelopeSchema.safeParse(response);
  if (!envelope.success || !envelope.data.data) return first;
  const d = ChargeDataSchema.safeParse(envelope.data.data);
  if (!d.success) return first;
  const status = mapChargeStatus(d.data.status);
  if (!status) return first;
  try {
    const amountInKobo = parseNairaDecimalString(d.data.amount);
    const method = d.data.payment_method_details ?? d.data.payment_method;
    return buildTransaction(
      d.data,
      status,
      amountInKobo,
      method,
      { date: fetchedAt, raw: fetchedAt.toISOString() },
      response
    );
  } catch {
    return first;
  }
}

function buildTransaction(
  d: z.infer<typeof ChargeDataSchema>,
  status: NonNullable<ReturnType<typeof mapChargeStatus>>,
  amountInKobo: number,
  method: { type?: unknown } | null | undefined,
  occurred: { date: Date; raw: string },
  raw: unknown
): ParseResult {
  // Retrieve/verify charge responses carry a typed fees[] breakdown (vat, app,
  // merchant, stamp_duty). When present, net = amount - Σfees. Webhook charges
  // omit fees entirely -> Σ = 0 -> net = amount, unchanged.
  const feeInKobo = asKobo(sumFlwFees(d.fees));
  const transaction = validateTransaction({
    dedupeKey: chargeDedupeKey(d.id),
    provider: PROVIDER,
    providerReference: d.id,
    amountInKobo,
    feeInKobo,
    netAmountInKobo: amountInKobo - feeInKobo,
    currency: d.currency.toUpperCase(),
    status,
    channel: mapPaymentMethodType(method?.type),
    direction: "credit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

function err(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
