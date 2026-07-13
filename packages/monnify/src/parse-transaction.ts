import { z } from "zod";
import {
  asKobo,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  validateTransaction,
  type ParseResult,
} from "@pay-normalize/core";
import { mapCollectionStatus, mapPaymentMethod, parseMonnifyTimestamp } from "./mapping";
import { PROVIDER, transactionDedupeKey } from "./parse-webhook";

/**
 * Normalize a Monnify "Get Transaction Status" response
 * (GET /api/v2/transactions/:reference or /api/v2/merchant/transactions/query)
 * — the VERIFY-BEFORE-VALUE primitive. The HOST makes the authenticated call
 * (its JWT, its HTTP — NOT_DOING.md bans network I/O here); this normalizes the
 * response.
 *
 * Identity joins the webhook row: transactionDedupeKey(transactionReference),
 * so a verify-sourced row and a SUCCESSFUL_TRANSACTION webhook row for the same
 * payment upsert into ONE row with STATUS_RANK arbitrating. This is also the
 * missing-money recovery path when a webhook was never delivered.
 *
 * Money model is the collection model: amountPaid is gross in, settlementAmount
 * is net, fee = amountPaid - settlementAmount.
 */

const EnvelopeSchema = z.object({
  requestSuccessful: z.boolean(),
  responseMessage: z.string().nullish(),
  responseCode: z.union([z.string(), z.number()]).nullish(),
  responseBody: z.record(z.string(), z.unknown()).nullish(),
});

const BodySchema = z
  .object({
    transactionReference: z.string().min(1),
    amountPaid: z.union([z.number(), z.string()]),
    settlementAmount: z.union([z.number(), z.string()]).nullish(),
    paymentStatus: z.unknown(),
    paymentMethod: z.unknown(),
    currency: z.string().min(1).nullish(),
    paidOn: z.string().nullish(),
  })
  .passthrough();

export function parseMonnifyTransaction(response: unknown): ParseResult {
  const envelope = EnvelopeSchema.safeParse(response);
  if (!envelope.success) {
    return err("transaction response missing { requestSuccessful, responseBody } envelope", response);
  }
  if (!envelope.data.requestSuccessful || !envelope.data.responseBody) {
    return err(
      `transaction lookup failed: ${envelope.data.responseMessage ?? "no message"}`,
      response
    );
  }

  const d = BodySchema.safeParse(envelope.data.responseBody);
  if (!d.success) {
    const i = d.error.issues[0];
    return err(
      `transaction data malformed: ${i?.message ?? ""} at responseBody.${i?.path.join(".") ?? "?"}`,
      response
    );
  }

  try {
    const status = mapCollectionStatus(d.data.paymentStatus);
    if (!status) return err(`unmapped paymentStatus: ${String(d.data.paymentStatus)}`, response);

    const amountInKobo = parseNairaDecimalString(d.data.amountPaid);
    const netAmountInKobo =
      d.data.settlementAmount != null && d.data.settlementAmount !== ""
        ? parseNairaDecimalString(d.data.settlementAmount)
        : amountInKobo;
    const feeInKobo = asKobo(amountInKobo - netAmountInKobo);

    const occurred = parseMonnifyTimestamp(d.data.paidOn);
    if (!occurred) return err("transaction data has unparseable paidOn", response);

    const transaction = validateTransaction({
      dedupeKey: transactionDedupeKey(d.data.transactionReference), // SAME identity as the webhook
      provider: PROVIDER,
      providerReference: d.data.transactionReference,
      amountInKobo,
      feeInKobo,
      netAmountInKobo,
      currency: (d.data.currency ?? "NGN").toUpperCase(),
      status,
      channel: mapPaymentMethod(d.data.paymentMethod),
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
    return err(e instanceof Error ? e.message : "unexpected transaction parse failure", response);
  }
}

function err(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
