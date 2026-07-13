import { z } from "zod";
import {
  asKobo,
  composeDedupeKey,
  MalformedPayloadError,
  AmountParseError,
  parseKoboInteger,
  validateTransaction,
  type ParseResult,
  type RawBody,
} from "@pay-normalize/core";
import { mapChannel, mapChargeStatus, TRANSFER_EVENT_STATUS } from "./mapping";

export const PROVIDER = "paystack";

/**
 * Event routing, from Paystack's published event list:
 *
 *   charge.success                        -> transaction (credit)
 *   transfer.success | failed | reversed  -> transaction (debit)
 *   refund.processed                      -> transaction: REVERSED against the
 *                                            ORIGINAL charge reference, so the
 *                                            host's STATUS_RANK guard promotes
 *                                            SUCCESSFUL -> REVERSED naturally.
 *   refund.pending|processing|failed, subscription.*, invoice.*, dispute.*,
 *   dedicatedaccount.assign.*, customeridentification.*, paymentrequest.*
 *                                         -> unknown_event (recognized,
 *                                            surfaced, never swallowed —
 *                                            account lifecycle, not money
 *                                            movement)
 *   anything else                         -> unknown_event (forward compat:
 *                                            Paystack adds events without
 *                                            notice; NACKing them would make
 *                                            their 72-hour retry loop hammer
 *                                            your endpoint for nothing)
 */

const EnvelopeSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

const ChargeDataSchema = z
  .object({
    reference: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    fees: z.union([z.number(), z.string()]).nullish(),
    currency: z.string().nullish(),
    channel: z.unknown(),
    status: z.unknown(),
    paid_at: z.string().nullish(),
    paidAt: z.string().nullish(),
    created_at: z.string().nullish(),
    createdAt: z.string().nullish(),
  })
  .passthrough();

const TransferDataSchema = z
  .object({
    reference: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    currency: z.string().nullish(),
    updated_at: z.string().nullish(),
    updatedAt: z.string().nullish(),
    created_at: z.string().nullish(),
    createdAt: z.string().nullish(),
  })
  .passthrough();

const RefundDataSchema = z
  .object({
    transaction_reference: z.string().min(1).nullish(),
    amount: z.union([z.number(), z.string()]).nullish(),
    currency: z.string().nullish(),
    refund_created_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

export function parsePaystackWebhook(rawBody: RawBody): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return parseError("payload is not valid JSON", rawBody.toString("utf8"));
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return parseError("payload missing { event, data } envelope", json);
  }
  const { event, data } = envelope.data;

  try {
    if (event === "charge.success") return parseCharge(event, data, json);
    if (event in TRANSFER_EVENT_STATUS) return parseTransfer(event, data, json);
    if (event === "refund.processed") return parseRefundProcessed(event, data, json);
    return { kind: "unknown_event", provider: PROVIDER, eventType: event, raw: json };
  } catch (e) {
    if (e instanceof MalformedPayloadError || e instanceof AmountParseError) {
      return { kind: "parse_error", provider: PROVIDER, error: e, raw: json };
    }
    return parseError(e instanceof Error ? e.message : "unexpected parse failure", json);
  }
}

function parseCharge(event: string, data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = ChargeDataSchema.safeParse(data);
  if (!d.success) {
    return parseError(`charge.success data malformed: ${d.error.issues[0]?.message ?? ""}`, raw);
  }
  const status = mapChargeStatus(d.data.status);
  if (!status) {
    return parseError(`charge.success carried unmapped status: ${String(d.data.status)}`, raw);
  }

  // Paystack charge amounts and fees arrive ALREADY IN KOBO as integers.
  const amountInKobo = parseKoboInteger(d.data.amount);
  const feeInKobo = d.data.fees != null ? parseKoboInteger(d.data.fees) : asKobo(0);

  const occurred = firstTimestamp([d.data.paid_at, d.data.paidAt, d.data.created_at, d.data.createdAt]);
  if (!occurred) {
    return parseError("charge.success has no parseable paid_at/created_at timestamp", raw);
  }

  const transaction = validateTransaction({
    dedupeKey: chargeDedupeKey(d.data.reference),
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
    settlementDate: null, // webhooks don't carry settlement dates; settlement files do
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

function parseTransfer(event: string, data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = TransferDataSchema.safeParse(data);
  if (!d.success) {
    return parseError(`${event} data malformed: ${d.error.issues[0]?.message ?? ""}`, raw);
  }
  const status = TRANSFER_EVENT_STATUS[event];
  if (!status) return parseError(`unroutable transfer event: ${event}`, raw);

  const amountInKobo = parseKoboInteger(d.data.amount);
  const occurred = firstTimestamp([d.data.updated_at, d.data.updatedAt, d.data.created_at, d.data.createdAt]);
  if (!occurred) return parseError(`${event} has no parseable timestamp`, raw);

  const transaction = validateTransaction({
    dedupeKey: composeDedupeKey(PROVIDER, `transfer:${d.data.reference}`),
    provider: PROVIDER,
    providerReference: d.data.reference,
    amountInKobo,
    // Transfer webhook payloads don't reliably carry the fee; 0 here, true fee
    // reconciles from the settlement/transfer export. Documented, not guessed.
    feeInKobo: asKobo(0),
    netAmountInKobo: amountInKobo,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status,
    channel: "bank_transfer",
    direction: "debit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

/**
 * refund.processed -> REVERSED on the ORIGINAL charge's dedupe key.
 * Two webhooks about one transaction (charge.success, then refund.processed)
 * intentionally share identity: the host's unique index treats the second as
 * a status transition, and STATUS_RANK(REVERSED=3) > SUCCESSFUL(2) applies it.
 */
function parseRefundProcessed(event: string, data: Record<string, unknown>, raw: unknown): ParseResult {
  const d = RefundDataSchema.safeParse(data);
  const originalRef = d.success ? d.data.transaction_reference : undefined;
  if (!d.success || !originalRef) {
    return parseError("refund.processed missing transaction_reference to the original charge", raw);
  }
  const amountInKobo = d.data.amount != null ? parseKoboInteger(d.data.amount) : asKobo(0);
  const occurred = firstTimestamp([d.data.refund_created_at, d.data.created_at]) ?? {
    date: undefined,
    raw: undefined,
  };
  if (!occurred.date) {
    return parseError("refund.processed has no parseable timestamp", raw);
  }

  const transaction = validateTransaction({
    dedupeKey: chargeDedupeKey(originalRef),
    provider: PROVIDER,
    providerReference: originalRef,
    amountInKobo,
    feeInKobo: asKobo(0),
    netAmountInKobo: amountInKobo,
    currency: (d.data.currency ?? "NGN").toUpperCase(),
    status: "REVERSED",
    channel: "unknown", // refund payload doesn't restate the original channel; host already has it
    direction: "credit",
    occurredAt: occurred.date,
    occurredAtRaw: occurred.raw,
    settlementDate: null,
    rawProviderPayload: raw,
  });
  return { kind: "transaction", transaction };
}

/** charge-family identity: refunds resolve to the same key as their charge. */
export function chargeDedupeKey(reference: string): string {
  return composeDedupeKey(PROVIDER, `charge:${reference}`);
}

function firstTimestamp(
  candidates: Array<string | null | undefined>
): { date: Date; raw: string } | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const parsed = new Date(c); // Paystack sends ISO-8601 with explicit Z (UTC)
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, raw: c };
  }
  return undefined;
}

function parseError(message: string, raw: unknown): ParseResult {
  return {
    kind: "parse_error",
    provider: PROVIDER,
    error: new MalformedPayloadError(message, raw),
    raw,
  };
}
