import { z } from "zod";
import {
  asKobo,
  composeDedupeKey,
  MalformedPayloadError,
  AmountParseError,
  parseNairaDecimalString,
  validateTransaction,
  type ParseResult,
  type RawBody,
} from "@pay-normalize/core";
import { EVENT_MAP, mapNombaType } from "./mapping";

export const PROVIDER = "nomba";

/**
 * Envelope: { event_type, requestId, data: { merchant, terminal, transaction, customer } }.
 *
 * AMOUNTS ARE NAIRA DECIMALS — the third convention in three providers:
 *   Paystack: kobo integers (10000), OPay: kobo strings ("49160"),
 *   Nomba: naira decimal NUMBERS (transactionAmount: 120, fee: 0.6).
 * parseNairaDecimalString does the boundary conversion with BigInt string
 * math (120 -> 12000 kobo, 0.6 -> 60 kobo) — the IEEE-754 trap tests in core
 * exist for exactly this payload shape.
 *
 * requestId is a PER-DELIVERY UUID ("unique request identifier useful for
 * tracking messages" — their words). It maps to providerEventId: it
 * distinguishes redelivery of one event (same transactionId, possibly same
 * requestId) from two lifecycle events about one transaction. Identity for
 * dedupe remains transactionId — Nomba retries up to 5 times on non-2xx with
 * exponential backoff (2m/5m/11m/24m/53m), so duplicates are guaranteed under
 * any transient failure.
 */

const EnvelopeSchema = z.object({
  event_type: z.string().min(1),
  requestId: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()),
});

const TransactionSchema = z
  .object({
    transactionId: z.string().min(1),
    transactionAmount: z.union([z.number(), z.string()]),
    fee: z.union([z.number(), z.string()]).nullish(),
    type: z.unknown(),
    time: z.string().min(1),
    aliasAccountReference: z.string().nullish(), // Owoore's VA routing key — preserved via raw
    narration: z.string().nullish(),
  })
  .passthrough();

const DataSchema = z
  .object({
    transaction: TransactionSchema,
    merchant: z.record(z.string(), z.unknown()).nullish(),
    customer: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export function parseNombaWebhook(rawBody: RawBody): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return parseError("payload is not valid JSON", rawBody.toString("utf8"));
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return parseError("payload missing { event_type, data } envelope", json);
  }
  const eventType = envelope.data.event_type;

  const mapping = EVENT_MAP[eventType];
  if (!mapping) {
    // Nomba adds event types over time; unknown routes through, never swallowed.
    return { kind: "unknown_event", provider: PROVIDER, eventType, raw: json };
  }

  const parsedData = DataSchema.safeParse(envelope.data.data);
  if (!parsedData.success) {
    return parseError(
      `${eventType} data malformed: ${parsedData.error.issues[0]?.message ?? ""} at data.${parsedData.error.issues[0]?.path.join(".") ?? "?"}`,
      json
    );
  }
  const txn = parsedData.data.transaction;

  try {
    const amountInKobo = parseNairaDecimalString(txn.transactionAmount);
    const feeInKobo =
      txn.fee != null && txn.fee !== "" ? parseNairaDecimalString(txn.fee) : asKobo(0);

    const occurred = parseTimestamp(txn.time);
    if (!occurred) return parseError(`${eventType} has unparseable transaction.time`, json);

    /**
     * net = amount - fee. For payment_* (credits) this is exactly what lands
     * in the wallet. For payout_* (debits) note the wallet impact is
     * amount + fee (Nomba charges the fee ON TOP of the transfer amount —
     * visible in transaction records as amountCharged = amount + fixedCharge).
     * The schema invariant stays; hosts reconciling wallet balance for
     * payouts should sum amount + fee, and the transaction-record parser
     * models this precisely. First prod payout webhook fixture pins whether
     * webhook transactionAmount means principal or charged total.
     */
    const transaction = validateTransaction({
      dedupeKey: composeDedupeKey(PROVIDER, `transaction:${txn.transactionId}`),
      provider: PROVIDER,
      providerReference: txn.transactionId,
      ...(envelope.data.requestId ? { providerEventId: envelope.data.requestId } : {}),
      amountInKobo,
      feeInKobo,
      netAmountInKobo: amountInKobo - feeInKobo,
      currency: "NGN", // webhook payload carries no currency field; records do
      status: mapping.status,
      channel: mapNombaType(txn.type),
      direction: mapping.direction,
      occurredAt: occurred.date,
      occurredAtRaw: occurred.raw,
      settlementDate: null,
      rawProviderPayload: json,
    });
    return { kind: "transaction", transaction };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: json };
    }
    return parseError(e instanceof Error ? e.message : "unexpected parse failure", json);
  }
}

function parseTimestamp(raw: string): { date: Date; raw: string } | undefined {
  const parsed = new Date(raw); // RFC-3339 with explicit Z per their docs
  if (Number.isNaN(parsed.getTime())) return undefined;
  return { date: parsed, raw };
}

function parseError(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
