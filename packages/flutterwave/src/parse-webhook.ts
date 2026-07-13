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
import { mapChargeStatus, mapPaymentMethodType, resolveFlwTimestamp } from "./mapping";

export const PROVIDER = "flutterwave";

/**
 * v4 envelope: { data, id: "wbk_...", timestamp: <ms epoch>, type: "charge.completed" }.
 *
 *  - `id` (wbk_*) is a TRUE PER-DELIVERY ID -> providerEventId. Their docs:
 *    "Occasionally, we might send the same webhook event more than once" —
 *    and their retry policy (3 retries, 30-minute intervals, only if enabled
 *    on the dashboard!) guarantees duplicates under transient failure.
 *  - AMOUNTS ARE MAIN-UNIT DECIMALS ("amount": 2500, "amount": 1500.25) —
 *    the FIFTH amount convention in the library (Paystack kobo-int, OPay
 *    kobo-string, Nomba-webhook naira-number, Nomba-record naira-string,
 *    Flutterwave main-unit decimal number). parseNairaDecimalString converts
 *    to integer minor units (x100), which is correct for NGN/KES/USD alike.
 *  - NO FEE FIELD on charge webhooks. feeInKobo = 0, documented: Flutterwave
 *    fees materialize in SETTLEMENTS (typed fee array: stamp_duty,
 *    charge_fee) — see parse-settlement.ts. net == amount here; the
 *    settlement row carries the truth. This is not a gap, it is their model.
 *  - Identity: data.id (chg_*) — shared with the retrieve-charge parser so
 *    webhook-sourced and API-sourced rows upsert together. The merchant's
 *    `reference` rides in raw.
 */

const EnvelopeSchema = z.object({
  type: z.string().min(1),
  // Delivery (webhook) id is `id` on mobile_money deliveries but `webhook_id`
  // on card / bank_transfer deliveries — Flutterwave is inconsistent. Accept both.
  id: z.string().min(1).optional(),
  webhook_id: z.string().min(1).optional(),
  timestamp: z.number().optional(),
  data: z.record(z.string(), z.unknown()),
});

const ChargeDataSchema = z
  .object({
    id: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    currency: z.string().min(1),
    status: z.unknown(),
    reference: z.string().nullish(),
    created_datetime: z.union([z.string(), z.number()]).nullish(),
    payment_method: z
      .object({ type: z.unknown() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const CHARGE_EVENT_TYPE = "charge.completed";

export function chargeDedupeKey(chargeId: string): string {
  return composeDedupeKey(PROVIDER, `charge:${chargeId}`);
}

export function parseFlutterwaveWebhook(rawBody: RawBody): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return parseError("payload is not valid JSON", rawBody.toString("utf8"));
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return parseError("payload missing { type, data } envelope", json);
  }
  const { type, data, timestamp } = envelope.data;
  const deliveryId = envelope.data.id ?? envelope.data.webhook_id;

  if (type !== CHARGE_EVENT_TYPE) {
    // transfer.completed, refund events, future types — surfaced, never swallowed.
    return { kind: "unknown_event", provider: PROVIDER, eventType: type, raw: json };
  }

  const d = ChargeDataSchema.safeParse(data);
  if (!d.success) {
    return parseError(
      `charge.completed data malformed: ${d.error.issues[0]?.message ?? ""} at data.${d.error.issues[0]?.path.join(".") ?? "?"}`,
      json
    );
  }

  try {
    const status = mapChargeStatus(d.data.status);
    if (!status) return parseError(`unmapped charge status: ${String(d.data.status)}`, json);

    const amountInKobo = parseNairaDecimalString(d.data.amount);

    const occurred =
      resolveFlwTimestamp(d.data.created_datetime) ?? resolveFlwTimestamp(timestamp);
    if (!occurred) return parseError("no resolvable created_datetime/timestamp", json);

    const transaction = validateTransaction({
      dedupeKey: chargeDedupeKey(d.data.id),
      provider: PROVIDER,
      providerReference: d.data.id,
      ...(deliveryId ? { providerEventId: deliveryId } : {}),
      amountInKobo,
      feeInKobo: asKobo(0), // fees live in settlements — see file docblock
      netAmountInKobo: amountInKobo,
      currency: d.data.currency.toUpperCase(),
      status,
      channel: mapPaymentMethodType(d.data.payment_method?.type),
      direction: "credit",
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

function parseError(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
